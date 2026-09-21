import { scoreFromKnown } from "@/lib/intelligence/sellability";

export type DemandTrend =
  | "rising"
  | "surge"
  | "flat"
  | "falling"
  | "crash"
  | "unknown";

export type DemandStability =
  | "sustained"
  | "growing"
  | "seasonal"
  | "spike"
  | "unstable"
  | "unknown";

export type DemandPoint = {
  value: number;
  observedAt: string;
  signalType?: string;
};

export type DemandWindowChange = {
  days: 7 | 14 | 30;
  previousValue: number | null;
  currentValue: number | null;
  change: number | null;
  pct: number | null;
};

export type DemandAnalysis = {
  volume: number | null;
  volumeUnit: string | null;
  windows: DemandWindowChange[];
  trend: DemandTrend;
  stability: DemandStability;
  spike: boolean;
  demandScore: number | null;
  demandConfidence: number;
  socialMentions: number | null;
  observationCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  series: Array<{ observedAt: string; value: number }>;
  evidence: Record<string, unknown>;
};

function asFinite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : null;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function uniqueDaily(points: DemandPoint[]): DemandPoint[] {
  const byDay = new Map<string, DemandPoint>();
  const sorted = [...points].sort(
    (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime(),
  );

  for (const point of sorted) {
    if (asFinite(point.value) === null) continue;
    byDay.set(dayKey(point.observedAt), point);
  }

  return [...byDay.values()];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function generallyIncreasing(values: number[]): boolean {
  if (values.length < 3) return false;
  let ups = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[index - 1]) ups += 1;
  }
  return ups / (values.length - 1) >= 0.66 && values[values.length - 1] > values[0];
}

function varianceHigh(values: number[]): boolean {
  if (values.length < 3) return false;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return false;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean >= 0.45;
}

function findWindowValue(
  series: DemandPoint[],
  latestAt: number,
  days: number,
): number | null {
  const target = latestAt - days * 86_400_000;
  const tolerance = days * 0.45 * 86_400_000;
  let best: DemandPoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const point of series.slice(0, -1)) {
    const time = new Date(point.observedAt).getTime();
    const delta = Math.abs(time - target);
    if (delta <= tolerance && delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }

  return best ? best.value : null;
}

function windowChange(
  series: DemandPoint[],
  days: 7 | 14 | 30,
): DemandWindowChange {
  if (series.length === 0) {
    return {
      days,
      previousValue: null,
      currentValue: null,
      change: null,
      pct: null,
    };
  }

  const current = series[series.length - 1];
  const previous = findWindowValue(
    series,
    new Date(current.observedAt).getTime(),
    days,
  );

  if (previous === null || previous === 0) {
    return {
      days,
      previousValue: previous,
      currentValue: current.value,
      change: previous === null ? null : current.value - previous,
      pct: null,
    };
  }

  const change = current.value - previous;
  return {
    days,
    previousValue: previous,
    currentValue: current.value,
    change,
    pct: Number((change / previous).toFixed(4)),
  };
}

function classifyTrend(args: {
  series: DemandPoint[];
  primaryPct: number | null;
  spike: boolean;
}): DemandTrend {
  if (args.series.length < 2) return "unknown";
  if (args.spike) return "surge";
  if (args.primaryPct === null) return "unknown";
  if (args.primaryPct <= -0.5) return "crash";
  if (args.primaryPct <= -0.15) return "falling";
  if (args.primaryPct >= 0.15) return "rising";
  return "flat";
}

function classifyStability(args: {
  series: DemandPoint[];
  spike: boolean;
  priorRising: boolean;
}): DemandStability {
  const values = args.series.map((point) => point.value);
  if (args.spike) return "spike";
  if (values.length < 3) return "unknown";
  if (args.priorRising) return "growing";
  if (varianceHigh(values)) return "unstable";
  if (values.length >= 90) return "seasonal";
  return "sustained";
}

