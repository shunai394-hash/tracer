import Link from "next/link";

export const metadata = {
  title: "Terms of Service — TRACER",
  description: "TRACER terms of service.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">Legal</p>
      <h1 className="mt-3 text-4xl text-zinc-100">Terms of Service</h1>
      <p className="mt-4 text-sm text-zinc-500">Last updated: September 27, 2026</p>
      <div className="mt-10 space-y-8 text-sm leading-7 text-zinc-300">
        <section><h2 className="text-xl text-zinc-100">1. Service</h2><p className="mt-3">TRACER provides product research, product identification, price observation, supplier research, and related commerce intelligence features. Availability and extracted fields can vary by source.</p></section>
        <section><h2 className="text-xl text-zinc-100">2. Acceptable use</h2><p className="mt-3">Use TRACER only in accordance with applicable law, the rules of the websites and marketplaces you access, and the terms that apply to your accounts. Do not use TRACER to bypass access controls, abuse a service, or collect data you are not authorized to access.</p></section>
        <section><h2 className="text-xl text-zinc-100">3. Data accuracy</h2><p className="mt-3">Market prices, availability, rankings, shipping costs, supplier information, and identifiers can change. TRACER may mark information as unknown when it cannot verify it. Users remain responsible for independently confirming material information before making purchasing, listing, or business decisions.</p></section>
        <section><h2 className="text-xl text-zinc-100">4. Third-party services</h2><p className="mt-3">TRACER can interact with third-party marketplaces, retailers, suppliers, payment providers, and data services. Their own terms, policies, availability, and fees apply.</p></section>
        <section><h2 className="text-xl text-zinc-100">5. No guarantee of business results</h2><p className="mt-3">TRACER does not guarantee sales, profit, product availability, supplier fulfillment, marketplace approval, or any particular commercial result.</p></section>
        <section><h2 className="text-xl text-zinc-100">6. Changes</h2><p className="mt-3">We may update these terms as the service evolves. The effective date shown on this page identifies the current version.</p></section>
      </div>
      <Link href="/" className="mt-10 inline-block text-sm text-cyan-300 hover:text-cyan-100">← Back to TRACER</Link>
    </main>
  );
}
