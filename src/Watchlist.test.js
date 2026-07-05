// Tests for Watchlist — the sole state owner. PropertiesService and
// LockService are mocked; every test builds a fresh store, so no test can
// pollute another (or any real watchlist).
const {
  installPropertiesService,
  installLockService,
  uninstallGasGlobals,
} = require('../test/gasMocks');
const { Watchlist } = require('./Watchlist');

let props;
let lockRecorder;

beforeEach(() => {
  props = installPropertiesService({});
  lockRecorder = installLockService();
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('Watchlist.tickers', () => {
  test('returns the default SPY, GLD, SLV when storage is unset', () => {
    expect(Watchlist.tickers()).toEqual(['SPY', 'GLD', 'SLV']);
  });

  test('reading the default does not write anything to storage', () => {
    Watchlist.tickers();
    expect(props.getProperty('WATCHLIST')).toBeNull();
  });

  test('returns a fresh copy — mutating the result cannot corrupt later reads', () => {
    const first = Watchlist.tickers();
    first.push('HACKED');
    expect(Watchlist.tickers()).toEqual(['SPY', 'GLD', 'SLV']);
  });

  test('returns the stored list when one exists', () => {
    props.setProperty('WATCHLIST', JSON.stringify(['TSLA', 'AAPL']));
    expect(Watchlist.tickers()).toEqual(['TSLA', 'AAPL']);
  });

  test('a stored empty list is EMPTY, not the default (distinct states)', () => {
    props.setProperty('WATCHLIST', '[]');
    expect(Watchlist.tickers()).toEqual([]);
  });

  test('corrupted JSON degrades to the default with a warning — never throws (unattended run)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    props.setProperty('WATCHLIST', '{not json');
    expect(Watchlist.tickers()).toEqual(['SPY', 'GLD', 'SLV']);
    expect(warn).toHaveBeenCalled();
  });

  test('stored non-array JSON also degrades to the default with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    props.setProperty('WATCHLIST', '"SPY"');
    expect(Watchlist.tickers()).toEqual(['SPY', 'GLD', 'SLV']);
    expect(warn).toHaveBeenCalled();
  });

  test('the stored-path result is a fresh copy too — mutating it cannot corrupt later reads', () => {
    props.setProperty('WATCHLIST', JSON.stringify(['TSLA']));
    const first = Watchlist.tickers();
    first.push('HACKED');
    expect(Watchlist.tickers()).toEqual(['TSLA']);
  });

  test('self-heals entry-level junk on read: normalizes case, drops non-ticker garbage, warns', () => {
    // A hand-edited or badly-restored property: the read boundary is the
    // last gate before these strings ride into Alpha Vantage URLs.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    props.setProperty('WATCHLIST', JSON.stringify(['spy', 'AAA&interval=1min', 'GLD', 42]));
    expect(Watchlist.tickers()).toEqual(['SPY', 'GLD', '42']);
    expect(warn).toHaveBeenCalled();
  });

  test('de-dupes on read so a duplicated slot cannot double-spend the daily API budget', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    props.setProperty('WATCHLIST', JSON.stringify(['SPY', 'spy', 'SPY', 'GLD']));
    expect(Watchlist.tickers()).toEqual(['SPY', 'GLD']);
    expect(warn).toHaveBeenCalled();
  });

  test('reads never touch the lock', () => {
    Watchlist.tickers();
    Watchlist.isPaused();
    Watchlist.has('SPY');
    Watchlist.isFull();
    expect(lockRecorder.waitLockCalls).toHaveLength(0);
  });
});

describe('Watchlist.add', () => {
  test('normalizes and stores: "  tsla " becomes TSLA', () => {
    const result = Watchlist.add('  tsla ');
    expect(result).toEqual({ status: 'added', ticker: 'TSLA', tickers: ['SPY', 'GLD', 'SLV', 'TSLA'] });
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(['SPY', 'GLD', 'SLV', 'TSLA']);
  });

  test('duplicate add is a no-op with status "duplicate" (case-insensitive)', () => {
    const result = Watchlist.add('spy');
    expect(result.status).toBe('duplicate');
    expect(result.ticker).toBe('SPY');
    expect(props.getProperty('WATCHLIST')).toBeNull(); // nothing was written
  });

  test('the 11th ticker is refused with status "at_cap" and the store is untouched', () => {
    const ten = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];
    props.setProperty('WATCHLIST', JSON.stringify(ten));
    const result = Watchlist.add('TSLA');
    expect(result.status).toBe('at_cap');
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(ten);
  });

  test('exactly MAX_TICKERS is allowed — the cap refuses the next one, not the last slot', () => {
    const nine = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
    props.setProperty('WATCHLIST', JSON.stringify(nine));
    expect(Watchlist.add('T9').status).toBe('added');
    expect(Watchlist.add('TSLA').status).toBe('at_cap');
  });

  test('junk that is not ticker-shaped is refused as "invalid" without taking the lock', () => {
    for (const junk of ['', '   ', 'WAY TOO LONG!', 'ABCDEFGHIJK', '$SPY', 'A;B']) {
      expect(Watchlist.add(junk).status).toBe('invalid');
    }
    expect(lockRecorder.waitLockCalls).toHaveLength(0);
    expect(props.getProperty('WATCHLIST')).toBeNull();
  });

  test('real-world symbol shapes are accepted (BRK.B, BF-B, single letter)', () => {
    expect(Watchlist.add('BRK.B').status).toBe('added');
    expect(Watchlist.add('bf-b').status).toBe('added');
    expect(Watchlist.add('F').status).toBe('added');
  });

  test('writes run under the lock and always release it', () => {
    Watchlist.add('TSLA');
    expect(lockRecorder.waitLockCalls).toEqual([Watchlist.LOCK_TIMEOUT_MS]);
    expect(lockRecorder.releaseCount).toBe(1);
  });

  test('the lock is released even when the write itself throws (finally contract)', () => {
    // A leaked lock would make every later write reply "busy" for the rest
    // of the execution — a silent unattended-run hazard.
    const failing = installPropertiesService({});
    failing.setProperty = () => {
      throw new Error('quota exceeded');
    };
    expect(() => Watchlist.add('TSLA')).toThrow('quota exceeded');
    expect(lockRecorder.releaseCount).toBe(1);
  });

  test('lock timeout returns "busy", writes nothing, and never calls releaseLock', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const busyRecorder = installLockService({ failWait: true });
    expect(Watchlist.add('TSLA')).toEqual({ status: 'busy' });
    expect(props.getProperty('WATCHLIST')).toBeNull();
    expect(warn).toHaveBeenCalled();
    // The lock was never acquired — releasing it would be a contract breach.
    expect(busyRecorder.waitLockCalls).toEqual([Watchlist.LOCK_TIMEOUT_MS]);
    expect(busyRecorder.releaseCount).toBe(0);
  });

  test('add over a corrupted store heals to default-plus-new and warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    props.setProperty('WATCHLIST', '{not json');
    const result = Watchlist.add('TSLA');
    expect(result.status).toBe('added');
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(['SPY', 'GLD', 'SLV', 'TSLA']);
    expect(warn).toHaveBeenCalled();
  });
});

