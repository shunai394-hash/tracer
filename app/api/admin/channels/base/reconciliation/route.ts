import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ListingRow = {
  id: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  product_id: string | null;
  published: boolean | null;
  base_item_id: string | number | null;
  selling_price: number | string | null;
  supplier_name: string | null;
  supplier_listing_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | null;
  orderable: boolean | null;
  base_publication_status: string | null;
};

function normalizedTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizedImage(value: unknown): string {
  try {
    const url = new URL(String(value ?? ""));
    url.hash = "";
    // Keep query parameters: some supplier/CDN URLs use them to identify distinct image assets.
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function textTokens(value: unknown): string[] {
  const normalized = normalizedTitle(value);
  if (!normalized) return [];
  const text = String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja-JP");
  const tokens = text.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  // Japanese titles often contain no spaces. Add adjacent CJK bigrams so partial
  // overlaps remain measurable without treating a whole Japanese sentence as one token.
  const cjkRuns = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return [...new Set(tokens)];
}
function partialTitleScore(baseTitle: unknown, tracerTitle: unknown): number {
  const a = new Set(textTokens(baseTitle));
  const b = new Set(textTokens(tracerTitle));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const overlap = shared / Math.max(a.size, b.size);
  const compactA = normalizedTitle(String(baseTitle ?? ""));
  const compactB = normalizedTitle(String(tracerTitle ?? ""));
  const containment = compactA.length >= 4 && compactB.length >= 4 &&
    (compactA.includes(compactB) || compactB.includes(compactA));
  return Math.min(55, Math.round(Math.max(overlap, containment ? 0.85 : 0) * 55));
}

function visibility(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** Read-only reconciliation report. Candidates are evidence only and never auto-mapped. */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => null) as {
      snapshot?: { complete?: unknown; items?: unknown };
    } | null;
    const snapshotItems = body?.snapshot?.items;
    if (
      body?.snapshot?.complete !== true ||
      !Array.isArray(snapshotItems) ||
      snapshotItems.length < 1 ||
      snapshotItems.some((item) => !item || typeof item !== "object" || Array.isArray(item))
    ) {
      return NextResponse.json(
        { ok: false, error: "BASE_SNAPSHOT_INPUT_INCOMPLETE_OR_INVALID", complete: false },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const typedSnapshotItems = snapshotItems as Record<string, unknown>[];
    const ids = typedSnapshotItems.map((item) => String(item.item_id ?? ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return NextResponse.json(
        { ok: false, error: "BASE_SNAPSHOT_INPUT_ID_MISSING_OR_DUPLICATE", complete: false },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const db = createSupabaseAdminClient();
    const listings: ListingRow[] = [];
    const pageSize = 1000;
    let complete = false;

    for (let page = 0; page < 10; page += 1) {
      const from = page * pageSize;
      const { data, error } = await db
        .from("shop_listings")
        .select("id,title,description,image_url,product_id,published,base_item_id,selling_price,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,inventory,orderable,base_publication_status")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error("TRACER_LISTINGS_READ_FAILED");
      const rows = (data ?? []) as ListingRow[];
      listings.push(...rows);
      if (rows.length < pageSize) {
        complete = true;
        break;
      }
    }

    if (!complete) throw new Error("TRACER_LISTINGS_SCAN_INCOMPLETE");

    const byBaseId = new Map<string, ListingRow[]>();
    const byTitle = new Map<string, ListingRow[]>();
    for (const listing of listings) {
      const baseId = String(listing.base_item_id ?? "").trim();
      if (baseId) {
        const group = byBaseId.get(baseId) ?? [];
        group.push(listing);
        byBaseId.set(baseId, group);
      }
      const title = normalizedTitle(listing.title);
      if (title) {
        const group = byTitle.get(title) ?? [];
        group.push(listing);
        byTitle.set(title, group);
      }
    }

    const items = typedSnapshotItems.map((item) => {
      const baseItemId = String(item.item_id ?? "");
      const title = String(item.title ?? item.name ?? "");
      const key = normalizedTitle(title);
      const exactIdListings = byBaseId.get(baseItemId) ?? [];
      const titleCandidates = key ? (byTitle.get(key) ?? []) : [];
      const baseImage = normalizedImage(item.image_url ?? item.image ?? item.image_url_1);
      const baseSupplierProductId = String(item.supplier_product_id ?? item.supplierProductId ?? "").trim();
      const baseSupplierVariantId = String(item.supplier_variant_id ?? item.supplierVariantId ?? "").trim();
      const baseSpecs = String(item.detail ?? item.description ?? item.specification ?? "");
      const candidateScores = listings.map((row) => {
        const evidence: string[] = [];
        let score = 0;
        if (baseSupplierProductId && baseSupplierProductId === String(row.supplier_product_id ?? "").trim()) {
          score += 100; evidence.push("supplier_product_id_exact");
        }
        if (baseSupplierVariantId && baseSupplierVariantId === String(row.supplier_variant_id ?? "").trim()) {
          score += 100; evidence.push("supplier_variant_id_exact");
        }
        const candidateImage = normalizedImage(row.image_url);
        if (baseImage && candidateImage && baseImage === candidateImage) {
          score += 30; evidence.push("image_url_exact");
        }
        const titleScore = partialTitleScore(title, row.title);
        if (key && normalizedTitle(row.title) === key) {
          score += 70; evidence.push("title_exact");
        } else if (titleScore > 0) {
          score += titleScore; evidence.push("title_partial");
        }
        const specTokens = new Set(textTokens(baseSpecs));
        const listingTokens = new Set(textTokens(row.description));
        let specShared = 0;
        for (const token of specTokens) if (listingTokens.has(token)) specShared += 1;
        const specScore = specTokens.size ? Math.round((specShared / Math.max(specTokens.size, listingTokens.size || 1)) * 20) : 0;
        if (specScore > 0) { score += specScore; evidence.push("specification_overlap"); }
        return { row, score, evidence };
      }).filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
      const topScore = candidateScores[0]?.score ?? 0;
      const topCandidates = candidateScores.filter((candidate) => candidate.score === topScore);
      const reviewRequired = topCandidates.length > 1 || (topScore > 0 && topScore < 100);
      return {
        baseItemId,
        visible: visibility(item.visible),
        title,
        price: item.price ?? null,
        stock: item.stock ?? null,
        exactBaseIdMatchCount: exactIdListings.length,
        exactBaseIdMatches: exactIdListings.map((row) => ({
          listingId: row.id,
          title: row.title,
          published: row.published,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
        })),
        exactTitleCandidateCount: titleCandidates.length,
        exactTitleCandidates: titleCandidates.slice(0, 20).map((row) => ({
          listingId: row.id,
          title: row.title,
          productId: row.product_id,
          published: row.published,
          existingBaseItemId: row.base_item_id,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
          priceDifference: Number.isFinite(Number(item.price)) && Number.isFinite(Number(row.selling_price))
            ? Number(row.selling_price) - Number(item.price)
            : null,
        })),
        scoredCandidates: candidateScores.slice(0, 20).map(({ row, score, evidence }) => ({
          listingId: row.id,
          title: row.title,
          score,
          evidence,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          imageUrlMatches: Boolean(baseImage && normalizedImage(row.image_url) === baseImage),
          status: !reviewRequired && evidence.some((entry) => entry === "supplier_product_id_exact" || entry === "supplier_variant_id_exact")
            ? "HIGH_CONFIDENCE_CANDIDATE_NOT_AUTO_MAPPED"
            : "REVIEW_REQUIRED",
        })),
        candidateDecision: topCandidates.length > 1 ? "MULTIPLE_TOP_CANDIDATES_REVIEW_REQUIRED"
          : topScore > 0 ? "CANDIDATE_REVIEW_REQUIRED" : "NO_CANDIDATE",
      };
    });

    const exactMapped = items.filter((item) => item.exactBaseIdMatchCount === 1).length;
    const unmapped = items.filter((item) => item.exactBaseIdMatchCount === 0).length;
    const ambiguous = items.filter((item) => item.exactBaseIdMatchCount > 1).length;
    const titleCandidateCount = items.filter((item) => item.exactTitleCandidateCount > 0).length;
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      source: "BASE /items + TRACER shop_listings read-only reconciliation",
      complete: complete,
      baseItemCount: typedSnapshotItems.length,
      baseVisibleCount: typedSnapshotItems.filter((item) => visibility(item.visible) === true).length,
      baseHiddenCount: typedSnapshotItems.filter((item) => visibility(item.visible) === false).length,
      tracerListingCount: listings.length,
      exactBaseIdMappedCount: exactMapped,
      baseItemsWithoutExactMappingCount: unmapped,
      baseItemsWithAmbiguousExactMappingCount: ambiguous,
      baseItemsWithExactTitleCandidateCount: titleCandidateCount,
      baseItemsWithScoredCandidateCount: items.filter((item) => item.scoredCandidates.length > 0).length,
      baseItemsRequiringCandidateReviewCount: items.filter((item) => item.candidateDecision !== "NO_CANDIDATE").length,
      tracerListingsWithoutBaseItemIdCount: listings.filter((row) => !String(row.base_item_id ?? "").trim()).length,
      duplicateBaseItemIdGroupsInTracer: [...byBaseId.entries()].filter(([, rows]) => rows.length > 1).length,
      note: "Scored candidates are unverified evidence only. Ambiguous or partial matches require manual review. This report never writes mappings or changes BASE listings.",
      items,
    };
    const date = report.generatedAt.slice(0, 10);
    return new Response(JSON.stringify(report, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"tracer-base-reconciliation-" + date + ".json\"",
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_RECONCILIATION_FAILED";
    const stage = message.split(":")[0].slice(0, 100);
    console.error("[TRACER BASE RECONCILIATION FAILED]", { stage });
    return NextResponse.json(
      { ok: false, error: stage, complete: false },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
