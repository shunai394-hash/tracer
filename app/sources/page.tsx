import { isBrightDataConfigured } from "@/lib/sources/brightdata";
import { isMcpConfigured } from "@/lib/sources/mcp";

export default function SourcesPage() {
  const brightData = isBrightDataConfigured();
  const mcp = isMcpConfigured();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Sources
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">外部世界データ</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        TRACER AI → Bright Data MCP → Web / Marketplace / Product Data。
        TRACER は MCP の client / tool consumer です。サーバー実装は持ちません。
      </p>
      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <article className="border border-cyan-500/15 p-6">
          <h2 className="text-lg text-zinc-100">Bright Data</h2>
          <p className="mt-2 font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">
            {brightData ? "Token present" : "Unset"}
          </p>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            API 呼び出しは `lib/sources/brightdata` に抽象化しています。この段階では取得を実行しません。
          </p>
        </article>
        <article className="border border-cyan-500/15 p-6">
          <h2 className="text-lg text-zinc-100">MCP consumer</h2>
          <p className="mt-2 font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">
            {mcp ? "Endpoint present" : "Unset"}
          </p>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            `lib/sources/mcp` から外部 MCP を利用できる設計です。ツール実行は未実装です。
          </p>
        </article>
      </div>
    </main>
  );
}
