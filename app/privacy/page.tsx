import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — TRACER",
  description: "TRACER privacy policy and extension data practices.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-400">Legal</p>
      <h1 className="mt-3 text-4xl text-zinc-100">Privacy Policy</h1>
      <p className="mt-4 text-sm text-zinc-500">Last updated: September 27, 2026</p>
      <div className="mt-10 space-y-8 text-sm leading-7 text-zinc-300">
        <section><h2 className="text-xl text-zinc-100">1. What TRACER collects</h2><p className="mt-3">When you use the TRACER Chrome extension to capture an Amazon product, TRACER may receive the product page URL, ASIN when available, product title, brand, price, product image URL, and capture time. The extension also stores its configured TRACER API base URL and, if you choose to configure one, an ingestion key in Chrome local storage.</p></section>
        <section><h2 className="text-xl text-zinc-100">2. Why we use this data</h2><p className="mt-3">The captured product data is used to identify products, normalize product information through TRACER and EC-Pulse, monitor product observations, and provide commerce research features. We do not need your general browsing history to provide the extension&apos;s capture function.</p></section>
        <section><h2 className="text-xl text-zinc-100">3. Sharing</h2><p className="mt-3">Captured product information may be processed by TRACER infrastructure and EC-Pulse for normalization and product intelligence. We do not sell captured product data as a data-broker service. Backend credentials such as EC-Pulse API keys and database service keys are not stored in the extension.</p></section>
        <section><h2 className="text-xl text-zinc-100">4. Your choices</h2><p className="mt-3">You can stop using or remove the extension at any time. You can also clear the extension's local settings through Chrome. For account or stored product-data requests, contact the TRACER operator through the support channel provided with your account.</p></section>
        <section><h2 className="text-xl text-zinc-100">5. Security</h2><p className="mt-3">TRACER uses server-side authentication and keeps backend service credentials out of the browser extension. No security measure is guaranteed to be perfect, so users should avoid entering secrets into product-page fields or extension settings unless explicitly required.</p></section>
        <section><h2 className="text-xl text-zinc-100">6. Contact</h2><p className="mt-3">For privacy questions or data requests, use the support contact associated with your TRACER account.</p></section>
      </div>
      <Link href="/" className="mt-10 inline-block text-sm text-cyan-300 hover:text-cyan-100">← Back to TRACER</Link>
    </main>
  );
}
