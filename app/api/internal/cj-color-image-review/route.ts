import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

// Fixed review scope: three known color families and their exact CJ variant IDs.
// This endpoint is read-only and never accepts caller-supplied product IDs or URLs.
const TARGETS = [
  { pid: "1454782204398931968", vid: "1454782204449263616", sku: "CJNS133704001AZ", name: "Blue" },
  { pid: "1454782204398931968", vid: "1454782204453457920", sku: "CJNS133704002BY", name: "Green" },
  { pid: "1454782204398931968", vid: "1454782204457652224", sku: "CJNS133704003CX", name: "Orange" },
  { pid: "1454782204398931968", vid: "1454782204461846528", sku: "CJNS133704004DW", name: "Black" },
  { pid: "1454782204398931968", vid: "1454782204466040832", sku: "CJNS133704005EV", name: "Gray" },

  { pid: "2606090341151608200", vid: "2606090341151608900", sku: "CJNS292694701AZ", name: "Blue" },
  { pid: "2606090341151608200", vid: "2606090341151609400", sku: "CJNS292694702BY", name: "Green" },
  { pid: "2606090341151608200", vid: "2606090341151609900", sku: "CJNS292694703CX", name: "Pink" },
  { pid: "2606090341151608200", vid: "2606090341161600400", sku: "CJNS292694704DW", name: "Black" },
  { pid: "2606090341151608200", vid: "2606090341161600800", sku: "CJNS292694705EV", name: "Brown" },

  { pid: "2608270931501632200", vid: "2608270931501633200", sku: "CJNS310228901AZ", name: "Variant 1" },
  { pid: "2608270931501632200", vid: "2608270931501633201", sku: "CJNS310228902BY", name: "Variant 2" },
  { pid: "2608270931501632200", vid: "2608270931501633202", sku: "CJNS310228903CX", name: "Black" },
  { pid: "2608270931501632200", vid: "2608270931501633203", sku: "CJNS310228904DW", name: "Blue" },
  { pid: "2608270931501632200", vid: "2608270931501633204", sku: "CJNS310228905EV", name: "Black / Gray" },
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

  const expectedByVid = new Map(TARGETS.map((row) => [row.vid, row]));
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
