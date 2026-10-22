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
  archived_at?: string | null;
};

const emptyForm = { id: "", title: "", description: "", imageUrl: "", price: "", inventory: "1", published: false };

export function ManualInventoryPanel() {
  const [token, setToken] = useState("");
  const [listings, setListings] = useState<Listing[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");

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

  async function archive(listing: Listing) {
    if (!token.trim()) { setMessage("先に管理トークンを入力してください。"); return; }
    if (!window.confirm(`「${listing.title}」を非公開にして退避します。商品データは削除されず、復元できます。よろしいですか？`)) return;
    setLoading(true); setMessage("");
    try {
      const response = await fetch("/api/admin/manual-inventory", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` }, body: JSON.stringify({ id: listing.id }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "商品を退避できませんでした。");
      setMessage("商品を非公開にして退避しました。商品データは保持されています。");
      if (form.id === listing.id) setForm(emptyForm);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "退避に失敗しました。"); }
    finally { setLoading(false); }
  }

  async function restore(listing: Listing) {
    if (!token.trim()) { setMessage("先に管理トークンを入力してください。"); return; }
    setLoading(true); setMessage("");
    try {
      const response = await fetch("/api/admin/manual-inventory", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` }, body: JSON.stringify({ id: listing.id, action: "restore" }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "商品を復元できませんでした。");
      setMessage("商品データを復元しました。誤公開防止のため非公開で復元しました。編集して公開してください。");
      setView("active");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "復元に失敗しました。"); }
    finally { setLoading(false); }
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
          <h2 id="manual-inventory-heading" className="mt-2 text-xl">商品登録・在庫・公開管理</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            TRACERの商品一覧に掲載する商品を手動登録できます。BASE・Shopifyの公開状態とは独立しています。在庫はここで入力した数を管理します。
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
        <div className="mt-7 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">商品管理（{listings.filter((item) => !item.archived_at).length}件）</h3>
            <div className="flex gap-2">
              <button type="button" onClick={() => setView("active")} className={`border px-3 py-2 text-xs ${view === "active" ? "border-cyan-300/60 text-cyan-100" : "border-white/15 text-zinc-400"}`}>販売・管理中</button>
              <button type="button" onClick={() => setView("archived")} className={`border px-3 py-2 text-xs ${view === "archived" ? "border-cyan-300/60 text-cyan-100" : "border-white/15 text-zinc-400"}`}>退避済み</button>
            </div>
          </div>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名で検索…" aria-label="商品名で検索" className="w-full border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white" />
          {(() => {
            const visible = listings.filter((listing) => Boolean(listing.archived_at) === (view === "archived") && listing.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
            if (visible.length === 0) return <p className="border border-white/10 p-4 text-sm text-zinc-500">{view === "archived" ? "退避済み商品はありません。" : "商品がありません。上のフォームから登録できます。"}</p>;
            return visible.map((listing) => (
              <article key={listing.id} className={`flex flex-col gap-3 border p-4 sm:flex-row sm:items-center sm:justify-between ${listing.archived_at ? "border-amber-300/20 opacity-80" : "border-white/10"}`}>
                <div className="min-w-0">
                  <p className="text-sm">{listing.title}</p>
                  <p className="mt-1 text-xs text-zinc-400">¥{Number(listing.selling_price ?? 0).toLocaleString("ja-JP")} · 在庫 {listing.inventory ?? 0} · {listing.archived_at ? "退避済み" : listing.published ? "公開設定ON" : "非公開"}</p>
                  <p className="mt-1 break-all font-mono text-[10px] text-zinc-600">{listing.id}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <a href={`/shop/${listing.slug}`} target="_blank" rel="noreferrer" className="border border-white/15 px-3 py-2 text-xs text-zinc-300">商品ページ ↗</a>
                  {listing.archived_at ? (
                    <button type="button" disabled={loading} onClick={() => void restore(listing)} className="border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200 disabled:opacity-40">復元</button>
                  ) : (
                    <>
                      <button type="button" disabled={loading} onClick={() => edit(listing)} className="border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200 disabled:opacity-40">編集</button>
                      <button type="button" disabled={loading} onClick={() => void archive(listing)} className="border border-amber-300/30 px-3 py-2 text-xs text-amber-200 disabled:opacity-40">非公開・退避</button>
                    </>
                  )}
                </div>
              </article>
            ));
          })()}
          <p className="text-xs leading-5 text-zinc-500">「非公開・退避」は完全削除ではありません。商品情報を保持して一覧から外し、必要なら復元できます。公開設定ONでも、画像・在庫・商品情報などの公開条件を満たさない商品は表示されません。</p>
        </div>
      ) : null}
    </section>
  );
}
