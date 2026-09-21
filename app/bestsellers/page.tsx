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
      .select(
        "id, marketplace, rank, title, brand, asin, jan, price, currency, review_count, product_url, fetched_at, source",
      )
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
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Market bestsellers
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">売れ筋観測</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        Amazon.co.jp / 楽天市場 / Yahoo!ショッピングのランキングから取得できた実データだけを表示します。取れなければ空です。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {rows.length === 0 && !error ? (
        <p className="mt-10 text-sm text-zinc-500">観測された売れ筋はまだありません。</p>
      ) : (
        <div className="mt-10 divide-y divide-white/5 border border-cyan-500/15">
          {rows.map((row) => (
            <article key={String(row.id)} className="px-5 py-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {String(row.marketplace)} · rank {row.rank == null ? "unknown" : String(row.rank)} · {String(row.source)}
              </p>
              <h2 className="mt-1 text-zinc-100">{String(row.title)}</h2>
              <p className="mt-1 text-sm text-zinc-400">
                {formatMoney(
                  typeof row.price === "number" ? row.price : null,
                  typeof row.currency === "string" ? row.currency : null,
                )}{" "}
                · ASIN {row.asin ? String(row.asin) : "unknown"} · JAN{" "}
                {row.jan ? String(row.jan) : "unknown"}
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
