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
