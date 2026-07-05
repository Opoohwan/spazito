// Tests for core/Formatter — pure, runs in Node with no Apps Script.
// These pin the money rules of ADR 006 §10; every case here is a real trap
// (locale grouping, float rounding, "NaN" leaking to a text message).
const { Formatter } = require('./Formatter');

// Shorthand: a successful quote.
const q = (ticker, price) => ({ ticker, price, ok: true });
// Shorthand: a failed quote (price deliberately absent — ok is the truth).
const failed = (ticker) => ({ ticker, ok: false });

describe('the confirmed message format', () => {
  test('the exact spec example: S&P 7,500 | Gold 4,500 | Silver 70.00', () => {
    const line = Formatter.summaryLine([
      q('SPY', '7500'),
      q('GLD', '4500'),
      q('SLV', '70'),
    ]);
    expect(line).toBe('S&P 7,500 | Gold 4,500 | Silver 70.00');
  });

  test('segments come out in input (watchlist) order — never reordered', () => {
    const line = Formatter.summaryLine([q('SLV', '70'), q('SPY', '7500')]);
    expect(line).toBe('Silver 70.00 | S&P 7,500');
  });
});

describe('per-ticker display rules (the data table)', () => {
  test('SPY → "S&P", comma-grouped, 0 decimals (rounds, never truncates)', () => {
    expect(Formatter.summaryLine([q('SPY', '7500.49')])).toBe('S&P 7,500');
    expect(Formatter.summaryLine([q('SPY', '7500.51')])).toBe('S&P 7,501');
  });

  test('GLD → "Gold", 0 decimals', () => {
    expect(Formatter.summaryLine([q('GLD', '4500.99')])).toBe('Gold 4,501');
  });

  test('SLV → "Silver", exactly 2 decimals, padded', () => {
    expect(Formatter.summaryLine([q('SLV', '70')])).toBe('Silver 70.00');
    expect(Formatter.summaryLine([q('SLV', '70.5')])).toBe('Silver 70.50');
  });

  test('a custom ticker uses its own symbol and 2 decimals (the default rule)', () => {
    expect(Formatter.summaryLine([q('TSLA', '412.379')])).toBe('TSLA 412.38');
  });

  test('lookup is case/whitespace-insensitive — Formatter must not assume callers normalized', () => {
    expect(Formatter.summaryLine([q(' spy ', '7500')])).toBe('S&P 7,500');
    expect(Formatter.summaryLine([q('tsla', '100')])).toBe('TSLA 100.00');
  });
});

describe('number formatting rigor', () => {
  test('sub-dollar prices keep their leading zero', () => {
    expect(Formatter.summaryLine([q('PENNY', '0.4567')])).toBe('PENNY 0.46');
  });

  test('very large prices group every three digits — integer part only', () => {
    expect(Formatter.summaryLine([q('BIG', '600000.00')])).toBe('BIG 600,000.00');
    expect(Formatter.summaryLine([q('HUGE', '1234567.891')])).toBe('HUGE 1,234,567.89');
  });

  test('grouping boundaries: 999 stays bare, 1000 gains a comma', () => {
    expect(Formatter.summaryLine([q('A', '999')])).toBe('A 999.00');
    expect(Formatter.summaryLine([q('B', '1000')])).toBe('B 1,000.00');
  });

  test('numeric (non-string) prices are accepted too', () => {
    expect(Formatter.summaryLine([q('SLV', 70.5)])).toBe('Silver 70.50');
  });

  test('the .005 float trap is pinned: (1.005).toFixed(2) is "1.00" in JS — documented, not hidden', () => {
    // 1.005 has no exact binary representation (it is 1.00499999...), so
    // toFixed rounds DOWN here. Rounding at .xx5 boundaries is decided by
    // the float bits, not a "half up" rule (ADR 006 §10); for market
    // prices a half-cent boundary is noise, but the behavior must be
    // pinned so nobody "fixes" it blind.
    expect(Formatter.summaryLine([q('X', '1.005')])).toBe('X 1.00');
    // Where the float lands ABOVE the boundary (1.135 is stored slightly
    // high), it rounds up. Verified against V8 — most .xx5 values round
    // DOWN because their float representation sits just under.
    expect(Formatter.summaryLine([q('Y', '1.135')])).toBe('Y 1.14');
  });

  test('0-decimal boundary: 7500.5 IS exactly representable, so it rounds up cleanly', () => {
    expect(Formatter.summaryLine([q('SPY', '7500.5')])).toBe('S&P 7,501');
  });

  test('rounding that carries across a grouping boundary: round first, THEN group', () => {
    // A group-before-round refactor would pass every other fixture; this
    // one catches it.
    expect(Formatter.summaryLine([q('X', '99999.999')])).toBe('X 100,000.00');
  });
});

