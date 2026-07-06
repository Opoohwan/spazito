/**
 * core/Formatter.js — PURE core module (no I/O, no Apps Script globals).
 *
 * Owns the ENTIRE daily message line (ADR 006 §10): every display rule,
 * every number format, the failed-ticker rendering, and the empty-watchlist
 * notice. No other module formats a price — if a `.toFixed` or a comma
 * appears in a shell module, that's the bleed ADR 006 §13 forbids.
 *
 * Input contract (decided as "Option C", see CHANGELOG): an ORDERED array
 *   [{ ticker, price, ok }, ...]   in watchlist order.
 * `ok` is the source of truth — `price` is only read when ok is exactly
 * true, and a price that doesn't parse to a usable finite number renders as
 * "n/a" anyway, so the literal text "NaN" (or "1e+21") can never reach the
 * recipient's phone. A failed ticker renders IN PLACE
 * ("S&P n/a | Gold 4,500 | ...") — the line never drops or reorders a slot.
 *
 * The [#N TAG] auth block (ADR 008 §6) is NOT built here: HMAC needs a GAS
 * global (Utilities), so signing is a shell step appended after this pure
 * line is built.
 */
const Formatter = {
  // The display-rules DATA TABLE (ADR 006 §10) — how each known ticker is
  // shown. THIS TABLE IS THE SOURCE OF TRUTH for display rules; the docs
  // restate it only as illustration. Deliberately a table, not per-ticker
  // if-branches: adding or changing a rule is one line here plus a test.
  //   label    — what the recipient sees instead of the raw symbol
  //   decimals — how many decimal places the price is rounded to
  DISPLAY_RULES: Object.freeze({
    SPY: Object.freeze({ label: 'S&P', decimals: 0 }),
    GLD: Object.freeze({ label: 'Gold', decimals: 0 }),
    SLV: Object.freeze({ label: 'Silver', decimals: 2 }),
  }),

  // Any ticker not in the table: shown under its own symbol with 2 decimals.
  DEFAULT_DECIMALS: 2,

  // How a failed slot reads, and what separates segments. The separator is
  // part of the signed payload format (ADR 008 §6) — never change one
  // without checking the offline verifier's expectations.
  NA: 'n/a',
  SEPARATOR: ' | ',

  // Above this magnitude Number.prototype.toFixed switches to exponent
  // notation ("1e+21"), which must never appear in a text message. No real
  // security price comes anywhere near it; anything this large is garbage.
  MAX_FORMATTABLE: 1e21,

  // What goes out when there is nothing to report. Owned here so "the whole
  // line" really is one module's responsibility. Distinct from all-failed:
  // an empty list means nothing was attempted (this notice); all-failed
  // means every attempt failed (a full "n/a" line — the caller logs that).
  // (The command-reply copy for "you just removed the last ticker" is
  // core/Replies' concern — deliberately separate from this daily-run notice.)
  EMPTY_WATCHLIST_MESSAGE:
    'Your watchlist is empty — text "add SPY" (or any ticker) to start getting daily prices.',

  /**
   * The one public entry point: ordered quotes in, finished message out.
   *
   *   summaryLine([{ticker:"SPY", price:"7500.23", ok:true}, ...])
   *     → "S&P 7,500 | Gold 4,500 | Silver 70.00"
   */
  summaryLine(quotes) {
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return this.EMPTY_WATCHLIST_MESSAGE;
    }
    return quotes.map((quote) => this._segment(quote)).join(this.SEPARATOR);
  },

  /**
   * True when quotes were attempted and EVERY one failed — the caller's
   * signal that the data source itself is down/throttled (it logs an
   * error; the n/a line still goes out). Lives here, not in Scheduler,
   * because Formatter owns ok-semantics: "what counts as failed" must be
   * decided in exactly one module or the rendering and the alarm drift
   * apart (Chunk 7 gate). An EMPTY list is NOT all-failed — nothing was
   * attempted (§9's distinct-states rule).
   */
  allFailed(quotes) {
    return Array.isArray(quotes)
      && quotes.length > 0
      && quotes.every((quote) => !quote || quote.ok !== true);
  },

  /**
   * One "Label 1,234.56" (or "Label n/a") segment for one quote.
   */
  _segment(quote) {
    // A slot that isn't even an object still renders (as a bare "n/a") —
    // the line never drops a position, and a malformed slot must never
    // crash the whole unattended run (ADR 006 §9).
    if (quote === null || typeof quote !== 'object') return this.NA;

    // Uppercase before the table lookup. Formatter is pure and must not
    // assume callers normalized (ADR 006 §10) — and the leaf rule (§2)
    // means this stays a local one-liner (kept equivalent to
    // Tickers.normalize — see the cross-check test) rather than a call
    // into Tickers.
    const symbol = quote.ticker === undefined || quote.ticker === null
      ? ''
      : String(quote.ticker).trim().toUpperCase();

    const known = this.DISPLAY_RULES[symbol];
    // Unknown symbols become their own label — sanitized down to
    // ticker-legal characters and a sane length, so nothing weird can ever
    // ride a label into the message text or the signed HMAC payload
    // (defense in depth; Watchlist's allowlist is the primary gate).
    const label = known ? known.label : symbol.replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
    const decimals = known ? known.decimals : this.DEFAULT_DECIMALS;

    if (label === '') return this.NA; // no usable name at all

    if (quote.ok !== true) return label + ' ' + this.NA;

    const price = this._parsePrice(quote.price);
    // Defensive belt: ok:true with an unusable price still renders n/a —
    // "NaN", "Infinity", or exponent notation must never reach a text.
    if (!Number.isFinite(price) || Math.abs(price) >= this.MAX_FORMATTABLE) {
      return label + ' ' + this.NA;
    }

    return label + ' ' + this._formatMoney(price, decimals);
  },

  /**
   * Parse once, at the core boundary (ADR 006 §10): Alpha Vantage returns
   * prices as plain decimal strings ("70.1200"). Strict — only that shape
   * is accepted. Number()'s looser accepts ("0x10" → 16, "1e3" → 1000,
   * "" → 0) would fabricate a price out of garbage, so the shape is
   * checked first and anything else becomes NaN (→ "n/a").
   */
  _parsePrice(raw) {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
      return Number(raw.trim());
    }
    return NaN;
  },

  /**
   * Money formatting with LOCALE-INDEPENDENT grouping (ADR 006 §10).
   * toLocaleString is forbidden: under the server's locale it may emit
   * "7.500" or "7 500". Instead: round with toFixed, then comma-group the
   * INTEGER part only: 600000.00 → "600,000.00", never "6,00,000.00".
   *
   * ROUNDING NOTE: toFixed's result at ".xx5" boundaries is decided by the
   * IEEE-754 float representation, NOT by a clean "half up" rule — most
   * such values are stored slightly LOW and round down ((1.005).toFixed(2)
   * === "1.00"). The tests pin real examples in both directions so nobody
   * "fixes" this blind; for market prices a half-cent boundary is noise.
   */
  _formatMoney(value, decimals) {
    const fixed = value.toFixed(decimals);
    const parts = fixed.split('.');
    // Insert a comma at every position with a multiple-of-three digits to
    // its right: \B = not at the start, lookahead = groups of exactly 3
    // digits to the end of the integer part. Pinned by the 999/1,000 and
    // 1,234,567 tests.
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Formatter };
