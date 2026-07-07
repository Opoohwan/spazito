/**
 * SecurityGate.js — SHELL module. The webhook AUTHORIZATION gate
 * (ADR 008 §2/§3). CommandHandler asks exactly one question — "may this
 * request act?" — and this module answers it. No other module makes auth
 * decisions.
 *
 * The layers, in order (ALL must pass):
 *   1. SEALED check — after MAX_FAILURES token-valid rejections the bot
 *      ignores everyone (ADR 008 §3). While sealed, the ONLY thing that
 *      works is "unlock <UNLOCK_SECRET>" — which must ALSO carry the valid
 *      URL token, the recipient's From, and a FRESH MessageSid (a captured
 *      unlock request cannot re-arm the bot).
 *   2. URL bearer token — the webhook URL carries ?k=<WEBHOOK_TOKEN>
 *      (e.parameter.k). The GAS-legal substitute for signature validation
 *      (a GAS web app cannot read request headers — ADR 008).
 *   3. From == RECIPIENT_NUMBER — only the recipient's phone may command
 *      the bot.
 *   4. MessageSid replay lock — a captured request cannot be re-fired.
 *
 * WHAT COUNTS TOWARD THE SEAL (decided at the 8b gate): only failures
 * that carried the VALID TOKEN — a targeted probe by someone holding the
 * secret webhook URL. Ambient junk texts (spam randomly hitting the
 * Twilio number — no token) are rejected for ONE property read with ZERO
 * writes: they can never seal the bot (self-DoS) and can never drain the
 * storage quota (flood-DoS). The audit therefore records only signal,
 * never ambient noise.
 *
 * CONTRACT: comparisons are constant-time (core/SecureCompare) and the
 * token/From layers are BOTH always evaluated. Secrets are read fresh
 * (ADR 008 §1). A rejection is SILENT to the caller — no reply, no oracle.
 *
 * Returns a decision object { allowed, justSealed } — justSealed is true
 * exactly once, at the sealing transition, so CommandHandler can send the
 * single "🔒 sealed" notice (the ONLY proactive security text — ADR 008 §4).
 */
const SecurityGate = {
  /**
   * The decision for this webhook request. Never throws for a merely
   * hostile request; a broken CONFIG (missing token/number) does throw —
   * that's a deploy fault that must fail loud (ADR 006 §8), and
   * CommandHandler's catch still answers the wire with a silent 200.
   */
  authorize(e) {
    const params = (e && e.parameter) || {};

    // Layer 1: sealed. One property read; everything is ignored except a
    // fully-authenticated, replay-fresh unlock. No writes on this path —
    // a sealed bot must be nearly free to flood (see header).
    if (SecurityVault.isSealed()) {
      if (this._tryUnseal(params)) {
        SecurityVault.resetFailures();
        return { allowed: true, justSealed: false };
      }
      return { allowed: false, justSealed: false };
    }

    // Layers 2+3: evaluate BOTH unconditionally, then combine — a
    // short-circuit would let response timing hint at which layer failed.
    const tokenOk = SecureCompare.equals(String(params.k || ''), Config.require('WEBHOOK_TOKEN'));
    const fromOk = SecureCompare.equals(String(params.From || ''), Config.require('RECIPIENT_NUMBER'));

    if (!(tokenOk && fromOk)) {
      // Deliberately vague log: which layer failed is not stated, and
      // nothing attacker-controlled is echoed.
      console.warn('Webhook request rejected by the security gate (silent 200 returned).');
      if (tokenOk) {
        // Token valid, From wrong: a TARGETED probe — count it (see header).
        const failure = SecurityVault.registerFailure(params.From);
        return { allowed: false, justSealed: failure.justSealed };
      }
      // Ambient junk: rejected without touching state.
      return { allowed: false, justSealed: false };
    }

    // Layer 4: replay. Fail-closed — a missing sid (real Twilio always
    // sends one) or an uncheckable one is treated as a replay.
    const replay = SecurityVault.checkAndRecordSid(params.MessageSid);
    if (replay.replayed) {
      console.warn('Webhook request rejected: repeated or missing MessageSid (replay protection).');
      SecurityVault.recordAudit('replay', params.From);
      return { allowed: false, justSealed: false };
    }

    SecurityVault.resetFailures();
    return { allowed: true, justSealed: false };
  },

  /**
   * While sealed: re-arm ONLY for a request that carries the correct
   * unlock secret AND the valid token AND the recipient's From AND a
   * fresh MessageSid — all checked here because the normal layers are
   * skipped while sealed. The body is parsed with the same pure parser as
   * everything else ("UNLOCK <secret>" works regardless of the verb's
   * case while the secret itself stays untouched — ARG_SPECS 'raw').
   *
   * Returns true only when the bot ACTUALLY unsealed: a busy vault lock
   * reports false, so a confirmation can never be sent for an unseal that
   * didn't happen — the recipient just texts unlock again.
   */
  _tryUnseal(params) {
    const intent = CommandParser.parse(params.Body);
    if (intent.type !== CommandParser.TYPES.UNLOCK || !intent.arg) return false;

    const secretOk = SecureCompare.equals(intent.arg, Config.require('UNLOCK_SECRET'));
    const tokenOk = SecureCompare.equals(String(params.k || ''), Config.require('WEBHOOK_TOKEN'));
    const fromOk = SecureCompare.equals(String(params.From || ''), Config.require('RECIPIENT_NUMBER'));
    if (!(secretOk && tokenOk && fromOk)) return false;

    // A REPLAYED unlock must not re-arm the bot (a captured re-armer
    // would defeat the whole lockout). Checked BEFORE the unseal write.
    if (SecurityVault.checkAndRecordSid(params.MessageSid).replayed) return false;

    if (!SecurityVault.unseal(params.From)) return false;
    console.log('SecurityGate: unlock accepted — the bot is re-armed.');
    return true;
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { SecurityGate };
