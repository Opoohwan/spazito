# ADR 003 — All Secrets in Script Properties, Never in Source

**Status:** Accepted
**Date:** 2026-07-04

## Context

Spazito holds five secrets: `ALPHA_VANTAGE_KEY`, `TWILIO_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`, and `RECIPIENT_NUMBER`. The source code is version-controlled in
git and may be pushed to a remote. Anything hardcoded in source is committed in
plaintext — permanently, in history, even if later removed. A leaked Twilio auth token
is a billable-fraud vector; a leaked Alpha Vantage key burns the daily quota.

## Decision

All secrets live exclusively in **Apps Script Script Properties** (Project Settings →
Script Properties), set by hand in the editor. They are read **only** through
`Config.js`, which is the single access point. `Config` validates that every required
key is present at startup and throws a clear, named error immediately if one is
missing — it never silently proceeds and fails halfway through a run.

`.clasp.json` (which contains the live script ID) is gitignored. No secret and no
script identity is ever committed.

Enforced in code:
- No secret literal appears anywhere in `src/`.
- No module calls `PropertiesService.getScriptProperties()` for a secret except
  `Config`. Everyone else receives values from `Config`.
- A missing key is a loud startup failure, not a runtime `undefined`.

## Alternatives Considered

- **Hardcode in source** — simplest, and catastrophic. The secrets end up in git
  history forever. Rejected outright; this is the whole reason for the ADR.
- **External secret manager (e.g. GCP Secret Manager)** — real secret rotation and
  audit, but adds a cloud dependency, cost, and auth complexity to a free single-user
  app. Overkill. Rejected.
- **A gitignored `secrets.gs` file** — keeps secrets out of the committed tree, but
  one wrong `git add -f` or a teammate's misconfiguration leaks them, and `clasp push`
  would upload the file into the shared script anyway. Script Properties keep secrets
  off disk entirely. Rejected.

## Consequences

**Gain:**
- Secrets are never in the repo, never in history, never in a pushed file.
- One audited access path (`Config`) — easy to reason about who can read what.
- Missing configuration fails loudly and early instead of mid-run.

**Give up:**
- Secrets are set by hand in the GAS editor per environment. There is no automated
  provisioning; the deployment checklist must be followed. This is documented in
  README and CLAUDE.md.
- No built-in rotation — rotating a key is a manual edit in Script Properties.
