// Tests for PriceService — the sole Alpha Vantage caller. UrlFetchApp,
// Utilities.sleep, and Config are all mocked. Quote-shaped response bodies
// come from the golden fixture (captured API shape) — raw non-JSON error
// bodies (HTTP-500 text, gateway HTML) are declared inline because they are
// not part of the API's JSON contract.
const {
  installUrlFetchApp,
  installUtilities,
  installFake,
  uninstallGasGlobals,
} = require('../test/gasMocks');
const { PriceService } = require('./PriceService');
const fixture = require('../test/fixtures/alphavantage-global-quote.json');

const FAKE_KEY = 'fake-av-key-12345';

// Build a success body for any symbol from the golden fixture, using the
// module's own FIELDS constants so a field-name drift is a one-place fix.
function successBody(symbol, price) {
  const body = JSON.parse(JSON.stringify(fixture.success));
  body[PriceService.FIELDS.QUOTE][PriceService.FIELDS.SYMBOL] = symbol;
  if (price !== undefined) body[PriceService.FIELDS.QUOTE][PriceService.FIELDS.PRICE] = price;
  return body;
}

let sleepRecorder;

beforeEach(() => {
  installFake('Config', {
    require: (key) => {
      if (key !== 'ALPHA_VANTAGE_KEY') throw new Error('unexpected key: ' + key);
      return FAKE_KEY;
    },
  });
  sleepRecorder = installUtilities();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  uninstallGasGlobals();
  jest.restoreAllMocks();
});

describe('successful quotes', () => {
  test('parses the golden GLOBAL_QUOTE fixture: price stays the raw string, ok true', () => {
    installUrlFetchApp({ body: fixture.success });
    expect(PriceService.quotesFor(['SPY'])).toEqual([
      { ticker: 'SPY', price: '623.6200', ok: true },
    ]);
  });

  test('does NO formatting — "7500.0000" passes through verbatim, untouched', () => {
    installUrlFetchApp({ body: successBody('SPY', '7500.0000') });
    const [quote] = PriceService.quotesFor(['SPY']);
    expect(quote.price).toBe('7500.0000'); // not 7,500 — that is Formatter's job
  });

  test('returns quotes in request order', () => {
    const bodies = { SPY: successBody('SPY', '623.62'), GLD: successBody('GLD', '311.20') };
    installUrlFetchApp((url) => ({ body: url.includes('symbol=GLD') ? bodies.GLD : bodies.SPY }));
    const quotes = PriceService.quotesFor(['GLD', 'SPY']);
    expect(quotes.map((q) => q.ticker)).toEqual(['GLD', 'SPY']);
    expect(quotes.map((q) => q.price)).toEqual(['311.20', '623.62']);
  });

  test('logs the latest trading day for staleness diagnosis (ADR 006 §9)', () => {
    installUrlFetchApp({ body: fixture.success });
    PriceService.quotesFor(['SPY']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2026-07-02'));
  });
});

describe('call spacing — the ADR 007 budget', () => {
  test('sleeps MIN_CALL_SPACING_MS between calls, not before the first', () => {
    installUrlFetchApp({ body: fixture.success });
    PriceService.quotesFor(['SPY', 'GLD', 'SLV']);
    expect(sleepRecorder.sleeps).toEqual([15000, 15000]);
  });

  test('a single ticker sleeps zero times', () => {
    installUrlFetchApp({ body: fixture.success });
    PriceService.quotesFor(['SPY']);
    expect(sleepRecorder.sleeps).toEqual([]);
  });

  test('an empty list makes zero fetches, zero sleeps, and never reads the config', () => {
    const fetchRecorder = installUrlFetchApp({ body: fixture.success });
    installFake('Config', { require: () => { throw new Error('must not be called'); } });
    expect(PriceService.quotesFor([])).toEqual([]);
    expect(fetchRecorder.calls).toHaveLength(0);
    expect(sleepRecorder.sleeps).toHaveLength(0);
  });

  test('non-array input returns [] instead of throwing (the never-throw contract holds at the boundary)', () => {
    installUrlFetchApp({ body: fixture.success });
    expect(PriceService.quotesFor(null)).toEqual([]);
    expect(PriceService.quotesFor(undefined)).toEqual([]);
  });

  test('spacing still applies around a FAILED call — a failure is not a license to speed up', () => {
    installUrlFetchApp((url, params, callIndex) =>
      callIndex === 2 ? new Error('socket hang up') : { body: fixture.success }
    );
    PriceService.quotesFor(['SPY', 'GLD', 'SLV']);
    expect(sleepRecorder.sleeps).toEqual([15000, 15000]);
  });

  test('an oversized list is clamped to MAX_TICKERS_PER_RUN with a loud error log', () => {
    const fetchRecorder = installUrlFetchApp({ body: fixture.success });
    const thirty = Array.from({ length: 30 }, (_, i) => 'T' + i);
    const quotes = PriceService.quotesFor(thirty);
    expect(quotes).toHaveLength(PriceService.MAX_TICKERS_PER_RUN);
    expect(fetchRecorder.calls).toHaveLength(PriceService.MAX_TICKERS_PER_RUN);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('clamping'));
  });

  test('a missing API key fails LOUD once, before any fetch — never ten quiet fetch_errors', () => {
    const fetchRecorder = installUrlFetchApp({ body: fixture.success });
    const configError = new Error('Missing Script Property: ALPHA_VANTAGE_KEY.');
    configError.name = 'MissingConfigError';
    installFake('Config', { require: () => { throw configError; } });
    expect(() => PriceService.quotesFor(['SPY', 'GLD'])).toThrow(
      expect.objectContaining({ name: 'MissingConfigError' })
    );
    expect(fetchRecorder.calls).toHaveLength(0);
  });
});

