import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

// Fixed review scope: the second batch of three known CJ variant families and their exact variant IDs.
// This endpoint is read-only and never accepts caller-supplied product IDs or URLs.
const TARGETS = [
  { pid: "2607241016071620500", vid: "2607241016071621300", sku: "CJYD300565901AZ", name: "Blue" },
  { pid: "2607241016071620500", vid: "2607241016071622300", sku: "CJYD300565902BY", name: "Blue / Green" },
  { pid: "2607241016071620500", vid: "2607241016071624300", sku: "CJYD300565904DW", name: "Yellow / Purple" },
  { pid: "2607241016071620500", vid: "2607241016071624800", sku: "CJYD300565905EV", name: "Khaki" },
  { pid: "2607241016071620500", vid: "2607241016071625500", sku: "CJYD300565906FU", name: "Pink" },

  { pid: "2610130715191608300", vid: "2610130715201600400", sku: "CJNS325262901AZ", name: "Variant 1" },
  { pid: "2610130715191608300", vid: "2610130715201600403", sku: "CJNS325262904DW", name: "White" },
  { pid: "2610130715191608300", vid: "2610130715201600404", sku: "CJNS325262905EV", name: "Red" },
  { pid: "2610130715191608300", vid: "2610130715201600405", sku: "CJNS325262906FU", name: "Blue" },
  { pid: "2610130715191608300", vid: "2610130715201600406", sku: "CJNS325262907GT", name: "Green" },

  { pid: "1541796973395849216", vid: "1541796973794308096", sku: "CJST151297001AZ", name: "White" },
  { pid: "1541796973395849216", vid: "1541796973819473920", sku: "CJST151297002BY", name: "Green" },
  { pid: "1541796973395849216", vid: "1541796973823668224", sku: "CJST151297003CX", name: "Blue" },
  { pid: "1541796973395849216", vid: "1541796973827862528", sku: "CJST151297004DW", name: "Orange" },
  { pid: "1541796973395849216", vid: "1541796973832056832", sku: "CJST151297005EV", name: "Black" },
] as const;

const ALLOWED_IMAGE_HOSTS = new Set([
  "cf.cjdropshipping.com",
  "oss-cf.cjdropshipping.com",
]);

function isAllowedImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
      !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const productIds = [...new Set(TARGETS.map((row) => row.pid))];
  const { data: offers, error: offersError } = await db
    .from("supplier_offers")
    .select("variant_id,supplier_product_id,supplier_variant_id")
    .eq("supplier_code", "cj")
    .in("supplier_product_id", productIds);

  if (offersError) {
    return NextResponse.json({ ok: false, error: "supplier_offer_read_failed" }, { status: 503 });
  }

  const expectedByVid = new Map<string, (typeof TARGETS)[number]>(TARGETS.map((row) => [row.vid, row]));
  const matchedOffers = (offers ?? []).filter((row) =>
    expectedByVid.has(String(row.supplier_variant_id)) &&
    expectedByVid.get(String(row.supplier_variant_id))?.pid === String(row.supplier_product_id),
  );
  const variantIds = [...new Set(matchedOffers.map((row) => String(row.variant_id)))];
  const { data: variants, error: variantsError } = await db
    .from("commerce_variants")
    .select("id,sku,title_ja,attributes")
    .in("id", variantIds);

  if (variantsError) {
    return NextResponse.json({ ok: false, error: "commerce_variant_read_failed" }, { status: 503 });
  }

  const variantsById = new Map((variants ?? []).map((row) => [String(row.id), row]));
  const rows = TARGETS.map((expected) => {
    const offer = matchedOffers.find((row) =>
      String(row.supplier_product_id) === expected.pid &&
      String(row.supplier_variant_id) === expected.vid,
    );
    const variant = offer ? variantsById.get(String(offer.variant_id)) : null;
    const attributes = variant?.attributes && typeof variant.attributes === "object"
      ? variant.attributes as Record<string, unknown>
      : {};
    const imageUrl = attributes.variantImageUrl;
    const identityVerified = attributes.variantImageIdentityVerified === true;
    const exactSku = variant?.sku === expected.sku;
    const safeUrl = isAllowedImageUrl(imageUrl);

    return {
      supplierProductId: expected.pid,
      supplierVariantId: expected.vid,
      variantName: expected.name,
      sku: expected.sku,
      title: variant?.title_ja ?? null,
      exactSku,
      identityVerified,
      hasImage: safeUrl,
      imageUrl: safeUrl ? imageUrl : null,
      colorImageVerified: attributes.colorImageVerified === true,
    };
  });

  const complete = rows.length === TARGETS.length &&
    rows.every((row) => row.exactSku && row.identityVerified && row.hasImage) &&
    new Set(rows.map((row) => row.supplierProductId + "|" + row.imageUrl)).size === rows.length;

  return NextResponse.json({
    ok: complete,
    readOnly: true,
    targetProductCount: productIds.length,
    checked: rows.length,
    exactSkuCount: rows.filter((row) => row.exactSku).length,
    identityVerifiedCount: rows.filter((row) => row.identityVerified).length,
    imageCount: rows.filter((row) => row.hasImage).length,
    rows,
  }, { status: complete ? 200 : 207 });
}
