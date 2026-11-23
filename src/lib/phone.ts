/** Converts 07..., 01..., 2547... or +2547... into the 2547... format Daraja expects. */
export function normalizePhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");

  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;

  return digits;
}

export function isValidPhoneNumber(phoneNumber: string): boolean {
  return /^254[17]\d{8}$/.test(normalizePhoneNumber(phoneNumber));
}