describe('rate-limit short-circuit — a limited run stops spending (ADR 007)', () => {
  test('first response rate-limited → one fetch total; the rest are marked without spending', () => {
    const fetchRecorder = installUrlFetchApp({ body: fixture.rateLimitNote });
    const quotes = PriceService.quotesFor(['SPY', 'GLD', 'SLV']);
    expect(fetchRecorder.calls).toHaveLength(1);
    expect(sleepRecorder.sleeps).toEqual([]); // no pointless waiting either
    expect(quotes.map((q) => q.reason)).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
    expect(quotes.map((q) => q.ticker)).toEqual(['SPY', 'GLD', 'SLV']); // order + every slot kept
  });

  test('mid-run rate limit: earlier successes are kept, later tickers are not fetched', () => {
    const fetchRecorder = installUrlFetchApp((url, params, callIndex) =>
      callIndex === 2 ? { body: fixture.rateLimitNote } : { body: fixture.success }
    );
    const quotes = PriceService.quotesFor(['SPY', 'GLD', 'SLV']);
    expect(fetchRecorder.calls).toHaveLength(2);
    expect(quotes.map((q) => q.ok)).toEqual([true, false, false]);
    expect(quotes[2].reason).toBe('rate_limited');
  });

  test('the envelope is recognized per key: Note and Information both trigger it', () => {
    for (const fixtureKey of ['rateLimitNote', 'rateLimitInformation']) {
      installUrlFetchApp({ body: fixture[fixtureKey] });
      const [quote] = PriceService.quotesFor(['SPY']);
      expect(quote).toEqual({ ticker: 'SPY', price: null, ok: false, reason: 'rate_limited' });
    }
  });
});