describe('Watchlist.remove', () => {
  test('removes a tracked ticker (case-insensitive) and persists the rest', () => {
    props.setProperty('WATCHLIST', JSON.stringify(['SPY', 'GLD', 'SLV']));
    const result = Watchlist.remove(' gld ');
    expect(result.status).toBe('removed');
    expect(result.nowEmpty).toBe(false);
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(['SPY', 'SLV']);
  });

  test('removing an untracked ticker is a friendly no-op with status "not_found"', () => {
    props.setProperty('WATCHLIST', JSON.stringify(['SPY']));
    const result = Watchlist.remove('TSLA');
    expect(result.status).toBe('not_found');
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(['SPY']);
  });

  test('removing from the (unset) default list materializes the remainder', () => {
    const result = Watchlist.remove('SPY');
    expect(result.status).toBe('removed');
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(['GLD', 'SLV']);
  });

  test('remove-that-empties flags nowEmpty, and the empty list persists as empty (not default)', () => {
    props.setProperty('WATCHLIST', JSON.stringify(['SPY']));
    const result = Watchlist.remove('SPY');
    expect(result.status).toBe('removed');
    expect(result.nowEmpty).toBe(true);
    expect(props.getProperty('WATCHLIST')).toBe('[]');
    expect(Watchlist.tickers()).toEqual([]); // stays empty — does NOT snap back to default
  });

  test('lock timeout returns "busy", removes nothing, and never calls releaseLock', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    props.setProperty('WATCHLIST', JSON.stringify(['SPY']));
    const busyRecorder = installLockService({ failWait: true });
    expect(Watchlist.remove('SPY')).toEqual({ status: 'busy' });
    expect(JSON.parse(props.getProperty('WATCHLIST'))).toEqual(['SPY']);
    expect(busyRecorder.releaseCount).toBe(0);
  });
});

describe('Watchlist paused flag', () => {
  test('not paused by default', () => {
    expect(Watchlist.isPaused()).toBe(false);
  });

  test('setPaused(true) pauses; setPaused(false) resumes; distinct statuses, persisted as strings', () => {
    expect(Watchlist.setPaused(true)).toEqual({ status: 'paused', paused: true });
    expect(props.getProperty('PAUSED')).toBe('true');
    expect(Watchlist.isPaused()).toBe(true);

    expect(Watchlist.setPaused(false)).toEqual({ status: 'resumed', paused: false });
    expect(props.getProperty('PAUSED')).toBe('false');
    expect(Watchlist.isPaused()).toBe(false);
  });

  test('setPaused honors the lock and reports busy on timeout without releasing', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const busyRecorder = installLockService({ failWait: true });
    expect(Watchlist.setPaused(true)).toEqual({ status: 'busy' });
    expect(props.getProperty('PAUSED')).toBeNull();
    expect(busyRecorder.releaseCount).toBe(0);
  });

  test('every status a mutation returns is a declared STATUS constant', () => {
    // Replies (Chunk 8a) keys copy off these exact values — a rename here
    // must be caught by a failing test, not by a silent wrong reply.
    expect(Object.values(Watchlist.STATUS).sort()).toEqual(
      ['added', 'at_cap', 'busy', 'duplicate', 'invalid', 'not_found', 'paused', 'removed', 'resumed']
    );
    expect(Object.isFrozen(Watchlist.STATUS)).toBe(true);
    expect(Object.isFrozen(Watchlist.DEFAULT_TICKERS)).toBe(true);
  });
});

describe('Watchlist.has / Watchlist.isFull', () => {
  test('has() is case-insensitive and normalization-aware', () => {
    expect(Watchlist.has(' spy ')).toBe(true);
    expect(Watchlist.has('TSLA')).toBe(false);
  });

  test('isFull() flips exactly at MAX_TICKERS', () => {
    expect(Watchlist.isFull()).toBe(false);
    const ten = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];
    props.setProperty('WATCHLIST', JSON.stringify(ten));
    expect(Watchlist.isFull()).toBe(true);
  });
});
