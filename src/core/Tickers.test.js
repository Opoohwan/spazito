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
