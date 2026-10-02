"use client";

import { useEffect, useMemo, useState } from "react";

type Mapping = {
  id: string;
  shop_listing_id: string;
  shop_title: string | null;
  base_item_id: string | null;
  supplier_listing_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_title: string | null;
  supplier_external_id: string | null;
  supplier_sku: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  cost: number | null;
  shipping_cost: number | null;
  inventory: number | null;
  orderable: boolean | null;
  tracking_available: boolean | null;
  auto_order_enabled: boolean;
  auto_payment_enabled: boolean;
  auto_tracking_enabled: boolean;
  automation_status: string;
  mapping_verification_status: string;
  fully_automatable: boolean;
};

type Candidate = {
  id: string;
  title: string | null;
  base_item_id: string | null;
  published: boolean | null;
  supplier_name: string | null;
  inventory: number | null;
  orderable: boolean | null;
};

type SupplierListing = {
  id: string;
  supplier: string;
  title: string | null;
  external_id: string | null;
  sku: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  cost: number | null;
  shipping_cost: number | null;
  inventory: number | null;
  orderable: boolean | null;
  price_confirmed: boolean | null;
  inventory_confirmed: boolean | null;
  tracking_available: boolean | null;
  verification_status: string | null;
};

type Account = {
  id: string;
  code: string;
  display_name: string;
  active: boolean;
  order_automation_status: string;
  payment_automation_status: string;
  shipping_tracking_status: string;
};

