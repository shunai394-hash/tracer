export type EvidenceRecord = {
  id: string;
  field: string;
  metric: string;
  value: unknown;
  source: string;
  sourceUrl?: string | null;
  observedAt?: string | null;
  retrievedAt: string;
  freshnessHours?: number | null;
  confidence: string;
  kind: "observed" | "derived" | "estimated" | "unknown";
};

export type CalculationRecord = {
  field: string;
  formula: string;
  inputs: Record<string, unknown>;
  result: unknown;
  kind: "derived" | "estimated";
  calculable: boolean;
  reason?: string;
};

export function evidenceRecord(
  id: string,
  args: Omit<EvidenceRecord, "id" | "retrievedAt"> & { retrievedAt?: string },
): EvidenceRecord {
  return {
    id,
    retrievedAt: args.retrievedAt ?? new Date().toISOString(),
    ...args,
  };
}
