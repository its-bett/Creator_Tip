type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 15;

/** Small in-process limiter; use a shared store (e.g. Upstash) when scaling out. */
export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 2000) {
      for (const [entry, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(entry);
      }
    }
    return false;
  }

  bucket.count += 1;
  return bucket.count > MAX_REQUESTS;
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}
