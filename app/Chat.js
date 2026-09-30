"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAT_PRESETS, findChatPreset } from "@/lib/chatPresets";
import { post } from "@/lib/client";
import { playChatSound, preloadChatSounds } from "@/lib/audio";

const WIDE_QUERY = "(min-width: 720px)";
const MAX_TOASTS = 3; // stacked at once on wide screens; more wait in line
const TOAST_MS = 4000;
const MAX_LENGTH = 200;

function useWide() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return wide;
}

// All the chat's state and behavior. Everything comes from the polled game
// state (`state.chat`, the last 50 messages) — the chat never polls on its own.
//
// "Seen" tracking: the messages present the first time this runs are the
// baseline (never toasted, never unread). After that, every new message from
// someone else notifies (toast + sound + unread count) only if the chat isn't
// visible right then. Own messages never notify.
export function useChat({ state, code, playerId, sheetOpen, onOpenRequest }) {
  const wide = useWide();
  // How many toasts are on screen at once (each starts its 4 seconds when it
  // moves into this window): a stack of 3 in the wide-screen corner; one at a
  // time in the phone chat bar and in the scratch sheet's header.
  const maxVisible = wide && !sheetOpen ? MAX_TOASTS : 1;
  const [open, setOpen] = useState(false); // phone: the sheet
  const [expanded, setExpanded] = useState(true); // wide: the side panel
  const [panelInView, setPanelInView] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [localMsgs, setLocalMsgs] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState(false); // a text box has focus

  const known = useRef(null);
  const timers = useRef(new Map());
  const panelEl = useRef(null);
  const observer = useRef(null);
  const openRequest = useRef(onOpenRequest);
  openRequest.current = onOpenRequest;

  const canSend = !state.me.removed;
  const visible = wide ? expanded && panelInView && !tabHidden : open;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const update = () => setTabHidden(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // While a text box has focus the on-screen keyboard may be up, so the phone
  // chat bar and toasts step aside instead of sitting above the keyboard.
  useEffect(() => {
    const isField = (el) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const onIn = (e) => setTyping(isField(e.target));
    const onOut = (e) => setTyping(isField(e.relatedTarget));
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => { document.removeEventListener("focusin", onIn); document.removeEventListener("focusout", onOut); };
  }, []);

  // The phone sheet doesn't exist on wide screens.
  useEffect(() => { if (wide) setOpen(false); }, [wide]);

  // Sound files are fetched ahead of time (after the first tap unlocks audio)
  // so a statement's own sound plays without a delay.
  useEffect(() => {
    const preload = () => preloadChatSounds(CHAT_PRESETS.map((p) => p.sound));
    window.addEventListener("pointerdown", preload, { once: true });
    return () => window.removeEventListener("pointerdown", preload);
  }, []);

  const clearToasts = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    setToasts([]);
  }, []);

  // New messages from the latest poll.
  useEffect(() => {
    const incoming = state.chat || [];
    if (known.current === null) {
      known.current = new Set(incoming.map((m) => m.id));
      return;
    }
    const fresh = incoming.filter((m) => !known.current.has(m.id));
    if (!fresh.length) return;
    fresh.forEach((m) => known.current.add(m.id));
    const others = fresh.filter((m) => m.playerId !== playerId);
    if (!others.length || visibleRef.current) return;
    setUnread((n) => n + others.length);
    setToasts((q) => [...q, ...others.map((m) => ({ id: m.id, name: m.name, text: m.text, presetId: m.presetId }))]);
    // One sound per batch: the newest message's own sound, or the default.
    const last = others[others.length - 1];
    playChatSound(findChatPreset(last.presetId)?.sound);
  }, [state.chat, playerId]);

  // Messages I just sent show up at once; drop them once the poll has them.
  useEffect(() => {
    const ids = new Set((state.chat || []).map((m) => m.id));
    setLocalMsgs((l) => {
      const kept = l.filter((m) => !ids.has(m.id));
      return kept.length === l.length ? l : kept;
    });
  }, [state.chat]);

  const messages = useMemo(() => {
    const server = state.chat || [];
    const ids = new Set(server.map((m) => m.id));
    return [...server, ...localMsgs.filter((m) => !ids.has(m.id))];
  }, [state.chat, localMsgs]);

  // Opening (or scrolling to) the chat marks everything as read.
  useEffect(() => {
    if (visible) { setUnread(0); clearToasts(); }
  }, [visible, clearToasts]);

  // Each toast on screen disappears by itself after TOAST_MS; the ones waiting
  // in line start their own timer when they move up.
  useEffect(() => {
    for (const t of toasts.slice(0, maxVisible)) {
      if (timers.current.has(t.id)) continue;
      timers.current.set(t.id, setTimeout(() => {
        timers.current.delete(t.id);
        setToasts((q) => q.filter((x) => x.id !== t.id));
      }, TOAST_MS));
    }
  }, [toasts, maxVisible]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);

  // Closes one toast early without opening the chat (the next one in line
  // moves up and starts its own 4 seconds).
  const dismissToast = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((q) => q.filter((x) => x.id !== id));
  }, []);

  const panelRef = useCallback((el) => {
    if (observer.current) { observer.current.disconnect(); observer.current = null; }
    panelEl.current = el;
    if (!el) { setPanelInView(false); return; }
    if (typeof IntersectionObserver === "undefined") { setPanelInView(true); return; }
    const io = new IntersectionObserver(([entry]) => setPanelInView(entry.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    observer.current = io;
  }, []);

  const openChat = useCallback(() => {
    if (openRequest.current) openRequest.current();
    clearToasts();
    if (wide) {
      setExpanded(true);
      requestAnimationFrame(() => panelEl.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
    } else {
      setOpen(true);
    }
  }, [wide, clearToasts]);

  const send = useCallback(async (payload) => {
    setSending(true); setError("");
    try {
      const { message } = await post("/api/chat", { code, playerId, ...payload });
      if (known.current) known.current.add(message.id);
      setLocalMsgs((l) => [...l.slice(-49), message]);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSending(false);
    }
  }, [code, playerId]);

  return {
    wide, open, setOpen, expanded, setExpanded, panelRef, unread, toasts, openChat, dismissToast, typing, maxVisible,
    messages, canSend, playerId, draft, setDraft, sending, error, setError, send,
  };
}

// The chat itself: messages, quick statements, and the text box. Used inside
// the phone sheet and the wide-screen side panel.
export function ChatPanel({ chat }) {
  const { messages, canSend, playerId, draft, setDraft, sending, error, setError, send } = chat;
  const listRef = useRef(null);
  const pinned = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  function handleScroll() {
    const list = listRef.current;
    if (list) pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  async function submit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    pinned.current = true;
    if (await send({ text })) setDraft("");
  }

  async function sendPreset(id) {
    if (sending) return;
    pinned.current = true;
    await send({ presetId: id });
  }

  return (
    <div className="chat-panel">
      <ol className="chat-list" ref={listRef} onScroll={handleScroll} role="log" aria-label="Chat messages">
        {messages.length === 0 ? (
          <li className="chat-empty muted small">No messages yet. Say hi!</li>
        ) : (
          messages.map((m) => {
            const mine = m.playerId === playerId;
            return (
              <li key={m.id} className={`chat-msg${mine ? " chat-msg--mine" : ""}${m.presetId ? " chat-msg--preset" : ""}`}>
                <span className="chat-name">{mine ? "You" : m.name}</span>
                <span className="chat-text">{m.text}</span>
              </li>
            );
          })
        )}
      </ol>

      {canSend ? (
        <>
          <div className="chat-chips" role="group" aria-label="Quick statements">
            {CHAT_PRESETS.map((p) => (
              <button key={p.id} type="button" className="secondary chat-chip" onClick={() => sendPreset(p.id)} disabled={sending}>
                {p.text}
              </button>
            ))}
          </div>
          <form className="chat-form" onSubmit={submit}>
            <input
              className="chat-input"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); if (error) setError(""); }}
              maxLength={MAX_LENGTH}
              placeholder="Write a message"
              aria-label="Message"
              autoComplete="off"
              enterKeyHint="send"
            />
            <button type="submit" className="chat-send" disabled={sending || !draft.trim()}>Send</button>
          </form>
          {error && <p className="error small chat-error" role="alert">{error}</p>}
        </>
      ) : (
        <p className="small muted chat-readonly">You can still read the chat, but you can't send messages anymore.</p>
      )}
    </div>
  );
}

