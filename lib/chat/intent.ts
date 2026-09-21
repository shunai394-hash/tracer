export type ChatIntent =
  | "recommend_now"
  | "why_recommend"
  | "forecast_units"
  | "profit"
  | "competition"
  | "cart_rate"
  | "forecast_vs_actual"
  | "why_not_test_ready"
  | "what_to_test"
  | "sales_status"
  | "funnel_dropoff"
  | "demand_analysis"
  | "general";

const RULES: Array<{ intent: ChatIntent; pattern: RegExp }> = [
  { intent: "recommend_now", pattern: /おすすめ|今売る|今売|候補|何がいい|which product|recommend/i },
  { intent: "what_to_test", pattern: /テストすべき|販売テスト|test ready|どれをテスト/i },
  { intent: "why_not_test_ready", pattern: /test_ready|TEST_READY|ならない|なぜ.*テスト/i },
  { intent: "why_recommend", pattern: /なぜおすすめ|なんでおすすめ|理由|why/i },
  { intent: "forecast_units", pattern: /何個|売れそう|販売予測|forecast|units/i },
  { intent: "profit", pattern: /利益|粗利|いくら|margin|profit/i },
  { intent: "competition", pattern: /競合|ライバル|competition/i },
  { intent: "cart_rate", pattern: /カート|atc|add to cart/i },
  { intent: "forecast_vs_actual", pattern: /予測と実績|誤差|どれくらい違う|vs actual/i },
  { intent: "funnel_dropoff", pattern: /カート.*購入|購入されない|なぜ.*買わ|離脱/i },
  { intent: "sales_status", pattern: /販売状況|売れてる|実績|impressions|クリック|購入/i },
  { intent: "demand_analysis", pattern: /需要|トレンド|急上|velocity|demand/i },
];

export function classifyChatIntent(message: string): ChatIntent {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) return rule.intent;
  }
  return "general";
}
