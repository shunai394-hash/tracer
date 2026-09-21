"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type ChatLink = {
  label: string;
  href: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  links?: ChatLink[];
  missing?: string[];
  usedData?: string[];
  confidence?: string;
};

const STARTERS = [
  "今おすすめの商品は？",
  "今どの商品を販売テストすべき？",
  "この商品は何個くらい売れそう？",
  "カート追加率は？",
];

export function TracerChat({ embedded = false }: { embedded?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(embedded);

  if (!embedded && (pathname === "/chat" || pathname.startsWith("/shop"))) {
    return null;
  }
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    setBusy(true);
    setInput("");
    setMessages((current) => [...current, { role: "user", content: message }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        answer?: string;
        error?: string;
        links?: ChatLink[];
        missing?: string[];
        usedData?: string[];
        confidence?: string;
      };

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: payload.ok
            ? payload.answer ?? "回答を生成できませんでした。"
            : payload.error || "回答を生成できませんでした。",
          links: payload.links,
          missing: payload.missing,
          usedData: payload.usedData,
          confidence: payload.confidence,
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: "チャットに接続できませんでした。" },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const panel = (
    <div className="flex h-full flex-col border border-cyan-500/20 bg-zinc-950/95">
      <div className="border-b border-white/5 px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-400">
          TRACER Chat
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          実データだけを読みます。無いものは unknown です。
        </p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {messages.length === 0 ? (
          <div className="space-y-2">
            {STARTERS.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => send(starter)}
                className="block w-full border border-white/10 px-3 py-2 text-left text-zinc-300 hover:border-cyan-400/40"
              >
                {starter}
              </button>
            ))}
          </div>
        ) : (
          messages.map((message, index) => (
            <article
              key={`${message.role}-${index}`}
              className={
                message.role === "user"
                  ? "ml-8 border border-white/10 px-3 py-2 text-zinc-200"
                  : "mr-4 border border-cyan-500/15 px-3 py-2 text-zinc-300"
              }
            >
              <p className="whitespace-pre-wrap leading-6">{message.content}</p>
              {message.usedData && message.usedData.length > 0 ? (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                  使用データ: {message.usedData.join(" · ")}
                  {message.confidence ? ` · 信頼度 ${message.confidence}` : ""}
                </p>
              ) : null}
              {message.missing && message.missing.length > 0 ? (
                <p className="mt-1 text-[11px] text-amber-300/80">
                  不足: {message.missing.join(" · ")}
                </p>
              ) : null}
              {message.links && message.links.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {message.links.map((link) => (
                    <Link
                      key={`${link.href}-${link.label}`}
                      href={link.href}
                      className="border border-cyan-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200 hover:bg-cyan-400/10"
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      <form
        className="flex gap-2 border-t border-white/5 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="今売るなら何がいい？"
          className="flex-1 border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-100"
        />
        <button
          type="submit"
          disabled={busy}
          className="border border-cyan-400/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200 disabled:opacity-40"
        >
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );

  if (embedded) {
    return <div className="h-[640px]">{panel}</div>;
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 w-[min(420px,calc(100vw-2rem))]">
      {open ? <div className="mb-3 h-[520px] shadow-2xl">{panel}</div> : null}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="border border-cyan-400/40 bg-black/80 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-200"
        >
          {open ? "Close chat" : "AI Chat"}
        </button>
      </div>
    </div>
  );
}
