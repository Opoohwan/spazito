/**
 * core/Tickers.js — PURE core module (no I/O, no Apps Script globals).
 *
 * Owns the canonical ticker text rules for SHELL callers (Watchlist,
 * CommandHandler): normalize user input once, at the boundary, instead of
 * sprinkling .trim()/.toUpperCase() around shell code — pure logic lives in
 * core so it can be unit-tested in Node (ADR 005 / ADR 006 §2).
 *
 * Ownership note (decided at the Chunk 0 council gate): core modules
 * (CommandParser, Formatter) must NOT call this module — core modules are
 * leaves (ADR 006 §2) — so where the standard requires them to defensively
 * uppercase (ADR 006 §10), they do it locally. That small duplication is
 * mandated by the leaf rule; do not "DRY" it into a core→core call.
 */
const Tickers = {
  /**
   * Normalize raw user input into canonical ticker form:
   *   "  tsla " -> "TSLA"
   *
   * Anything that isn't a string (null, undefined, a number from a weird
   * caller) is coerced safely — never throws. Returns "" for empty/absent
   * input; callers treat "" as "no ticker given".
   */
  normalize(raw) {
    if (raw === undefined || raw === null) return '';
    return String(raw).trim().toUpperCase();
  },

  /**
   * True when the input looks like a real ticker symbol: 1–10 characters,
   * letters/digits plus the dot and hyphen real symbols use (BRK.B, BF-B).
   *
   * This is a FORMAT allowlist, not an existence check — "does this symbol
   * actually trade" is Alpha Vantage's question (PriceService answers it).
   * The allowlist is what keeps junk out of the stored watchlist and means
   * nothing weird can ever ride a ticker into an API URL.
   *
   * Normalizes internally (same module, so no leaf-rule issue) — callers
   * don't have to pre-clean.
   */
  isValid(raw) {
    return /^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(this.normalize(raw));
  },
};

// Dual-load guard (ADR 006 §2): in Apps Script `module` is undefined so this
// line is inert; in Node it exposes the module to require() for Jest tests.
// It must stay the LAST line of the file. Coverage note: the "GAS side" of
// this branch can never run under Node, so it is excluded from the branch
// coverage gate rather than permanently costing headroom.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Tickers };
