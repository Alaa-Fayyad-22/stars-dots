"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAT_PRESETS, findChatPreset } from "@/lib/chatPresets";
import { post, copyText, colorsById } from "@/lib/client";
import { Swatch } from "./Board";
import { playChatSound, preloadChatSounds } from "@/lib/audio";

const WIDE_QUERY = "(min-width: 720px)";
const MAX_TOASTS = 3; // stacked at once on wide screens; more wait in line
const TOAST_MS = 4000;
const MAX_LENGTH = 200;
const LONG_STATEMENT = 16; // characters; a longer statement gets a chip row of its own

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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
export function useChat({ state, code, cred, sheetOpen, onOpenRequest }) {
  const playerId = cred.id;
  const wide = useWide();
  // How many toasts are on screen at once (each starts its 4 seconds when it
  // moves into this window): a stack of 3 in the wide-screen corner; one at a
  // time in the phone chat bar and in the scratch sheet's header.
  const maxVisible = wide && !sheetOpen ? MAX_TOASTS : 1;
  const [open, setOpen] = useState(false); // phone: the sheet
  const [expanded, setExpanded] = useState(false); // wide: the side panel
  const [panelInView, setPanelInView] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [localMsgs, setLocalMsgs] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState(false); // a text box has focus
  const [pickerId, setPickerId] = useState(null); // which quick-statements picker is open: "dock" | "corner" | "sheet"

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

  // People who left (and can come back) are marked "(away)" in the chat.
  const awayIds = useMemo(() => new Set(state.players.filter((p) => p.removed && p.leaveReason === "left").map((p) => p.id)), [state.players]);
  // Everyone's color, from the players already in the poll (no extra data on messages).
  const colors = useMemo(() => colorsById(state.players), [state.players]);

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

  // Only one quick-statements picker at a time, and none survives a change of
  // layout (phone bar <-> corner button), the scratch sheet opening or
  // closing, the chat sheet opening, or the keyboard coming up.
  useEffect(() => { setPickerId(null); }, [wide, sheetOpen, open, typing]);

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
    setUnread((n) => n + others.filter((m) => !m.presetId).length);
    setToasts((q) => [...q, ...others.map((m) => ({ id: m.id, playerId: m.playerId, name: m.name, text: m.text, presetId: m.presetId }))]);
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

  const remember = useCallback((message) => {
    if (known.current) known.current.add(message.id);
    setLocalMsgs((l) => [...l.slice(-49), message]);
  }, []);

  const send = useCallback(async (payload) => {
    setSending(true); setError("");
    try {
      const { message } = await post("/api/chat", { code, ...payload }, cred);
      remember(message);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSending(false);
    }
  }, [code, cred, remember]);

  // A quick statement from a picker. Reports its own result — a failure (say,
  // the rate limit) is shown inside the picker, not in the chat's text box.
  const sendPreset = useCallback(async (presetId) => {
    try {
      const { message } = await post("/api/chat", { code, presetId }, cred);
      remember(message);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, [code, cred, remember]);

  return {
    wide, open, setOpen, expanded, setExpanded, panelRef, unread, toasts, openChat, dismissToast, typing, maxVisible,
    messages, canSend, playerId, draft, setDraft, sending, error, setError, send, sendPreset, pickerId, setPickerId, awayIds, colors,
  };
}

// ---- Quick statements (the 😀 button and its picker) -------------------------
// One component for all three homes: the phone chat bar ("dock"), the
// wide-screen corner ("corner") and the scratch sheet's header ("sheet"). The
// picker opens right above the button (below it in the sheet header, which sits
// at the very top of the screen), as a grid of big chips. Tapping a chip sends
// that statement at once. Only one picker is ever open (see `pickerId`).
export function QuickPicker({ chat, id, placement = "above" }) {
  const { pickerId, setPickerId, sendPreset, canSend } = chat;
  const open = pickerId === id;
  const [busyId, setBusyId] = useState(null);
  const [sentId, setSentId] = useState(null);
  const [error, setError] = useState("");
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const closeTimer = useRef(null);

  const close = useCallback((refocus) => {
    setPickerId(null);
    if (refocus) btnRef.current?.focus();
  }, [setPickerId]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Closes with Escape or a tap outside. Escape is handled first (capture
  // phase) so inside the scratch sheet it closes only the picker, not the sheet.
  useEffect(() => {
    if (!open) {
      setBusyId(null); setSentId(null); setError("");
      return;
    }
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);

  const choose = useCallback(async (preset) => {
    if (busyId || sentId) return;
    setBusyId(preset.id); setError("");
    const res = await sendPreset(preset.id);
    setBusyId(null);
    if (!res.ok) { setError(res.error); return; }
    setSentId(preset.id);
    closeTimer.current = setTimeout(() => { setSentId(null); setPickerId(null); }, 850);
  }, [busyId, sentId, sendPreset, setPickerId]);

  if (!canSend) return null;
  const single = CHAT_PRESETS.some((p) => Array.from(p.text).length > LONG_STATEMENT);

  return (
    <div className={`qs qs--${id} qs--${placement}`} ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className="qs-btn"
        aria-label={open ? "Close quick statements" : "Quick statements"}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => (open ? close(false) : setPickerId(id))}
      >
        <span aria-hidden="true">{open ? "✕" : "😀"}</span>
      </button>
      {open && (
        <div className="qs-pop" role="group" aria-label="Quick statements">
          <div className={`qs-grid${single ? " qs-grid--single" : ""}`}>
            {CHAT_PRESETS.map((p) => {
              const state = sentId === p.id ? "sent" : busyId === p.id ? "sending" : "idle";
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`secondary qs-chip qs-chip--${state}`}
                  onClick={() => choose(p)}
                  disabled={!!busyId || !!sentId}
                  aria-label={state === "idle" ? p.text : state === "sending" ? `Sending: ${p.text}` : `Sent: ${p.text}`}
                >
                  {state === "sending" ? "Sending…" : state === "sent" ? "✓ Sent" : p.text}
                </button>
              );
            })}
          </div>
          {error && <p className="error small qs-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

// ---- The chat itself -------------------------------------------------------

// One message. Long-pressing it (touch) or right-clicking it (mouse) copies its
// text. Nothing here blocks scrolling or normal text selection: a press that
// moves, a scroll, or an active selection cancels the copy, and no default
// behavior is prevented on touch.
function ChatMessage({ m, mine, label, color }) {
  const [copied, setCopied] = useState(false);
  const press = useRef(null);
  const hide = useRef(null);
  useEffect(() => () => { clearTimeout(press.current?.timer); clearTimeout(hide.current); }, []);

  async function copy() {
    if (!(await copyText(m.text))) return;
    setCopied(true);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setCopied(false), 1300);
  }
  function cancel() {
    clearTimeout(press.current?.timer);
    press.current = null;
  }
  function onPointerDown(e) {
    if (e.pointerType === "mouse") return;
    cancel();
    press.current = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        press.current = null;
        if (window.getSelection?.().toString()) return; // they're selecting text — leave it alone
        copy();
      }, 550),
    };
  }
  function onPointerMove(e) {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel();
  }
  function onContextMenu(e) {
    const type = e.nativeEvent.pointerType;
    if (type && type !== "mouse") return; // a touch long-press: native selection handles it
    e.preventDefault();
    copy();
  }

  return (
    <li
      className={`chat-msg${mine ? " chat-msg--mine" : ""}${m.presetId ? " chat-msg--preset" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={onContextMenu}
    >
      <span className="chat-name"><Swatch color={color} />{label}</span>
      <span className="chat-text">{m.text}</span>
      {copied && <span className="chat-copied" role="status">Copied</span>}
    </li>
  );
}

// The chat itself: messages and the text box. Used inside the phone sheet and
// the wide-screen side panel. (Quick statements live in the 😀 picker.)
export function ChatPanel({ chat }) {
  const { messages: allMessages, canSend, playerId, draft, setDraft, sending, error, setError, send, awayIds, colors } = chat;
  // Quick statements only pop up as notifications; they're not shown in the chat list.
  const messages = allMessages.filter((m) => !m.presetId);
  const listRef = useRef(null);
  const pinned = useRef(true);
  const lastSeen = useRef(null);
  const [unseen, setUnseen] = useState(0);

  // Follow new messages only while the reader is at the bottom. Scrolled up
  // reading older ones? Leave them where they are and offer a jump instead.
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prevIdx = lastSeen.current ? messages.findIndex((m) => m.id === lastSeen.current) : -1;
    const added = lastSeen.current === null ? 0 : prevIdx === -1 ? messages.length : messages.length - 1 - prevIdx;
    lastSeen.current = lastId;
    if (pinned.current) list.scrollTop = list.scrollHeight;
    else if (added > 0) setUnseen((n) => n + added);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, messages.length]);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    if (pinned.current) setUnseen(0);
  }

  function jumpToNewest() {
    const list = listRef.current;
    if (!list) return;
    pinned.current = true;
    setUnseen(0);
    list.scrollTo({ top: list.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  async function submit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    pinned.current = true;
    if (await send({ text })) setDraft("");
  }

  return (
    <div className="chat-panel">
      <div className="chat-list-wrap">
        <ol className="chat-list" ref={listRef} onScroll={handleScroll} role="log" aria-label="Chat messages">
          {messages.length === 0 ? (
            <li className="chat-empty muted small">No messages yet. Say hi!</li>
          ) : (
            messages.map((m) => {
              const mine = m.playerId === playerId;
              const label = `${mine ? "You" : m.name}${awayIds.has(m.playerId) ? " (away)" : ""}`;
              return <ChatMessage key={m.id} m={m} mine={mine} label={label} color={colors[m.playerId]} />;
            })
          )}
        </ol>
        {unseen > 0 && (
          <button type="button" className="chat-newpill" onClick={jumpToNewest}>New messages ↓</button>
        )}
      </div>

      {canSend ? (
        <>
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
        <p className="small muted chat-readonly">You can still read the chat, but you can't send messages right now.</p>
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

// Phone: a slim bar along the bottom edge that opens the chat, with the 😀
// quick-statements button split off on its right. It reserves its own lane —
// the page has matching padding underneath — so unlike a floating button or a
// pop-up it can never sit on top of a control: whatever scrolls under it can
// always be scrolled clear, and the last controls on the page stay reachable.
// It shows the latest message and the unread count. It is also where incoming
// messages appear on a phone: for 4 seconds the bar itself turns dark (with a
// short pulse) and shows the sender and text (tap it to open the chat, ✕ to
// dismiss), one message at a time, with the same height — so nothing moves.
// It steps aside while a text box has focus (on Android the keyboard resizes
// the page and would otherwise push it up over the guess input). Scrolled down
// the page, it shrinks to a slimmer handle (badge + 😀 stay); it comes back
// scrolling up, or when the scrolling stops near the bottom. The lane it
// reserves never changes size, so nothing on the page jumps.
export function ChatDock({ chat, hidden }) {
  const { unread, open, typing, openChat, messages, toasts, dismissToast, pickerId } = chat;
  const alert = toasts[0];
  const chatOnly = messages.filter((m) => !m.presetId);
  const last = chatOnly[chatOnly.length - 1];
  const preview = last ? <><Swatch color={chat.colors[last.playerId]} />{`${last.playerId === chat.playerId ? "You" : last.name}: ${last.text}`}</> : "Say something to the table";
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let lastY = window.scrollY;
    let raf = 0;
    let idle = 0;
    const nearBottom = () => document.documentElement.scrollHeight - window.innerHeight - window.scrollY < 96;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        const dy = y - lastY;
        if (Math.abs(dy) >= 6) {
          if (dy < 0 || nearBottom()) setCollapsed(false);
          else if (y > 160) setCollapsed(true);
          lastY = y;
        }
        clearTimeout(idle);
        idle = setTimeout(() => { if (nearBottom() || window.scrollY < 160) setCollapsed(false); }, 700);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); clearTimeout(idle); };
  }, []);

  const slim = collapsed && !alert && pickerId !== "dock";
  return (
    <div className={`chat-dock${alert ? " chat-dock--alert" : ""}${slim ? " chat-dock--slim" : ""}${typing || open || hidden ? " chat-dock--hidden" : ""}`}>
      {alert && <span key={alert.id} className="chat-dock-flash" aria-hidden="true" />}
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
              <span className="chat-dock-name"><Swatch color={chat.colors[alert.playerId]} />{alert.name}</span>
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
        <QuickPicker chat={chat} id="dock" placement="above" />
      </div>
      <span className="sr-only" role="status" aria-live="polite">{alert ? `${alert.name}: ${alert.text}` : ""}</span>
    </div>
  );
}

// Tablet and laptop: the 😀 button in the bottom-right corner. The notification
// stack sits above it (see .chat-toasts).
export function ChatCorner({ chat }) {
  if (!chat.canSend) return null;
  return <QuickPicker chat={chat} id="corner" placement="above" />;
}

// Phone: the chat as a full-screen sheet over the game. The page behind is
// pinned in place, and the sheet follows the *visual* viewport, so on iPhone
// the text box stays visible above the on-screen keyboard. `topToast` is the
// "Your turn!" notification, shown here so it sits above the open chat.
export function ChatSheet({ chat, topToast }) {
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
        {open && topToast}
      </div>
      {open && <ChatPanel chat={chat} />}
    </dialog>
  );
}

// A wide-screen toast: tap to open the chat, ✕ to close it, or swipe / drag it
// sideways to send it away. A drag past ~70px dismisses; a shorter one snaps
// back. (touch-action: pan-y lets a horizontal swipe reach us while vertical
// scrolling still works.)
function ToastItem({ t, chat }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const justDragged = useRef(false);
  const slideTimer = useRef(null);
  useEffect(() => () => clearTimeout(slideTimer.current), []);

  function onPointerDown(e) {
    if (e.button && e.button !== 0) return;
    if (e.target.closest(".chat-toast-dismiss")) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, dx: 0 };
  }
  function onPointerMove(e) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      d.moved = true;
      ref.current.setPointerCapture?.(e.pointerId);
      ref.current.style.transition = "none";
    }
    d.dx = dx;
    ref.current.style.transform = `translateX(${dx}px)`;
    ref.current.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 240));
  }
  function onPointerUp(e) {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
    ref.current.releasePointerCapture?.(e.pointerId);
    const el = ref.current;
    if (Math.abs(d.dx) > 70) {
      const instant = prefersReducedMotion();
      el.style.transition = instant ? "none" : "transform 0.16s ease-out, opacity 0.16s ease-out";
      el.style.transform = `translateX(${d.dx > 0 ? 420 : -420}px)`;
      el.style.opacity = "0";
      slideTimer.current = setTimeout(() => chat.dismissToast(t.id), instant ? 0 : 160);
    } else {
      el.style.transition = prefersReducedMotion() ? "none" : "transform 0.15s ease-out, opacity 0.15s ease-out";
      el.style.transform = "";
      el.style.opacity = "";
    }
  }
  function onPointerCancel() {
    drag.current = null;
    if (ref.current) { ref.current.style.transform = ""; ref.current.style.opacity = ""; }
  }

  return (
    <div
      ref={ref}
      className={`chat-toast${t.presetId ? " chat-toast--preset" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={(e) => { if (justDragged.current) { e.stopPropagation(); e.preventDefault(); } }}
    >
      <button type="button" className="chat-toast-open" onClick={chat.openChat}>
        <span className="chat-toast-name"><Swatch color={chat.colors[t.playerId]} />{t.name}</span>
        <span className="chat-toast-text">{t.text}</span>
      </button>
      <button type="button" className="chat-toast-dismiss" onClick={() => chat.dismissToast(t.id)} aria-label={`Dismiss message from ${t.name}`}>✕</button>
    </div>
  );
}

// Incoming-message toasts for wide screens (bottom-right corner, stacking
// upward above the 😀 button, newest at the bottom) and for the scratch sheet
// (`inSheet`). Tapping one opens the chat; its ✕ (or a swipe) closes just that
// one. On phones the message shows in the chat bar instead (see ChatDock).
// Inside the scratch sheet a single toast takes over the header's title text —
// the sheet's buttons and everything below stay uncovered. It's rendered inside
// the sheet's <dialog> while that's open (a modal dialog sits above everything
// else on the page and makes the rest inert, so a toast outside it couldn't be
// seen or tapped).
export function ChatToasts({ chat, inSheet = false }) {
  const shown = chat.toasts.slice(0, chat.maxVisible);
  const waiting = chat.toasts.length - shown.length;
  return (
    <div className={`chat-toasts${inSheet ? " chat-toasts--sheet" : ""}`} role="status" aria-live="polite">
      {shown.map((t) => <ToastItem key={t.id} t={t} chat={chat} />)}
      {waiting > 0 && <span className="chat-toast-more">+{waiting} more</span>}
    </div>
  );
}

// "▶ Your turn!" — a small accent-colored notice for the moment the turn
// passes to this player. Tap to dismiss. Where it sits is decided by the page
// (`place`): away from the guess controls, and inside whichever dialog is open.
export function TurnToast({ onDismiss, place }) {
  return (
    <div className={`turn-toast turn-toast--${place}`} role="status" aria-live="assertive">
      <button type="button" className="turn-toast-btn" onClick={onDismiss} aria-label="Your turn! Tap to dismiss">
        <span aria-hidden="true">▶</span> Your turn!
      </button>
    </div>
  );
}

