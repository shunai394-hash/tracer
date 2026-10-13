export type StatusWriteError = { message: string; code?: string };
export type StatusWriteResult = { ok: true } | { ok: false; error: string };

/** Persist a state transition and never silently ignore database write failures. */
export async function persistOrderStateUpdate(
  target: { table: string; id: string; context: string; purchaseOrderId?: string | null },
  write: () => PromiseLike<{ error: StatusWriteError | null }>,
): Promise<StatusWriteResult> {
  try {
    const { error } = await write();
    if (!error) return { ok: true };
    console.error("[TRACER ORDER STATE WRITE FAILED]", {
      ...target,
      code: error.code ?? null,
      error: error.message,
    });
    return { ok: false, error: error.message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER ORDER STATE WRITE THREW]", {
      ...target,
      error: message,
    });
    return { ok: false, error: message };
  }
}
