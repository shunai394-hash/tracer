import { CheckoutForm } from "@/components/checkout-form";

export default function CheckoutPage() {
  return (
    <main className="flex-1 bg-[#07090b]">
      <section className="border-b border-white/8">
        <div className="mx-auto max-w-[1200px] px-5 py-14 sm:px-8 sm:py-20 lg:px-10">
          <p className="text-[10px] font-mono uppercase tracking-[0.32em] text-cyan-300/70">02 / Checkout</p>
          <h1 className="mt-3 text-4xl tracking-[-0.05em] text-zinc-50 sm:text-5xl">購入手続き</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-500">
            配送先と支払い方法を確認します。注文情報は販売テストの観測データとしても安全に記録されます。
          </p>
        </div>
      </section>
      <section className="mx-auto max-w-[1200px] px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
        <CheckoutForm />
      </section>
    </main>
  );
}