export function analyzeDemandSeries(args: {
  points: DemandPoint[];
  socialMentions?: number | null;
  volumeUnit?: string | null;
}): DemandAnalysis {
  const series = uniqueDaily(
    args.points.filter((point) => asFinite(point.value) !== null),
  );
  const latest = series[series.length - 1] ?? null;
  const windows: DemandWindowChange[] = [
    windowChange(series, 7),
    windowChange(series, 14),
    windowChange(series, 30),
  ];

  const priorValues = series.slice(0, -1).map((point) => point.value);
  const priorMedian = median(priorValues);
  const previous = series.length >= 2 ? series[series.length - 2].value : null;
  const latestValue = latest?.value ?? null;
  const priorRising = generallyIncreasing(priorValues);

  const spikeFromMedian =
    latestValue !== null &&
    priorMedian !== null &&
    priorValues.length >= 3 &&
    latestValue >= priorMedian * 2.2;
  const spikeFromPrevious =
    latestValue !== null &&
    previous !== null &&
    previous > 0 &&
    latestValue / previous >= 2.5 &&
    !priorRising;
  const spike = spikeFromMedian || spikeFromPrevious;

  const primaryPct =
    [...windows].reverse().find((item) => item.pct !== null)?.pct ??
    (previous !== null && previous > 0 && latestValue !== null
      ? (latestValue - previous) / previous
      : null);

  const trend = classifyTrend({
    series,
    primaryPct,
    spike,
  });
  const stability = classifyStability({
    series,
    spike,
    priorRising,
  });

  const volume = latestValue;
  const social = asFinite(args.socialMentions ?? null);
  const scored = scoreFromKnown([
    {
      score: volume === null ? null : Math.max(0, Math.min(100, (volume / 1000) * 100)),
      weight: 0.34,
      confidence: volume === null ? 0 : 0.75,
    },
    {
      score:
        primaryPct === null
          ? null
          : Math.max(0, Math.min(100, 50 + primaryPct * 50)),
      weight: 0.28,
      confidence: primaryPct === null ? 0 : 0.7,
    },
    {
      score:
        social === null ? null : Math.max(0, Math.min(100, social / 1000)),
      weight: 0.12,
      confidence: social === null ? 0 : 0.6,
    },
    {
      score:
        stability === "unknown"
          ? null
          : stability === "growing" || stability === "sustained"
            ? 78
            : stability === "spike"
              ? 35
              : 40,
      weight: 0.16,
      confidence: stability === "unknown" ? 0 : 0.55,
    },
    {
      score: series.length >= 3 ? Math.min(100, series.length * 18) : null,
      weight: 0.1,
      confidence: series.length >= 3 ? 0.7 : 0,
    },
  ]);

  return {
    volume,
    volumeUnit: args.volumeUnit ?? null,
    windows,
    trend,
    stability,
    spike,
    demandScore: scored.score,
    demandConfidence: scored.confidence,
    socialMentions: social,
    observationCount: series.length,
    firstObservedAt: series[0]?.observedAt ?? null,
    lastObservedAt: latest?.observedAt ?? null,
    series: series.map((point) => ({
      observedAt: point.observedAt,
      value: point.value,
    })),
    evidence: {
      primary_pct: primaryPct,
      prior_median: priorMedian,
      prior_rising: priorRising,
      spike_from_median: spikeFromMedian,
      spike_from_previous: spikeFromPrevious,
      windows,
      social_mentions: social,
      unknown_not_zero: true,
    },
  };
}

export function demandTrendLabel(trend: DemandTrend): string {
  const labels: Record<DemandTrend, string> = {
    rising: "上昇",
    surge: "急上昇",
    flat: "横ばい",
    falling: "下降",
    crash: "急下降",
    unknown: "unknown",
  };
  return labels[trend];
}

export function demandStabilityLabel(stability: DemandStability): string {
  const labels: Record<DemandStability, string> = {
    sustained: "継続型",
    growing: "成長型",
    seasonal: "季節型",
    spike: "一時的急騰",
    unstable: "不安定",
    unknown: "unknown",
  };
  return labels[stability];
}

export function verifyDemandAnalysisInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const single = analyzeDemandSeries({
    points: [{ value: 2000, observedAt: "2026-09-21T00:00:00.000Z" }],
  });

  const rising = analyzeDemandSeries({
    points: [
      { value: 100, observedAt: "2026-08-22T00:00:00.000Z" },
      { value: 108, observedAt: "2026-08-29T00:00:00.000Z" },
      { value: 117, observedAt: "2026-09-05T00:00:00.000Z" },
      { value: 132, observedAt: "2026-09-12T00:00:00.000Z" },
      { value: 151, observedAt: "2026-09-21T00:00:00.000Z" },
    ],
  });

  const spike = analyzeDemandSeries({
    points: [
      { value: 100, observedAt: "2026-08-22T00:00:00.000Z" },
      { value: 120, observedAt: "2026-08-29T00:00:00.000Z" },
      { value: 135, observedAt: "2026-09-05T00:00:00.000Z" },
      { value: 310, observedAt: "2026-09-21T00:00:00.000Z" },
    ],
  });

  const noSocial = analyzeDemandSeries({
    points: [
      { value: 100, observedAt: "2026-09-14T00:00:00.000Z" },
      { value: 150, observedAt: "2026-09-21T00:00:00.000Z" },
    ],
    socialMentions: null,
  });

  const cases = [
    {
      name: "single_point_velocity_unknown",
      expected: true,
      actual:
        single.trend === "unknown" &&
        single.windows.every((item) => item.pct === null) &&
        single.volume === 2000,
    },
    {
      name: "sustained_rise_is_not_a_spike",
      expected: true,
      actual:
        rising.trend === "rising" &&
        rising.spike === false &&
        rising.stability === "growing",
    },
    {
      name: "one_off_jump_is_spike_not_sustained_growth",
      expected: true,
      actual: spike.spike === true && spike.stability === "spike",
    },
    {
      name: "missing_social_stays_unknown",
      expected: true,
      actual: noSocial.socialMentions === null,
    },
    {
      name: "percent_change_from_100_to_150_is_50",
      expected: true,
      actual: noSocial.windows.find((item) => item.days === 7)?.pct === 0.5,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
