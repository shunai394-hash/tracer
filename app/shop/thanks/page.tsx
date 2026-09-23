import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type OrderStatusView = {
  paymentStatus: string;
  orderStatus: string;
  paymentMethod: string;
};

async function getOrderStatus(orderId: string): Promise<OrderStatusView | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_orders")
    .select("payment_status, order_status, payment_method")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    paymentStatus: String(data.payment_status ?? "unknown"),
    orderStatus: String(data.order_status ?? "unknown"),
    paymentMethod: String(data.payment_method ?? "unknown"),
  };
}

export default async function ThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order } = await searchParams;

  let status: OrderStatusView | null = null;
  let error: string | null = null;

  if (order) {
    try {
      status = await getOrderStatus(order);
    } catch (caught) {
      error =
        caught instanceof SupabaseConfigError
          ? null
          : caught instanceof Error
            ? caught.message
            : "注文状態を確認できませんでした。";
    }
  }

  // The redirect back from Stripe Checkout is never treated as payment
  // confirmation by itself — only the webhook-confirmed DB state is. A card
  // order can legitimately still show "pending" here if the webhook has not
  // arrived yet.
  const isCardPending = status?.paymentMethod === "card" && status.paymentStatus !== "paid";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="text-3xl text-zinc-50">ご注文を受け付けました</h1>
      <p className="mt-4 text-sm text-zinc-400">注文ID: {order ?? "unknown"}</p>

      {error ? <p className="mt-4 text-sm text-amber-300">{error}</p> : null}

      {status ? (
        <div className="mt-6 border border-cyan-500/15 p-5 text-sm">
          {isCardPending ? (
            <p className="text-amber-300">
              決済の確認中です。Stripeからの通知(webhook)を受け取り次第、注文が確定します。このページを更新して確認してください。
            </p>
          ) : status.paymentStatus === "paid" ? (
            <p className="text-emerald-400">支払いが確認されました。注文状態: {status.orderStatus}</p>
          ) : status.paymentStatus === "failed" ? (
            <p className="text-red-400">決済に失敗しました。注文は確定していません。</p>
          ) : (
            <p className="text-zinc-400">注文状態: {status.orderStatus} / 支払い状態: {status.paymentStatus}</p>
          )}
        </div>
      ) : (
        <p className="mt-6 text-sm text-zinc-500">この注文は販売テストの実測として記録されます。</p>
      )}
    </main>
  );
}
