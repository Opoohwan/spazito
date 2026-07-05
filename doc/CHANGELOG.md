# Changelog

Our internal journal of where we've been. One story per release — what it was and why
it mattered. Configuration and deployment gotchas are called out because they affect
setup. Everything else is in `git log`.

---

## [Unreleased]

**The foundation.** Before a line of `src/` exists, Spazito's architecture is fully
decided and written down — the deliberate order, so the rules shape the code as it's
written instead of being bolted on after.

The docs got a home: a `doc/` folder with `decisions/` (architecture decision records)
and `dev/` (developer guides), and the CHANGELOG and ROADMAP moved under it. Six ADRs
now record every load-bearing choice and, more importantly, *why* — serverless on Google
Apps Script (001), secrets in Script Properties (003), state in PropertiesService with no
database (004), and the two that define how the code is shaped: Functional Core /
Imperative Shell (005) and the strict, `grep`-checkable no-bleed quality standard (006).
That last one is the spine of the project — each module owns exactly one thing, pure
logic is physically separated from I/O so it can be tested in Node, and there's a
"What Never To Do" list a reviewer can check mechanically.

The `dev/` set followed: an architecture map with data-flow diagrams for both the daily
alert and inbound commands, a schema reference for the PropertiesService key-value store,
a debugging guide for diagnosing the unattended system from execution logs, and a
processes guide for the clasp/deploy workflow.

**The council was built** — twelve read-only reviewer agents in `.claude/agents/` (four
stack SMEs, five always-on craft guardians, three operational critics), each pinned to
Opus and mandated to be adversarial, plus a `/council` gate command. Findings go to chat,
never to files.

**A hard adversarial review of the whole foundation** (before any code) surfaced three
cracks and a batch of spec holes, all now fixed:
- **ADR 007 added** — living within the Alpha Vantage free tier: the 25/day·5/min limit
  is a real ceiling, so `PriceService` spaces calls 15s apart, the watchlist is capped
  at 10 tickers, and `add`'s validation call is counted against the daily budget.
- **Source files are `.js`, not `.gs`** — Node/Jest can only load `.js`, and the whole
  day-1 testing plan depends on it; clasp pushes them to Apps Script as `.gs`. Dual-load
  guard documented as the last line of every module.
- **Message-formatting rules pinned** — a display-rules data table in `Formatter`
  (SPY/GLD 0dp, SLV 2dp, custom default 2dp); failed tickers render in place as
  `Label n/a` so the line never drops a slot.
- **`Watchlist` writes are `LockService`-guarded** against concurrent `doPost`s.
- **`DEBUG_MODE` corrected** across the docs — it gates Twilio only; it does *not* stop
  Alpha Vantage calls, so a debug-mode `testSendNow` still spends quota. (Two docs had
  claimed otherwise.)
- **Security posture made honest** — the `From` check is a spoofable baseline, not
  authentication; Twilio `X-Twilio-Signature` validation is documented as the hardening
  path (Parking Lot).
- Edge commands defined (duplicate `add`, unknown symbol, at-cap, `remove`-that-empties,
  empty-watchlist notice); market-holiday behavior noted; deployment steps de-duplicated
  to `PROCESSES.md`; reviewer agents pinned to a strong model.

### Security (the gift's headline)
The recipient is off-grid and security-centric, so security became a *feature*, not
overhead — documented in **ADR 008 (Security & Defense-in-Depth)**:
- **Layered webhook gate** — a secret URL bearer token (`X-Twilio-Signature` is
  impossible on GAS — web apps can't read headers), the `From` check, and `MessageSid`
  replay protection, all constant-time; plus auto-lockout and a silent 200 on any failure.
- **Security is pull, not push** — blocked attempts are logged and retrievable via a
  `log` command, never proactively texted (push alerts would relay ambient Twilio-number
  spam to the recipient — corrected here).
- **Recipient-verifiable messages** — each text carries `[#N TAG]` (a sequence counter +
  a truncated `HMAC-SHA256(VERIFIER_KEY,"N|payload")`), checkable in a self-contained
  **offline verifier** shipped at `tools/spazito-verifier.html` (no network, self-testing
  crypto, key held only by the recipient).
- **Key delivery** — split-channel and out-of-band (e.g. half by mail, half by
  Signal/call), tool by email, checksum over the second channel. Never email the key.
- Twilio hardening — scoped API key / subaccount + account 2FA.

### Recalibration (the audience is one person — David's brother)
Once it was clear Spazito is a gift for a single, security-centric, off-grid recipient,
the plan was re-priced for *his delight + never-silently-failing* rather than SaaS
robustness. The council reviewed every open decision; the outcomes:
- **Formatter contract = Option C** — an ordered `[{ticker, price, ok}]` array (`ok` is the
  source of truth; `NaN`/empty → `ok:false`), so a failed ticker renders in place as
  `Label n/a` and the line never reorders. (The earlier `{ok, failed}` shape lost order.)
- **No retries** — a failed/slow/rate-limited ticker is just `ok:false`; retrying a
  rate-limit `Note` only deepens throttling and risks the 6-minute cap.
- **Shell is unit-tested in Node with mocked GAS globals** (not GAS-smoke-only), global 80%
  floor; a **`.claspignore`** keeps test files off the push (they'd otherwise kill the app);
  mocks are built from **golden (captured real) responses**.
- Flat **15s** call spacing; constants (`MAX_TICKERS`, `MIN_CALL_SPACING_MS`) live in their
  owner modules; `add` runs free checks before the paid validation; empty-watchlist and
  all-failed are distinct states; a minimal `LockService` write guard with a "busy" reply.

**Deployment gotcha worth remembering — the timezone was corrected from `America/Phoenix`
to `America/Los_Angeles`.** The recipient lives in Eureka, CA, which is Pacific and
observes DST. Phoenix (permanently UTC−7) would have delivered the "5pm" text at *4pm his
time all winter*. The fix is to track the recipient's own zone so "5pm" always means 5pm
on his clock. When `appsscript.json` is written, its `timeZone` must be
`America/Los_Angeles` — not Phoenix, despite any older note that called Phoenix
"intentional." (See ADR 002.)
