// Shared fakes for Google Apps Script globals, used by shell-module tests.
//
// This file lives OUTSIDE src/ on purpose: clasp pushes only src/ (rootDir),
// so nothing here can ever reach Apps Script. Tests require() it with a
// relative path — Jest is happy to load files outside its `roots`.
//
// The fakes mimic the real GAS behavior the shell modules depend on:
//   - PropertiesService values are always strings; a missing key reads as null.
//
// TEARDOWN CONTRACT: every install* helper registers the global names it
// creates in one registry, and uninstallGasGlobals() deletes whatever was
// registered. New installers (LockService, UrlFetchApp, ...) get cleanup for
// free — the teardown can never drift out of sync with the installs, which
// would leak fakes across tests and cause order-dependent flakes.

// Names of every global currently installed by this module.
const installedGlobals = new Set();

/** Install a fake under a global name and remember it for teardown. */
function installGlobal(name, fake) {
  global[name] = fake;
  installedGlobals.add(name);
  return fake;
}

/**
 * Build a fake Script Properties store, optionally pre-seeded.
 * Mirrors the real API surface Spazito uses.
 */
function makeScriptProperties(initial = {}) {
  const store = {};
  for (const [key, value] of Object.entries(initial)) store[key] = String(value);
  return {
    getProperty(key) {
      return key in store ? store[key] : null; // real GAS returns null, not undefined
    },
    setProperty(key, value) {
      store[key] = String(value); // real GAS coerces everything to string
      return this;
    },
    deleteProperty(key) {
      delete store[key];
      return this;
    },
    getProperties() {
      return { ...store }; // real GAS returns a snapshot copy, not a live view
    },
  };
}

/**
 * Install a fake global PropertiesService (as GAS would provide) and return
 * the underlying store so a test can seed/inspect it.
 * Call uninstallGasGlobals() in afterEach/afterAll to clean up.
 */
function installPropertiesService(initial = {}) {
  const props = makeScriptProperties(initial);
  installGlobal('PropertiesService', {
    getScriptProperties: () => props,
  });
  return props;
}

/**
 * Install a fake global LockService. Returns a recorder so tests can assert
 * lock discipline (writes acquire + release; reads never touch the lock).
 *
 * options.failWait = true simulates a contended lock: waitLock throws, as
 * real GAS does on timeout (that is Watchlist's "busy" path).
 */
function installLockService({ failWait = false } = {}) {
  const recorder = { waitLockCalls: [], releaseCount: 0 };
  const lock = {
    waitLock(timeoutMs) {
      recorder.waitLockCalls.push(timeoutMs);
      if (failWait) throw new Error('Could not acquire lock within the timeout.');
    },
    releaseLock() {
      recorder.releaseCount += 1;
    },
  };
  installGlobal('LockService', { getScriptLock: () => lock });
  return recorder;
}

/** Remove every fake GAS global any install* helper put in place. */
function uninstallGasGlobals() {
  for (const name of installedGlobals) delete global[name];
  installedGlobals.clear();
}

module.exports = {
  makeScriptProperties,
  installPropertiesService,
  installLockService,
  uninstallGasGlobals,
};
