import { getTransactionByCheckoutRequestId, getTransactionById, updateTransaction } from "@/lib/db";

const TIMEOUT_MINUTES = Number(process.env.PAYMENT_TIMEOUT_MINUTES || 10);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  const checkoutRequestId = url.searchParams.get("checkoutRequestId")?.trim();

  if (!id && !checkoutRequestId) {
    return Response.json(
      { error: "Provide an id or checkoutRequestId." },
      { status: 400 },
    );
  }

  const transaction = id
    ? await getTransactionById(id)
    : await getTransactionByCheckoutRequestId(checkoutRequestId!);

  if (!transaction) {
    return Response.json({ error: "Payment not found." }, { status: 404 });
  }

  // If no callback arrives (wrong PIN, network loss, closed prompt), stop polling.
  if (transaction.status === "PENDING") {
    const ageMinutes = (Date.now() - new Date(transaction.createdAt).getTime()) / 60_000;
    if (ageMinutes > TIMEOUT_MINUTES) {
      await updateTransaction(transaction.id, {
        status: "FAILED",
        failureReason: "The payment prompt expired. Please try again.",
      });
      transaction.status = "FAILED";
      transaction.failureReason = "The payment prompt expired. Please try again.";
    }
  }

  return Response.json(
    {
      id: transaction.id,
      status: transaction.status,
      amount: transaction.amount,
      giftTitle: transaction.giftTitle,
      supporterName: transaction.supporterName,
      paymentMethod: transaction.paymentMethod,
      mpesaReceiptNumber: transaction.mpesaReceiptNumber,
      failureReason: transaction.failureReason,
      mode: transaction.mode,
      createdAt: transaction.createdAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
