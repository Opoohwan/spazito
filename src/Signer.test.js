// Tests for Signer — the [#N TAG] auth block. THE AUTHORITATIVE CONTRACT
// IS tools/spazito-verifier.html: these tests recompute the tag with an
// INDEPENDENT implementation (Node's crypto, exactly what the verifier's
// Web Crypto does) and parse the output with the verifier's own regex, so
// the GAS signer and the offline verifier can never drift apart silently.
const crypto = require('crypto');
const {
  installPropertiesService,
  installLockService,
  installUtilities,
  installFake,
  uninstallGasGlobals,
} = require('../test/gasMocks');
const { Signer } = require('./Signer');
const { SecurityVault } = require('./SecurityVault');
const { Locks } = require('./Locks');

const KEY = 'fake-verifier-key';

// The verifier's exact parsing regex (tools/spazito-verifier.html:127).
const VERIFIER_REGEX = /\[#(\d+)\s+([0-9A-Fa-f]{8})\]\s*$/;

// Independent tag computation — mirrors the verifier: first 8 hex chars,
// uppercase, of HMAC-SHA256(key, canonical).
function expectedTag(sequence, payload) {
  return crypto
    .createHmac('sha256', KEY)
    .update(sequence + '|' + payload, 'utf8')
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

let props;

function installConfig({ debug = false } = {}) {
  installFake('Config', {
    require: (key) => {
      if (key !== 'VERIFIER_KEY') throw new Error('unexpected key: ' + key);
      return KEY;
    },
    isDebugMode: () => debug,
  });
}

beforeEach(() => {
  props = installPropertiesService({});
  installLockService();
  installUtilities(); // real HMAC, GAS-style signed bytes
  installFake('Locks', Locks);
  installFake('SecurityVault', SecurityVault); // real vault over fake storage
  installConfig();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('the signed message matches the offline verifier, byte for byte', () => {
  test('golden vector: the ADR 008 example line signs to what the verifier will compute', () => {
    const line = 'S&P 7,500 | Gold 4,500 | Silver 70.00';
    const signed = Signer.sign(line);

    const match = signed.match(VERIFIER_REGEX);
    expect(match).not.toBeNull();
    const [, n, tag] = match;
    expect(n).toBe('1'); // first message ever → sequence 1
    expect(tag).toBe(expectedTag(1, line));
    // The payload the verifier will reconstruct is exactly the original line.
    expect(signed.slice(0, match.index).trim()).toBe(line);
  });

  test('the tag is bound to BOTH the sequence and the content', () => {
    const first = Signer.sign('S&P 7,500');
    const second = Signer.sign('S&P 7,500'); // same text, next sequence
    const tagOf = (msg) => msg.match(VERIFIER_REGEX)[2];
    expect(tagOf(first)).toBe(expectedTag(1, 'S&P 7,500'));
    expect(tagOf(second)).toBe(expectedTag(2, 'S&P 7,500'));
    expect(tagOf(first)).not.toBe(tagOf(second)); // a replayed tag can't fit a new N
  });

  test('the payload is trimmed before signing — canonical exactly as the verifier rebuilds it', () => {
    const signed = Signer.sign('  Gold 4,500  ');
    const match = signed.match(VERIFIER_REGEX);
    expect(match[2]).toBe(expectedTag(1, 'Gold 4,500'));
    expect(signed.startsWith('Gold 4,500 [#')).toBe(true);
  });
});

describe('the LIVE verifier file is the contract — not a copied snapshot of it', () => {
  test('tools/spazito-verifier.html still parses, canonicalizes, and truncates the way we sign', () => {
    // If the verifier is ever edited (different separator, tag length,
    // regex), this fails and points at the real drift — the header's
    // "can never drift apart silently" claim is enforced here.
    const fs = require('fs');
    const path = require('path');
    const verifier = fs.readFileSync(
      path.join(__dirname, '..', 'tools', 'spazito-verifier.html'),
      'utf8'
    );
    expect(verifier).toContain('/\\[#(\\d+)\\s+([0-9A-Fa-f]{8})\\]\\s*$/'); // the parse regex
    expect(verifier).toContain('n + "|" + payload'); // the canonical input
    expect(verifier).toContain('.slice(0,8)'); // the tag truncation
    expect(verifier).toContain('F7BC83F430538424B13298E6AA6FB143'); // the self-test vector
  });
});

describe('the sequence counter', () => {
  test('climbs by exactly 1 per sent alert and persists', () => {
    Signer.sign('a');
    Signer.sign('b');
    Signer.sign('c');
    expect(props.getProperty('SEC_MSG_COUNT')).toBe('3');
  });

  test('DEBUG_MODE previews the next number WITHOUT consuming it — no false gaps for the recipient', () => {
    Signer.sign('live one'); // sequence 1
    installConfig({ debug: true });
    const debugSigned = Signer.sign('debug run');
    expect(debugSigned).toContain('[#2 '); // shows what WOULD go out
    expect(props.getProperty('SEC_MSG_COUNT')).toBe('1'); // nothing consumed

    installConfig({ debug: false });
    const nextLive = Signer.sign('live two');
    expect(nextLive).toContain('[#2 '); // the real #2 — gapless
  });

  test('a busy vault degrades to sending UNSIGNED — the prices still go out (ADR 006 §9)', () => {
    installFake('SecurityVault', { nextSequence: () => null, currentSequence: () => 0 });
    const result = Signer.sign('S&P 7,500');
    expect(result).toBe('S&P 7,500'); // no block appended
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unsigned'));
  });
});
