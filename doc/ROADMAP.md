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

**The build is complete.** Chunks 0–8b (scaffold, all nine shell modules, six core
modules, the council-gated rhythm, 342 tests at 100% coverage) shipped — the story
lives in `doc/CHANGELOG.md`. What remains is putting it in the world:

### Chunk 9 — Deploy + live smoke test 🧑 💰
- [ ] `clasp login` → `clasp create --type webapp` (`create-script` on clasp 3.x) →
      set `"rootDir": "src"` in `.clasp.json` **before any push** (PROCESSES.md step 2)
- [ ] `clasp push` → `clasp deploy` → copy the web-app URL
- [ ] Set all Script Properties (API keys + numbers + `WEBHOOK_TOKEN`, `VERIFIER_KEY`,
      `UNLOCK_SECRET`; optionally `TWILIO_API_KEY_SID` for the hardened auth path)
- [ ] Wire the Twilio webhook (POST) to the **token-bearing** URL (`…/exec?k=…`);
      leave the Fallback URL EMPTY (PROCESSES.md step 6)
- [ ] Run `createTrigger` once from the editor (OAuth consent on first run)
- [ ] 🧑 Smoke test: text `list` → confirm reply; run `testSendNow` → confirm the SMS
      arrives and its `[#N TAG]` verifies in `tools/spazito-verifier.html`
- [ ] **Integration-seams checklist** (break points unit tests can't cover): trigger
      really fires 5pm LA; `.claspignore` held (app loads); real `doPost` payload shape;
      real Alpha Vantage + Twilio responses match the golden fixtures — **if the live
      shape differs, recapture and commit the refreshed fixture**; layered gate rejects
      a bad token / wrong `From` / replayed SID; a live `[#N TAG]` verifies offline
- [ ] Trial-account caveats until upgraded: verify the recipient number (else 21608),
      and the trial body prefix breaks `[#N TAG]` verification (PROCESSES.md)
- [ ] Key provisioning to the recipient: split-channel per ADR 008 §7 (never email the
      key); include the "no tag = couldn't sign, not forged" note
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
