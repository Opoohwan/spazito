/**
 * CommandHandler.js — SHELL module. The inbound-webhook entry point:
 * Twilio POSTs the recipient's text here, and this module runs
 *   authorize (FIRST, always) → parse → dispatch → reply.
 * It orchestrates only (ADR 006 §4/§6): parsing is CommandParser's,
 * wording is Replies', state is Watchlist's, prices are PriceService's,
 * sending is SmsService's, and the auth decision is SecurityGate's.
 *
 * WIRE CONTRACT: doPost always returns an empty 200 —
 *   - on success: the confirmation goes out as a separate outbound SMS via
 *     SmsService (a GAS web app can't reliably return the TwiML content
 *     type Twilio's inline-reply path expects — ADR 006 §11);
 *   - on auth failure: silent 200, zero side effects — no reply, no oracle
 *     for strangers (ADR 008 §3);
 *   - on ANY internal error: still 200 (logged, scrubbed) — a non-2xx
 *     makes Twilio log error 11200 against the number and try the Fallback
 *     URL if one is configured (leave it UNSET — PROCESSES.md); a clean
 *     200 keeps the failure quietly on our side of the wire.
 *
 * COST DISCIPLINE (ADR 007 + Chunk 6 gate): one inbound message causes AT
 * MOST one paid Alpha Vantage call (add-validation, only after every free
 * check passed) and exactly one outbound reply. A failed reply send is
 * terminal — never retried.
 */
