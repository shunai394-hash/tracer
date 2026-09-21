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
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-16">
      <h1 className="text-3xl text-zinc-50">カート</h1>
      {cart.items.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-400">カートは空です。</p>
      ) : (
        <div className="mt-8 space-y-4">
          {cart.items.map((item) => (
            <div key={item.listingId} className="flex justify-between border border-white/10 px-4 py-3">
              <div>
                <p className="text-zinc-100">{item.title}</p>
                <p className="text-sm text-zinc-500">x {item.qty}</p>
              </div>
              <p>{formatMoney(item.unitPrice * item.qty, item.currency)}</p>
            </div>
          ))}
          <p className="text-lg text-zinc-100">
            合計 {formatMoney(total, currency)}
          </p>
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
