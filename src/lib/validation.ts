export const MIN_TIP = 50;
export const MAX_TIP = 100_000;

export function parseAmount(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) return null;
  if (amount < MIN_TIP || amount > MAX_TIP) return null;
  return amount;
}

export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function isValidUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9._-]{2,40}$/.test(value) &&
    !value.includes("..")
  );
}
