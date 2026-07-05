// Tests for Config — the sole secrets reader. PropertiesService is mocked;
// no real GAS, no real secrets anywhere in this file.
const { installPropertiesService, uninstallGasGlobals } = require('../test/gasMocks');
const { Config } = require('./Config');

// A fully-populated store matching SCHEMA.md. Values are obvious fakes
// (phone numbers use the reserved 555 exchange).
const ALL_KEYS_SET = {
  ALPHA_VANTAGE_KEY: 'fake-av-key',
  TWILIO_SID: 'ACfake0000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'fake-twilio-secret',
  TWILIO_FROM_NUMBER: '+15095551234',
  RECIPIENT_NUMBER: '+17075559876',
  WEBHOOK_TOKEN: 'fake-webhook-token',
  VERIFIER_KEY: 'fake-verifier-key',
  UNLOCK_SECRET: 'fake-unlock-secret',
};

afterEach(() => uninstallGasGlobals());

describe('Config.require', () => {
  test('returns the value when the key is set', () => {
    installPropertiesService(ALL_KEYS_SET);
    expect(Config.require('ALPHA_VANTAGE_KEY')).toBe('fake-av-key');
    expect(Config.require('RECIPIENT_NUMBER')).toBe('+17075559876');
  });

  test('throws a named error when the key is missing — never returns undefined', () => {
    installPropertiesService({});
    expect(() => Config.require('TWILIO_SID')).toThrow(
      expect.objectContaining({ name: 'MissingConfigError' })
    );
  });

  test('the error message names the key (singular wording) and says where to set it', () => {
    installPropertiesService({});
    expect(() => Config.require('TWILIO_SID')).toThrow(/Missing Script Property: TWILIO_SID/);
    expect(() => Config.require('TWILIO_SID')).toThrow(/Script Properties/);
  });

  test('an empty-string value counts as missing (a blank paste is a mistake, not a config)', () => {
    installPropertiesService({ ...ALL_KEYS_SET, WEBHOOK_TOKEN: '' });
    expect(() => Config.require('WEBHOOK_TOKEN')).toThrow(/WEBHOOK_TOKEN/);
  });

  test('a whitespace-only value counts as missing too', () => {
    installPropertiesService({ ...ALL_KEYS_SET, VERIFIER_KEY: '   ' });
    expect(() => Config.require('VERIFIER_KEY')).toThrow(/VERIFIER_KEY/);
  });

  test('values are returned trimmed — a pasted trailing newline cannot poison auth or HMAC', () => {
    installPropertiesService({ ...ALL_KEYS_SET, ALPHA_VANTAGE_KEY: '  fake-av-key\n' });
    expect(Config.require('ALPHA_VANTAGE_KEY')).toBe('fake-av-key');
  });

  test('reads fresh every call — a rotated value is picked up immediately, no caching', () => {
    const props = installPropertiesService(ALL_KEYS_SET);
    expect(Config.require('ALPHA_VANTAGE_KEY')).toBe('fake-av-key');
    props.setProperty('ALPHA_VANTAGE_KEY', 'rotated-key');
    expect(Config.require('ALPHA_VANTAGE_KEY')).toBe('rotated-key');
  });
});

describe('Config.optional', () => {
  test('returns the trimmed value when set', () => {
    installPropertiesService({ TWILIO_API_KEY_SID: ' SKfake000 ' });
    expect(Config.optional('TWILIO_API_KEY_SID')).toBe('SKfake000');
  });

  test('returns null (never throws) when unset or blank', () => {
    installPropertiesService({ BLANK: '  ' });
    expect(Config.optional('TWILIO_API_KEY_SID')).toBeNull();
    expect(Config.optional('BLANK')).toBeNull();
  });
});

describe('Config.validateAll', () => {
  test('passes silently when every required key is present', () => {
    installPropertiesService(ALL_KEYS_SET);
    expect(() => Config.validateAll()).not.toThrow();
  });

  test('throws naming ALL missing keys at once (plural wording), not just the first', () => {
    const partial = { ...ALL_KEYS_SET };
    delete partial.VERIFIER_KEY;
    delete partial.UNLOCK_SECRET;
    installPropertiesService(partial);
    expect(() => Config.validateAll()).toThrow(
      /Missing Script Properties: VERIFIER_KEY, UNLOCK_SECRET/
    );
  });

  test('an empty-string key fails validation at the boundary, not mid-run', () => {
    installPropertiesService({ ...ALL_KEYS_SET, UNLOCK_SECRET: '' });
    expect(() => Config.validateAll()).toThrow(
      expect.objectContaining({ name: 'MissingConfigError' })
    );
    expect(() => Config.validateAll()).toThrow(/UNLOCK_SECRET/);
  });

  test('the validation error carries the MissingConfigError name', () => {
    installPropertiesService({});
    expect(() => Config.validateAll()).toThrow(
      expect.objectContaining({ name: 'MissingConfigError' })
    );
  });

  test('never leaks a secret VALUE into an error message', () => {
    // One key missing, all others set to sentinel values — the thrown message
    // must mention the missing KEY but no stored VALUE.
    const partial = { ...ALL_KEYS_SET };
    delete partial.WEBHOOK_TOKEN;
    installPropertiesService(partial);
    let thrown;
    try {
      Config.validateAll();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    for (const secretValue of Object.values(partial)) {
      expect(thrown.message).not.toContain(secretValue);
    }
  });
});

describe('Config.validateForAlert', () => {
  test('passes with only the alert-path keys — webhook secrets not required', () => {
    // Exactly the situation mid-build (Chunks 5-7) and the failure-isolation
    // case post-launch: webhook-only secrets absent, daily alert still runs.
    const alertOnly = { ...ALL_KEYS_SET };
    delete alertOnly.WEBHOOK_TOKEN;
    delete alertOnly.UNLOCK_SECRET;
    installPropertiesService(alertOnly);
    expect(() => Config.validateForAlert()).not.toThrow();
  });

  test('still fails loudly when an alert-path key is missing', () => {
    const partial = { ...ALL_KEYS_SET };
    delete partial.ALPHA_VANTAGE_KEY;
    installPropertiesService(partial);
    expect(() => Config.validateForAlert()).toThrow(/ALPHA_VANTAGE_KEY/);
  });

  test('every alert key is also a required key (the sets stay consistent)', () => {
    for (const key of Config.ALERT_KEYS) {
      expect(Config.REQUIRED_KEYS).toContain(key);
    }
  });
});

describe('Config.isDebugMode', () => {
  test('true only for the literal string "true"', () => {
    installPropertiesService({ DEBUG_MODE: 'true' });
    expect(Config.isDebugMode()).toBe(true);
  });

  test('"TRUE", "1", and unset all mean live sending', () => {
    installPropertiesService({ DEBUG_MODE: 'TRUE' });
    expect(Config.isDebugMode()).toBe(false);
    installPropertiesService({ DEBUG_MODE: '1' });
    expect(Config.isDebugMode()).toBe(false);
    installPropertiesService({});
    expect(Config.isDebugMode()).toBe(false);
  });
});
