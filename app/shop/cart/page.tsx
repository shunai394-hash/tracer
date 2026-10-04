"use client";

import Link from "next/link";
import { useShopCart } from "@/components/shop-cart";
import { formatMoney } from "@/lib/intelligence/format-display";

export default function CartPage() {
  const cart = useShopCart();
  const total = cart.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  const currency = cart.items[0]?.currency ?? null;

  return (
    <main className="flex-1 bg-[#07090b]">
      <section className="border-b border-white/8">
        <div className="mx-auto max-w-[1200px] px-5 py-14 sm:px-8 sm:py-20 lg:px-10">
          <div className="flex items-end justify-between gap-8">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.32em] text-cyan-300/70">01 / Cart</p>
              <h1 className="mt-3 text-4xl tracking-[-0.05em] text-zinc-50 sm:text-5xl">カート</h1>
              <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-500">
                選んだ商品を確認して、次のステップへ進みます。販売条件が確認できた商品のみ購入できます。
              </p>
            </div>
            <Link href="/shop" className="hidden text-xs tracking-[0.12em] text-zinc-500 transition hover:text-cyan-200 sm:inline-flex">
              ← 商品一覧へ
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
        {cart.items.length === 0 ? (
          <div className="border border-white/10 bg-[#0a0d10] px-6 py-14 text-center sm:px-10">
            <span className="mx-auto flex h-10 w-10 items-center justify-center border border-cyan-300/20 text-cyan-200" aria-hidden="true">＋</span>
            <h2 className="mt-6 text-xl text-zinc-100">まだ商品がありません。</h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-zinc-500">TRACERが確認した商品から、気になるものをひとつ選んでみてください。</p>
            <Link href="/shop" className="mt-7 inline-flex min-h-11 items-center bg-cyan-300 px-6 text-xs font-semibold tracking-[0.08em] text-zinc-950 transition hover:-translate-y-0.5 hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">
              商品を見る <span className="ml-4" aria-hidden="true">→</span>
            </Link>
          </div>
        ) : (
          <div className="grid gap-8 lg:grid-cols-[1fr_340px] lg:items-start">
            <div className="border border-white/10 bg-[#0a0d10]">
              <div className="flex items-center justify-between border-b border-white/8 px-5 py-4 sm:px-6">
                <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600">Selected items</span>
                <span className="text-xs text-zinc-500">{cart.items.length} item{cart.items.length === 1 ? "" : "s"}</span>
              </div>
              <div className="divide-y divide-white/7">
                {cart.items.map((item, index) => (
                  <article key={item.listingId} className="grid gap-5 px-5 py-6 sm:grid-cols-[72px_1fr_auto] sm:items-center sm:px-6">
                    <div className="flex h-[72px] w-[72px] items-center justify-center overflow-hidden border border-white/8 bg-black/20">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-[9px] font-mono text-zinc-700">0{index + 1}</span>
                      )}
                    </div>
                    <div>
                      <p className="text-sm leading-6 text-zinc-100">{item.title}</p>
                      <p className="mt-1 text-xs text-zinc-600">数量 {item.qty} · 商品価格 {formatMoney(item.unitPrice, item.currency)}</p>
                    </div>
                    <p className="text-sm font-medium text-zinc-100 sm:text-right">{formatMoney(item.unitPrice * item.qty, item.currency)}</p>
                  </article>
                ))}
              </div>
            </div>

            <aside className="border border-white/10 bg-[#0a0d10] p-6 sm:p-7 lg:sticky lg:top-24">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600">Order summary</p>
              <div className="mt-7 flex items-end justify-between border-b border-white/8 pb-5">
                <span className="text-sm text-zinc-500">合計</span>
                <span className="text-2xl tracking-[-0.03em] text-zinc-50">{formatMoney(total, currency)}</span>
              </div>
              <p className="mt-5 text-xs leading-5 text-zinc-600">次の画面で配送先と支払い方法を確認します。</p>
              <Link href="/shop/checkout" className="group mt-6 flex min-h-12 w-full items-center justify-between bg-cyan-300 px-5 text-xs font-semibold tracking-[0.08em] text-zinc-950 transition hover:-translate-y-0.5 hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">
                購入手続きへ <span className="text-lg transition-transform group-hover:translate-x-1" aria-hidden="true">→</span>
              </Link>
              <Link href="/shop" className="mt-4 flex justify-center text-[11px] text-zinc-600 transition hover:text-zinc-300 sm:hidden">商品一覧へ戻る</Link>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}