describe('failure isolation — one bad ticker never sinks the run (ADR 006 §9)', () => {
  test('a thrown fetch becomes ok:false/fetch_error; the others still return', () => {
    installUrlFetchApp((url) =>
      url.includes('symbol=GLD') ? new Error('socket hang up') : { body: fixture.success }
    );
    const quotes = PriceService.quotesFor(['SPY', 'GLD', 'SLV']);
    expect(quotes.map((q) => q.ok)).toEqual([true, false, true]);
    expect(quotes[1]).toEqual({ ticker: 'GLD', price: null, ok: false, reason: 'fetch_error' });
  });

  test('unknown symbol (empty Global Quote) → ok:false/no_quote', () => {
    installUrlFetchApp({ body: fixture.unknownSymbol });
    expect(PriceService.quotesFor(['ZZZZFAKE'])[0]).toEqual({
      ticker: 'ZZZZFAKE',
      price: null,
      ok: false,
      reason: 'no_quote',
    });
  });

  test('a 200 body with NO "Global Quote" key at all → no_quote, never a throw', () => {
    installUrlFetchApp({ body: {} });
    expect(PriceService.quotesFor(['SPY'])[0].reason).toBe('no_quote');
  });

  test('an "Error Message" body (bad/revoked API key) → api_error, and the message IS logged', () => {
    // Distinct from no_quote: a key typo must never read as "couldn't find
    // TICKER". The message text names the problem and holds no secret.
    installUrlFetchApp({ body: fixture.errorMessage });
    expect(PriceService.quotesFor(['SPY'])[0].reason).toBe('api_error');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('apikey is invalid'));
  });

  test('a quote whose price is garbage → ok:false/bad_price (never a fabricated number)', () => {
    installUrlFetchApp({ body: successBody('SPY', 'None') });
    expect(PriceService.quotesFor(['SPY'])[0].reason).toBe('bad_price');
  });

  test('a missing/empty price field → no_quote', () => {
    installUrlFetchApp({ body: successBody('SPY', '') });
    expect(PriceService.quotesFor(['SPY'])[0].reason).toBe('no_quote');
  });

  test('HTTP 500 → ok:false/fetch_error (muteHttpExceptions path)', () => {
    installUrlFetchApp({ code: 500, body: 'Internal Server Error' });
    expect(PriceService.quotesFor(['SPY'])[0].reason).toBe('fetch_error');
  });

  test('unparseable (non-JSON) body → ok:false/fetch_error, no throw', () => {
    installUrlFetchApp({ body: '<html>gateway timeout</html>' });
    expect(PriceService.quotesFor(['SPY'])[0].reason).toBe('fetch_error');
  });

  test('every reason is a declared REASON constant', () => {
    expect(Object.values(PriceService.REASON).sort()).toEqual(
      ['api_error', 'bad_price', 'fetch_error', 'no_quote', 'rate_limited']
    );
    expect(Object.isFrozen(PriceService.REASON)).toBe(true);
    expect(Object.isFrozen(PriceService.FIELDS)).toBe(true);
  });
});

describe('the request itself', () => {
  test('calls GLOBAL_QUOTE with the URL-encoded symbol and muteHttpExceptions', () => {
    const fetchRecorder = installUrlFetchApp({ body: fixture.success });
    PriceService.quotesFor(['BRK.B']);
    const { url, params } = fetchRecorder.calls[0];
    expect(url).toContain('https://www.alphavantage.co/query?function=GLOBAL_QUOTE');
    expect(url).toContain('symbol=BRK.B');
    expect(params).toEqual({ muteHttpExceptions: true });
  });

  test('a hostile ticker cannot smuggle extra query parameters (URL-encoded)', () => {
    const fetchRecorder = installUrlFetchApp({ body: fixture.unknownSymbol });
    PriceService.quotesFor(['SPY&function=TIME_SERIES_DAILY']);
    const { url } = fetchRecorder.calls[0];
    expect(url).toContain('symbol=SPY%26function%3DTIME_SERIES_DAILY');
    expect(url.match(/function=/g)).toHaveLength(1); // only ours
  });

  test('the API key is sent but NEVER logged — at any level, on any path', () => {
    // Exercise a success, an envelope, an unknown symbol, and a hard throw.
    let call = 0;
    installUrlFetchApp(() => {
      call += 1;
      if (call === 1) return { body: fixture.success };
      if (call === 2) return { body: fixture.unknownSymbol };
      if (call === 3) return { body: fixture.errorMessage };
      return new Error('boom');
    });
    PriceService.quotesFor(['SPY', 'GLD', 'SLV', 'TSLA']);
    for (const mock of [console.log, console.warn, console.error]) {
      for (const args of mock.mock.calls) {
        expect(args.join(' ')).not.toContain(FAKE_KEY);
      }
    }
  });

  test('a REAL-GAS-shaped network exception (URL embedded in the message) is scrubbed before logging', () => {
    // Real Apps Script throws e.g. "Address unavailable: https://...&apikey=KEY"
    // on DNS/timeout failures — muteHttpExceptions does NOT mute those.
    // This is the leak the _scrub() redaction exists to stop.
    installUrlFetchApp((url) => new Error('Address unavailable: ' + url));
    const [quote] = PriceService.quotesFor(['SPY']);
    expect(quote.reason).toBe('fetch_error');
    for (const mock of [console.log, console.warn, console.error]) {
      for (const args of mock.mock.calls) {
        expect(args.join(' ')).not.toContain(FAKE_KEY);
        expect(args.join(' ')).not.toContain('alphavantage.co/query');
      }
    }
  });
});
