/**
 * Per-order human approval for supplier (CJ) purchases.
 *
 * Live CJ ordering pays from the CJ balance immediately, so a paid customer
 * order must not become a real supplier purchase until a person has approved
 * that exact procurement row. The approval is stored as a commerce_events row
 * (unique event_key) and is bound to the supplier IDs and quantity it was
 * given for; an approval for different content, or an expired one, is ignored.
 *
 * Fail-closed: approval is required unless COMMERCE_PROCUREMENT_REQUIRE_APPROVAL
 * is exactly "0".
 *
 * Pure module: no network, database, or path-alias imports.
 */

export const PROCUREMENT_APPROVAL_EVENT_TYPE = "procurement_approved";
export const PROCUREMENT_APPROVAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type ProcurementApprovalTarget = {
  id: string;
  supplierCode: string;
  supplierProductId: string;
  supplierVariantId: string;
  quantity: number;
};

export type ProcurementApprovalDetail = {
  procurementOrderId: string;
  supplierCode: string;
  supplierProductId: string;
  supplierVariantId: string;
  quantity: number;
  approvedBy: string;
  approvedAt: string;
};

export type ProcurementApprovalDecision =
  | { approved: true }
  | { approved: false; reason: "approval_missing" | "approval_content_mismatch" | "approval_expired" | "approval_invalid" };

export function isProcurementApprovalRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.COMMERCE_PROCUREMENT_REQUIRE_APPROVAL?.trim() !== "0";
}

export function procurementApprovalEventKey(procurementOrderId: string): string {
  return `procurement_approval:${procurementOrderId}`;
}

export function buildProcurementApprovalDetail(target: ProcurementApprovalTarget, approvedBy: string, now = new Date()): ProcurementApprovalDetail {
  return {
    procurementOrderId: target.id,
    supplierCode: target.supplierCode,
    supplierProductId: target.supplierProductId,
    supplierVariantId: target.supplierVariantId,
    quantity: target.quantity,
    approvedBy,
    approvedAt: now.toISOString(),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** Decides whether a stored approval event authorizes ordering this exact procurement row now. */
export function evaluateProcurementApproval(
  target: ProcurementApprovalTarget,
  event: { event_type?: unknown; status?: unknown; detail?: unknown } | null | undefined,
  nowMs = Date.now(),
): ProcurementApprovalDecision {
  if (!event) return { approved: false, reason: "approval_missing" };
  if (event.event_type !== PROCUREMENT_APPROVAL_EVENT_TYPE || event.status !== "ok") return { approved: false, reason: "approval_invalid" };
  const detail = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail) ? event.detail as Record<string, unknown> : null;
  if (!detail || !text(detail.approvedBy)) return { approved: false, reason: "approval_invalid" };
  const approvedAt = Date.parse(text(detail.approvedAt));
  if (!Number.isFinite(approvedAt) || approvedAt > nowMs + 5 * 60 * 1000) return { approved: false, reason: "approval_invalid" };
  if (nowMs - approvedAt > PROCUREMENT_APPROVAL_MAX_AGE_MS) return { approved: false, reason: "approval_expired" };
  const matches = text(detail.procurementOrderId) === target.id
    && text(detail.supplierCode) === target.supplierCode
    && text(detail.supplierProductId) === target.supplierProductId
    && text(detail.supplierVariantId) === target.supplierVariantId
    && Number(detail.quantity) === target.quantity;
  return matches ? { approved: true } : { approved: false, reason: "approval_content_mismatch" };
}
