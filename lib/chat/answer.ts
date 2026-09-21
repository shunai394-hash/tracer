import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini";
import type { ChatFacts, ChatLink } from "@/lib/chat/retrieve-context";
import { linksForFacts } from "@/lib/chat/retrieve-context";
import {
  demandStabilityLabel,
  demandTrendLabel,
  type DemandStability,
  type DemandTrend,
} from "@/lib/intelligence/analyze-demand";
import { formatConfidence, formatMoney, formatUnits } from "@/lib/intelligence/format-display";

export type ChatAnswer = {
  answer: string;
  intent: ChatFacts["intent"];
  missing: string[];
  confidence: string;
  usedData: string[];
  links: ChatLink[];
  facts: ChatFacts;
};

function unknownText(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function pct(value: number | null): string {
  if (value === null) return "unknown";
  return `${Math.round(value * 100)}%`;
}

function ruleBasedAnswer(facts: ChatFacts): string {
  const selected = facts.selected;
  const demand = facts.selectedDemand;
  const funnel = facts.funnel;

  if (facts.intent === "recommend_now" || facts.intent === "what_to_test") {
    if (facts.opportunities.length === 0) {
      return "現在取得できている商機データはありません。需要・供給・価格の実データが揃うまで推薦できません。";
    }
    const lines = facts.opportunities.slice(0, 3).map((item, index) => {
      const name = unknownText(item.product_name, "名称不明");
      return `${index + 1}. ${name}
需要: ${item.demand_trend ?? "unknown"} / volume ${item.demand_volume ?? "unknown"}
アイデンティティ: ${item.identity_confidence ?? "unknown"}
競合: ${item.competitor_count ?? "unknown"}件
利益: ${item.profit_calculable === true ? formatMoney(item.contribution_profit as number | null, item.market_currency as string | null) : "国内販売価格または仕入データ不足のため算出できません"}
販売予測30日: ${formatUnits(item.forecast_units_30d as number | null)}
検索適性: ${item.search_fit_score ?? "unknown"}
販売テスト: ${item.sellability_state ?? "unknown"}`;
    });
    return `現在取得できているデータでは、候補は以下です。\n\n${lines.join("\n\n")}\n\n需要が高いだけでは推薦していません。商品アイデンティティと供給が確認できた候補だけを並べています。`;
  }

  if (!selected && facts.intent !== "demand_analysis") {
    return "対象商品を特定できる実データがありません。商品名を含めて質問するか、先に Opportunity を生成してください。";
  }

  if (facts.intent === "demand_analysis") {
    if (!demand) {
      return "需要分析データはまだありません。Google Trends などから観測が溜まると、需要量・速度・トレンドを表示できます。";
    }
    return `需要「${demand.query}」
Demand Score: ${demand.demand_score ?? "unknown"}
Trend: ${demandTrendLabel((demand.trend as DemandTrend) ?? "unknown")}
Velocity 7日: ${pct(demand.velocity_7d as number | null)}
Volume: ${demand.volume ?? "unknown"}
Stability: ${demandStabilityLabel((demand.stability as DemandStability) ?? "unknown")}
Confidence: ${formatConfidence(demand.demand_confidence as number | null)}
SNS言及: ${demand.social_mentions ?? "unknown"}
観測期間: ${demand.last_observed_at ?? "unknown"}
急騰フラグ: ${demand.spike === true ? "あり（継続成長とは断定していません）" : "なし"}`;
  }

  const name = String(selected?.product_name ?? "この商品");

  if (facts.intent === "why_recommend") {
    const reasons = Array.isArray(selected?.recommendation_reasons)
      ? (selected?.recommendation_reasons as Array<{ statement?: string }>)
          .map((item) => item.statement)
          .filter(Boolean)
      : [];
    const priceMissing = selected?.market_price === null;
    return `${name} を見ている理由です。
${reasons.length > 0 ? reasons.map((item) => `・${item}`).join("\n") : "実データから言える推薦理由はまだありません。"}
検索需要: ${selected?.demand_volume ?? "unknown"} / ${selected?.demand_trend ?? "unknown"}
商品アイデンティティ: ${selected?.identity_confidence ?? "unknown"}
競合商品数: ${selected?.competitor_count ?? "unknown"}件
${priceMissing ? "ただし国内販売価格が取得できていないため、利益予測は unknown です。" : `利益計算: ${selected?.profit_calculable === true ? "可能" : "不能"}`}
信頼度: ${formatConfidence(selected?.overall_confidence as number | null)}`;
  }

  if (facts.intent === "forecast_units") {
    if (selected?.forecast_units_30d === null) {
      return `${name} は、現在のデータでは販売予測を算出できません。需要または実売履歴が不足しています。`;
    }
    return `${name} の説明可能な予測です。
7日: ${formatUnits(selected?.forecast_units_7d as number | null)}
30日: ${formatUnits(selected?.forecast_units_30d as number | null)}
予測売上: ${formatMoney(selected?.forecast_revenue_30d as number | null, selected?.market_currency as string | null)}
予測利益: ${formatMoney(selected?.forecast_profit_30d as number | null, selected?.market_currency as string | null)}
kind: ${selected?.forecast_kind ?? "unknown"}
信頼度: ${formatConfidence(selected?.forecast_confidence as number | null)}
これは観測販売数ではなく、${selected?.forecast_kind === "observed_run_rate" ? "実売ランレート" : "需要データからの推定"}です。`;
  }

  if (facts.intent === "profit") {
    if (!selected || selected.profit_calculable !== true) {
      return `${name} は、国内販売価格が取得できていない、または仕入・通貨データが不足しているため利益は算出できません。`;
    }
    return `${name} の利益データです。
市場価格: ${formatMoney(selected.market_price as number | null, selected.market_currency as string | null)}
仕入: ${formatMoney(selected.source_cost as number | null, selected.source_currency as string | null)}
推定粗利: ${formatMoney(selected.contribution_profit as number | null, selected.market_currency as string | null)}
粗利率: ${selected.contribution_margin ?? "unknown"}%
実測利益は販売テスト結果がある場合のみ別表示します。`;
  }

  if (facts.intent === "competition") {
    if (!selected || selected.competitor_count === null) {
      return `${name} の競合数は未観測です。競合が少ないとは判断していません。`;
    }
    return `${name} で現在取得できている競合商品数は ${selected.competitor_count} 件です。これは marketplace の観測出品数であり、検索コンテンツ量ではありません。`;
  }

  if (facts.intent === "why_not_test_ready") {
    const missing = Array.isArray(selected?.missing) ? selected.missing : [];
    return `${name} の sellability は ${selected?.sellability_state ?? "unknown"} です。
TEST_READY にならない理由として観測されている不足は、${missing.length > 0 ? missing.join(", ") : "データ品質ゲートの不足項目が記録されていません"} です。不足項目を推測では埋めていません。`;
  }

  if (facts.intent === "forecast_vs_actual") {
    if (!selected || selected.forecast_error_units_30d === null) {
      return `${name} は、予測と実績を比較できる実売データがまだありません。`;
    }
    return `${name} の予測誤差（実績-予測）は ${selected.forecast_error_units_30d} 個です。
予測30日: ${formatUnits(selected.forecast_units_30d as number | null)}
これは観測された販売テスト結果との差分です。`;
  }

  if (
    facts.intent === "sales_status" ||
    facts.intent === "cart_rate" ||
    facts.intent === "funnel_dropoff"
  ) {
    if (!funnel || funnel.observed !== true) {
      return `${name} の販売実績はまだありません。Impressions / Clicks / Cart / Purchase は販売テスト後に観測されます。`;
    }
    const base = `${name} の観測ファネルです。
Impressions: ${funnel.impressions ?? "unknown"}
Clicks: ${funnel.clicks ?? "unknown"}
CTR: ${funnel.ctr ?? "unknown"}
Product Views: ${funnel.product_views ?? "unknown"}
Add to Cart: ${funnel.add_to_cart ?? "unknown"}
ATC Rate: ${funnel.atc_rate ?? "unknown"}
Checkout: ${funnel.checkout ?? "unknown"}
Purchases: ${funnel.purchases ?? "unknown"}
Conversion Rate: ${funnel.conversion_rate ?? "unknown"}
Revenue: ${funnel.revenue ?? "unknown"}
Profit: ${funnel.profit ?? "unknown"}
対象テスト: ${funnel.test_id}
対象時刻: ${funnel.measured_at ?? "unknown"}`;

    if (
      facts.intent === "funnel_dropoff" &&
      asPositive(funnel.add_to_cart) &&
      (funnel.purchases === 0 || funnel.purchases === null)
    ) {
      return `${base}

観測事実: カート追加は確認できますが、購入は確認できていません。
原因は断定できません。価格・送料・購入導線などを確認する必要があります。`;
    }
    return base;
  }

  return `${name} について、現在参照できた実データは需要 ${selected?.demand_volume ?? "unknown"}、競合 ${selected?.competitor_count ?? "unknown"}、利益計算 ${selected?.profit_calculable === true ? "可能" : "不能"}、予測30日 ${formatUnits(selected?.forecast_units_30d as number | null)} です。足りない項目は unknown のままです。`;
}

function asPositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function usedData(facts: ChatFacts): string[] {
  const fields: string[] = [];
  if (facts.selected) fields.push("opportunity_intelligence");
  if (facts.demand.length > 0) fields.push("demand_intelligence");
  if (facts.funnel?.observed === true) fields.push("sales_test_results");
  if (facts.selected?.forecast_units_30d !== null) fields.push("product_sales_forecasts");
  return fields;
}

function numbersIn(text: string): string[] {
  return text.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

function inventedNumbers(answer: string, facts: ChatFacts): boolean {
  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  return numbersIn(answer).some((value) => !allowed.has(value));
}

export async function answerFromFacts(facts: ChatFacts): Promise<ChatAnswer> {
  const links = linksForFacts(facts);
  const fallback = ruleBasedAnswer(facts);
  let answer = fallback;

  if (isGeminiConfigured()) {
    try {
      const generated = await generateStructuredJson<{ answer?: string }>({
        systemInstruction:
          "You are TRACER's data-reading assistant. Reply in Japanese JSON {\"answer\":\"...\"}. Use ONLY the provided facts. If a field is null, say it is unavailable. Never invent demand, price, units, profit, or funnel numbers. Distinguish observed sales from estimated forecasts. Do not claim a cause; only organize observed facts.",
        prompt: JSON.stringify({
          intent: facts.intent,
          facts,
          task: "Explain the facts to help product selection. Include used data, missing data, and confidence when possible.",
        }),
        timeoutMs: 18_000,
      });
      if (typeof generated.answer === "string" && generated.answer.trim()) {
        if (!inventedNumbers(generated.answer, facts)) {
          answer = generated.answer.trim();
        }
      }
    } catch {
      answer = fallback;
    }
  }

  return {
    answer,
    intent: facts.intent,
    missing: facts.missing,
    confidence: facts.selected
      ? formatConfidence(facts.selected.overall_confidence as number | null)
      : facts.selectedDemand
        ? formatConfidence(facts.selectedDemand.demand_confidence as number | null)
        : "unknown",
    usedData: usedData(facts),
    links,
    facts,
  };
}
