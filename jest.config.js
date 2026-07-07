// Jest configuration — the local test harness for Spazito.
//
// This file never reaches Apps Script: clasp pushes only what is inside
// rootDir ("src" in .clasp.json) — that setting is the primary guard — and
// .claspignore is the backstop that keeps *.test.js off the push even if
// rootDir were ever misconfigured. (A pushed test/config file's require()
// would throw at load and kill every execution; see ADR 006 §12.)
//
// The coverage gate is enforced HERE: `npm test` FAILS if coverage drops
// below the floors in coverageThreshold, so a chunk cannot pass its Council
// Gate while under-tested.
//   - src/core/ (pure logic) is held at 100% — pure functions have no excuse.
//     Carving core into its own threshold group also removes it from the
//     global pool, so a well-tested core can never average away an
//     under-tested shell module.
//   - Everything else (the shell modules, which will be tested with mocked
//     GAS globals — PropertiesService, UrlFetchApp, ... — wired via Jest
//     mocks as each shell chunk lands) must clear the 80% global floor.
module.exports = {
  testEnvironment: 'node',

  // Tests live alongside the source they test (src/**/*.test.js), plus the
  // fidelity tests that pin the shared GAS fakes (test/gasMocks.test.js).
  roots: ['<rootDir>/src', '<rootDir>/test'],

  // Recreates GAS's shared global scope for Node: installs the pure core
  // modules as globals so shell modules can reference them by bare name,
  // exactly as they do in Apps Script (see test/gasScope.js).
  setupFiles: ['<rootDir>/test/gasScope.js'],

  // Coverage always on, so the floors below are enforced on every run.
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 80,
      functions: 80,
    },
    './src/core/': {
      lines: 100,
      branches: 100,
      functions: 100,
    },
    // Per-FILE floor for shell modules: no single module can hide under
    // its well-tested siblings' average (the global pool masks that).
    './src/*.js': {
      lines: 80,
      branches: 80,
      functions: 80,
    },
  },
};
