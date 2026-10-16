/**
 * One definition of NEWFIND delivery outcome for every report. A delivery is
 * delivered only when the receiver acknowledged it ("processed" or
 * "duplicate"); a row whose status says processed without that ACK is counted
 * separately so it can never inflate the success count.
 */

export type NewfindDeliveryOutcome = "delivered" | "failed" | "open" | "withdrawn" | "status_without_ack";

export type NewfindDeliveryRow = { status?: unknown; ack_status?: unknown; ackStatus?: unknown };

export function isNewfindAck(value: unknown): boolean {
  return value === "processed" || value === "duplicate";
}

export function newfindDeliveryOutcome(row: NewfindDeliveryRow): NewfindDeliveryOutcome {
  const status = String(row.status ?? "");
  const ack = row.ack_status ?? row.ackStatus ?? null;
  if (status === "processed") return isNewfindAck(ack) ? "delivered" : "status_without_ack";
  if (status === "failed") return "failed";
  if (status === "withdrawn") return "withdrawn";
  return "open";
}

export type NewfindDeliveryTally = Record<NewfindDeliveryOutcome, number> & { total: number };

export function tallyNewfindDeliveries(rows: NewfindDeliveryRow[]): NewfindDeliveryTally {
  const tally: NewfindDeliveryTally = { total: 0, delivered: 0, failed: 0, open: 0, withdrawn: 0, status_without_ack: 0 };
  for (const row of rows) {
    tally.total += 1;
    tally[newfindDeliveryOutcome(row)] += 1;
  }
  return tally;
}
