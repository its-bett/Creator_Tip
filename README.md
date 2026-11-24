# TipJar — Creator Tipping & Support Platform

A mobile-first creator support page for Kenya, powered by **Next.js 16**, **Supabase/PostgreSQL**, and the **Safaricom Daraja STK Push** API.

Supporters pick a preset gift (or a custom amount), leave a name and message, choose **M-Pesa, Airtel Money, PayPal or Binance Pay**, and approve the payment. The site polls the payment status and shows the receipt when a callback arrives.

> M-Pesa uses the real Daraja API when credentials are configured. Airtel Money, PayPal and Binance Pay are **simulated demo methods** — they have full checkout UI, status tracking and receipts, but no merchant integrations or real charges.

**Earnings are private.** Public profiles show a normal creator-style layout (posts, followers, following, supporters) and supporter wall with names/messages only — no totals, per-gift amounts or receipts. The creator alone can unlock those figures in the token-gated dashboard.

## What's implemented

| Roadmap phase | Implementation |
| --- | --- |
| 1 — Architecture & database | Next.js App Router + Tailwind 4, Supabase schema (`supabase/schema.sql`), `creators`, `gift_tiers`, `transactions`, `creator_stats` view, RLS policies |
| 2 — Frontend UI/UX | Creator header, gift grid with “Popular” badge, custom gift tile, four-method selector, contextual checkout fields, loading/waiting/success/failed states, recent supporters wall |
| 3 — Backend & Daraja | OAuth token caching, STK push with timestamp + base64 password, callback webhook with idempotency and amount checks, status polling endpoint; provider abstraction for demo methods |
| 4 — Testing & simulation | File-backed demo store, sandbox simulation buttons (success/cancel), phone + amount validation, request rate limiting, prompt expiry |
| 5 — Privacy & dashboard | Public profile shows followers/following style stats; amounts and receipts stripped from public API/UI; token-gated `/dashboard/[username]` with earnings summary and activity |
| 6 — Deployment | Environment-driven live/demo switching, public callback URL config, secrets kept server-side |

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. With no environment variables set, the app runs in **demo mode**: data is seeded from `src/lib/seed.ts` and persisted to `.data/store.json`. Nothing is charged and no request reaches Safaricom.

Two sample profiles are available:

- `/` → `@1._coastspoter` (configurable with `DEFAULT_CREATOR_USERNAME`)
- `/wanjiku_makes` → a second creator, to demonstrate dynamic profile routes
- `/dashboard/1._coastspoter` → the private creator dashboard. Locally the access code is `tipjar-demo`; set `CREATOR_DASHBOARD_TOKEN` in `.env.local` to choose your own.

In demo mode the checkout modal offers **Simulate success** and **Cancel payment** buttons, which feed a synthetic callback through the same callback processor used in production. Each method has its own input field: phone number for M-Pesa/Airtel, email for PayPal, and Pay ID or email for Binance Pay. Receipts are prefixed `MP`, `AR`, `PP` and `BN` respectively.

```bash
npm run build   # production build
npm run lint    # eslint
```

## Connect Supabase

1. Create a Supabase project.
2. Run `supabase/schema.sql`, then `supabase/seed.sql` in the SQL editor.
3. Copy `.env.example` to `.env.local` and set:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

The service role key is used only in server components and route handlers. Never prefix it with `NEXT_PUBLIC_`.

If either Supabase variable is unset, the app uses the local `.data/store.json` file store instead — no database setup required. If both are set but requests fail with `permission denied for table creators` or similar, the key's role lacks privileges (or the schema has not been applied in that project): re-run `supabase/schema.sql` and confirm the key belongs to the same project. Comment out both variables to return to file-store mode while testing payments.

## Enable M-Pesa (sandbox first)

New to Daraja? Follow the step-by-step [sandbox setup guide](docs/MPESA_SANDBOX.md) to create an account, attach the M-Pesa Express product, find the shortcode/passkey and expose a callback URL.

