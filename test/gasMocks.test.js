// Fidelity tests for the shared GAS fakes. These pin the behaviors the shell
// modules depend on — if the fake ever drifts from real PropertiesService
// semantics (null for missing, string coercion, snapshot copies), these fail
// loudly instead of letting every shell suite pass against a lying mock.
const {
  makeScriptProperties,
  installPropertiesService,
  installLockService,
  uninstallGasGlobals,
} = require('./gasMocks');

afterEach(() => uninstallGasGlobals());

describe('makeScriptProperties fidelity', () => {
  test('a missing key reads as null — exactly like real GAS (never undefined)', () => {
    const props = makeScriptProperties();
    expect(props.getProperty('NOPE')).toBeNull();
  });

  test('setProperty coerces values to strings, like real GAS', () => {
    const props = makeScriptProperties();
    props.setProperty('N', 123);
    expect(props.getProperty('N')).toBe('123');
    props.setProperty('B', true);
    expect(props.getProperty('B')).toBe('true');
  });

  test('seeded initial values are string-coerced too', () => {
    const props = makeScriptProperties({ COUNT: 7 });
    expect(props.getProperty('COUNT')).toBe('7');
  });

  test('deleteProperty makes the key read as null again', () => {
    const props = makeScriptProperties({ KEY: 'v' });
    props.deleteProperty('KEY');
    expect(props.getProperty('KEY')).toBeNull();
  });

  test('getProperties returns a snapshot copy — mutating it never touches the store', () => {
    const props = makeScriptProperties({ KEY: 'v' });
    const snapshot = props.getProperties();
    snapshot.KEY = 'tampered';
    expect(props.getProperty('KEY')).toBe('v');
  });
});

describe('installLockService fidelity', () => {
  test('waitLock records the timeout and returns quietly on success — like real GAS', () => {
    const recorder = installLockService();
    const lock = global.LockService.getScriptLock();
    expect(() => lock.waitLock(5000)).not.toThrow();
    expect(recorder.waitLockCalls).toEqual([5000]);
  });

  test('failWait makes waitLock THROW, matching real GAS timeout behavior (not return false)', () => {
    installLockService({ failWait: true });
    const lock = global.LockService.getScriptLock();
    expect(() => lock.waitLock(5000)).toThrow();
  });

  test('releaseLock increments the release counter', () => {
    const recorder = installLockService();
    const lock = global.LockService.getScriptLock();
    lock.releaseLock();
    lock.releaseLock();
    expect(recorder.releaseCount).toBe(2);
  });
});

describe('installUrlFetchApp fidelity', () => {
  const { installUrlFetchApp } = require('./gasMocks');

  test('the response code defaults to 200; an explicit code wins', () => {
    installUrlFetchApp({ body: 'ok' });
    expect(global.UrlFetchApp.fetch('u').getResponseCode()).toBe(200);
    installUrlFetchApp({ code: 500, body: 'nope' });
    expect(global.UrlFetchApp.fetch('u').getResponseCode()).toBe(500);
  });

  test('object bodies are JSON-stringified; string bodies pass through verbatim', () => {
    installUrlFetchApp({ body: { a: 1 } });
    expect(global.UrlFetchApp.fetch('u').getContentText()).toBe('{"a":1}');
    installUrlFetchApp({ body: '<html>raw</html>' });
    expect(global.UrlFetchApp.fetch('u').getContentText()).toBe('<html>raw</html>');
  });

  test('a returned Error THROWS — matching real UrlFetchApp transport failures', () => {
    // muteHttpExceptions only mutes HTTP status codes; DNS/socket failures
    // still throw in real GAS, and the fake must behave the same.
    installUrlFetchApp(() => new Error('Address unavailable'));
    expect(() => global.UrlFetchApp.fetch('u')).toThrow('Address unavailable');
  });

  test('the recorder captures every call url + params, and callIndex is 1-based', () => {
    const seen = [];
    const recorder = installUrlFetchApp((url, params, callIndex) => {
      seen.push(callIndex);
      return { body: 'ok' };
    });
    global.UrlFetchApp.fetch('first', { x: 1 });
    global.UrlFetchApp.fetch('second');
    expect(recorder.calls).toEqual([{ url: 'first', params: { x: 1 } }, { url: 'second', params: undefined }]);
    expect(seen).toEqual([1, 2]);
  });
});

describe('installUtilities fidelity', () => {
  const { installUtilities } = require('./gasMocks');

  test('sleep records the requested ms without actually blocking', () => {
    const recorder = installUtilities();
    const before = Date.now();
    global.Utilities.sleep(15000);
    global.Utilities.sleep(15000);
    expect(Date.now() - before).toBeLessThan(1000); // did not really wait
    expect(recorder.sleeps).toEqual([15000, 15000]);
  });

  test('base64Encode matches real GAS output (hardcoded vector, not a Buffer round-trip)', () => {
    installUtilities();
    expect(global.Utilities.base64Encode('user:pass')).toBe('dXNlcjpwYXNz');
  });
});

describe('install/uninstall lifecycle', () => {
  test('installPropertiesService exposes the store through the global', () => {
    installPropertiesService({ A: '1' });
    expect(global.PropertiesService.getScriptProperties().getProperty('A')).toBe('1');
  });

  test('uninstallGasGlobals removes every installed global (no cross-test leaks)', () => {
    installPropertiesService({});
    installLockService();
    expect(global.PropertiesService).toBeDefined();
    expect(global.LockService).toBeDefined();
    uninstallGasGlobals();
    expect(global.PropertiesService).toBeUndefined();
    expect(global.LockService).toBeUndefined();
  });
});
