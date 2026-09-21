import { TracerChat } from "@/components/tracer-chat";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        AI Chat
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">データを読むアシスタント</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        FAQ ではなく、需要・商品・利益・予測・販売テストの実データを自然言語で確認します。
        存在しない数値は作りません。
      </p>
      <div className="mt-10">
        <TracerChat embedded />
      </div>
    </main>
  );
}
