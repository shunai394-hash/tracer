/** CJ product and variant IDs are native decimal IDs, not TRACER UUIDs or SKUs. */
export function isCanonicalCJNativeId(value) {
  return /^\d{10,22}$/.test(String(value ?? "").trim());
}
