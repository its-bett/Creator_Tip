# TipJar: Monetization & Daraja Instant Payout Architecture

> Adapted from the Paystack payout draft for this repository's Next.js + Supabase + Safaricom Daraja stack.
> This document is an architecture target. Verify current Daraja API field names, endpoints, and limits against the official Safaricom Daraja documentation before implementation.

## 1. Goals

- Let creators receive **100% of successful tips** into a platform wallet.
- Monetize at cash-out with a **5% instant withdrawal fee**.
- Support **instant M-Pesa withdrawals** through **Daraja B2C**.
- Keep supporter-facing tip flow private: **the creator can see wallet balance/earnings, but supporters/tippers must never see the creator's wallet balance, available balance, withdrawals, or private totals**.
- Prevent double-spending, duplicate webhook credits, and chargeback/dispute loss.
- Fit the existing app shape: Next.js App Router, TypeScript, Supabase/Postgres service-role writes, local demo store fallback.

## 2. Current State In This Repo

Relevant existing pieces:

- Tip collection already uses Daraja STK Push:
  - `src/lib/mpesa.ts` - OAuth, STK push, STK query, callback signing/verification.
  - `src/lib/mpesa-reconcile.ts` - pending STK reconciliation.
  - `src/lib/payment-callback.ts` - shared STK callback processing and idempotent pending completion.
  - `src/app/api/tips/initiate/route.ts` - creates pending tip and starts STK push.
  - `src/app/api/tips/status/route.ts` - polls/reconciles status.
  - `src/app/api/tips/callback/route.ts` - receives signed Daraja callback.
- Data model is tip-centric, not wallet-centric:
  - `supabase/schema.sql` defines `creators`, `gift_tiers`, `transactions`, and `creator_stats`.
  - `src/lib/db.ts` computes private earnings by summing successful `transactions`.
- There is no creator payout destination, no withdrawal flow, no wallet balance, and no immutable money ledger.

The existing STK collection flow should remain the source of truth for **tip payment attempts**. The new wallet/ledger model should sit on top of successful tip settlements and withdrawal requests.

## 3. Revenue Model: 5% Withdrawal Fee

Creators receive 100% of each successful tip in their wallet. Revenue is recognized when a creator withdraws.

- **Gross withdrawal**: amount requested by creator.
- **Platform fee**: `5%` of gross withdrawal.
- **Net payout**: gross withdrawal minus platform fee.
- **Daraja B2C charge**: decide explicitly whether it is absorbed inside the 5% platform fee (recommended for simple UX) or deducted after fee. Model both fields in the ledger.

Example:

| Item | Amount (KES) |
|---|---:|
| Creator requests withdrawal | 10,000.00 |
| Platform fee (5%) | 500.00 |
| B2C charge absorbed by platform | 0.00 - 50.00 (example, confirm actual tariff) |
| Net sent to creator M-Pesa | 9,500.00 |
| Platform net revenue | 500.00 minus absorbed B2C charge |

Rules:

- Never deduct a fee when the fan sends a tip.
- Show the fee breakdown before confirming withdrawal.
- Enforce a minimum withdrawal so Daraja/B2C costs do not erase margin.

## 4. Target Data Model

Use Supabase/Postgres as the authoritative financial store. Keep money values in **minor units** (`bigint` cents) or `numeric(12,2)` consistently; do not mix. This repo currently uses integer KES amounts for tips; for payout accounting, prefer **integer minor units** or `numeric(12,2)` with strict rounding rules. The schema below uses `numeric(12,2)` for readability; convert deliberately if you standardize on minor units.

### 4.1 `wallets`

One wallet per creator per currency.

