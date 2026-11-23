import { normalizePhoneNumber } from "@/lib/phone";
import type { PaymentMethod } from "@/lib/types";

export type PaymentMethodInfo = {
  id: PaymentMethod;
  name: string;
  shortName: string;
  icon: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  inputMode: "tel" | "email" | "text";
  waitingTitle: string;
  waitingHint: string;
};

export const PAYMENT_METHODS: PaymentMethodInfo[] = [
  {
    id: "mpesa",
    name: "M-Pesa",
    shortName: "M-Pesa",
    icon: "M",
    description: "Safaricom STK push",
    fieldLabel: "M-Pesa phone number",
    placeholder: "0712345678",
    inputMode: "tel",
    waitingTitle: "Waiting for M-Pesa",
    waitingHint: "Enter your PIN on the prompt sent to your phone.",
  },
  {
    id: "airtel",
    name: "Airtel Money",
    shortName: "Airtel",
    icon: "A",
    description: "Airtel Money prompt",
    fieldLabel: "Airtel Money number",
    placeholder: "0751234567",
    inputMode: "tel",
    waitingTitle: "Waiting for Airtel Money",
    waitingHint: "Approve the payment prompt on your Airtel line.",
  },
  {
    id: "paypal",
    name: "PayPal",
    shortName: "PayPal",
    icon: "P",
    description: "PayPal balance or card",
    fieldLabel: "PayPal email",
    placeholder: "you@example.com",
    inputMode: "email",
    waitingTitle: "Waiting for PayPal",
    waitingHint: "Approve the payment in your PayPal account.",
  },
  {
    id: "binance",
    name: "Binance Pay",
    shortName: "Binance",
    icon: "B",
    description: "Pay with crypto",
    fieldLabel: "Binance Pay ID or email",
    placeholder: "your-pay-id",
    inputMode: "text",
    waitingTitle: "Waiting for Binance Pay",
    waitingHint: "Confirm the transfer in your Binance app.",
  },
];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (
    typeof value === "string" &&
    PAYMENT_METHODS.some((method) => method.id === value)
  );
}

export function getPaymentMethod(id: PaymentMethod): PaymentMethodInfo {
  return PAYMENT_METHODS.find((method) => method.id === id) ?? PAYMENT_METHODS[0];
}

const SAFARICOM_PREFIX = /^254(?:7(?:0|1|2|4|9)|1)\d{7}$/;
const AIRTEL_PREFIX = /^2547[3-8]\d{7}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validatePaymentInput(
  method: PaymentMethod,
  rawPhone: string,
  rawAccount: string,
): { phoneNumber: string; paymentAccount: string | null; error?: string } {
  if (method === "mpesa" || method === "airtel") {
    const phoneNumber = normalizePhoneNumber(rawPhone);
    const valid =
      method === "mpesa"
        ? SAFARICOM_PREFIX.test(phoneNumber)
        : AIRTEL_PREFIX.test(phoneNumber);

    return valid
      ? { phoneNumber, paymentAccount: null }
      : {
          phoneNumber,
          paymentAccount: null,
          error:
            method === "mpesa"
              ? "Enter a valid Safaricom number, e.g. 0712345678."
              : "Enter a valid Airtel number, e.g. 0751234567.",
        };
  }

  const account = rawAccount.trim();
  if (method === "paypal" && !EMAIL.test(account)) {
    return {
      phoneNumber: "",
      paymentAccount: null,
      error: "Enter a valid PayPal email address.",
    };
  }
  if (method === "binance" && account.length < 3) {
    return {
      phoneNumber: "",
      paymentAccount: null,
      error: "Enter your Binance Pay ID or email.",
    };
  }

  return { phoneNumber: "", paymentAccount: account };
}

export function receiptPrefix(method: PaymentMethod): string {
  switch (method) {
    case "airtel":
      return "AR";
    case "paypal":
      return "PP";
    case "binance":
      return "BN";
    default:
      return "MP";
  }
}
