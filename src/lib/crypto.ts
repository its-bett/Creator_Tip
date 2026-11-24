import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Constant-time comparison for short opaque tokens and signatures. */
export function safeEqualStrings(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHmacSignature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function createOpaqueToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
