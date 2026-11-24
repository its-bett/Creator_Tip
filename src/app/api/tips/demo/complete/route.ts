import { getTransactionByCheckoutRequestId, getTransactionById } from "@/lib/db";
import { receiptPrefix } from "@/lib/payments";
import { processStkCallback } from "@/lib/payment-callback";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import type { Transaction } from "@/lib/types";

/** Local-only helper for simulating a provider payment response. */
export async function POST(request: Request) {
  const demoAllowed =
    process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_PAYMENTS === "true";
  if (!demoAllowed) {
    return Response.json({ error: "Demo simulation is disabled." }, { status: 404 });
  }

  if (isRateLimited(`demo:${clientKey(request)}`)) {
    return Response.json({ error: "Too many simulation requests." }, { status: 429 });
  }

  let body: {
    transactionId?: unknown;
    checkoutRequestId?: unknown;
    success?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (body.success !== true && body.success !== false) {
    return Response.json({ error: "success must be true or false." }, { status: 400 });
  }

  const transactionId = typeof body.transactionId === "string" ? body.transactionId.trim() : "";
  const checkoutRequestId =
    typeof body.checkoutRequestId === "string" ? body.checkoutRequestId.trim() : "";

  const transaction: Transaction | null = transactionId
    ? await getTransactionById(transactionId)
    : checkoutRequestId
      ? await getTransactionByCheckoutRequestId(checkoutRequestId)
      : null;

  if (!transaction || transaction.mode !== "demo" || transaction.checkoutRequestId !== checkoutRequestId) {
    return Response.json({ error: "Demo payment not found." }, { status: 404 });
  }

  const cancelled = body.success === false;
  const receipt = cancelled
    ? undefined
    : `${receiptPrefix(transaction.paymentMethod)}${Date.now().toString().slice(-8)}`;

  const outcome = await processStkCallback(
    {
      Body: {
        stkCallback: {
          CheckoutRequestID: transaction.checkoutRequestId,
          ResultCode: cancelled ? 1032 : 0,
          ResultDesc: cancelled
            ? "Request cancelled by user"
            : "The payment request was processed successfully",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: transaction.amount },
              { Name: "MpesaReceiptNumber", Value: receipt },
            ],
          },
        },
      },
    },
    { transactionId: transaction.id, source: "demo" },
  );

  if (outcome !== "accepted") {
    return Response.json({ error: "Could not simulate this payment." }, { status: 400 });
  }

  return Response.json({ success: true });
}