```sql
create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null unique references public.creators(id) on delete cascade,
  currency text not null default 'KES' check (currency in ('KES')),
  pending_balance numeric(12,2) not null default 0 check (pending_balance >= 0),
  available_balance numeric(12,2) not null default 0 check (available_balance >= 0),
  reserved_balance numeric(12,2) not null default 0 check (reserved_balance >= 0),
  payout_phone text check (payout_phone ~ '^254[17][0-9]{8}$'),
  payout_name text,
  payout_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Notes:

- `available_balance` - cleared funds that can be withdrawn.
- `pending_balance` - funds held during clearance/risk window. For normal M-Pesa STK tips, this can be short or zero; keep it for future card/chargeback rails and dispute handling.
- `reserved_balance` - amount locked while a withdrawal is being processed. Prevents concurrent payout requests from spending the same funds.
- `payout_phone` replaces Paystack `recipient_code`. For Daraja B2C, the destination is usually the creator's M-Pesa MSISDN.

### 4.2 `wallet_ledger_entries`

Immutable double-entry-style ledger. Do not update amounts in place; append correction/reversal entries.

```sql
do $$ begin
  create type wallet_ledger_type as enum (
    'TIP_CREDIT',
    'TIP_PENDING',
    'CLEARANCE_RELEASE',
    'WITHDRAWAL_REQUEST',
    'WITHDRAWAL_SUCCESS',
    'WITHDRAWAL_FAILED_REVERSAL',
    'PLATFORM_FEE',
    'PROVIDER_FEE',
    'ADJUSTMENT',
    'DISPUTE_HOLD',
    'DISPUTE_REVERSAL'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type wallet_ledger_status as enum (
    'PENDING',
    'CLEARED',
    'PROCESSING',
    'SUCCESS',
    'FAILED',
    'CANCELLED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.wallet_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete restrict,
  creator_id uuid not null references public.creators(id) on delete restrict,
  type wallet_ledger_type not null,
  status wallet_ledger_status not null,
  currency text not null default 'KES',
  gross_amount numeric(12,2) not null default 0 check (gross_amount >= 0),
  fee_amount numeric(12,2) not null default 0 check (fee_amount >= 0),
  provider_fee_amount numeric(12,2) not null default 0 check (provider_fee_amount >= 0),
  net_amount numeric(12,2) not null default 0 check (net_amount >= 0),
  external_reference text,
  idempotency_key text not null unique,
  source_transaction_id uuid references public.transactions(id) on delete set null,
  withdrawal_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  release_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_wallet_created_idx
  on public.wallet_ledger_entries(wallet_id, created_at desc);
create index if not exists wallet_ledger_source_tx_idx
  on public.wallet_ledger_entries(source_transaction_id);
```

Ledger rules:

- `idempotency_key` is mandatory and unique. It prevents duplicate credits/reversals from webhook retries.
- `TIP_CREDIT` should be created exactly once per successful tip transaction.
- Withdrawal-related entries should reference the same `withdrawal_id`.
- `metadata` can store Daraja IDs, callback payload hashes, reason codes, and audit detail.

### 4.3 `withdrawals`

Tracks payout intent and Daraja B2C state.

```sql
do $$ begin
  create type withdrawal_status as enum (
    'PENDING',
    'PROCESSING',
    'SUCCESS',
    'FAILED',
    'REVERSED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete restrict,
  creator_id uuid not null references public.creators(id) on delete restrict,
  currency text not null default 'KES',
  gross_amount numeric(12,2) not null check (gross_amount > 0),
  fee_amount numeric(12,2) not null check (fee_amount >= 0),
  provider_fee_amount numeric(12,2) not null default 0 check (provider_fee_amount >= 0),
  net_amount numeric(12,2) not null check (net_amount >= 0),
  payout_phone text not null check (payout_phone ~ '^254[17][0-9]{8}$'),
  status withdrawal_status not null default 'PENDING',
  originator_conversation_id text not null unique,
  conversation_id text unique,
  daraja_transaction_id text unique,
  result_code integer,
  result_desc text,
  failure_reason text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  raw_result jsonb
);

create index if not exists withdrawals_creator_requested_idx
  on public.withdrawals(creator_id, requested_at desc);
```

Notes:

- `originator_conversation_id` is the idempotency/correlation key you generate before calling B2C.
- `conversation_id` and `daraja_transaction_id` are populated from Daraja callbacks.
- Keep raw callback payloads for audit/debug, but redact sensitive fields before logging.

### 4.4 Relationship To Existing `transactions`

Keep `public.transactions` as the **tip collection record**. It already has the fields needed for STK correlation and supporter-facing history.

Recommended additions/evolutions:

- Add `wallet_credited_at timestamptz` or rely on a unique ledger entry with `source_transaction_id`.
- Add `settled_amount` if tips can ever differ from requested amount; today amount is validated.
- Keep `creator_stats` for compatibility, but long-term dashboard earnings should read from wallet/ledger, not raw tip sums.

## 5. End-to-End Flow

### Step A: Tip Collection (Existing Daraja STK Push)

This repo already implements tip collection:

1. Client calls `POST /api/tips/initiate`.
2. Server validates input, resolves creator/tier, creates `transactions` row as `PENDING`.
3. For live M-Pesa, server calls Daraja STK Push via `src/lib/mpesa.ts`.
4. Daraja calls back to `POST /api/tips/callback`; server verifies HMAC signature and processes result through `src/lib/payment-callback.ts`.
5. Client polls `POST /api/tips/status`; server can reconcile with STK Query.

Wallet credit extension:

1. When a tip becomes `SUCCESS`, create a `TIP_CREDIT` ledger entry with `idempotency_key = tip_credit:<transaction.id>`.
2. In the same DB transaction, lock the creator wallet row and increment `available_balance` by tip gross amount.
3. For M-Pesa STK tips, default to immediate available credit unless you introduce a risk hold. If a hold is needed, credit `pending_balance` and set `release_at`.
4. Never credit wallet from client polling alone; credit only from a server-side confirmed success path (callback or verified STK query reconciliation) inside an idempotent DB transaction.

### Step B: Creator Payout Onboarding

Creators need a verified withdrawal destination before B2C payout.

1. Creator enters payout M-Pesa number in dashboard settings.
2. Server normalizes/validates MSISDN (`2547...` / `2541...`).
3. Optionally verify ownership by sending a small confirmation flow or requiring an authenticated creator session and recent OTP; at minimum require dashboard token/auth and explicit confirmation.
4. Store payout details on `wallets.payout_phone` and `payout_name`.
5. Do not store Daraja initiator credentials per creator. B2C uses platform initiator credentials.

Suggested API:

- `POST /api/creators/[username]/payout-destination`
- Auth: same private creator auth as earnings/dashboard, ideally stronger than a shared token before production.

### Step C: Instant Withdrawal (Daraja B2C)

When a creator requests withdrawal:

1. **Validate request**
   - Authenticated creator only.
   - `gross_amount >= MIN_WITHDRAWAL` (example: KES 100 or 500; pick based on B2C cost).
   - `payout_phone` configured and verified.
   - Optional rate limit: e.g. 3 withdrawals/hour/creator.

2. **Compute amounts**
   ```ts
   const feeAmount = roundMoney(grossAmount * 0.05);
   const providerFeeAmount = 0; // or configured estimate/actual if absorbed
   const netAmount = grossAmount - feeAmount - providerFeeAmount;
   if (netAmount <= 0) throw new Error("Withdrawal amount too small after fees");
   ```

3. **Atomic DB reservation**
   - Start DB transaction.
   - `SELECT ... FOR UPDATE` the `wallets` row.
   - Check `available_balance >= gross_amount`.
   - Deduct `gross_amount` from `available_balance`.
   - Add `gross_amount` to `reserved_balance`.
   - Insert `withdrawals` row with `status='PROCESSING'`, generated `originator_conversation_id`.
   - Insert ledger entries:
     - `WITHDRAWAL_REQUEST` (gross debit)
     - `PLATFORM_FEE` (fee recognized)
     - optional `PROVIDER_FEE`
   - Commit.

4. **Call Daraja B2C**
   - Use platform B2C credentials from env.
   - Send `OriginatorConversationID = withdrawal.originator_conversation_id`.
   - Set `ResultURL` and `QueueTimeOutURL` to server endpoints, e.g. `/api/withdrawals/b2c/result` and `/api/withdrawals/b2c/timeout`.
   - If the HTTP call fails before Daraja accepts the request, mark withdrawal failed and reverse reservation in a compensating DB transaction.

5. **Handle B2C callbacks**
   - `ResultURL` success: mark withdrawal `SUCCESS`, move reserved funds out permanently, append `WITHDRAWAL_SUCCESS` ledger marker if desired.
   - `ResultURL` failure or `QueueTimeOutURL`: mark withdrawal `FAILED`, move `reserved_balance` back to `available_balance`, append `WITHDRAWAL_FAILED_REVERSAL`.
   - Callbacks must be idempotent; unique keys can be `withdrawal_result:<originator_conversation_id>:<result_code>`.

### Step D: Reconciliation / Recovery

- If B2C request times out at HTTP layer, query transaction status if available or keep withdrawal in `PROCESSING` until timeout callback/manual reconciliation.
- Add an admin/reconciliation job for withdrawals stuck in `PROCESSING` beyond a threshold.
- Reconcile wallet balance from ledger periodically in audits; ledger is the audit trail, wallet is the fast balance cache.

## 6. Daraja Integration Details

### 6.1 Existing STK Variables

Already present in `.env.example`:

```env
MPESA_BASE_URL=
MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=
MPESA_PASSKEY=
MPESA_CALLBACK_URL=
MPESA_CALLBACK_SECRET=
```

### 6.2 B2C Variables (Target)

```env
# Daraja B2C / payouts
MPESA_B2C_INITIATOR_NAME=
MPESA_B2C_SECURITY_CREDENTIAL=
MPESA_B2C_COMMAND_ID=BusinessPayment
MPESA_B2C_SHORTCODE=
MPESA_B2C_QUEUE_TIMEOUT_URL=https://your-domain.example/api/withdrawals/b2c/timeout
MPESA_B2C_RESULT_URL=https://your-domain.example/api/withdrawals/b2c/result
MIN_WITHDRAWAL_AMOUNT=100
WITHDRAWAL_FEE_PERCENT=5
```

Operational notes:

- `MPESA_B2C_SECURITY_CREDENTIAL` is the encrypted initiator password generated per Daraja environment/certificate. Treat as secret.
- Do not expose B2C credentials to client.
- Use separate initiator/shortcode config from STK if your setup differs.
- Disable any manual approval mode that prevents automated payouts, where applicable.

### 6.3 B2C Request Shape (Illustrative)

Confirm exact fields before implementation.

```json
{
  "OriginatorConversationID": "wd_01J...",
  "InitiatorName": "testapi",
  "SecurityCredential": "<encrypted>",
  "CommandID": "BusinessPayment",
  "Amount": "9500",
  "PartyA": "600000",
  "PartyB": "254712345678",
  "Remarks": "TipJar creator payout",
  "QueueTimeOutURL": "https://example.com/api/withdrawals/b2c/timeout",
  "ResultURL": "https://example.com/api/withdrawals/b2c/result",
  "Occassion": "CreatorWithdrawal"
}
```

Implementation note: Daraja amount fields are usually whole currency units for B2C; confirm accepted format and rounding. The current STK integration sends integer KES amount.

## 7. API Surface (Target)

Existing tip APIs remain:

- `POST /api/tips/initiate`
- `GET|POST /api/tips/status`
- `POST /api/tips/callback`
- `POST /api/tips/demo/complete`

New payout/wallet APIs (private, creator-authenticated only):

- `GET /api/creators/[username]/wallet` - private creator wallet summary (available/pending/reserved balances, currency).
- `POST /api/creators/[username]/payout-destination` - set/verify payout phone.
- `POST /api/creators/[username]/withdrawals` - request withdrawal.
- `GET /api/creators/[username]/withdrawals` - list withdrawal history.
- `POST /api/withdrawals/b2c/result` - Daraja B2C result callback.
- `POST /api/withdrawals/b2c/timeout` - Daraja B2C timeout callback.

Visibility rules:

- **Creator-only**: wallet balances, ledger entries, withdrawal amounts/status/history, payout destination, and aggregate earnings.
- **Supporter/public**: creator profile, gift tiers, supporter wall activity, and tip status for their own submitted tip only; no wallet balance, no creator totals, no receipt/amount exposure beyond what the product explicitly allows for the supporter's own flow.
- Never add wallet/balance fields to `GET /api/creators/[username]` or any public profile payload. Keep private data behind authenticated dashboard/wallet endpoints, same pattern as `CreatorEarnings`.

All private creator endpoints must require strong authentication. The current dashboard token is acceptable for demo/dev but should be replaced with real creator auth before production payouts.

## 8. Codebase Change Map

### Database / Types

- `supabase/schema.sql` - add wallets, ledger, withdrawals, enums, indexes, RLS/revokes.
- `src/lib/types.ts` - add `Wallet`, `WalletLedgerEntry`, `Withdrawal`, request/response types.
- `src/lib/db.ts` - add atomic wallet credit/reserve/release/reversal functions; keep local demo store behavior in parity where practical.

### Daraja / Payments

- `src/lib/mpesa.ts` - keep STK logic; extract shared OAuth/config helpers if useful.
- `src/lib/daraja-b2c.ts` (new) - B2C request, callback parsing, timeout/result handling helpers.
- `src/lib/wallet.ts` (new) - fee calculation, balance invariants, idempotency keys.
- `src/lib/payment-callback.ts` - after confirmed tip success, trigger idempotent wallet credit.

### Routes / UI

- `src/app/api/withdrawals/b2c/result/route.ts` (new)
- `src/app/api/withdrawals/b2c/timeout/route.ts` (new)
- `src/app/api/creators/[username]/withdrawals/route.ts` (new)
- `src/components/creator-dashboard.tsx` - show available/pending/reserved balances, fee preview, payout destination, withdrawal history.
- Add admin/ops visibility for failed/stuck withdrawals before enabling at scale.

## 9. Critical Safeguards

1. **Creator-only wallet visibility**
   - Creators can view their own wallet balance, pending/available/reserved amounts, ledger, and withdrawals in authenticated surfaces only.
   - Supporters/tippers must never receive creator wallet balance, total earnings, or withdrawal data in public profile, tip initiation, tip status, callback, or supporter-wall responses.
   - Reuse the existing privacy boundary: public `CreatorProfile`/supporter types exclude amounts; private financial data stays in authenticated dashboard/wallet endpoints.

2. **Idempotency everywhere**
   - Tip credit ledger key: `tip_credit:<transaction_id>`.
   - Withdrawal request key: `withdrawal_request:<originator_conversation_id>`.
   - B2C result key: `b2c_result:<originator_conversation_id>:<result_code_or_hash>`.
   - Enforce unique DB constraints; ignore duplicates safely.

3. **Atomic balance updates**
   - Use `SELECT ... FOR UPDATE` on wallet row for any credit/reserve/release/reversal.
   - Never compute available balance in app memory and write it back without a locked transaction.

4. **No client-trusted money values**
   - Ignore client-supplied fee/net values.
   - Compute fee and net on server from stored config and requested gross amount.

5. **Callback authenticity**
   - STK callbacks already use HMAC signature in this app; keep that pattern.
   - B2C callbacks come from Daraja to public URLs; protect with network/provider controls where possible, strict payload validation, secret path/token if used, and idempotent state transitions. Do not mark payouts successful from unauthenticated client input.

6. **Withdrawal limits and abuse controls**
   - Minimum withdrawal amount.
   - Rate limit withdrawal endpoint.
   - Max daily withdrawal amount / velocity checks.
   - Alert on abnormal withdrawal patterns.

7. **Pending/held funds**
   - M-Pesa STK is lower chargeback risk than cards, but keep `pending_balance` and `release_at` in the model.
   - If disputes/reversals are introduced, freeze/dispute-hold before allowing withdrawal.

8. **Operational readiness**
   - Confirm B2C shortcode balance/liquidity before enabling auto-payouts.
   - Monitor failed callbacks, stuck PROCESSING withdrawals, and ledger/wallet drift.
   - Keep immutable audit logs and raw provider payloads (redacted).

## 10. Migration Plan

1. **Schema migration**
   - Add `wallets`, `wallet_ledger_entries`, `withdrawals`, enums, indexes.
   - Backfill one wallet per existing creator.

2. **Backfill existing successful tips**
   - For each historical `transactions.status='SUCCESS'`, insert `TIP_CREDIT` ledger entry if missing.
   - Recompute wallet `available_balance` from ledger backfill result.

3. **Dual-read dashboard**
   - Temporarily compare old `creator_stats` totals with wallet ledger totals.
   - Switch dashboard earnings to wallet/ledger once matched.

4. **Payout destination onboarding**
   - Add UI and secure auth for payout phone.

5. **Withdrawals behind feature flag**
   - Enable B2C in sandbox first.
   - Use small limits and manual review before full rollout.

## 11. Open Decisions

- **Auth**: replace shared dashboard token with real creator accounts before production withdrawals.
- **Fee policy**: absorb Daraja B2C charge inside 5%, or show it separately.
- **Balance unit**: keep integer KES, or migrate money to integer cents / `numeric(12,2)` consistently across tips and wallets.
- **Hold policy**: immediate availability for M-Pesa tips, or short safety buffer.
- **Payout method scope**: M-Pesa B2C only first; bank payouts later.
- **Demo mode parity**: simulate withdrawals in local/demo store, or disable withdrawal actions unless B2C is configured.
