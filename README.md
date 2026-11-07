# BountyPilot

An agent that pays open-source bounty contributors through PayPal Payouts once their merged PR is verified.

> **Status:** 🚧 Work in progress for the PayPal AI Hackathon.

---

## About the hackathon

The core requirement is a project that meaningfully uses both PayPal and AI, built on the PayPal sandbox.

| | |
|---|---|
| **Event** | PayPal AI Hackathon |
| **Dates** | Oct 1 – Nov 12, 2026 |
| **Submission deadline** | Nov 12, 2026, 12:00 pm PT (Nov 13, 4:00 am SGT) |
| **Event page** | https://paypalaihackathon.devpost.com/ |

---

## Our project

**Name:** BountyPilot (working name)

### The problem
Paying open-source contributors for bounties is manual. A maintainer has to check the PR meets the brief, collect payment details, send the money and track spend.

### Our solution
An agent that pays bounty contributors through PayPal once their merged PR is verified. A plain-code policy engine decides whether a payout is allowed; an LLM reviewer can only send a payout to human approval, never approve one itself.

### How it uses PayPal
- PayPal Payouts API, called through a custom agent tool
- PayPal Agent Toolkit
- PayPal sandbox

---

## Tech stack

| Layer | Choice |
|---|---|
| Language / framework | TypeScript + Next.js |
| Agent & payments | PayPal Agent Toolkit with the Vercel AI SDK; PayPal Payouts API (sandbox) |
| Dashboard | AG Studio (AG Grid) |
| AI / LLM provider | _TBD_ |
| Hosting | _TBD_ |

---

## Getting started

