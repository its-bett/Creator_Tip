import { verifyMpesaCallback } from "@/lib/mpesa";
import { processStkCallback } from "@/lib/payment-callback";

export async function POST(request: Request) {
  const callback = verifyMpesaCallback(request);
  if (!callback) {
    return Response.json({ ResultCode: 1, ResultDesc: "Unauthorized callback" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ResultCode: 1, ResultDesc: "Invalid JSON" }, { status: 400 });
  }

  const outcome = await processStkCallback(body, {
    transactionId: callback.transactionId,
    source: "mpesa",
  });

  if (outcome === "invalid") {
    return Response.json(
      { ResultCode: 1, ResultDesc: "Missing payment result fields" },
      { status: 400 },
    );
  }

  // Always acknowledge Safaricom callbacks so they are not retried indefinitely.
  return Response.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
