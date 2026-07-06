// Tests for SmsService — the sole Twilio caller. UrlFetchApp, Utilities,
// and Config are mocked; response bodies come from the golden fixture.
// All numbers/credentials are obvious fakes — but the SIDs are HEX-shaped
// on purpose: the Redactor's SID pattern requires 32 hex chars, and a fake
// like "ACfake…" (k isn't hex) would quietly dodge the very net the leak
// tests exist to prove (Chunk 6 gate finding).
const {
  installUrlFetchApp,
  installUtilities,
  installFake,
  uninstallGasGlobals,
} = require('../test/gasMocks');
const { SmsService } = require('./SmsService');
const fixture = require('../test/fixtures/twilio-message-response.json');

const FAKE = {
  TWILIO_SID: 'ACdeadbeef00deadbeef00deadbeef0000',
  TWILIO_AUTH_TOKEN: 'fake-twilio-secret',
  TWILIO_FROM_NUMBER: '+15095551234',
  RECIPIENT_NUMBER: '+17075559876',
};
const FAKE_API_KEY_SID = 'SKdeadbeef00deadbeef00deadbeef0000';

// A Config fake: required keys from the table above; optional keys (the
// scoped API key SID, DEBUG_MODE) provided per test.
function installConfig({ apiKeySid = null, debug = false } = {}) {
  installFake('Config', {
    require: (key) => {
      if (!(key in FAKE)) throw new Error('unexpected required key: ' + key);
      return FAKE[key];
    },
    optional: (key) => (key === 'TWILIO_API_KEY_SID' ? apiKeySid : null),
    isDebugMode: () => debug,
  });
}

