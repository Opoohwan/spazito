/**
 * PriceService.js — SHELL module. The ONLY caller of Alpha Vantage
 * (ADR 006 §4/§5). If any other module needs a price, it asks this one.
 *
 * Contract: quotesFor(tickers) → an ORDERED array, one entry per requested
 * ticker, same order:
 *   { ticker, price: "623.6200", ok: true }                    — success
 *   { ticker, price: null, ok: false, reason: <see below> }    — failure
 *
 * `price` stays the STRING Alpha Vantage sent — parsing and formatting are
 * core/Formatter's job (ADR 006 §10); this module does no formatting.
 *
 * Failure `reason` values (CommandHandler tells "unknown symbol" apart from
 * "couldn't reach Alpha Vantage" when validating an `add`):
 *   "no_quote"     — the API answered but knows no such symbol
 *   "rate_limited" — the API returned its Note/Information envelope
 *   "api_error"    — the API rejected the request itself (bad/revoked key)
 *   "bad_price"    — a quote arrived but its price field is unusable
 *   "fetch_error"  — network failure or non-200 HTTP status
 *
 * RESILIENCE (ADR 006 §9): each ticker is fetched inside its own try/catch —
 * one failure never sinks the others — and there are NO retries: retrying a
 * rate-limited call causes more rate-limiting and risks the 6-minute
 * execution cap. A failed ticker is simply ok:false. The one loud exception:
 * a MISSING API key throws immediately (ADR 006 §8) — a config fault must
 * never masquerade as ten network failures.
 *
 * SECRET SAFETY: the API key rides in the request URL. The URL is never
 * logged, and — because real Apps Script network exceptions can embed the
 * full request URL in their message — every logged error string first goes
 * through _scrub(), which redacts apikey values and URLs (ADR 006 §11).
 */
