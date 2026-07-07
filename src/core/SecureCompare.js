/**
 * core/SecureCompare.js — PURE core module (no I/O, no Apps Script globals).
 *
 * Constant-time string equality for the webhook auth gate (ADR 008 §2:
 * "all constant-time"). A naive === comparison can bail out at the first
 * differing character, which in principle lets an attacker measure response
 * times to guess a secret one character at a time. This comparison always
 * walks the entire string and folds every difference into one number, so
 * the time taken doesn't depend on WHERE the strings differ.
 *
 * (On Apps Script the network jitter dwarfs any such signal — this is
 * defense-in-depth, and it costs nothing.)
 */
const SecureCompare = {
  /**
   * True when a and b are identical strings. Non-strings are never equal
   * to anything (fail closed). Length differences still walk the full
   * expected string so timing stays length-independent.
   */
  equals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    // Start with the length difference folded in, then XOR every character
    // pair. Comparing against `a` itself when lengths differ keeps the
    // loop length tied to the CALLER-supplied value, not the secret.
    let diff = a.length === b.length ? 0 : 1;
    const other = a.length === b.length ? b : a;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ other.charCodeAt(i);
    }
    return diff === 0;
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { SecureCompare };
