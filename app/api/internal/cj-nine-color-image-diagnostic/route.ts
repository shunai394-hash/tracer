import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchCJVariantByVid } from "@/lib/sources/cj";

export const runtime = "nodejs";
export const maxDuration = 180;

// Fixed, server-side allowlist for one exact CJ parent. No caller-supplied IDs.
// Read-only: no database, listing, price, inventory, publication, or order writes.
const EXPECTED_PRODUCT_ID = "1739211543297925120";
const PARENT_IMAGE_URL =
  "https://oss-cf.cjdropshipping.com/product/2023/12/26/07/78b41f61-9977-4ef4-95e1-b6dabc829118.jpg";
const TARGET_VARIANTS = [
  { vid: "1739211543398588416", sku: "CJNS192984501AZ" },
  { vid: "1739211543495057408", sku: "CJNS192984502BY" },
  { vid: "1739211543574749184", sku: "CJNS192984503CX" },
  { vid: "1739211543658635264", sku: "CJNS192984504DW" },
  { vid: "1739211543914487808", sku: "CJNS192984507GT" },
  { vid: "1739211543994179584", sku: "CJNS192984508HS" },
  { vid: "1739211544103231488", sku: "CJNS192984509IR" },
  { vid: "1739211544191311872", sku: "CJNS192984510JQ" },
  { vid: "1739211544279392256", sku: "CJNS192984511KP" },
] as const;

function safeImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const results = [];
  // Sequential calls intentionally preserve CJ's shared 1-request-per-2s limiter.
  for (const expected of TARGET_VARIANTS) {
    try {
      const variant = await fetchCJVariantByVid(expected.vid);
      const exactIdentity =
        variant?.vid === expected.vid &&
        variant.productId === EXPECTED_PRODUCT_ID &&
        variant.sku === expected.sku;
      const imageUrl = exactIdentity ? safeImageUrl(variant?.variantImage ?? null) : null;
      results.push({
        vid: expected.vid,
        expectedSku: expected.sku,
        returnedSku: variant?.sku ?? null,
        returnedName: variant?.nameEn ?? null,
        exactIdentity,
        imageUrl,
        hasImage: Boolean(imageUrl),
        sameAsParentImage: Boolean(imageUrl && imageUrl === PARENT_IMAGE_URL),
        error: null,
      });
    } catch (error) {
      results.push({
        vid: expected.vid,
        expectedSku: expected.sku,
        returnedSku: null,
        returnedName: null,
        exactIdentity: false,
        imageUrl: null,
        hasImage: false,
        sameAsParentImage: false,
        error: error instanceof Error ? error.message.slice(0, 160) : "lookup_failed",
      });
    }
  }

  const complete = results.length === TARGET_VARIANTS.length &&
    results.every((row) => row.exactIdentity && row.hasImage && !row.sameAsParentImage);
  return NextResponse.json({
    ok: complete,
    readOnly: true,
    expectedProductId: EXPECTED_PRODUCT_ID,
    checked: results.length,
    exactIdentityCount: results.filter((row) => row.exactIdentity).length,
    imageCount: results.filter((row) => row.hasImage).length,
    distinctImageCount: new Set(results.map((row) => row.imageUrl).filter(Boolean)).size,
    results,
  }, { status: complete ? 200 : 207 });
}
