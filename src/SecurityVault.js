/**
 * SecurityVault.js — SHELL module. The single owner of all SECURITY STATE
 * (ADR 008; same single-owner discipline as Watchlist, ADR 006 §5):
 * the message sequence counter, the lockout failure-count + sealed flag,
 * the recent-MessageSid replay set, and the bounded audit log.
 *
 * No other module reads or writes these Script Properties — SecurityGate
 * asks questions ("sealed? replayed?"), Signer asks for the next sequence
 * number, CommandHandler asks for the recent audit. The storage encodings
 * are this module's private detail.
 *
 * FAIL-CLOSED RULE: when a security decision can't be made (lock busy,
 * corrupted state), the answer that keeps the bot SAFE wins — a replay
 * check that can't run reports "replayed" (reject one message) rather
 * than waving through a possible replay.
 *
 * All writes run under the shared script lock (Locks, ADR 006 §5).
 * Timestamps come from new Date() — allowed in shell, never in core.
 */
const SecurityVault = {
  // Consecutive failed authorizations before the bot SEALS itself and
  // ignores everyone until re-armed with the UNLOCK_SECRET (ADR 008 §3).
  // Five: a human typo never gets near it; a probing script trips it fast.
  MAX_FAILURES: 5,

  // How long a seen MessageSid stays in the replay set. Twilio SIDs are
  // unique forever — the TTL only bounds STORAGE, and 24h comfortably
  // covers any realistic replay of a captured request.
  SID_TTL_MS: 24 * 60 * 60 * 1000,

  // Bounds that keep each property comfortably under the ~9KB value limit.
  MAX_SIDS: 50,
  MAX_AUDIT_ENTRIES: 20,

  LOCK_TIMEOUT_MS: 5000,

  // The Script Property keys this module owns (see SCHEMA.md).
  _KEYS: Object.freeze({
    COUNTER: 'SEC_MSG_COUNT',
    FAILURES: 'SEC_FAILURES',
    SEALED: 'SEC_SEALED',
    SIDS: 'SEC_SEEN_SIDS',
    AUDIT: 'SEC_AUDIT',
  }),

  // ---- message sequence counter (for the [#N TAG] signer) ----

  /** The last sequence number that was issued (0 before the first send). */
  currentSequence() {
    const raw = PropertiesService.getScriptProperties().getProperty(this._KEYS.COUNTER);
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  },

  /**
   * Claim the next sequence number (locked read-modify-write — two
   * near-simultaneous sends must never share an N; a duplicate N reads as
   * a REPLAY in the recipient's verifier).
   * Busy → null; the caller decides what a send without a number does.
   */
  nextSequence() {
    return Locks.withScriptLock(this.LOCK_TIMEOUT_MS, () => {
      const next = this.currentSequence() + 1;
      PropertiesService.getScriptProperties().setProperty(this._KEYS.COUNTER, String(next));
      return next;
    }, () => null);
  },

  // ---- MessageSid replay protection (ADR 008 §2.4) ----

  /**
   * Record a MessageSid; report whether it was already seen. Fail-closed:
   * a missing/blank sid, or a lock that can't be had, reports replayed:true.
   * The stored set is pruned by TTL and capped by count.
   */
  checkAndRecordSid(sid) {
    if (typeof sid !== 'string' || sid.trim() === '') return { replayed: true };
    const cleanSid = sid.trim();
    return Locks.withScriptLock(this.LOCK_TIMEOUT_MS, () => {
      const props = PropertiesService.getScriptProperties();
      const now = Date.now();
      const seen = this._readJson(this._KEYS.SIDS, []);
      const fresh = seen.filter((entry) => entry && (now - entry.t) < this.SID_TTL_MS);
      if (fresh.some((entry) => entry.sid === cleanSid)) return { replayed: true };
      fresh.push({ sid: cleanSid, t: now });
      // Cap by dropping the OLDEST — the newest sids are the replay risk.
      const bounded = fresh.slice(-this.MAX_SIDS);
      props.setProperty(this._KEYS.SIDS, JSON.stringify(bounded));
      return { replayed: false };
    }, () => ({ replayed: true })); // can't check → don't trust it
  },

  // ---- lockout (ADR 008 §3) ----

  /** True when the bot has sealed itself and ignores everything but unlock. */
  isSealed() {
    return PropertiesService.getScriptProperties().getProperty(this._KEYS.SEALED) === 'true';
  },

  /**
   * Count one failed authorization. IMPORTANT (8b gate): the gate only
   * calls this for TOKEN-VALID failures — a targeted probe by someone who
   * holds the secret webhook URL. Ambient junk texts (no/wrong token, the
   * overwhelming majority of hostile traffic) never reach here, so they
   * can neither seal the bot nor burn storage quota.
   *
   * At MAX_FAILURES the bot seals. Returns { sealed, justSealed } —
   * justSealed is true exactly once, on the transition, so the caller can
   * fire the single "sealed" notice (ADR 008 §4, amended ON at the 8b
   * gate: a silently-sealed bot left the recipient dark).
   * Busy → counts nothing (one uncounted probe is safer than blocking).
   */
  registerFailure(from) {
    return Locks.withScriptLock(this.LOCK_TIMEOUT_MS, () => {
      const props = PropertiesService.getScriptProperties();
      const failures = (parseInt(props.getProperty(this._KEYS.FAILURES), 10) || 0) + 1;
      props.setProperty(this._KEYS.FAILURES, String(failures));
      this._appendAudit('rejected', from);
      if (failures >= this.MAX_FAILURES && !this.isSealed()) {
        props.setProperty(this._KEYS.SEALED, 'true');
        this._appendAudit('sealed', from);
        console.error(
          'SecurityVault: ' + failures + ' consecutive rejected token-valid requests — the bot ' +
          'has SEALED itself and will ignore everything until re-armed with the unlock secret ' +
          '(ADR 008 §3).'
        );
        return { sealed: true, justSealed: true };
      }
      return { sealed: this.isSealed(), justSealed: false };
    }, () => ({ sealed: this.isSealed(), justSealed: false }));
  },

  /** A successful authorization clears the consecutive-failure count. */
  resetFailures() {
    const props = PropertiesService.getScriptProperties();
    if ((parseInt(props.getProperty(this._KEYS.FAILURES), 10) || 0) === 0) return; // no write needed
    Locks.withScriptLock(this.LOCK_TIMEOUT_MS, () => {
      PropertiesService.getScriptProperties().setProperty(this._KEYS.FAILURES, '0');
    }, () => {});
  },

  /**
   * Re-arm after a lockout (the gate verified the unlock secret first).
   * Returns true only when the state ACTUALLY flipped — a busy lock
   * returns false so the caller never confirms an unseal that didn't
   * happen (8b gate: the old void version let "unlocked and running" be
   * sent while the bot stayed sealed).
   */
  unseal(from) {
    return Locks.withScriptLock(this.LOCK_TIMEOUT_MS, () => {
      const props = PropertiesService.getScriptProperties();
      props.setProperty(this._KEYS.SEALED, 'false');
      props.setProperty(this._KEYS.FAILURES, '0');
      this._appendAudit('unsealed', from);
      return true;
    }, () => {
      console.warn('SecurityVault: could not unseal (lock busy) — text unlock again.');
      return false;
    });
  },

  // ---- audit (ADR 008 §4: pull, not push) ----

  /** Record a security event outside the failure path (e.g. a replay). */
  recordAudit(kind, from) {
    Locks.withScriptLock(this.LOCK_TIMEOUT_MS, () => {
      this._appendAudit(kind, from);
    }, () => {});
  },

  /** The most recent audit entries, newest first: [{ t, k, s }]. */
  recentAudit(count) {
    return this._readJson(this._KEYS.AUDIT, []).slice(-count).reverse();
  },

  /**
   * A sender only ever appears in the audit as a salted HASH (ADR 008 §1
   * — the number itself exists nowhere reachable): first 6 hex chars of
   * HMAC-SHA256(VERIFIER_KEY, number). Enough to see "same sender again",
   * never enough to recover the number.
   */
  hashSender(from) {
    const bytes = Utilities.computeHmacSha256Signature(String(from || ''), Config.require('VERIFIER_KEY'));
    let hex = '';
    for (let i = 0; i < 3; i++) {
      hex += ((bytes[i] + 256) % 256).toString(16).padStart(2, '0');
    }
    return hex.toUpperCase();
  },

  /** Append one audit entry (caller already holds the lock). */
  _appendAudit(kind, from) {
    const props = PropertiesService.getScriptProperties();
    const entries = this._readJson(this._KEYS.AUDIT, []);
    entries.push({ t: new Date().toISOString(), k: kind, s: this.hashSender(from) });
    props.setProperty(this._KEYS.AUDIT, JSON.stringify(entries.slice(-this.MAX_AUDIT_ENTRIES)));
  },

  /** Parse one of our JSON properties; corrupted state degrades to the fallback. */
  _readJson(key, fallback) {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    if (raw === null) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
      console.warn('SecurityVault: ' + key + ' was corrupted; starting it fresh.');
      return fallback;
    }
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { SecurityVault };
