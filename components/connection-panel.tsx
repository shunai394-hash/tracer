import type { FoundationStatus } from "@/lib/config/env";

function Row({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 py-3 last:border-b-0">
      <span className="text-sm text-zinc-300">{label}</span>
      <span
        className={
          ready
            ? "font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400"
            : "font-mono text-[11px] uppercase tracking-[0.18em] text-amber-400"
        }
      >
        {ready ? "Ready" : "Unset"}
      </span>
    </div>
  );
}

export function ConnectionPanel({ status }: { status: FoundationStatus }) {
  return (
    <section className="border border-cyan-500/15 bg-black/50 p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-400/80">
        Foundation
      </p>
      <h2 className="mt-2 text-lg text-zinc-100">接続状態</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        キーの有無だけを表示します。秘密情報は出しません。未設定の接続を、稼働中には見せません。
      </p>
      <div className="mt-4">
        <Row label="Supabase (URL + anon)" ready={status.supabasePublic} />
        <Row label="Supabase service role" ready={status.supabaseServiceRole} />
        <Row label="Gemini" ready={status.gemini} />
        <Row label="Bright Data" ready={status.brightData} />
        <Row label="Bright Data MCP" ready={status.brightDataMcp} />
      </div>
    </section>
  );
}
