import { CheckoutForm } from "@/components/checkout-form";

export default function CheckoutPage() {
  return (
    <main className="flex-1 bg-[#07090b]">
      <section className="relative overflow-hidden border-b border-white/8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_18%,rgba(34,211,238,0.08),transparent_30%)]" aria-hidden="true" />
        <div className="relative mx-auto max-w-[1200px] px-5 py-14 sm:px-8 sm:py-20 lg:px-10">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-mono uppercase tracking-[0.28em] text-zinc-600">
            <span className="text-cyan-300/80">TRACER SELECTED</span>
            <span aria-hidden="true">/</span>
            <span>Secure checkout</span>
          </div>
          <div className="mt-5 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <h1 className="text-4xl tracking-[-0.055em] text-zinc-50 sm:text-6xl">最後の確認。</h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-zinc-500 sm:text-base sm:leading-8">
                配送先とお支払い方法を入力して、注文内容を確定します。必要な情報だけを、落ち着いて確認できます。
              </p>
            </div>
            <div className="hidden border-l border-white/10 pl-6 text-right lg:block">
              <p className="text-[9px] font-mono uppercase tracking-[0.24em] text-zinc-700">Checkout</p>
              <p className="mt-2 text-xs text-zinc-500">04 / Final check</p>
            </div>
          </div>
          <div className="mt-10 grid max-w-2xl grid-cols-4 gap-2" aria-label="購入手続きの進行状況">
            {[
              ["01", "Contact", true],
              ["02", "Shipping", true],
              ["03", "Payment", true],
              ["04", "Confirm", true],
            ].map(([number, label, active]) => (
              <div key={label} className="space-y-2">
                <div className={`h-px ${active ? "bg-cyan-300/70" : "bg-white/10"}`} />
                <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.14em]">
                  <span className="text-cyan-200/70">{number}</span>
                  <span className="text-zinc-600">{label}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1200px] px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
        <CheckoutForm />
      </section>
    </main>
  );
}
