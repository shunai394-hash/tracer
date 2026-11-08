import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  createShopifyColorFamily,
  type ShopifyColorFamilyCreateInput,
} from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// This endpoint is intentionally limited to the three families already
// approved for the color-consolidation work. It creates DRAFT products only;
// it never publishes or archives the existing standalone products.
const FAMILIES: Record<string, { canonicalProductId: string; supplierProductId: string; supplierVariantIds: string[]; sourceProductIds: string[] }> = {
  "2608270931501632200": {
    canonicalProductId: "78440a5e-c95e-4282-bf39-f7885f66dc0f",
    supplierProductId: "2608270931501632200",
    supplierVariantIds: ["2608270931501633200", "2608270931501633201", "2608270931501633202", "2608270931501633203", "2608270931501633204"],
    sourceProductIds: ["8659229999148", "8659229409324", "8659230195756", "8659229835308", "8659229638700"],
  },
  "2611030217281638700": {
    canonicalProductId: "cda6d104-1036-4d06-a6d7-6896b3bbca79",
    supplierProductId: "2611030217281638700",
    supplierVariantIds: ["2611030217291630600", "2611030217291630601", "2611030217291630602", "2611030217291630603", "2611030217291630604"],
    sourceProductIds: ["8665687588908", "8665687818284", "8665688113196", "8665688375340", "8665687982124"],
  },
  "2610130254321621100": {
    canonicalProductId: "7552ee45-64f7-4f9b-8a4c-026f85ec5a97",
    supplierProductId: "2610130254321621100",
    supplierVariantIds: ["2610130254321622300", "2610130254321622301", "2610130254321622302", "2610130254321622303", "2610130254321622304"],
    sourceProductIds: ["8661943058476", "8661942796332", "8661943124012", "8661941485612", "8661941813292"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!isRecord(body) || !isRecord(body.input)) {
    return NextResponse.json({ ok: false, error: "input_required" }, { status: 400 });
  }

  const input = body.input as unknown as ShopifyColorFamilyCreateInput;
  const family = FAMILIES[String(input.supplierProductId ?? "")];
  if (!family || input.supplierCode?.trim().toLowerCase() !== "cj" ||
      input.canonicalProductId !== family.canonicalProductId ||
      !Array.isArray(input.variants) || input.variants.length !== 5) {
    return NextResponse.json({ ok: false, error: "color_family_not_allowlisted_or_incomplete" }, { status: 400 });
  }

  const supplierIds = input.variants.map((variant) => String(variant?.supplierVariantId ?? ""));
  const sourceProductIds = input.variants.map((variant) => String(variant?.sourceShopifyProductId ?? "").replace(/^gid:\/\/shopify\/Product\//, ""));
  if (new Set(supplierIds).size !== 5 ||
      family.supplierVariantIds.some((id) => !supplierIds.includes(id)) ||
      family.sourceProductIds.some((id) => !sourceProductIds.includes(id))) {
    return NextResponse.json({ ok: false, error: "source_variant_identity_mismatch" }, { status: 409 });
  }

  // Fail closed until every variant has an explicit visual image-to-color
  // confirmation. URL uniqueness alone is not sufficient evidence.
  if (input.variants.some((variant) => variant.colorImageVerified !== true)) {
    return NextResponse.json({ ok: false, error: "color_image_visual_verification_required" }, { status: 409 });
  }

  try {
    const result = await createShopifyColorFamily(input);
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "shopify_color_family_creation_failed";
    return NextResponse.json({ ok: false, error: message.slice(0, 500) }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}
