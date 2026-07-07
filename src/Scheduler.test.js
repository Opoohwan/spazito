// Tests for Scheduler — the orchestrator. EVERY collaborator is mocked
// (installFake through the gasMocks registry): these tests prove the
// choreography — who gets called, in what order, with what — not the
// collaborators' own behavior (each has its own suite).
const {
  installFake,
  installScriptApp,
  uninstallGasGlobals,
} = require('../test/gasMocks');
const { Scheduler, runDailyAlert, createTrigger, testSendNow } = require('./Scheduler');

// One recorder object per test, capturing each collaborator call.
function installCollaborators({
  paused = false,
  tickers = ['SPY', 'GLD', 'SLV'],
  quotes = [
    { ticker: 'SPY', price: '7500', ok: true },
    { ticker: 'GLD', price: '4500', ok: true },
    { ticker: 'SLV', price: '70', ok: true },
  ],
  validateThrows = null,
} = {}) {
  const calls = { validate: 0, isPaused: 0, tickers: 0, quotesFor: [], summaryLine: [], send: [] };
  installFake('Config', {
    validateForAlert: () => {
      calls.validate += 1;
      if (validateThrows) throw validateThrows;
    },
  });
  installFake('Watchlist', {
    isPaused: () => {
      calls.isPaused += 1;
      return paused;
    },
    tickers: () => {
      calls.tickers += 1;
      return tickers;
    },
  });
  installFake('PriceService', {
    quotesFor: (requested) => {
      calls.quotesFor.push(requested);
      return quotes;
    },
  });
  // summaryLine is mocked (sentinel string); allFailed is the REAL pure
  // classifier — it's the contract under test, not plumbing to fake.
  const { Formatter: RealFormatter } = require('./core/Formatter');
  installFake('Formatter', {
    summaryLine: (input) => {
      calls.summaryLine.push(input);
      return 'FORMATTED LINE';
    },
    allFailed: RealFormatter.allFailed.bind(RealFormatter),
  });
  installFake('SmsService', {
    send: (message) => {
      calls.send.push(message);
      return { outcome: 'sent' };
    },
  });
  installFake('Redactor', { scrub: (t) => String(t) });
  return calls;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('the happy path — orchestration only, each collaborator exactly once', () => {
  test('validate → paused-check → tickers → quotes → format → send, wired in order', () => {
    const calls = installCollaborators();
    Scheduler.runDailyAlert();

    expect(calls.validate).toBe(1);
    expect(calls.isPaused).toBe(1);
    expect(calls.tickers).toBe(1);
    expect(calls.quotesFor).toEqual([['SPY', 'GLD', 'SLV']]); // exactly what Watchlist said
    expect(calls.summaryLine).toHaveLength(1);
    expect(calls.summaryLine[0].map((q) => q.ticker)).toEqual(['SPY', 'GLD', 'SLV']);
    expect(calls.send).toEqual(['FORMATTED LINE']); // sends what Formatter built — verbatim
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('paused — skip entirely, send nothing (spec)', () => {
  test('no fetch, no format, no send; a lifecycle log says why', () => {
    const calls = installCollaborators({ paused: true });
    Scheduler.runDailyAlert();
    expect(calls.quotesFor).toHaveLength(0);
    expect(calls.send).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('paused'));
  });
});

describe('degraded runs — send what we have, flag what we must', () => {
  test('partial failure still sends (the partial-send invariant) with no all-failed error', () => {
    const calls = installCollaborators({
      quotes: [
        { ticker: 'SPY', price: null, ok: false, reason: 'fetch_error' },
        { ticker: 'GLD', price: '4500', ok: true },
      ],
    });
    Scheduler.runDailyAlert();
    expect(calls.send).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  test('ALL failed: the n/a message still goes out AND console.error fires (the AV-down signal)', () => {
    const calls = installCollaborators({
      quotes: [
        { ticker: 'SPY', price: null, ok: false, reason: 'rate_limited' },
        { ticker: 'GLD', price: null, ok: false, reason: 'rate_limited' },
      ],
    });
    Scheduler.runDailyAlert();
    expect(calls.send).toHaveLength(1); // n/a line beats silence
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Every ticker failed'));
  });

  test('empty watchlist is NOT all-failed: the notice sends, no error logged', () => {
    const calls = installCollaborators({ tickers: [], quotes: [] });
    Scheduler.runDailyAlert();
    expect(calls.summaryLine).toEqual([[]]); // Formatter owns the empty notice
    expect(calls.send).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  test('a failed send is terminal — exactly one send() call, never a retry', () => {
    const calls = installCollaborators();
    installFake('SmsService', {
      send: (message) => {
        if (calls.send.length > 0) throw new Error('RETRY DETECTED — send called twice');
        calls.send.push(message);
        return { outcome: 'failed' };
      },
    });
    expect(() => Scheduler.runDailyAlert()).not.toThrow();
    expect(calls.send).toHaveLength(1);
  });
});

describe('fail-loud and fail-safe (unattended — ADR 006 §8/§9)', () => {
  test('a missing alert key stops the run before any spend — logged AND re-thrown (red execution)', () => {
    const configError = new Error('Missing Script Property: ALPHA_VANTAGE_KEY.');
    configError.name = 'MissingConfigError';
    const calls = installCollaborators({ validateThrows: configError });
    expect(() => Scheduler.runDailyAlert()).toThrow(/ALPHA_VANTAGE_KEY/);
    expect(calls.isPaused).toBe(0); // validation runs FIRST, before anything
    expect(calls.quotesFor).toHaveLength(0); // no quota spent on a bad config
    expect(calls.send).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ALPHA_VANTAGE_KEY'));
  });

  test('an unexpected explosion is logged AND re-thrown — a dead run must show as Failed, not Completed', () => {
    // A swallowed error would mark the execution green and suppress
    // Google's trigger-failure email — the silent-stop this system fears most.
    installCollaborators();
    installFake('PriceService', {
      quotesFor: () => {
        throw new Error('something deeply unexpected');
      },
    });
    expect(() => Scheduler.runDailyAlert()).toThrow(/Daily alert run failed/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Daily alert run failed'));
  });

  test('a send() throw (contract regression) is also caught, logged, and re-thrown', () => {
    installCollaborators();
    installFake('SmsService', {
      send: () => {
        throw new Error('SmsService broke its never-throw contract');
      },
    });
    expect(() => Scheduler.runDailyAlert()).toThrow(/Daily alert run failed/);
    expect(console.error).toHaveBeenCalled();
  });

  test('both the log AND the re-thrown error are scrubbed (error text is never trusted)', () => {
    installCollaborators();
    const scrubbed = [];
    installFake('Redactor', {
      scrub: (t) => {
        scrubbed.push(String(t));
        return '[scrubbed]';
      },
    });
    installFake('PriceService', {
      quotesFor: () => {
        throw new Error('boom with https://example.com/secret');
      },
    });
    expect(() => Scheduler.runDailyAlert()).toThrow(/\[scrubbed\]/);
    expect(scrubbed.length).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[scrubbed]'));
  });
});

describe('trigger installation (createTrigger — run once per deployment)', () => {
  test('installs five weekly triggers, Mon–Fri, at the ALERT_HOUR', () => {
    const recorder = installScriptApp();
    Scheduler.installTrigger();
    expect(recorder.created).toEqual([
      { handler: 'runDailyAlert', day: 'MONDAY', hour: 17 },
      { handler: 'runDailyAlert', day: 'TUESDAY', hour: 17 },
      { handler: 'runDailyAlert', day: 'WEDNESDAY', hour: 17 },
      { handler: 'runDailyAlert', day: 'THURSDAY', hour: 17 },
      { handler: 'runDailyAlert', day: 'FRIDAY', hour: 17 },
    ]);
  });

  test('idempotent: clears existing runDailyAlert triggers first — no duplicate texts, ever', () => {
    const recorder = installScriptApp({
      existingTriggers: ['runDailyAlert', 'runDailyAlert', 'someOtherFunction'],
    });
    Scheduler.installTrigger();
    expect(recorder.deleted).toEqual(['runDailyAlert', 'runDailyAlert']); // only ours
    expect(recorder.created).toHaveLength(5);
  });

  test('every created trigger points at a REAL exported global function (rename protection)', () => {
    // A renamed entry point with a stale handler string would install five
    // triggers pointing at nothing — the daily text silently never fires.
    const recorder = installScriptApp();
    Scheduler.installTrigger();
    const schedulerExports = require('./Scheduler');
    for (const created of recorder.created) {
      expect(typeof schedulerExports[created.handler]).toBe('function');
    }
  });

  test('a half-installed set fails LOUD — the operator must see it and re-run', () => {
    // A ScriptApp where create() silently does nothing (quota hiccup):
    // the closing verification must throw, not log success.
    const { installFake: installAnyFake } = require('../test/gasMocks');
    installAnyFake('ScriptApp', {
      WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY' },
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({
        timeBased: () => ({
          onWeekDay: () => ({ atHour: () => ({ create: () => {} }) }),
        }),
      }),
    });
    expect(() => Scheduler.installTrigger()).toThrow(/re-run createTrigger/);
  });
});

describe('cross-module copy tripwire', () => {
  test('Replies\' human schedule phrase matches Scheduler.ALERT_HOUR — change them together', () => {
    // If the alert hour ever moves, this fails and points at the copy in
    // Replies that would otherwise silently lie about when texts arrive.
    const { Replies } = require('./core/Replies');
    expect(Scheduler.ALERT_HOUR).toBe(17);
    expect(Replies.SCHEDULE_PHRASE).toContain('5pm');
  });
});

describe('the GAS entry points delegate — no logic of their own', () => {
  test('runDailyAlert() and testSendNow() both run the full flow', () => {
    for (const entryPoint of [runDailyAlert, testSendNow]) {
      const calls = installCollaborators();
      entryPoint();
      expect(calls.send).toHaveLength(1);
      uninstallGasGlobals();
    }
  });

  test('createTrigger() installs the triggers', () => {
    const recorder = installScriptApp();
    createTrigger();
    expect(recorder.created).toHaveLength(5);
  });
});
