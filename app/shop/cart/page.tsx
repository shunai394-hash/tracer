"use client";

import Link from "next/link";
import { useShopCart } from "@/components/shop-cart";
import { formatMoney } from "@/lib/intelligence/format-display";

export default function CartPage() {
  const cart = useShopCart();
  const total = cart.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  const currency = cart.items[0]?.currency ?? null;

  return (
    <main className="flex-1 bg-[#FBF6F1]">
      <section className="relative overflow-hidden border-b border-[#EADBD3]">
        <div className="pointer-events-none absolute right-0 top-0 h-full w-[38%] bg-[radial-gradient(circle_at_70%_20%,rgba(154,107,91,0.10),transparent_55%)]" aria-hidden="true" />
        <div className="relative mx-auto max-w-[1200px] px-5 py-14 sm:px-8 sm:py-20 lg:px-10">
          <div className="flex items-end justify-between gap-8">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.32em] text-[#9A6B5B]">01 / Cart</p>
              <h1 className="mt-3 text-4xl tracking-[-0.05em] text-[#3B241A] sm:text-5xl">カート</h1>
              <p className="mt-4 max-w-xl text-sm leading-7 text-[#5C4035]">
                選んだ商品を確認して、次のステップへ進みます。販売条件が確認できた商品のみ購入できます。
              </p>
            </div>
            <Link href="/shop" className="hidden text-xs tracking-[0.12em] text-[#5C4035] transition hover:text-[#9A6B5B] sm:inline-flex">
              ← 商品一覧へ
            </Link>
          </div>
          <div className="mt-8 flex max-w-md items-center gap-2 text-[9px] font-mono uppercase tracking-[0.2em] text-[#9A6B5B]" aria-label="購入手続きの進行状況">
            <span className="h-px flex-1 bg-[#3B241A]/50" />
            <span className="text-[#9A6B5B]">Cart</span>
            <span className="h-px flex-1 bg-white/10" />
            <span>Checkout</span>
            <span className="h-px flex-1 bg-white/10" />
            <span>Done</span>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
        {cart.items.length === 0 ? (
          <div className="relative overflow-hidden border border-[#EADBD3] bg-white/80 px-6 py-16 text-center sm:px-10">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#9A6B5B]/40 to-transparent" aria-hidden="true" />
            <span className="mx-auto flex h-12 w-12 items-center justify-center border border-[#EADBD3] text-lg text-[#9A6B5B]" aria-hidden="true">＋</span>
            <p className="mt-6 text-[9px] font-mono uppercase tracking-[0.3em] text-[#9A6B5B]">Nothing selected yet</p>
            <h2 className="mt-3 text-xl text-[#3B241A]">まだ商品がありません。</h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#5C4035]">TRACERが確認した商品から、気になるものをひとつ選んでみてください。</p>
            <Link href="/shop" className="mt-7 inline-flex min-h-11 items-center bg-[#3B241A] px-6 text-xs font-semibold tracking-[0.08em] text-white transition duration-300 hover:-translate-y-0.5 hover:bg-[#5C4035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B]">
              商品を見る <span className="ml-4" aria-hidden="true">→</span>
            </Link>
          </div>
        ) : (
          <div className="grid gap-8 lg:grid-cols-[1fr_340px] lg:items-start">
            <div className="border border-[#EADBD3] bg-white/80">
              <div className="flex items-center justify-between border-b border-[#EADBD3] px-5 py-4 sm:px-6">
                <div>
                  <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-[#7D675D]">Selected items</span>
                  <p className="mt-1 text-xs text-[#9A6B5B]">確認済みの商品だけを次へ進めます。</p>
                </div>
                <span className="text-xs text-[#5C4035]">{cart.items.length} item{cart.items.length === 1 ? "" : "s"}</span>
              </div>
              <div className="divide-y divide-[#EADBD3]">
                {cart.items.map((item, index) => (
                  <article key={item.listingId} className="group grid gap-5 px-5 py-6 transition-colors hover:bg-[#FBF6F1] sm:grid-cols-[72px_1fr_auto] sm:items-center sm:px-6">
                    <div className="relative flex h-[72px] w-[72px] items-center justify-center overflow-hidden border border-[#EADBD3] bg-[#F4ECE6]">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                      ) : (
                        <span className="text-[9px] font-mono text-[#9A6B5B]">0{index + 1}</span>
                      )}
                    </div>
                    <div>
                      <p className="text-sm leading-6 text-[#3B241A]">{item.title}</p>
                      <p className="mt-1 text-xs text-[#7D675D]">数量 {item.qty} · 商品価格 {formatMoney(item.unitPrice, item.currency)}</p>
                    </div>
                    <p className="text-sm font-medium text-[#3B241A] sm:text-right">{formatMoney(item.unitPrice * item.qty, item.currency)}</p>
                  </article>
                ))}
              </div>
            </div>

            <aside className="border border-[#EADBD3] bg-white/80 p-6 sm:p-7 lg:sticky lg:top-24" aria-label="注文概要">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-[#9A6B5B]">Order summary</p>
              <div className="mt-7 flex items-end justify-between border-b border-[#EADBD3] pb-5">
                <span className="text-sm text-[#5C4035]">合計</span>
                <span className="text-2xl tracking-[-0.03em] text-[#3B241A]">{formatMoney(total, currency)}</span>
              </div>
              <p className="mt-5 text-xs leading-5 text-[#7D675D]">次の画面で配送先と支払い方法を確認します。</p>
              <Link href="/shop/checkout" className="group mt-6 flex min-h-12 w-full items-center justify-between bg-[#3B241A] px-5 text-xs font-semibold tracking-[0.08em] text-white transition duration-300 hover:-translate-y-0.5 hover:bg-[#5C4035] hover:shadow-[0_12px_40px_rgba(34,211,238,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B]">
                購入手続きへ <span className="text-lg transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true">→</span>
              </Link>
              <Link href="/shop" className="mt-4 flex justify-center text-[11px] text-[#7D675D] transition hover:text-[#5C4035] sm:hidden">商品一覧へ戻る</Link>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}
