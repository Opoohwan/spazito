# Spazito Roadmap

**Single source of truth for what's next. Open here first every session.**

Forward-looking only. When work is done it moves to the CHANGELOG and leaves here — no
completed items, no strikethroughs.

---

## How we build: chunks, gates, and tests

### The rhythm
Small chunks. Each one ends green (tests pass, coverage ≥ 80%), each gets a **Council
Gate**, each is **one commit**. A chunk is not "done" until its gate is clean and it's
committed. This matches the commit-per-chunk discipline — no long uncommitted stretches.

### The Council Gate — after each chunk, before the commit
- **Convened:** the five always-on reviewers **+** that chunk's domain SMEs.
  - **Always-on five (every gate):** `architecture-guardian`, `code-quality-reviewer`,
    `test-quality-reviewer` (the **QA lead**), `security-reviewer`, `tech-debt-hunter`.
  - Per-chunk lines below list only the **added** domain SMEs.
- **Adversarial, not a rubber stamp:** "looks good, no findings" is a failure of
  diligence, not a pass. Every finding carries a `file:line` and a concrete failure
  scenario. Reviewers report independently — no consensus-softening.
- **Findings come back in chat. No `.md` report files.**
- Flow: run the gate → findings to chat → resolve → re-gate if needed → **commit**.

### Testing from day 1 — the QA-lead standard
- The harness exists in **Chunk 0**, before any feature code.
- **Runner:** Jest (`coverageThreshold` enforces the gate). *Confirm at Chunk 0.*
- **Coverage floor: 80% lines + branches**, enforced by config — the suite fails under
  80%, so a gate cannot pass without it. The pure **core** targets ~100%; **shell**
  modules are covered via mocked GAS seams (`UrlFetchApp`, `PropertiesService`).
- **"Acceptable to the QA lead"** = ≥ 80% **and** tests assert real behavior (not that a
  mock was called) **and** error paths are covered **and** state is isolated between
  tests. A hollow-but-green suite fails the gate.
- **Dual-load pattern:** every module ends with
  `if (typeof module !== 'undefined') module.exports = {...}` so the same file runs in
  Node (tests) and GAS (prod). GAS ignores the guard; Node uses it.

**Legend:** 🧑 needs David · 🤖 Claude · 💰 has a cost · 🛡 Council Gate

---

## Now

### Chunk 0 — Scaffold + test harness *(testing from day 1)*
- [ ] `clasp create --type webapp`; write `appsscript.json` (timezone
      `America/Los_Angeles`, webapp access **Anyone** — required for the Twilio webhook)
