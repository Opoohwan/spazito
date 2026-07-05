// Fidelity tests for the shared GAS fakes. These pin the behaviors the shell
// modules depend on — if the fake ever drifts from real PropertiesService
// semantics (null for missing, string coercion, snapshot copies), these fail
// loudly instead of letting every shell suite pass against a lying mock.
const {
  makeScriptProperties,
  installPropertiesService,
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

describe('install/uninstall lifecycle', () => {
  test('installPropertiesService exposes the store through the global', () => {
    installPropertiesService({ A: '1' });
    expect(global.PropertiesService.getScriptProperties().getProperty('A')).toBe('1');
  });

  test('uninstallGasGlobals removes every installed global (no cross-test leaks)', () => {
    installPropertiesService({});
    expect(global.PropertiesService).toBeDefined();
    uninstallGasGlobals();
    expect(global.PropertiesService).toBeUndefined();
  });
});
