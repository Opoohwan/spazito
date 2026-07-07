// Tests for SecurityGate — the full layered gate (ADR 008 §2/§3): sealed →
// token → From → replay, with token-gated failure counting (ambient junk
// can never seal the bot). Config and SecurityVault are mocked (the vault
// has its own suite); SecureCompare and CommandParser are the real core.
const { installFake, uninstallGasGlobals } = require('../test/gasMocks');
const { SecurityGate } = require('./SecurityGate');

const TOKEN = 'fake-webhook-token-64chars';
const RECIPIENT = '+17075559876';
const UNLOCK = 'CorrectHorse-Battery_Staple';

function installConfig() {
  const requiredKeys = [];
  installFake('Config', {
    require: (key) => {
      requiredKeys.push(key);
      if (key === 'WEBHOOK_TOKEN') return TOKEN;
      if (key === 'RECIPIENT_NUMBER') return RECIPIENT;
      if (key === 'UNLOCK_SECRET') return UNLOCK;
      throw new Error('unexpected key: ' + key);
    },
  });
  return requiredKeys;
}

// A controllable vault fake with a call recorder.
function installVault({ sealed = false, replayed = false, justSealed = false, unsealBusy = false } = {}) {
  const calls = { failures: [], resets: 0, audits: [], unseals: [], sids: [] };
  let isSealed = sealed;
  installFake('SecurityVault', {
    isSealed: () => isSealed,
    registerFailure: (from) => {
      calls.failures.push(from);
      return { sealed: isSealed, justSealed };
    },
    resetFailures: () => {
      calls.resets += 1;
    },
    checkAndRecordSid: (sid) => {
      calls.sids.push(sid);
      return { replayed };
    },
    recordAudit: (kind, from) => calls.audits.push({ kind, from }),
    unseal: (from) => {
      if (unsealBusy) return false;
      isSealed = false;
      calls.unseals.push(from);
      return true;
    },
  });
  return calls;
}

// A Twilio-shaped event: form fields land in e.parameter.
function event({ k = TOKEN, From = RECIPIENT, Body = 'list', MessageSid = 'SMfresh1' } = {}) {
  return { parameter: { k, From, Body, MessageSid } };
}

