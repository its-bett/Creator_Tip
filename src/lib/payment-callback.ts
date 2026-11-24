import {
  attachMpesaReceipt,
  completePendingTransaction,
  completeTimedOutTransaction,
  getTransactionById,
  getTransactionByCheckoutRequestId,
} from "@/lib/db";
import { isPlaceholderCheckoutRequestId } from "@/lib/mpesa";
import type { Transaction, TransactionPatch } from "@/lib/types";
import { cleanText } from "@/lib/validation";

type CallbackItem = { Name?: string; Value?: unknown };
type StkCallback = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResultCode?: number | string;
  ResultDesc?: string;
  CallbackMetadata?: { Item?: CallbackItem[] };
};

export type CallbackOutcome = "accepted" | "unknown" | "invalid";
export type CallbackSource = "mpesa" | "demo";

type ProcessOptions = {
  /** Correlation ID from the signed callback URL, when available. */
  transactionId?: string | null;
  source?: CallbackSource;
};

function metadataValue(items: CallbackItem[] | undefined, name: string): unknown {
  return items?.find((item) => item.Name === name)?.Value;
}

function parseResultCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export async function processStkCallback(
  body: unknown,
  options: ProcessOptions = {},
): Promise<CallbackOutcome> {
  const payload = (body ?? {}) as Record<string, unknown>;
  const wrapper = payload.Body as Record<string, unknown> | undefined;
  const callback = (wrapper?.stkCallback ?? payload.stkCallback ?? payload) as StkCallback;

  const checkoutRequestId = cleanText(callback.CheckoutRequestID, 120);
  const resultCode = parseResultCode(callback.ResultCode);
  const resultDesc = cleanText(callback.ResultDesc ?? "", 240);

  if (!checkoutRequestId || resultCode === null) return "invalid";

  const transaction: Transaction | null = options.transactionId
    ? await getTransactionById(options.transactionId)
    : await getTransactionByCheckoutRequestId(checkoutRequestId);

  if (!transaction) {
    console.warn("[mpesa] callback for unknown transaction", {
      checkoutRequestId,
      transactionId: options.transactionId ?? null,
    });
    return "unknown";
  }

  const source = options.source ?? "mpesa";
  if (source === "demo") {
    if (transaction.mode !== "demo") {
      console.warn("[mpesa] rejected demo callback for live transaction", transaction.id);
      return "accepted";
    }
  } else if (transaction.mode !== "live" || transaction.paymentMethod !== "mpesa") {
    console.warn("[mpesa] rejected live callback for non-live transaction", transaction.id);
    return "accepted";
  }

  if (
    !isPlaceholderCheckoutRequestId(transaction.checkoutRequestId) &&
    transaction.checkoutRequestId !== checkoutRequestId
  ) {
    console.warn("[mpesa] callback checkout ID mismatch", {
      transactionId: transaction.id,
      expected: transaction.checkoutRequestId,
      received: checkoutRequestId,
    });
    return "accepted";
  }

  const merchantRequestId = cleanText(callback.MerchantRequestID ?? "", 120) || null;
  if (
    merchantRequestId &&
    transaction.merchantRequestId &&
    merchantRequestId !== transaction.merchantRequestId
  ) {
    console.warn("[mpesa] callback merchant request ID mismatch", transaction.id);
    return "accepted";
  }

  const correlationPatch: TransactionPatch = {
    merchantRequestId: merchantRequestId ?? transaction.merchantRequestId ?? undefined,
  };
  // A callback can fill in the real Daraja ID if the initiate response was lost,
  // but it must never replace an ID we already confirmed.
  if (isPlaceholderCheckoutRequestId(transaction.checkoutRequestId)) {
    correlationPatch.checkoutRequestId = checkoutRequestId;
  }

  if (resultCode === 0) {
    const items = callback.CallbackMetadata?.Item;
    const paidAmount = Number(metadataValue(items, "Amount"));
    const receipt = cleanText(metadataValue(items, "MpesaReceiptNumber") ?? "", 120);

    if (
      !Number.isFinite(paidAmount) ||
      paidAmount <= 0 ||
      paidAmount !== transaction.amount ||
      !receipt
    ) {
      const failureReason =
        paidAmount !== transaction.amount
          ? `Payment amount did not match the gift. Expected ${transaction.amount}, received ${
              Number.isFinite(paidAmount) ? paidAmount : "nothing"
            }.`
          : "M-Pesa confirmation was missing valid payment details.";

      await completePendingTransaction(transaction.id, {
        ...correlationPatch,
        status: "FAILED",
        failureReason,
      });
      return "accepted";
    }

    const successPatch: TransactionPatch = {
      ...correlationPatch,
      status: "SUCCESS",
      mpesaReceiptNumber: receipt,
      failureReason: null,
    };

    const updated = await completePendingTransaction(transaction.id, successPatch);
    if (updated) return "accepted";

    // A late success can still recover a tip we expired after the prompt timeout.
    const recovered = await completeTimedOutTransaction(transaction.id, successPatch);
    if (recovered) return "accepted";

    if (transaction.status === "SUCCESS") {
      await attachMpesaReceipt(transaction.id, receipt);
    }
    return "accepted";
  }

  await completePendingTransaction(transaction.id, {
    ...correlationPatch,
    status: "FAILED",
    failureReason: resultDesc || `M-Pesa declined the payment (${resultCode}).`,
  });
  return "accepted";
}
