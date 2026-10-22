import { ConnectionPanel } from "@/components/connection-panel";
import { OrderingSettingsForm } from "@/components/ordering-settings-form";
import { SelectionSettingsForm } from "@/components/selection-settings-form";
import { getFoundationStatus } from "@/lib/config/env";
import { EMPTY_SELECTION_SETTINGS } from "@/lib/intelligence/selection-config";
import { getSelectionSettings } from "@/lib/intelligence/selection-settings-store";
import { DEFAULT_ORDERING_SETTINGS } from "@/lib/ordering/types";
import { getOrderingSettings } from "@/lib/ordering/store";
import { SupabaseConfigError } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const status = getFoundationStatus();
  let selection = EMPTY_SELECTION_SETTINGS;
  let ordering = DEFAULT_ORDERING_SETTINGS;
  let settingsError: string | null = null;

  try {
    [selection, ordering] = await Promise.all([
      getSelectionSettings(),
      getOrderingSettings(),
    ]);
  } catch (error) {
    settingsError =
      error instanceof SupabaseConfigError
        ? "Supabase が未設定のためフィルタを読めません。"
        : error instanceof Error
          ? error.message
          : "設定を読み込めませんでした。";
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Settings
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">規則・注文・接続設定</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        商品選定フィルターと注文モードをここで設定します。APIキーなどの接続秘密情報そのものは、この画面では編集しません。
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <a href="/admin/operations" className="border border-cyan-300/40 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100 hover:bg-cyan-300/15">管理センター（BOT・規則一覧） →</a>
        <a href="/dashboard" className="border border-white/15 px-4 py-3 text-sm text-zinc-200 hover:bg-white/5">商品管理へ →</a>
      </div>
      <div className="mt-10 max-w-xl">
        <ConnectionPanel status={status} />
      </div>
      <section className="mt-8 max-w-xl text-sm leading-7 text-zinc-500">
        <p>必要な変数:</p>
        <p>NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY</p>
        <p>GEMINI_API_KEY / GEMINI_MODEL</p>
        <p>BRIGHTDATA_API_TOKEN / BRIGHTDATA_ZONE / BRIGHTDATA_MCP_URL</p>
      </section>

      <section className="mt-12 grid gap-8 lg:grid-cols-2">
        <article className="border border-cyan-500/15 p-5">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
            Default filters
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            空欄は判定に使いません。初期値を固定ハードコードしません。
          </p>
          {settingsError ? (
            <p className="mt-4 text-sm text-amber-300">{settingsError}</p>
          ) : (
            <div className="mt-4">
              <SelectionSettingsForm initial={selection} />
            </div>
          )}
        </article>
        <article className="border border-cyan-500/15 p-5">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
            Ordering
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            初期モードは APPROVAL です。AUTO は全 Gate 通過時のみ。
          </p>
          {settingsError ? (
            <p className="mt-4 text-sm text-amber-300">{settingsError}</p>
          ) : (
            <div className="mt-4">
              <OrderingSettingsForm initial={ordering} />
            </div>
          )}
        </article>
      </section>
    </main>
  );
}
