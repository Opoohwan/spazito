// Jest bootstrap (wired via setupFiles in jest.config.js).
//
// In Apps Script every file runs in ONE shared global scope, so a shell
// module can reference a core module (`Tickers`, `Formatter`, ...) by bare
// name. Node has no such scope. This file recreates it for tests, in exactly
// one place — and AUTOMATICALLY: every module in src/core/ is discovered and
// installed as a global, so adding a new core module can never be silently
// forgotten here (that failure would otherwise surface as a confusing
// ReferenceError in some unrelated shell test much later).
//
// Core modules only — they are pure and stateless, so tests never need to
// mock them and there is nothing to tear down. SHELL collaborators are
// different: tests install those as (usually mocked) globals themselves,
// through the gasMocks registry, so they get cleaned up between tests.
//
// The dual-load guard in each module stays exactly one line (ADR 006 §2):
// it never requires dependencies or touches `global` — that is this file's
// job, and only this file's.
const fs = require('fs');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'src', 'core');

for (const file of fs.readdirSync(CORE_DIR)) {
  if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
  const exported = require(path.join(CORE_DIR, file));
  for (const [name, moduleObject] of Object.entries(exported)) {
    global[name] = moduleObject;
  }
}