- [ ] `.gitignore` — `.clasp.json`, `node_modules/`, `coverage/`
- [ ] **`.claspignore` + `rootDir: "src"`** — keep `*.test.js` / `jest.config.js` / node_modules
      off the push (a pushed test file's `require` kills every execution — ADR 006 §12)
- [ ] **`.gitattributes`** — `* text=auto eol=lf` (no CRLF churn)
- [ ] Folder structure: `src/` (shell), `src/core/` (pure); tests mirror alongside
- [ ] `package.json` + Jest + `coverageThreshold` 80% lines/branches (build fails under);
      shell tested via mocked GAS globals (`PropertiesService`/`UrlFetchApp`/`LockService`/`Utilities`)
- [ ] Prove the pipeline: one trivial `src/core/*.js` function + its Jest test, green,
      with the dual-load export guard (`.js` source so Node/Jest load it directly; clasp
      pushes it as `.gs`) and a coverage report
- [ ] First commit
- 🛡 **+ SMEs:** `gas-platform-expert` (manifest, timezone, dual-load runs in GAS)

### Chunk 1 — `Config` *(secrets, fail-loud)*
- [ ] Sole reader of secret Script Properties; `require(key)` throws a clear, named error
      if missing (never returns `undefined`)
- [ ] **Tests:** missing key → named throw; present keys → returned; no secret in any
      log; PropertiesService mocked
- 🛡 **+ SMEs:** `gas-platform-expert`

### Chunk 2 — `Watchlist` *(state owner)*
- [ ] Sole reader/writer of `WATCHLIST` + `PAUSED`; owns the schema; defaults to
      `SPY, GLD, SLV` when unset; add uppercases + de-dupes + **caps at 10** (ADR 007);
      remove is a friendly no-op; all writes under a `LockService` script lock (ADR 006 §5)
- [ ] **Tests:** default-when-unset; add dedup/uppercase; **cap refuses the 11th**;
      remove absent; remove-that-empties; paused get/set; **state isolation** between tests
- 🛡 **+ SMEs:** `gas-platform-expert`

### Chunk 3 — `core/Formatter` *(pure — the money rules)*
- [ ] `summaryLine([{ticker,price,ok}]) → "S&P 7,500 | Gold 4,500 | Silver 70.00"` —
      **ordered array, `ok` = source of truth** (Gap 1 = Option C); display-rules data
      table (SPY/GLD 0dp, SLV 2dp, custom default 2dp, all comma; **locale-safe grouping**;
      ADR 006 §10); `ok:false` renders in place as `Label n/a`; owns the whole line incl.
      the empty-watchlist notice
- [ ] **Tests (high-value):** each label's format; custom default; sub-dollar; very large
      (comma grouping); `.005` rounding boundary; NaN/empty → `ok:false` → `n/a`; a single
      `ok:false`; **all-failed**; and **empty** watchlist (distinct). ~100%.
- 🛡 **+ SMEs:** `javascript-rigor-expert` (money/float/coercion)

### Chunk 4 — `core/CommandParser` *(pure — body → intent)*
- [ ] `parse(body) → { type, arg }`; case-insensitive, trimmed; every command + alias
      (`stop→pause`, `start→resume`, `status→list`); empty/garbage → `help`
- [ ] **Tests:** every command and alias; whitespace/case; `add TSLA` → arg `TSLA`;
      empty → help; garbage → help. Target ~100%.
- 🛡 **+ SMEs:** `spec-conformance-reviewer` (all spec'd commands present)

### Chunk 5 — `PriceService` *(Alpha Vantage — sole caller)*
- [ ] Only module that calls Alpha Vantage; `quotesFor(tickers) → ordered [{ticker,price,ok}]`;
      per-ticker try/catch, **no retries** (ADR 006 §9); NaN/empty price → `ok:false`;
      **flat 15s spacing** (`MIN_CALL_SPACING_MS`); rate-limit envelope keys
      (`Note`/`Information`) a **named constant**; does no formatting
- [ ] **Tests:** valid GLOBAL_QUOTE parse; rate-limit envelope → `ok:false` (per key); bad
      symbol → `ok:false`; NaN price → `ok:false`; **one fails, others still return**;
      spacing invoked between calls. Mocks built from a **captured real response** (golden
      fixture); `UrlFetchApp` + sleep mocked.
- 🛡 **+ SMEs:** `market-api-expert`, `resilience-reviewer`, `cost-quota-guardian`

### Chunk 6 — `SmsService` *(Twilio — sole caller)*
- [ ] Only module that calls Twilio; `send(message)` via REST (E.164, **scoped API key /
      subaccount, not the master Auth Token** — ADR 008); `DEBUG_MODE="true"` logs instead
      of sending; a send failure logs, doesn't throw
- [ ] **Tests:** correct REST shape; DEBUG_MODE logs-not-sends; failure logged not thrown;
      **credentials never logged**. `UrlFetchApp` mocked from a **captured real response**.
- 🛡 **+ SMEs:** `twilio-expert`, `cost-quota-guardian`

### Chunk 7 — `Scheduler` *(orchestrator + daily alert)*
- [ ] `runDailyAlert()` orchestrates only: paused-check → tickers → quotes → format →
      send; top-level try/catch (unattended); `createTrigger()` (clears existing first,
      installs Mon–Fri 5pm); `testSendNow()`
- [ ] **Tests:** paused → nothing sent; partial failure → partial send; happy path calls
      each collaborator once; top-level catch logs. All collaborators mocked.
- 🛡 **+ SMEs:** `resilience-reviewer`, `spec-conformance-reviewer`, `gas-platform-expert`
      (trigger semantics)

### Chunk 8a — `CommandHandler` *(`doPost` + dispatch)*
- [ ] `doPost(e)`: **authorize first** via the layered gate (Chunk 8b), then parse →
      dispatch table → reply via `SmsService`; `add` runs the **free checks
      (duplicate / at-cap) BEFORE the paid AV validation**, and branches unknown-symbol
      vs. can't-reach-AV; `remove` that empties confirms; malformed body → help; replies
      are REST, never TwiML
- [ ] **Tests:** unauthorized → silent no-op; each command dispatches; `add`
      free-checks-before-AV + duplicate + unknown + at-cap; `remove` empties; malformed →
      help; auth runs before any handler
- 🛡 **+ SMEs:** `twilio-expert`, `spec-conformance-reviewer`, `gas-platform-expert` —
      `security-reviewer` runs loud here

### Chunk 8b — Security vault *(ADR 008)*
- [ ] **Layered gate** (all constant-time): `WEBHOOK_TOKEN` in URL → `From` →
      `MessageSid` replay store (TTL); auto-lockout after N + `UNLOCK_SECRET` re-arm;
      **silent 200** on any failure
- [ ] **Pull-based audit** (numbers hashed): `log` command; single optional "🔒 sealed"
      notice (no push alerts — that was the spam vector)
- [ ] **Message auth:** monotonic counter (state) + a **shell signer** appending
      `[#N TAG]` = `HMAC-SHA256(VERIFIER_KEY,"N|payload")` hex/upper/first-8 (ADR 008 §6)
      — must match `tools/spazito-verifier.html` (golden-vector test)
- [ ] **Twilio:** scoped API key / subaccount, not the master Auth Token; 🧑 enable 2FA
- [ ] **Tests:** token / `From` / replay each reject; lockout seals + unlock re-arms;
      audit records + redacts; signer tag matches the verifier's known vector; counter
      increments + persists
- 🛡 **+ SMEs:** `security-reviewer` (lead), `gas-platform-expert`,
      `javascript-rigor-expert` (HMAC/encoding), `cost-quota-guardian`

### Chunk 9 — Deploy + live smoke test 🧑 💰
- [ ] `clasp deploy` → copy web-app URL
- [ ] Set all Script Properties (API keys + numbers + `WEBHOOK_TOKEN`, `VERIFIER_KEY`,
      `UNLOCK_SECRET`); wire the Twilio webhook (POST) to the **token-bearing** URL
- [ ] `clasp run createTrigger` (once)
- [ ] 🧑 Smoke test: text `list` → confirm reply; run `testSendNow` → confirm SMS arrives
- [ ] **Integration-seams checklist** (break points unit tests can't cover): trigger
      really fires 5pm LA; `.claspignore` held (app loads); real `doPost` payload shape;
      real Alpha Vantage + Twilio responses match the golden fixtures — **if the live
      shape differs, recapture and commit the refreshed fixture**; layered gate rejects
      a bad token / wrong `From` / replayed SID; a live `[#N TAG]` verifies in
      `tools/spazito-verifier.html`
- 🛡 **Full council final pass + 🧑 David manual verification**

---

## Parking Lot

- **Duplicate-send guard** — a `LAST_SENT_DATE` key so a double-firing trigger can't text
  twice. Noted in `SCHEMA.md` as reserved. Add if it proves needed; not worth the state
  on day one.
- **Dedicated `AUDIT_SALT`** — `SecurityVault.hashSender` currently salts with
  `VERIFIER_KEY` (key reuse: the same key signs messages). Exposure is ~nil for a
  single-recipient tool whose only audit reader holds that key, but a dedicated salt
  property is cleaner. Cheap to add later; noted at the 8b gate.
- **Unsigned-degrade visibility** — when the signer can't claim a sequence number
  (vault lock busy, vanishingly rare) the daily text goes out with no `[#N TAG]`.
  Recipient guidance: "no tag = the bot couldn't sign that one, not forged" — goes in
  the key-provisioning note at deploy. A visible `[unsigned]` marker was considered and
  parked.
- _(Twilio `X-Twilio-Signature` validation was investigated and dropped — GAS web apps
  can't read request headers, so it's infeasible on this stack. Superseded by the URL
  bearer token in ADR 008.)_
