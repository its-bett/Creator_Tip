import { completePendingTransaction } from "@/lib/db";
import { isPlaceholderCheckoutRequestId, queryStkStatus } from "@/lib/mpesa";
import type { Transaction } from "@/lib/types";

const QUERY_INTERVAL_MS = 15_000;
const lastQueryAt = new Map<string, number>();

/**
 * Ask Daraja for the latest STK result when a callback has not arrived.
 * This is a read-only reconciliation against Safaricom; it never initiates a charge.
 */
export async function reconcileMpesaTransaction(
  transaction: Transaction,
): Promise<Transaction> {
  if (
    transaction.mode !== "live" ||
    transaction.paymentMethod !== "mpesa" ||
    transaction.status !== "PENDING" ||
    !transaction.checkoutRequestId ||
    isPlaceholderCheckoutRequestId(transaction.checkoutRequestId)
  ) {
    return transaction;
  }

  const now = Date.now();
  if (now - (lastQueryAt.get(transaction.id) ?? 0) < QUERY_INTERVAL_MS) {
    return transaction;
  }
  lastQueryAt.set(transaction.id, now);

  let result;
  try {
    result = await queryStkStatus(transaction.checkoutRequestId);
  } catch (error) {
    console.warn("[mpesa] STK query failed", {
      transactionId: transaction.id,
      error: error instanceof Error ? error.message : error,
    });
    return transaction;
  }

  const patch =
    result.resultCode === "0"
      ? {
          status: "SUCCESS" as const,
          // STK query confirms payment but does not return the receipt; a late
          // callback can still attach it later.
          mpesaReceiptNumber: transaction.mpesaReceiptNumber,
          failureReason: null,
          merchantRequestId: result.merchantRequestId ?? undefined,
        }
      : result.resultCode
        ? {
            status: "FAILED" as const,
            failureReason:
              result.resultDescription || `M-Pesa declined the payment (${result.resultCode}).`,
            merchantRequestId: result.merchantRequestId ?? undefined,
          }
        : null;

  if (!patch) return transaction;

  const updated = await completePendingTransaction(transaction.id, patch);
  if (!updated) {
    // A callback or another poll won the race; that result is authoritative.
    return transaction;
  }

  console.info("[mpesa] reconciled transaction from STK query", {
    transactionId: transaction.id,
    resultCode: result.resultCode,
  });
  return updated;
}
