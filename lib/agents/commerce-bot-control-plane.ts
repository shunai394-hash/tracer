/**
 * TRACER commerce-bot control plane.
 *
 * This registry is intentionally descriptive: it never claims a live check has
 * run just because credentials exist. Channel writes remain in the existing,
 * individually authenticated adapters and cron routes.
 */

export type CommerceBotId =
  | "main"
  | "product-monitor"
  | "japanese-copy"
  | "channel-sync"
  | "qa";

export type CommerceBotStatus = "configured" | "needs-configuration" | "route-backed" | "read-only-foundation";

export type CommerceBotDefinition = {
  id: CommerceBotId;
  name: string;
  responsibility: string;
  mode: "orchestrator" | "monitor" | "transform" | "reconcile" | "quality";
  existingRoutes: string[];
  requiredEnvironment: string[];
  writesExternalSystems: boolean;
  approvalGate: string;
};

export const COMMERCE_BOTS: readonly CommerceBotDefinition[] = [
  {
    id: "main",
    name: "Main Bot",
    responsibility: "全体進捗、優先順位、停止条件、各Botの結果を集約する",
    mode: "orchestrator",
    existingRoutes: ["/api/cron/patrol-ai"],
    requiredEnvironment: ["CRON_SECRET"],
    writesExternalSystems: false,
    approvalGate: "各Botの実測結果を確認し、危険度順に提案する。Main Bot単独では販売チャネルへ書き込まない。",
  },
  {
    id: "product-monitor",
    name: "商品監視Bot",
    responsibility: "仕入商品ID・バリエーションID・仕入価格・国内送料・在庫・追跡可否の変化を検知する",
    mode: "monitor",
    existingRoutes: ["/api/cron/supply-first", "/api/cron/inventory-refresh"],
    requiredEnvironment: ["CRON_SECRET", "SUPABASE_URL"],
    writesExternalSystems: false,
    approvalGate: "商品名だけで同一判定しない。識別子や根拠が欠ける場合は公開・再入荷を保留する。",
  },
  {
    id: "japanese-copy",
    name: "日本語化Bot",
    responsibility: "商品名・説明文の日本語品質、誇大表現、欠落属性を検査する",
    mode: "transform",
    existingRoutes: ["/api/cron/base-japanese-copy"],
    requiredEnvironment: ["CRON_SECRET"],
    writesExternalSystems: true,
    approvalGate: "翻訳候補の生成と外部更新を分離し、更新後の再取得確認ができない商品は成功扱いにしない。",
  },
  {
    id: "channel-sync",
    name: "同期Bot",
    responsibility: "TRACERを正本としてBASE・Shopify・NEWFINDのSKU/外部ID/価格/在庫/公開状態を照合する",
    mode: "reconcile",
    existingRoutes: ["/api/admin/shopify/reconcile", "/api/cron/shopify-publish", "/api/cron/newfind-retry"],
    requiredEnvironment: ["CRON_SECRET"],
    writesExternalSystems: true,
    approvalGate: "まず読み取り照合。書き込みは不一致の根拠、対象ID、変更前後、冪等キーが確認できる場合のみ。",
  },
  {
    id: "qa",
    name: "QA Bot",
    responsibility: "テスト、実測結果、チャネル間不一致、同期後の再確認を集約する",
    mode: "quality",
    existingRoutes: ["/api/health", "/api/admin/shopify/reconcile"],
    requiredEnvironment: [],
    writesExternalSystems: false,
    approvalGate: "コード実装・CI成功・デプロイ・外部実データ検証を別々の状態として報告する。",
  },
] as const;

export type CommerceBotEnvironment = Record<string, string | undefined>;

export function getCommerceBotStatus(
  bot: CommerceBotDefinition,
  env: CommerceBotEnvironment,
): CommerceBotStatus {
  if (bot.id === "qa") return "read-only-foundation";
  const missing = bot.requiredEnvironment.filter((key) => !env[key]?.trim());
  if (missing.length > 0) return "needs-configuration";
  return bot.existingRoutes.length > 0 ? "route-backed" : "configured";
}

export function buildCommerceBotStatusReport(env: CommerceBotEnvironment) {
  const bots = COMMERCE_BOTS.map((bot) => ({
    ...bot,
    status: getCommerceBotStatus(bot, env),
    missingEnvironment: bot.requiredEnvironment.filter((key) => !env[key]?.trim()),
    executionClaim: "not-run",
  }));

  const blockers = bots.flatMap((bot) =>
    bot.missingEnvironment.map((key) => ({
      botId: bot.id,
      severity: key === "CRON_SECRET" ? "high" as const : "medium" as const,
      code: "MISSING_CONFIGURATION",
      detail: `${bot.name}: ${key} が未設定です。`,
    })),
  );

  return {
    service: "tracer-commerce-bot-control-plane",
    mode: "read-only-status",
    sourceOfTruth: "TRACER",
    channels: ["BASE", "Shopify", "NEWFIND"],
    externalWritesEnabledByThisEndpoint: false,
    bots,
    blockers,
    guardrails: [
      "商品名のみの照合でレコードを結合しない",
      "仕入商品ID・バリエーションID・チャネルID・SKUを優先する",
      "原価または日本向け送料が不明・ゼロの場合は販売可と判定しない",
      "公開条件は在庫・日本配送・追跡可否・利益率の根拠を要求する",
      "読み取り監査と外部更新を分離し、更新後は再取得して検証する",
      "このエンドポイントの応答だけで同期成功や本番検証済みとは判定しない",
    ],
    generatedAt: new Date().toISOString(),
  };
}
