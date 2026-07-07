/**
 * Signer.js — SHELL module. Appends the [#N TAG] authentication block to
 * the daily price text (ADR 008 §6), so the recipient can prove — offline,
 * with a key only he holds — that a message really came from his bot and
 * wasn't altered.
 *
 * THE CONTRACT IS THE VERIFIER'S (tools/spazito-verifier.html — treat it
 * as authoritative; a golden-vector test pins this module against it):
 *   canonical input = "<N>|<payload>"      payload = the message, trimmed
 *   TAG = first 8 hex chars, UPPERCASE, of HMAC-SHA256(VERIFIER_KEY, canonical)
 *   appended block  = " [#N TAG]"          (matches /\[#(\d+)\s+([0-9A-Fa-f]{8})\]\s*$/)
 *
 * N is the monotonic sequence counter (SecurityVault): +1 per SENT alert.
 * The verifier reads a repeat as a replay and a jump as missed texts —
 * so DEBUG_MODE (which logs instead of sending) must NOT consume a
 * number, or every debug run would show the recipient a false gap.
 * testSendNow DOES consume one: it sends a real, signed text (decided at
 * the Chunk 7 gate).
 *
 * This is a SHELL step (HMAC needs the GAS Utilities global) that runs
 * AFTER the pure Formatter builds the line — signing never happens in core.
 */
const Signer = {
  /**
   * Return the message with its auth block appended. If a sequence number
   * can't be claimed (vault lock busy — vanishingly rare), the message
   * goes out UNSIGNED with a logged warning: the recipient missing one
   * verifiable tag beats missing the day's prices entirely (ADR 006 §9;
   * signer degrade contract decided at the Chunk 7 gate).
   */
  sign(message) {
    const payload = String(message).trim();

    // DEBUG_MODE: the text is only logged, never sent — peek at the next
    // number without consuming it so the live sequence stays gapless.
    const sequence = Config.isDebugMode()
      ? SecurityVault.currentSequence() + 1
      : SecurityVault.nextSequence();

    if (sequence === null) {
      console.warn('Signer: could not claim a sequence number (lock busy) — sending unsigned.');
      return payload;
    }

    return payload + ' [#' + sequence + ' ' + this._tag(sequence, payload) + ']';
  },

  /** First 8 uppercase hex chars of HMAC-SHA256(key, "N|payload"). */
  _tag(sequence, payload) {
    const canonical = sequence + '|' + payload;
    const bytes = Utilities.computeHmacSha256Signature(canonical, Config.require('VERIFIER_KEY'));
    // GAS returns SIGNED bytes (-128..127); normalize each into 0..255
    // before rendering hex, or negative bytes corrupt the tag.
    let hex = '';
    for (let i = 0; i < 4; i++) {
      hex += ((bytes[i] + 256) % 256).toString(16).padStart(2, '0');
    }
    return hex.toUpperCase();
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Signer };
