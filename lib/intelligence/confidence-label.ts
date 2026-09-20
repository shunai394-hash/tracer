import type { ConfidenceLabel } from "@/lib/domain/types";

export function toConfidenceLabel(
  numeric: number | null | undefined,
  hasData: boolean,
): ConfidenceLabel {
  if (!hasData || numeric === null || numeric === undefined || !Number.isFinite(numeric)) {
    return "unknown";
  }

  if (numeric < 0.4) return "low";
  if (numeric < 0.7) return "medium";
  return "high";
}

export function weakerLabel(
  left: ConfidenceLabel,
  right: ConfidenceLabel,
): ConfidenceLabel {
  const rank: Record<ConfidenceLabel, number> = {
    unknown: 0,
    low: 1,
    medium: 2,
    high: 3,
  };

  return rank[left] <= rank[right] ? left : right;
}

export function confidenceJudgment(args: {
  demand: ConfidenceLabel;
  price: ConfidenceLabel;
}): string | null {
  if (args.demand === "high" && (args.price === "unknown" || args.price === "low")) {
    return "需要は確認できているが利益判断は未確定";
  }

  if (args.price === "high" && (args.demand === "unknown" || args.demand === "low")) {
    return "価格は観測されているが需要判断は未確定";
  }

  return null;
}
