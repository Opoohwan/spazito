// Jest bootstrap (wired via setupFiles in jest.config.js).
//
// In Apps Script every file runs in ONE shared global scope, so a shell
// module can reference a core module (`Tickers`, `Formatter`, ...) by bare
// name. Node has no such scope. This file recreates it for tests, in exactly
// one place: every CORE module is installed as a global here.
//
// Core modules only — they are pure and stateless, so tests never need to
// mock them and there is nothing to tear down. SHELL collaborators are
// different: tests install those as (usually mocked) globals themselves,
// through the gasMocks registry, so they get cleaned up between tests.
//
// The dual-load guard in each module stays exactly one line (ADR 006 §2):
// it never requires dependencies or touches `global` — that is this file's
// job, and only this file's.
const { Tickers } = require('../src/core/Tickers');

global.Tickers = Tickers;
