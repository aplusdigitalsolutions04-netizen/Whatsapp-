/* eslint-disable jsx-a11y/media-has-caption -- customer-sent audio/video has no caption tracks */
import { Fragment, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { activeProvider } from "../lib/bridge.server";
import { logEvent } from "../lib/log.server";
import { ALLOWED_UPLOAD_MIME, kindFromMime, MAX_MEDIA_BYTES, saveMedia, signedAvatarUrl, signedMediaUrl } from "../lib/media.server";
import { rateLimited } from "../lib/rate-limit.server";
import { sendAndRecord } from "../lib/whatsapp.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { EmojiPicker } from "../components/EmojiPicker";
import { Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const filter = url.searchParams.get("filter") ?? "all";
  const selectedId = url.searchParams.get("c");

  const where: Record<string, unknown> = { shop: session.shop };
  if (q) where.OR = [{ phone: { contains: q.replace(/[^\d+]/g, "") || q } }, { customerName: { contains: q } }];
  if (filter === "human") where.mode = "human";
  if (filter === "bot") where.mode = "bot";
  if (filter === "closed") where.status = "closed";
  if (filter === "open") where.status = "open";

  const list = await prisma.conversation.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const selected = selectedId
    ? await prisma.conversation.findFirst({
        where: { id: selectedId, shop: session.shop },
        include: { messages: { orderBy: { createdAt: "asc" }, take: 300 } },
      })
    : null;

  const preview = (m?: { body: string; mediaKind: string | null; direction: string }) =>
    !m ? "" : `${m.direction === "out" ? "✓ " : ""}${m.body || (m.mediaKind ? `📎 ${m.mediaKind}` : "")}`.slice(0, 70);

  return {
    q,
    filter,
    canSendFiles: activeProvider() === "qr",
    list: list.map((c) => ({
      id: c.id, phone: c.phone, name: c.customerName, mode: c.mode, status: c.status,
      avatar: c.avatarFile ? signedAvatarUrl(c.id) : null,
      last: c.lastMessageAt.toISOString(), preview: preview(c.messages[0]),
    })),
    selected: selected && {
      id: selected.id, phone: selected.phone, name: selected.customerName, mode: selected.mode,
      avatar: selected.avatarFile ? signedAvatarUrl(selected.id) : null,
      status: selected.status, handoffReason: selected.handoffReason,
      messages: selected.messages.map((m) => ({
        id: m.id, direction: m.direction, sender: m.sender, body: m.body, status: m.status,
        error: m.error, at: m.createdAt.toISOString(),
        media: m.mediaKind
          ? { kind: m.mediaKind, name: m.mediaName, mime: m.mediaMime, url: m.mediaFile ? signedMediaUrl(m.id) : null }
          : null,
      })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(form.get("id") ?? "");
  const conv = await prisma.conversation.findFirst({ where: { id, shop: session.shop } });
  if (!conv) return { ok: false, message: "Conversation not found" };

  switch (intent) {
    case "takeover":
      await prisma.conversation.update({ where: { id }, data: { mode: "human", handoffReason: "Agent took over" } });
      await logEvent({ shop: session.shop, source: "admin", event: "handoff", detail: "agent takeover" });
      return { ok: true, message: "You took over this conversation. The bot is paused." };
    case "return":
      await prisma.conversation.update({ where: { id }, data: { mode: "bot", handoffReason: null, state: "idle", pendingOrders: "[]", verifyAttempts: 0 } });
      return { ok: true, message: "Conversation returned to the bot." };
    case "reset":
      await prisma.conversation.update({ where: { id }, data: { state: "idle", pendingOrders: "[]", verifyAttempts: 0 } });
      return { ok: true, message: "Conversation state reset." };
    case "close":
      await prisma.conversation.update({ where: { id }, data: { status: conv.status === "closed" ? "open" : "closed" } });
      return { ok: true, message: conv.status === "closed" ? "Reopened." : "Closed." };
    case "delete":
      await prisma.conversation.delete({ where: { id } });
      return { ok: true, message: "Conversation deleted.", deleted: true };
    case "reply": {
      if (rateLimited(`reply:${session.shop}`, 60, 60_000)) return { ok: false, message: "Slow down: too many replies." };
      const body = String(form.get("body") ?? "").trim().slice(0, 1500);
      const file = form.get("file");
      const hasFile = file instanceof File && file.size > 0;
      if (!body && !hasFile) return { ok: false, message: "Type a message or attach a file." };
      if (conv.mode !== "human") return { ok: false, message: "Take over the conversation before replying." };

      let media: { kind: string; mime: string; name?: string; file: string } | undefined;
      if (hasFile) {
        const mime = (file.type || "").split(";")[0].toLowerCase();
        if (file.size > MAX_MEDIA_BYTES) return { ok: false, message: "File is larger than 16 MB." };
        if (!ALLOWED_UPLOAD_MIME.has(mime)) return { ok: false, message: "This file type is not allowed. Use images, video, audio, PDF, Word, Excel, text or zip." };
        const saved = saveMedia(Buffer.from(await file.arrayBuffer()), mime);
        media = { kind: kindFromMime(mime), mime, name: file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100), file: saved.file };
      }
      const res = await sendAndRecord({ shop: session.shop, conversationId: id, to: conv.phone, body, sender: "agent", media });
      return res.ok ? { ok: true, sent: true, message: "Sent." } : { ok: false, message: `Not sent: ${res.error}` };
    }
    default:
      return { ok: false, message: "Unknown action" };
  }
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const listTime = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? time(iso) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
};
const initials = (n: string) => (n.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("") || "#").toUpperCase();

/** WhatsApp profile picture, or initials when the customer has none (or keeps it private). */
function Avatar({ src, label }: { src: string | null; label: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) return <img className="wa-avatar wa-avatar-img" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <span className="wa-avatar">{initials(label)}</span>;
}

/** WhatsApp-style text: links become anchors (http/https only) and *bold* is honoured. */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
        ) : (
          <Fragment key={i}>
            {part.split(/(\*[^*\n]+\*)/g).map((seg, j) =>
              /^\*[^*\n]+\*$/.test(seg) ? <strong key={j}>{seg.slice(1, -1)}</strong> : <Fragment key={j}>{seg}</Fragment>,
            )}
          </Fragment>
        ),
      )}
    </>
  );
}

