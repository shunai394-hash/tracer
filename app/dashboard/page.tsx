import { BaseOperationsPanel } from "@/components/base-operations-panel";
import { ConnectionPanel } from "@/components/connection-panel";
import { OpportunityKpis } from "@/components/opportunity-kpis";
import { getFoundationStatus } from "@/lib/config/env";
import { isBaseConfigured } from "@/lib/channels/base";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOpportunityKpis } from "@/lib/intelligence/opportunity-store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
  } catch (caught) {
    baseLoadError = caught instanceof Error ? caught.message : "BASE公開状態を読み込めませんでした。";
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
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Dashboard
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">運用ダッシュボード</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        商品数ではなく、販売テストまで進んだ商機を見ます。実測がない指標は unknown です。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {kpis ? (
        <div className="mt-10">
          <OpportunityKpis kpis={kpis} />
        </div>
      ) : null}
      <BaseOperationsPanel
        configured={isBaseConfigured()}
        listings={baseListings}
        loadError={baseLoadError}
      />
      <div className="mt-10 max-w-xl">
        <ConnectionPanel status={status} />
      </div>
    </main>
  );
}
