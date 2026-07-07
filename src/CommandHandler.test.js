// Tests for CommandHandler — the doPost entry point. SHELL collaborators
// (Config, SecurityGate, Watchlist, PriceService, SmsService,
// ContentService) are mocked; the CORE modules (CommandParser, Replies,
// Tickers, Redactor) are the real ones — parsing and copy are part of the
// behavior under test, not plumbing.
const { installFake, uninstallGasGlobals } = require('../test/gasMocks');
const { CommandHandler, doPost } = require('./CommandHandler');
const { Replies } = require('./core/Replies');

// One recorder per test.
function installCollaborators({
  authorized = true,
  tickers = ['SPY', 'GLD', 'SLV'],
  has = false,
  isFull = false,
  quote = { ticker: 'TSLA', price: '412.38', ok: true },
  addResult = { status: 'added', ticker: 'TSLA', tickers: ['SPY', 'GLD', 'SLV', 'TSLA'] },
  removeResult = { status: 'removed', ticker: 'GLD', tickers: ['SPY', 'SLV'], nowEmpty: false },
  pausedResult = { status: 'paused', paused: true },
  resumedResult = { status: 'resumed', paused: false },
} = {}) {
  const calls = { validate: 0, authorize: [], quotesFor: [], add: [], remove: [], setPaused: [], send: [] };
  installFake('Config', { validateForWebhook: () => { calls.validate += 1; } });
  installFake('SecurityGate', {
    authorize: (e) => {
      calls.authorize.push(e);
      return { allowed: authorized, justSealed: false };
    },
  });
  installFake('Watchlist', {
    STATUS: {
      ADDED: 'added', DUPLICATE: 'duplicate', AT_CAP: 'at_cap', INVALID: 'invalid',
      REMOVED: 'removed', NOT_FOUND: 'not_found', PAUSED: 'paused', RESUMED: 'resumed', BUSY: 'busy',
    },
    MAX_TICKERS: 10,
    tickers: () => tickers,
    isPaused: () => false,
    has: () => has,
    isFull: () => isFull,
    add: (t) => { calls.add.push(t); return addResult; },
    remove: (t) => { calls.remove.push(t); return removeResult; },
    setPaused: (flag) => { calls.setPaused.push(flag); return flag ? pausedResult : resumedResult; },
  });
  installFake('PriceService', {
    REASON: { NO_QUOTE: 'no_quote', RATE_LIMITED: 'rate_limited', API_ERROR: 'api_error', BAD_PRICE: 'bad_price', FETCH_ERROR: 'fetch_error' },
    quotesFor: (list) => { calls.quotesFor.push(list); return [quote]; },
  });
  installFake('SmsService', {
    send: (message) => { calls.send.push(message); return { outcome: 'sent' }; },
  });
  installFake('SecurityVault', {
    recentAudit: () => [
      { t: '2026-07-05T01:00:00.000Z', k: 'replay', s: 'A1B2C3' },
      { t: '2026-07-04T01:00:00.000Z', k: 'rejected', s: 'D4E5F6' },
    ],
  });
  installFake('ContentService', {
    createTextOutput: (text) => ({ kind: 'TextOutput', text }),
  });
  return calls;
}

