"use client";

import Link from "next/link";
import { useShopCart } from "@/components/shop-cart";
import { formatMoney } from "@/lib/intelligence/format-display";

export default function CartPage() {
  const cart = useShopCart();
  const total = cart.items.reduce(
    (sum, item) => sum + item.unitPrice * item.qty,
    0,
  );
  const currency = cart.items[0]?.currency ?? null;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:px-6 sm:py-16">
      <div className="flex items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-cyan-300/70">Your selection</p>
          <h1 className="mt-2 text-3xl font-medium tracking-tight text-zinc-50">カート</h1>
        </div>
        {cart.items.length > 0 ? (
          <button type="button" onClick={cart.clear} className="text-xs text-zinc-500 transition hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            すべて削除
          </button>
        ) : null}
      </div>
      {cart.items.length === 0 ? (
        <div className="mt-10 border border-dashed border-white/10 px-6 py-14 text-center">
          <p className="text-xl text-zinc-200">まだ選んだ商品はありません。</p>
          <p className="mt-3 text-sm leading-6 text-zinc-500">気になるものを選んで、ここで数量を確認できます。</p>
          <Link href="/shop" className="mt-7 inline-flex border border-cyan-300/30 bg-cyan-300/5 px-5 py-3 text-xs text-cyan-100 transition hover:bg-cyan-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">商品を見る →</Link>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {cart.items.map((item) => (
            <div key={item.listingId} className="grid gap-4 border border-white/10 bg-zinc-950/40 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="flex min-w-0 items-center gap-4">
                {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-16 w-16 shrink-0 object-cover" /> : null}
                <div className="min-w-0">
                  <Link href={`/shop/${item.slug}`} className="text-sm text-zinc-100 transition hover:text-cyan-200">{item.title}</Link>
                  <p className="mt-1 text-xs text-zinc-500">{formatMoney(item.unitPrice, item.currency)} / 個</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-5 sm:justify-end">
                <div className="flex items-center border border-white/10" aria-label={`${item.title} の数量`}>
                  <button type="button" onClick={() => cart.setQuantity(item.listingId, item.qty - 1)} className="px-3 py-2 text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" aria-label="数量を1つ減らす">−</button>
                  <span className="min-w-8 text-center text-sm text-zinc-200">{item.qty}</span>
                  <button type="button" onClick={() => cart.setQuantity(item.listingId, item.qty + 1)} className="px-3 py-2 text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" aria-label="数量を1つ増やす">+</button>
                </div>
                <p className="min-w-24 text-right text-sm text-zinc-100">{formatMoney(item.unitPrice * item.qty, item.currency)}</p>
                <button type="button" onClick={() => cart.remove(item.listingId)} className="text-xs text-zinc-600 hover:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" aria-label={`${item.title} を削除`}>削除</button>
              </div>
            </div>
          ))}
          <div className="mt-7 flex items-end justify-between border-t border-white/10 pt-6">
            <span className="text-sm text-zinc-500">小計</span>
            <p className="text-2xl font-medium tracking-tight text-zinc-50">{formatMoney(total, currency)}</p>
          </div>
          <Link
            href="/shop/checkout"
            className="inline-block border border-cyan-300 px-5 py-3 text-sm tracking-[0.16em] text-cyan-100"
          >
            購入手続きへ
          </Link>
        </div>
      )}
    </main>
  );
}