const PriceService = {
  // Flat delay between consecutive Alpha Vantage calls (ADR 007).
  // Derivation: free tier allows 5 calls/minute; 15s spacing = 4/minute,
  // comfortably under. Ten tickers = nine 15s gaps ≈ 2.25 minutes of
  // sleeping (fetch latency extra), well inside Apps Script's 6-minute
  // execution cap. (12s is the theoretical floor; 15s buys margin.)
  MIN_CALL_SPACING_MS: 15000,

  // Defensive bound on one run's spend, mirroring Watchlist.MAX_TICKERS
  // (both derive from ADR 007: 10 calls/run fits the 25/day budget and,
  // spaced 15s, the 6-minute cap). Watchlist enforces it at the state
  // boundary; this clamp defends the module that actually SPENDS the
  // budget against any other/buggy caller.
  MAX_TICKERS_PER_RUN: 10,

  // Alpha Vantage signals "you're over the rate limit" with a 200 response
  // whose body is an envelope under one of these keys instead of a quote.
  // Named here (and tested per key) so a new envelope key is a one-line fix.
  RATE_LIMIT_KEYS: Object.freeze(['Note', 'Information']),

  // A 200 whose body is {"Error Message": ...} means the REQUEST was
  // rejected (typically an invalid or revoked API key) — a config problem,
  // not an unknown symbol. Kept distinct so a key typo never reads as
  // "couldn't find TICKER".
  ERROR_MESSAGE_KEY: 'Error Message',

  // Failure reasons — frozen vocabulary, same discipline as
  // Watchlist.STATUS: callers branch on these exact strings.
  REASON: Object.freeze({
    NO_QUOTE: 'no_quote',
    RATE_LIMITED: 'rate_limited',
    API_ERROR: 'api_error',
    BAD_PRICE: 'bad_price',
    FETCH_ERROR: 'fetch_error',
  }),

  // The GLOBAL_QUOTE response field names, named once — the tests build
  // their fixtures from these too, so a field-name drift is a one-line fix
  // in exactly one place.
  FIELDS: Object.freeze({
    QUOTE: 'Global Quote',
    PRICE: '05. price',
    TRADING_DAY: '07. latest trading day',
    SYMBOL: '01. symbol',
  }),

  // The one place in the codebase that names the Alpha Vantage host
  // (ADR 006 §5 grep invariant).
  API_HOST: 'https://www.alphavantage.co',

  /**
   * Fetch quotes for every ticker, in order, spacing calls to respect the
   * rate limit. An empty (or non-array) list returns an empty array without
   * touching the network or the config.
   *
   * Budget defenses (ADR 007):
   *   - input clamped to MAX_TICKERS_PER_RUN — an oversized list can't
   *     blow the daily budget or sleep past the 6-minute execution cap;
   *   - the first rate_limited response SHORT-CIRCUITS the rest: once the
   *     API says "over the limit", every further call would spend a
   *     daily-budget request just to hear the same apology, so the
   *     remaining tickers are marked rate_limited without being fetched.
   *
   * Throws ONLY for a missing ALPHA_VANTAGE_KEY (read once, up front —
   * fail-loud at the boundary, ADR 006 §8). Individual ticker failures
   * never throw.
   */
  quotesFor(tickers) {
    if (!Array.isArray(tickers) || tickers.length === 0) return [];

    let list = tickers;
    if (list.length > this.MAX_TICKERS_PER_RUN) {
      console.error(
        'quotesFor was given ' + list.length + ' tickers — clamping to ' +
        this.MAX_TICKERS_PER_RUN + ' (ADR 007 budget). This indicates a bug upstream.'
      );
      list = list.slice(0, this.MAX_TICKERS_PER_RUN);
    }

    const apiKey = Config.require('ALPHA_VANTAGE_KEY'); // loud if missing — see header

    const quotes = [];
    for (let i = 0; i < list.length; i++) {
      // Space BETWEEN calls (no pointless wait before the first). This is
      // the ADR 007 rate-limit budget in action.
      if (i > 0) Utilities.sleep(this.MIN_CALL_SPACING_MS);
      const quote = this._quote(list[i], apiKey);
      quotes.push(quote);

      if (quote.reason === this.REASON.RATE_LIMITED) {
        console.warn(
          'Rate limited at ' + list[i] + '; not spending calls on the remaining ' +
          (list.length - i - 1) + ' ticker(s).'
        );
        for (let j = i + 1; j < list.length; j++) {
          quotes.push(this._failure(list[j], this.REASON.RATE_LIMITED));
        }
        break;
      }
    }
    return quotes;
  },

  /**
   * One GLOBAL_QUOTE call, fully contained: any failure comes back as an
   * ok:false entry, never an exception (ADR 006 §9).
   */
  _quote(ticker, apiKey) {
    try {
      const url = this.API_HOST + '/query?function=GLOBAL_QUOTE'
        + '&symbol=' + encodeURIComponent(ticker)
        + '&apikey=' + encodeURIComponent(apiKey);

      // muteHttpExceptions: a 4xx/5xx returns a response object instead of
      // throwing, so we can log the status code (never the URL — see header).
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

      const status = response.getResponseCode();
      if (status !== 200) {
        console.warn('Alpha Vantage HTTP ' + status + ' for ' + ticker);
        return this._failure(ticker, this.REASON.FETCH_ERROR);
      }

      const body = JSON.parse(response.getContentText());

      // Rate-limit envelope: a 200 whose body is an apology, not a quote.
      for (const key of this.RATE_LIMIT_KEYS) {
        if (key in body) {
          console.warn('Alpha Vantage rate-limit envelope ("' + key + '") for ' + ticker);
          return this._failure(ticker, this.REASON.RATE_LIMITED);
        }
      }

      // Request rejected (bad/revoked key, malformed call). The message
      // text is valuable to log — it names the problem ("apikey is
      // invalid...") — but it goes through the Redactor like every other
      // error string, because we don't control what the API embeds in it.
      if (this.ERROR_MESSAGE_KEY in body) {
        console.warn('Alpha Vantage rejected the request for ' + ticker + ': ' + Redactor.scrub(body[this.ERROR_MESSAGE_KEY]));
        return this._failure(ticker, this.REASON.API_ERROR);
      }

      const quote = body[this.FIELDS.QUOTE];
      const price = quote && quote[this.FIELDS.PRICE];
      // No usable quote. This branch covers three shapes: no "Global Quote"
      // key at all, the EMPTY object Alpha Vantage returns for unknown
      // symbols, and a quote whose price field is missing/blank.
      if (!price) {
        console.warn('Alpha Vantage has no quote for ' + ticker);
        return this._failure(ticker, this.REASON.NO_QUOTE);
      }
      // The price must at least look like a number here at the boundary —
      // Formatter re-checks defensively, but ok:false is set where the
      // data arrives (ADR 006 §10).
      if (!Number.isFinite(Number(price))) {
        console.warn('Alpha Vantage returned an unusable price for ' + ticker);
        return this._failure(ticker, this.REASON.BAD_PRICE);
      }

      // Observability (ADR 006 §9): on a market holiday the API returns the
      // LAST close — logging the trading day makes "prices look stale"
      // diagnosable instead of a mystery.
      console.log('Alpha Vantage ' + ticker + ' latest trading day: ' + quote[this.FIELDS.TRADING_DAY]);

      return { ticker: ticker, price: String(price), ok: true };
    } catch (e) {
      // Network failure or JSON parse failure — this ticker is n/a; the
      // rest of the run continues. Real GAS network exceptions can embed
      // the full request URL (key included) in e.message, so it is
      // scrubbed (core/Redactor — the one owner of log redaction) before
      // logging — never trust an error string.
      console.warn('Alpha Vantage fetch failed for ' + ticker + ': ' + Redactor.scrub(e && e.message));
      return this._failure(ticker, this.REASON.FETCH_ERROR);
    }
  },

  /** The one failure shape (keeps every return site identical). */
  _failure(ticker, reason) {
    return { ticker: ticker, price: null, ok: false, reason: reason };
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { PriceService };
