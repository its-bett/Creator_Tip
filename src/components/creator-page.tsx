"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getPaymentMethod, PAYMENT_METHODS, validatePaymentInput } from "@/lib/payments";
import type { CreatorProfile, GiftTier, PaymentMethod } from "@/lib/types";

type Phase = "idle" | "initiating" | "waiting" | "success" | "failed";

const CUSTOM_TIER: GiftTier = {
  id: "custom",
  creatorId: "",
  title: "Custom gift",
  amount: 0,
  icon: "🎁",
  isPopular: false,
  sortOrder: 99,
};

function formatKes(amount: number): string {
  return new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(amount);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-KE").format(value);
}

function relativeTime(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export default function CreatorPage({ profile }: { profile: CreatorProfile }) {
  const router = useRouter();
  const { creator, tiers, supporters, stats, mpesaLive } = profile;
  const allTiers = [...tiers, CUSTOM_TIER];
  const defaultTier = tiers.find((tier) => tier.isPopular) ?? tiers[0] ?? CUSTOM_TIER;

  const [selectedTierId, setSelectedTierId] = useState(defaultTier.id);
  const [customAmount, setCustomAmount] = useState("500");
  const [modalOpen, setModalOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("mpesa");
  const [supporterName, setSupporterName] = useState("");
  const [message, setMessage] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [paymentAccount, setPaymentAccount] = useState("");
  const [error, setError] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  const [transaction, setTransaction] = useState<{
    id: string;
    checkoutRequestId: string;
    paymentMethod: PaymentMethod;
  } | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const methodInfo = getPaymentMethod(transaction?.paymentMethod ?? paymentMethod);
  const selectedTier = allTiers.find((tier) => tier.id === selectedTierId) ?? CUSTOM_TIER;
  const amount =
    selectedTier.id === "custom" ? Number(customAmount || 0) : selectedTier.amount;
  const isCustom = selectedTier.id === "custom";

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phase !== "initiating" && phase !== "waiting") {
        setModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen, phase]);

  useEffect(() => {
    if (phase !== "waiting" || !transaction) return;

    let cancelled = false;
    const controller = new AbortController();

    const checkStatus = async () => {
      try {
        const response = await fetch(
          `/api/tips/status?checkoutRequestId=${encodeURIComponent(transaction.checkoutRequestId)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          status: string;
          mpesaReceiptNumber: string | null;
          failureReason: string | null;
        };
        if (cancelled) return;

        if (data.status === "SUCCESS") {
          setReceipt(data.mpesaReceiptNumber);
          setPhase("success");
          router.refresh();
        } else if (data.status === "FAILED") {
          setError(data.failureReason || "The payment was not completed.");
          setPhase("failed");
        }
      } catch {
        // Transient errors are ignored; the next poll will retry.
      }
    };

    void checkStatus();
    const interval = window.setInterval(checkStatus, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      controller.abort();
    };
  }, [phase, transaction, router]);

  const openCheckout = () => {
    setError("");
    setReceipt(null);
    setTransaction(null);
    setPhase("idle");
    setModalOpen(true);
  };

  const closeCheckout = () => {
    if (phase === "initiating" || phase === "waiting") return;
    setModalOpen(false);
  };

  const initiate = async () => {
    setError("");

    if (!Number.isFinite(amount) || amount < 50) {
      setError("Choose an amount of at least KES 50.");
      return;
    }
    const paymentInput = validatePaymentInput(paymentMethod, phoneNumber, paymentAccount);
    if (paymentInput.error) {
      setError(paymentInput.error);
      return;
    }

    setPhase("initiating");

    try {
      const response = await fetch("/api/tips/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorId: creator.id,
          tierId: isCustom ? undefined : selectedTier.id,
          giftTitle: isCustom ? "Custom gift" : selectedTier.title,
          amount,
          paymentMethod,
          supporterName: supporterName.trim() || "Anonymous",
          supporterMessage: message.trim(),
          phoneNumber: paymentInput.phoneNumber,
          paymentAccount: paymentInput.paymentAccount,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        transactionId?: string;
        checkoutRequestId?: string;
        customerMessage?: string;
        paymentMethod?: PaymentMethod;
      };

      if (!response.ok || !data.transactionId || !data.checkoutRequestId) {
        throw new Error(data.error || "Could not start the payment.");
      }

      setTransaction({
        id: data.transactionId,
        checkoutRequestId: data.checkoutRequestId,
        paymentMethod: data.paymentMethod ?? paymentMethod,
      });
      setCustomerMessage(
        data.customerMessage || "Check your phone for the M-Pesa prompt.",
      );
      setPhase("waiting");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
      setPhase("failed");
    }
  };

  const simulate = async (success: boolean) => {
    if (!transaction) return;
    try {
      await fetch("/api/tips/demo/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutRequestId: transaction.checkoutRequestId,
          amount,
          success,
          paymentMethod: transaction.paymentMethod,
        }),
      });
    } catch {
      setError("Could not simulate the payment. Please try again.");
    }
  };

  const reset = () => {
    setPhase("idle");
    setError("");
    setReceipt(null);
    setTransaction(null);
    setCustomerMessage("");
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_15%_-10%,#fef3c7_0%,transparent_38%),radial-gradient(circle_at_90%_0%,#dcfce7_0%,transparent_35%),#faf7f2] px-4 py-6 text-slate-900 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-600 text-white">
              T
            </span>
            <span>TipJar</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600">
              {mpesaLive ? "M-Pesa live" : "Sandbox / demo"}
            </span>
            <Link
              href={`/dashboard/${creator.username}`}
              className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-700"
            >
              Creator dashboard
            </Link>
          </div>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-amber-100 bg-white/90 shadow-[0_25px_80px_rgba(120,83,25,0.12)] backdrop-blur">
          {/* Creator header */}
          <section className="relative overflow-hidden bg-[linear-gradient(125deg,#064e3b_0%,#065f46_45%,#b45309_140%)] px-5 py-8 text-white sm:px-9 sm:py-10">
            <div className="absolute -right-10 -top-16 h-56 w-56 rounded-full bg-amber-400/20 blur-2xl" />
            <div className="absolute -bottom-20 left-1/3 h-52 w-52 rounded-full bg-emerald-300/10 blur-2xl" />

            <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center">
              <div
                className="grid h-24 w-24 shrink-0 place-items-center rounded-[28px] border-4 border-white/25 bg-white/15 text-5xl shadow-xl backdrop-blur"
                style={
                  creator.avatarUrl
                    ? { backgroundImage: `url(${creator.avatarUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
                    : undefined
                }
                aria-hidden="true"
              >
                {!creator.avatarUrl && creator.avatarEmoji}
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200">
                  Support a creator
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
                  {creator.displayName}
                </h1>
                <p className="mt-1 text-sm text-emerald-100">@{creator.username}</p>
                <p className="mt-3 max-w-xl text-sm leading-6 text-white/80 sm:text-base">
                  {creator.headline}
                </p>
                <p className="mt-1 text-xs text-white/55">{creator.location}</p>
              </div>
            </div>

            <div className="relative mt-7 grid grid-cols-2 gap-2 sm:max-w-xl sm:grid-cols-4">
              {[
                { label: "Posts", value: formatCount(stats.posts) },
                { label: "Followers", value: formatCount(stats.followers) },
                { label: "Following", value: formatCount(stats.following) },
                { label: "Supporters", value: formatCount(stats.supporters) },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl bg-white/10 px-3 py-3 backdrop-blur">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-100/80">
                    {item.label}
                  </p>
                  <p className="mt-1 text-sm font-bold sm:text-base">{item.value}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-8 px-5 py-8 sm:px-9 lg:grid-cols-[1.15fr_0.85fr]">
            {/* Gift grid + about */}
            <div>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">
                    Pick a gift
                  </p>
                  <h2 className="mt-1 text-2xl font-black tracking-tight">
                    Send a little something
                  </h2>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {allTiers.map((tier) => {
                  const selected = tier.id === selectedTierId;
                  return (
                    <button
                      key={tier.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedTierId(tier.id);
                        setError("");
                      }}
                      className={`relative rounded-2xl border p-4 text-left transition ${
                        selected
                          ? "border-emerald-500 bg-emerald-50 shadow-[0_12px_30px_rgba(5,150,105,0.16)]"
                          : "border-slate-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/40"
                      }`}
                    >
                      {tier.isPopular && (
                        <span className="absolute right-3 top-3 rounded-full bg-amber-500 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-white">
                          Popular
                        </span>
                      )}
                      <span className="text-3xl" aria-hidden="true">{tier.icon}</span>
                      <span className="mt-3 block font-bold text-slate-900">{tier.title}</span>
                      <span className="mt-0.5 block text-sm text-slate-500">
                        {tier.id === "custom" ? "You choose the amount" : `KES ${formatKes(tier.amount)}`}
                      </span>
                    </button>
                  );
                })}
              </div>

              {isCustom && (
                <label className="mt-4 block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                    Your amount (KES)
                  </span>
                  <input
                    type="number"
                    min={50}
                    max={100000}
                    step={50}
                    value={customAmount}
                    onChange={(event) => setCustomAmount(event.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                  />
                </label>
              )}

              <div className="mt-8 rounded-2xl border border-dashed border-amber-200 bg-amber-50/50 p-5">
                <h3 className="font-bold text-slate-900">Why support?</h3>
                <p className="mt-1.5 text-sm leading-6 text-slate-600">{creator.bio}</p>
              </div>

              <div className="mt-8">
                <h3 className="text-lg font-bold">Recent supporters</h3>
                {supporters.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">
                    Be the first to send a gift.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {supporters.map((supporter) => (
                      <li
                        key={supporter.id}
                        className="rounded-2xl border border-slate-100 bg-white px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-bold text-slate-900">
                            {supporter.supporterName}
                          </p>
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                            {getPaymentMethod(supporter.paymentMethod).shortName}
                          </span>
                        </div>
                        {supporter.supporterMessage && (
                          <p className="mt-1 text-sm text-slate-600">
                            “{supporter.supporterMessage}”
                          </p>
                        )}
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">
                          {supporter.giftTitle} · {relativeTime(supporter.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Sticky checkout summary */}
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="rounded-[26px] bg-slate-950 p-6 text-white shadow-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">
                  Your support
                </p>
                <h2 className="mt-1 text-2xl font-black">Make their day</h2>

                <fieldset className="mt-5">
                  <legend className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                    Payment method
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {PAYMENT_METHODS.map((method) => {
                      const selected = method.id === paymentMethod;
                      return (
                        <button
                          key={method.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            setPaymentMethod(method.id);
                            setError("");
                          }}
                          className={`rounded-xl border p-2.5 text-left transition ${
                            selected
                              ? "border-emerald-400 bg-emerald-400/10"
                              : "border-white/10 bg-white/5 hover:border-white/25"
                          }`}
                        >
                          <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-xs font-black text-slate-900">
                            {method.icon}
                          </span>
                          <span className="mt-1.5 block text-xs font-bold text-white">
                            {method.shortName}
                          </span>
                          <span className="mt-0.5 block text-[10px] leading-3 text-slate-400">
                            {method.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="mt-5 space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm">
                  <div className="flex justify-between gap-3 text-slate-300">
                    <span>{selectedTier.title}</span>
                    <span>KES {formatKes(Number.isFinite(amount) ? amount : 0)}</span>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-white/10 pt-3 text-lg font-black text-white">
                    <span>Total</span>
                    <span>KES {formatKes(Number.isFinite(amount) ? amount : 0)}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={openCheckout}
                  className="mt-6 w-full rounded-2xl bg-emerald-500 px-4 py-4 text-base font-black text-slate-950 transition hover:bg-emerald-400 active:scale-[0.99]"
                >
                  Support with {methodInfo.name}
                </button>

                <div className="mt-5 flex items-center gap-3 text-xs text-slate-400">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-500/15 text-sm font-black text-emerald-300">
                    {methodInfo.icon}
                  </span>
                  <p>
                    {paymentMethod === "mpesa" && mpesaLive
                      ? "Secure STK push. You approve the payment on your phone with your M-Pesa PIN."
                      : methodInfo.waitingHint}
                  </p>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-slate-500">
                  {mpesaLive
                    ? "M-Pesa is live. Airtel Money, PayPal and Binance Pay are simulated demos."
                    : "All methods are simulated demos until payment credentials are configured."}
                </p>
                {!mpesaLive && (
                  <p className="mt-2 text-[11px] leading-5 text-amber-200/70">
                    No real money moves in demo mode.
                  </p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* Checkout modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Support with ${methodInfo.name}`}
            className="w-full max-w-md rounded-t-[28px] bg-white p-6 shadow-2xl sm:rounded-[28px]"
          >
            {phase === "success" ? (
              <div className="py-6 text-center">
                <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-3xl text-emerald-700">
                  ✓
                </div>
                <h2 className="mt-4 text-2xl font-black">Thank you!</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Your KES {formatKes(amount)} gift via {methodInfo.name} reached{" "}
                  {creator.displayName}.
                </p>
                {receipt && (
                  <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                    Receipt: {receipt}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="mt-6 w-full rounded-2xl bg-slate-900 px-4 py-3 font-bold text-white transition hover:bg-slate-700"
                >
                  Done
                </button>
              </div>
            ) : phase === "waiting" ? (
              <div className="py-4 text-center">
                <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-emerald-100 border-t-emerald-600" />
                <h2 className="mt-5 text-xl font-black">{methodInfo.waitingTitle}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{customerMessage}</p>
                <p className="mt-2 text-xs text-slate-400">
                  {methodInfo.waitingHint}{" "}
                  {paymentMethod === "mpesa" || paymentMethod === "airtel"
                    ? `Number: ${phoneNumber || "your phone"}`
                    : `Account: ${paymentAccount || "your account"}`}
                </p>

                {(!mpesaLive || paymentMethod !== "mpesa") && (
                  <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-amber-800">
                      {methodInfo.name} simulation
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void simulate(true)}
                        className="rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-emerald-700"
                      >
                        Simulate success
                      </button>
                      <button
                        type="button"
                        onClick={() => void simulate(false)}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
                      >
                        Cancel payment
                      </button>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    reset();
                  }}
                  className="mt-5 text-sm font-semibold text-slate-500 underline underline-offset-4 hover:text-slate-800"
                >
                  Close this window
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">
                      Checkout · {methodInfo.name}
                    </p>
                    <h2 className="mt-1 text-xl font-black">Gift {creator.displayName}</h2>
                  </div>
                  <button
                    type="button"
                    onClick={closeCheckout}
                    aria-label="Close"
                    className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
                  >
                    ✕
                  </button>
                </div>

                <div className="mt-5 space-y-4">
                  <div className="flex flex-wrap gap-1.5">
                    {PAYMENT_METHODS.map((method) => {
                      const selected = method.id === paymentMethod;
                      return (
                        <button
                          key={method.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            setPaymentMethod(method.id);
                            setError("");
                          }}
                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                            selected
                              ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                              : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                          }`}
                        >
                          {method.shortName}
                        </button>
                      );
                    })}
                  </div>

                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                      Your name <span className="font-normal text-slate-400">(optional)</span>
                    </span>
                    <input
                      value={supporterName}
                      onChange={(event) => setSupporterName(event.target.value)}
                      maxLength={60}
                      placeholder="Anonymous"
                      className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                    />
                  </label>

                  {paymentMethod === "mpesa" || paymentMethod === "airtel" ? (
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                        {methodInfo.fieldLabel}
                      </span>
                      <input
                        value={phoneNumber}
                        onChange={(event) => {
                          setPhoneNumber(event.target.value);
                          setError("");
                        }}
                        placeholder={methodInfo.placeholder}
                        inputMode={methodInfo.inputMode}
                        autoComplete="tel"
                        className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                        {methodInfo.fieldLabel}
                      </span>
                      <input
                        value={paymentAccount}
                        onChange={(event) => {
                          setPaymentAccount(event.target.value);
                          setError("");
                        }}
                        placeholder={methodInfo.placeholder}
                        inputMode={methodInfo.inputMode}
                        autoComplete={methodInfo.id === "paypal" ? "email" : "off"}
                        className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                      />
                    </label>
                  )}

                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                      Message <span className="font-normal text-slate-400">(optional)</span>
                    </span>
                    <textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      maxLength={240}
                      rows={2}
                      placeholder="Say something kind..."
                      className="w-full resize-none rounded-xl border border-slate-200 px-4 py-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                    />
                  </label>

                  <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm">
                    <span className="text-slate-600">{selectedTier.title}</span>
                    <span className="font-black text-slate-900">
                      KES {formatKes(Number.isFinite(amount) ? amount : 0)}
                    </span>
                  </div>

                  {phase === "failed" && error && (
                    <div
                      role="alert"
                      className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void initiate()}
                    disabled={phase === "initiating"}
                    className="w-full rounded-2xl bg-emerald-600 px-4 py-4 text-base font-black text-white transition hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-70"
                  >
                    {phase === "initiating"
                      ? "Starting payment..."
                      : `Support with ${methodInfo.name} · KES ${formatKes(Number.isFinite(amount) ? amount : 0)}`}
                  </button>
                  <p className="text-center text-[11px] text-slate-400">
                    {paymentMethod === "mpesa" || paymentMethod === "airtel"
                      ? "A prompt will appear on your phone. No card required."
                      : "Demo checkout: no real account is charged."}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
