export default function ProductsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
        Products
      </p>
      <h1 className="mt-3 text-3xl text-zinc-50">商品</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
        Product は正規化された商品実体です。価格や需要は Observation 側に持ちます。
      </p>
      <div className="mt-10 border border-dashed border-cyan-500/20 p-10 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-zinc-500">
          Empty catalog
        </p>
        <p className="mt-3 text-sm text-zinc-400">登録済みの商品はまだありません。</p>
      </div>
    </main>
  );
}
