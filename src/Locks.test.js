// Tests for Locks — the one home of the script-lock discipline (ADR 006
// §5). Watchlist and SecurityVault exercise it transitively; this suite
// names the contract directly so it can't rot if callers are refactored.
const { installLockService, uninstallGasGlobals } = require('../test/gasMocks');
const { Locks } = require('./Locks');

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('Locks.withScriptLock', () => {
  test('acquires with the given timeout, runs the mutation, ALWAYS releases', () => {
    const recorder = installLockService();
    const result = Locks.withScriptLock(1234, () => 'did the work', () => 'busy');
    expect(result).toBe('did the work');
    expect(recorder.waitLockCalls).toEqual([1234]);
    expect(recorder.releaseCount).toBe(1);
  });

  test('releases in finally even when the mutation throws', () => {
    const recorder = installLockService();
    expect(() =>
      Locks.withScriptLock(1000, () => {
        throw new Error('boom');
      }, () => 'busy')
    ).toThrow('boom');
    expect(recorder.releaseCount).toBe(1);
  });

  test('a timeout takes the busy path, logs, and releases NOTHING (never acquired)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = installLockService({ failWait: true });
    const result = Locks.withScriptLock(1000, () => 'never runs', () => 'busy path');
    expect(result).toBe('busy path');
    expect(recorder.releaseCount).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
