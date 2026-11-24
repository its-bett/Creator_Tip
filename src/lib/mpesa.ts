import { createHmacSignature, safeEqualStrings } from "@/lib/crypto";
import { normalizePhoneNumber, isValidPhoneNumber } from "@/lib/phone";

export { normalizePhoneNumber, isValidPhoneNumber };

const DEFAULT_BASE_URL = "https://sandbox.safaricom.co.ke";

export type MpesaConfig = {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
};

export function getMpesaConfig(): MpesaConfig | null {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;

  if (!consumerKey || !consumerSecret || !shortcode || !passkey) return null;

  return {
    baseUrl: (process.env.MPESA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
  };
}

/**
 * Live mode needs Daraja credentials plus a reachable, authenticated callback.
 * A missing callback URL would silently strand paid tips, so require all six
 * values before presenting M-Pesa as live.
 */
export function isMpesaConfigured(): boolean {
  return (
    getMpesaConfig() !== null &&
    Boolean(process.env.MPESA_CALLBACK_URL && process.env.MPESA_CALLBACK_SECRET)
  );
}

export function createCheckoutRequestId(prefix = "local"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Matches local placeholders only; real Daraja IDs also begin with `ws_`. */
export function isPlaceholderCheckoutRequestId(value: string): boolean {
  return /^(?:local_[0-9a-f]{20}|ws_[0-9a-f]{20})$/.test(value);
}

export function createAccountReference(): string {
  return `TIP${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/* ----------------------------------- OAuth ----------------------------------- */

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | null = null;
let tokenRequest: Promise<string> | null = null;

async function requestAccessToken(config: MpesaConfig): Promise<string> {
  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`,
  ).toString("base64");

  const response = await fetch(
    `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`M-Pesa authentication failed (${response.status}).`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: string };
  if (!data.access_token) {
    throw new Error("M-Pesa authentication returned no access token.");
  }

  const lifetimeSeconds = Number(data.expires_in ?? 3599);
  cachedToken = {
    value: data.access_token,
    // Refresh a minute early so we never send an expiring token.
    expiresAt: Date.now() + Math.max(lifetimeSeconds - 60, 30) * 1000,
  };
  return cachedToken.value;
}

export async function getAccessToken(): Promise<string> {
  const config = getMpesaConfig();
  if (!config) throw new Error("M-Pesa is not configured.");

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  if (tokenRequest) return tokenRequest;

  tokenRequest = requestAccessToken(config).finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
}

/* --------------------------------- STK push ---------------------------------- */

export type StkPushArgs = {
  amount: number;
  phoneNumber: string;
  callbackUrl: string;
  accountReference: string;
  transactionDesc: string;
};

export type StkPushResult = {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
};

/** Daraja expects Nairobi local time (EAT), not UTC. */
function darajaTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "00";

  return `${part("year")}${part("month")}${part("day")}${part("hour")}${part("minute")}${part("second")}`;
}

export async function initiateStkPush(args: StkPushArgs): Promise<StkPushResult> {
  const config = getMpesaConfig();
  if (!config) throw new Error("M-Pesa is not configured.");

  const accessToken = await getAccessToken();
  const timestamp = darajaTimestamp();
  const password = Buffer.from(
    `${config.shortcode}${config.passkey}${timestamp}`,
  ).toString("base64");

  const response = await fetch(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: args.amount,
      PartyA: args.phoneNumber,
      PartyB: config.shortcode,
      PhoneNumber: args.phoneNumber,
      CallBackURL: args.callbackUrl,
      AccountReference: args.accountReference,
      TransactionDesc: args.transactionDesc.slice(0, 13),
    }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`M-Pesa STK push failed (${response.status}).`);
  }

  const data = (await response.json()) as {
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    ResponseCode?: string;
    ResponseDescription?: string;
    CustomerMessage?: string;
    errorCode?: string;
    errorDescription?: string;
  };

  if (data.ResponseCode !== "0" || !data.CheckoutRequestID) {
    throw new Error(
      data.errorDescription ||
        data.ResponseDescription ||
        "M-Pesa could not start the payment prompt.",
    );
  }

  return {
    merchantRequestId: String(data.MerchantRequestID ?? ""),
    checkoutRequestId: String(data.CheckoutRequestID),
    responseCode: String(data.ResponseCode),
    responseDescription: String(data.ResponseDescription ?? "Accepted"),
    customerMessage: String(data.CustomerMessage ?? "Check your phone to complete the payment."),
  };
}

/* ------------------------------- STK query ----------------------------------- */

export type StkQueryResult = {
  resultCode: string;
  resultDescription: string;
  merchantRequestId: string | null;
  checkoutRequestId: string;
};

/** Query Daraja when a callback is missing or slow. Never sends money. */
export async function queryStkStatus(checkoutRequestId: string): Promise<StkQueryResult> {
  const config = getMpesaConfig();
  if (!config) throw new Error("M-Pesa is not configured.");
  if (!checkoutRequestId || isPlaceholderCheckoutRequestId(checkoutRequestId)) {
    throw new Error("No Daraja checkout request to query yet.");
  }

  const accessToken = await getAccessToken();
  const timestamp = darajaTimestamp();
  const password = Buffer.from(
    `${config.shortcode}${config.passkey}${timestamp}`,
  ).toString("base64");

  const response = await fetch(`${config.baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`M-Pesa STK query failed (${response.status}).`);
  }

  const data = (await response.json()) as {
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    ResultCode?: string | number;
    ResultDesc?: string;
    ResponseCode?: string;
    ResponseDescription?: string;
    errorCode?: string;
    errorDescription?: string;
  };

  // A rejected query uses ResponseCode/errorDescription instead of ResultCode.
  if (data.ResultCode === undefined && data.ResponseCode !== "0") {
    throw new Error(
      data.errorDescription || data.ResponseDescription || "M-Pesa could not check the payment.",
    );
  }

  return {
    resultCode: String(data.ResultCode ?? ""),
    resultDescription: String(data.ResultDesc ?? data.ResponseDescription ?? "Payment update received"),
    merchantRequestId: data.MerchantRequestID ? String(data.MerchantRequestID) : null,
    checkoutRequestId: String(data.CheckoutRequestID ?? checkoutRequestId),
  };
}

/* --------------------------------- callbacks --------------------------------- */

export function signCallbackTransaction(transactionId: string): string {
  const secret = process.env.MPESA_CALLBACK_SECRET;
  if (!secret) throw new Error("MPESA_CALLBACK_SECRET is not configured.");
  return createHmacSignature(transactionId, secret);
}

/**
 * Each STK push gets its own signed callback URL. The transaction ID lets us
 * match the callback even if the Daraja checkout ID update fails, and the HMAC
 * stops anyone from forging a result for another transaction.
 */
export function buildMpesaCallbackUrl(callbackBase: string, transactionId: string): string {
  const url = new URL(callbackBase);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("MPESA_CALLBACK_URL must use HTTPS in production.");
  }
  url.searchParams.set("tipId", transactionId);
  url.searchParams.set("sig", signCallbackTransaction(transactionId));
  return url.toString();
}

/** Returns the transaction ID only when the callback URL signature is valid. */
export function verifyMpesaCallback(request: Request): { transactionId: string | null } | null {
  const secret = process.env.MPESA_CALLBACK_SECRET;
  if (!secret) return null;

  const url = new URL(request.url);
  const transactionId = url.searchParams.get("tipId");
  const signature = url.searchParams.get("sig");

  if (transactionId && signature) {
    const expected = createHmacSignature(transactionId, secret);
    return safeEqualStrings(expected, signature) ? { transactionId } : null;
  }

  // Accept callbacks already in flight from the previous static-secret format.
  const legacySecret =
    url.searchParams.get("secret") ?? request.headers.get("x-mpesa-secret") ?? "";
  return safeEqualStrings(secret, legacySecret) ? { transactionId: null } : null;
}
