/**
 * Watchlist.js — SHELL module. The single owner of all MUTABLE STATE
 * (ADR 004, ADR 006 §5): the ticker watchlist and the paused flag.
 *
 * No other module reads or writes the WATCHLIST / PAUSED properties — the
 * storage format (a JSON array string; "true"/"false") is this module's
 * private detail. Callers get plain arrays/booleans and structured outcome
 * objects. (Secrets are NOT state; those belong to Config.js.)
 *
 * WRITE SAFETY (ADR 006 §5): every mutation runs inside a LockService script
 * lock. Two texts arriving nearly at once — or Twilio retrying a webhook —
 * would otherwise race the read-modify-write and one change would silently
 * vanish. A lock that can't be acquired within LOCK_TIMEOUT_MS returns
 * { status: STATUS.BUSY } so the caller can reply "try again", never fails
 * silently. Reads are deliberately NOT locked: a reader overlapping a writer
 * just sees the pre-write value — a harmless timing artifact.
 *
 * OUTCOME OBJECTS, NOT MESSAGES: mutations return one of the STATUS values
 * below plus structured fields. Turning those into friendly SMS copy is
 * core/Replies' job (ADR 006 §4) — state and wording never mix. Contract:
 * outcomes decided under the lock carry the current `tickers` list; cheap
 * refusals (invalid) and lock failures (busy) don't.
 */
