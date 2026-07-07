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

// Every global this module installed, mapped to what was there before —
// so teardown RESTORES a pre-existing global (e.g. a core module installed
// by the gasScope bootstrap that a test temporarily faked) instead of
// deleting it and starving every later test in the file.
const installedGlobals = new Map();

/** Install a fake under a global name and remember it for teardown. */
function installGlobal(name, fake) {
  if (!installedGlobals.has(name)) {
    installedGlobals.set(
      name,
      Object.prototype.hasOwnProperty.call(global, name)
        ? { existed: true, value: global[name] }
        : { existed: false }
    );
  }
  global[name] = fake;
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

/**
 * Install a fake global UrlFetchApp. `respond` decides each call's outcome:
 *   - a function (url, params, callIndex) → result (callIndex is 1-BASED:
 *     1 on the first fetch), or
 *   - a single result object used for every call.
 * A result is { code?, body } — code defaults to 200; an object body is
 * JSON-stringified (as the real API would return text). Return/throw an
 * Error to simulate a network failure (real UrlFetchApp throws).
 * Returns a recorder of every { url, params } for assertions.
 */
function installUrlFetchApp(respond) {
  const recorder = { calls: [] };
  installGlobal('UrlFetchApp', {
    fetch(url, params) {
      recorder.calls.push({ url, params });
      const result = typeof respond === 'function'
        ? respond(url, params, recorder.calls.length)
        : respond;
      if (result instanceof Error) throw result;
      return {
        getResponseCode() {
          return result.code === undefined ? 200 : result.code;
        },
        getContentText() {
          return typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
        },
      };
    },
  });
  return recorder;
}

/**
 * Install a fake global Utilities:
 *   - sleep is recorded (non-blocking) so tests assert call spacing without
 *     actually waiting 15 seconds;
 *   - base64Encode mirrors real GAS (standard base64 of the UTF-8 bytes),
 *     which SmsService uses to build the Twilio Basic-auth header.
 */
function installUtilities() {
  const recorder = { sleeps: [] };
  installGlobal('Utilities', {
    sleep(ms) {
      recorder.sleeps.push(ms);
    },
    base64Encode(text) {
      return Buffer.from(String(text), 'utf8').toString('base64');
    },
    // Real HMAC via Node crypto, returned exactly the way GAS returns it:
    // an array of SIGNED bytes (-128..127), not a Buffer. The Signer's
    // byte→hex conversion depends on that quirk, so the fake must share it
    // (pinned against the RFC test vector in gasMocks.test.js).
    computeHmacSha256Signature(value, key) {
      const digest = require('crypto')
        .createHmac('sha256', String(key))
        .update(String(value), 'utf8')
        .digest();
      return Array.from(digest).map((byte) => (byte > 127 ? byte - 256 : byte));
    },
  });
  return recorder;
}

/**
 * Install a fake global ScriptApp for trigger-management tests. Fakes the
 * fluent builder chain Scheduler uses:
 *   newTrigger(fn).timeBased().onWeekDay(day).atHour(h).create()
 * Returns a recorder: { deleted: [handlerNames], created: [{handler, day, hour}] }.
 * `existingTriggers` seeds getProjectTriggers() with fake triggers by
 * handler-function name.
 */
function installScriptApp({ existingTriggers = [] } = {}) {
  const recorder = { deleted: [], created: [] };
  // LIVE list, like the real service: deleteTrigger removes from it and
  // create() adds to it, so code that re-reads getProjectTriggers() to
  // verify its own work (Scheduler.installTrigger does) sees reality.
  let triggers = existingTriggers.map((handlerName) => ({
    getHandlerFunction: () => handlerName,
  }));
  installGlobal('ScriptApp', {
    WeekDay: Object.freeze({
      MONDAY: 'MONDAY',
      TUESDAY: 'TUESDAY',
      WEDNESDAY: 'WEDNESDAY',
      THURSDAY: 'THURSDAY',
      FRIDAY: 'FRIDAY',
      SATURDAY: 'SATURDAY',
      SUNDAY: 'SUNDAY',
    }),
    getProjectTriggers: () => [...triggers],
    deleteTrigger(trigger) {
      recorder.deleted.push(trigger.getHandlerFunction());
      triggers = triggers.filter((t) => t !== trigger);
    },
    newTrigger(handlerName) {
      const spec = { handler: handlerName };
      return {
        timeBased: () => ({
          onWeekDay: (day) => {
            spec.day = day;
            return {
              atHour: (hour) => {
                spec.hour = hour;
                return {
                  create: () => {
                    recorder.created.push({ ...spec });
                    triggers.push({ getHandlerFunction: () => spec.handler });
                  },
                };
              },
            };
          },
        }),
      };
    },
  });
  return recorder;
}

/**
 * Install any fake under any global name, through the same teardown
 * registry. This is how tests provide SHELL collaborators (Config,
 * Watchlist, ...) to the module under test — mirroring GAS's shared global
 * scope with a mock, per the ADR 006 §2 Node-side convention.
 */
function installFake(name, fake) {
  return installGlobal(name, fake);
}

/**
 * Undo every install: a global that existed before (a gasScope core
 * module) is restored; one we created from nothing is deleted.
 */
function uninstallGasGlobals() {
  for (const [name, previous] of installedGlobals) {
    if (previous.existed) global[name] = previous.value;
    else delete global[name];
  }
  installedGlobals.clear();
}

module.exports = {
  makeScriptProperties,
  installPropertiesService,
  installLockService,
  installUrlFetchApp,
  installUtilities,
  installScriptApp,
  installFake,
  uninstallGasGlobals,
};
