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
        body: JSON.stringify({ listingId: cart.items[0]?.listingId, eventType: "checkout" }),
      });

      const response = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.items.map((item) => ({ listingId: item.listingId, qty: item.qty })),
          customerName: String(formData.get("name") ?? ""),
          customerEmail: String(formData.get("email") ?? ""),
          customerPhone: String(formData.get("phone") ?? ""),
          shippingAddress: String(formData.get("address") ?? ""),
          shippingCountryCode: String(formData.get("countryCode") ?? ""),
          shippingProvince: String(formData.get("province") ?? ""),
          shippingCity: String(formData.get("city") ?? ""),
          shippingZip: String(formData.get("zip") ?? ""),
          shippingLine1: String(formData.get("line1") ?? ""),
          paymentMethod: String(formData.get("payment") ?? "cash_on_delivery"),
          notes: String(formData.get("notes") ?? ""),
        }),
      });
      const payload = (await response.json()) as { ok: boolean; orderId?: string; checkoutUrl?: string | null; error?: string };
      if (!payload.ok || !payload.orderId) throw new Error(payload.error ?? "注文できませんでした");
      cart.clear();
      if (payload.checkoutUrl) {
        window.location.href = payload.checkoutUrl;
        return;
      }
      router.push(`/shop/thanks?order=${payload.orderId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "注文できませんでした");
    } finally {
      setBusy(false);
    }
  }

  if (cart.items.length === 0) {
    return (
      <div className="border border-white/10 bg-[#0a0d10] px-6 py-14 text-center">
        <h2 className="text-xl text-zinc-100">カートは空です。</h2>
        <p className="mt-3 text-sm text-zinc-500">購入する商品を先に選んでください。</p>
      </div>
    );
  }

  const fieldClass = "mt-2 w-full border border-white/10 bg-[#07090b] px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-700 hover:border-white/20 focus:border-cyan-300/60 focus:ring-1 focus:ring-cyan-300/20";
  const sectionClass = "border border-white/10 bg-[#0a0d10] p-5 sm:p-7";

  return (
    <form
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(new FormData(event.currentTarget));
      }}
    >
      <div className="space-y-5">
        <section className={sectionClass} aria-labelledby="contact-heading">
          <div className="flex items-start justify-between gap-6">
            <div><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600">01 / Contact</p><h2 id="contact-heading" className="mt-2 text-lg text-zinc-100">連絡先</h2></div>
            <span className="text-[10px] text-zinc-700">必須項目あり</span>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="text-xs text-zinc-400">氏名<input name="name" required autoComplete="name" className={fieldClass} /></label>
            <label className="text-xs text-zinc-400">メール<input name="email" type="email" required autoComplete="email" className={fieldClass} /></label>
            <label className="text-xs text-zinc-400 sm:col-span-2">電話<input name="phone" required autoComplete="tel" className={fieldClass} /></label>
          </div>
        </section>

        <section className={sectionClass} aria-labelledby="shipping-heading">
          <div><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600">02 / Shipping</p><h2 id="shipping-heading" className="mt-2 text-lg text-zinc-100">配送先</h2></div>
          <label className="mt-6 block text-xs text-zinc-400">配送先住所（表示用）<textarea name="address" required autoComplete="street-address" rows={3} className={fieldClass} /></label>
          <p className="mt-3 border-l border-amber-300/20 pl-3 text-xs leading-5 text-zinc-600">実発注に必要な住所情報も下で確認します。未入力の項目がある場合、実発注は安全側にブロックされます。</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="text-xs text-zinc-400">国コード（例: JP）<input name="countryCode" maxLength={2} autoComplete="country" className={fieldClass + " uppercase"} /></label>
            <label className="text-xs text-zinc-400">郵便番号<input name="zip" autoComplete="postal-code" className={fieldClass} /></label>
            <label className="text-xs text-zinc-400">都道府県 / 州<input name="province" autoComplete="address-level1" className={fieldClass} /></label>
            <label className="text-xs text-zinc-400">市区町村<input name="city" autoComplete="address-level2" className={fieldClass} /></label>
          </div>
          <label className="mt-4 block text-xs text-zinc-400">番地・建物名<input name="line1" autoComplete="address-line1" className={fieldClass} /></label>
        </section>

        <section className={sectionClass} aria-labelledby="payment-heading">
          <div><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600">03 / Payment</p><h2 id="payment-heading" className="mt-2 text-lg text-zinc-100">支払い方法</h2></div>
          <label className="mt-6 block text-xs text-zinc-400">支払い方法
            <select name="payment" defaultValue="card" className={fieldClass}>
              <option value="card">カード決済（Stripe）</option>
              <option value="cash_on_delivery">代金引換</option>
              <option value="bank_transfer">銀行振込</option>
            </select>
          </label>
          <label className="mt-4 block text-xs text-zinc-400">備考<textarea name="notes" rows={2} className={fieldClass} placeholder="配送についての希望など（任意）" /></label>
        </section>
      </div>

      <aside className="border border-cyan-300/15 bg-[#0a0d10] p-6 lg:sticky lg:top-24" aria-label="注文確認">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-300/60">Final check</p>
        <h2 className="mt-3 text-xl tracking-[-0.03em] text-zinc-100">確認して、次へ。</h2>
        <div className="mt-6 space-y-3 border-y border-white/8 py-5">
          {cart.items.map((item) => (
            <div key={item.listingId} className="flex gap-3 text-xs">
              <span className="min-w-0 flex-1 leading-5 text-zinc-400">{item.title} × {item.qty}</span>
              <span className="text-zinc-200">{item.currency} {item.unitPrice * item.qty}</span>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs leading-5 text-zinc-600">カード決済の場合、次にStripeの安全な決済画面へ移動します。</p>
        <button type="submit" disabled={busy} aria-busy={busy} className="group mt-6 flex min-h-12 w-full items-center justify-between bg-cyan-300 px-5 text-xs font-semibold tracking-[0.08em] text-zinc-950 transition hover:-translate-y-0.5 hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 disabled:cursor-wait disabled:opacity-50 disabled:hover:translate-y-0">
          {busy ? "注文を処理しています…" : "注文を確定する"}<span className="text-lg transition-transform group-hover:translate-x-1" aria-hidden="true">→</span>
        </button>
        {error ? <p role="alert" className="mt-4 border border-amber-300/15 bg-amber-300/[0.025] p-3 text-xs leading-5 text-amber-200">{error}</p> : null}
        <p className="mt-4 text-center text-[10px] tracking-[0.08em] text-zinc-700">TRACER · VERIFIED COMMERCE FLOW</p>
      </aside>
    </form>
  );
}
