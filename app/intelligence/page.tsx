import { IntelligencePingButton } from "@/components/intelligence-ping-button";
import { isGeminiConfigured } from "@/lib/ai/gemini";

export default function IntelligencePage() {
  const configured = isGeminiConfigured();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Intelligence
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">AI Intelligence</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        Gemini はサーバー側モジュール `lib/ai/gemini` からのみ呼び出します。
        商品判定や発掘ロジックはまだ実装していません。
      </p>
      <section className="mt-10 max-w-xl border border-cyan-500/15 bg-black/40 p-6">
        <p className="text-sm text-zinc-300">
          Gemini:{" "}
          <span className={configured ? "text-emerald-400" : "text-amber-400"}>
            {configured ? "キー設定あり" : "未設定"}
          </span>
        </p>
        <IntelligencePingButton />
      </section>
    </main>
  );
}
