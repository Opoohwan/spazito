/**
 * core/Redactor.js — PURE core module (no I/O, no Apps Script globals).
 *
 * The ONE owner of log redaction: scrub anything secret-shaped out of a
 * string before it can reach a log (ADR 006 §11, ADR 008 §1). Both API
 * shells (PriceService, SmsService) route every logged error string
 * through here — a security control implemented once, hardened once.
 *
 * Why this exists (Chunk 6 council gate): each shell had grown its own
 * `_scrub` with a different pattern set. Whichever copy got hardened after
 * an incident, the other would keep leaking. Redaction is a pure
 * string→string concern — exactly the "missing named concept" ADR 006 §7
 * says to name and give a home (this is NOT a Utils grab-bag; it owns one
 * domain: keeping secrets out of logs).
 *
 * The patterns are a UNION of every caller's needs — over-redacting an
 * error message is always safe; under-redacting never is:
 *   - URLs                — real GAS network exceptions embed the full
 *                           request URL (Alpha Vantage: carries apikey;
 *                           Twilio: carries the account SID)
 *   - apikey=… values     — belt-and-suspenders outside URLs
 *   - Basic-auth blobs    — "Basic dXNlcjpwYXNz…" would be credentials
 *   - AC/SK hex SIDs      — Twilio account / API-key SIDs
 *   - phone-length runs   — Twilio error text echoes the To number back
 *                           ("The 'To' number +1707… is not valid")
 */
const Redactor = {
  /**
   * Return the text with every secret-shaped substring replaced by a
   * bracketed placeholder. Total: any input (null, an Error, a number) is
   * String()-coerced first — scrubbing must never itself throw.
   *
   * Order matters: URLs first (they swallow embedded apikey/SIDs whole),
   * then the narrower patterns for anything standing alone.
   */
  scrub(text) {
    return String(text)
      .replace(/https?:\/\/\S*/gi, '[url redacted]')
      .replace(/apikey=[^&\s"']*/gi, 'apikey=REDACTED')
      .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, '[auth redacted]')
      .replace(/\b(AC|SK)[0-9a-f]{32}\b/gi, '[sid redacted]')
      .replace(/\+?\d[\d\-\s().]{6,}\d/g, '[number redacted]');
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Redactor };