type Msg = NonNullable<Awaited<ReturnType<typeof loader>>["selected"]>["messages"][number];

function MediaView({ m }: { m: NonNullable<Msg["media"]> }) {
  if (!m.url) return <div className="wa-file">📎 {m.kind} (file not available)</div>;
  if (m.kind === "image") return <a href={m.url} target="_blank" rel="noreferrer"><img className="wa-img" src={m.url} alt={m.name ?? "image"} loading="lazy" /></a>;
  if (m.kind === "video") return <video className="wa-img" src={m.url} controls preload="none" />;
  if (m.kind === "audio") return <audio src={m.url} controls preload="none" />;
  return (
    <a className="wa-file" href={m.url} target="_blank" rel="noreferrer">
      <span className="wa-file-ico">📄</span>
      <span><b>{m.name ?? "Document"}</b><br /><small>{m.mime}</small></span>
    </a>
  );
}

function Ticks({ status }: { status: string }) {
  if (status === "failed") return <span className="wa-tick bad" title="Failed">⚠</span>;
  if (status === "queued") return <span className="wa-tick" title="Sending">🕓</span>;
  if (status === "sent") return <span className="wa-tick" title="Sent">✓</span>;
  return <span className={`wa-tick ${status === "read" ? "read" : ""}`} title={status}>✓✓</span>;
}

