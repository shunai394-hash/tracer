import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function text(value: unknown, max = 5000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validImageUrl(value: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("shop_listings")
      .select("id,product_id,slug,title,description,image_url,selling_price,currency,inventory,published,published_at,manual_inventory,created_at,updated_at")
      .eq("manual_inventory", true)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({ ok: true, listings: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "listing_read_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const id = text(body.id, 80);
  const title = text(body.title, 180);
  const description = text(body.description, 10000);
  const imageUrl = text(body.imageUrl, 2000);
  const price = Number(body.price);
  const inventory = Number(body.inventory);
  const published = body.published === true;

  if (!title) return NextResponse.json({ ok: false, error: "商品名を入力してください。" }, { status: 400 });
  if (!description) return NextResponse.json({ ok: false, error: "商品説明を入力してください。" }, { status: 400 });
  if (!Number.isFinite(price) || price < 0 || (published && price <= 0)) {
    return NextResponse.json({ ok: false, error: "販売価格を確認してください。" }, { status: 400 });
  }
  if (!Number.isInteger(inventory) || inventory < 0 || inventory > 1_000_000) {
    return NextResponse.json({ ok: false, error: "在庫数は0以上の整数で入力してください。" }, { status: 400 });
  }
  if (imageUrl && !validImageUrl(imageUrl)) {
    return NextResponse.json({ ok: false, error: "画像URLはHTTPSで入力してください。" }, { status: 400 });
  }
  if (published && (!imageUrl || inventory < 1)) {
    return NextResponse.json({ ok: false, error: "公開にはHTTPS画像と1個以上の在庫が必要です。" }, { status: 400 });
  }
  if (published && !/[ぁ-んァ-ヶ一-龯々ー]/u.test(title)) {
    return NextResponse.json({ ok: false, error: "TRACERの公開商品名は日本語で入力してください。" }, { status: 400 });
  }
  if (published && (!isPublishableCatalogTitle(title) || !isPublishableCatalogDescription(description))) {
    return NextResponse.json({ ok: false, error: "商品名または説明が公開品質基準を満たしていません。内容を修正してください。" }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const slugBase = title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9ぁ-んァ-ヶ一-龯]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "manual-product";
  const now = new Date().toISOString();
  const values = {
    title,
    description,
    image_url: imageUrl || null,
    selling_price: price,
    currency: "JPY",
    inventory,
    published,
    published_at: published ? now : null,
    manual_inventory: true,
    orderable: false,
    tracking_available: false,
    updated_at: now,
    selection_reasons: ["manual_inventory"],
    missing: [],
  };

  try {
    if (id) {
      const { data, error } = await db
        .from("shop_listings")
        .update(values)
        .eq("id", id)
        .eq("manual_inventory", true)
        .is("archived_at", null)
        .select("id,product_id,slug,title,description,image_url,selling_price,currency,inventory,published,published_at,manual_inventory,updated_at")
        .single();
      if (error) throw error;
      return NextResponse.json({ ok: true, listing: data });
    }

    const { data: product, error: productError } = await db
      .from("products")
      .insert({ canonical_name: title })
      .select("id")
      .single();
    if (productError || !product) throw productError ?? new Error("product_create_failed");

    const slug = `${slugBase}-${crypto.randomUUID().slice(0, 8)}`;
    const { data, error } = await db
      .from("shop_listings")
      .insert({ ...values, product_id: product.id, slug, created_at: now })
      .select("id,product_id,slug,title,description,image_url,selling_price,currency,inventory,published,published_at,manual_inventory,updated_at")
      .single();
    if (error) {
      await db.from("products").delete().eq("id", product.id);
      throw error;
    }
    return NextResponse.json({ ok: true, listing: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "listing_save_failed" }, { status: 500 });
  }
}


export async function DELETE(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const id = text(body.id, 80);
  if (!id) return NextResponse.json({ ok: false, error: "削除対象の商品IDがありません。" }, { status: 400 });

  try {
    const db = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("shop_listings")
      .update({
        archived_at: now,
        archive_reason: "manual_admin_archived",
        published: false,
        published_at: null,
        orderable: false,
        updated_at: now,
      })
      .eq("id", id)
      .eq("manual_inventory", true)
      .is("archived_at", null)
      .select("id,title,archived_at")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "対象商品が見つからないか、手動管理商品ではありません。データは変更していません。" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, archived: data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "listing_archive_failed" }, { status: 500 });
  }
}