1. Get credentials from the [Safaricom Developer Portal](https://developer.safaricom.co.ke/).
2. Set in `.env.local`:

```bash
MPESA_BASE_URL=https://sandbox.safaricom.co.ke
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=...
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://your-public-domain/api/tips/callback
MPESA_CALLBACK_SECRET=a-long-random-string
```

3. Register `MPESA_CALLBACK_URL` in your Daraja app. Safaricom must be able to reach it over HTTPS — `localhost` will not work. Use a tunnel (e.g. ngrok) for sandbox testing.
4. When the callback secret is set, the app appends it as `?secret=...` to the callback URL and rejects callbacks that don't include it. For live deployment, rotate to a fresh secret and register the new URL.
5. For production, set `MPESA_BASE_URL=https://api.safaricom.co.ke` with your paybill shortcode and passkey after Safaricom go-live approval.

No STK push is sent until **all four** Daraja variables are present; otherwise the app stays in demo mode.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/creators/[username]` | Public profile, gift tiers, follower-style stats, recent supporters (no amounts/receipts) |
| `POST` | `/api/creators/[username]/earnings` | Private earnings; requires `Authorization: Bearer <code>` or `{ "token": "<code>" }` |
| `POST` | `/api/tips/initiate` | Validate tip, create `PENDING` transaction, start STK push |
| `POST` | `/api/tips/callback` | Daraja webhook; updates transaction from `ResultCode` |
| `GET` | `/api/tips/status?id=…` or `?checkoutRequestId=…` | Poll payment state for the checkout UI |
| `POST` | `/api/tips/demo/complete` | Local-only provider simulation for all four methods (404 in live mode) |

## Payment flow

1. `POST /api/tips/initiate` stores a `PENDING` transaction with its `payment_method` (amount always taken from the stored gift tier, never from the browser).
2. For live M-Pesa, Daraja returns a `CheckoutRequestID`, which is saved on the transaction. Demo methods generate a local reference.
3. The UI polls `/api/tips/status` every two seconds while showing “Waiting for M-Pesa”.
4. `/api/tips/callback` verifies the secret, finds the transaction, and writes `SUCCESS` (with receipt) or `FAILED` (with reason). Repeated callbacks are ignored.
5. Prompts that never receive a callback expire after `PAYMENT_TIMEOUT_MINUTES`.

## Private earnings

Set `CREATOR_DASHBOARD_TOKEN` in `.env.local` to a long random string (for example `openssl rand -hex 32`), then open `/dashboard/<username>` and enter it. The code is checked in constant time on the server, never stored in the app database, and kept in the browser tab's `sessionStorage` only until you lock the dashboard or close the tab.

Public routes never return `total_supported` or per-transaction amounts/receipts: `getCreatorProfile()` maps supporters through a redacting helper and builds its stats from follower/following/post counts. Earnings are read only by `getCreatorEarnings()` behind the protected endpoint. Without `CREATOR_DASHBOARD_TOKEN`, production returns `503` for the earnings endpoint; local development falls back to the clearly-labelled `tipjar-demo` code.

## Security notes

- Secrets are read from server-side environment variables only.
- Money figures and receipts are absent from public profile JSON, the profile UI and the supporter wall; the earnings endpoint is the only way to read them.
- Public RLS allows reading profiles/tiers; all transaction reads and writes use the service role.
- Callback secret is compared in constant time; amount mismatches between callback and stored transaction are rejected.
- Basic per-IP rate limiting is built in (15 requests/minute per process). Use a shared store such as Upstash when running multiple instances.
- Before accepting real money: enable HTTPS, add monitoring/alerting for failed callbacks, reconcile against Daraja settlement reports, and confirm Safaricom's business verification.
- To make Airtel Money, PayPal or Binance Pay real, add merchant credentials and a provider-specific adapter/webhook behind the existing `paymentMethod` field; the checkout and status UI will not need to change.

## Project structure

```
src/
  app/
    [username]/page.tsx          # public creator profile route
    dashboard/[username]/page.tsx # private creator dashboard route
    api/creators/[username]/     # public profile JSON
    api/creators/[username]/earnings/ # token-gated earnings JSON
    api/tips/{initiate,callback,status,demo/complete}/
    page.tsx                     # default creator
  components/
    creator-page.tsx             # client-side tipping UI
    creator-dashboard.tsx        # access-code form + private earnings UI
    profile.tsx                  # server-side data loading + Suspense
  lib/
    db.ts                        # Supabase adapter + local file fallback
    mpesa.ts, phone.ts           # OAuth, STK push, phone helpers
    payments.ts                  # payment method metadata + input validation
    payment-callback.ts          # shared callback processor
    types.ts, seed.ts, validation.ts, rate-limit.ts
supabase/
  schema.sql, seed.sql
docs/
  MPESA_SANDBOX.md             # Daraja sandbox onboarding + test flow
```
