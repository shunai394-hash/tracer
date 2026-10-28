export type SalesChannel = "BASE" | "Shopify" | "NEWFIND";

export type ChannelSnapshot = {
  externalProductId: string | null;
  externalVariantId?: string | null;
  sku: string | null;
  sellingPrice: number | null;
  stock: number | null;
  published: boolean | null;
  observedAt: string | null;
};

export type OperationsProductSnapshot = {
  tracerProductId: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  sku: string | null;
  title: string | null;
  description: string | null;
  supplierCost: number | null;
  japanShippingCost: number | null;
  sellingPrice: number | null;
  stock: number | null;
  trackingAvailable: boolean | null;
  shouldBePublic: boolean | null;
  updatedAt: string | null;
  channels: Partial<Record<SalesChannel, ChannelSnapshot>>;
};

export type BotFinding = {
  bot: "product_monitor" | "japanese_copy" | "channel_sync" | "qa";
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  productKey: string | null;
  channels: SalesChannel[];
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  requiresHumanApproval: boolean;
};

export type BotTask = {
  owner: "product_monitor" | "japanese_copy" | "channel_sync" | "qa";
  priority: number;
  productKey: string | null;
  reason: string;
  readOnly: true;
};

export type ReadOnlyOperationsReport = {
  mode: "read-only";
  generatedAt: string;
  productCount: number;
  findingCount: number;
  findings: BotFinding[];
  tasks: BotTask[];
  blockedCount: number;
};

const CHANNELS: SalesChannel[] = ["BASE", "Shopify", "NEWFIND"];
const hasJapanese = (value: string | null): boolean =>
  typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
const validPositiveNumber = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const validNonNegativeNumber = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function productKey(product: OperationsProductSnapshot): string | null {
  if (!product.tracerProductId || !product.supplierProductId || !product.supplierVariantId) return null;
  return [product.tracerProductId, product.supplierProductId, product.supplierVariantId].join(":");
}

function priorityFor(finding: BotFinding): number {
  const severity = { critical: 100, high: 75, medium: 45, low: 20 }[finding.severity];
  const botWeight = { product_monitor: 5, japanese_copy: 0, channel_sync: 10, qa: 15 }[finding.bot];
  return severity + botWeight;
}

/**
 * Deterministic read-only multi-bot orchestrator.
 * It produces findings and proposed tasks only; it has no DB/client/network/write API.
 * Product matching uses stable IDs and never falls back to titles.
 */
