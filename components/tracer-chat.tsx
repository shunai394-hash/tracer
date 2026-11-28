"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type ChatLink = {
  label: string;
  href: string;
};

type MuseVideo = {
  jobId?: string;
  status?: string;
  outputVideoUrl?: string | null;
  errorMessage?: string | null;
  label?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  links?: ChatLink[];
  missing?: string[];
  usedData?: string[];
  confidence?: string;
  museVideo?: MuseVideo | null;
};

const VIDEO_STATUS: Record<string, string> = {
  needs_input: "確認が必要",
  queued: "キューで待機中",
  processing: "制作中",
  succeeded: "完成",
  failed: "失敗",
  unavailable: "キュー未接続",
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

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    const pending = messages.find((message) =>
      message.museVideo?.jobId && (message.museVideo.status === "queued" || message.museVideo.status === "processing")
    );
    if (!pending?.museVideo?.jobId) return undefined;
    const jobId = pending.museVideo.jobId;
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        const response = await fetch(`/api/chat/muse-video?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const payload = (await response.json()) as { ok?: boolean; museVideo?: MuseVideo };
        if (stopped || !payload.ok || !payload.museVideo) return;
        setMessages((current) => current.map((message) =>
          message.museVideo?.jobId === jobId ? { ...message, museVideo: payload.museVideo } : message
        ));
      })();
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [messages]);

  if (!embedded && (pathname === "/chat" || pathname.startsWith("/shop"))) {
    return null;
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    setBusy(true);
    setInput("");
    setMessages((current) => [...current, { role: "user", content: message }]);

    try {
      const attachments = await Promise.all(files.slice(0, 4).map(async (file) => {
        if (file.size > 8 * 1024 * 1024) throw new Error("8MBを超える素材は専用スタジオから同じキューへ送ってください。");
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("素材を読み取れませんでした。"));
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.readAsDataURL(file);
        });
        const contentType = file.type || (file.name.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : file.name.toLowerCase().endsWith(".png") ? "image/png" : "");
        return { contentType, dataBase64, role: /bgm/i.test(file.name) ? "bgm" : undefined };
      }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attachments }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        answer?: string;
        error?: string;
        links?: ChatLink[];
        missing?: string[];
        usedData?: string[];
        confidence?: string;
        museVideo?: MuseVideo | null;
      };
      setFiles([]);

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
          museVideo: payload.museVideo,
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
          商品の質問は実データだけを読みます。動画の依頼はMuse制作キューへ渡します。
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
              {message.museVideo ? (
                <div className="mt-2 space-y-2">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300">
                    制作状況: {message.museVideo.status === "succeeded" && message.museVideo.outputVideoUrl
                      ? "完成"
                      : VIDEO_STATUS[message.museVideo.status ?? ""] ?? message.museVideo.label ?? "確認中"}
                  </p>
                  {message.museVideo.status === "succeeded" && message.museVideo.outputVideoUrl ? (
                    <>
                      <video
                        src={message.museVideo.outputVideoUrl}
                        controls
                        playsInline
                        preload="metadata"
                        className="w-full bg-black"
                      />
                      <a
                        href={message.museVideo.outputVideoUrl}
                        download="tracer-muse.mp4"
                        className="inline-block border border-cyan-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200"
                      >
                        MP4を保存
                      </a>
                    </>
                  ) : null}
                  {message.museVideo.errorMessage ? (
                    <p className="text-[11px] text-amber-300/80">{message.museVideo.errorMessage}</p>
                  ) : null}
                </div>
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
      {files.length > 0 ? (
        <p className="border-t border-white/5 px-3 pt-2 text-[11px] text-zinc-500">添付: {files.map((file) => file.name).join("、")}</p>
      ) : null}
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
          placeholder="動画を作って、または商品を聞いてください"
          className="flex-1 border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-100"
        />
        <label className="border border-white/10 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">
          素材
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,audio/mpeg,video/mp4,video/webm"
            multiple
            className="sr-only"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 4))}
          />
        </label>
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
