"use client";

import { useCallback, useState } from "react";

type Listing = {
  id: string;
  product_id: string;
  slug: string;
  title: string;
  description: string | null;
  image_url: string | null;
  selling_price: number | null;
  currency: string | null;
  inventory: number | null;
  published: boolean;
  published_at: string | null;
  manual_inventory?: boolean;
  supplier_name?: string | null;
  supplier_product_id?: string | null;
  supplier_variant_id?: string | null;
  shopify_product_id?: string | null;
  base_item_id?: string | null;
};

const emptyForm = { id: "", title: "", description: "", imageUrl: "", price: "", inventory: "1", published: false };

export function ManualInventoryPanel() {
  const [token, setToken] = useState("");
  const [listings, setListings] = useState<Listing[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!token.trim()) {
      setMessage("管理トークンを入力してください。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/manual-inventory", {
        headers: { Authorization: `Bearer ${token.trim()}` },
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(response.status === 401 ? "管理トークンが正しくありません。" : body.error ?? "商品を読み込めませんでした。");
      setListings(body.listings ?? []);
      setLoaded(true);
      setMessage(`${(body.listings ?? []).length}件の商品を読み込みました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  function edit(listing: Listing) {
    setForm({
      id: listing.id,
      title: listing.title ?? "",
      description: listing.description ?? "",
      imageUrl: listing.image_url ?? "",
      price: listing.selling_price == null ? "" : String(listing.selling_price),
      inventory: String(listing.inventory ?? 0),
      published: listing.published === true,
    });
    setMessage("編集内容を入力し、保存してください。");
  }

  async function manageListing(id: string, action: "unpublish" | "archive", title: string) {
    const verb = action === "archive" ? "アーカイブ" : "TRACER掲載停止";
    if (!window.confirm(`「${title}」を${verb}しますか？${action === "archive" ? "\n完全削除ではなく、一覧から退避します。" : "\nBASE・Shopifyの掲載状態は変更しません。"}`)) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/manual-inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify({ action, id }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? `${verb}に失敗しました。`);
      setMessage(body.message ?? `${verb}しました。`);
      if (form.id === id) setForm(emptyForm);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${verb}に失敗しました。`);
    } finally {
      setLoading(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim()) {
      setMessage("管理トークンを入力してください。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/manual-inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify({
          id: form.id || undefined,
          title: form.title,
          description: form.description,
          imageUrl: form.imageUrl,
          price: Number(form.price),
          inventory: Number(form.inventory),
          published: form.published,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "保存に失敗しました。");
      setMessage(form.published ? "保存しました。公開条件を満たした商品はTRACERの商品一覧に掲載されます。" : "保存しました。非公開で保存しました。");
      setForm(emptyForm);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-10 border border-cyan-300/20 bg-[#0a0d10] p-5 text-zinc-100 sm:p-7" aria-labelledby="manual-inventory-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/70">TRACER Store Management</p>
          <h2 id="manual-inventory-heading" className="mt-2 text-xl">商品管理｜追加・編集・掲載停止</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            商品を追加し、TRACER掲載を停止できます。編集・アーカイブは手動管理商品だけに対応します。仕入先連携商品はここで削除せず、掲載停止のみ行います。BASE・Shopify側の掲載状態は別管理です。
          </p>
        </div>
        <a href="/shop" target="_blank" rel="noreferrer" className="border border-white/15 px-3 py-2 text-xs text-cyan-200 hover:bg-white/5">公開商品一覧を見る ↗</a>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <label className="flex-1 text-xs text-zinc-400">
          管理トークン
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="TRACER_ADMIN_TOKEN"
            className="mt-2 w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300"
          />
        </label>
        <button type="button" onClick={() => void load()} disabled={loading || !token.trim()} className="self-end border border-cyan-300/40 px-4 py-2.5 text-sm text-cyan-200 disabled:opacity-40">
          {loading ? "処理中…" : "商品を読み込む"}
        </button>
      </div>

      <form onSubmit={save} className="mt-7 grid gap-4 border-t border-white/10 pt-6 sm:grid-cols-2">
        <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">{form.id ? "商品を編集" : "新しい商品を登録"}</h3>
          {form.id ? <button type="button" onClick={() => setForm(emptyForm)} className="text-xs text-zinc-400 underline">新規登録に切り替え</button> : null}
        </div>
        <label className="text-xs text-zinc-400">商品名 *
          <input required maxLength={180} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-2 w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white" />
        </label>
        <label className="text-xs text-zinc-400">販売価格（円）*
          <input required type="number" min="0" step="1" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} className="mt-2 w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white" />
        </label>
        <label className="text-xs text-zinc-400 sm:col-span-2">商品説明 *
          <textarea required maxLength={10000} rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-2 w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white" />
        </label>
        <label className="text-xs text-zinc-400 sm:col-span-2">商品画像URL（HTTPS）*
          <input required type="url" value={form.imageUrl} onChange={(event) => setForm({ ...form, imageUrl: event.target.value })} placeholder="https://..." className="mt-2 w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white" />
        </label>
        <label className="text-xs text-zinc-400">手動管理する在庫数 *
          <input required type="number" min="0" max="1000000" step="1" value={form.inventory} onChange={(event) => setForm({ ...form, inventory: event.target.value })} className="mt-2 w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white" />
        </label>
        <label className="flex items-center gap-3 self-end border border-white/10 p-3 text-sm">
          <input type="checkbox" checked={form.published} onChange={(event) => setForm({ ...form, published: event.target.checked })} />
          TRACERの商品一覧に公開する
        </label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={loading} className="bg-cyan-300 px-5 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40">{loading ? "保存中…" : form.published ? "保存して公開" : "非公開で保存"}</button>
          <p className="text-xs leading-5 text-zinc-500">公開には商品名・説明・HTTPS画像・1個以上の在庫・正の販売価格が必要です。</p>
        </div>
      </form>

      {message ? <p role="status" aria-live="polite" className="mt-5 border border-white/10 bg-black/30 p-3 text-sm text-cyan-100">{message}</p> : null}

      {loaded ? (
        <div className="mt-7 space-y-2">
          <h3 className="mb-3 text-sm font-medium">掲載商品一覧（{listings.length}件）</h3>
          {listings.length === 0 ? <p className="border border-white/10 p-4 text-sm text-zinc-500">商品がありません。上のフォームから手動商品を登録できます。</p> : listings.map((listing) => (
            <article key={listing.id} className="flex flex-col gap-3 border border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm">{listing.title}</p>
                  <span className={listing.manual_inventory ? "border border-cyan-300/30 px-2 py-0.5 text-[10px] text-cyan-200" : "border border-white/15 px-2 py-0.5 text-[10px] text-zinc-400"}>{listing.manual_inventory ? "手動管理" : "仕入先連携"}</span>
                  <span className={listing.published ? "text-[10px] text-emerald-300" : "text-[10px] text-zinc-500"}>{listing.published ? "TRACER公開中" : "TRACER非公開"}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">¥{Number(listing.selling_price ?? 0).toLocaleString("ja-JP")} · 在庫 {listing.inventory ?? 0}</p>
                {!listing.manual_inventory ? <p className="mt-1 text-xs text-zinc-500">仕入先: {listing.supplier_name ?? "未設定"} · BASE/Shopifyの掲載は各チャネルで別管理</p> : null}
                <p className="mt-1 break-all font-mono text-[10px] text-zinc-600">{listing.id}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <a href={`/shop/${listing.slug}`} target="_blank" rel="noreferrer" className="border border-white/15 px-3 py-2 text-xs text-zinc-300">商品ページ ↗</a>
                {listing.manual_inventory ? <button type="button" onClick={() => edit(listing)} disabled={loading} className="border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200 disabled:opacity-40">編集</button> : null}
                {listing.published ? <button type="button" onClick={() => void manageListing(listing.id, "unpublish", listing.title)} disabled={loading} className="border border-amber-300/40 px-3 py-2 text-xs text-amber-200 disabled:opacity-40">掲載停止</button> : null}
                {listing.manual_inventory ? <button type="button" onClick={() => void manageListing(listing.id, "archive", listing.title)} disabled={loading} className="border border-red-300/30 px-3 py-2 text-xs text-red-200 disabled:opacity-40">アーカイブ</button> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
