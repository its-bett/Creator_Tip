import { isMpesaConfigured } from "@/lib/mpesa";
import { receiptPrefix } from "@/lib/payments";
import { processStkCallback } from "@/lib/payment-callback";

/** Local-only helper for simulating a provider payment response. Disabled in live mode. */
export async function POST(request: Request) {
  if (isMpesaConfigured()) {
    return Response.json({ error: "Demo simulation is disabled in live mode." }, { status: 404 });
  }

  const body = (await request.json()) as {
    checkoutRequestId?: string;
    success?: boolean;
    amount?: number;
    paymentMethod?: string;
  };

  const method =
    body.paymentMethod === "airtel" ||
    body.paymentMethod === "paypal" ||
    body.paymentMethod === "binance"
      ? body.paymentMethod
      : "mpesa";
  const cancelled = body.success === false;
  const receipt = cancelled
    ? undefined
    : `${receiptPrefix(method)}${Date.now().toString().slice(-8)}`;

  const outcome = await processStkCallback({
    Body: {
      stkCallback: {
        CheckoutRequestID: body.checkoutRequestId,
        ResultCode: cancelled ? 1032 : 0,
        ResultDesc: cancelled
          ? "Request cancelled by user"
          : "The payment request was processed successfully",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: body.amount },
            { Name: "MpesaReceiptNumber", Value: receipt },
          ],
        },
      },
    },
  });

  if (outcome === "invalid") {
    return Response.json({ error: "Invalid demo callback." }, { status: 400 });
  }

  return Response.json({ success: true });
}
