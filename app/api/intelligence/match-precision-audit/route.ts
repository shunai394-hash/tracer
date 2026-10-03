import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { detectProductIntent } from "@/lib/intelligence/match-demand-products";
import {
  isStrongDemandMatch,
  readObservationIdentifiers,
  resolveMatchMethod,
  variantsCompatible,
} from "@/lib/intelligence/demand-match-evidence";

export const runtime = "nodejs";
export const maxDuration = 60;

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Row = Record<string, unknown>;
type Verdict = "PASS" | "FAIL" | "MISSING" | "AMBIGUOUS";

const IDENTIFIER_IDENTITY_METHODS = new Set(["asin", "jan", "gtin", "ean", "upc", "brand_mpn"]);

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

async function count(db: Db, table: string, filter?: (q: ReturnType<ReturnType<Db["from"]>["select"]>) => ReturnType<ReturnType<Db["from"]>["select"]>) {
  const base = db.from(table).select("*", { count: "exact", head: true });
  const { count: value, error } = await (filter ? filter(base) : base);
  return error ? `error: ${error.message}` : value ?? 0;
}

async function all(db: Db, table: string, columns: string, limit = 5000): Promise<{ rows: Row[]; error: string | null }> {
  const { data, error } = await db.from(table).select(columns).limit(limit);
  return { rows: (data ?? []) as unknown as Row[], error: error?.message ?? null };
}