beforeEach(() => {
  installUtilities();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

// Collect every string logged at every level (for leak assertions).
function allLoggedText() {
  const lines = [];
  for (const mock of [console.log, console.warn, console.error]) {
    for (const args of mock.mock.calls) lines.push(args.join(' '));
  }
  return lines.join('\n');
}

describe('the REST request shape', () => {
  test('POSTs form fields To/From/Body to the Messages endpoint with Basic auth', () => {
    installConfig();
    const fetchRecorder = installUrlFetchApp({ code: 201, body: fixture.success });

    const result = SmsService.send('S&P 7,500 | Gold 4,500 | Silver 70.00');

    expect(result).toEqual({ outcome: 'sent' });
    const { url, params } = fetchRecorder.calls[0];
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/' + FAKE.TWILIO_SID + '/Messages.json'
    );
    expect(params.method).toBe('post');
    expect(params.muteHttpExceptions).toBe(true);
    expect(params.payload).toEqual({
      To: '+17075559876',
      From: '+15095551234',
      Body: 'S&P 7,500 | Gold 4,500 | Silver 70.00',
    });
  });

  test('the message body passes through VERBATIM — no formatting here', () => {
    installConfig();
    const fetchRecorder = installUrlFetchApp({ code: 201, body: fixture.success });
    SmsService.send('exactly this text [#47 A3F9C2E1]');
    expect(fetchRecorder.calls[0].params.payload.Body).toBe('exactly this text [#47 A3F9C2E1]');
  });

  test('hardened path: TWILIO_API_KEY_SID becomes the Basic-auth username — and no warning', () => {
    installConfig({ apiKeySid: FAKE_API_KEY_SID });
    const fetchRecorder = installUrlFetchApp({ code: 201, body: fixture.success });
    SmsService.send('hello');
    const expected = 'Basic ' + Buffer.from(
      FAKE_API_KEY_SID + ':' + FAKE.TWILIO_AUTH_TOKEN, 'utf8'
    ).toString('base64');
    expect(fetchRecorder.calls[0].params.headers.Authorization).toBe(expected);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('hardened path: the URL still uses the ACCOUNT SID — two different SIDs is correct Twilio', () => {
    installConfig({ apiKeySid: FAKE_API_KEY_SID });
    const fetchRecorder = installUrlFetchApp({ code: 201, body: fixture.success });
    SmsService.send('hello');
    expect(fetchRecorder.calls[0].url).toContain('/Accounts/' + FAKE.TWILIO_SID + '/');
    expect(fetchRecorder.calls[0].url).not.toContain(FAKE_API_KEY_SID);
  });

  test('fallback path: master-token auth works but WARNS on every send (never silent — Chunk 1 gate)', () => {
    installConfig({ apiKeySid: null });
    const fetchRecorder = installUrlFetchApp({ code: 201, body: fixture.success });
    SmsService.send('hello');
    const expected = 'Basic ' + Buffer.from(
      FAKE.TWILIO_SID + ':' + FAKE.TWILIO_AUTH_TOKEN, 'utf8'
    ).toString('base64');
    expect(fetchRecorder.calls[0].params.headers.Authorization).toBe(expected);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('scoped'));
  });
});

describe('DEBUG_MODE — gates Twilio only', () => {
  test('logs the message instead of sending; zero fetches, zero spend', () => {
    installConfig({ debug: true });
    const fetchRecorder = installUrlFetchApp({ code: 201, body: fixture.success });
    const result = SmsService.send('would-be text');
    expect(result).toEqual({ outcome: 'debug' });
    expect(fetchRecorder.calls).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('would-be text'));
  });
});

describe('failures log and return — never throw (ADR 006 §9)', () => {
  test('a Twilio 400 logs the numeric error code and returns outcome failed', () => {
    installConfig();
    installUrlFetchApp({ code: 400, body: fixture.invalidToNumber });
    const result = SmsService.send('hello');
    expect(result).toEqual({ outcome: 'failed' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('21211'));
  });

  test('the Twilio error text is scrubbed — the To number it echoes never reaches the log', () => {
    // fixture.invalidToNumber.message contains "+17075559876".
    installConfig();
    installUrlFetchApp({ code: 400, body: fixture.invalidToNumber });
    SmsService.send('hello');
    expect(allLoggedText()).not.toContain('7075559876');
    expect(allLoggedText()).toContain('[number redacted]');
  });

  test('a trial-account unverified-number refusal (21608) logs its code — the onboarding trap', () => {
    installConfig();
    installUrlFetchApp({ code: 400, body: fixture.trialUnverified });
    expect(SmsService.send('hello')).toEqual({ outcome: 'failed' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('21608'));
    expect(allLoggedText()).not.toContain('7075559876');
  });

  test('an auth failure (401) logs its code without leaking anything', () => {
    installConfig();
    installUrlFetchApp({ code: 401, body: fixture.authError });
    const result = SmsService.send('hello');
    expect(result).toEqual({ outcome: 'failed' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('20003'));
  });

  test('a JSON error body with no message field still logs its code cleanly', () => {
    installConfig();
    installUrlFetchApp({ code: 429, body: { code: 20429, status: 429 } });
    expect(SmsService.send('hello')).toEqual({ outcome: 'failed' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('20429'));
  });

  test('a non-JSON error body (proxy HTML) is handled and truncated, no throw', () => {
    installConfig();
    installUrlFetchApp({ code: 502, body: '<html>bad gateway</html>' });
    expect(SmsService.send('hello')).toEqual({ outcome: 'failed' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });

  test('a REAL-GAS-shaped network exception (URL in the message) is scrubbed before logging', () => {
    installConfig();
    installUrlFetchApp((url) => new Error('Address unavailable: ' + url));
    const result = SmsService.send('hello');
    expect(result).toEqual({ outcome: 'failed' });
    expect(allLoggedText()).not.toContain('api.twilio.com/2010-04-01');
    expect(allLoggedText()).not.toContain(FAKE.TWILIO_SID);
  });

  test('a Config throw mid-send is caught, scrubbed, and returned as a failure', () => {
    installFake('Config', {
      isDebugMode: () => false,
      require: () => {
        throw new Error('Missing Script Property: TWILIO_SID.');
      },
      optional: () => null,
    });
    installUrlFetchApp({ code: 201, body: fixture.success });
    expect(SmsService.send('hello')).toEqual({ outcome: 'failed' });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('credential and number hygiene — nothing sensitive in any log, on any path', () => {
  test('success, 400, 401, and hard-throw paths leak neither auth token, SIDs, nor numbers', () => {
    installConfig();
    let call = 0;
    installUrlFetchApp((url) => {
      call += 1;
      if (call === 1) return { code: 201, body: fixture.success };
      if (call === 2) return { code: 400, body: fixture.invalidToNumber };
      if (call === 3) return { code: 401, body: fixture.authError };
      // Real GAS network exceptions embed the request URL (which carries
      // the account SID) — headers/credentials are not in exception text.
      return new Error('Address unavailable: ' + url);
    });
    for (let i = 0; i < 4; i++) SmsService.send('hello');

    const logged = allLoggedText();
    expect(logged).not.toContain(FAKE.TWILIO_AUTH_TOKEN);
    expect(logged).not.toContain(FAKE.TWILIO_SID);
    expect(logged).not.toContain('7075559876'); // recipient
    expect(logged).not.toContain('5095551234'); // Twilio number
    expect(logged).not.toContain(
      Buffer.from(FAKE.TWILIO_SID + ':' + FAKE.TWILIO_AUTH_TOKEN, 'utf8').toString('base64')
    );
  });

  test('the outcome vocabulary is frozen (dispatch contract, ADR 006 §7)', () => {
    expect(Object.values(SmsService.OUTCOME).sort()).toEqual(['debug', 'failed', 'sent']);
    expect(Object.isFrozen(SmsService.OUTCOME)).toBe(true);
  });
});
