import Link from "next/link";

export const metadata = {
  title: "TRACER Chrome Extension",
  description: "Capture Amazon product data with the TRACER Chrome extension.",
};

export default function ExtensionPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">TRACER Extension</p>
      <h1 className="mt-3 text-4xl text-zinc-100 sm:text-5xl">Capture once. Research in TRACER.</h1>
      <p className="mt-5 max-w-2xl text-zinc-400 leading-7">Amazonの商品ページから商品情報を取得し、TRACER / EC-Pulse の商品基盤へ送ります。ブラウザの閲覧履歴を収集するための拡張機能ではありません。</p>
      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {[["01","Capture","Amazon.com / Amazon.co.jp の商品ページからASIN、商品名、ブランド、価格などを取得"],["02","Normalize","TRACERからEC-Pulseへ送り、商品識別子と価格観測を正規化"],["03","Research","TRACERで仕入れ、利益、商品同一性などの調査につなげる"]].map(([n,t,d]) => <section key={n} className="border border-white/10 bg-zinc-950/60 p-5"><span className="font-mono text-xs text-cyan-400">{n}</span><h2 className="mt-3 text-lg text-zinc-100">{t}</h2><p className="mt-2 text-sm leading-6 text-zinc-400">{d}</p></section>)}
      </div>
      <section className="mt-10 border border-amber-400/15 bg-amber-400/5 p-6">
        <h2 className="text-lg text-zinc-100">利用上の注意</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-400">
          <li>対象サイトの利用規約・robots.txt・APIポリシー等を尊重してください。</li>
          <li>TRACERは市場データの取得結果を保証するものではありません。</li>
          <li>EC-Pulse APIキーやデータベースの秘密鍵を拡張機能へ入力しないでください。</li>
          <li>販売・購入前に価格、在庫、送料、規約、知的財産権などを確認してください。</li>
        </ul>
      </section>
      <div className="mt-8 flex gap-5 text-sm"><Link href="/privacy" className="text-cyan-300 hover:text-cyan-100">Privacy Policy</Link><Link href="/terms" className="text-cyan-300 hover:text-cyan-100">Terms of Service</Link></div>
    </main>
  );
}
