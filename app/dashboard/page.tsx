import { BaseOperationsPanel } from "@/components/base-operations-panel";
import { ConnectionPanel } from "@/components/connection-panel";
import { OpportunityKpis } from "@/components/opportunity-kpis";
import { getFoundationStatus } from "@/lib/config/env";
import { isBaseConfigured } from "@/lib/channels/base";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOpportunityKpis } from "@/lib/intelligence/opportunity-store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ListingLink = {
  id: string;
  title: string | null;
  product_id: string | null;
  supplier_listing_id: string | null;
  supplier_name: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | null;
  orderable: boolean | null;
  tracking_available: boolean | null;
  pipeline_stage: string | null;
  published: boolean | null;
};

function State({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? "text-cyan-300" : "text-amber-300"}>
      {ok ? "●" : "○"} {label}
    </span>
  );
}

export default async function DashboardPage() {
  const status = getFoundationStatus();
  let kpis = null;
  let error: string | null = null;
  let baseListings: Array<{
    id: string;
    title: string | null;
    published: boolean | null;
    base_item_id: string | null;
    base_publication_status: string | null;
    base_last_error: string | null;
    inventory: number | string | null;
    orderable: boolean | null;
    selling_price: number | null;
    image_url: string | null;
  }> = [];
  let baseLoadError: string | null = null;
  let linkedListings: ListingLink[] = [];
  let linkageError: string | null = null;

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error: listingsError } = await supabase
      .from("shop_listings")
      .select("id,title,published,base_item_id,base_publication_status,base_last_error,inventory,orderable,selling_price,image_url")
      .or("published.eq.true,base_item_id.not.is.null")
      .order("created_at", { ascending: false })
      .limit(100);
    if (listingsError) throw new Error(listingsError.message);
    baseListings = data ?? [];

    const { data: links, error: linksError } = await supabase
      .from("shop_listings")
      .select("id,title,product_id,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,pipeline_stage,published")
      .or("published.eq.true,supplier_listing_id.not.is.null")
      .order("created_at", { ascending: false })
      .limit(100);
    if (linksError) throw new Error(linksError.message);
    linkedListings = (links ?? []) as ListingLink[];
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "商品接続状態を読み込めませんでした。";
    linkageError = message;
    if (!baseLoadError) baseLoadError = message;
  }

  try {
    kpis = await getOpportunityKpis();
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? null
        : caught instanceof Error
          ? caught.message
          : "KPI を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">Dashboard</p>
      <h1 className="mt-3 text-3xl text-zinc-50">運用ダッシュボード</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        商品数ではなく、販売テストまで進んだ商機と、仕入先・variantまでの接続状態を追跡します。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {kpis ? <div className="mt-10"><OpportunityKpis kpis={kpis} /></div> : null}

      <section className="mt-10 border border-cyan-300/15 bg-[#0a0d10] p-5 sm:p-7" aria-labelledby="linkage-heading">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/60">Product → Supplier → Variant</p>
            <h2 id="linkage-heading" className="mt-2 text-xl text-zinc-100">商品接続・受発注トレース</h2>
            <p className="mt-2 max-w-3xl text-xs leading-5 text-zinc-500">ここで「どの商品が、どのCJ商品・variantから仕入れるのか」を確認できます。注文先が未確定の商品は販売対象にしません。</p>
          </div>
          <span className="border border-white/10 px-3 py-1.5 font-mono text-[10px] text-zinc-500">{linkedListings.length} linked records</span>
        </div>
        {linkageError ? <p className="mt-6 text-sm text-amber-300">{linkageError}</p> : null}
        <div className="mt-7 space-y-3">
          {linkedListings.length === 0 ? (
            <p className="border border-white/8 px-4 py-8 text-sm text-zinc-500">紐付け済みの商品はありません。</p>
          ) : linkedListings.map((listing) => {
            const supplierLinked = Boolean(listing.supplier_name && listing.supplier_product_id && listing.supplier_variant_id);
            const operational = listing.orderable === true && Number(listing.inventory ?? 0) > 0 && listing.tracking_available === true;
            return (
              <article key={listing.id} className="border border-white/8 bg-black/20 p-4 sm:p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">{listing.title ?? "Untitled listing"}</p>
                    <p className="mt-1 break-all font-mono text-[10px] text-zinc-700">TRACER listing {listing.id}</p>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-[10px]">
                    <State ok={Boolean(listing.product_id)} label="PRODUCT" />
                    <State ok={supplierLinked} label="SUPPLIER LINKED" />
                    <State ok={Boolean(listing.supplier_variant_id)} label="VARIANT" />
                    <State ok={operational} label="ORDERABLE" />
                  </div>
                </div>
                <div className="mt-5 grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                  <div className="border border-white/6 p-3"><p className="text-[9px] uppercase tracking-[0.18em] text-zinc-700">Supplier</p><p className="mt-1 text-zinc-300">{listing.supplier_name ?? "未設定"}</p></div>
                  <div className="border border-white/6 p-3"><p className="text-[9px] uppercase tracking-[0.18em] text-zinc-700">Product ID</p><p className="mt-1 break-all font-mono text-zinc-400">{listing.supplier_product_id ?? "未設定"}</p></div>
                  <div className="border border-white/6 p-3"><p className="text-[9px] uppercase tracking-[0.18em] text-zinc-700">Variant ID</p><p className="mt-1 break-all font-mono text-zinc-400">{listing.supplier_variant_id ?? "未設定"}</p></div>
                  <div className="border border-white/6 p-3"><p className="text-[9px] uppercase tracking-[0.18em] text-zinc-700">Inventory / Stage</p><p className="mt-1 text-zinc-300">{listing.inventory ?? 0} / {listing.pipeline_stage ?? "—"}</p></div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <BaseOperationsPanel configured={isBaseConfigured()} listings={baseListings} loadError={baseLoadError} />
      <div className="mt-10 max-w-xl"><ConnectionPanel status={status} /></div>
    </main>
  );
}
