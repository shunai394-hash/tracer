export type BasePublicationOutcomeInput = {
  failed: number;
  skipped: number;
};

export type BasePublicationOutcome = {
  ok: boolean;
  status: 200 | 207;
};

/**
 * A batch is successful only when every attempted listing was published or
 * reconciled without being skipped/blocked. HTTP 207 keeps partial results
 * observable to callers without misrepresenting them as a full success.
 */
export function getBasePublicationOutcome(
  result: BasePublicationOutcomeInput,
): BasePublicationOutcome {
  const ok = result.failed === 0 && result.skipped === 0;
  return { ok, status: ok ? 200 : 207 };
}
