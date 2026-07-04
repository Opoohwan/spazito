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
- [ ] Folder structure: `src/` (shell), `src/core/` (pure)
- [ ] `package.json` + Jest + `coverageThreshold` at 80% lines/branches (build fails
      under)
- [ ] Prove the pipeline: one trivial `src/core/` function + its test, green, with the
      dual-load export guard and a coverage report
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
      `SPY, GLD, SLV` when unset; add uppercases + de-dupes; remove is a friendly no-op
- [ ] **Tests:** default-when-unset; add dedup/uppercase; remove absent; paused get/set;
      **state isolation** between tests
- 🛡 **+ SMEs:** `gas-platform-expert`

### Chunk 3 — `core/Formatter` *(pure — the money rules)*
- [ ] `quotes → "S&P 7,500 | Gold 4,500 | Silver 70.00"`; SPY/GLD comma no-decimals,
      SLV exactly 2dp, custom tickers generalize; appends a note for any failed ticker
- [ ] **Tests (high-value):** each label's format; sub-dollar price; very large price
      (comma grouping); missing/failed quote; partial-subset note. Target ~100%.
- 🛡 **+ SMEs:** `javascript-rigor-expert` (money/float/coercion)

### Chunk 4 — `core/CommandParser` *(pure — body → intent)*
- [ ] `parse(body) → { type, arg }`; case-insensitive, trimmed; every command + alias
      (`stop→pause`, `start→resume`, `status→list`); empty/garbage → `help`
- [ ] **Tests:** every command and alias; whitespace/case; `add TSLA` → arg `TSLA`;
      empty → help; garbage → help. Target ~100%.
- 🛡 **+ SMEs:** `spec-conformance-reviewer` (all spec'd commands present)

### Chunk 5 — `PriceService` *(Alpha Vantage — sole caller)*
- [ ] Only module that calls Alpha Vantage; `quotesFor(tickers) → { ok, failed }`;
      per-ticker try/catch; detects the rate-limit `Note`/`Information` envelope; does no
      formatting
- [ ] **Tests:** valid GLOBAL_QUOTE parse; rate-limit envelope handled; bad symbol;
      **one ticker fails, others still return** (partial). `UrlFetchApp` mocked.
- 🛡 **+ SMEs:** `market-api-expert`, `resilience-reviewer`, `cost-quota-guardian`

### Chunk 6 — `SmsService` *(Twilio — sole caller)*
- [ ] Only module that calls Twilio; `send(message)` via REST (E.164, basic auth
      header); `DEBUG_MODE="true"` logs instead of sending; a send failure logs, doesn't
      throw
- [ ] **Tests:** correct REST shape; DEBUG_MODE logs-not-sends; failure logged not
      thrown; **auth token never logged**. `UrlFetchApp` mocked.
- 🛡 **+ SMEs:** `twilio-expert`, `cost-quota-guardian`

### Chunk 7 — `Scheduler` *(orchestrator + daily alert)*
- [ ] `runDailyAlert()` orchestrates only: paused-check → tickers → quotes → format →
      send; top-level try/catch (unattended); `createTrigger()` (clears existing first,
      installs Mon–Fri 5pm); `testSendNow()`
- [ ] **Tests:** paused → nothing sent; partial failure → partial send; happy path calls
      each collaborator once; top-level catch logs. All collaborators mocked.
- 🛡 **+ SMEs:** `resilience-reviewer`, `spec-conformance-reviewer`, `gas-platform-expert`
      (trigger semantics)

### Chunk 8 — `CommandHandler` *(`doPost` + dispatch)*
- [ ] `doPost(e)`: **authorize `From == RECIPIENT_NUMBER` first**, then parse → dispatch
      table → reply via `SmsService`; `add` validates via `PriceService` before insert;
      malformed body → help; replies are REST, never TwiML
- [ ] **Tests:** unauthorized sender → no action; each command dispatches; `add`
      validates first; malformed → help; auth runs before any handler
- 🛡 **+ SMEs:** `twilio-expert` (no-TwiML, webhook), `spec-conformance-reviewer`,
      `gas-platform-expert` (`doPost` contract) — `security-reviewer` runs loud here

### Chunk 9 — Deploy + live smoke test 🧑 💰
- [ ] `clasp deploy` → copy web-app URL
- [ ] Set all Script Properties (five secrets); wire the Twilio webhook (POST) to the URL
- [ ] `clasp run createTrigger` (once)
- [ ] 🧑 Smoke test: text `list` → confirm reply; run `testSendNow` → confirm SMS arrives
- 🛡 **Full council final pass + 🧑 David manual verification**

---

## Parking Lot

- **Duplicate-send guard** — a `LAST_SENT_DATE` key so a double-firing trigger can't text
  twice. Noted in `SCHEMA.md` as reserved. Add if it proves needed; not worth the state
  on day one.
