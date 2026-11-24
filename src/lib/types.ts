export type TransactionStatus = "PENDING" | "SUCCESS" | "FAILED";

export const PAYMENT_TIMEOUT_REASON = "The payment prompt expired. Please try again.";
export const LATE_CALLBACK_GRACE_MINUTES = 60 * 24;

export type PaymentMethod = "mpesa" | "airtel" | "paypal" | "binance";

export type Creator = {
  id: string;
  username: string;
  displayName: string;
  headline: string;
  bio: string;
  avatarUrl: string | null;
  avatarEmoji: string;
  location: string;
  followers: number;
  following: number;
  posts: number;
  mpesaPhone: string | null;
  createdAt: string;
};

export type GiftTier = {
  id: string;
  creatorId: string;
  title: string;
  amount: number;
  icon: string;
  isPopular: boolean;
  sortOrder: number;
};

/** Public supporter activity — deliberately excludes amounts and receipts. */
export type Supporter = {
  id: string;
  supporterName: string;
  supporterMessage: string | null;
  giftTitle: string | null;
  paymentMethod: PaymentMethod;
  createdAt: string;
};

/** Public profile stats, modeled after a standard creator profile. */
export type CreatorStats = {
  followers: number;
  following: number;
  supporters: number;
  posts: number;
};

export type CreatorProfile = {
  creator: Creator;
  tiers: GiftTier[];
  supporters: Supporter[];
  stats: CreatorStats;
  mode: "demo" | "live";
  mpesaLive: boolean;
};

/** Private figures returned only to the authenticated creator. */
export type CreatorEarnings = {
  totalSupported: number;
  supporterCount: number;
  successfulCount: number;
  pendingCount: number;
  failedCount: number;
  transactions: Array<{
    id: string;
    supporterName: string;
    giftTitle: string | null;
    amount: number;
    paymentMethod: PaymentMethod;
    status: TransactionStatus;
    mpesaReceiptNumber: string | null;
    createdAt: string;
  }>;
};

export type Transaction = {
  id: string;
  creatorId: string;
  supporterName: string;
  supporterMessage: string | null;
  giftTitle: string | null;
  amount: number;
  phoneNumber: string;
  paymentAccount: string | null;
  paymentMethod: PaymentMethod;
  status: TransactionStatus;
  mpesaReceiptNumber: string | null;
  checkoutRequestId: string;
  merchantRequestId: string | null;
  accountReference: string | null;
  /** Secret, per-transaction token required when polling payment status. */
  pollingToken: string;
  failureReason: string | null;
  mode: "demo" | "live";
  createdAt: string;
  updatedAt: string;
};

export type NewTransaction = Pick<
  Transaction,
  | "creatorId"
  | "supporterName"
  | "supporterMessage"
  | "giftTitle"
  | "amount"
  | "phoneNumber"
  | "paymentAccount"
  | "paymentMethod"
  | "checkoutRequestId"
  | "accountReference"
  | "pollingToken"
  | "mode"
>;

export type TransactionPatch = Partial<
  Pick<
    Transaction,
    | "status"
    | "mpesaReceiptNumber"
    | "failureReason"
    | "checkoutRequestId"
    | "merchantRequestId"
    | "updatedAt"
  >
>;
