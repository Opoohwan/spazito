/**
 * Locks.js — SHELL module. The ONE home of the script-lock discipline
 * (ADR 006 §5): acquire with a timeout → do the work → ALWAYS release in
 * finally; a timeout runs the caller's busy-path instead, and since the
 * lock was never acquired, nothing is released.
 *
 * Exists because TWO modules own lock-guarded state (Watchlist and
 * SecurityVault) — per §7, a concept two modules need gets a name and one
 * home, never a second copy that can drift.
 */
const Locks = {
  /**
   * Run `mutate` inside the script lock. On timeout, run `onBusy` instead
   * (log first — a contended lock must never fail silently).
   *
   * The timeout must stay well under Twilio's ~15s webhook window: if the
   * lock can't be had in a few seconds, the caller replies "busy" itself
   * rather than letting the request stall.
   */
  withScriptLock(timeoutMs, mutate, onBusy) {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(timeoutMs); // throws if not acquired in time
    } catch (e) {
      console.warn('Could not acquire the script lock within ' + timeoutMs + 'ms; taking the busy path.');
      return onBusy();
    }
    try {
      return mutate();
    } finally {
      lock.releaseLock();
    }
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Locks };
