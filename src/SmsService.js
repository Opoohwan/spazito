/**
 * SmsService.js — SHELL module. The ONLY caller of Twilio (ADR 006 §4/§5).
 * It decides nothing: WHAT to send and WHEN is the caller's business; this
 * module just delivers one message to the recipient, safely.
 *
 * Contract: send(message) → { outcome } where outcome is one of
 * SmsService.OUTCOME:
 *   "sent"   — Twilio accepted the message
 *   "debug"  — DEBUG_MODE: logged instead of sending, zero spend
 *   "failed" — Twilio refused / network failed (already logged here)
 * A send failure LOGS (console.error) and returns — it never throws. The
 * daily run and command replies degrade; they don't die (ADR 006 §9).
 * Callers must treat "failed" as terminal: never retry (a retry is a
 * double-billed message; see ADR 006 §9's no-retries stance).
 *
 * AUTH (ADR 008 §5): Basic auth against the Twilio REST API.
 *   - Hardened path: TWILIO_API_KEY_SID (an "SK…" scoped API key) is the
 *     username and TWILIO_AUTH_TOKEN holds that key's SECRET. A leaked
 *     property can then at worst send messages — it cannot own the account.
 *   - Fallback path: no TWILIO_API_KEY_SID → username is TWILIO_SID and
 *     TWILIO_AUTH_TOKEN holds the master Auth Token. Allowed for easy
 *     onboarding but NEVER silent — it logs a warning on every send
 *     (decided at the Chunk 1 council gate; each GAS execution sends at
 *     most a message or two, so per-send is effectively once-per-run).
 *
 * DEBUG_MODE gates THIS MODULE ONLY: it stops Twilio spend, not Alpha
 * Vantage calls (SCHEMA.md).
 *
 * LOG HYGIENE (ADR 006 §11 + ADR 008 §1): no credential and NO PHONE NUMBER
 * ever reaches a log. Twilio error messages echo the To number back
 * ("The 'To' number +1707… is not valid"), and real GAS network exceptions
 * can embed the request URL (which carries the account SID) — so every
 * logged error string goes through core/Redactor first.
 */
const SmsService = {
  // What one send() call came to. Frozen vocabulary (ADR 006 §7 convention).
  OUTCOME: Object.freeze({
    SENT: 'sent',
    DEBUG: 'debug',
    FAILED: 'failed',
  }),

  // The one place in the codebase that names the Twilio host (ADR 006 §5
  // grep invariant), and the API version the Messages endpoint lives under.
  API_HOST: 'https://api.twilio.com',
  API_VERSION: '2010-04-01',

  // How much of a NON-JSON error body (proxy HTML, gateway pages) is worth
  // keeping in a log line — enough to recognize, not enough to spam.
  MAX_ERROR_LOG_CHARS: 200,

  /**
   * Send one SMS to the recipient. Reads config fresh every call
   * (rotation-safe, ADR 008 §1). Never throws — see the module contract.
   */
  send(message) {
    try {
      if (Config.isDebugMode()) {
        // DEBUG_MODE: show exactly what WOULD have been sent, spend nothing.
        console.log('DEBUG_MODE — SMS not sent. Message: ' + message);
        return { outcome: this.OUTCOME.DEBUG };
      }

      const accountSid = Config.require('TWILIO_SID');
      const authSecret = Config.require('TWILIO_AUTH_TOKEN');
      const apiKeySid = Config.optional('TWILIO_API_KEY_SID');

      // Basic-auth username: the scoped API key when configured, else the
      // account SID (master-token fallback — allowed, never silent).
      const username = apiKeySid || accountSid;
      if (!apiKeySid) {
        console.warn(
          'SmsService is authenticating with the master Auth Token. Prefer a scoped ' +
          'API key: set TWILIO_API_KEY_SID (ADR 008 §5, SCHEMA.md).'
        );
      }

      // NOTE the two-different-SIDs shape, which is correct Twilio, not a
      // bug: the resource PATH always uses the ACCOUNT SID (TWILIO_SID),
      // even when the Basic-auth USERNAME is the scoped API key SID. Do
      // not "tidy" the URL to use `username` — that 404s every send.
      const url = this.API_HOST + '/' + this.API_VERSION + '/Accounts/'
        + encodeURIComponent(accountSid) + '/Messages.json';

      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        // An object payload is form-encoded by UrlFetchApp — exactly what
        // the Twilio Messages endpoint expects (this also safely encodes
        // the "&" in "S&P"; never hand-build this query string).
        payload: {
          To: Config.require('RECIPIENT_NUMBER'),
          From: Config.require('TWILIO_FROM_NUMBER'),
          Body: String(message),
        },
        headers: {
          Authorization: 'Basic ' + Utilities.base64Encode(username + ':' + authSecret),
        },
        // 4xx/5xx return a response instead of throwing, so the error code
        // can be logged (scrubbed) rather than exploding.
        muteHttpExceptions: true,
      });

      const status = response.getResponseCode();
      if (status >= 200 && status < 300) {
        // The message SID is Twilio's receipt — the handle to look the
        // message up in the console when debugging delivery. num_segments
        // is the billing unit (a long line can cost 2+ segments), logged
        // so cost drift is visible. ONLY sid/status/num_segments may be
        // logged from the receipt — receipt.to / receipt.from /
        // receipt.account_sid are on this same object and this line does
        // NOT pass through the Redactor.
        const receipt = JSON.parse(response.getContentText());
        console.log(
          'SMS handed to Twilio, sid ' + receipt.sid + ', status ' + receipt.status +
          ', segments ' + receipt.num_segments
        );
        return { outcome: this.OUTCOME.SENT };
      }

      // Twilio refused. Log the numeric error code (the key to
      // twilio.com/docs/errors) with the text scrubbed of numbers/SIDs.
      const errorBody = this._parseErrorBody(response.getContentText());
      console.error(
        'Twilio send failed: HTTP ' + status +
        ', code ' + errorBody.code + ': ' + Redactor.scrub(errorBody.message)
      );
      return { outcome: this.OUTCOME.FAILED };
    } catch (e) {
      // Network failure or config problem mid-send. Scrubbed — a GAS
      // network exception can carry the full request URL. (A 2xx whose
      // body isn't JSON also lands here — counted as failed even though
      // Twilio may have accepted it; acceptable asymmetry, it self-heals
      // on the next daily run.)
      console.error('Twilio send failed: ' + Redactor.scrub(e && e.message));
      return { outcome: this.OUTCOME.FAILED };
    }
  },

  /** Best-effort parse of a Twilio error body (it may not be JSON at all). */
  _parseErrorBody(text) {
    try {
      const parsed = JSON.parse(text);
      return { code: String(parsed.code), message: parsed.message || '' };
    } catch (e) {
      return { code: 'unknown', message: String(text).slice(0, this.MAX_ERROR_LOG_CHARS) };
    }
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { SmsService };
