/**
 * core/CommandParser.js — PURE core module (no I/O, no Apps Script globals).
 *
 * Turns a raw inbound SMS body into a parsed command intent — and nothing
 * else (ADR 006 §4/§6). It does not check authorization (CommandHandler,
 * first), does not touch state (Watchlist), and does not build replies
 * (Replies). Parsing is separated from doing so it can be tested in Node
 * against every weird thing a human might type.
 *
 * Output shape is ALWAYS { type, arg }:
 *   "  Add tsla "  → { type: "add",    arg: "TSLA" }
 *   "STOP"         → { type: "pause",  arg: null }
 *   "unlock Xy z"  → { type: "unlock", arg: "Xy z" }   (verbatim — see ARG_SPECS)
 *   "" / gibberish → { type: "help",   arg: null }
 *
 * HOW TO EXTEND (ADR 006 §6 — never a switch):
 *   - New ALIAS for an existing command: one ALIASES line + a test.
 *   - New COMMAND: a TYPES entry + an ALIASES entry + (if it takes an
 *     argument) an ARG_SPECS entry + one handler entry in CommandHandler's
 *     dispatch table + tests. The shape tests fail loudly if TYPES is
 *     forgotten.
 *
 * Note: both an explicit "help" text and any unusable input collapse to the
 * SAME { type: "help" } intent — deliberate. If a differentiated reply
 * ("didn't catch 'byy'…") is ever wanted, add a distinct "unknown" type
 * then; don't overload help further.
 */
const CommandParser = {
  // Canonical intent types. Frozen so the dispatch contract can't be
  // mutated at runtime; the real typo protection is that code references
  // these named constants (CommandParser.TYPES.ADD) instead of retyping
  // string literals — a mistyped NAME surfaces as undefined immediately.
  TYPES: Object.freeze({
    ADD: 'add',
    REMOVE: 'remove',
    PAUSE: 'pause',
    RESUME: 'resume',
    LIST: 'list',
    HELP: 'help',
    LOG: 'log',       // security audit pull (ADR 008 §4) — handled in Chunk 8b
    UNLOCK: 'unlock', // re-arm after auto-lockout (ADR 008 §3) — handled in Chunk 8b
  }),

  // Every word the recipient can text (lowercased) → its canonical type.
  // Aliases are first-class: "stop" must behave exactly like "pause"
  // because that's what a person naturally texts a chatty bot.
  ALIASES: Object.freeze({
    add: 'add',
    remove: 'remove',
    pause: 'pause',
    stop: 'pause',
    resume: 'resume',
    start: 'resume',
    list: 'list',
    status: 'list',
    help: 'help',
    log: 'log',
    unlock: 'unlock',
  }),

  // How each command's argument is treated. A command absent from this
  // table takes no argument (anything after the verb is ignored chatter).
  //   'ticker' — first word after the verb, UPPERCASED (canonical symbol
  //              form; whether it's a PLAUSIBLE ticker is Watchlist /
  //              PriceService's judgment, not the parser's)
  //   'raw'    — everything after the verb, VERBATIM. Never re-cased or
  //              re-tokenized: unlock carries a case-sensitive secret
  //              (ADR 008 §3) and mangling it would leave a sealed bot
  //              dark forever.
  ARG_SPECS: Object.freeze({
    add: 'ticker',
    remove: 'ticker',
    unlock: 'raw',
  }),

  /**
   * Parse one SMS body. Total function: any input — null, undefined,
   * numbers, emoji soup, even prototype-property names like "constructor"
   * — comes back as a valid intent, worst case { type: "help", arg: null }.
   * The webhook must never throw over a text message (ADR 006 §9).
   *
   * Case-insensitive, whitespace-tolerant (spaces, tabs, newlines). Words
   * after the ones we understand are ignored ("add TSLA please" adds TSLA
   * — people talk to texting bots like people).
   */
  parse(body) {
    if (typeof body !== 'string') return this._help();

    const trimmed = body.trim();
    const words = trimmed.split(/\s+/);
    const verb = words[0].toLowerCase();
    // Own-property lookup ONLY: a body of "constructor" or "__proto__"
    // must fall through to help, not resolve to Object.prototype members.
    const type = Object.prototype.hasOwnProperty.call(this.ALIASES, verb)
      ? this.ALIASES[verb]
      : undefined;
    if (!type) return this._help(); // empty body lands here too ('' is no alias)

    const argSpec = Object.prototype.hasOwnProperty.call(this.ARG_SPECS, type)
      ? this.ARG_SPECS[type]
      : null;
    if (argSpec === null) return { type, arg: null };

    if (words.length < 2) return this._help(); // "add" / "unlock" with nothing after

    if (argSpec === 'ticker') return { type, arg: words[1].toUpperCase() };
    // 'raw': the remainder after the verb, untouched apart from the outer
    // trim — case and internal spacing preserved.
    return { type, arg: trimmed.slice(words[0].length).trim() };
  },

  /** The one shape every unusable input collapses to. */
  _help() {
    return { type: this.TYPES.HELP, arg: null };
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { CommandParser };
