import { ConnectionPanel } from "@/components/connection-panel";
import { getFoundationStatus } from "@/lib/config/env";

export default function DashboardPage() {
  const status = getFoundationStatus();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Dashboard
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">運用ダッシュボード</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        市場指標は観測が始まってから表示します。現時点では基盤の接続状態のみです。
      </p>
      <div className="mt-10 max-w-xl">
        <ConnectionPanel status={status} />
      </div>
    </main>
  );
}
