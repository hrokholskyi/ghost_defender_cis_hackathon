/** Pure display helpers shared by the engine, the gateways and the tools. */

export function formatAed(amount: number): string {
  return `AED ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Keeps the first 4 and the last 4 characters, for example "AE00 •••• 0001". */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s+/g, "");
  if (compact.length <= 8) return compact;
  return `${compact.slice(0, 4)} •••• ${compact.slice(-4)}`;
}
