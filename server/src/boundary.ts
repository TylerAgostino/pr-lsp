// Canonical runtime boundary guards for RPC/JSON payloads. One definition
// for the whole package; never recreate at call sites.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** String-or-empty for display fields on untrusted payloads. */
export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Number-or-null for optional numeric fields on untrusted payloads. */
export function optNum(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