// A Twilio-shaped webhook event.
function post(body) {
  return { parameter: { Body: body, From: '+17075559876', k: 'token', MessageSid: 'SMfake1' } };
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('authorization comes FIRST and rejection is absolutely silent', () => {
  test('unauthorized → empty 200, no reply, no state touch, no paid call, NO validation sweep', () => {
    const calls = installCollaborators({ authorized: false });
    const result = CommandHandler.doPost(post('add TSLA'));
    expect(result).toEqual({ kind: 'TextOutput', text: '' });
    expect(calls.send).toHaveLength(0);
    expect(calls.add).toHaveLength(0);
    expect(calls.quotesFor).toHaveLength(0);
    expect(calls.validate).toBe(0); // hostile requests don't pay the 8-read sweep
  });

  test('the gate runs BEFORE validation (order pinned) — the gate is the flood defense', () => {
    const order = [];
    const calls = installCollaborators();
    installFake('Config', { validateForWebhook: () => order.push('validate') });
    installFake('SecurityGate', {
      authorize: (e) => {
        order.push('authorize');
        return { allowed: true, justSealed: false };
      },
    });
    CommandHandler.doPost(post('list'));
    expect(order).toEqual(['authorize', 'validate']);
    expect(calls.send).toHaveLength(1);
  });

  test('the sealing transition sends the ONE sealed notice — then silence', () => {
    const calls = installCollaborators();
    installFake('SecurityGate', {
      authorize: () => ({ allowed: false, justSealed: true }),
    });
    const result = CommandHandler.doPost(post('anything'));
    expect(result).toEqual({ kind: 'TextOutput', text: '' });
    expect(calls.send).toEqual([Replies.sealedNotice()]);
  });
});

describe('command dispatch — each command, one reply', () => {
  test('list replies with the watchlist and state', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('list'));
    expect(calls.send).toEqual([Replies.list(['SPY', 'GLD', 'SLV'], false)]);
  });

  test('status is list (alias flows through the real parser)', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('STATUS'));
    expect(calls.send).toEqual([Replies.list(['SPY', 'GLD', 'SLV'], false)]);
  });

  test('list reflects the PAUSED state — isPaused() is really consulted', () => {
    const calls = installCollaborators();
    installFake('Watchlist', {
      STATUS: {}, MAX_TICKERS: 10,
      tickers: () => ['SPY'],
      isPaused: () => true,
      has: () => false, isFull: () => false,
    });
    CommandHandler.doPost(post('list'));
    expect(calls.send).toEqual([Replies.list(['SPY'], true)]);
  });

  test('pause and stop both pause', () => {
    for (const body of ['pause', 'stop']) {
      const calls = installCollaborators();
      CommandHandler.doPost(post(body));
      expect(calls.setPaused).toEqual([true]);
      expect(calls.send).toEqual([Replies.paused()]);
      uninstallGasGlobals();
    }
  });

  test('resume and start both resume', () => {
    for (const body of ['resume', 'start']) {
      const calls = installCollaborators();
      CommandHandler.doPost(post(body));
      expect(calls.setPaused).toEqual([false]);
      expect(calls.send).toEqual([Replies.resumed()]);
      uninstallGasGlobals();
    }
  });

  test('help, gibberish, and an EMPTY body all get the same help reply', () => {
    for (const body of ['help', 'what is the meaning of life', '']) {
      const calls = installCollaborators();
      CommandHandler.doPost(post(body));
      expect(calls.send).toEqual([Replies.help()]);
      uninstallGasGlobals();
    }
  });

  test('log pulls the audit trail (security is pull, not push — ADR 008 §4)', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('log'));
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toContain('replay');
    expect(calls.send[0]).toContain('A1B2C3');
  });

  test('unlock (having passed the gate) replies with the running confirmation', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('unlock some-secret'));
    expect(calls.send).toEqual([Replies.unlocked()]);
  });

  test('a future parser type with no table row still falls back to help (defensive seam)', () => {
    const calls = installCollaborators();
    installFake('CommandParser', {
      TYPES: { ADD: 'add', REMOVE: 'remove', PAUSE: 'pause', RESUME: 'resume', LIST: 'list', HELP: 'help', LOG: 'log', UNLOCK: 'unlock' },
      parse: () => ({ type: 'shiny_new_command', arg: null }),
    });
    CommandHandler.doPost(post('anything'));
    expect(calls.send).toEqual([Replies.help()]);
  });

  test('a missing Body field (malformed POST) gets help, never a throw', () => {
    const calls = installCollaborators();
    CommandHandler.doPost({ parameter: { From: '+17075559876', k: 'token' } });
    expect(calls.send).toEqual([Replies.help()]);
  });

  test('even a null event survives every layer (gate decides; body degrades to help)', () => {
    // Real Twilio always sends an event — this pins the belt-and-suspenders
    // path where the gate authorized but the event is malformed.
    const calls = installCollaborators();
    CommandHandler.doPost(undefined);
    expect(calls.send).toEqual([Replies.help()]);
  });
});

describe('add — free checks BEFORE the paid validation (ADR 007)', () => {
  test('happy path: free checks pass → ONE paid call → Watchlist.add → added reply', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('add tsla'));
    expect(calls.quotesFor).toEqual([['TSLA']]); // normalized, exactly one call
    expect(calls.add).toEqual(['TSLA']);
    expect(calls.send).toEqual([Replies.added('TSLA', ['SPY', 'GLD', 'SLV', 'TSLA'])]);
  });

  test('duplicate: refused for FREE — no Alpha Vantage call, no state touch', () => {
    const calls = installCollaborators({ has: true });
    CommandHandler.doPost(post('add SPY'));
    expect(calls.quotesFor).toHaveLength(0);
    expect(calls.add).toHaveLength(0);
    expect(calls.send).toEqual([Replies.duplicate('SPY')]);
  });

  test('at cap: refused for FREE', () => {
    const calls = installCollaborators({ isFull: true });
    CommandHandler.doPost(post('add TSLA'));
    expect(calls.quotesFor).toHaveLength(0);
    expect(calls.send).toEqual([Replies.atCap(10)]);
  });

  test('junk that is not ticker-shaped: refused for FREE', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('add $$$$$'));
    expect(calls.quotesFor).toHaveLength(0);
    expect(calls.send).toEqual([Replies.invalidTicker('$$$$$')]);
  });

  test('unknown symbol (no_quote): not added, and the reply says the SYMBOL is the problem', () => {
    const calls = installCollaborators({
      quote: { ticker: 'ZZZZ', price: null, ok: false, reason: 'no_quote' },
    });
    CommandHandler.doPost(post('add ZZZZ'));
    expect(calls.add).toHaveLength(0);
    expect(calls.send).toEqual([Replies.unknownSymbol('ZZZZ')]);
  });

  test('rate-limited/unreachable: not added, and the reply says the SERVICE is the problem', () => {
    for (const reason of ['rate_limited', 'api_error', 'fetch_error']) {
      const calls = installCollaborators({
        quote: { ticker: 'TSLA', price: null, ok: false, reason },
      });
      CommandHandler.doPost(post('add TSLA'));
      expect(calls.add).toHaveLength(0);
      expect(calls.send).toEqual([Replies.serviceUnreachable()]);
      uninstallGasGlobals();
    }
  });

  test('a lock-busy add (race after the paid call) replies busy', () => {
    const calls = installCollaborators({ addResult: { status: 'busy' } });
    CommandHandler.doPost(post('add TSLA'));
    expect(calls.send).toEqual([Replies.busy()]);
  });

  test('a lost race to a duplicate (add re-check under the lock) still reads as already-tracking', () => {
    const calls = installCollaborators({
      addResult: { status: 'duplicate', ticker: 'TSLA', tickers: ['TSLA'] },
    });
    CommandHandler.doPost(post('add TSLA'));
    expect(calls.send).toEqual([Replies.duplicate('TSLA')]);
  });

  test('a lost race to the cap (filled between pre-check and lock) still reads as at-cap', () => {
    const calls = installCollaborators({ addResult: { status: 'at_cap', ticker: 'TSLA', tickers: [] } });
    CommandHandler.doPost(post('add TSLA'));
    expect(calls.send).toEqual([Replies.atCap(10)]);
  });

  test('Watchlist reporting invalid (its own re-check) maps to the invalid reply', () => {
    const calls = installCollaborators({ addResult: { status: 'invalid', ticker: 'TSLA' } });
    CommandHandler.doPost(post('add TSLA'));
    expect(calls.send).toEqual([Replies.invalidTicker('TSLA')]);
  });
});

