export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  return String(Math.round(value));
}

export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined || !currency) {
    return "計算不能";
  }

  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatConfidenceLabel(value: string | null | undefined): string {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "unknown";
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }

  return `${Math.round(value * 100)}%`;
}
