// Tests for core/Tickers — pure, runs in Node with no Apps Script anywhere.
const { Tickers } = require('./Tickers');

describe('Tickers.normalize', () => {
  test('uppercases a lowercase symbol', () => {
    expect(Tickers.normalize('tsla')).toBe('TSLA');
  });

  test('trims surrounding whitespace', () => {
    expect(Tickers.normalize('  SPY  ')).toBe('SPY');
  });

  test('trims and uppercases together (the real SMS case: " add tsla ")', () => {
    expect(Tickers.normalize('\tgld \n')).toBe('GLD');
  });

  test('already-canonical input passes through unchanged', () => {
    expect(Tickers.normalize('SLV')).toBe('SLV');
  });

  test('empty string stays empty', () => {
    expect(Tickers.normalize('')).toBe('');
  });

  test('whitespace-only collapses to empty', () => {
    expect(Tickers.normalize('   ')).toBe('');
  });

  test('undefined and null coerce to empty, never throw', () => {
    expect(Tickers.normalize(undefined)).toBe('');
    expect(Tickers.normalize(null)).toBe('');
  });

  test('non-string input is coerced, not crashed on', () => {
    expect(Tickers.normalize(42)).toBe('42');
  });

  test('internal whitespace is preserved — tokenizing is CommandParser\'s job, not ours', () => {
    expect(Tickers.normalize('sp y')).toBe('SP Y');
  });
});

describe('Tickers.isValid', () => {
  test('accepts plain symbols regardless of input case or padding', () => {
    expect(Tickers.isValid('SPY')).toBe(true);
    expect(Tickers.isValid(' tsla ')).toBe(true);
    expect(Tickers.isValid('F')).toBe(true);
  });

  test('accepts the dot and hyphen shapes real symbols use', () => {
    expect(Tickers.isValid('BRK.B')).toBe(true);
    expect(Tickers.isValid('BF-B')).toBe(true);
  });

  test('rejects empty and whitespace-only input', () => {
    expect(Tickers.isValid('')).toBe(false);
    expect(Tickers.isValid('   ')).toBe(false);
    expect(Tickers.isValid(null)).toBe(false);
    expect(Tickers.isValid(undefined)).toBe(false);
  });

  test('rejects strings with internal spaces or symbols that could ride into a URL', () => {
    expect(Tickers.isValid('SP Y')).toBe(false);
    expect(Tickers.isValid('$SPY')).toBe(false);
    expect(Tickers.isValid('A;B')).toBe(false);
    expect(Tickers.isValid('A&B=C')).toBe(false);
  });

  test('rejects anything longer than 10 characters', () => {
    expect(Tickers.isValid('ABCDEFGHIJ')).toBe(true);   // exactly 10
    expect(Tickers.isValid('ABCDEFGHIJK')).toBe(false); // 11
  });

  test('rejects a leading dot or hyphen (first char must be a letter or digit)', () => {
    expect(Tickers.isValid('.SPY')).toBe(false);
    expect(Tickers.isValid('-SPY')).toBe(false);
  });
});
