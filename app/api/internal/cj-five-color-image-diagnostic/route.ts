import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchCJVariantByVid } from "@/lib/sources/cj";

export const runtime = "nodejs";
export const maxDuration = 180;

// Exact, server-side allowlist. This diagnostic never accepts caller-supplied IDs
// and never writes to Supabase, listings, prices, stock, or orders.
const EXPECTED_PRODUCT_ID = "1360428949011828736";
const TARGET_VARIANTS = [
  { color: "Red", vid: "1360428950521778176", sku: "CJNS101188701AZ" },
  { color: "Blue", vid: "1360428950572109824", sku: "CJNS101188702BY" },
  { color: "Dark blue", vid: "1360428950618247168", sku: "CJNS101188703CX" },
  { color: "Black", vid: "1360428950664384512", sku: "CJNS101188704DW" },
  { color: "Gray", vid: "1360428950710521856", sku: "CJNS101188705EV" },
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

  // Do not parse a request body: the VID allowlist is fixed in this source file.
  const results: Array<{
    color: string;
    vid: string;
    expectedSku: string;
    returnedSku: string | null;
    returnedName: string | null;
    exactIdentity: boolean;
    imageUrl: string | null;
    hasImage: boolean;
    error: string | null;
  }> = [];
  for (const expected of TARGET_VARIANTS) {
    try {
      const variant = await fetchCJVariantByVid(expected.vid);
      const exactIdentity =
        variant?.vid === expected.vid &&
        variant.productId === EXPECTED_PRODUCT_ID &&
        variant.sku === expected.sku;
      results.push({
        color: expected.color,
        vid: expected.vid,
        expectedSku: expected.sku,
        returnedSku: variant?.sku ?? null,
        returnedName: variant?.nameEn ?? null,
        exactIdentity,
        imageUrl: exactIdentity ? safeImageUrl(variant?.variantImage ?? null) : null,
        hasImage: Boolean(exactIdentity && safeImageUrl(variant?.variantImage ?? null)),
        error: null,
      });
    } catch (error) {
      results.push({
        color: expected.color,
        vid: expected.vid,
        expectedSku: expected.sku,
        returnedSku: null,
        returnedName: null,
        exactIdentity: false,
        imageUrl: null,
        hasImage: false,
        error: error instanceof Error ? error.message.slice(0, 160) : "lookup_failed",
      });
    }
  }

  const complete = results.length === TARGET_VARIANTS.length &&
    results.every((row) => row.exactIdentity && row.hasImage);
  return NextResponse.json({
    ok: complete,
    readOnly: true,
    expectedProductId: EXPECTED_PRODUCT_ID,
    checked: results.length,
    imageCount: results.filter((row) => row.hasImage).length,
    exactIdentityCount: results.filter((row) => row.exactIdentity).length,
    results,
  }, { status: complete ? 200 : 207 });
}
