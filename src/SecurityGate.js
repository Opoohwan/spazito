/**
 * SecurityGate.js — SHELL module. The webhook AUTHORIZATION gate
 * (ADR 008 §2). CommandHandler asks exactly one question — "may this
 * request act?" — and this module answers it. No other module makes auth
 * decisions.
 *
 * Layers checked here (Chunk 8a):
 *   1. URL bearer token — the webhook URL Twilio POSTs to carries
 *      ?k=<WEBHOOK_TOKEN>; it arrives as e.parameter.k. This is the
 *      GAS-legal substitute for Twilio signature validation (a GAS web
 *      app cannot read request headers — ADR 008).
 *   2. From == RECIPIENT_NUMBER — only the recipient's phone may command
 *      the bot. Spoofable alone, which is why it is one layer of several.
 *
 * Layers landing in Chunk 8b, in this same module: MessageSid replay
 * protection, auto-lockout after N failures, and the pull-based audit log.
 * DESIGN NOTE for 8b (decided at the 8a gate): the boolean authorize(e)
 * seam stays. A SEALED bot still answers false to everyone — the unlock
 * re-arm is handled INSIDE this gate (it has the whole event, so it can
 * recognize "unlock <UNLOCK_SECRET>" while sealed and re-arm before
 * answering), not by CommandHandler dispatch.
 *
 * CONTRACT: every comparison is constant-time (core/SecureCompare), BOTH
 * layers are always evaluated (no early exit that leaks which layer
 * failed), secrets are read fresh from Config (never cached — ADR 008 §1),
 * and a rejection is SILENT to the caller — no reply, no oracle. The log
 * line for a rejection carries no attacker-controlled data (no From
 * echo — hashing it for the audit trail is 8b's job).
 */
const SecurityGate = {
  /**
   * True when this webhook request may act. Never throws for a merely
   * hostile request; a broken CONFIG (missing token/number) does throw —
   * that's a deploy fault that must fail loud (ADR 006 §8), and
   * CommandHandler's catch still answers the wire with a silent 200.
   */
  authorize(e) {
    const params = (e && e.parameter) || {};

    // Evaluate every layer unconditionally, then combine — a short-circuit
    // would let response timing hint at which layer rejected.
    const tokenOk = SecureCompare.equals(String(params.k || ''), Config.require('WEBHOOK_TOKEN'));
    const fromOk = SecureCompare.equals(String(params.From || ''), Config.require('RECIPIENT_NUMBER'));

    const allowed = tokenOk && fromOk;
    if (!allowed) {
      // Deliberately vague: which layer failed is not logged (that detail
      // plus the execution log would help an attacker tune requests), and
      // nothing attacker-controlled is echoed.
      console.warn('Webhook request rejected by the security gate (silent 200 returned).');
    }
    return allowed;
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { SecurityGate };
