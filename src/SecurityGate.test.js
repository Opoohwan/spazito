// Tests for SecurityGate — the webhook authorization gate (Chunk 8a
// layers: URL token + From; replay/lockout/audit land in 8b). Config is
// mocked; SecureCompare is the real core module (it IS the contract).
const { installFake, uninstallGasGlobals } = require('../test/gasMocks');
const { SecurityGate } = require('./SecurityGate');

const TOKEN = 'fake-webhook-token-64chars';
const RECIPIENT = '+17075559876';

function installConfig() {
  const requiredKeys = [];
  installFake('Config', {
    require: (key) => {
      requiredKeys.push(key);
      if (key === 'WEBHOOK_TOKEN') return TOKEN;
      if (key === 'RECIPIENT_NUMBER') return RECIPIENT;
      throw new Error('unexpected key: ' + key);
    },
  });
  return requiredKeys;
}

// A Twilio-shaped event: form fields land in e.parameter.
function event({ k = TOKEN, From = RECIPIENT, Body = 'list' } = {}) {
  return { parameter: { k, From, Body, MessageSid: 'SMfake' } };
}

beforeEach(() => {
  installConfig();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('the layered gate — all layers must pass', () => {
  test('valid token AND matching From → allowed', () => {
    expect(SecurityGate.authorize(event())).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('wrong token → rejected, even with the right From', () => {
    expect(SecurityGate.authorize(event({ k: 'wrong-token' }))).toBe(false);
  });

  test('missing token → rejected (a bare exec URL is not enough)', () => {
    const e = event();
    delete e.parameter.k;
    expect(SecurityGate.authorize(e)).toBe(false);
  });

  test('right token but a stranger\'s From → rejected', () => {
    expect(SecurityGate.authorize(event({ From: '+15555550000' }))).toBe(false);
  });

  test('missing From → rejected', () => {
    const e = event();
    delete e.parameter.From;
    expect(SecurityGate.authorize(e)).toBe(false);
  });

  test('a malformed event (no parameter at all) → rejected, never a throw', () => {
    expect(SecurityGate.authorize(undefined)).toBe(false);
    expect(SecurityGate.authorize({})).toBe(false);
    expect(SecurityGate.authorize({ parameter: null })).toBe(false);
  });
});

describe('rejection behavior — quiet and information-free', () => {
  test('BOTH layers are evaluated even when the first fails — no short-circuit to time against', () => {
    const requiredKeys = installConfig();
    SecurityGate.authorize(event({ k: 'wrong-token' }));
    // A short-circuit mutant would never read RECIPIENT_NUMBER on a bad token.
    expect(requiredKeys).toContain('WEBHOOK_TOKEN');
    expect(requiredKeys).toContain('RECIPIENT_NUMBER');
  });

  test('the rejection log names NO layer and echoes NOTHING attacker-controlled', () => {
    SecurityGate.authorize(event({ k: 'attacker-token', From: '+15555550000' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = console.warn.mock.calls[0].join(' ');
    expect(logged).not.toContain('attacker-token');
    expect(logged).not.toContain('5555550000');
    expect(logged.toLowerCase()).not.toContain('token'); // no which-layer hint
    expect(logged.toLowerCase()).not.toContain('from');
  });

  test('secrets are read fresh on every call — a rotated token applies immediately', () => {
    expect(SecurityGate.authorize(event())).toBe(true);
    installFake('Config', {
      require: (key) => (key === 'WEBHOOK_TOKEN' ? 'rotated-token' : RECIPIENT),
    });
    expect(SecurityGate.authorize(event())).toBe(false); // old token now rejected
    expect(SecurityGate.authorize(event({ k: 'rotated-token' }))).toBe(true);
  });

  test('a missing CONFIG key throws (deploy fault — loud), unlike a hostile request (quiet)', () => {
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