const Watchlist = {
  // Every status a Watchlist mutation can return. Frozen so a typo'd or
  // renamed status is impossible — core/Replies keys its reply copy off
  // these exact values, and the two files must never drift.
  STATUS: Object.freeze({
    ADDED: 'added',
    DUPLICATE: 'duplicate',
    AT_CAP: 'at_cap',
    INVALID: 'invalid',
    REMOVED: 'removed',
    NOT_FOUND: 'not_found',
    PAUSED: 'paused',
    RESUMED: 'resumed',
    BUSY: 'busy',
  }),

  // Hard cap on watchlist size (ADR 007). Derivation: Alpha Vantage free
  // tier = 25 calls/day and 5/min. Ten tickers = 10 calls per daily run,
  // leaving 15/day headroom for `add` validations; ten calls spaced 15s
  // apart ≈ 2.5 min, safely inside Apps Script's 6-minute execution cap.
  MAX_TICKERS: 10,

  // How long a writer waits for the script lock. Must stay well under
  // Twilio's ~15s webhook retry window (ADR 006 §5): if we can't get the
  // lock in 5s we reply "busy" ourselves rather than letting Twilio re-fire
  // the whole request.
  LOCK_TIMEOUT_MS: 5000,

  // What the recipient gets before any customization. Lives in code, not
  // pre-seeded into storage — an unset WATCHLIST property means "default".
  // Frozen: reads hand out copies, and nothing may mutate the source.
  DEFAULT_TICKERS: Object.freeze(['SPY', 'GLD', 'SLV']),

  // The Script Property keys this module owns. Named once so a typo can't
  // silently split reads and writes across two different keys.
  _KEYS: Object.freeze({ WATCHLIST: 'WATCHLIST', PAUSED: 'PAUSED' }),

  /**
   * The current watchlist as a fresh plain array. Three layers of
   * self-defense, because the unattended daily run must degrade, never die
   * (ADR 006 §9), and because whatever this returns rides straight into
   * Alpha Vantage URLs (Chunk 5):
   *   - unset storage → the default list;
   *   - corrupted storage (unparseable / not an array) → warn + default;
   *   - entry-level junk (a hand-edited property, a bad restore) →
   *     normalize each entry, DROP anything that isn't ticker-shaped
   *     (Tickers.isValid — the URL-injection chokepoint), and de-dupe so a
   *     duplicated slot can't double-spend the daily API budget (ADR 007).
   */
  tickers() {
    const raw = PropertiesService.getScriptProperties().getProperty(this._KEYS.WATCHLIST);
    if (raw === null) return [...this.DEFAULT_TICKERS];

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('WATCHLIST is not an array');
    } catch (e) {
      console.warn(
        'WATCHLIST property is corrupted (' + e.message + '); using the default list. ' +
        'Stored value: ' + raw
      );
      return [...this.DEFAULT_TICKERS];
    }

    // Entry-level healing. JSON.parse gave us a fresh array, and this map/
    // filter builds another — callers can never mutate our state through
    // the return value.
    const clean = [];
    for (const entry of parsed) {
      const ticker = Tickers.normalize(entry);
      if (!Tickers.isValid(ticker) || clean.indexOf(ticker) !== -1) continue;
      clean.push(ticker);
    }
    if (clean.length !== parsed.length) {
      console.warn(
        'WATCHLIST contained ' + (parsed.length - clean.length) +
        ' invalid/duplicate entr(ies); they were ignored. Stored value: ' + raw
      );
    }
    return clean;
  },

  /**
   * True when the (normalized) ticker is already tracked.
   * WHY this exists next to add()'s own duplicate check: it is the FREE
   * pre-flight for CommandHandler — a doomed `add` must be rejected BEFORE
   * spending the one Alpha Vantage validation call (ADR 007). Advisory only
   * (unlocked); add() re-checks under the lock as the source of truth.
   */
  has(rawTicker) {
    return this.tickers().indexOf(Tickers.normalize(rawTicker)) !== -1;
  },

  /**
   * True when the list is at the ADR 007 cap. Same role as has(): free,
   * advisory pre-flight for CommandHandler; add() re-checks under the lock.
   */
  isFull() {
    return this.tickers().length >= this.MAX_TICKERS;
  },

  /** True when alerts are paused. Unset or anything but "true" = active. */
  isPaused() {
    return PropertiesService.getScriptProperties().getProperty(this._KEYS.PAUSED) === 'true';
  },

  /**
   * Pause or resume alerts.
   * Returns { status: STATUS.PAUSED | STATUS.RESUMED, paused }
   * — or { status: STATUS.BUSY } on lock timeout.
   */
  setPaused(paused) {
    return this._withLock(() => {
      const flag = Boolean(paused);
      PropertiesService.getScriptProperties().setProperty(this._KEYS.PAUSED, flag ? 'true' : 'false');
      return { status: flag ? this.STATUS.PAUSED : this.STATUS.RESUMED, paused: flag };
    });
  },

  /**
   * Add a ticker. Normalizes ("  tsla " → "TSLA"), refuses junk that isn't
   * even ticker-shaped, de-dupes, and enforces the cap.
   * Returns one of:
   *   { status: STATUS.ADDED,     ticker, tickers }  — success, new list
   *   { status: STATUS.DUPLICATE, ticker, tickers }  — already tracked
   *   { status: STATUS.AT_CAP,    ticker, tickers }  — list full
   *   { status: STATUS.INVALID,   ticker }           — not a plausible symbol
   *   { status: STATUS.BUSY }                        — lock timeout, try again
   *
   * NOTE: this is only the format/state half of `add`. "Does the symbol
   * actually exist" is CommandHandler's job (it asks PriceService, which
   * costs an Alpha Vantage call — ADR 007 — and runs only AFTER the free
   * checks here would pass).
   */
  add(rawTicker) {
    const ticker = Tickers.normalize(rawTicker);
    if (!Tickers.isValid(ticker)) return { status: this.STATUS.INVALID, ticker };
    return this._withLock(() => {
      const current = this.tickers();
      if (current.indexOf(ticker) !== -1) return { status: this.STATUS.DUPLICATE, ticker, tickers: current };
      if (current.length >= this.MAX_TICKERS) return { status: this.STATUS.AT_CAP, ticker, tickers: current };
      const updated = current.concat([ticker]);
      this._store(updated);
      return { status: this.STATUS.ADDED, ticker, tickers: updated };
    });
  },

  /**
   * Remove a ticker. Friendly no-op when it isn't tracked.
   * Returns one of:
   *   { status: STATUS.REMOVED,   ticker, tickers, nowEmpty } — nowEmpty
   *     flags an emptied list so the caller can warn "no more daily prices"
   *   { status: STATUS.NOT_FOUND, ticker, tickers }
   *   { status: STATUS.BUSY }
   */
  remove(rawTicker) {
    const ticker = Tickers.normalize(rawTicker);
    return this._withLock(() => {
      const current = this.tickers();
      if (current.indexOf(ticker) === -1) return { status: this.STATUS.NOT_FOUND, ticker, tickers: current };
      const updated = current.filter((t) => t !== ticker);
      this._store(updated);
      return { status: this.STATUS.REMOVED, ticker, tickers: updated, nowEmpty: updated.length === 0 };
    });
  },

  /** Persist the list. The JSON-array encoding is private to this module. */
  _store(tickerList) {
    PropertiesService.getScriptProperties().setProperty(this._KEYS.WATCHLIST, JSON.stringify(tickerList));
  },

  /**
   * Run a mutation inside the script lock (ADR 006 §5 contract):
   * acquire with a timeout → do the work → ALWAYS release in finally.
   * Timeout → { status: STATUS.BUSY }, and since the lock was never
   * acquired there is nothing to release — releaseLock must NOT be called
   * on that path.
   */
  _withLock(mutate) {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(this.LOCK_TIMEOUT_MS); // throws if not acquired in time
    } catch (e) {
      console.warn('Could not acquire the watchlist lock within ' + this.LOCK_TIMEOUT_MS + 'ms; replying busy.');
      return { status: this.STATUS.BUSY };
    }
    try {
      return mutate();
    } finally {
      lock.releaseLock();
    }
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file. (Cross-module names
// like Tickers resolve through GAS's shared global scope; in Node the test
// bootstrap test/gasScope.js provides them — never this guard.)
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Watchlist };