export function runReadOnlyOperationsBots(args: {
  products: OperationsProductSnapshot[];
  previousProducts?: OperationsProductSnapshot[];
  generatedAt?: string;
}): ReadOnlyOperationsReport {
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const findings: BotFinding[] = [];
  const previousByKey = new Map<string, OperationsProductSnapshot>();
  for (const previous of args.previousProducts ?? []) {
    const key = productKey(previous);
    if (key) previousByKey.set(key, previous);
  }

  const keyCounts = new Map<string, number>();
  for (const product of args.products) {
    const key = productKey(product);
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  for (const product of args.products) {
    const key = productKey(product);
    const channels = CHANNELS.filter((channel) => product.channels[channel]);
    if (!key) {
      findings.push({
        bot: "qa", code: "IDENTITY_INCOMPLETE", severity: "critical", productKey: null,
        channels, message: "TRACER・仕入先商品・仕入先バリエーションの識別IDが揃わないため、商品照合を停止しました。",
        evidence: { tracerProductId: product.tracerProductId, supplierProductId: product.supplierProductId, supplierVariantId: product.supplierVariantId },
        requiresHumanApproval: true,
      });
      continue;
    }
    if ((keyCounts.get(key) ?? 0) > 1) {
      findings.push({
        bot: "qa", code: "DUPLICATE_STABLE_IDENTITY", severity: "critical", productKey: key,
        channels, message: "同一の安定識別IDが複数行に存在します。タイトルによる自動統合はせず、確認が必要です。",
        evidence: { occurrences: keyCounts.get(key) },
        requiresHumanApproval: true,
      });
    }

    if (!validPositiveNumber(product.sellingPrice)) {
      findings.push({
        bot: "qa", code: "SELLING_PRICE_INVALID", severity: "high", productKey: key,
        channels, message: "販売価格が未設定または不正です。販売状態の変更は行わず確認対象にしました。",
        evidence: { sellingPrice: product.sellingPrice }, requiresHumanApproval: true,
      });
    }
    if (!validNonNegativeNumber(product.supplierCost) || !validNonNegativeNumber(product.japanShippingCost)) {
      findings.push({
        bot: "product_monitor", code: "SUPPLIER_COST_OR_SHIPPING_UNKNOWN", severity: "high", productKey: key,
        channels, message: "仕入原価または日本向け送料が未確認です。利益判定を確定できません。",
        evidence: { supplierCostKnown: validNonNegativeNumber(product.supplierCost), japanShippingCostKnown: validNonNegativeNumber(product.japanShippingCost) },
        requiresHumanApproval: true,
      });
    }
    if (product.stock === null || !Number.isFinite(product.stock) || product.stock < 0) {
      findings.push({
        bot: "product_monitor", code: "STOCK_UNKNOWN", severity: "high", productKey: key,
        channels, message: "在庫が未確認または不正です。自動補充・公開判断を行いません。",
        evidence: { stock: product.stock }, requiresHumanApproval: true,
      });
    }

    if (!hasJapanese(product.title) || !product.title?.trim()) {
      findings.push({
        bot: "japanese_copy", code: "TITLE_NEEDS_JAPANESE_REVIEW", severity: "medium", productKey: key,
        channels, message: "商品名に日本語が確認できません。自動公開せず、日本語化候補としてレビュー対象にしました。",
        evidence: { titlePresent: Boolean(product.title?.trim()), hasJapaneseTitle: hasJapanese(product.title) },
        requiresHumanApproval: true,
      });
    }
    if (!hasJapanese(product.description) || !product.description?.trim()) {
      findings.push({
        bot: "japanese_copy", code: "DESCRIPTION_NEEDS_JAPANESE_REVIEW", severity: "medium", productKey: key,
        channels, message: "商品説明に日本語が確認できないか、空欄です。原文の根拠を保った翻訳が必要です。",
        evidence: { descriptionPresent: Boolean(product.description?.trim()), hasJapaneseDescription: hasJapanese(product.description) },
        requiresHumanApproval: true,
      });
    }

    const previous = previousByKey.get(key);
    if (previous) {
      if (previous.sellingPrice !== product.sellingPrice) {
        findings.push({
          bot: "product_monitor", code: "SELLING_PRICE_CHANGED", severity: "medium", productKey: key,
          channels, message: "前回スナップショットからTRACER販売価格が変化しました。",
          evidence: { previous: previous.sellingPrice, current: product.sellingPrice },
          requiresHumanApproval: true,
        });
      }
      if (previous.stock !== product.stock) {
        findings.push({
          bot: "product_monitor", code: "STOCK_CHANGED", severity: "medium", productKey: key,
          channels, message: "前回スナップショットからTRACER在庫が変化しました。",
          evidence: { previous: previous.stock, current: product.stock },
          requiresHumanApproval: true,
        });
      }
      if (previous.supplierCost !== product.supplierCost || previous.japanShippingCost !== product.japanShippingCost) {
        findings.push({
          bot: "product_monitor", code: "LANDED_COST_CHANGED", severity: "high", productKey: key,
          channels, message: "仕入原価または日本向け送料が変化しました。利益率を再計算する必要があります。",
          evidence: {
            previousSupplierCost: previous.supplierCost, currentSupplierCost: product.supplierCost,
            previousJapanShipping: previous.japanShippingCost, currentJapanShipping: product.japanShippingCost,
          }, requiresHumanApproval: true,
        });
      }
    }

    for (const channel of CHANNELS) {
      const snapshot = product.channels[channel];
      if (!snapshot) continue;
      if (!snapshot.externalProductId || !snapshot.sku || !product.sku || snapshot.sku !== product.sku) {
        findings.push({
          bot: "channel_sync", code: "CHANNEL_IDENTITY_MISMATCH", severity: "high", productKey: key,
          channels: [channel], message: "チャネルの商品IDまたはSKUが未確認・不一致です。商品名では補完しません。",
          evidence: { channelSku: snapshot.sku, tracerSku: product.sku, externalProductIdPresent: Boolean(snapshot.externalProductId) },
          requiresHumanApproval: true,
        });
      }
      if (snapshot.sellingPrice === null || snapshot.sellingPrice !== product.sellingPrice) {
        findings.push({
          bot: "channel_sync", code: "CHANNEL_PRICE_MISMATCH", severity: "high", productKey: key,
          channels: [channel], message: "チャネル価格とTRACER基準価格が一致していません。",
          evidence: { channelPrice: snapshot.sellingPrice, tracerPrice: product.sellingPrice },
          requiresHumanApproval: true,
        });
      }
      if (snapshot.stock === null || snapshot.stock !== product.stock) {
        findings.push({
          bot: "channel_sync", code: "CHANNEL_STOCK_MISMATCH", severity: "high", productKey: key,
          channels: [channel], message: "チャネル在庫とTRACER基準在庫が一致していません。",
          evidence: { channelStock: snapshot.stock, tracerStock: product.stock },
          requiresHumanApproval: true,
        });
      }
      if (snapshot.published === null || snapshot.published !== product.shouldBePublic) {
        findings.push({
          bot: "channel_sync", code: "CHANNEL_PUBLICATION_MISMATCH", severity: "high", productKey: key,
          channels: [channel], message: "チャネル公開状態とTRACERの公開可否が一致していません。",
          evidence: { channelPublished: snapshot.published, shouldBePublic: product.shouldBePublic },
          requiresHumanApproval: true,
        });
      }
    }
  }

  const tasksByKey = new Map<string, BotTask>();
  for (const finding of findings) {
    const owner = finding.bot;
    const key = `${owner}:${finding.productKey ?? "global"}`;
    const task: BotTask = {
      owner, priority: priorityFor(finding), productKey: finding.productKey,
      reason: finding.message, readOnly: true,
    };
    const existing = tasksByKey.get(key);
    if (!existing || existing.priority < task.priority) tasksByKey.set(key, task);
  }
  const tasks = [...tasksByKey.values()].sort((a, b) => b.priority - a.priority);
  return {
    mode: "read-only",
    generatedAt,
    productCount: args.products.length,
    findingCount: findings.length,
    findings,
    tasks,
    blockedCount: findings.filter((finding) => finding.requiresHumanApproval).length,
  };
}