// Wide screens: the chat is a collapsible section of the side column.
export function ChatSection({ chat }) {
  const { expanded, setExpanded, unread } = chat;
  return (
    <section ref={chat.panelRef} className="chat-section">
      <div className="chat-section-head">
        <h2>Chat</h2>
        {!expanded && unread > 0 && <span className="chat-badge chat-badge--inline" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
        <button type="button" className="secondary chat-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide" : "Show"}
        </button>
      </div>
      {expanded && <ChatPanel chat={chat} />}
    </section>
  );
}

// Phone: a slim bar along the bottom edge that opens the chat. It reserves its
// own lane — the page has matching padding underneath — so unlike a floating
// button or a pop-up it can never sit on top of a control: whatever scrolls
// under it can always be scrolled clear, and the last controls on the page
// stay reachable. It shows the latest message and the unread count. It is also
// where incoming messages appear on a phone: for 4 seconds the bar itself
// turns dark and shows the sender and text (tap it to open the chat, ✕ to
// dismiss), one message at a time, with the same height — so nothing moves.
// It steps aside while a text box has focus (on Android the keyboard resizes
// the page and would otherwise push it up over the guess input).
export function ChatDock({ chat, hidden }) {
  const { unread, open, typing, openChat, messages, toasts, dismissToast } = chat;
  const alert = toasts[0];
  const last = messages[messages.length - 1];
  const preview = last ? `${last.playerId === chat.playerId ? "You" : last.name}: ${last.text}` : "Say something to the table";
  return (
    <div className={`chat-dock${alert ? " chat-dock--alert" : ""}${typing || open || hidden ? " chat-dock--hidden" : ""}`}>
      <div className="chat-dock-row">
        <button
          type="button"
          className="chat-dock-btn"
          onClick={openChat}
          aria-label={unread > 0 ? `Open chat, ${unread} unread` : "Open chat"}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          {alert ? (
            <>
              <span className="chat-dock-name">{alert.name}</span>
              <span className="chat-dock-preview chat-dock-preview--alert">{alert.text}</span>
            </>
          ) : (
            <>
              <span className="chat-dock-label">Chat</span>
              <span className="chat-dock-preview">{preview}</span>
            </>
          )}
          {unread > 0 && <span className="chat-badge">{unread > 99 ? "99+" : unread}</span>}
        </button>
        {alert && (
          <button type="button" className="chat-dock-dismiss" onClick={() => dismissToast(alert.id)} aria-label={`Dismiss message from ${alert.name}`}>✕</button>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{alert ? `${alert.name}: ${alert.text}` : ""}</span>
    </div>
  );
}

// Phone: the chat as a full-screen sheet over the game. The page behind is
// pinned in place, and the sheet follows the *visual* viewport, so on iPhone
// the text box stays visible above the on-screen keyboard.
export function ChatSheet({ chat }) {
  const { open, setOpen } = chat;
  const dialogRef = useRef(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const onCancel = (e) => { e.preventDefault(); setOpen(false); };
    const onClose = () => setOpen(false);
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("close", onClose);
    return () => { dlg.removeEventListener("cancel", onCancel); dlg.removeEventListener("close", onClose); };
  }, [setOpen]);

  // Pin the page behind the sheet (body: fixed at the current scroll offset —
  // plain overflow: hidden isn't enough on iOS) and restore it on close.
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const { body } = document;
    const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // Follow the visual viewport (it shrinks when the keyboard opens, and iOS
  // may also pan it).
  useEffect(() => {
    if (!open) return;
    const dlg = dialogRef.current;
    const vv = window.visualViewport;
    if (!dlg || !vv) return;
    const update = () => {
      dlg.style.setProperty("--vv-top", `${vv.offsetTop}px`);
      dlg.style.setProperty("--vv-h", `${vv.height}px`);
      dlg.classList.toggle("chat-sheet--kb", window.innerHeight - vv.height > 120);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      dlg.style.removeProperty("--vv-top");
      dlg.style.removeProperty("--vv-h");
      dlg.classList.remove("chat-sheet--kb");
    };
  }, [open]);

  return (
    <dialog ref={dialogRef} className="chat-sheet" aria-label="Chat">
      <div className="chat-sheet-head">
        <h2>Chat</h2>
        <button type="button" className="secondary chat-sheet-close" onClick={() => setOpen(false)} aria-label="Close chat">✕</button>
      </div>
      {open && <ChatPanel chat={chat} />}
    </dialog>
  );
}

// Incoming-message toasts for wide screens (bottom-right corner, stacking
// upward, newest at the bottom) and for the scratch sheet (`inSheet`). Tapping
// one opens the chat; its ✕ closes just that one. On phones the message shows
// in the chat bar instead (see ChatDock). Inside the scratch sheet a single
// toast takes over the header's title text — the sheet's ✕ button and
// everything below stay uncovered. It's rendered inside the sheet's <dialog>
// while that's open (a modal dialog sits above everything else on the page and
// makes the rest inert, so a toast outside it couldn't be seen or tapped).
export function ChatToasts({ chat, inSheet = false }) {
  const shown = chat.toasts.slice(0, chat.maxVisible);
  const waiting = chat.toasts.length - shown.length;
  return (
    <div className={`chat-toasts${inSheet ? " chat-toasts--sheet" : ""}`} role="status" aria-live="polite">
      {shown.map((t) => (
        <div key={t.id} className={`chat-toast${t.presetId ? " chat-toast--preset" : ""}`}>
          <button type="button" className="chat-toast-open" onClick={chat.openChat}>
            <span className="chat-toast-name">{t.name}</span>
            <span className="chat-toast-text">{t.text}</span>
          </button>
          <button type="button" className="chat-toast-dismiss" onClick={() => chat.dismissToast(t.id)} aria-label={`Dismiss message from ${t.name}`}>✕</button>
        </div>
      ))}
      {waiting > 0 && <span className="chat-toast-more">+{waiting} more</span>}
    </div>
  );
}
