import { CheckoutForm } from "@/components/checkout-form";

export default function CheckoutPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12 sm:px-6 sm:py-16">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-cyan-300/70">
        Final step
      </p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight text-zinc-50">
        購入手続き
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
        選んだ商品と配送先を確認して、注文内容を送信してください。
        支払い方法は代金引換または銀行振込です。表示価格が確認できない商品は購入手続きに進めません。
      </p>
      <div className="mt-8 border border-white/10 bg-zinc-950/40 p-5 sm:p-6">
        <CheckoutForm />
      </div>
    </main>
  );
}
