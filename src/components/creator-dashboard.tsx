"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { getPaymentMethod } from "@/lib/payments";
import type { CreatorEarnings, TransactionStatus } from "@/lib/types";

const STORAGE_KEY = "tipjar-dashboard-token";

function formatKes(amount: number): string {
  return new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(amount);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-KE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function statusStyle(status: TransactionStatus): string {
  if (status === "SUCCESS") return "bg-emerald-50 text-emerald-700";
  if (status === "FAILED") return "bg-rose-50 text-rose-700";
  return "bg-amber-50 text-amber-700";
}

export default function CreatorDashboard({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = use(params);
  const [token, setToken] = useState("");
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const unlock = async (code: string) => {
    if (!code.trim()) {
      setError("Enter your creator access code.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/creators/${encodeURIComponent(username)}/earnings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${code.trim()}`,
          },
          body: JSON.stringify({ token: code.trim() }),
        },
      );
      const data = (await response.json()) as CreatorEarnings & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Could not open the dashboard.");
      }
      setEarnings(data);
      setToken("");
      try {
        sessionStorage.setItem(STORAGE_KEY, code.trim());
      } catch {
        // Storage can be unavailable in private browsing; the session still works.
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // Ignore unavailable storage.
    }
    if (!saved) return;
    let active = true;
    void (async () => {
      // Defer past the effect body so a saved session cannot cascade renders.
      await Promise.resolve();
      if (active) await unlock(saved);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const lock = () => {
    setEarnings(null);
    setError("");
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore unavailable storage.
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_15%_-10%,#dcfce7_0%,transparent_38%),#faf7f2] px-4 py-6 text-slate-900 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-600 text-white">
              T
            </span>
            <span>TipJar</span>
          </div>
          <Link
            href={`/${username}`}
            className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-300"
          >
            ← Back to profile
          </Link>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-emerald-100 bg-white/90 shadow-[0_25px_80px_rgba(5,150,105,0.12)] backdrop-blur">
          <section className="bg-[linear-gradient(125deg,#064e3b_0%,#065f46_55%,#b45309_140%)] px-5 py-8 text-white sm:px-9">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200">
              Private
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-tight">Creator dashboard</h1>
            <p className="mt-2 text-sm text-white/75">
              Only you can see these figures. They are never included on your public profile.
            </p>
            {earnings && (
              <button
                type="button"
                onClick={lock}
                className="mt-4 rounded-full border border-white/25 px-3 py-1 text-xs font-semibold text-white/90 transition hover:bg-white/10"
              >
                Lock dashboard
              </button>
            )}
          </section>

          {!earnings ? (
            <section className="px-5 py-10 sm:px-9">
              {loading ? (
                <p className="text-sm text-slate-500">Checking your access code…</p>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void unlock(token);
                  }}
                  className="mx-auto max-w-md"
                >
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                      Creator access code
                    </span>
                    <input
                      type="password"
                      value={token}
                      onChange={(event) => {
                        setToken(event.target.value);
                        setError("");
                      }}
                      placeholder="Enter your access code"
                      autoComplete="current-password"
                      className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                    />
                  </label>

                  {error && (
                    <p role="alert" className="mt-3 text-sm text-rose-600">
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="mt-5 w-full rounded-2xl bg-emerald-600 px-4 py-3.5 font-bold text-white transition hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-70"
                  >
                    {loading ? "Checking…" : "View my earnings"}
                  </button>

                  {process.env.NODE_ENV !== "production" && (
                    <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                      Local demo code: <code className="font-bold">tipjar-demo</code>. Set{" "}
                      <code>CREATOR_DASHBOARD_TOKEN</code> in <code>.env.local</code> to use your
                      own.
                    </p>
                  )}
                </form>
              )}
            </section>
          ) : (
            <section className="px-5 py-8 sm:px-9">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "Total supported", value: `KES ${formatKes(earnings.totalSupported)}` },
                  { label: "Supporters", value: formatKes(earnings.supporterCount) },
                  { label: "Pending", value: formatKes(earnings.pendingCount) },
                  { label: "Failed", value: formatKes(earnings.failedCount) },
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl bg-emerald-50 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700/70">
                      {item.label}
                    </p>
                    <p className="mt-1 text-xl font-black text-emerald-900">{item.value}</p>
                  </div>
                ))}
              </div>

              <h2 className="mt-9 text-lg font-bold">Recent activity</h2>
              {earnings.transactions.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No payments yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100">
                  {earnings.transactions.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900">
                          {item.supporterName}
                          <span className="ml-2 font-normal text-slate-400">
                            · {item.giftTitle ?? "Support"}
                          </span>
                        </p>
                        <p className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">
                          {getPaymentMethod(item.paymentMethod).shortName} ·{" "}
                          {formatDate(item.createdAt)}
                          {item.mpesaReceiptNumber ? ` · ${item.mpesaReceiptNumber}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusStyle(item.status)}`}
                        >
                          {item.status}
                        </span>
                        <span className="text-sm font-black text-slate-900">
                          KES {formatKes(item.amount)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
