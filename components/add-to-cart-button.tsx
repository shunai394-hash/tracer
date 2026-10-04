"use client";

import { useState } from "react";
import { useShopCart } from "@/components/shop-cart";

export function AddToCartButton(props: {
  listingId: string;
  slug: string;
  title: string;
  unitPrice: number | null;
  currency: string | null;
  imageUrl: string | null;
}) {
  const cart = useShopCart();
  const [message, setMessage] = useState<string | null>(null);
  const disabled = props.unitPrice === null || !props.currency;

  async function add() {
    if (props.unitPrice === null || !props.currency) return;
    cart.add({
      listingId: props.listingId,
      slug: props.slug,
      title: props.title,
      unitPrice: props.unitPrice,
      currency: props.currency,
      imageUrl: props.imageUrl,
    });
    setMessage("カートに追加しました。");
    try {
      await fetch("/api/shop/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: props.listingId,
          eventType: "add_to_cart",
        }),
      });
    } catch {
      // Funnel write is best-effort; cart still works.
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void add()}
        aria-describedby={message ? "add-to-cart-status" : undefined}
        className="group flex w-full items-center justify-between gap-4 border border-cyan-300/70 bg-cyan-300 px-5 py-4 text-left text-sm font-medium tracking-[0.08em] text-zinc-950 transition duration-300 hover:-translate-y-0.5 hover:border-cyan-200 hover:bg-cyan-200 hover:shadow-[0_12px_40px_rgba(34,211,238,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:shadow-none"
      >
        <span>{disabled ? "現在購入できません" : "カートに入れる"}</span>
        <span aria-hidden="true" className="text-lg transition-transform duration-300 group-hover:translate-x-1">↗</span>
      </button>
      {disabled ? (
        <p className="mt-2 text-xs leading-5 text-amber-300">販売価格が確認できないため、購入操作を無効にしています。</p>
      ) : null}
      {message ? (
        <p id="add-to-cart-status" role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-xs text-cyan-200">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </div>
  );
}
