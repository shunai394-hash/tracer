import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchCJVariantByVid } from "@/lib/sources/cj";

export const runtime = "nodejs";
export const maxDuration = 300;

// Fixed read-only audit scope: the 11 CJ parent products identified in
// supplier_offers. Caller-supplied IDs are never accepted.
const TARGET_VARIANTS = [
  { pid: "1568079604899270656", vid: "1568079604924436480", sku: "CJNS1559897-Wine red", name: "Wine red" },
  { pid: "1568079604899270656", vid: "1568079604924436481", sku: "CJNS1559897-Blue", name: "Blue" },
  { pid: "1568079604899270656", vid: "1568079604924436483", sku: "CJNS1559897-Pink", name: "Pink" },
  { pid: "1568079604899270656", vid: "1568079604924436484", sku: "CJNS1559897-Rubber pink", name: "Rubber pink" },
  { pid: "1568079604899270656", vid: "1568079604924436485", sku: "CJNS1559897-Grey", name: "Grey" },
  { pid: "1583013314588848128", vid: "1583013314655956992", sku: "CJNS159197601AZ", name: "Beige white" },
  { pid: "1583013314588848128", vid: "1583013314660151296", sku: "CJNS159197602BY", name: "Coffee" },
  { pid: "1598519300065865728", vid: "1598519300099420160", sku: "CJHZ162580001AZ", name: "Pink and white" },
  { pid: "1598519300065865728", vid: "1719893998598369280", sku: "CJHZ162580002BY", name: "Suit1" },
  { pid: "1677925536317845504", vid: "1677925536397537280", sku: "CJYD179679902BY", name: "Black and white" },
  { pid: "1677925536317845504", vid: "1677925536498200576", sku: "CJYD179679903CX", name: "Fine lattice" },
  { pid: "1677925536317845504", vid: "1677925536586280960", sku: "CJYD179679904DW", name: "Plaid coffee" },
  { pid: "1677925536317845504", vid: "1677925536733081600", sku: "CJYD179679905EV", name: "Plaid red" },
  { pid: "1689818113417682944", vid: "1689818113493180416", sku: "CJNS181956701AZ", name: "Light brown" },
  { pid: "1689818113417682944", vid: "1689818113551900672", sku: "CJNS181956702BY", name: "Dark brown" },
  { pid: "1739211543297925120", vid: "1739211543398588416", sku: "CJNS192984501AZ", name: "Large white" },
  { pid: "1739211543297925120", vid: "1739211543495057408", sku: "CJNS192984502BY", name: "Large pink" },
  { pid: "1739211543297925120", vid: "1739211543574749184", sku: "CJNS192984503CX", name: "Large black" },
  { pid: "1739211543297925120", vid: "1739211543658635264", sku: "CJNS192984504DW", name: "Large haze blue" },
  { pid: "1739211543297925120", vid: "1739211543914487808", sku: "CJNS192984507GT", name: "Medium blue" },
  { pid: "1739211543297925120", vid: "1739211543994179584", sku: "CJNS192984508HS", name: "Medium black" },
  { pid: "1739211543297925120", vid: "1739211544103231488", sku: "CJNS192984509IR", name: "Medium pink" },
  { pid: "1739211543297925120", vid: "1739211544191311872", sku: "CJNS192984510JQ", name: "Medium mint green" },
  { pid: "1739211543297925120", vid: "1739211544279392256", sku: "CJNS192984511KP", name: "Medium white" },
  { pid: "2409020524201624100", vid: "2409020524201624400", sku: "CJJT212604601AZ", name: "Set 1" },
  { pid: "2409020524201624100", vid: "2409020524201624600", sku: "CJJT212604602BY", name: "Set 2" },
  { pid: "2507090541471600100", vid: "2507090541471600600", sku: "CJJT242536802BY", name: "Pink and yellow" },
  { pid: "2507090541471600100", vid: "2507090541471600800", sku: "CJJT242536803CX", name: "Court green" },
  { pid: "2507090541471600100", vid: "2507090541471601000", sku: "CJJT242536804DW", name: "Coffee tortoiseshell" },
  { pid: "2507090541471600100", vid: "2507090541471601200", sku: "CJJT242536805EV", name: "Wave white" },
  { pid: "2507090541471600100", vid: "2507090541471601300", sku: "CJJT242536806FU", name: "Rice tortoiseshell" },
  { pid: "2507090541471600100", vid: "2507090541471601700", sku: "CJJT242536808HS", name: "Mermaid purple" },
  { pid: "2507090541471600100", vid: "2507090541471601900", sku: "CJJT242536809IR", name: "Floral coffee" },
  { pid: "2507090541471600100", vid: "2507090541471602100", sku: "CJJT242536810JQ", name: "Sky blue" },
  { pid: "2507090541471600100", vid: "2507090541471602300", sku: "CJJT242536811KP", name: "Transparent powder" },
  { pid: "2507090541471600100", vid: "2507090541471602400", sku: "CJJT242536812LO", name: "Yuanshan green" },
  { pid: "2602270747341630000", vid: "2602270747341630500", sku: "CJNS276941401AZ", name: "Coffee" },
  { pid: "2602270747341630000", vid: "2602270747341630800", sku: "CJNS276941402BY", name: "Khaki" },
  { pid: "2602270747341630000", vid: "2602270747341631100", sku: "CJNS276941403CX", name: "Brown" },
  { pid: "2602270747341630000", vid: "2602270747341631400", sku: "CJNS276941404DW", name: "Black" },
  { pid: "2607240511241608800", vid: "2607240511251601600", sku: "CJNS300427904DW", name: "Pink" },
  { pid: "2607240511241608800", vid: "2607240511251602300", sku: "CJNS300427905EV", name: "Brown" },
  { pid: "2607240511241608800", vid: "2607240511251602800", sku: "CJNS300427906FU", name: "Blue" },
  { pid: "2607240511241608800", vid: "2607240511251603300", sku: "CJNS300427907GT", name: "Green" },
  { pid: "2607240511241608800", vid: "2607240511251603800", sku: "CJNS300427908HS", name: "Beige" },
  { pid: "2610070855311635500", vid: "2610070855311636600", sku: "CJBA323015101AZ", name: "Claret red" },
  { pid: "2610070855311635500", vid: "2610070855311636601", sku: "CJBA323015102BY", name: "Gold" },
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

  // This endpoint is strictly read-only. It fetches each exact CJ VID and
  // never writes product, image, stock, price, listing, or order data.
  const results: Array<{
    pid: string;
    vid: string;
    expectedSku: string;
    variantName: string;
    returnedPid: string | null;
    returnedVid: string | null;
    returnedSku: string | null;
    exactIdentity: boolean;
    imageUrl: string | null;
    hasImage: boolean;
    error: string | null;
  }> = [];

  // Small batches avoid flooding the supplier API while keeping the audit
  // within the route's execution window.
  for (let offset = 0; offset < TARGET_VARIANTS.length; offset += 3) {
    const batch = TARGET_VARIANTS.slice(offset, offset + 3);
    const batchResults = await Promise.all(batch.map(async (expected) => {
      try {
        const variant = await fetchCJVariantByVid(expected.vid);
        const exactIdentity =
          variant?.vid === expected.vid &&
          variant.productId === expected.pid &&
          variant.sku === expected.sku;
        const imageUrl = exactIdentity ? safeImageUrl(variant?.variantImage ?? null) : null;
        return {
          pid: expected.pid,
          vid: expected.vid,
          expectedSku: expected.sku,
          variantName: expected.name,
          returnedPid: variant?.productId ?? null,
          returnedVid: variant?.vid ?? null,
          returnedSku: variant?.sku ?? null,
          exactIdentity,
          imageUrl,
          hasImage: Boolean(imageUrl),
          error: null,
        };
      } catch (error) {
        return {
          pid: expected.pid,
          vid: expected.vid,
          expectedSku: expected.sku,
          variantName: expected.name,
          returnedPid: null,
          returnedVid: null,
          returnedSku: null,
          exactIdentity: false,
          imageUrl: null,
          hasImage: false,
          error: error instanceof Error ? error.message.slice(0, 160) : "lookup_failed",
        };
      }
    }));
    results.push(...batchResults);
  }

  const imageCounts = new Map<string, number>();
  for (const row of results) {
    if (row.imageUrl) {
      const key = `${row.pid}|${row.imageUrl}`;
      imageCounts.set(key, (imageCounts.get(key) ?? 0) + 1);
    }
  }
  const annotated = results.map((row) => ({
    ...row,
    duplicateImageWithinProduct: row.imageUrl
      ? (imageCounts.get(`${row.pid}|${row.imageUrl}`) ?? 0) > 1
      : false,
  }));
  const exactIdentityCount = annotated.filter((row) => row.exactIdentity).length;
  const imageCount = annotated.filter((row) => row.hasImage).length;
  return NextResponse.json({
    ok: exactIdentityCount === TARGET_VARIANTS.length && imageCount === TARGET_VARIANTS.length,
    readOnly: true,
    targetProductCount: new Set(TARGET_VARIANTS.map((row) => row.pid)).size,
    checked: annotated.length,
    exactIdentityCount,
    imageCount,
    missingImageCount: annotated.length - imageCount,
    duplicateImageVariantCount: annotated.filter((row) => row.duplicateImageWithinProduct).length,
    results: annotated,
  }, { status: exactIdentityCount === TARGET_VARIANTS.length ? 200 : 207 });
}
