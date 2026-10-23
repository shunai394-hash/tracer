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
        className="group flex w-full items-center justify-center gap-3 rounded-full bg-[#3B241A] px-6 py-4 text-sm font-medium text-white transition hover:bg-[#5C4035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span>{disabled ? "現在購入できません" : "カートに入れる"}</span>
        
      </button>
      {disabled ? (
        <p className="mt-2 text-xs leading-5 text-[#B84A62]">販売価格が確認できないため、購入操作を無効にしています。</p>
      ) : null}
      {message ? (
        <p id="add-to-cart-status" role="status" aria-live="polite" className="mt-3 flex items-center justify-center gap-2 text-xs text-[#5C4035]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#B84A62]" aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </div>
  );
}
