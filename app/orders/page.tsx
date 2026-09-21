import Link from "next/link";
import { OrderActions } from "@/components/order-actions";
import {
  formatConfidence,
  formatMoney,
  formatUnits,
} from "@/lib/intelligence/format-display";
import {
  listPurchaseOrders,
  listReorderRecommendations,
} from "@/lib/ordering/store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  let error: string | null = null;
  let recommendations: Awaited<ReturnType<typeof listReorderRecommendations>> = [];
  let orders: Awaited<ReturnType<typeof listPurchaseOrders>> = [];

  try {
    [recommendations, orders] = await Promise.all([
      listReorderRecommendations(),
      listPurchaseOrders(),
    ]);
  } catch (caught) {
    error =
      caught instanceof SupabaseConfigError
        ? "Supabase が未設定のため発注を読めません。"
        : caught instanceof Error
          ? caught.message
          : "発注を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Orders
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">発注案と発注履歴</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        予測と発注実行は分離しています。自社在庫が未記録の場合、CJ在庫を自社在庫として使いません。
      </p>
      {error ? <p className="mt-8 text-sm text-amber-300">{error}</p> : null}

      <section className="mt-10">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
          Recommendations
        </h2>
        <div className="mt-4 divide-y divide-white/5 border border-cyan-500/15">
          {recommendations.length === 0 ? (
            <p className="px-5 py-6 text-sm text-zinc-500">発注案はまだありません。</p>
          ) : (
            recommendations.map((item) => (
              <article key={item.id} className="px-5 py-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                  {item.orderState} · {item.productId}
                </p>
                <ul className="mt-2 space-y-1 text-sm text-zinc-300">
                  <li>現在庫 {item.onHand ?? "unknown"}</li>
                  <li>30日予測 {formatUnits(item.forecastUnits30d)}</li>
                  <li>ROP {item.reorderPoint ?? "unknown"}</li>
                  <li>推奨数 {item.recommendedQty ?? "unknown"}</li>
                  <li>
                    発注金額 {formatMoney(item.estimatedCost, item.currency)}
                  </li>
                  <li>
                    予測利益 {formatMoney(item.estimatedProfit, item.currency)}
                  </li>
                  <li>Confidence {formatConfidence(item.confidence)}</li>
                </ul>
                {item.rationale ? (
                  <p className="mt-2 text-sm text-zinc-400">{item.rationale}</p>
                ) : null}
                <div className="mt-3">
                  <OrderActions
                    recommendationId={item.id}
                    orderState={item.orderState}
                  />
                </div>
                {item.opportunityId ? (
                  <Link
                    href={`/intelligence/${item.opportunityId}`}
                    className="mt-3 inline-block font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-400"
                  >
                    Opportunity
                  </Link>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
          Purchase orders
        </h2>
        <div className="mt-4 divide-y divide-white/5 border border-cyan-500/15">
          {orders.length === 0 ? (
            <p className="px-5 py-6 text-sm text-zinc-500">発注履歴はまだありません。</p>
          ) : (
            orders.map((order) => (
              <article key={order.id} className="px-5 py-4 text-sm text-zinc-300">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                  {order.status} · {order.mode}
                </p>
                <p className="mt-2">
                  qty {order.qty ?? "unknown"} ·{" "}
                  {formatMoney(order.totalCost, order.currency)}
                </p>
                {order.rationale ? (
                  <p className="mt-2 text-zinc-400">{order.rationale}</p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
