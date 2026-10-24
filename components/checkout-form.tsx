"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useShopCart } from "@/components/shop-cart";
import { formatMoney } from "@/lib/intelligence/format-display";

export function CheckoutForm() {
  const cart = useShopCart();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(formData: FormData) {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/shop/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listingId: cart.items[0]?.listingId, eventType: "checkout" }) });
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
      if (payload.checkoutUrl) { window.location.href = payload.checkoutUrl; return; }
      router.push(`/shop/thanks?order=${payload.orderId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "注文できませんでした");
    } finally { setBusy(false); }
  }

  if (cart.items.length === 0) {
    return <div className="relative overflow-hidden border border-[#EADBD3] bg-white px-6 py-16 text-center sm:px-10"><div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent" aria-hidden="true" /><span className="mx-auto flex h-12 w-12 items-center justify-center border border-cyan-300/20 text-lg text-[#9A6B5B]" aria-hidden="true">＋</span><p className="mt-6 text-[9px] font-mono uppercase tracking-[0.3em] text-[#9A6B5B]">Nothing to check out</p><h2 className="mt-3 text-xl text-[#3B241A]">カートは空です。</h2><p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#3B241A]0">購入する商品を選んでから、こちらへ戻ってきてください。</p><Link href="/shop" className="mt-7 inline-flex min-h-11 items-center bg-[#3B241A] px-6 text-xs font-semibold tracking-[0.08em] text-white transition duration-300 hover:-translate-y-0.5 hover:bg-[#5C4035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B]">商品を見る <span className="ml-4" aria-hidden="true">→</span></Link></div>;
  }

  const fieldClass = "mt-2 w-full border border-[#EADBD3] bg-[#FBF6F1] px-4 py-3.5 text-sm text-[#3B241A] outline-none transition placeholder:text-[#9A6B5B] hover:border-[#D8C1B5] focus:border-[#9A6B5B] focus:ring-2 focus:ring-cyan-300/10";
  const sectionClass = "border border-[#EADBD3] bg-white p-5 sm:p-7";
  const total = cart.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  const currency = cart.items[0]?.currency ?? null;

  return <form className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start" onSubmit={(event) => { event.preventDefault(); void submit(new FormData(event.currentTarget)); }}>
    <div className="space-y-5">
      <section className={sectionClass} aria-labelledby="contact-heading"><div className="flex items-start justify-between gap-6"><div><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-[#9A6B5B]">01 / Contact</p><h2 id="contact-heading" className="mt-2 text-xl tracking-[-0.02em] text-[#3B241A]">連絡先</h2></div><span className="mt-1 text-[10px] text-[#9A6B5B]">すべて必須</span></div><div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="text-xs text-[#5C4035]">氏名<input name="name" required autoComplete="name" className={fieldClass} /></label><label className="text-xs text-[#5C4035]">メール<input name="email" type="email" required autoComplete="email" className={fieldClass} /></label><label className="text-xs text-[#5C4035] sm:col-span-2">電話<input name="phone" required autoComplete="tel" className={fieldClass} /></label></div></section>
      <section className={sectionClass} aria-labelledby="shipping-heading"><div><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-[#9A6B5B]">02 / Shipping</p><h2 id="shipping-heading" className="mt-2 text-xl tracking-[-0.02em] text-[#3B241A]">配送先</h2></div><label className="mt-6 block text-xs text-[#5C4035]">住所<textarea name="address" required autoComplete="street-address" rows={3} className={fieldClass} placeholder="〒100-0000 東京都…" /></label><div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="text-xs text-[#5C4035]">国<input name="countryCode" required maxLength={2} autoComplete="country" defaultValue="JP" className={fieldClass + " uppercase"} /></label><label className="text-xs text-[#5C4035]">郵便番号<input name="zip" required autoComplete="postal-code" className={fieldClass} /></label><label className="text-xs text-[#5C4035]">都道府県 / 州<input name="province" required autoComplete="address-level1" className={fieldClass} /></label><label className="text-xs text-[#5C4035]">市区町村<input name="city" required autoComplete="address-level2" className={fieldClass} /></label></div><label className="mt-4 block text-xs text-[#5C4035]">番地・建物名<input name="line1" required autoComplete="address-line1" className={fieldClass} /></label></section>
      <section className={sectionClass} aria-labelledby="payment-heading"><div><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-[#9A6B5B]">03 / Payment</p><h2 id="payment-heading" className="mt-2 text-xl tracking-[-0.02em] text-[#3B241A]">お支払い</h2></div><label className="mt-6 block text-xs text-[#5C4035]">支払い方法<select name="payment" defaultValue="card" className={fieldClass}><option value="card">カード決済（Stripe）</option><option value="cash_on_delivery">代金引換</option><option value="bank_transfer">銀行振込</option></select></label><div className="mt-4 flex gap-3 border border-[#EADBD3] bg-[#FBF6F1] p-4"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#3B241A]" aria-hidden="true" /><p className="text-xs leading-5 text-[#3B241A]0">カード決済を選んだ場合は、注文確定後にStripeの安全な決済画面へ移動します。</p></div><label className="mt-4 block text-xs text-[#5C4035]">備考<textarea name="notes" rows={2} className={fieldClass} placeholder="配送についての希望など（任意）" /></label></section>
    </div>
    <aside className="border border-[#EADBD3] bg-white p-6 shadow-2xl shadow-[#3B241A]/5 sm:p-7 lg:sticky lg:top-24" aria-label="注文確認"><p className="text-[10px] font-mono uppercase tracking-[0.22em] text-[#9A6B5B]">04 / Final check</p><h2 className="mt-3 text-2xl tracking-[-0.035em] text-[#3B241A]">この内容で注文する。</h2><div className="mt-7 space-y-4 border-y border-[#EADBD3] py-5">{cart.items.map((item) => <div key={item.listingId} className="flex gap-4 text-xs"><span className="min-w-0 flex-1 leading-5 text-[#5C4035]">{item.title} <span className="text-[#9A6B5B]">× {item.qty}</span></span><span className="shrink-0 text-[#3B241A]">{formatMoney(item.unitPrice * item.qty, item.currency)}</span></div>)}</div><div className="mt-6 flex items-end justify-between"><span className="text-xs text-[#9A6B5B]">合計</span><span className="text-3xl tracking-[-0.04em] text-[#3B241A]">{formatMoney(total, currency)}</span></div><p className="mt-5 text-[11px] leading-5 text-[#9A6B5B]">注文内容を確認してから確定してください。</p><button type="submit" disabled={busy} aria-busy={busy} className="group mt-6 flex min-h-13 w-full items-center justify-between bg-[#3B241A] px-5 text-xs font-semibold tracking-[0.08em] text-white transition duration-300 hover:-translate-y-0.5 hover:bg-[#5C4035] hover:shadow-[0_16px_48px_rgba(59,36,26,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9A6B5B] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-wait disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none">{busy ? "処理しています…" : "注文を確定する"}<span className="text-lg transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true">→</span></button>{error ? <p role="alert" className="mt-4 border border-amber-300/15 bg-amber-300/[0.025] p-3 text-xs leading-5 text-amber-200">{error}</p> : null}<div className="mt-5 flex items-center justify-center gap-2 text-[9px] font-mono uppercase tracking-[0.16em] text-[#9A6B5B]"><span className="h-1.5 w-1.5 rounded-full bg-[#3B241A]/70" aria-hidden="true" />Secure checkout</div></aside>
  </form>;
}
