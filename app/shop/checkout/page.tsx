import { CheckoutForm } from "@/components/checkout-form";

export default function CheckoutPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="text-3xl text-zinc-50">購入手続き</h1>
      <p className="mt-4 text-sm text-zinc-400">
        注文は観測データとして保存します。代金引換または銀行振込です。価格が unknown の商品は扱えません。
      </p>
      <div className="mt-8">
        <CheckoutForm />
      </div>
    </main>
  );
}