export default function Conversations() {
  const { list, selected, q, filter, canSendFiles } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const shopify = useAppBridge();
  const busy = nav.state !== "idle";
  const replyForm = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState("");
  useAutoRefresh(4000);

  useEffect(() => {
    if (result?.message) shopify.toast.show(result.message, { isError: !result.ok });
    if (result && "sent" in result && result.sent) {
      replyForm.current?.reset(); // clear only after a successful send
      setFileName("");
    }
  }, [result, shopify]);

  // Keep the newest message in view, unless the agent scrolled up to read history.
  const lastId = selected?.messages.at(-1)?.id;
  useEffect(() => {
    const el = thread.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [lastId]);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [selected?.id]);

  const confirmDelete = (e: React.FormEvent) => {
    if (!window.confirm("Delete this conversation and all its messages? This cannot be undone.")) e.preventDefault();
  };
  const insertEmoji = (emoji: string) => {
    const t = textarea.current;
    if (!t) return;
    const a = t.selectionStart ?? t.value.length;
    const b = t.selectionEnd ?? a;
    t.value = t.value.slice(0, a) + emoji + t.value.slice(b);
    t.focus();
    t.setSelectionRange(a + emoji.length, a + emoji.length);
  };

  let lastDay = "";
  return (
    <Page title="Conversations">
      <div className="wa">
        <aside className="wa-side">
          <Form method="get" className="wa-search">
            <input name="q" defaultValue={q} placeholder="Search name or number" aria-label="Search conversations" />
            <select name="filter" defaultValue={filter} aria-label="Filter">
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="human">Agent</option>
              <option value="bot">JAZZ</option>
            </select>
            <button type="submit">Go</button>
          </Form>
          <div className="wa-list">
            {list.length === 0 && <p className="o-muted" style={{ padding: 16 }}>No conversations yet. Messages appear here when customers write in on WhatsApp.</p>}
            {list.map((c) => (
              <Link key={c.id} className={`wa-item ${selected?.id === c.id ? "active" : ""}`} to={`?c=${c.id}&filter=${filter}&q=${encodeURIComponent(q)}`}>
                <Avatar src={c.avatar} label={c.name ?? c.phone} />
                <span className="wa-item-main">
                  <span className="wa-item-top">
                    <b>{c.name ?? c.phone}</b>
                    <small>{listTime(c.last)}</small>
                  </span>
                  <span className="wa-item-bottom">
                    <span className="wa-preview">{c.preview}</span>
                    {c.mode === "human" && <span className="o-badge warning">Agent</span>}
                    {c.status === "closed" && <span className="o-badge">Closed</span>}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </aside>

        <section className="wa-chat">
          {!selected ? (
            <div className="wa-empty">
              <div style={{ fontSize: 56 }}>💬</div>
              <h2>Select a conversation</h2>
              <p className="o-muted">Choose a chat on the left to read it, take over from the bot, send files and reply.</p>
            </div>
          ) : (
            <>
              <header className="wa-head">
                <Avatar src={selected.avatar} label={selected.name ?? selected.phone} />
                <div className="wa-head-main">
                  <b>{selected.name ?? selected.phone}</b>
                  <small>{selected.name ? `${selected.phone} · ` : ""}{selected.mode === "human" ? `Agent mode${selected.handoffReason ? ` (${selected.handoffReason})` : ""}` : "JAZZ is replying"}</small>
                </div>
                <div className="wa-actions">
                  {([selected.mode === "human" ? "return" : "takeover", "reset", "close"] as const).map((i) => (
                    <Form method="post" key={i}>
                      <input type="hidden" name="id" value={selected.id} />
                      <button className={i === "takeover" || i === "return" ? "" : "ghost"} name="intent" value={i} disabled={busy}>
                        {{ takeover: "Take over", return: "Return to bot", reset: "Reset", close: selected.status === "closed" ? "Reopen" : "Close" }[i]}
                      </button>
                    </Form>
                  ))}
                  <Form method="post" onSubmit={confirmDelete}>
                    <input type="hidden" name="id" value={selected.id} />
                    <button className="danger" name="intent" value="delete" disabled={busy}>Delete</button>
                  </Form>
                </div>
              </header>

              <div className="wa-thread" ref={thread} role="log" aria-label="Message history">
                {selected.messages.length === 0 && <p className="o-muted" style={{ textAlign: "center" }}>No messages.</p>}
                {selected.messages.map((m) => {
                  const day = dayLabel(m.at);
                  const showDay = day !== lastDay;
                  lastDay = day;
                  const cls = m.direction === "in" ? "in" : m.sender === "agent" ? "agent" : "bot";
                  return (
                    <Fragment key={m.id}>
                      {showDay && <div className="wa-day"><span>{day}</span></div>}
                      <div className={`wa-msg ${cls}`}>
                        {m.direction === "out" && <span className="wa-who">{m.sender === "agent" ? "Agent" : "🤖 JAZZ"}</span>}
                        {m.media && <MediaView m={m.media} />}
                        {m.body && <div className="wa-text"><RichText text={m.body} /></div>}
                        <span className="wa-meta">
                          {time(m.at)} {m.direction === "out" && <Ticks status={m.status} />}
                        </span>
                        {m.error && <small className="wa-err">{m.error}</small>}
                      </div>
                    </Fragment>
                  );
                })}
              </div>

              {selected.mode === "human" ? (
                <Form method="post" encType="multipart/form-data" ref={replyForm} className="wa-composer">
                  <input type="hidden" name="id" value={selected.id} />
                  {fileName && (
                    <div className="wa-chip">
                      📎 {fileName}
                      <button type="button" className="o-icon" aria-label="Remove attachment" onClick={() => { if (fileInput.current) fileInput.current.value = ""; setFileName(""); }}>✕</button>
                    </div>
                  )}
                  <div className="wa-compose-row">
                    <EmojiPicker onPick={insertEmoji} />
                    {canSendFiles ? (
                      <>
                        <button type="button" className="o-icon" aria-label="Attach file" onClick={() => fileInput.current?.click()}>📎</button>
                        <input
                          ref={fileInput} type="file" name="file" hidden
                          accept="image/*,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
                          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
                        />
                      </>
                    ) : null}
                    <textarea
                      ref={textarea} name="body" rows={1} maxLength={1500} aria-label="Reply" placeholder="Type a message"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          replyForm.current?.requestSubmit(e.currentTarget.form?.querySelector<HTMLButtonElement>("button[name=intent]") ?? undefined);
                        }
                      }}
                    />
                    <button className="wa-send" name="intent" value="reply" disabled={busy} aria-label="Send">➤</button>
                  </div>
                  {!canSendFiles && <small className="o-muted">Sending files needs the WhatsApp Web (QR) connection.</small>}
                </Form>
              ) : (
                <div className="wa-bar">
                  <span>🤖 The bot is handling this chat.</span>
                  <Form method="post">
                    <input type="hidden" name="id" value={selected.id} />
                    <button name="intent" value="takeover" disabled={busy}>Take over to reply</button>
                  </Form>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
