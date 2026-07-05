// Pins the gasScope bootstrap contract: every core module is discoverable
// and installed as a global, exactly as GAS's shared scope would provide it.
const fs = require('fs');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'src', 'core');

describe('gasScope bootstrap', () => {
  test('every src/core module is installed as a global for shell tests', () => {
    const coreFiles = fs
      .readdirSync(CORE_DIR)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    expect(coreFiles.length).toBeGreaterThan(0);

    for (const file of coreFiles) {
      const exported = require(path.join(CORE_DIR, file));
      for (const [name, moduleObject] of Object.entries(exported)) {
        // Same object, not a copy — shell tests must exercise the real thing.
        expect(global[name]).toBe(moduleObject);
      }
    }
  });
});