beforeEach(() => {
  installConfig();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('the layered gate — all layers must pass', () => {
  test('valid token AND From AND fresh sid → allowed, failures reset', () => {
    const vault = installVault();
    expect(SecurityGate.authorize(event())).toEqual({ allowed: true, justSealed: false });
    expect(vault.resets).toBe(1);
    expect(vault.failures).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('right token but a stranger\'s From → rejected AND counted (a targeted probe)', () => {
    const vault = installVault();
    expect(SecurityGate.authorize(event({ From: '+15555550000' })).allowed).toBe(false);
    expect(vault.failures).toEqual(['+15555550000']);
    expect(vault.resets).toBe(0);
  });

  test('wrong token (ambient junk) → rejected with ZERO state writes — it can never seal the bot', () => {
    const vault = installVault();
    expect(SecurityGate.authorize(event({ k: 'wrong-token' })).allowed).toBe(false);
    expect(vault.failures).toHaveLength(0); // not counted
    expect(vault.audits).toHaveLength(0); // not audited
    expect(vault.sids).toHaveLength(0); // no replay write either
  });

  test('missing token → same ambient treatment (a bare exec URL is not enough)', () => {
    const vault = installVault();
    const e = event();
    delete e.parameter.k;
    expect(SecurityGate.authorize(e).allowed).toBe(false);
    expect(vault.failures).toHaveLength(0);
  });

  test('the sealing transition is reported so the caller can send the ONE notice', () => {
    const vault = installVault({ justSealed: true });
    const decision = SecurityGate.authorize(event({ From: '+15555550000' }));
    expect(decision).toEqual({ allowed: false, justSealed: true });
    expect(vault.failures).toHaveLength(1);
  });

  test('a REPLAYED MessageSid is rejected AFTER token+From pass, and audited', () => {
    const vault = installVault({ replayed: true });
    expect(SecurityGate.authorize(event({ MessageSid: 'SMseen' })).allowed).toBe(false);
    expect(vault.sids).toEqual(['SMseen']);
    expect(vault.audits).toEqual([{ kind: 'replay', from: RECIPIENT }]);
    expect(vault.resets).toBe(0);
  });

  test('the replay layer only runs for otherwise-valid requests (no sid spend on strangers)', () => {
    const vault = installVault();
    SecurityGate.authorize(event({ k: 'wrong' }));
    expect(vault.sids).toHaveLength(0);
  });

  test('a malformed event (no parameter at all) → rejected, never a throw', () => {
    installVault();
    expect(SecurityGate.authorize(undefined).allowed).toBe(false);
    expect(SecurityGate.authorize({}).allowed).toBe(false);
    expect(SecurityGate.authorize({ parameter: null }).allowed).toBe(false);
  });
});

describe('sealed mode (ADR 008 §3) — everything is ignored except a full unlock', () => {
  test('while sealed, even a perfectly valid command is rejected — with ZERO writes (flood-proof)', () => {
    const vault = installVault({ sealed: true });
    expect(SecurityGate.authorize(event({ Body: 'list' })).allowed).toBe(false);
    expect(vault.audits).toHaveLength(0); // post-seal noise is not recorded
    expect(vault.failures).toHaveLength(0);
  });

  test('unlock with the correct secret + token + From + fresh sid re-arms and is allowed', () => {
    const vault = installVault({ sealed: true });
    const decision = SecurityGate.authorize(event({ Body: 'unlock ' + UNLOCK }));
    expect(vault.unseals).toEqual([RECIPIENT]);
    expect(vault.sids).toEqual(['SMfresh1']); // the unlock's own sid was consumed
    expect(decision).toEqual({ allowed: true, justSealed: false });
    expect(vault.resets).toBe(1);
  });

  test('a REPLAYED unlock (captured request re-fired) cannot re-arm the bot', () => {
    const vault = installVault({ sealed: true, replayed: true });
    expect(SecurityGate.authorize(event({ Body: 'unlock ' + UNLOCK })).allowed).toBe(false);
    expect(vault.unseals).toHaveLength(0); // the unseal never happened
  });

  test('a busy vault lock means NOT unsealed — no false "all good" is possible', () => {
    const vault = installVault({ sealed: true, unsealBusy: true });
    expect(SecurityGate.authorize(event({ Body: 'unlock ' + UNLOCK })).allowed).toBe(false);
    expect(vault.unseals).toHaveLength(0);
  });

  test('the unlock secret is case-sensitive and must be exact', () => {
    const vault = installVault({ sealed: true });
    expect(SecurityGate.authorize(event({ Body: 'unlock ' + UNLOCK.toLowerCase() })).allowed).toBe(false);
    expect(vault.unseals).toHaveLength(0);
  });

  test('the correct secret WITHOUT the valid token cannot re-arm (all layers required)', () => {
    const vault = installVault({ sealed: true });
    expect(SecurityGate.authorize(event({ Body: 'unlock ' + UNLOCK, k: 'wrong' })).allowed).toBe(false);
    expect(vault.unseals).toHaveLength(0);
  });

  test('the correct secret with the token/From fields MISSING entirely cannot re-arm', () => {
    const vault = installVault({ sealed: true });
    const e = event({ Body: 'unlock ' + UNLOCK });
    delete e.parameter.k;
    delete e.parameter.From;
    expect(SecurityGate.authorize(e).allowed).toBe(false);
    expect(vault.unseals).toHaveLength(0);
  });

  test('the correct secret from a stranger\'s number cannot re-arm', () => {
    const vault = installVault({ sealed: true });
    expect(
      SecurityGate.authorize(event({ Body: 'unlock ' + UNLOCK, From: '+15555550000' })).allowed
    ).toBe(false);
    expect(vault.unseals).toHaveLength(0);
  });

  test('non-unlock bodies while sealed never even read the unlock secret', () => {
    const requiredKeys = installConfig();
    installVault({ sealed: true });
    SecurityGate.authorize(event({ Body: 'add TSLA' }));
    expect(requiredKeys).not.toContain('UNLOCK_SECRET');
  });

  test('an unlock intent with a null arg (defensive — the real parser prevents it) is rejected', () => {
    installVault({ sealed: true });
    installFake('CommandParser', {
      TYPES: { UNLOCK: 'unlock' },
      parse: () => ({ type: 'unlock', arg: null }),
    });
    expect(SecurityGate.authorize(event({ Body: 'unlock' })).allowed).toBe(false);
  });
});

describe('rejection behavior — quiet and information-free', () => {
  test('BOTH token and From layers are evaluated even when the first fails — no short-circuit', () => {
    const requiredKeys = installConfig();
    installVault();
    SecurityGate.authorize(event({ k: 'wrong-token' }));
    expect(requiredKeys).toContain('WEBHOOK_TOKEN');
    expect(requiredKeys).toContain('RECIPIENT_NUMBER');
  });

  test('the rejection log names NO layer and echoes NOTHING attacker-controlled', () => {
    installVault();
    SecurityGate.authorize(event({ k: 'attacker-token', From: '+15555550000' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = console.warn.mock.calls[0].join(' ');
    expect(logged).not.toContain('attacker-token');
    expect(logged).not.toContain('5555550000');
    expect(logged.toLowerCase()).not.toContain('token'); // no which-layer hint
    expect(logged.toLowerCase()).not.toContain('from');
  });

  test('secrets are read fresh on every call — a rotated token applies immediately', () => {
    installVault();
    expect(SecurityGate.authorize(event()).allowed).toBe(true);
    installFake('Config', {
      require: (key) => {
        if (key === 'WEBHOOK_TOKEN') return 'rotated-token';
        if (key === 'RECIPIENT_NUMBER') return RECIPIENT;
        return UNLOCK;
      },
    });
    expect(SecurityGate.authorize(event()).allowed).toBe(false); // old token now rejected
    expect(
      SecurityGate.authorize(event({ k: 'rotated-token', MessageSid: 'SMfresh2' })).allowed
    ).toBe(true);
  });

  test('a missing CONFIG key throws (deploy fault — loud), unlike a hostile request (quiet)', () => {
    installVault();
    installFake('Config', {
      require: () => {
        const err = new Error('Missing Script Property: WEBHOOK_TOKEN.');
        err.name = 'MissingConfigError';
        throw err;
      },
    });
    expect(() => SecurityGate.authorize(event())).toThrow(
      expect.objectContaining({ name: 'MissingConfigError' })
    );
  });
});
