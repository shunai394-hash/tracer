import { ConnectionPanel } from "@/components/connection-panel";
import { getFoundationStatus } from "@/lib/config/env";

export default function SettingsPage() {
  const status = getFoundationStatus();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Settings
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">接続設定</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        値は `.env.local` または Vercel の環境変数に置きます。この画面では有無だけを確認できます。
      </p>
      <div className="mt-10 max-w-xl">
        <ConnectionPanel status={status} />
      </div>
      <section className="mt-8 max-w-xl text-sm leading-7 text-zinc-500">
        <p>必要な変数:</p>
        <p>NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY</p>
        <p>GEMINI_API_KEY / GEMINI_MODEL</p>
        <p>BRIGHTDATA_API_TOKEN / BRIGHTDATA_ZONE / BRIGHTDATA_MCP_URL</p>
      </section>
    </main>
  );
}