describe('remove', () => {
  test('removes and confirms with the remaining list', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('remove gld'));
    expect(calls.remove).toEqual(['GLD']);
    expect(calls.send).toEqual([Replies.removed('GLD', ['SPY', 'SLV'], false)]);
  });

  test('removing the last ticker warns the list is now empty', () => {
    const calls = installCollaborators({
      removeResult: { status: 'removed', ticker: 'SPY', tickers: [], nowEmpty: true },
    });
    CommandHandler.doPost(post('remove SPY'));
    expect(calls.send).toEqual([Replies.removed('SPY', [], true)]);
  });

  test('removing something untracked is a friendly no-op', () => {
    const calls = installCollaborators({
      removeResult: { status: 'not_found', ticker: 'TSLA', tickers: ['SPY'] },
    });
    CommandHandler.doPost(post('remove TSLA'));
    expect(calls.send).toEqual([Replies.notTracking('TSLA')]);
  });

  test('a lock-busy remove replies busy', () => {
    const calls = installCollaborators({ removeResult: { status: 'busy' } });
    CommandHandler.doPost(post('remove SPY'));
    expect(calls.send).toEqual([Replies.busy()]);
  });

  test('remove with garbage is refused for free — no state call, bounded echo', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('remove $$$$$'));
    expect(calls.remove).toHaveLength(0);
    expect(calls.send).toEqual([Replies.invalidTicker('$$$$$')]);
  });
});

describe('pause/resume under lock contention', () => {
  test('a lock-busy pause replies busy', () => {
    const calls = installCollaborators({ pausedResult: { status: 'busy' } });
    CommandHandler.doPost(post('pause'));
    expect(calls.send).toEqual([Replies.busy()]);
  });
});

describe('the wire contract — always an empty 200, exactly one reply', () => {
  test('every successful command returns the empty TextOutput', () => {
    installCollaborators();
    expect(CommandHandler.doPost(post('list'))).toEqual({ kind: 'TextOutput', text: '' });
  });

  test('one inbound → exactly ONE outbound reply (the Chunk 6 amplification guard)', () => {
    const calls = installCollaborators();
    CommandHandler.doPost(post('add TSLA'));
    expect(calls.send).toHaveLength(1);
  });

  test('an internal explosion is logged (scrubbed) and STILL answers 200 — Twilio must not retry', () => {
    installCollaborators();
    installFake('Watchlist', {
      STATUS: {}, MAX_TICKERS: 10,
      tickers: () => { throw new Error('boom at https://example.com/x'); },
      isPaused: () => false, has: () => false, isFull: () => false,
    });
    const result = CommandHandler.doPost(post('list'));
    expect(result).toEqual({ kind: 'TextOutput', text: '' });
    expect(console.error).toHaveBeenCalledWith(expect.not.stringContaining('example.com'));
  });

  test('a broken config fails loud in the log but still answers 200 quietly', () => {
    const calls = installCollaborators();
    installFake('Config', {
      validateForWebhook: () => { throw new Error('Missing Script Property: WEBHOOK_TOKEN.'); },
    });
    const result = CommandHandler.doPost(post('list'));
    expect(result).toEqual({ kind: 'TextOutput', text: '' });
    expect(calls.send).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_TOKEN'));
  });

  test('the bare-global doPost entry point delegates to the module', () => {
    const calls = installCollaborators();
    const result = doPost(post('list'));
    expect(result).toEqual({ kind: 'TextOutput', text: '' });
    expect(calls.send).toHaveLength(1);
  });
});