### Prerequisites
- Node.js 22 (`.nvmrc` pins it; 20.19 is the minimum supported)
- A free [PayPal Developer](https://developer.paypal.com/) account, which gives you the sandbox

### Setup
1. Clone the repo:
   ```bash
   git clone https://github.com/kthgoat/paypal_AI_Hackathon.git
   cd paypal_AI_Hackathon
   ```
2. Install dependencies (this also generates the Prisma client):
   ```bash
   npm install
   ```
3. Copy the env template and fill it in. Use **sandbox** credentials only, and never commit `.env.local`:
   ```bash
   cp .env.example .env.local        # Windows PowerShell: Copy-Item .env.example .env.local
   ```
   - ⚠️ **The sandbox Business account MUST be created with Country = United States and a USD PayPal balance (for example 5000).** Accounts created from Singapore default to SG, and payouts then fail with `INSUFFICIENT_FUNDS`. Create it on the dashboard's sandbox accounts page.
   - In the [PayPal Developer Dashboard](https://developer.paypal.com/), go to **Apps & Credentials**, switch to **Sandbox**, and create a REST app linked to that US Business account. Copy its **Client ID** into `PAYPAL_CLIENT_ID` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (the same value; it is safe in the browser) and its **Secret** into `PAYPAL_CLIENT_SECRET`. Use the copy icons next to each value (each is 80 characters).
   - From the sandbox accounts page, copy a sandbox **Personal** account's email (it ends in `@personal.example.com`) into `PAYPAL_TEST_RECEIVER`. Never use the Business account's email.
   - Leave `PAYPAL_ENVIRONMENT=SANDBOX` and `DATABASE_URL` as they are. The other keys (GitHub, LLM, AG Studio, demo admin) can stay empty until those features land.
4. Create the local database:
   ```bash
   npx prisma migrate dev
   ```
5. Seed the demo data:
   ```bash
   npm run seed
   ```
6. Start the app at http://localhost:3000:
   ```bash
   npm run dev
   ```

### Smoke test
Proves your credentials work by sending a $1.00 payout in the sandbox. It has no dependencies, so there is nothing to install first.

```bash
node --env-file=.env.local scripts/smoke-payout.mjs
```

Add `--dry-run` to authenticate and print the request without sending a payout.

Success looks like: the script prints a payout batch ID, a batch status of `SUCCESS`, and the test receiver (masked) with a transaction status of `SUCCESS`. You can then log in at [sandbox.paypal.com](https://www.sandbox.paypal.com/) with the sandbox personal account and see the $1.00 arrive.

If the item status shows `UNCLAIMED`, `PAYPAL_TEST_RECEIVER` isn't a sandbox account email; copy it again from the sandbox accounts page.

### Notes for contributors
- **Money is stored as integer cents** in the database. Convert with `usdToCents` / `centsToUsd` from `lib/db.ts`; `lib/types.ts` uses dollars.
- **Next.js 16 has Cache Components enabled.** Read `AGENTS.md` (and the docs in `node_modules/next/dist/docs/`) before writing pages or routes that fetch data.
- **Prisma 7:** the generated client lives in `lib/generated/prisma` (gitignored). Import the shared client from `lib/db.ts`, and run `npx prisma generate` after changing `prisma/schema.prisma`, because `migrate dev` does not regenerate it.

---

## Dashboard (Moe)

Open `/dashboard` after starting the app. It starts with **clearly labelled sample data**
and works without PayPal credentials, a database, or an AI API key. This is the first
dashboard deliverable from the build plan: AG Studio rendering a sample ledger.

- Overview: monthly successful spend, pending approvals, remaining budget, active bounties.
- Approval queue: reviewer summary, acceptance criteria, CI and merge checks, confidence,
  policy rule, and visible injection flags. The demo holds flagged PRs and failed checks.
- Demo approval queues a simulated `PENDING` payout; it never calls PayPal or marks money as paid.
- Demo pause/resume holds approvals. Reset demo restores the fixtures; all demo actions are in memory.
- Ledger: search, status filter, verdict details, and CSV export.
- AG Studio: editable ledger grid, successful payouts per contributor chart, and a registered
  custom approval-queue widget. Use `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` for the trial licence.
  Without a key, development uses AG Studio's unlicensed mode and may show its watermark.
- Audit log and guardrails: decisions, rule reasons, and the project's configured limits.

### Backend handoff

**Connect ledger** reads `GET /api/dashboard`, which takes a read-only database snapshot,
uses the existing `lib/db.ts` mappers, and returns `DashboardSnapshot` from `lib/dashboard.ts`.
Run the migrations and seed first. A connection failure is shown explicitly; sample data
is never silently presented as live data. Claim PayPal emails are excluded from the response;
only the already-masked payout recipient is exposed.

Live approval and pause controls are disabled until Kendrick's authenticated mutation
endpoints are available. The backend must recheck CI, merge, recipient, policy caps,
pause state, and idempotency; client-side checks are only presentation safeguards.
An approval response must not be treated as proof of a successful PayPal payment.

The **Treasurer agent remains to be connected** to the team's selected model and AG Studio
Agent Framework. There is no simulated AI chat or browser-exposed LLM key in this first slice.
AG Studio layouts currently reset when the view is reopened; saved reports are future work.

## GitHub webhook (Arif)

`POST /api/github/webhook` verifies the original request bytes using GitHub's
`X-Hub-Signature-256` header, acknowledges webhook pings, and records only
`pull_request` events with `action: closed` and `merged: true`.
Signature handling follows [GitHub's validation guide](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Verified merges are saved in `GitHubMergeEvent`, independently of the bounty ledger.
Both delivery IDs and `(repo, PR number, merge commit)` are unique, so duplicate
deliveries and replays do not insert additional work, even after a restart.
This is the reception milestone: no GitHub data fetching, AI review, or payout is
triggered yet. These events do not appear in the dashboard.

### Local test

1. Apply the new migration and regenerate the client:
   ```bash
   npx prisma migrate dev
   npx prisma generate
   ```
2. Generate a random secret locally:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```
   Put that value in `GITHUB_WEBHOOK_SECRET` in `.env.local`. This is a separate
   secret you choose, not your GitHub token or PayPal secret.
3. Start (or restart) `npm run dev` so it loads the secret.
4. In another terminal, send a signed synthetic event:
   ```bash
   node --env-file=.env.local scripts/smoke-github-webhook.mjs
   ```
   First run: `HTTP 201` with `status: received`. Repeat: `HTTP 200` with
   `status: duplicate`. The app terminal also logs the first received merge.
   The script writes one clearly named test record (`bountypilot/webhook-test`)
   to the local inbox; it does not call GitHub or PayPal.

### Connect the demo GitHub repo

Once you have a public HTTPS development URL forwarding to your local server,
add a webhook under the demo repository's **Settings → Webhooks**:

- Payload URL: `https://YOUR-DEVELOPMENT-HOST/api/github/webhook`
- Content type: `application/json`
- Secret: the same `GITHUB_WEBHOOK_SECRET` from `.env.local`
- Events: choose individual events and select **Pull requests**
- Keep SSL verification enabled and the webhook active.

The initial ping should return `200` with `status: pong`. Merge a test PR and
inspect **Recent Deliveries**: the first merged event should return `201` with
`status: received`. Redelivering it should return `200` with `status: duplicate`.
Creating or closing an unmerged PR returns `200` with `status: ignored`.

## Team

| Name | Role |
|---|---|
| Kendrick | _TBD_ |
| Arif | _TBD_ |
| Darius | _TBD_ |
| Moe | _TBD_ |

---

## Submission checklist

- [ ] Working prototype using PayPal sandbox + AI
- [ ] Public repo with an open-source license visible in the About section
- [ ] Hosted demo URL or complete run instructions
- [ ] Demo video under 3 minutes, public on YouTube, no copyrighted music
- [ ] Devpost text description and a tools-used section
- [ ] Submitted by Nov 12, 10:00 pm SGT (buffer before the real cutoff)

---

## License

MIT. See [LICENSE](LICENSE).
