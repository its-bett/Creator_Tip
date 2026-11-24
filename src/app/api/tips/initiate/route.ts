import {
  createTransaction,
  getCreatorById,
  getTierById,
  updateTransaction,
} from "@/lib/db";
import { createOpaqueToken } from "@/lib/crypto";
import {
  buildMpesaCallbackUrl,
  createAccountReference,
  createCheckoutRequestId,
  initiateStkPush,
  isMpesaConfigured,
} from "@/lib/mpesa";
import {
  getPaymentMethod,
  isPaymentMethod,
  validatePaymentInput,
} from "@/lib/payments";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { cleanText, parseAmount } from "@/lib/validation";

const DEMO_MESSAGES = {
  mpesa: "Demo M-Pesa: no real payment will be requested.",
  airtel: "Demo Airtel Money: approve the simulated prompt to continue.",
  paypal: "Demo PayPal: no charge will be made to your account.",
  binance: "Demo Binance Pay: no crypto will be transferred.",
};

export async function POST(request: Request) {
  try {
    if (isRateLimited(clientKey(request))) {
      return Response.json(
        { error: "Too many payment requests. Please wait a minute and try again." },
        { status: 429 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const creatorId = cleanText(body.creatorId, 60);
    const tierId = cleanText(body.tierId, 60);
    const supporterName = cleanText(body.supporterName, 60) || "Anonymous";
    const supporterMessage = cleanText(body.supporterMessage, 240);
    const paymentMethod = isPaymentMethod(body.paymentMethod) ? body.paymentMethod : "mpesa";

    const paymentInput = validatePaymentInput(
      paymentMethod,
      cleanText(body.phoneNumber, 20),
      cleanText(body.paymentAccount, 120),
    );

    if (!creatorId) {
      return Response.json({ error: "A creator is required." }, { status: 400 });
    }

    if (paymentInput.error) {
      return Response.json({ error: paymentInput.error }, { status: 400 });
    }

    const creator = await getCreatorById(creatorId);
    if (!creator) {
      return Response.json({ error: "Creator not found." }, { status: 404 });
    }

    let amount = parseAmount(body.amount);
    let giftTitle = cleanText(body.giftTitle, 40) || "Support";

    if (tierId) {
      const tier = await getTierById(tierId);
      if (!tier || tier.creatorId !== creator.id || tier.amount <= 0) {
        return Response.json({ error: "That gift is not available." }, { status: 400 });
      }
      // Always trust the stored price, never an amount supplied by the browser.
      amount = tier.amount;
      giftTitle = tier.title;
    }

    if (amount === null) {
      return Response.json(
        { error: "Choose an amount between KES 50 and KES 100,000." },
        { status: 400 },
      );
    }

    const useLiveMpesa = paymentMethod === "mpesa" && isMpesaConfigured();
    const accountReference = useLiveMpesa ? createAccountReference() : null;
    const pollingToken = createOpaqueToken();
    const transaction = await createTransaction({
      creatorId: creator.id,
      supporterName,
      supporterMessage: supporterMessage || null,
      giftTitle,
      amount,
      phoneNumber: paymentInput.phoneNumber,
      paymentAccount: paymentInput.paymentAccount,
      paymentMethod,
      mode: useLiveMpesa ? "live" : "demo",
      checkoutRequestId: createCheckoutRequestId(),
      accountReference,
      pollingToken,
    });

    let customerMessage = DEMO_MESSAGES[paymentMethod];

    if (useLiveMpesa) {
      const callbackBase = process.env.MPESA_CALLBACK_URL as string;
      const callbackUrl = buildMpesaCallbackUrl(callbackBase, transaction.id);

      try {
        const result = await initiateStkPush({
          amount,
          phoneNumber: paymentInput.phoneNumber,
          callbackUrl,
          accountReference: accountReference as string,
          transactionDesc: `Support ${creator.displayName}`,
        });

        customerMessage = result.customerMessage;

        // The signed callback carries our transaction ID, so a failed mapping
        // update cannot lose the payment. It only disables STK-query fallback.
        try {
          await updateTransaction(transaction.id, {
            checkoutRequestId: result.checkoutRequestId,
            merchantRequestId: result.merchantRequestId || undefined,
          });
        } catch (error) {
          console.error("[mpesa] could not store Daraja checkout mapping", {
            transactionId: transaction.id,
            error: error instanceof Error ? error.message : error,
          });
        }

        return Response.json({
          success: true,
          mode: "live",
          paymentMethod,
          transactionId: transaction.id,
          pollingToken,
          checkoutRequestId: result.checkoutRequestId,
          customerMessage,
        });
      } catch (error) {
        await updateTransaction(transaction.id, {
          status: "FAILED",
          failureReason:
            error instanceof Error ? error.message : "Could not start the STK prompt.",
        });

        return Response.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "M-Pesa could not start the payment. Please try again.",
          },
          { status: 502 },
        );
      }
    }

    return Response.json({
      success: true,
      mode: "demo",
      paymentMethod,
      methodName: getPaymentMethod(paymentMethod).name,
      transactionId: transaction.id,
      pollingToken,
      checkoutRequestId: transaction.checkoutRequestId,
      customerMessage,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error && process.env.NODE_ENV !== "production"
            ? error.message
            : "Could not start the payment. Please try again.",
      },
      { status: 500 },
    );
  }
}
