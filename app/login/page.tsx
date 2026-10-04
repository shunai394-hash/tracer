"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendEmailLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("email");
    setError(null);
    setSent(false);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/mypage`,
        },
      });
      if (authError) throw authError;
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "認証メールを送信できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function signInWithGoogle() {
    setBusy("google");
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/mypage` },
      });
      if (authError) throw authError;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Googleログインを開始できませんでした。");
      setBusy(null);
    }
  }

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-16 sm:px-8">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute left-1/2 top-1/2 h-[32rem] w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-400/[0.045] blur-3xl" />
        <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] [background-size:48px_48px]" />
      </div>
      <section className="relative w-full max-w-md border border-white/10 bg-[#0a0d10]/95 p-6 shadow-2xl shadow-cyan-950/10 backdrop-blur-xl sm:p-9" aria-labelledby="login-heading">
        <div className="border-b border-white/8 pb-6">
          <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-cyan-300/70">TRACER / ACCOUNT</p>
          <h1 id="login-heading" className="mt-4 text-3xl tracking-[-0.045em] text-zinc-50">マイページへ。</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-500">メール認証、またはGoogleアカウントで安全にログインできます。</p>
        </div>

        <button type="button" onClick={() => void signInWithGoogle()} disabled={busy !== null} className="mt-7 flex min-h-12 w-full items-center justify-center gap-3 border border-white/15 bg-white px-5 text-sm font-medium text-zinc-900 transition hover:-translate-y-0.5 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-wait disabled:opacity-50">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-xs font-bold" aria-hidden="true">G</span>
          {busy === "google" ? "Googleへ接続中…" : "Googleでログイン"}
        </button>

        <div className="my-7 flex items-center gap-3 text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-700">
          <span className="h-px flex-1 bg-white/8" />
          <span>or email</span>
          <span className="h-px flex-1 bg-white/8" />
        </div>

        <form onSubmit={sendEmailLink}>
          <label className="block text-xs text-zinc-400">
            メールアドレス
            <input type="email" name="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="mt-2 w-full border border-white/10 bg-[#07090b] px-4 py-3.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-700 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10" />
          </label>
          <button type="submit" disabled={busy !== null} className="mt-4 flex min-h-12 w-full items-center justify-between bg-cyan-300 px-5 text-xs font-semibold tracking-[0.08em] text-zinc-950 transition hover:-translate-y-0.5 hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 disabled:cursor-wait disabled:opacity-50">
            {busy === "email" ? "送信しています…" : "認証メールを送る"}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {sent ? <p role="status" className="mt-5 border border-cyan-300/15 bg-cyan-300/[0.025] p-4 text-xs leading-5 text-cyan-100">認証メールを送信しました。メール内のリンクからマイページへ進んでください。</p> : null}
        {error ? <p role="alert" className="mt-5 border border-amber-300/15 bg-amber-300/[0.025] p-4 text-xs leading-5 text-amber-200">{error}</p> : null}
        <button type="button" onClick={() => router.push("/shop")} className="mt-7 w-full text-center text-xs text-zinc-600 transition hover:text-zinc-300">商品を見るに戻る</button>
      </section>
    </main>
  );
}