describe('failed tickers — ok is the source of truth', () => {
  test('a failed ticker renders in place as "Label n/a"; the line keeps every slot', () => {
    const line = Formatter.summaryLine([failed('SPY'), q('GLD', '4500'), q('SLV', '70')]);
    expect(line).toBe('S&P n/a | Gold 4,500 | Silver 70.00');
  });

  test('a failed CUSTOM ticker shows its symbol with n/a', () => {
    expect(Formatter.summaryLine([failed('TSLA')])).toBe('TSLA n/a');
  });

  test('ok:false wins even if a price is present — price is only read when ok', () => {
    expect(Formatter.summaryLine([{ ticker: 'SPY', price: '7500', ok: false }])).toBe('S&P n/a');
  });

  test('all-failed renders a full n/a line (still a message — never a blank text)', () => {
    const line = Formatter.summaryLine([failed('SPY'), failed('GLD'), failed('SLV')]);
    expect(line).toBe('S&P n/a | Gold n/a | Silver n/a');
  });

  test('"NaN" can never reach a text: ok:true with garbage price still renders n/a', () => {
    expect(Formatter.summaryLine([q('SPY', 'not-a-price')])).toBe('S&P n/a');
    expect(Formatter.summaryLine([q('SPY', '')])).toBe('S&P n/a');
    expect(Formatter.summaryLine([q('SPY', '   ')])).toBe('S&P n/a');
    expect(Formatter.summaryLine([{ ticker: 'SPY', ok: true }])).toBe('S&P n/a');
    expect(Formatter.summaryLine([q('SPY', NaN)])).toBe('S&P n/a');
    expect(Formatter.summaryLine([q('SPY', Infinity)])).toBe('S&P n/a');
  });

  test('exponent notation can never reach a text: toFixed flips to "1e+21" at huge magnitudes', () => {
    expect(Formatter.summaryLine([q('SPY', 1e21)])).toBe('S&P n/a');
    expect(Formatter.summaryLine([q('SPY', '1e21')])).toBe('S&P n/a');
  });

  test('Number()\'s loose accepts are rejected: hex/exponent strings are garbage, not prices', () => {
    expect(Formatter.summaryLine([q('SPY', '0x10')])).toBe('S&P n/a');
    expect(Formatter.summaryLine([q('SPY', '1e3')])).toBe('S&P n/a');
  });

  test('ok must be exactly true — the string "false" (a classic stored-flag trap) means failed', () => {
    expect(Formatter.summaryLine([{ ticker: 'SPY', price: '7500', ok: 'false' }])).toBe('S&P n/a');
    expect(Formatter.summaryLine([{ ticker: 'SPY', price: '7500', ok: 1 }])).toBe('S&P n/a');
  });

  test('a null/undefined SLOT renders as a bare n/a — never crashes, never drops the position', () => {
    expect(Formatter.summaryLine([null])).toBe('n/a');
    expect(Formatter.summaryLine([q('SPY', '7500'), undefined])).toBe('S&P 7,500 | n/a');
  });

  test('a missing/empty ticker name renders as bare n/a (no usable label)', () => {
    expect(Formatter.summaryLine([{ price: '10', ok: true }])).toBe('n/a');
    expect(Formatter.summaryLine([q('', '10')])).toBe('n/a');
  });

  test('an unknown symbol\'s label is sanitized to ticker-legal characters (defense in depth)', () => {
    // Watchlist's allowlist is the primary gate; this is the last line of
    // defense before the message text / signed payload.
    expect(Formatter.summaryLine([q('A|B', '10')])).toBe('AB 10.00');
    expect(Formatter.summaryLine([q('EVIL[#1 X]', '10')])).toBe('EVIL1X 10.00');
  });
});

describe('empty watchlist — a distinct state, not a failure', () => {
  test('an empty array produces the friendly empty-watchlist notice', () => {
    expect(Formatter.summaryLine([])).toBe(Formatter.EMPTY_WATCHLIST_MESSAGE);
    expect(Formatter.EMPTY_WATCHLIST_MESSAGE).toMatch(/add/i);
  });

  test('non-array input is treated as empty, not a crash (defensive core boundary)', () => {
    expect(Formatter.summaryLine(undefined)).toBe(Formatter.EMPTY_WATCHLIST_MESSAGE);
    expect(Formatter.summaryLine(null)).toBe(Formatter.EMPTY_WATCHLIST_MESSAGE);
  });

  test('empty is DISTINCT from all-failed — the two must never collapse', () => {
    const empty = Formatter.summaryLine([]);
    const allFailed = Formatter.summaryLine([failed('SPY')]);
    expect(empty).not.toBe(allFailed);
    expect(allFailed).toContain('n/a');
    expect(empty).not.toContain('n/a');
  });
});

describe('the rules table itself', () => {
  test('is frozen — display rules change by edit + test, never at runtime', () => {
    expect(Object.isFrozen(Formatter.DISPLAY_RULES)).toBe(true);
    expect(Object.isFrozen(Formatter.DISPLAY_RULES.SPY)).toBe(true);
  });
});

describe('cross-module equivalence (the mandated leaf-rule duplication)', () => {
  test('Formatter\'s local normalization agrees with Tickers.normalize for table lookups', () => {
    // The leaf rule (ADR 006 §2) forbids Formatter calling Tickers, so the
    // trim+uppercase is duplicated locally. This test pins that the two
    // stay in agreement — if Tickers.normalize ever evolves, this fails
    // and the duplication gets reconciled instead of silently diverging.
    const { Tickers } = require('./Tickers');
    for (const raw of [' spy ', 'gld', '\tSLV\n', 'brk.b', 42, null, undefined]) {
      const viaFormatter = Formatter.summaryLine([{ ticker: raw, ok: false }]);
      const viaTickers = Tickers.normalize(raw);
      const rule = Formatter.DISPLAY_RULES[viaTickers];
      const expectedLabel = rule ? rule.label : (viaTickers || null);
      if (expectedLabel === null) {
        expect(viaFormatter).toBe('n/a'); // both agree: nothing usable
      } else {
        expect(viaFormatter).toBe(expectedLabel + ' n/a');
      }
    }
  });
});
