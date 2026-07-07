// Tests for core/SecureCompare — the constant-time equality the auth gate
// stands on. (True timing behavior can't be asserted in a unit test; what
// CAN be pinned is the equality logic and the fail-closed edges.)
const { SecureCompare } = require('./SecureCompare');

describe('SecureCompare.equals', () => {
  test('identical strings are equal', () => {
    expect(SecureCompare.equals('secret-token', 'secret-token')).toBe(true);
    expect(SecureCompare.equals('', '')).toBe(true);
  });

  test('any difference anywhere fails — first char, last char, middle', () => {
    expect(SecureCompare.equals('Xecret-token', 'secret-token')).toBe(false);
    expect(SecureCompare.equals('secret-tokeX', 'secret-token')).toBe(false);
    expect(SecureCompare.equals('secretXtoken', 'secret-token')).toBe(false);
  });

  test('length differences fail — prefix, superstring, empty', () => {
    expect(SecureCompare.equals('secret', 'secret-token')).toBe(false);
    expect(SecureCompare.equals('secret-token-plus', 'secret-token')).toBe(false);
    expect(SecureCompare.equals('', 'secret-token')).toBe(false);
  });

  test('non-strings NEVER pass, even suspicious lookalikes (fail closed)', () => {
    expect(SecureCompare.equals(null, null)).toBe(false);
    expect(SecureCompare.equals(undefined, undefined)).toBe(false);
    expect(SecureCompare.equals(123, 123)).toBe(false);
    expect(SecureCompare.equals(['a'], 'a')).toBe(false);
  });

  test('case matters — tokens are exact', () => {
    expect(SecureCompare.equals('Secret', 'secret')).toBe(false);
  });
});
