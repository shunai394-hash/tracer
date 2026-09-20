import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  let products: Array<{
    product_id: string;
    normalized_title: string;
    brand_name: string | null;
    current_price: number | string | null;
    currency: string | null;
  }> = [];
  let error: string | null = null;

  try {
    const supabase = createSupabaseAdminClient();
    const result = await supabase
      .from("product_intelligence")
      .select("product_id, normalized_title, brand_name, current_price, currency")
      .order("updated_at", { ascending: false })
      .limit(50);

    if (result.error) {
      throw new Error(result.error.message);
    }

    products = result.data ?? [];
  } catch (caught) {
    if (!(caught instanceof SupabaseConfigError)) {
      error = caught instanceof Error ? caught.message : "商品を読み込めませんでした。";
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Products
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">商品</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        Product は正規化された商品実体です。価格や需要は Observation 側に持ちます。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}
      {products.length === 0 ? (
        <div className="mt-10 border border-dashed border-cyan-500/20 p-10 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">
            Empty catalog
          </p>
          <p className="mt-3 text-sm text-zinc-400">登録済みの商品はまだありません。</p>
        </div>
      ) : (
        <div className="mt-10 divide-y divide-white/5 border border-cyan-500/15">
          {products.map((product) => (
            <div key={product.product_id} className="px-5 py-4">
              <p className="text-sm text-zinc-100">{product.normalized_title}</p>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                {product.brand_name ?? "no brand"}
                {product.current_price !== null && product.currency
                  ? ` / ${product.currency} ${product.current_price}`
                  : " / price unknown"}
              </p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
