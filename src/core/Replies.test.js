// Tests for core/Replies — pure copy, tested for the facts each reply must
// carry (the ticker, the next step, the actual outcome), not exact prose:
// wording may be polished later without rewriting the suite.
const { Replies } = require('./Replies');

describe('help', () => {
  test('lists every user-facing command', () => {
    const help = Replies.help();
    for (const command of ['add', 'remove', 'list', 'pause', 'resume', 'help']) {
      expect(help.toLowerCase()).toContain(command);
    }
  });
});

describe('add outcomes', () => {
  test('added names the ticker and the resulting list', () => {
    const text = Replies.added('TSLA', ['SPY', 'GLD', 'SLV', 'TSLA']);
    expect(text).toContain('TSLA');
    expect(text).toContain('SPY, GLD, SLV, TSLA');
  });

  test('duplicate names the ticker and reads as a no-op, not an error', () => {
    const text = Replies.duplicate('SPY');
    expect(text).toContain('SPY');
    expect(text.toLowerCase()).toContain('already');
  });

  test('atCap names the limit and the way forward', () => {
    const text = Replies.atCap(10);
    expect(text).toContain('10');
    expect(text.toLowerCase()).toContain('remove');
  });

  test('invalidTicker echoes a SANITIZED, BOUNDED fragment — junk cannot ride back out', () => {
    const text = Replies.invalidTicker('<script>alert("x")</script>very-long-garbage');
    expect(text).not.toContain('<');
    expect(text).not.toContain('(');
    // the echo is capped at 12 chars of ticker-legal characters
    expect(text).toContain('"scriptalertx"');
  });

  test('invalidTicker survives null/undefined', () => {
    expect(Replies.invalidTicker(undefined)).toContain('""');
  });

  test('unknownSymbol vs serviceUnreachable are DIFFERENT stories (distinct states)', () => {
    const unknown = Replies.unknownSymbol('ZZZZ');
    const unreachable = Replies.serviceUnreachable();
    expect(unknown).toContain('ZZZZ');
    expect(unknown).not.toBe(unreachable);
    expect(unreachable.toLowerCase()).toContain('nothing was changed');
  });
});

describe('remove outcomes', () => {
  test('removed names the ticker and the remaining list', () => {
    const text = Replies.removed('GLD', ['SPY', 'SLV'], false);
    expect(text).toContain('GLD');
    expect(text).toContain('SPY, SLV');
  });

  test('removing the last ticker warns clearly that daily prices stop', () => {
    const text = Replies.removed('SPY', [], true);
    expect(text).toContain('EMPTY');
    expect(text.toLowerCase()).toContain('add');
  });

  test('notTracking is a friendly no-op with a next step', () => {
    const text = Replies.notTracking('TSLA');
    expect(text).toContain('TSLA');
    expect(text.toLowerCase()).toContain('list');
  });
});

describe('pause / resume / list / busy', () => {
  test('paused and resumed each state the new reality and the way back', () => {
    expect(Replies.paused().toLowerCase()).toContain('resume');
    expect(Replies.resumed().toLowerCase()).toContain('5pm');
  });

  test('list shows the tickers and the active state', () => {
    const text = Replies.list(['SPY', 'GLD'], false);
    expect(text).toContain('SPY, GLD');
    expect(text.toLowerCase()).toContain('active');
  });

  test('list shows PAUSED when paused', () => {
    expect(Replies.list(['SPY'], true).toLowerCase()).toContain('paused');
  });

  test('an empty list explains itself and how to start', () => {
    const text = Replies.list([], false);
    expect(text.toLowerCase()).toContain('empty');
    expect(text.toLowerCase()).toContain('add');
  });

  test('busy asks for a retry in human terms', () => {
    expect(Replies.busy().toLowerCase()).toContain('try again');
  });
});