/**
 * Read-only precision audit of Demand -> Identity -> Market -> Supply ->
 * Inventory -> Margin -> TEST_READY. Every verdict is derived from stored
 * rows; nothing is inferred or written.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();

  const counts = Object.fromEntries(await Promise.all(Object.entries({
    demand_observations: count(db, "demand_observations"),
    demand_observations_unbound: count(db, "demand_observations", (q) => q.is("product_id", null)),
    demand_product_matches: count(db, "demand_product_matches"),
    demand_product_candidates: count(db, "demand_product_candidates"),
    opportunity_intelligence: count(db, "opportunity_intelligence"),
    opportunity_test_ready: count(db, "opportunity_intelligence", (q) => q.eq("sellability_state", "TEST_READY")),
    supplier_listings: count(db, "supplier_listings"),
    supplier_listings_verified: count(db, "supplier_listings", (q) => q.eq("verification_status", "verified")),
    supplier_listings_verified_supply: count(db, "supplier_listings", (q) =>
      q.eq("verification_status", "verified").eq("inventory_confirmed", true).eq("orderable", true).gt("inventory", 0)),
    product_offers: count(db, "product_offers"),
    product_offers_cj: count(db, "product_offers", (q) => q.eq("seller_name", "CJdropshipping")),
    shop_listings: count(db, "shop_listings"),
  }).map(async ([key, value]) => [key, await value] as const)));

  const [matchesQ, observationsQ, productsQ, listingsQ, oiQ, candidatesQ, cronQ] = await Promise.all([
    all(db, "demand_product_matches", "demand_observation_id, product_id, match_method, match_score, rationale, created_at"),
    db.from("demand_observations").select("id, product_id, signal_type, value, observed_at, metadata")
      .is("product_id", null).in("signal_type", ["search_volume", "search_result_count"])
      .order("observed_at", { ascending: false }).limit(300),
    all(db, "product_intelligence", "product_id, normalized_title"),
    all(db, "supplier_listings", "id, supplier, product_id, identity_method, identity_status, verification_status, inventory_confirmed, orderable, inventory, shipping_cost, cost, currency"),
    db.from("opportunity_intelligence")
      .select("product_id, product_name, sellability_state, lifecycle_status, opportunity_score, profit_calculable, contribution_margin, market_price, source_cost, metadata")
      .order("opportunity_score", { ascending: false, nullsFirst: false }).limit(200),
    all(db, "demand_product_candidates", "demand_observation_id, query, status"),
    db.from("cron_runs").select("job_name, status, started_at, finished_at, error").order("started_at", { ascending: false }).limit(500),
  ]);

  const titleByProduct = new Map(productsQ.rows.map((row) => [String(row.product_id), String(row.normalized_title ?? "")]));
  const matchesByObservation = new Map<string, Row[]>();
  const strongMatchesByProduct = new Map<string, number>();
  const methodCounts: Record<string, number> = {};
  for (const match of matchesQ.rows) {
    const method = resolveMatchMethod(match);
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    const list = matchesByObservation.get(String(match.demand_observation_id)) ?? [];
    list.push(match);
    matchesByObservation.set(String(match.demand_observation_id), list);
    if (isStrongDemandMatch(match)) {
      strongMatchesByProduct.set(String(match.product_id), (strongMatchesByProduct.get(String(match.product_id)) ?? 0) + 1);
    }
  }
  const candidateObservations = new Set(candidatesQ.rows.map((row) => String(row.demand_observation_id)));

  // A. Demand observation trace (why a row did or did not become a match).
  const observations = (observationsQ.data ?? []) as Row[];
  const reasonCounts: Record<string, number> = {};
  const demandTrace = observations.map((obs) => {
    const metadata = record(obs.metadata);
    const query = typeof metadata.query === "string" ? metadata.query : "";
    const ids = readObservationIdentifiers(metadata);
    const intent = detectProductIntent(query);
    const matches = matchesByObservation.get(String(obs.id)) ?? [];
    const strong = matches.filter((m) => isStrongDemandMatch(m));
    const reason = strong.length > 0
      ? "strong_match"
      : matches.length > 0
        ? "weak_match_only"
        : candidateObservations.has(String(obs.id))
          ? "candidate_created_no_product"
          : !ids.gtin && !ids.model
            ? intent.isProduct ? "product_intent_without_identifier_or_title_hit" : `not_product:${intent.reason}`
            : "identifier_without_market_product";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    return {
      observation_id: obs.id,
      query,
      provider: metadata.provider ?? null,
      signal_type: obs.signal_type,
      identifiers: { gtin: ids.gtin, model: ids.model, brand: ids.brand },
      intent: intent.reason,
      matches: matches.map((m) => ({ product_id: m.product_id, method: resolveMatchMethod(m), title: titleByProduct.get(String(m.product_id)) ?? null })),
      verdict: (strong.length > 0 ? "PASS" : matches.length > 0 ? "AMBIGUOUS" : "MISSING") as Verdict,
      reason,
    };
  });

  // B. False-positive check over stored matches: query vs product title.
  const fpCheck = matchesQ.rows.slice(0, 60).map((match) => {
    const observation = observations.find((obs) => String(obs.id) === String(match.demand_observation_id));
    const query = String(record(observation?.metadata).query ?? "");
    const title = titleByProduct.get(String(match.product_id)) ?? "";
    const variant = query && title ? variantsCompatible(query, title) : null;
    const method = resolveMatchMethod(match);
    return {
      query,
      title,
      method,
      strong: isStrongDemandMatch(match),
      variant_conflicts: variant?.conflicts ?? null,
      // A weak match is never identity; it is listed so a human can see what
      // the old 0.9 keyword score would have accepted.
      classification: isStrongDemandMatch(match) ? "exact" : variant && !variant.compatible ? "false_positive_blocked" : "weak_not_identity",
    };
  });

  // C. Product trace through every stage.
  const listingsByProduct = new Map<string, Row[]>();
  for (const listing of listingsQ.rows) {
    if (!listing.product_id) continue;
    const list = listingsByProduct.get(String(listing.product_id)) ?? [];
    list.push(listing);
    listingsByProduct.set(String(listing.product_id), list);
  }
  const oiRows = (oiQ.data ?? []) as Row[];
  const withListing = oiRows.filter((row) => listingsByProduct.has(String(row.product_id)));
  const sample = [...withListing.slice(0, 6), ...oiRows.filter((row) => !listingsByProduct.has(String(row.product_id))).slice(0, 2)];
  const productTrace = sample.map((row) => {
    const productId = String(row.product_id);
    const listings = listingsByProduct.get(productId) ?? [];
    const identifierLinked = listings.filter((l) => l.identity_status === "linked" && IDENTIFIER_IDENTITY_METHODS.has(String(l.identity_method ?? "")));
    const verified = identifierLinked.filter((l) => l.verification_status === "verified");
    const inventoryConfirmed = verified.filter((l) => l.inventory_confirmed === true && typeof l.inventory === "number");
    const inStock = inventoryConfirmed.filter((l) => Number(l.inventory) > 0 && l.orderable === true);
    const strong = strongMatchesByProduct.get(productId) ?? 0;
    const stages: Record<string, Verdict> = {
      demand: strong > 0 ? "PASS" : (matchesQ.rows.some((m) => String(m.product_id) === productId) ? "AMBIGUOUS" : "MISSING"),
      identity: identifierLinked.length > 0 ? "PASS" : listings.length > 0 ? "AMBIGUOUS" : "MISSING",
      market: row.market_price !== null && row.market_price !== undefined ? "PASS" : "MISSING",
      cj: listings.some((l) => l.supplier === "cj") ? "PASS" : listings.length > 0 ? "PASS" : "MISSING",
      verified_supply: verified.length > 0 ? "PASS" : listings.length > 0 ? "FAIL" : "MISSING",
      inventory: inStock.length > 0 ? "PASS" : inventoryConfirmed.length > 0 ? "FAIL" : "MISSING",
      margin: row.profit_calculable === true ? (Number(row.contribution_margin) > 0 ? "PASS" : "FAIL") : "MISSING",
      test_ready: row.sellability_state === "TEST_READY" ? "PASS" : "FAIL",
    };
    return {
      product_id: productId,
      name: row.product_name ?? titleByProduct.get(productId) ?? null,
      sellability_state: row.sellability_state,
      lifecycle_status: row.lifecycle_status,
      missing: record(row.metadata).missing ?? null,
      listings: listings.map((l) => ({
        supplier: l.supplier, identity_method: l.identity_method, identity_status: l.identity_status,
        verification_status: l.verification_status, inventory_confirmed: l.inventory_confirmed,
        orderable: l.orderable, inventory: l.inventory, shipping_cost: l.shipping_cost,
      })),
      strong_demand_matches: strong,
      stages,
    };
  });

  // D. CJ inventory/orderability states (unknown is kept separate).
  const cj = listingsQ.rows.filter((l) => l.supplier === "cj");
  const cjInventory = {
    total: cj.length,
    inventory_unknown: cj.filter((l) => l.inventory === null || l.inventory === undefined || l.inventory_confirmed !== true).length,
    inventory_confirmed: cj.filter((l) => l.inventory_confirmed === true).length,
    confirmed_in_stock_orderable: cj.filter((l) => l.inventory_confirmed === true && Number(l.inventory) > 0 && l.orderable === true).length,
    confirmed_out_of_stock: cj.filter((l) => l.inventory_confirmed === true && l.inventory === 0).length,
    orderable_true: cj.filter((l) => l.orderable === true).length,
    orderable_unknown: cj.filter((l) => l.orderable === null || l.orderable === undefined).length,
    identity_methods: cj.reduce<Record<string, number>>((acc, l) => {
      const key = `${l.identity_method ?? "null"}/${l.identity_status ?? "null"}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };

  // E. Latest run per cron job.
  const cronLatest: Record<string, Row> = {};
  for (const run of (cronQ.data ?? []) as Row[]) {
    const job = String(run.job_name);
    if (!cronLatest[job]) cronLatest[job] = { status: run.status, started_at: run.started_at, finished_at: run.finished_at, error: run.error };
  }

  const sellability: Record<string, number> = {};
  for (const row of oiRows) sellability[String(row.sellability_state)] = (sellability[String(row.sellability_state)] ?? 0) + 1;

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    deployment: { commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
    counts,
    readErrors: [matchesQ.error, observationsQ.error?.message, productsQ.error, listingsQ.error, oiQ.error?.message, candidatesQ.error, cronQ.error?.message].filter(Boolean),
    matchMethods: methodCounts,
    demandReasonCounts: reasonCounts,
    demandTrace: demandTrace.slice(0, 15),
    falsePositiveCheck: fpCheck,
    productTrace,
    topSellabilityStates: sellability,
    cjInventory,
    cronLatest,
  });
}
