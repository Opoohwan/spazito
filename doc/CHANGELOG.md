# Changelog

Our internal journal of where we've been. One story per release — what it was and why
it mattered. Configuration and deployment gotchas are called out because they affect
setup. Everything else is in `git log`.

---

## [Unreleased]

**It's live (Chunk 9 — deploy).** Spazito is deployed on Apps Script and texting its
recipient. The daily alert delivers, commands come back through the security gate and get
answered, and a live `[#N TAG]` was pasted into the offline verifier and came back
**✅ Authentic** — the HMAC computed on Google's servers matching the one computed in a
browser, byte for byte.

**The carrier war, which took longer than building the entire app.** This is the part worth
remembering, and it's now written up honestly in the README for anyone who tries this next:

- **US carriers block all programmatic SMS from unregistered numbers** (error **30034**).
  This is a carrier mandate via The Campaign Registry — *not* a Twilio policy. Switching
  providers does not escape it.
- **A2P 10DLC rejected us three times** (error **30912**), always the same finding: *"this
  describes person-to-person messaging."* A small, interactive bot **reads as P2P to a
  reviewer no matter how the description is worded** — the terse texts and the two-way
  commands look like a conversation, not a broadcast. That path is unwinnable for a tool
  like this. Cost of the lesson: **$19**, non-refundable.
- **Toll-free verification is the path that works.** A different, more permissive review;
  verification is **free**, and so are resubmissions. A local number cannot be converted —
  a toll-free number must be bought.
- It rejected us once on **30489 — "Website Must Be Established and Active."** A single thin
  opt-in page thrown up to satisfy compliance gets rejected. What passed: a **real
  multi-page site** (landing, how-it-works, features, sample messages, FAQ, and separate
  privacy + terms pages), served free from `docs/` on GitHub Pages. It was approved within
  minutes of the resubmit — the website *was* the whole objection.
- **Twilio's console is broken for resubmitting** a rejected verification (`Invalid Customer
  profile`, no way forward). The Messaging Compliance **API** works — and rejects a no-op
  edit, so at least one field must actually change.

**Honest cost.** The old docs claimed Spazito "runs entirely on free-tier infrastructure."
**That was wrong**, and it's now corrected everywhere. Apps Script and Alpha Vantage are
free; the SMS leg is not. Real ongoing cost is **~$28–30/yr**, and roughly **90% of it is
fixed rent** — the number and its registration — not messaging. Sending the texts costs
about $3 a year.

**Published.** The repo is public under MIT at `github.com/Opoohwan/spazito` — verified clean
of secrets in both the working tree *and* the full git history. The README now carries the
architecture, the security model, and the carrier-registration survival guide. Also shipped:
`tools/owners-manual.html`, a printable fold-over booklet for the recipient (one sheet,
folded once) whose key and unlock phrase are typed **in the browser and never written to
disk**, so a filled-in copy can't leak into the public repo.

**Known gap → Chunk 10.** The trigger does not honor the *"5:00pm"* spec: Apps Script's
`atHour(17)` fires at a random minute inside the hour (observed live: 5:02, 5:09, 5:49,
5:58). The recipient has been told to expect it before 6 for now. The fix is scoped in the
ROADMAP.

---

**The build (Chunks 0–8b).** The entire system now exists and is tested: 342 Jest
tests, 100% coverage on every file, enforced by config (core pinned at 100%, per-file
shell floors). Nine gated chunks, each one commit, each passed through the council
before landing:

- **Chunk 0** — scaffold + harness: the manifest (in `src/`, `rootDir` contract),
  `.claspignore` push-safety, Jest with the enforced coverage gate, and the dual-load
  pipeline proven end to end.
- **Chunks 1–2** — `Config` (fail-loud secrets, entry-point-scoped validation so a
  webhook-only key can never kill the 5pm text) and `Watchlist` (locked writes,
  self-healing reads that enforce the ticker allowlist and the ADR 007 cap at the
  boundary that feeds API URLs).
- **Chunks 3–4** — the pure core: `Formatter` (the money rules — locale-safe grouping,
  float-boundary pins, `n/a` in place, nothing but ASCII in a signable payload) and
  `CommandParser` (every command + alias, total function, raw args preserved for the
  case-sensitive unlock secret).
- **Chunks 5–6** — the API owners: `PriceService` (rate-limit short-circuit, budget
  clamps, the `api_error` envelope so a bad key never reads as "couldn't find TICKER",
  and log redaction after a source-verified finding that real GAS network exceptions
  embed the key-bearing URL) and `SmsService` (scoped-key auth with a warned fallback,
  DEBUG_MODE zero-spend, phone numbers scrubbed from every log path, 21610/21608
  handled by name). `core/Redactor` became the one owner of log redaction.
- **Chunk 7** — `Scheduler`: validate → paused-check → fetch → format → sign → send,
  with a dead run re-thrown so the execution goes red and Google's failure email fires
  (a swallowed error looked "Completed" and hid silent death); idempotent Mon–Fri
  trigger install with post-install verification.
- **Chunk 8a** — the inbound path: `CommandHandler` (`doPost`: gate first, dispatch
  table, one REST reply, always an empty 200), `core/Replies` (all the warm copy),
  `SecurityGate` + `core/SecureCompare`. The gate surfaced the **carrier STOP trap**
  (STOP opts out at the carrier; only START — not `resume` — undoes it; error 21610
  now explains itself) and the help copy steers around it.
- **Chunk 8b** — the security vault: `SecurityVault` (sequence counter, lockout,
  replay set, hashed-sender audit ring), `Signer` (`[#N TAG]` matching the offline
  verifier byte-for-byte — golden-vector tested against an independent HMAC
  implementation AND against the live verifier file), the full layered gate, `log` +
  `unlock` commands, `Locks` as the one home of the script-lock discipline. The
  full-panel gate caught the lockout being a **self-DoS timebomb** (ambient spam could
  seal the bot; floods could drain the storage quota) — redesigned so only token-valid
  failures count, hostile traffic costs one read and zero writes, and the sealing
  moment sends the one-time 🔒 notice.

**Process note:** gates ran budget-tiered from Chunk 7 on (mechanical grep invariants
run free by the orchestrator; lean panels for small chunks; the full panel for the
vault) — the catches above are why the council stayed worth its cost.

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
