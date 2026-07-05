/**
 * Config.js — SHELL module. The single owner of all SECRETS (ADR 003, ADR 006 §5).
 *
 * Every API key, token, and phone number lives in Script Properties — never in
 * this repo — and this module is the ONLY code allowed to read them. Everyone
 * else asks Config. (Mutable app state — the watchlist, the paused flag — is
 * NOT config; that belongs to Watchlist.js.)
 *
 * WHERE THE VALUES LIVE: Apps Script editor → Project Settings (gear icon) →
 * Script Properties. doc/dev/SCHEMA.md is the canonical reference for every
 * key: what it is, its format, and exactly where to get its value. The list
 * below only says what each key is FOR, so this file can't drift from the
 * schema. Rotating a key is just editing the value there — no code change,
 * no redeploy.
 *
 * FAIL-LOUD CONTRACT (ADR 006 §8): a missing key throws a clear, named error
 * immediately. Config never hands back undefined to be discovered as a
 * confusing failure halfway through a run.
 */
const Config = {
  // The keys the DAILY ALERT path needs (Scheduler.runDailyAlert / testSendNow).
  // Deliberately excludes the webhook-only secrets (WEBHOOK_TOKEN,
  // UNLOCK_SECRET) so a problem with those can never stop the daily text,
  // and so the alert path can be smoke-tested before the webhook exists.
  ALERT_KEYS: [
    'ALPHA_VANTAGE_KEY',   // price quotes (alphavantage.co)
    'TWILIO_SID',          // Twilio account SID ("AC…")
    'TWILIO_AUTH_TOKEN',   // Twilio Basic-auth password — see note below
    'TWILIO_FROM_NUMBER',  // the Twilio number texts come FROM (E.164)
    'RECIPIENT_NUMBER',    // the phone texts go TO (E.164)
    'VERIFIER_KEY',        // HMAC key for the [#N TAG] signature (ADR 008 §6)
  ],

  // Every key that must be set for a FULL deployment (alert + webhook).
  // The webhook path (doPost) needs all of these: commands fetch prices,
  // reply via Twilio, pass the URL-token gate, and can re-arm after lockout.
  REQUIRED_KEYS: [
    'ALPHA_VANTAGE_KEY',
    'TWILIO_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'RECIPIENT_NUMBER',
    'WEBHOOK_TOKEN',       // secret bearer token in the webhook URL ?k=… (ADR 008 §2)
    'VERIFIER_KEY',
    'UNLOCK_SECRET',       // re-arms the bot after auto-lockout (ADR 008 §3)
  ],

  // TWILIO_AUTH_TOKEN holds ONE of two different Twilio secrets (SCHEMA.md
  // has the step-by-step):
  //   - Hardened path (ADR 008 §5, preferred): create a scoped API key in the
  //     Twilio console, set TWILIO_API_KEY_SID (optional key, "SK…") to its
  //     SID, and put the API key's SECRET here — NOT the master Auth Token.
  //   - Fallback path: leave TWILIO_API_KEY_SID unset and put the master
  //     Auth Token here. SmsService warns in the log when running this way
  //     (decided at the Chunk 1 gate: allowed for easy onboarding, never silent).
  //
  // Other optional keys (Spazito runs without them):
  //   DEBUG_MODE — literal string "true" makes SmsService LOG outbound texts
  //   instead of sending. Gates Twilio only; Alpha Vantage calls still happen.

  /**
   * Read one required secret. Throws a named error if it is missing, empty,
   * or whitespace-only (a bad paste) — the error says exactly which key and
   * where to set it, and never includes any secret value.
   *
   * The value is returned TRIMMED: a stray trailing newline from a copy-paste
   * would otherwise break Twilio auth or the HMAC signature in ways that are
   * miserable to diagnose. No Spazito secret legitimately starts or ends
   * with whitespace.
   *
   * Values are read fresh on every call (never cached) — ADR 008 §1 requires
   * this for RECIPIENT_NUMBER, and applying it uniformly means a rotated key
   * takes effect on the very next run.
   */
  require(key) {
    const value = PropertiesService.getScriptProperties().getProperty(key);
    if (this._isMissing(value)) throw this._missingError([key]);
    return value.trim();
  },

  /**
   * Read one OPTIONAL secret/flag. Returns the trimmed value, or null when
   * unset/blank — never throws. This exists so modules never reach around
   * Config to PropertiesService for optional keys (single-owner, ADR 006 §5).
   */
  optional(key) {
    const value = PropertiesService.getScriptProperties().getProperty(key);
    return this._isMissing(value) ? null : value.trim();
  },

  /**
   * Validate every key a FULL deployment needs (alert + webhook). doPost
   * calls this first; Chunk 9's deploy checklist runs it once as a config
   * smoke test. Throws one error listing everything missing — not one key
   * at a time, mid-run (ADR 006 §8).
   */
  validateAll() {
    this._validate(this.REQUIRED_KEYS);
  },

  /**
   * Validate only what the daily alert needs. Scheduler calls this so the
   * 5pm text never dies over a webhook-only secret, and so testSendNow works
   * before the webhook chunk is even built.
   */
  validateForAlert() {
    this._validate(this.ALERT_KEYS);
  },

  /**
   * True only when the DEBUG_MODE Script Property is the literal string
   * "true" (SCHEMA.md: anything else — "TRUE", "1", unset — means live).
   */
  isDebugMode() {
    return this.optional('DEBUG_MODE') === 'true';
  },

  /** One shared definition of "missing" so require/optional/validate can never disagree. */
  _isMissing(value) {
    return value === null || value === undefined || String(value).trim() === '';
  },

  /** Check a key list, throw one error naming every missing key. */
  _validate(keys) {
    const props = PropertiesService.getScriptProperties();
    const missing = keys.filter((key) => this._isMissing(props.getProperty(key)));
    if (missing.length > 0) throw this._missingError(missing);
  },

  /**
   * Build the fail-loud error. Names only the missing KEY(S) — never any
   * value — so it is always safe for the execution log (ADR 006 §11).
   */
  _missingError(keys) {
    const error = new Error(
      `Missing Script Propert${keys.length === 1 ? 'y' : 'ies'}: ${keys.join(', ')}. ` +
      'Set in the Apps Script editor: Project Settings (gear icon) → Script Properties. ' +
      'See doc/dev/SCHEMA.md for what each key is and where to get its value.'
    );
    error.name = 'MissingConfigError';
    return error;
  },
};

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file.
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Config };
