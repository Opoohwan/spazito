# ADR 001 — Serverless on Google Apps Script

**Status:** Accepted
**Date:** 2026-07-04

## Context

Spazito needs to do two things on free, zero-maintenance infrastructure:

1. Fire once every weekday at 5:00pm and send one SMS.
2. Receive inbound SMS commands via a webhook and reply.

That means it needs, at minimum: a scheduled trigger, a small amount of durable
key-value storage (watchlist + paused flag), a way to make outbound HTTPS calls
(Alpha Vantage, Twilio), and a publicly reachable HTTP endpoint for Twilio to POST
to. The premise of the product is that it costs nothing and never needs a server
babysat.

## Decision

Run entirely on **Google Apps Script**. GAS provides all four requirements in one
free box:

- **Time-based triggers** — the Mon–Fri 5pm schedule, no cron host to run.
- **`PropertiesService`** — durable key-value storage, no external DB (see ADR 004).
- **`UrlFetchApp`** — outbound HTTPS to Alpha Vantage and Twilio.
- **Web app deployment** — a public `doPost` URL for the Twilio inbound webhook.

No server, no container, no infrastructure to secure or pay for.

## Alternatives Considered

- **AWS Lambda + EventBridge + SSM** — real tooling and real local tests, but
  introduces IAM, infra to manage, and leaves the free tier eventually. Overkill
  for one daily text.
- **Cloudflare Workers + Cron Triggers + KV** — excellent DX and fast, but far more
  machinery than one scheduled SMS justifies.
- **Google Cloud Functions + Cloud Scheduler + Firestore** — scales, but we do not
  need scale, and it costs money. GAS is the free sibling.
- **GitHub Actions scheduled workflow** — free compute and git-native, but it has
  **no inbound webhook**, so it cannot receive SMS commands. Dealbreaker.
- **Raspberry Pi / VPS + cron** — full control, but a box to babysit — which kills
  the zero-maintenance premise outright.

## Consequences

**Gain:**
- Zero cost, zero infrastructure, zero maintenance surface.
- Triggers, storage, HTTP client, and webhook host all in one runtime.
- Nothing to keep patched or online.

**Give up:**
- The GAS runtime is a sandbox with real quirks (single global scope, no `require`,
  6-minute execution cap, `doPost` cannot return TwiML). These constrain the code.
- Local testing is limited — GAS APIs only exist inside Google's runtime. This is a
  primary driver of the architecture in ADR 005.
- `clasp` is the only bridge to local version control; the editor is the source of
  truth for deployment.
