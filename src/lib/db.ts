import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMpesaConfigured } from "@/lib/mpesa";
import {
  DEMO_CREATORS,
  DEMO_GIFT_TIERS,
  DEMO_TRANSACTIONS,
} from "@/lib/seed";
import { LATE_CALLBACK_GRACE_MINUTES, PAYMENT_TIMEOUT_REASON } from "@/lib/types";
import type {
  Creator,
  CreatorEarnings,
  CreatorProfile,
  CreatorStats,
  GiftTier,
  NewTransaction,
  PaymentMethod,
  Supporter,
  Transaction,
  TransactionPatch,
} from "@/lib/types";

type DbRow = Record<string, unknown>;

type LocalStore = {
  creators: Creator[];
  tiers: GiftTier[];
  transactions: Transaction[];
};

let supabaseAdmin: SupabaseClient | null | undefined;

export function isLiveDatabase(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

function getSupabaseAdmin(): SupabaseClient | null {
  if (supabaseAdmin !== undefined) return supabaseAdmin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    supabaseAdmin = null;
    return null;
  }

  supabaseAdmin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseAdmin;
}

/* ---------------------------------- mapping --------------------------------- */

function mapCreator(row: DbRow): Creator {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    headline: String(row.headline ?? ""),
    bio: String(row.bio ?? ""),
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    avatarEmoji: String(row.avatar_emoji ?? "✨"),
    location: String(row.location ?? ""),
    followers: Number(row.followers ?? 0),
    following: Number(row.following ?? 0),
    posts: Number(row.posts ?? 0),
    mpesaPhone: row.mpesa_phone ? String(row.mpesa_phone) : null,
    createdAt: String(row.created_at),
  };
}

function mapTier(row: DbRow): GiftTier {
  return {
    id: String(row.id),
    creatorId: String(row.creator_id),
    title: String(row.title),
    amount: Number(row.amount),
    icon: String(row.icon ?? "🎁"),
    isPopular: Boolean(row.is_popular),
    sortOrder: Number(row.sort_order ?? 0),
  };
}

