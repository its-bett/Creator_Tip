import { getTransactionByCheckoutRequestId, updateTransaction } from "@/lib/db";

type CallbackItem = { Name?: string; Value?: unknown };
type StkCallback = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResultCode?: number | string;
  ResultDesc?: string;
  CallbackMetadata?: { Item?: CallbackItem[] };
};

export type CallbackOutcome = "accepted" | "unknown" | "invalid";

function metadataValue(items: CallbackItem[] | undefined, name: string): unknown {
  return items?.find((item) => item.Name === name)?.Value;
}

export async function processStkCallback(body: unknown): Promise<CallbackOutcome> {
  const payload = (body ?? {}) as Record<string, unknown>;
  const wrapper = payload.Body as Record<string, unknown> | undefined;
  const callback = (wrapper?.stkCallback ?? payload.stkCallback ?? payload) as StkCallback;
  const checkoutRequestId = String(callback.CheckoutRequestID ?? "").trim();
  const resultCode = Number(callback.ResultCode ?? 1);
  const resultDesc = String(callback.ResultDesc ?? "Payment update received");

  if (!checkoutRequestId) return "invalid";

  const transaction = await getTransactionByCheckoutRequestId(checkoutRequestId);
  if (!transaction) {
    console.warn(`[mpesa] callback for unknown checkout request: ${checkoutRequestId}`);
    return "unknown";
  }

  // Safaricom retries callbacks; only the first update should change the record.
  if (transaction.status !== "PENDING") return "accepted";

  if (resultCode === 0) {
    const items = callback.CallbackMetadata?.Item;
    const receipt = metadataValue(items, "MpesaReceiptNumber");
    const paidAmount = Number(metadataValue(items, "Amount") ?? transaction.amount);

    if (Number.isFinite(paidAmount) && paidAmount !== transaction.amount) {
      await updateTransaction(transaction.id, {
        status: "FAILED",
        failureReason: `Amount mismatch: expected ${transaction.amount}, received ${paidAmount}.`,
      });
      return "accepted";
    }

    await updateTransaction(transaction.id, {
      status: "SUCCESS",
      mpesaReceiptNumber: receipt ? String(receipt) : null,
      failureReason: null,
    });
    return "accepted";
  }

  await updateTransaction(transaction.id, {
    status: "FAILED",
    failureReason: resultDesc || `M-Pesa declined the payment (${resultCode}).`,
  });
  return "accepted";
}
