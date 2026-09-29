import { isBaseConfigured } from "@/lib/channels/base";

type BaseListing = {
  id: string;
  title: string | null;
  published: boolean | null;
  base_item_id: string | null;
  base_publication_status: string | null;
  base_last_error: string | null;
  inventory: number | string | null;
  orderable: boolean | null;
  selling_price: number | null;
  image_url: string | null;
};

type Props = {
  configured: boolean;
  listings: BaseListing[];
  loadError: string | null;
};

function reason(listing: BaseListing): string {
  if (listing.base_last_error) return "BASE公開エラー";
  if (listing.base_item_id && listing.published !== true) return "TRACERで非公開";
  if (listing.selling_price === null) return "販売価格なし";
  if (!listing.image_url) return "商品画像なし";
  const inventory =
    typeof listing.inventory === "number"
      ? listing.inventory
      : typeof listing.inventory === "string" && listing.inventory.trim()
        ? Number(listing.inventory)
        : null;
  if (inventory === null || !Number.isFinite(inventory)) return "在庫不明";
  if (inventory <= 0) return "在庫0";
  if (listing.orderable !== true) return "仕入先が注文可能ではない";
  return "公開条件を満たしています";
}

export function BaseOperationsPanel({ configured, listings, loadError }: Props) {
  const published = listings.filter((item) => item.base_item_id && item.published === true);
  const failed = listings.filter((item) => item.base_last_error);
  const blocked = listings.filter((item) => item.published === true && !item.base_item_id && !item.base_last_error);
  const ready = listings.filter((item) => {
    if (item.published !== true || item.base_item_id) return false;
    if (item.selling_price === null || !item.image_url || item.orderable !== true) return false;
    const inventory = typeof item.inventory === "number" ? item.inventory : Number(item.inventory);
    return Number.isFinite(inventory) && inventory > 0;
  });

  return (
    <section className="mt-10 border border-cyan-500/15 bg-black/50 p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-400/80">BASE Operations</p>
          <h2 className="mt-2 text-lg text-zinc-100">販売チャネル状態</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            TRACERを商品マスターとして、BASE公開条件と実行結果を確認します。認証情報は表示しません。
          </p>
        </div>
        <span className={configured ? "font-mono text-xs text-emerald-400" : "font-mono text-xs text-amber-400"}>
          {configured ? "BASE CONFIGURED" : "BASE NOT CONFIGURED"}
        </span>
      </div>

      {loadError ? (
        <p className="mt-5 border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-300">
          商品公開状態を読み込めませんでした: {loadError}
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            {[
              ["公開済み", published.length],
              ["公開可能", ready.length],
              ["ブロック", blocked.length],
              ["失敗", failed.length],
            ].map(([label, value]) => (
              <div key={String(label)} className="border border-white/5 p-4">
                <p className="text-xs text-zinc-500">{label}</p>
                <p className="mt-2 text-2xl text-zinc-100">{value}</p>
              </div>
            ))}
          </div>

          {failed.length > 0 ? (
            <div className="mt-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-400">Failed</p>
              <div className="mt-3 space-y-2">
                {failed.slice(0, 10).map((item) => (
                  <div key={item.id} className="border border-amber-500/15 p-3">
                    <p className="text-sm text-zinc-200">{item.title ?? item.id}</p>
                    <p className="mt-1 break-words text-xs text-amber-300">{item.base_last_error}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {blocked.length > 0 ? (
            <div className="mt-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Blocked</p>
              <div className="mt-3 space-y-2">
                {blocked.slice(0, 10).map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border border-white/5 p-3">
                    <p className="text-sm text-zinc-200">{item.title ?? item.id}</p>
                    <p className="text-xs text-zinc-500">{reason(item)}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
