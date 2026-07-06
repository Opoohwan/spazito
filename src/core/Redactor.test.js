// Tests for core/Redactor — the one owner of log redaction. Every pattern
// is pinned standalone AND in realistic combination, because this is a
// security net: a pattern that silently stops matching is a credential leak.
const { Redactor } = require('./Redactor');

describe('URL redaction (GAS network exceptions embed the full request URL)', () => {
  test('a real-GAS-shaped Alpha Vantage exception loses the URL and the key inside it', () => {
    const msg = 'Address unavailable: https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=real-key-123';
    const out = Redactor.scrub(msg);
    expect(out).not.toContain('alphavantage.co');
    expect(out).not.toContain('real-key-123');
    expect(out).toContain('[url redacted]');
  });

  test('a Twilio request URL loses the account SID riding in its path', () => {
    const out = Redactor.scrub(
      'Request failed: https://api.twilio.com/2010-04-01/Accounts/ACdeadbeefdeadbeefdeadbeefdeadbeef/Messages.json'
    );
    expect(out).not.toContain('ACdeadbeef');
    expect(out).toContain('[url redacted]');
  });
});

describe('standalone credential shapes (outside any URL)', () => {
  test('a bare apikey= value is redacted', () => {
    expect(Redactor.scrub('failed with apikey=sk-live-9999')).toBe('failed with apikey=REDACTED');
  });

  test('a bare hex Twilio SID is redacted — AC and SK forms, any case', () => {
    expect(Redactor.scrub('auth as ACdeadbeefdeadbeefdeadbeefdeadbeef failed'))
      .toBe('auth as [sid redacted] failed');
    expect(Redactor.scrub('key SKDEADBEEFDEADBEEFDEADBEEFDEADBEEF revoked'))
      .toBe('key [sid redacted] revoked');
  });

  test('a Basic-auth blob is redacted', () => {
    expect(Redactor.scrub('header was Basic dXNlcjpwYXNzd29yZA==')).toBe('header was [auth redacted]');
  });
});

describe('phone-number redaction (Twilio echoes the To number in error text)', () => {
  test.each([
    ['+17075559876'],
    ['1-707-555-9876'],
    ['(707) 555-9876'],
    ['707.555.9876'.replace(/\./g, ' ')], // spaced form
  ])('%s never survives', (number) => {
    const out = Redactor.scrub(`The 'To' number ${number} is not a valid phone number.`);
    expect(out).not.toContain('9876');
    expect(out).toContain('[number redacted]');
  });

  test('short harmless numbers (error codes) survive so logs stay diagnosable', () => {
    expect(Redactor.scrub('Twilio error code 21211')).toContain('21211');
  });
});

describe('totality — scrubbing never throws', () => {
  test('non-string input is coerced, not crashed on', () => {
    expect(Redactor.scrub(undefined)).toBe('undefined');
    expect(Redactor.scrub(null)).toBe('null');
    expect(Redactor.scrub(42)).toBe('42');
  });

  test('clean text passes through untouched', () => {
    expect(Redactor.scrub('Alpha Vantage has no quote for SPY')).toBe(
      'Alpha Vantage has no quote for SPY'
    );
  });
});
