/**
 * Scheduler.js — SHELL module. Orchestrates the daily alert and owns the
 * time trigger. It does NOTHING itself (ADR 006 §4): no fetching, no
 * formatting, no persisting, no sending — it asks the module that owns
 * each job, in order, and wraps the whole thing so an unattended failure
 * is logged, never silent.
 *
 * The daily flow (ARCHITECTURE.md has the diagram):
 *   validate config (loud) → paused? stop → tickers → quotes → format → send
 *
 * The [#N TAG] auth block (ADR 008 §6) is appended between format and send
 * by the security signer — that step lands in Chunk 8b and slots in here.
 */
const Scheduler = {
  // When the daily text goes out: the 5pm hour, AMERICA/LOS_ANGELES —
  // Apps Script triggers fire in the script's manifest timezone
  // (src/appsscript.json), which tracks the recipient's wall clock through
  // DST (ADR 002). NOTE a GAS quirk: atHour(17) means "sometime in the
  // 17:00–18:00 window" — Google picks the exact minute, we don't.
  ALERT_HOUR: 17,

  /**
   * One daily run. Per-ticker problems degrade (n/a slots, partial send —
   * ADR 006 §9). But if the RUN ITSELF dies (bad config, an unexpected
   * explosion), it is logged scrubbed AND re-thrown: a swallowed error
   * would mark the execution "Completed" and suppress Google's built-in
   * trigger-failure email to the owner — turning "no text arrived" into a
   * mystery nobody is notified about. A red execution + email is the
   * unattended system's only way to wave for help.
   *
   * (Double-fire note: GAS triggers are at-least-once; a rare double
   * invocation sends two texts. Accepted — see ROADMAP Parking Lot,
   * LAST_SENT_DATE — not worth state on day one.)
   */
  runDailyAlert() {
    try {
      // Fail LOUD on a half-configured deployment before doing anything
      // (ADR 006 §8) — and only for the alert path's own keys, so a
      // webhook-only secret can never stop the daily text.
      Config.validateForAlert();

      if (Watchlist.isPaused()) {
        console.log('Alerts are paused — daily run skipped, nothing sent.');
        return;
      }

      const tickers = Watchlist.tickers();
      const quotes = PriceService.quotesFor(tickers);

      // ALL failed (distinct from an EMPTY watchlist — ADR 006 §9): the
      // message still goes out (a full "n/a" line beats silence), but this
      // error is the signal that Alpha Vantage is down/throttled or the
      // key is bad — it's what to look for in the execution log. The
      // classification itself lives in core (Formatter owns ok-semantics).
      if (Formatter.allFailed(quotes)) {
        console.error(
          'Every ticker failed this run — Alpha Vantage is down, rate-limited, or the ' +
          'API key is bad. See the per-ticker warnings above; the n/a message was still sent.'
        );
      }

      // Formatter owns the whole line — including the "watchlist is empty"
      // notice when there was nothing to fetch.
      const message = Formatter.summaryLine(quotes);

      // SmsService logs its own failures and never throws; a failed send
      // is terminal — never retried (that would double-bill; ADR 006 §9).
      SmsService.send(message);
    } catch (e) {
      // Log it scrubbed (message + stack, so a random crash is
      // diagnosable), then re-throw a SANITIZED error: the run failed and
      // the execution must go red (owner email — see the doc above). The
      // re-thrown copy is scrubbed because GAS records its message
      // verbatim in the failure record.
      const details = Redactor.scrub((e && e.message) + '\n' + (e && e.stack));
      console.error('Daily alert run failed: ' + details);
      throw new Error('Daily alert run failed: ' + Redactor.scrub(e && e.message));
    }
  },

  /**
   * Install the Mon–Fri triggers (idempotent: clears any existing ones for
   * runDailyAlert first, so re-running this can never create duplicate
   * triggers → duplicate texts; see DEBUGGING.md "I got the text twice").
   *
   * Run ONCE per deployment, by hand (editor: select createTrigger → Run).
   * Triggers are runtime state, not source — clasp push does NOT install
   * them (PROCESSES.md step 7).
   */
  installTrigger() {
    const existing = ScriptApp.getProjectTriggers();
    for (const trigger of existing) {
      if (trigger.getHandlerFunction() === 'runDailyAlert') {
        ScriptApp.deleteTrigger(trigger);
      }
    }

    // GAS has no single "weekdays" trigger — five weekly triggers, one per
    // business day, each in the manifest timezone at the ALERT_HOUR window.
    const weekdays = [
      ScriptApp.WeekDay.MONDAY,
      ScriptApp.WeekDay.TUESDAY,
      ScriptApp.WeekDay.WEDNESDAY,
      ScriptApp.WeekDay.THURSDAY,
      ScriptApp.WeekDay.FRIDAY,
    ];
    for (const day of weekdays) {
      ScriptApp.newTrigger('runDailyAlert')
        .timeBased()
        .onWeekDay(day)
        .atHour(this.ALERT_HOUR)
        .create();
    }
    // (nearMinute(0) was considered and rejected: its ±15-minute window
    // could fire BEFORE 5pm; atHour keeps every text inside the 5pm hour.)

    // Verify the end state — this runs by hand, so a throw is visible to
    // the operator, and a half-installed set must not pass silently.
    const installed = ScriptApp.getProjectTriggers()
      .filter((t) => t.getHandlerFunction() === 'runDailyAlert').length;
    if (installed !== weekdays.length) {
      throw new Error(
        'Trigger install ended with ' + installed + ' runDailyAlert trigger(s) instead of ' +
        weekdays.length + ' — re-run createTrigger (it is safe to re-run).'
      );
    }
    console.log(
      'Installed 5 weekly triggers: runDailyAlert, Mon-Fri, in the ' +
      this.ALERT_HOUR + ':00 hour (script timezone).'
    );
  },
};

// ---------------------------------------------------------------------------
// GAS entry points — the ONLY bare global functions allowed (ADR 006 §3):
// trigger targets and manual test helpers must be global for Apps Script to
// find them. Each is one line; all real logic lives on the module above.
// ---------------------------------------------------------------------------

/** Trigger target: what the Mon–Fri 5pm trigger actually invokes. */
function runDailyAlert() {
  Scheduler.runDailyAlert();
}

/** One-time setup: run by hand in the editor after deploying (PROCESSES.md). */
function createTrigger() {
  Scheduler.installTrigger();
}

/**
 * Manual test: run the full daily-alert flow RIGHT NOW, bypassing the
 * trigger. Spends real Alpha Vantage quota; set DEBUG_MODE="true" first to
 * log instead of texting (that gates Twilio only — see SCHEMA.md).
 */
function testSendNow() {
  Scheduler.runDailyAlert();
}

// Dual-load guard (ADR 006 §2): inert in Apps Script; exposes the module to
// Jest in Node. Must stay the last line of the file. (The entry points are
// exported too so tests can prove they delegate.)
/* istanbul ignore next */
if (typeof module !== 'undefined') module.exports = { Scheduler, runDailyAlert, createTrigger, testSendNow };
