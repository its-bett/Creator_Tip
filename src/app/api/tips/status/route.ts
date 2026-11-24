import { safeEqualStrings } from "@/lib/crypto";
import { completePendingTransaction, getTransactionById } from "@/lib/db";
import { reconcileMpesaTransaction } from "@/lib/mpesa-reconcile";
import {
  PAYMENT_TIMEOUT_REASON,
  type Transaction,
} from "@/lib/types";

const TIMEOUT_MINUTES = Number(process.env.PAYMENT_TIMEOUT_MINUTES || 10);

function isExpired(transaction: Transaction): boolean {
  return (
    transaction.status === "PENDING" &&
    (Date.now() - new Date(transaction.createdAt).getTime()) / 60_000 > TIMEOUT_MINUTES
  );
}

/** Only the browser that started the payment knows this token. */
async function findAuthorizedTransaction(
  id: string,
  token: string,
): Promise<Transaction | null> {
  if (!id || !token) return null;
  const transaction = await getTransactionById(id);
  if (!transaction || !safeEqualStrings(transaction.pollingToken, token)) return null;
  return transaction;
}

function toStatusResponse(transaction: Transaction) {
  return {
    id: transaction.id,
    status: transaction.status,
    paymentMethod: transaction.paymentMethod,
    mode: transaction.mode,
    mpesaReceiptNumber: transaction.mpesaReceiptNumber,
    failureReason: transaction.failureReason,
    createdAt: transaction.createdAt,
    expired: isExpired(transaction),
  };
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Read-only status lookup. Use POST to reconcile a pending payment. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const transaction = await findAuthorizedTransaction(
    url.searchParams.get("id")?.trim() ?? "",
    url.searchParams.get("token")?.trim() ?? "",
  );

  if (!transaction) {
    return Response.json({ error: "Payment not found." }, { status: 404 });
  }

  return Response.json(toStatusResponse(transaction), { headers: NO_STORE });
}

/** Reconciles with Daraja, then expires prompts that were never confirmed. */
export async function POST(request: Request) {
  let body: { id?: unknown; token?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; token?: unknown };
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const transaction = await findAuthorizedTransaction(
    typeof body.id === "string" ? body.id.trim() : "",
    typeof body.token === "string" ? body.token.trim() : "",
  );

  if (!transaction) {
    return Response.json({ error: "Payment not found." }, { status: 404 });
  }

  let current = await reconcileMpesaTransaction(transaction);

  if (isExpired(current)) {
    current =
      (await completePendingTransaction(current.id, {
        status: "FAILED",
        failureReason: PAYMENT_TIMEOUT_REASON,
      })) ?? current;
  }

  return Response.json(toStatusResponse(current), { headers: NO_STORE });
}
