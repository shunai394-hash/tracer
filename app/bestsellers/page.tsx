import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatMoney } from "@/lib/intelligence/format-display";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function BestsellersPage() {
  let rows: Array<Record<string, unknown>> = [];
  let error: string | null = null;

  try {
    const supabase = createSupabaseAdminClient();
    const result = await supabase
      .from("marketplace_bestsellers")
      .select("id, marketplace, rank, title, brand, asin, jan, price, currency, review_count, product_url, fetched_at, source")
      .order("fetched_at", { ascending: false })
      .limit(60);

    if (result.error) throw new Error(result.error.message);
    rows = (result.data ?? []) as Array<Record<string, unknown>>;
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? "Supabase が未設定です。"
        : caught instanceof Error
          ? caught.message
          : "ランキングを読めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14">
      <div className="border-b border-white/8 pb-8">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">Market bestsellers</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl text-zinc-50">売れ筋観測</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              Amazon.co.jp / 楽天市場 / Yahoo!ショッピングから取得した観測データ。
              ここでは市場側の売れ筋と、TRACERの仕入判断を分離します。
            </p>
          </div>
          <div className="border border-cyan-400/15 px-4 py-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-600">Observed</p>
            <p className="mt-1 text-lg text-zinc-100">{rows.length}</p>
          </div>
        </div>
      </div>

      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}

      {rows.length === 0 && !error ? (
        <div className="mt-10 border border-dashed border-cyan-500/20 p-12 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">No observations</p>
          <p className="mt-3 text-sm text-zinc-400">観測された売れ筋はまだありません。</p>
        </div>
      ) : (
        <div className="mt-8 grid gap-3">
          {rows.map((row, index) => {
            const url = typeof row.product_url === "string" ? row.product_url : null;
            const rank = row.rank == null ? index + 1 : row.rank;
            return (
              <article key={String(row.id)} className="group grid gap-4 border border-white/8 bg-zinc-950/40 p-5 transition-colors hover:border-cyan-400/25 md:grid-cols-[72px_1fr_auto] md:items-start">
                <div className="font-mono text-xs text-cyan-400">#{String(rank)}</div>
                <div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
                    <span>{String(row.marketplace)}</span>
                    <span>{String(row.source)}</span>
                    {row.brand ? <span>{String(row.brand)}</span> : null}
                  </div>
                  <h2 className="mt-2 text-base leading-6 text-zinc-100">{String(row.title)}</h2>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
                    <span>Price <strong className="font-normal text-zinc-300">{formatMoney(typeof row.price === "number" ? row.price : null, typeof row.currency === "string" ? row.currency : null)}</strong></span>
                    <span>ASIN {row.asin ? String(row.asin) : "unknown"}</span>
                    <span>JAN {row.jan ? String(row.jan) : "unknown"}</span>
                    {row.review_count != null ? <span>Reviews {String(row.review_count)}</span> : null}
                  </div>
                </div>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="self-start border border-white/10 px-3 py-2 text-xs text-zinc-400 hover:border-cyan-400/30 hover:text-cyan-200">
                    Source ↗
                  </a>
                ) : (
                  <span className="text-xs text-zinc-700">Source unknown</span>
                )}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
