// Tests for SecurityVault — the sole owner of security state. Storage,
// locks, and HMAC (for sender hashing) are all faked; Locks is the real
// module over the fake LockService.
const {
  installPropertiesService,
  installLockService,
  installUtilities,
  installFake,
  uninstallGasGlobals,
} = require('../test/gasMocks');
const { SecurityVault } = require('./SecurityVault');
const { Locks } = require('./Locks');

let props;

beforeEach(() => {
  props = installPropertiesService({});
  installLockService();
  installUtilities();
  installFake('Locks', Locks);
  installFake('Config', { require: () => 'fake-verifier-key' });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('the sequence counter', () => {
  test('starts at 0, increments atomically, survives corrupted state', () => {
    expect(SecurityVault.currentSequence()).toBe(0);
    expect(SecurityVault.nextSequence()).toBe(1);
    expect(SecurityVault.nextSequence()).toBe(2);
    props.setProperty('SEC_MSG_COUNT', 'garbage');
    expect(SecurityVault.currentSequence()).toBe(0); // degraded, not crashed
    expect(SecurityVault.nextSequence()).toBe(1);
  });

  test('a busy lock yields null — the caller decides what an unnumbered send does', () => {
    installLockService({ failWait: true });
    expect(SecurityVault.nextSequence()).toBeNull();
  });
});

describe('replay protection (fail closed)', () => {
  test('a fresh sid is recorded; the same sid again is a replay', () => {
    expect(SecurityVault.checkAndRecordSid('SM111')).toEqual({ replayed: false });
    expect(SecurityVault.checkAndRecordSid('SM111')).toEqual({ replayed: true });
    expect(SecurityVault.checkAndRecordSid('SM222')).toEqual({ replayed: false });
  });

  test('missing/blank/non-string sids are ALWAYS treated as replays', () => {
    expect(SecurityVault.checkAndRecordSid(undefined).replayed).toBe(true);
    expect(SecurityVault.checkAndRecordSid('').replayed).toBe(true);
    expect(SecurityVault.checkAndRecordSid('   ').replayed).toBe(true);
    expect(SecurityVault.checkAndRecordSid(42).replayed).toBe(true);
  });

  test('a busy lock cannot wave a message through', () => {
    installLockService({ failWait: true });
    expect(SecurityVault.checkAndRecordSid('SM333').replayed).toBe(true);
  });

  test('expired sids age out (TTL) and the set is capped at MAX_SIDS', () => {
    const old = Date.now() - SecurityVault.SID_TTL_MS - 1000;
    props.setProperty('SEC_SEEN_SIDS', JSON.stringify([{ sid: 'SMOLD', t: old }]));
    // The expired sid no longer counts as seen:
    expect(SecurityVault.checkAndRecordSid('SMOLD').replayed).toBe(false);

    const many = Array.from({ length: SecurityVault.MAX_SIDS + 5 }, (_, i) => ({
      sid: 'SM' + i,
      t: Date.now(),
    }));
    props.setProperty('SEC_SEEN_SIDS', JSON.stringify(many));
    SecurityVault.checkAndRecordSid('SMNEW');
    const stored = JSON.parse(props.getProperty('SEC_SEEN_SIDS'));
    expect(stored.length).toBeLessThanOrEqual(SecurityVault.MAX_SIDS);
    expect(stored[stored.length - 1].sid).toBe('SMNEW'); // newest kept
  });

  test('corrupted sid storage degrades to an empty set with a warning, never a throw', () => {
    props.setProperty('SEC_SEEN_SIDS', '{broken');
    expect(SecurityVault.checkAndRecordSid('SM1').replayed).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('lockout (ADR 008 §3)', () => {
  test('not sealed by default; seals at exactly MAX_FAILURES, reporting the transition ONCE', () => {
    expect(SecurityVault.isSealed()).toBe(false);
    for (let i = 1; i < SecurityVault.MAX_FAILURES; i++) {
      expect(SecurityVault.registerFailure('+15555550000')).toEqual({ sealed: false, justSealed: false });
    }
    expect(SecurityVault.registerFailure('+15555550000')).toEqual({ sealed: true, justSealed: true });
    expect(SecurityVault.isSealed()).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SEALED'));
    // beyond the threshold: still sealed, but never "just" sealed again
    expect(SecurityVault.registerFailure('+15555550000')).toEqual({ sealed: true, justSealed: false });
  });

  test('failures beyond the threshold keep it sealed without a duplicate seal event', () => {
    for (let i = 0; i < SecurityVault.MAX_FAILURES; i++) SecurityVault.registerFailure('+1555');
    const sealEvents = SecurityVault.recentAudit(50).filter((e) => e.k === 'sealed').length;
    expect(SecurityVault.registerFailure('+1555').sealed).toBe(true);
    expect(SecurityVault.recentAudit(50).filter((e) => e.k === 'sealed').length).toBe(sealEvents);
  });

  test('a failure with NO From (malformed request) still counts and hashes safely', () => {
    expect(() => SecurityVault.registerFailure(undefined)).not.toThrow();
    expect(SecurityVault.recentAudit(1)[0].s).toMatch(/^[0-9A-F]{6}$/);
  });

  test('a success resets the count — failures must be CONSECUTIVE to seal', () => {
    for (let i = 0; i < SecurityVault.MAX_FAILURES - 1; i++) {
      SecurityVault.registerFailure('+15555550000');
    }
    SecurityVault.resetFailures();
    expect(SecurityVault.registerFailure('+15555550000').sealed).toBe(false);
  });

  test('resetFailures skips the write (and the lock) when already 0', () => {
    const recorder = installLockService();
    installFake('Locks', Locks);
    SecurityVault.resetFailures();
    expect(recorder.waitLockCalls).toHaveLength(0);
  });

  test('unseal re-arms, clears the count, and reports TRUE only when it really happened', () => {
    for (let i = 0; i < SecurityVault.MAX_FAILURES; i++) SecurityVault.registerFailure('+1555');
    expect(SecurityVault.isSealed()).toBe(true);
    expect(SecurityVault.unseal('+17075559876')).toBe(true);
    expect(SecurityVault.isSealed()).toBe(false);
    expect(SecurityVault.registerFailure('+1555').sealed).toBe(false); // count restarted
  });

  test('busy locks on the non-critical paths degrade quietly (reset skipped, unseal warns, audit dropped)', () => {
    SecurityVault.registerFailure('+1555'); // failures now 1
    installLockService({ failWait: true });
    installFake('Locks', Locks);
    expect(() => SecurityVault.resetFailures()).not.toThrow();
    expect(() => SecurityVault.recordAudit('replay', '+1555')).not.toThrow();
    expect(SecurityVault.unseal('+1555')).toBe(false); // NOT unsealed — never claim otherwise
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unlock'));
    // a busy registerFailure counts nothing but reports the current sealed state
    expect(SecurityVault.registerFailure('+1555')).toEqual({ sealed: false, justSealed: false });
  });
});

describe('the audit trail (pull, not push — ADR 008 §4)', () => {
  test('records events newest-first with hashed senders — never a raw number', () => {
    SecurityVault.registerFailure('+15555550000');
    SecurityVault.recordAudit('replay', '+15555550000');
    const audit = SecurityVault.recentAudit(5);
    expect(audit).toHaveLength(2);
    expect(audit[0].k).toBe('replay'); // newest first
    expect(audit[1].k).toBe('rejected');
    for (const entry of audit) {
      expect(entry.s).toMatch(/^[0-9A-F]{6}$/); // salted hash, 6 hex chars
      expect(JSON.stringify(entry)).not.toContain('5555550000');
    }
  });

  test('the same sender hashes to the same tag (patterns visible), different senders differ', () => {
    expect(SecurityVault.hashSender('+15555550000')).toBe(SecurityVault.hashSender('+15555550000'));
    expect(SecurityVault.hashSender('+15555550000')).not.toBe(SecurityVault.hashSender('+15555550001'));
  });

  test('the log is a bounded ring — old entries fall off at MAX_AUDIT_ENTRIES', () => {
    for (let i = 0; i < SecurityVault.MAX_AUDIT_ENTRIES + 5; i++) {
      SecurityVault.recordAudit('rejected', '+1555555' + i);
    }
    const stored = JSON.parse(props.getProperty('SEC_AUDIT'));
    expect(stored.length).toBe(SecurityVault.MAX_AUDIT_ENTRIES);
  });

  test('recentAudit(n) returns at most n and survives corrupted storage', () => {
    props.setProperty('SEC_AUDIT', 'not json');
    expect(SecurityVault.recentAudit(5)).toEqual([]);
    // valid JSON that isn't an array degrades the same way
    props.setProperty('SEC_AUDIT', '{"not":"an array"}');
    expect(SecurityVault.recentAudit(5)).toEqual([]);
  });
});
