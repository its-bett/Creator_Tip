import { timingSafeEqual } from "node:crypto";
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

export function isMpesaConfigured(): boolean {
  return getMpesaConfig() !== null;
}

export function createCheckoutRequestId(prefix = "ws"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
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

/* --------------------------------- callbacks --------------------------------- */

export function isCallbackAuthorized(request: Request): boolean {
  const expected = process.env.MPESA_CALLBACK_SECRET;
  if (!expected) return true;

  const supplied =
    new URL(request.url).searchParams.get("secret") ??
    request.headers.get("x-mpesa-secret") ??
    "";

  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
