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
        className="border border-cyan-300 px-5 py-3 text-sm tracking-[0.16em] text-cyan-100 disabled:opacity-40"
      >
        カートに入れる
      </button>
      {disabled ? (
        <p className="mt-2 text-sm text-amber-300">販売価格が unknown のため購入できません。</p>
      ) : null}
      {message ? <p className="mt-2 text-sm text-zinc-400">{message}</p> : null}
    </div>
  );
}
