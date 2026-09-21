"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useShopCart } from "@/components/shop-cart";

export function CheckoutForm() {
  const cart = useShopCart();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(formData: FormData) {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/shop/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: cart.items[0]?.listingId,
          eventType: "checkout",
        }),
      });

      const response = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.items.map((item) => ({
            listingId: item.listingId,
            qty: item.qty,
          })),
          customerName: String(formData.get("name") ?? ""),
          customerEmail: String(formData.get("email") ?? ""),
          customerPhone: String(formData.get("phone") ?? ""),
          shippingAddress: String(formData.get("address") ?? ""),
          paymentMethod: String(formData.get("payment") ?? "cash_on_delivery"),
          notes: String(formData.get("notes") ?? ""),
        }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        orderId?: string;
        error?: string;
      };
      if (!payload.ok || !payload.orderId) {
        throw new Error(payload.error ?? "注文できませんでした");
      }
      cart.clear();
      router.push(`/shop/thanks?order=${payload.orderId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "注文できませんでした");
    } finally {
      setBusy(false);
    }
  }

  if (cart.items.length === 0) {
    return <p className="text-sm text-zinc-400">カートは空です。</p>;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(new FormData(event.currentTarget));
      }}
    >
      <label className="block text-sm">
        氏名
        <input name="name" required className="mt-1 w-full border border-white/15 bg-black px-3 py-2" />
      </label>
      <label className="block text-sm">
        メール
        <input name="email" type="email" required className="mt-1 w-full border border-white/15 bg-black px-3 py-2" />
      </label>
      <label className="block text-sm">
        電話
        <input name="phone" required className="mt-1 w-full border border-white/15 bg-black px-3 py-2" />
      </label>
      <label className="block text-sm">
        配送先住所
        <textarea name="address" required className="mt-1 w-full border border-white/15 bg-black px-3 py-2" rows={3} />
      </label>
      <label className="block text-sm">
        支払い方法
        <select name="payment" className="mt-1 w-full border border-white/15 bg-black px-3 py-2">
          <option value="cash_on_delivery">代金引換</option>
          <option value="bank_transfer">銀行振込</option>
        </select>
      </label>
      <label className="block text-sm">
        備考
        <textarea name="notes" className="mt-1 w-full border border-white/15 bg-black px-3 py-2" rows={2} />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="border border-cyan-300 px-5 py-3 text-sm tracking-[0.16em] text-cyan-100 disabled:opacity-40"
      >
        {busy ? "送信中…" : "注文を確定する"}
      </button>
      {error ? <p className="text-sm text-amber-300">{error}</p> : null}
    </form>
  );
}
