# Getting Safaricom Daraja sandbox access

Follow this once, then fill the values into `.env.local` locally — don't paste secrets into chat or commit them.

## 1. Create a Daraja account

1. Go to <https://developer.safaricom.co.ke/>.
2. Click **Register / Sign up** and use your own email address.
3. Verify your email and log in.

## 2. Create a sandbox app

1. Open **My Apps** → **Create New App**.
2. Name it something like `TipJar Sandbox`.
3. When asked for API products, select **M-Pesa Express** (also labelled *Lipa na M-Pesa Sandbox* / *M-Pesa Sandbox*, depending on the portal version). This matters — without the product attached, token requests work but STK push returns `Invalid API call as no apiproduct match found`.
4. Submit the app.

## 3. Collect the five values you need

| Value | Where to find it |
| --- | --- |
| Consumer Key | Open your app under **My Apps** → credentials section |
| Consumer Secret | Same place as the key |
| Shortcode | **Test Credentials** page, or **APIs → M-Pesa Express → Simulate** (usually `174379` in sandbox) |
| Passkey | Same **Test Credentials** / **M-Pesa Express Simulate** page |
| Callback URL | Your own public HTTPS URL — see next step |

The sandbox shortcode and passkey are shared test values, not secrets. The consumer key/secret **are** secrets.

## 4. Make the callback URL publicly reachable

Safaricom must POST the payment result to a URL it can reach over the internet. `localhost` will not work.

For local testing, use a tunnel:

```bash
npx ngrok http 3000
```

Copy the `https://...` URL it prints. Your callback URL is:

```
https://<your-tunnel-url>/api/tips/callback
```

If your Daraja app also asks for a default callback URL in the portal, paste the same base URL there. Generate a callback secret too:

```bash
openssl rand -hex 24
```

The app adds `tipId` and an HMAC `sig` to the base URL for every STK push and rejects callbacks whose signature does not match. The secret itself is never sent in the URL or stored in the database.

> ngrok is fine for sandbox only. For production, use a stable HTTPS domain.

## 5. Configure the app

```bash
cd /path/to/creator-tipping-app
cp .env.example .env.local
```

Edit `.env.local`:

```bash
MPESA_BASE_URL=https://sandbox.safaricom.co.ke
MPESA_CONSUMER_KEY=<consumer key>
MPESA_CONSUMER_SECRET=<consumer secret>
MPESA_SHORTCODE=174379
MPESA_PASSKEY=<sandbox passkey>
MPESA_CALLBACK_URL=https://<your-tunnel-url>/api/tips/callback
MPESA_CALLBACK_SECRET=<the random secret you generated>

# Also set your private dashboard code while you're here
CREATOR_DASHBOARD_TOKEN=<long random string>
```

Leave the Supabase variables empty to keep using the local file store. Then **restart the dev server** — environment variables are read at startup.

The profile header should now read **M-Pesa live** and the checkout hint will say M-Pesa is live.

## 6. Test a sandbox payment

1. Open <http://localhost:3000>, pick a gift, and use Safaricom's sandbox test number `254708374149` (real Safaricom numbers also work).
2. Click **Support with M-Pesa**. No simulation buttons appear for M-Pesa in live mode.
3. In sandbox, no real phone prompt is sent. Complete the transaction from the **M-Pesa Express Simulate** page in the Daraja portal, or wait for the sandbox to post its callback automatically.
4. The checkout polls `/api/tips/status` every 2 seconds and shows the receipt on success.
5. Confirm the amount appears in `/dashboard/1._coastspoter` and **not** on the public profile.

Sandbox test payments reverse automatically, so no real money moves.

## Troubleshooting

- **`Invalid API call as no apiproduct match found`** — the M-Pesa Express product isn't attached to the app that produced your consumer key. Fix it in **My Apps**.
- **`M-Pesa authentication failed (401)`** — wrong key/secret, or they belong to a different app/environment.
- **Status stays PENDING** — the callback never reached you. Check ngrok is running and `MPESA_CALLBACK_URL` matches the tunnel. The status endpoint also queries Daraja directly every 15 seconds and will settle the tip from that result.
- **Callback returns 403** — the `tipId`/`sig` pair is missing or the signature does not match `MPESA_CALLBACK_SECRET`. The app compares signatures in constant time and rejects mismatches.
- **Wrong password errors** — the passkey must match the shortcode, and timestamps are generated in Africa/Nairobi time (the app already does this).

## Going live later

You'll need a real Pay Bill or Till, business verification, and a production passkey emailed by Safaricom. Then set `MPESA_BASE_URL=https://api.safaricom.co.ke` with the live shortcode/passkey and a stable HTTPS callback URL. Only after that should Airtel/PayPal/Binance adapters be wired to real merchant accounts.