const CommandHandler = {
  /**
   * The webhook body. `e.parameter` carries Twilio's form fields (Body,
   * From, MessageSid, ... plus our ?k= URL token).
   */
  doPost(e) {
    try {
      // AUTHORIZE FIRST — before anything else runs or is read
      // (ADR 006 §11). This ordering is also the flood defense: a hostile
      // request is rejected after ONE property read (the sealed check)
      // to at most a couple of secret reads, with no validation sweep.
      const auth = SecurityGate.authorize(e);
      if (!auth.allowed) {
        // The ONE proactive security text (ADR 008 §4): the moment the
        // bot seals itself, tell the recipient — a silently-sealed bot
        // would just look broken, forever.
        if (auth.justSealed) SmsService.send(Replies.sealedNotice());
        return this._emptyOk();
      }

      // A half-configured deployment fails loud in the log (ADR 006 §8) —
      // the catch below still answers the wire with a quiet 200. Runs
      // AFTER the gate so only authorized requests pay the full sweep.
      Config.validateForWebhook();

      const body = e && e.parameter ? e.parameter.Body : '';
      const intent = CommandParser.parse(body);

      // Dispatch table (§6): one small handler per command. An intent
      // with no entry gets the help text — never a silent nothing.
      const handler = this._commands()[intent.type];
      const reply = handler ? handler(intent.arg) : Replies.help();

      // Exactly one outbound reply per inbound command; SmsService logs
      // its own failures and never throws.
      SmsService.send(reply);
      return this._emptyOk();
    } catch (err) {
      console.error('doPost failed: ' + Redactor.scrub(err && err.message));
      return this._emptyOk();
    }
  },

  /**
   * The dispatch table (ADR 006 §6), keyed by the frozen CommandParser
   * TYPES constants — never retyped literals (§7): a renamed type breaks
   * here visibly instead of silently killing a command. Built at CALL time
   * on purpose: a top-level computed key would reference another file's
   * const during GAS's load phase, where file order isn't guaranteed
   * (TDZ ReferenceError = every execution dead).
   * Adding a command = one parser entry + one row here (+ tests).
   */
  _commands() {
    return {
      [CommandParser.TYPES.ADD]: (arg) => this._add(arg),
      [CommandParser.TYPES.REMOVE]: (arg) => this._remove(arg),
      [CommandParser.TYPES.PAUSE]: () => this._setPaused(true),
      [CommandParser.TYPES.RESUME]: () => this._setPaused(false),
      [CommandParser.TYPES.LIST]: () => Replies.list(Watchlist.tickers(), Watchlist.isPaused()),
      [CommandParser.TYPES.HELP]: () => Replies.help(),
      // Security commands (ADR 008 §3/§4). `log` pulls the audit trail —
      // blocked attempts are never pushed (the sole exception is the
      // one-time sealed notice). `unlock` reaching this table means the
      // gate just re-armed the bot OR it was never sealed — both
      // truthfully answered by the same reply.
      [CommandParser.TYPES.LOG]: () => Replies.auditLog(SecurityVault.recentAudit(8)),
      [CommandParser.TYPES.UNLOCK]: () => Replies.unlocked(),
    };
  },

  /**
   * `add` — the one command that can spend money-equivalent quota. The
   * FREE checks run first (ADR 007): a doomed add must cost zero Alpha
   * Vantage calls. Only a plausible, new, under-cap ticker earns the one
   * paid existence check; only a confirmed symbol enters the watchlist.
   */
  _add(rawArg) {
    // Free check 1: is it even ticker-shaped?
    if (!Tickers.isValid(rawArg)) return Replies.invalidTicker(rawArg);
    const ticker = Tickers.normalize(rawArg);
    // Free checks 2 + 3: already tracked? full? (advisory — Watchlist.add
    // re-checks under its lock as the source of truth)
    if (Watchlist.has(ticker)) return Replies.duplicate(ticker);
    if (Watchlist.isFull()) return Replies.atCap(Watchlist.MAX_TICKERS);

    // The PAID check (one Alpha Vantage call): does the symbol exist?
    const quote = PriceService.quotesFor([ticker])[0];
    if (!quote.ok) {
      // "No such symbol" and "the service is unreachable" are different
      // answers (ADR 006 §9 distinct-states) — a rate limit or an API
      // outage must never read as "your ticker doesn't exist".
      return quote.reason === PriceService.REASON.NO_QUOTE
        ? Replies.unknownSymbol(ticker)
        : Replies.serviceUnreachable();
    }

    const result = Watchlist.add(ticker);
    const replies = {
      [Watchlist.STATUS.ADDED]: () => Replies.added(result.ticker, result.tickers),
      [Watchlist.STATUS.DUPLICATE]: () => Replies.duplicate(result.ticker),
      [Watchlist.STATUS.AT_CAP]: () => Replies.atCap(Watchlist.MAX_TICKERS),
      [Watchlist.STATUS.INVALID]: () => Replies.invalidTicker(result.ticker),
      [Watchlist.STATUS.BUSY]: () => Replies.busy(),
    };
    return replies[result.status]();
  },

  _remove(rawArg) {
    // Same free format gate as _add: garbage never reaches state code or
    // gets echoed back at full length.
    if (!Tickers.isValid(rawArg)) return Replies.invalidTicker(rawArg);
    const result = Watchlist.remove(rawArg);
    const replies = {
      [Watchlist.STATUS.REMOVED]: () => Replies.removed(result.ticker, result.tickers, result.nowEmpty),
      [Watchlist.STATUS.NOT_FOUND]: () => Replies.notTracking(result.ticker),
      [Watchlist.STATUS.BUSY]: () => Replies.busy(),
    };
    return replies[result.status]();
  },

  _setPaused(paused) {
    const result = Watchlist.setPaused(paused);
    const replies = {
      [Watchlist.STATUS.PAUSED]: () => Replies.paused(),
      [Watchlist.STATUS.RESUMED]: () => Replies.resumed(),
      [Watchlist.STATUS.BUSY]: () => Replies.busy(),
    };
    return replies[result.status]();
  },

  /** The one thing a GAS webhook may answer with: an empty 200 text body. */
  _emptyOk() {
    return ContentService.createTextOutput('');
  },
};

// ---------------------------------------------------------------------------
// GAS entry point — web-app entrypoints must be bare globals (ADR 006 §3).
// ---------------------------------------------------------------------------

/** What Twilio's webhook POST actually invokes. All logic is on the module. */
function doPost(e) {
  return CommandHandler.doPost(e);
}

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file. (doPost exported too
// so tests prove the entry point delegates.)
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { CommandHandler, doPost };
