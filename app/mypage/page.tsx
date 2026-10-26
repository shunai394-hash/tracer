"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

interface AccountOrder {
  id: string;
  createdAt: string | null;
  status: string;
  paymentStatus: string;
  total: number | null;
  currency: string | null;
  hasShippingAddress: boolean;
}

export default function MyPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [orders, setOrders] = useState<AccountOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let active = true;

    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        router.replace("/login");
        return;
      }
      if (!active) return;
      setEmail(session.user.email ?? null);
      const response = await fetch("/api/account/orders", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const payload = (await response.json()) as { ok: boolean; orders?: AccountOrder[]; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "注文履歴を取得できませんでした。");
      }
      if (active) setOrders(payload.orders ?? []);
    }

    void load().catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : "マイページを読み込めませんでした。");
    }).finally(() => {
      if (active) setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.replace("/login");
      else setEmail(session.user.email ?? null);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [router]);

  async function signOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="relative flex-1 overflow-hidden text-white">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute right-0 top-0 h-96 w-96 rounded-full bg-cyan-400/[0.04] blur-3xl" />
      </div>
      <div className="relative mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16 lg:px-10">
        <div className="flex flex-col justify-between gap-6 border-b border-white/20 pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-sm font-bold uppercase tracking-[0.16em] text-white">TRACER / MY PAGE</p>
            <h1 className="mt-4 text-4xl font-bold tracking-[-0.03em] text-white sm:text-5xl">あなたのTRACER。</h1>
            <p className="mt-3 text-lg font-semibold text-white">{email ?? "認証情報を確認中…"}</p>
          </div>
          <button type="button" onClick={() => void signOut()} className="min-h-11 border border-white/30 bg-white/5 px-5 text-sm font-semibold text-white transition hover:border-white/60 hover:bg-white/10">ログアウト</button>
        </div>

        {error ? <p role="alert" className="mt-8 border border-amber-300/40 bg-amber-300/10 p-4 text-sm font-medium text-amber-100">{error}</p> : null}

        <section className="mt-10 grid gap-5 lg:grid-cols-[1fr_320px]" aria-labelledby="orders-heading">
          <div className="border border-white/20 bg-[#0a0d10] p-5 sm:p-7">
            <div className="flex items-end justify-between gap-4">
              <div><p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">Purchase history</p><h2 id="orders-heading" className="mt-2 text-xl font-semibold text-white">注文履歴</h2></div>
              <span className="font-mono text-xs text-zinc-300">{orders.length} orders</span>
            </div>
            {loading ? <p className="mt-8 text-base text-zinc-200">注文履歴を読み込んでいます…</p> : orders.length === 0 ? (
              <div className="mt-8 border border-dashed border-white/25 px-5 py-12 text-center"><p className="text-base text-zinc-200">まだ注文はありません。</p><Link href="/shop" className="mt-4 inline-block text-sm font-semibold text-cyan-200 underline underline-offset-4 hover:text-white">商品を見る →</Link></div>
            ) : (
              <div className="mt-7 space-y-3">{orders.map((order) => <article key={order.id} className="border border-white/20 p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-mono text-xs text-zinc-300">#{order.id}</p><p className="text-sm text-zinc-200">{order.createdAt ? new Date(order.createdAt).toLocaleString("ja-JP") : "—"}</p></div><div className="mt-4 flex flex-wrap gap-2 text-xs font-mono"><span className="border border-white/20 px-2 py-1 text-zinc-100">ORDER {order.status}</span><span className="border border-white/20 px-2 py-1 text-zinc-100">PAYMENT {order.paymentStatus}</span></div>{order.hasShippingAddress ? <p className="mt-4 text-sm leading-5 text-zinc-200">配送先登録済み</p> : null}</article>)}</div>
            )}
          </div>

          <aside className="border border-cyan-300/25 bg-[#0a0d10] p-5 sm:p-7">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">Account</p>
            <h2 className="mt-3 text-xl font-semibold text-white">アカウント</h2>
            <dl className="mt-7 divide-y divide-white/20 border-y border-white/20"><div className="py-4"><dt className="text-xs font-semibold uppercase tracking-[0.15em] text-zinc-300">Email</dt><dd className="mt-2 break-all text-base text-white">{email ?? "—"}</dd></div><div className="py-4"><dt className="text-xs font-semibold uppercase tracking-[0.15em] text-zinc-300">Identity</dt><dd className="mt-2 text-base font-semibold text-cyan-200">Verified account</dd></div></dl>
            <p className="mt-6 text-sm leading-6 text-zinc-200">配送先などの購入情報は、注文時に確認したうえで安全に受発注へ引き渡します。</p>
          </aside>
        </section>
      </div>
    </main>
  );
}