export default function SupplierMappingsPage() {
  const [secret, setSecret] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [shops, setShops] = useState<Candidate[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierListing[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [shopId, setShopId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSupplier = suppliers.find((item) => item.id === supplierId);
  const matchingSuppliers = useMemo(
    () => suppliers.filter((item) => !shopId || item.supplier === shops.find((shop) => shop.id === shopId)?.supplier_name),
    [suppliers, shops, shopId],
  );

  async function load() {
    const response = await fetch("/api/admin/supplier-mappings?includeCandidates=1", { cache: "no-store" });
    if (response.status === 401) {
      setLoggedIn(false);
      return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "読み込みに失敗しました");
    setLoggedIn(true);
    setMappings(data.mappings ?? []);
    setShops(data.candidates?.shopListings ?? []);
    setSuppliers(data.candidates?.supplierListings ?? []);
    setAccounts(data.candidates?.accounts ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      try {
        await load();
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "ログインに失敗しました");
      setSecret("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createMapping(event: React.FormEvent) {
    event.preventDefault();
    if (!shopId || !supplierId || !accountId) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/supplier-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopListingId: shopId,
          supplierListingId: supplierId,
          supplierAccountId: accountId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "紐づけに失敗しました");
      setMessage("固定マッピングを作成しました。次にライブ検証を実行してください。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function testMapping(id: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/supplier-mappings/test?id=${encodeURIComponent(id)}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "検証に失敗しました");
      setMessage(data.ok ? "在庫・配送のライブ検証OK。決済自動化は別ゲートです。" : data.error ?? "ライブ検証NG");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function enableFlag(id: string, field: "autoOrderEnabled" | "autoPaymentEnabled" | "autoTrackingEnabled", value: boolean) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/supplier-mappings?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "更新に失敗しました");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!loggedIn) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">TRACER ADMIN</p>
        <h1 className="mt-3 text-3xl text-zinc-50">仕入れ先・商品固定マッピング</h1>
        <p className="mt-4 text-sm text-zinc-400">CRON_SECRETで管理セッションを開始します。</p>
        <form onSubmit={login} className="mt-8 space-y-4">
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            className="w-full rounded border border-white/15 bg-black px-4 py-3 text-zinc-100"
            placeholder="管理シークレット"
            autoComplete="current-password"
          />
          <button disabled={busy || !secret} className="rounded bg-cyan-400 px-5 py-3 font-medium text-black disabled:opacity-40">
            管理画面へ
          </button>
        </form>
        {message ? <p className="mt-4 text-sm text-amber-300">{message}</p> : null}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-12">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">TRACER ADMIN</p>
          <h1 className="mt-3 text-3xl text-zinc-50">仕入れ先・商品固定マッピング</h1>
          <p className="mt-3 text-sm text-zinc-400">BASE注文後に再検索せず、固定された仕入れ商品・variantへ発注するための管理画面。</p>
        </div>
        <button onClick={() => fetch("/api/admin/login", { method: "DELETE" }).then(() => setLoggedIn(false))} className="rounded border border-white/15 px-4 py-2 text-sm text-zinc-300">
          ログアウト
        </button>
      </div>

      {message ? <p className="mt-6 rounded border border-cyan-400/20 bg-cyan-400/5 p-4 text-sm text-cyan-200">{message}</p> : null}

      <form onSubmit={createMapping} className="mt-8 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg text-zinc-100">固定マッピングを追加</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <select value={shopId} onChange={(event) => setShopId(event.target.value)} className="rounded border border-white/15 bg-black px-3 py-3 text-sm text-zinc-200">
            <option value="">BASE商品を選択</option>
            {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.title ?? shop.id}</option>)}
          </select>
          <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className="rounded border border-white/15 bg-black px-3 py-3 text-sm text-zinc-200">
            <option value="">仕入れ商品を選択</option>
            {matchingSuppliers.map((item) => <option key={item.id} value={item.id}>{item.supplier.toUpperCase()} / {item.title ?? item.id}</option>)}
          </select>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="rounded border border-white/15 bg-black px-3 py-3 text-sm text-zinc-200">
            <option value="">仕入れ先アカウント</option>
            {accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.display_name}</option>)}
          </select>
        </div>
        {selectedSupplier ? <p className="mt-3 text-xs text-zinc-500">variant: {selectedSupplier.supplier_variant_id ?? "unknown"} / 在庫: {selectedSupplier.inventory ?? "unknown"} / orderable: {String(selectedSupplier.orderable)}</p> : null}
        <button disabled={busy || !shopId || !supplierId || !accountId} className="mt-4 rounded bg-cyan-400 px-5 py-2.5 text-sm font-medium text-black disabled:opacity-40">
          固定マッピングを作成
        </button>
      </form>

      <section className="mt-8 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-3">BASE商品</th>
              <th className="px-4 py-3">仕入れ商品</th>
              <th className="px-4 py-3">固定variant</th>
              <th className="px-4 py-3">自動発注</th>
              <th className="px-4 py-3">自動決済</th>
              <th className="px-4 py-3">追跡</th>
              <th className="px-4 py-3">判定</th>
              <th className="px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mapping) => (
              <tr key={mapping.id} className="border-b border-white/5">
                <td className="px-4 py-4 text-zinc-200">{mapping.shop_title ?? mapping.shop_listing_id}</td>
                <td className="px-4 py-4 text-zinc-300">{mapping.supplier_name} / {mapping.supplier_title ?? mapping.supplier_listing_id}</td>
                <td className="px-4 py-4 font-mono text-xs text-zinc-400">{mapping.supplier_variant_id ?? "unknown"}</td>
                <td className="px-4 py-4"><input type="checkbox" checked={mapping.auto_order_enabled} disabled={busy} onChange={(event) => enableFlag(mapping.id, "autoOrderEnabled", event.target.checked)} /></td>
                <td className="px-4 py-4"><input type="checkbox" checked={mapping.auto_payment_enabled} disabled={busy} onChange={(event) => enableFlag(mapping.id, "autoPaymentEnabled", event.target.checked)} /></td>
                <td className="px-4 py-4"><input type="checkbox" checked={mapping.auto_tracking_enabled} disabled={busy} onChange={(event) => enableFlag(mapping.id, "autoTrackingEnabled", event.target.checked)} /></td>
                <td className="px-4 py-4">
                  <span className={mapping.fully_automatable ? "text-emerald-300" : "text-amber-300"}>
                    {mapping.fully_automatable ? "FULLY AUTOMATABLE" : `${mapping.automation_status} / ${mapping.mapping_verification_status}`}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <button onClick={() => testMapping(mapping.id)} disabled={busy} className="rounded border border-white/15 px-3 py-2 text-xs text-zinc-200 disabled:opacity-40">
                    ライブ検証
                  </button>
                </td>
              </tr>
            ))}
            {mappings.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-zinc-500">固定マッピングはまだありません。</td></tr> : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}
