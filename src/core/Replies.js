/**
 * core/Replies.js — PURE core module (no I/O, no Apps Script globals).
 *
 * Owns every COMMAND-REPLY string the recipient can receive (ADR 006 §4).
 * State lives in Watchlist, wording lives here — the two never mix. Each
 * function takes plain data and returns the finished SMS text.
 *
 * TONE: this is a gift for one person. Replies are warm and human, always
 * say what actually happened, and always hint at the next step. (The DAILY
 * price line and its empty-watchlist notice belong to Formatter, not here
 * — deliberately separate concerns.)
 */
const Replies = {
  // The daily-send time as humans say it. COUPLED to Scheduler.ALERT_HOUR
  // (17 → "5pm") — a tripwire test in Scheduler.test.js fails if the hour
  // changes so this copy can't silently lie about when texts arrive.
  SCHEDULE_PHRASE: 'around 5pm on weekdays',

  /**
   * The one help text — sent for "help" and for anything unrecognized.
   * GSM-7 characters only (no fancy dots/dashes) so it stays cheap, and it
   * warns about STOP: that word is intercepted by the CARRIER as a full
   * unsubscribe (only "START" undoes it — "resume" cannot). Steering the
   * recipient to pause/resume avoids the trap.
   */
  help() {
    return 'Spazito here! Text me: "add TSLA", "remove TSLA", "list", "pause", "resume", "help". ' +
      'One ticker per message. (Use "pause", not STOP - STOP blocks all texts at the carrier ' +
      'until you send START.)';
  },

  added(ticker, tickers) {
    return 'Added ' + ticker + '! Now tracking: ' + tickers.join(', ') + '.';
  },

  duplicate(ticker) {
    return 'Already tracking ' + ticker + ' — you\'re all set.';
  },

  atCap(max) {
    return 'The watchlist is full (' + max + ' tickers — the free data plan\'s limit). ' +
      'Remove one first ("remove TSLA"), then add the new one.';
  },

  /**
   * Bound + strip anything user-typed before echoing it back in an SMS:
   * ticker-legal characters only, max 12. Every reply that echoes raw
   * input goes through here — the sanitizing must live in ONE place.
   */
  _echo(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .replace(/[^A-Za-z0-9.\-]/g, '')
      .slice(0, 12);
  },

  invalidTicker(raw) {
    return '"' + this._echo(raw) + '" doesn\'t look like a ticker symbol, so nothing was changed. ' +
      'Try something like "add TSLA" or "remove TSLA".';
  },

  unknownSymbol(ticker) {
    return 'Couldn\'t find ' + ticker + ' — not added. Double-check the symbol?';
  },

  serviceUnreachable() {
    return 'The price service isn\'t answering right now, so nothing was changed. ' +
      'Try again in a few minutes.';
  },

  removed(ticker, tickers, nowEmpty) {
    if (nowEmpty) {
      return 'Removed ' + ticker + '. The watchlist is now EMPTY — no daily prices ' +
        'until you add one back ("add SPY").';
    }
    return 'Removed ' + ticker + '. Now tracking: ' + tickers.join(', ') + '.';
  },

  notTracking(ticker) {
    return 'Wasn\'t tracking ' + this._echo(ticker) + ', so nothing to remove. Text "list" to see the watchlist.';
  },

  paused() {
    return 'Daily prices paused. Text "resume" whenever you want them back.';
  },

  resumed() {
    return 'Daily prices are back on — next text ' + this.SCHEDULE_PHRASE + '.';
  },

  list(tickers, paused) {
    const state = paused ? 'paused — text "resume" to restart' : 'active, ' + this.SCHEDULE_PHRASE;
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return 'The watchlist is empty (daily prices are ' + state + '). Text "add SPY" to start tracking.';
    }
    return 'Tracking: ' + tickers.join(', ') + '. Daily prices are ' + state + '.';
  },

  busy() {
    return 'Spazito is mid-change on another request — give it a few seconds and try again.';
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Replies };
