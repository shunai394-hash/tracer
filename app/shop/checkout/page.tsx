import { ご注文Form } from "@/components/checkout-form";

export const metadata = { title: "ご注文手続き", robots: { index: false, follow: false } };

export default function ご注文Page() {
  const steps = [
    ["01", "連絡先"],
    ["02", "配送先"],
    ["03", "お支払い"],
    ["04", "注文確認"],
  ] as const;

  return (
    <main className="flex-1 bg-[#FBF6F1]">
      <section className="relative overflow-hidden border-b border-[#EADBD3]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_18%,rgba(154,107,91,0.10),transparent_30%)]" aria-hidden="true" />
        <div className="relative mx-auto max-w-[1200px] px-5 py-14 sm:px-8 sm:py-20 lg:px-10">
          <div className="tracer-reveal flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-mono uppercase tracking-[0.28em] text-[#7D675D]">
            <span className="text-[#9A6B5B]">TRACER SELECT</span>
            <span aria-hidden="true">/</span>
            <span>ご注文手続き</span>
          </div>
          <div className="mt-5 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="tracer-reveal tracer-reveal-delay-1">
              <h1 className="text-4xl tracking-[-0.055em] text-[#3B241A] sm:text-6xl">最後の確認。</h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-[#5C4035] sm:text-base sm:leading-8">
                配送先とお支払い方法を入力して、注文内容を確定します。必要な情報だけを、落ち着いて確認できます。
              </p>
            </div>
            <div className="tracer-reveal tracer-reveal-delay-2 hidden border-l border-[#EADBD3] pl-6 text-right lg:block">
              <p className="text-[9px] font-mono uppercase tracking-[0.24em] text-[#9A6B5B]">ご注文</p>
              <p className="mt-2 text-xs text-[#5C4035]">04 / 注文確認</p>
            </div>
          </div>
          <div className="tracer-reveal tracer-reveal-delay-3 mt-10 grid max-w-2xl grid-cols-4 gap-2" aria-label="購入手続きの進行状況">
            {steps.map(([number, label]) => (
              <div key={label} className="space-y-2">
                <div className="h-px bg-[#3B241A]/70" />
                <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.14em]">
                  <span className="text-[#9A6B5B]/70">{number}</span>
                  <span className="text-[#7D675D]">{label}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1200px] px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
        <ご注文Form />
      </section>
    </main>
  );
}
