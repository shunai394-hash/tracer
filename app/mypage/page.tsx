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
    <main className="relative flex-1 overflow-hidden">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute right-0 top-0 h-96 w-96 rounded-full bg-cyan-400/[0.04] blur-3xl" />
      </div>
      <div className="relative mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16 lg:px-10">
        <div className="flex flex-col justify-between gap-6 border-b border-white/8 pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-cyan-300/70">TRACER / MY PAGE</p>
            <h1 className="mt-4 text-4xl tracking-[-0.05em] text-zinc-50 sm:text-5xl">あなたのTRACER。</h1>
            <p className="mt-3 text-sm text-zinc-500">{email ?? "認証情報を確認中…"}</p>
          </div>
          <button type="button" onClick={() => void signOut()} className="min-h-10 border border-white/10 px-4 text-xs text-zinc-400 transition hover:border-white/20 hover:text-zinc-100">ログアウト</button>
        </div>

        {error ? <p role="alert" className="mt-8 border border-amber-300/15 bg-amber-300/[0.025] p-4 text-sm text-amber-200">{error}</p> : null}

        <section className="mt-10 grid gap-5 lg:grid-cols-[1fr_320px]" aria-labelledby="orders-heading">
          <div className="border border-white/10 bg-[#0a0d10] p-5 sm:p-7">
            <div className="flex items-end justify-between gap-4">
              <div><p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-700">Purchase history</p><h2 id="orders-heading" className="mt-2 text-xl text-zinc-100">注文履歴</h2></div>
              <span className="font-mono text-[10px] text-zinc-600">{orders.length} orders</span>
            </div>
            {loading ? <p className="mt-8 text-sm text-zinc-600">注文履歴を読み込んでいます…</p> : orders.length === 0 ? (
              <div className="mt-8 border border-dashed border-white/8 px-5 py-12 text-center"><p className="text-sm text-zinc-400">まだ注文はありません。</p><Link href="/shop" className="mt-4 inline-block text-xs text-cyan-200 hover:text-white">商品を見る →</Link></div>
            ) : (
              <div className="mt-7 space-y-3">{orders.map((order) => <article key={order.id} className="border border-white/8 p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-mono text-[10px] text-zinc-600">#{order.id}</p><p className="text-xs text-zinc-500">{order.createdAt ? new Date(order.createdAt).toLocaleString("ja-JP") : "—"}</p></div><div className="mt-4 flex flex-wrap gap-2 text-[10px] font-mono"><span className="border border-white/8 px-2 py-1 text-zinc-400">ORDER {order.status}</span><span className="border border-white/8 px-2 py-1 text-zinc-400">PAYMENT {order.paymentStatus}</span></div>{order.hasShippingAddress ? <p className="mt-4 text-xs leading-5 text-zinc-600">配送先登録済み</p> : null}</article>)}</div>
            )}
          </div>

          <aside className="border border-cyan-300/10 bg-[#0a0d10] p-5 sm:p-7">
            <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-300/60">Account</p>
            <h2 className="mt-3 text-xl text-zinc-100">アカウント</h2>
            <dl className="mt-7 divide-y divide-white/8 border-y border-white/8"><div className="py-4"><dt className="text-[9px] uppercase tracking-[0.18em] text-zinc-700">Email</dt><dd className="mt-2 break-all text-sm text-zinc-300">{email ?? "—"}</dd></div><div className="py-4"><dt className="text-[9px] uppercase tracking-[0.18em] text-zinc-700">Identity</dt><dd className="mt-2 text-sm text-cyan-200">Verified account</dd></div></dl>
            <p className="mt-6 text-xs leading-6 text-zinc-600">配送先などの購入情報は、注文時に確認したうえで安全に受発注へ引き渡します。</p>
          </aside>
        </section>
      </div>
    </main>
  );
}
