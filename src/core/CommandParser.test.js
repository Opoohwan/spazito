// Tests for core/CommandParser — pure, runs in Node with no Apps Script.
// Every command and alias from the spec (CLAUDE.md "Incoming SMS commands"
// + ADR 008 §3/§4) is pinned here; parse() must be total — no input may
// ever throw or escape the declared TYPES.
const { CommandParser } = require('./CommandParser');

describe('every spec command and alias', () => {
  test.each([
    ['add SPY', 'add', 'SPY'],
    ['remove SPY', 'remove', 'SPY'],
    ['pause', 'pause', null],
    ['stop', 'pause', null], // alias
    ['resume', 'resume', null],
    ['start', 'resume', null], // alias
    ['list', 'list', null],
    ['status', 'list', null], // alias
    ['help', 'help', null],
    ['log', 'log', null], // ADR 008 §4 audit pull
  ])('"%s" → type %s, arg %s', (body, type, arg) => {
    expect(CommandParser.parse(body)).toEqual({ type, arg });
  });
});

describe('case and whitespace tolerance', () => {
  test('commands are case-insensitive', () => {
    expect(CommandParser.parse('PAUSE').type).toBe('pause');
    expect(CommandParser.parse('Stop').type).toBe('pause');
    expect(CommandParser.parse('LiSt').type).toBe('list');
  });

  test('surrounding and internal whitespace is tolerated: "  Add   tsla  "', () => {
    expect(CommandParser.parse('  Add   tsla  ')).toEqual({ type: 'add', arg: 'TSLA' });
  });

  test('tabs and newlines separate words too — multi-line SMS composers exist', () => {
    expect(CommandParser.parse('add\nTSLA')).toEqual({ type: 'add', arg: 'TSLA' });
    expect(CommandParser.parse('add\tTSLA')).toEqual({ type: 'add', arg: 'TSLA' });
  });

  test('the ticker argument is uppercased', () => {
    expect(CommandParser.parse('add tsla')).toEqual({ type: 'add', arg: 'TSLA' });
    expect(CommandParser.parse('remove brk.b')).toEqual({ type: 'remove', arg: 'BRK.B' });
  });

  test('trailing chatter is ignored — people talk to texting bots', () => {
    expect(CommandParser.parse('add TSLA please')).toEqual({ type: 'add', arg: 'TSLA' });
    expect(CommandParser.parse('list please')).toEqual({ type: 'list', arg: null });
  });

  test('only the FIRST token after add/remove is the ticker — the rest is dropped', () => {
    // Pins the one-ticker-per-message decision; a later "fix" that joins
    // tokens must consciously change this test.
    expect(CommandParser.parse('add SPY GLD')).toEqual({ type: 'add', arg: 'SPY' });
  });
});

describe('raw arguments (unlock) — never re-cased, never re-tokenized', () => {
  test('the unlock secret survives verbatim, case intact', () => {
    expect(CommandParser.parse('unlock MySecretV3')).toEqual({ type: 'unlock', arg: 'MySecretV3' });
  });

  test('a multi-word secret keeps its internal spacing', () => {
    expect(CommandParser.parse('unlock My Secret Phrase')).toEqual({
      type: 'unlock',
      arg: 'My Secret Phrase',
    });
  });

  test('the verb itself is still case-insensitive; only the arg is protected', () => {
    expect(CommandParser.parse('UNLOCK abcDEF')).toEqual({ type: 'unlock', arg: 'abcDEF' });
  });

  test('bare "unlock" with no secret → help', () => {
    expect(CommandParser.parse('unlock')).toEqual({ type: 'help', arg: null });
  });
});

describe('empty and garbage input → help, never a throw', () => {
  test.each([
    [''],
    ['   '],
    ['buy low sell high'],
    ['addTSLA'], // no space — not a recognized verb
    ['🚀🚀🚀'],
    ['DROP TABLE watchlist'],
  ])('garbage %j → help', (body) => {
    expect(CommandParser.parse(body)).toEqual({ type: 'help', arg: null });
  });

  test('prototype-property names cannot escape the alias table (own-property lookup)', () => {
    for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(CommandParser.parse(evil)).toEqual({ type: 'help', arg: null });
    }
  });

  test('non-string input (Twilio edge, malformed POST) → help, never a throw', () => {
    expect(CommandParser.parse(undefined)).toEqual({ type: 'help', arg: null });
    expect(CommandParser.parse(null)).toEqual({ type: 'help', arg: null });
    expect(CommandParser.parse(42)).toEqual({ type: 'help', arg: null });
    expect(CommandParser.parse({})).toEqual({ type: 'help', arg: null });
  });

  test('a bare "add" or "remove" with no ticker is not a usable command → help', () => {
    expect(CommandParser.parse('add')).toEqual({ type: 'help', arg: null });
    expect(CommandParser.parse('remove ')).toEqual({ type: 'help', arg: null });
  });
});

describe('output shape contract', () => {
  test('every result has exactly { type, arg } — and type is always a declared TYPES value', () => {
    for (const body of ['pause', 'add SPY', 'unlock s3cret', 'nonsense', '', 'constructor']) {
      const intent = CommandParser.parse(body);
      expect(Object.keys(intent).sort()).toEqual(['arg', 'type']);
      expect(Object.values(CommandParser.TYPES)).toContain(intent.type);
    }
  });

  test('TYPES, ALIASES, and ARG_SPECS are frozen — the dispatch contract cannot drift at runtime', () => {
    expect(Object.isFrozen(CommandParser.TYPES)).toBe(true);
    expect(Object.isFrozen(CommandParser.ALIASES)).toBe(true);
    expect(Object.isFrozen(CommandParser.ARG_SPECS)).toBe(true);
  });

  test('every alias maps to a declared canonical type', () => {
    for (const type of Object.values(CommandParser.ALIASES)) {
      expect(Object.values(CommandParser.TYPES)).toContain(type);
    }
  });

  test('every ARG_SPECS key is a declared canonical type (no dead arg rules)', () => {
    for (const key of Object.keys(CommandParser.ARG_SPECS)) {
      expect(Object.values(CommandParser.TYPES)).toContain(key);
    }
  });
});