function mapTransaction(row: DbRow): Transaction {
  const rawMethod = String(row.payment_method ?? "mpesa").toLowerCase();
  const paymentMethod: PaymentMethod =
    rawMethod === "airtel" || rawMethod === "paypal" || rawMethod === "binance"
      ? rawMethod
      : "mpesa";

  return {
    id: String(row.id),
    creatorId: String(row.creator_id),
    supporterName: String(row.supporter_name ?? "Anonymous"),
    supporterMessage: row.supporter_message ? String(row.supporter_message) : null,
    giftTitle: row.gift_title ? String(row.gift_title) : null,
    amount: Number(row.amount),
    phoneNumber: String(row.phone_number ?? ""),
    paymentAccount: row.payment_account ? String(row.payment_account) : null,
    paymentMethod,
    status: row.status === "SUCCESS" || row.status === "FAILED" ? row.status : "PENDING",
    mpesaReceiptNumber: row.mpesa_receipt_number
      ? String(row.mpesa_receipt_number)
      : null,
    checkoutRequestId: String(row.checkout_request_id),
    merchantRequestId: row.merchant_request_id ? String(row.merchant_request_id) : null,
    accountReference: row.account_reference ? String(row.account_reference) : null,
    pollingToken: String(row.polling_token ?? ""),
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    mode: row.mode === "live" ? "live" : "demo",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

function toSupporter(transaction: Transaction): Supporter {
  // Amounts and receipts are private — they must not leak into public responses.
  return {
    id: transaction.id,
    supporterName: transaction.supporterName,
    supporterMessage: transaction.supporterMessage,
    giftTitle: transaction.giftTitle,
    paymentMethod: transaction.paymentMethod,
    createdAt: transaction.createdAt,
  };
}

function toPublicStats(creator: Creator, supporterCount: number): CreatorStats {
  return {
    followers: creator.followers,
    following: creator.following,
    supporters: supporterCount,
    posts: creator.posts,
  };
}

/* ------------------------------- local fallback ------------------------------ */

const storePath =
  process.env.LOCAL_STORE_PATH || path.join(process.cwd(), ".data", "store.json");
let writeQueue: Promise<unknown> = Promise.resolve();

async function readStore(): Promise<LocalStore> {
  try {
    const contents = await readFile(/* turbopackIgnore: true */ storePath, "utf8");
    const store = JSON.parse(contents) as LocalStore;
    // Migrate stores created by earlier versions of the app.
    for (const creator of store.creators) {
      creator.followers ??= 0;
      creator.following ??= 0;
      creator.posts ??= 0;
    }
    for (const transaction of store.transactions) {
      transaction.paymentMethod ??= "mpesa";
      transaction.paymentAccount ??= null;
      transaction.mode ??= "demo";
      transaction.merchantRequestId ??= null;
      transaction.accountReference ??= null;
      transaction.pollingToken ??= `legacy_${transaction.id}`;
    }
    return store;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;

    const seeded: LocalStore = {
      creators: structuredClone(DEMO_CREATORS),
      tiers: structuredClone(DEMO_GIFT_TIERS),
      transactions: structuredClone(DEMO_TRANSACTIONS),
    };
    await writeStore(seeded);
    return seeded;
  }
}

async function writeStore(store: LocalStore): Promise<void> {
  await mkdir(/* turbopackIgnore: true */ path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${process.pid}.tmp`;
  await writeFile(/* turbopackIgnore: true */ tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(/* turbopackIgnore: true */ tempPath, storePath);
}

async function withStore<T>(mutate: (store: LocalStore) => Promise<T> | T): Promise<T> {
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutate(store);
    await writeStore(store);
    return result;
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

/* -------------------------------- public reads ------------------------------- */

export async function getCreatorProfile(
  username: string,
): Promise<CreatorProfile | null> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const store = await readStore();
    const creator = store.creators.find(
      (item) => item.username.toLowerCase() === username.toLowerCase(),
    );
    if (!creator) return null;

    const tiers = store.tiers
      .filter((tier) => tier.creatorId === creator.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const successful = store.transactions
      .filter(
        (item) => item.creatorId === creator.id && item.status === "SUCCESS",
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      creator,
      tiers,
      supporters: successful.slice(0, 8).map(toSupporter),
      stats: toPublicStats(creator, successful.length),
      mode: "demo",
      mpesaLive: isMpesaConfigured(),
    };
  }

  // Match case-sensitively first, then tolerate a differently-cased URL.
  // (ilike would treat the underscores in usernames as wildcards.)
  const exact = await supabase
    .from("creators")
    .select("*")
    .eq("username", username)
    .maybeSingle();
  if (exact.error) throw exact.error;

  const { data: creatorRow, error: creatorError } = exact.data
    ? { data: exact.data, error: null }
    : await supabase
        .from("creators")
        .select("*")
        .eq("username", username.toLowerCase())
        .maybeSingle();

  if (creatorError) throw creatorError;
  if (!creatorRow) return null;

  const creator = mapCreator(creatorRow as DbRow);

  const [tiersResult, supportersResult, countResult] = await Promise.all([
    supabase
      .from("gift_tiers")
      .select("*")
      .eq("creator_id", creator.id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("transactions")
      .select("*")
      .eq("creator_id", creator.id)
      .eq("status", "SUCCESS")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", creator.id)
      .eq("status", "SUCCESS"),
  ]);

  if (tiersResult.error) throw tiersResult.error;
  if (supportersResult.error) throw supportersResult.error;
  if (countResult.error) throw countResult.error;

  const supporters = (supportersResult.data ?? []).map((row) =>
    mapTransaction(row as DbRow),
  );

  return {
    creator,
    tiers: (tiersResult.data ?? []).map((row) => mapTier(row as DbRow)),
    supporters: supporters.map(toSupporter),
    stats: toPublicStats(creator, countResult.count ?? 0),
    mode: "live",
    mpesaLive: isMpesaConfigured(),
  };
}

/** Private earnings data. Only call from a token-protected route. */
export async function getCreatorEarnings(
  username: string,
): Promise<CreatorEarnings | null> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const store = await readStore();
    const creator = store.creators.find(
      (item) => item.username.toLowerCase() === username.toLowerCase(),
    );
    if (!creator) return null;

    const all = store.transactions
      .filter((item) => item.creatorId === creator.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const successful = all.filter((item) => item.status === "SUCCESS");

    return {
      totalSupported: successful.reduce((sum, item) => sum + item.amount, 0),
      supporterCount: successful.length,
      successfulCount: successful.length,
      pendingCount: all.filter((item) => item.status === "PENDING").length,
      failedCount: all.filter((item) => item.status === "FAILED").length,
      transactions: all.slice(0, 20).map((item) => ({
        id: item.id,
        supporterName: item.supporterName,
        giftTitle: item.giftTitle,
        amount: item.amount,
        paymentMethod: item.paymentMethod,
        status: item.status,
        mpesaReceiptNumber: item.mpesaReceiptNumber,
        createdAt: item.createdAt,
      })),
    };
  }

  const exact = await supabase
    .from("creators")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (exact.error) throw exact.error;

  const { data: creatorRow, error: creatorError } = exact.data
    ? { data: exact.data, error: null }
    : await supabase
        .from("creators")
        .select("id")
        .eq("username", username.toLowerCase())
        .maybeSingle();
  if (creatorError) throw creatorError;
  if (!creatorRow) return null;

  const creatorId = String((creatorRow as DbRow).id);
  const [totalsResult, successfulResult, pendingResult, failedResult, transactionsResult] =
    await Promise.all([
      supabase
        .from("creator_stats")
        .select("total_supported, supporter_count")
        .eq("creator_id", creatorId)
        .maybeSingle(),
      supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", creatorId)
        .eq("status", "SUCCESS"),
      supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", creatorId)
        .eq("status", "PENDING"),
      supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", creatorId)
        .eq("status", "FAILED"),
      supabase
        .from("transactions")
        .select("*")
        .eq("creator_id", creatorId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  for (const result of [totalsResult, successfulResult, pendingResult, failedResult, transactionsResult]) {
    if (result.error) throw result.error;
  }

  const totals = totalsResult.data as DbRow | null;
  const transactions = (transactionsResult.data ?? []).map((row) =>
    mapTransaction(row as DbRow),
  );

  return {
    totalSupported: Number(totals?.total_supported ?? 0),
    supporterCount: successfulResult.count ?? Number(totals?.supporter_count ?? 0),
    successfulCount: successfulResult.count ?? 0,
    pendingCount: pendingResult.count ?? 0,
    failedCount: failedResult.count ?? 0,
    transactions: transactions.map((item) => ({
      id: item.id,
      supporterName: item.supporterName,
      giftTitle: item.giftTitle,
      amount: item.amount,
      paymentMethod: item.paymentMethod,
      status: item.status,
      mpesaReceiptNumber: item.mpesaReceiptNumber,
      createdAt: item.createdAt,
    })),
  };
}

export async function getCreatorById(id: string): Promise<Creator | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const store = await readStore();
    return store.creators.find((creator) => creator.id === id) ?? null;
  }

  const { data, error } = await supabase
    .from("creators")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapCreator(data as DbRow) : null;
}

export async function getTierById(id: string): Promise<GiftTier | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const store = await readStore();
    return store.tiers.find((tier) => tier.id === id) ?? null;
  }

  const { data, error } = await supabase
    .from("gift_tiers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapTier(data as DbRow) : null;
}

export async function getTransactionByCheckoutRequestId(
  checkoutRequestId: string,
): Promise<Transaction | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const store = await readStore();
    return (
      store.transactions.find(
        (item) => item.checkoutRequestId === checkoutRequestId,
      ) ?? null
    );
  }

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("checkout_request_id", checkoutRequestId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapTransaction(data as DbRow) : null;
}

export async function getTransactionById(id: string): Promise<Transaction | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const store = await readStore();
    return store.transactions.find((item) => item.id === id) ?? null;
  }

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapTransaction(data as DbRow) : null;
}

/* --------------------------------- mutations --------------------------------- */

function patchToRow(patch: TransactionPatch): DbRow {
  const row: DbRow = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.mpesaReceiptNumber !== undefined) row.mpesa_receipt_number = patch.mpesaReceiptNumber;
  if (patch.failureReason !== undefined) row.failure_reason = patch.failureReason;
  if (patch.checkoutRequestId !== undefined) row.checkout_request_id = patch.checkoutRequestId;
  if (patch.merchantRequestId !== undefined) row.merchant_request_id = patch.merchantRequestId;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  return row;
}

async function updateLocalTransaction(
  id: string,
  patch: TransactionPatch,
  canUpdate: (transaction: Transaction) => boolean,
): Promise<Transaction | null> {
  const values = { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
  const definedValues = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as TransactionPatch;
  const result: { transaction: Transaction | null } = { transaction: null };

  await withStore((store) => {
    const index = store.transactions.findIndex((item) => item.id === id);
    if (index === -1 || !canUpdate(store.transactions[index])) return;
    store.transactions[index] = { ...store.transactions[index], ...definedValues };
    result.transaction = store.transactions[index];
  });

  return result.transaction;
}

/** Updates only while the transaction is still awaiting its first payment result. */
export async function completePendingTransaction(
  id: string,
  patch: TransactionPatch,
): Promise<Transaction | null> {
  const values = { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return updateLocalTransaction(id, values, (item) => item.status === "PENDING");
  }

  const { data, error } = await supabase
    .from("transactions")
    .update(patchToRow(values))
    .eq("id", id)
    .eq("status", "PENDING")
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? mapTransaction(data as DbRow) : null;
}

/**
 * A late callback may arrive after the UI timed out. Allow it to recover a
 * transaction we expired ourselves, but never overwrite a real failure.
 */
export async function completeTimedOutTransaction(
  id: string,
  patch: TransactionPatch,
): Promise<Transaction | null> {
  const supabase = getSupabaseAdmin();
  const graceCutoff = Date.now() - LATE_CALLBACK_GRACE_MINUTES * 60_000;

  const canRecover = (item: Transaction) =>
    item.status === "FAILED" &&
    item.failureReason === PAYMENT_TIMEOUT_REASON &&
    new Date(item.updatedAt).getTime() >= graceCutoff;

  if (!supabase) {
    return updateLocalTransaction(id, patch, canRecover);
  }

  const { data: current, error: readError } = await supabase
    .from("transactions")
    .select("status, failure_reason, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (
    !current ||
    current.status !== "FAILED" ||
    current.failure_reason !== PAYMENT_TIMEOUT_REASON ||
    new Date(String(current.updated_at)).getTime() < graceCutoff
  ) {
    return null;
  }

  const { data, error } = await supabase
    .from("transactions")
    .update(patchToRow(patch))
    .eq("id", id)
    .eq("status", "FAILED")
    .eq("failure_reason", PAYMENT_TIMEOUT_REASON)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? mapTransaction(data as DbRow) : null;
}

/** Lets a late callback add a receipt to a payment already confirmed by STK query. */
export async function attachMpesaReceipt(
  id: string,
  receipt: string,
): Promise<Transaction | null> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return updateLocalTransaction(
      id,
      { mpesaReceiptNumber: receipt },
      (item) => item.status === "SUCCESS" && item.mpesaReceiptNumber === null,
    );
  }

  const { data, error } = await supabase
    .from("transactions")
    .update({ mpesa_receipt_number: receipt })
    .eq("id", id)
    .eq("status", "SUCCESS")
    .is("mpesa_receipt_number", null)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? mapTransaction(data as DbRow) : null;
}

export async function createTransaction(input: NewTransaction): Promise<Transaction> {
  const now = new Date().toISOString();
  const transaction: Transaction = {
    id: crypto.randomUUID(),
    ...input,
    status: "PENDING",
    mpesaReceiptNumber: null,
    merchantRequestId: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  };

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    await withStore((store) => {
      store.transactions.unshift(transaction);
    });
    return transaction;
  }

  const { data, error } = await supabase
    .from("transactions")
    .insert({
      id: transaction.id,
      creator_id: transaction.creatorId,
      supporter_name: transaction.supporterName,
      supporter_message: transaction.supporterMessage,
      gift_title: transaction.giftTitle,
      amount: transaction.amount,
      phone_number: transaction.phoneNumber,
      payment_account: transaction.paymentAccount,
      payment_method: transaction.paymentMethod,
      mode: transaction.mode,
      status: transaction.status,
      checkout_request_id: transaction.checkoutRequestId,
      account_reference: transaction.accountReference,
      polling_token: transaction.pollingToken,
    })
    .select("*")
    .single();

  if (error) throw error;
  return mapTransaction(data as DbRow);
}

export async function updateTransaction(
  id: string,
  patch: TransactionPatch,
): Promise<Transaction | null> {
  const values = { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const definedValues = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as TransactionPatch;
    const result: { transaction: Transaction | null } = { transaction: null };
    await withStore((store) => {
      const index = store.transactions.findIndex((item) => item.id === id);
      if (index === -1) return;
      store.transactions[index] = { ...store.transactions[index], ...definedValues };
      result.transaction = store.transactions[index];
    });
    return result.transaction;
  }

  const { data, error } = await supabase
    .from("transactions")
    .update(patchToRow(values))
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ? mapTransaction(data as DbRow) : null;
}
