"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Legend, DigitEntry, PinEntry, RoundBanner, GuessFeed, PlayerNotes, DraftBoxes,
  ScratchSheet, Scoreboard, RoundHistory, DuplicateWarning,
} from "../../Board";
import {
  savePlayer, loadPlayer, post, fetchState, usePlayerNotes, digitsOnly, findDuplicateGuess, draftGuessReason,
  canPlayerGuess, guessButtonLabel, sheetStatus, loadFlag, saveFlag, copyText, awayTag,
} from "@/lib/client";
import { unlockAudio, playBeep } from "@/lib/audio";
import { useChat, ChatSection, ChatSheet, ChatDock, ChatToasts, ChatCorner, QuickPicker, TurnToast } from "../../Chat";


const POLL_MS = 3000;
const TURN_TOAST_MS = 3000;

const MODE_LABEL = { rotating: "Rotating host", computer: "Computer host" };
export default function Game() {
  const code = String(useParams().code || "").toUpperCase();
  const [cred, setCred] = useState(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const requestIdRef = useRef(0);

  // Older versions saved just a player id here; that can't sign anyone in, so
  // loadPlayer() treats it as "not signed in" and the entry form appears.
  useEffect(() => {
    setCred(loadPlayer(code));
    setReady(true);
  }, [code]);

  const refresh = useCallback(async () => {
    const id = ++requestIdRef.current;
    const res = await fetchState(code, cred);
    // A newer request may have started (and even finished) while this one was
    // in flight. If so, its response is stale — drop it instead of letting it
    // clobber more recent state.
    if (id !== requestIdRef.current) return;
    if (res.status === 404) { setNotFound(true); return; }
    if (res.ok) setState(await res.json());
  }, [code, cred]);

  // Poll so everyone's phone stays in sync
  useEffect(() => {
    if (!ready) return;
    refresh();
    // Every 3 seconds while visible; every 15 seconds while the tab is in the
    // background, so "Your turn!" can still show in the tab title without
    // sending too many requests.
    let tick = 0;
    const t = setInterval(() => {
      tick++;
      if (!document.hidden || tick % 5 === 0) refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [ready, refresh]);

  if (notFound) {
    return (
      <section className="state-card">
        <h1>Game not found</h1>
        <p className="muted">The code <strong>{code}</strong> doesn't match a game. Games are removed after 24 hours of inactivity.</p>
        <Link href="/"><button>Start or join a game</button></Link>
      </section>
    );
  }
  if (!ready || !state) return <p className="muted loading">Loading game {code}…</p>;

  // Opened an invite link but not in the game yet (or lost / outdated saved data)
  if (!state.me) {
    return <EntryForm code={code} state={state} onJoined={(c) => { savePlayer(code, c); setCred(c); }} />;
  }

  return <GameView state={state} code={code} cred={cred} onAction={refresh} />;
}

function TopBar({ code, state }) {
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  async function invite() {
    const url = `${location.origin}/game/${code}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Stars & Dots", text: `Join my game: ${code}`, url }); } catch {}
      return;
    }
    if (await copyText(url)) { setCopied(true); timers.current.push(setTimeout(() => setCopied(false), 2000)); }
  }
  async function copyCode() {
    if (await copyText(code)) { setCodeCopied(true); timers.current.push(setTimeout(() => setCodeCopied(false), 1800)); }
  }
  return (
    <div className="topbar">
      <div>
        <div className="small muted">Game code · round {state.round} · {state.digits} digits · {MODE_LABEL[state.mode]}</div>
        <div className="room-code-row">
          <div className="room-code">{code}</div>
          <button type="button" className="secondary copy-code" onClick={copyCode} aria-label={codeCopied ? "Game code copied" : "Copy game code"}>
            {codeCopied ? "Copied ✓" : "Copy code"}
          </button>
        </div>
      </div>
      <div className="topbar-actions">
        <button className="secondary" onClick={invite}>{copied ? "Link copied" : "Invite"}</button>
        <Link href="/"><button className="secondary">New game</button></Link>
      </div>
    </div>
  );
}

function EntryForm({ code, state, onJoined }) {
  const [tab, setTab] = useState("join");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [rejoinName, setRejoinName] = useState("");
  const [rejoinPin, setRejoinPin] = useState("");
  // Everyone who can get their seat back: players in the game and people who left.
  const comers = state.players.filter((p) => !p.removed || p.leaveReason === "left");

  async function join() {
    if (busy || !name.trim() || pin.length !== 4) return;
    setBusy(true); setError("");
    try { const { playerId, token } = await post("/api/join", { code, name, pin }); onJoined({ id: playerId, token }); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  async function rejoin() {
    if (busy || !rejoinName || rejoinPin.length !== 4) return;
    setBusy(true); setError("");
    try { const { playerId, token } = await post("/api/rejoin", { code, name: rejoinName, pin: rejoinPin }); onJoined({ id: playerId, token }); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <section className="state-card">
      <h1>Join {state.organizerName ? `${state.organizerName}'s` : "the"} game</h1>
      <p className="muted">Game code</p>
      <div className="room-code room-code--big">{code}</div>
      <p className="small muted">{state.digits} digits · {MODE_LABEL[state.mode]}</p>

      <div className="entry-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "join"} className={`secondary entry-tab${tab === "join" ? " entry-tab--selected" : ""}`} onClick={() => { setTab("join"); setError(""); }}>New player</button>
        <button type="button" role="tab" aria-selected={tab === "rejoin"} className={`secondary entry-tab${tab === "rejoin" ? " entry-tab--selected" : ""}`} onClick={() => { setTab("rejoin"); setError(""); }}>Already in this game?</button>
      </div>

      {tab === "join" ? (
        <>
          <label htmlFor="n">Your name</label>
          <input id="n" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus autoComplete="nickname"
            onKeyDown={(e) => e.key === "Enter" && join()} />
          <PinEntry id="np" label="Pick a PIN" value={pin} onChange={setPin} onEnter={join}
            help="So you can get back in if you lose your spot. Any 4 digits." />
          <button onClick={join} disabled={busy || !name.trim() || pin.length !== 4}>Join game</button>
        </>
      ) : (
        <>
          <p className="small muted">Pick your name and enter your PIN to get your exact seat back.</p>
          {comers.length === 0 ? (
            <p className="muted small">No players yet.</p>
          ) : (
            <>
              <label htmlFor="rn">Your name</label>
              <select id="rn" value={rejoinName} onChange={(e) => setRejoinName(e.target.value)}>
                <option value="">Choose your name…</option>
                {comers.map((p) => <option key={p.id} value={p.name}>{p.name}{awayTag(p)}</option>)}
              </select>
              <PinEntry id="rp" label="Your PIN" value={rejoinPin} onChange={setRejoinPin} onEnter={rejoin} />
              <button onClick={rejoin} disabled={busy || !rejoinName || rejoinPin.length !== 4}>Rejoin</button>
            </>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function PickSecretForm({ code, cred, digits, onDone }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || secret.length !== digits) return;
    setBusy(true); setError("");
    try { await post("/api/pick", { code, secret }, cred); setSecret(""); await onDone(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  return (
    <section>
      <h2>Pick the number</h2>
      <p className="small muted">Only you'll see it. {digits} different digits, not starting with 0.</p>
      <DigitEntry id="pick" value={secret} onChange={setSecret} digits={digits} mask onEnter={submit} />
      <button onClick={submit} disabled={busy || secret.length !== digits}>Start the round</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function EndRoundControl({ code, cred, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true); setError("");
    try { await post("/api/endround", { code }, cred); setConfirming(false); await onDone(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  if (!confirming) {
    return <button type="button" className="secondary" onClick={() => setConfirming(true)}>End round</button>;
  }
  return (
    <div className="confirm-box">
      <p className="small">End this round with no winner? The number will be revealed to everyone, and nobody scores.</p>
      <div className="confirm-actions">
        <button type="button" className="secondary" onClick={confirm} disabled={busy}>Yes, end round</button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// Everyone in the game can leave, and come back any time with their name and
// PIN (or, on this device, with the Rejoin button). Always confirmed.
function LeaveGameControl({ code, cred, onLeft, quiet }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true); setError("");
    try { await post("/api/leave", { code }, cred); await onLeft(); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  if (!confirming) {
    return (
      <button type="button" className={quiet ? "secondary leave-quiet" : "secondary"} onClick={() => setConfirming(true)}>
        Leave game
      </button>
    );
  }
  return (
    <div className="confirm-box" role="group" aria-label="Leave the game?">
      <p className="small">Leave the game? You can come back anytime with your name and PIN.</p>
      <div className="confirm-actions">
        <button type="button" className="secondary" onClick={confirm} disabled={busy}>Yes, leave</button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={busy}>Stay</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// Skip turn, End round and Leave game, in a section that opens and closes.
// Its header shows whose turn it is, so the host can see it without opening
// it, and whether it's open is remembered on this device.
function HostControls({ code, cred, state, onAction }) {
  const [open, setOpen] = useState(() => loadFlag("sd:hostctl-open", false));
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState("");
  const title = state.mode === "rotating" ? "Host controls" : "Organizer controls";
  const active = state.roundState === "active";
  const current = state.players.find((p) => p.id === state.currentPlayerId && !p.removed);
  const summary = active ? (current ? `${current.name}'s turn` : "Waiting for a player") : state.roundState === "pending" ? "Waiting for the number" : "Round over";

  function toggle() {
    const next = !open;
    setOpen(next);
    saveFlag("sd:hostctl-open", next);
  }
  async function skipTurn() {
    if (skipBusy) return;
    setSkipBusy(true); setSkipError("");
    try { await post("/api/skipturn", { code }, cred); await onAction(); }
    catch (e) { setSkipError(e.message); }
    setSkipBusy(false);
  }

  return (
    <div className="hostctl">
      <button type="button" className="secondary hostctl-head" aria-expanded={open} aria-controls="hostctl-body" onClick={toggle}>
        <span className="hostctl-title">{title}</span>
        <span className="hostctl-summary">{active && current ? <><span aria-hidden="true">▶ </span>{summary}</> : summary}</span>
        <span className="hostctl-chevron" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="hostctl-body" id="hostctl-body">
          {active && (
            <>
              <button className="secondary" onClick={skipTurn} disabled={skipBusy}>
                Skip {current ? current.name : "player"}'s turn
              </button>
              <p className="small muted">Use this if someone is stuck or away.</p>
              <EndRoundControl code={code} cred={cred} onDone={onAction} />
              {skipError && <p className="error" role="alert">{skipError}</p>}
            </>
          )}
          <LeaveGameControl code={code} cred={cred} onLeft={onAction} />
        </div>
      )}
    </div>
  );
}

// The rotating host's own number, hidden until they tap Show, so nobody
// can read it over their shoulder.
function SecretReveal({ secret }) {
  const [show, setShow] = useState(false);
  return (
    <section>
      <h2>Your number</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
        <span className="room-code">{show ? secret : "•".repeat(secret.length)}</span>
        <button
          type="button"
          className="secondary"
          style={{ width: "auto", margin: 0 }}
          onClick={() => setShow(!show)}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <p className="small muted">Only you can see this.</p>
    </section>
  );
}

// Where the "Your turn!" notice sits in the main view: whichever of the spots
// covers the fewest controls (and never the guess controls, if any spot is
// clear of them). Re-checked while it's showing, since the page can scroll.
function useToastSpot(active, wide) {
  const [spot, setSpot] = useState("top");
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const overlap = (a, b) => Math.max(0, Math.min(a.r, b.right) - Math.max(a.l, b.left)) * Math.max(0, Math.min(a.b, b.bottom) - Math.max(a.t, b.top));
    const compute = () => {
      raf = 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(240, vw - 24);
      const h = 48;
      const centered = (vw - w) / 2;
      const right = vw - w - 12;
      const spots = wide
        ? { top: { l: centered, t: 12 }, "top-right": { l: right, t: 12 }, "bottom-left": { l: 20, t: vh - 20 - h } }
        : { top: { l: centered, t: 12 }, "top-right": { l: right, t: 12 }, bottom: { l: centered, t: vh - 52 - 12 - h } };
      let best = null;
      for (const [name, p] of Object.entries(spots)) {
        const box = { l: p.l, r: p.l + w, t: p.t, b: p.t + h };
        let score = 0;
        document.querySelectorAll("[data-guard]").forEach((el) => { score += overlap(box, el.getBoundingClientRect()) * 100; });
        document.querySelectorAll("main button, main input, main select, main a").forEach((el) => {
          if (!el.closest("[data-guard]")) score += overlap(box, el.getBoundingClientRect());
        });
        if (best === null || score < best.score) best = { name, score };
      }
      setSpot(best.name);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(compute); };
    compute();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [active, wide]);
  return spot;
}

function GameView({ state, code, cred, onAction }) {
  const playerId = cred.id;
  const { digits } = state;
  const [guess, setGuess] = useState("");
  const [guessError, setGuessError] = useState("");
  const [guessBusy, setGuessBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draftGuessBusy, setDraftGuessBusy] = useState(false);
  const [draftGuessError, setDraftGuessError] = useState("");
  const [nextRoundBusy, setNextRoundBusy] = useState(false);
  const [removeBusyId, setRemoveBusyId] = useState(null);
  const [removeError, setRemoveError] = useState("");
  const [rejoinBusy, setRejoinBusy] = useState(false);
  const [rejoinError, setRejoinError] = useState("");
  const [turnToast, setTurnToast] = useState(null);

  // Whoever currently holds host/organizer controls right now — the actual
  // host, or, during a hostless rotating round, whoever picked up controls
  // when the host left. Always checked again on the server too.
  const isControlsHolder = state.isControlsHolder;
  const iAmHostThisRound = state.mode === "rotating" && state.isHost;
  const canGuess = canPlayerGuess({
    roundState: state.roundState,
    isHostThisRound: iAmHostThisRound,
    solved: state.me.solved,
    currentPlayerId: state.currentPlayerId,
    playerId,
  });
  const showGuessForm = state.roundState === "active" && !iAmHostThisRound && !state.me.solved;
  const showNotesAndDraft = !iAmHostThisRound;

  // The one exception to "the sheet never closes by itself": the moment a
  // player becomes the actual host (hosting rotates to them, or they take over
  // after the previous host leaves between rounds), their player tools —
  // including the scratch sheet — go away, so close it if it was open.
  useEffect(() => {
    if (iAmHostThisRound) setSheetOpen(false);
  }, [iAmHostThisRound]);

  // "Your turn" alert: vibrate (Android), beep, and change the tab title the
  // moment the turn passes to this player. The little "▶ Your turn!" notice
  // fires on the same transition (but not just because the page loaded).
  const wasMyTurn = useRef(false);
  const seenFirst = useRef(false);
  const originalTitle = useRef(null);

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio);
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, []);

  useEffect(() => {
    if (canGuess && !wasMyTurn.current) {
      try { navigator.vibrate?.([200, 100, 200]); } catch {}
      playBeep();
      if (seenFirst.current) setTurnToast(Date.now());
    }
    if (!canGuess) setTurnToast(null);
    wasMyTurn.current = canGuess;
    seenFirst.current = true;
  }, [canGuess]);

  // The notice goes by itself after a few seconds.
  useEffect(() => {
    if (!turnToast) return;
    const t = setTimeout(() => setTurnToast(null), TURN_TOAST_MS);
    return () => clearTimeout(t);
  }, [turnToast]);

  useEffect(() => {
    if (originalTitle.current === null) originalTitle.current = document.title;
    document.title = canGuess ? "▶ Your turn! · Stars & Dots" : originalTitle.current;
    return () => { document.title = originalTitle.current; };
  }, [canGuess]);

  const chat = useChat({ state, code, cred, sheetOpen, onOpenRequest: () => setSheetOpen(false) });
  const toastSpot = useToastSpot(!!turnToast && !sheetOpen && !chat.open, chat.wide);
  const dismissTurnToast = () => setTurnToast(null);

  const { notes, toggleDigit, setDraft, clearDraft, clear } = usePlayerNotes(code, state.round, digits);
  const dup = guess.length === digits ? findDuplicateGuess(state.players, guess, playerId) : null;

  const draftString = notes.draft.join("");
  const draftReason = draftGuessReason({
    draft: notes.draft,
    digits,
    players: state.players,
    playerId,
    roundState: state.roundState,
    isHostThisRound: iAmHostThisRound,
    solved: state.me.solved,
    currentPlayerId: state.currentPlayerId,
  });
  const draftCanSubmit = draftReason === null;
  const draftSubmitMessage = draftGuessError || (!draftGuessBusy && !draftCanSubmit ? draftReason : null);

  // Shared by both the main "Check guess" button and the scratch sheet's
  // "Submit guess" button, so server validation, duplicate protection, and
  // double-tap protection all apply exactly the same way either way.
  async function submitGuessValue(value) {
    try {
      await post("/api/guess", { code, guess: value }, cred);
      await onAction();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function submitGuess() {
    if (guessBusy || guess.length !== digits || !canGuess || dup) return;
    setGuessBusy(true); setGuessError("");
    const res = await submitGuessValue(guess);
    if (res.ok) setGuess(""); else setGuessError(res.error);
    setGuessBusy(false);
  }

  async function submitDraftGuess() {
    if (draftGuessBusy || !draftCanSubmit) return;
    setDraftGuessBusy(true); setDraftGuessError("");
    const res = await submitGuessValue(draftString);
    // On success the number's been used, so clear the draft (shared with the
    // main view) for the next guess. On rejection, leave it as-is so the
    // player can fix it.
    if (res.ok) clearDraft(); else setDraftGuessError(res.error);
    setDraftGuessBusy(false);
  }

  function useDraftAsGuess(value) {
    setGuess(digitsOnly(value, digits));
  }

  function openSheet() {
    setDraftGuessError("");
    setSheetOpen(true);
  }

  function changeDraftFromSheet(next) {
    setDraft(next);
    if (draftGuessError) setDraftGuessError("");
  }

  async function nextRound() {
    if (nextRoundBusy) return;
    setNextRoundBusy(true);
    try { await post("/api/newround", { code }, cred); await onAction(); }
    catch { /* surfaced via banner state on next poll */ }
    setNextRoundBusy(false);
  }

  async function removePlayerFromGame(targetPlayerId) {
    if (removeBusyId) return;
    setRemoveBusyId(targetPlayerId); setRemoveError("");
    try { await post("/api/remove", { code, targetPlayerId }, cred); await onAction(); }
    catch (e) { setRemoveError(e.message); }
    setRemoveBusyId(null);
  }

  async function restorePlayerInGame(targetPlayerId) {
    if (removeBusyId) return;
    setRemoveBusyId(targetPlayerId); setRemoveError("");
    try { await post("/api/restore", { code, targetPlayerId }, cred); await onAction(); }
    catch (e) { setRemoveError(e.message); }
    setRemoveBusyId(null);
  }

  // Coming back after leaving, on this device: the token proves who you are.
  async function rejoinThisDevice() {
    if (rejoinBusy) return;
    setRejoinBusy(true); setRejoinError("");
    try { await post("/api/comeback", { code }, cred); await onAction(); }
    catch (e) { setRejoinError(e.message); }
    setRejoinBusy(false);
  }

  // Where the "Your turn!" notice is drawn: inside whichever dialog is open
  // (a modal dialog sits above everything else, so it has to live in it), else
  // on the page itself.
  const pageToast = turnToast && !sheetOpen && !chat.open ? <TurnToast place={toastSpot} onDismiss={dismissTurnToast} /> : null;
  const sheetToast = turnToast ? <TurnToast place="sheet" onDismiss={dismissTurnToast} /> : null;
  const chatToast = turnToast ? <TurnToast place="chat" onDismiss={dismissTurnToast} /> : null;

  if (state.me.removed) {
    const away = state.me.leaveReason === "left";
    return (
      <>
        <TopBar code={code} state={state} />
        <div className="two-up">
          <div className="col-main">
            <section>
              <div className="turn-banner turn-banner--waiting" role="status">
                <span>
                  {away
                    ? "You left the game. You can come back anytime."
                    : "You've been removed from this game by the host."}
                </span>
              </div>
              {away && (
                <>
                  <button type="button" onClick={rejoinThisDevice} disabled={rejoinBusy}>{rejoinBusy ? "Rejoining…" : "Rejoin"}</button>
                  <p className="small muted">On another device? Open the game link and choose "Already in this game?" with your name and PIN.</p>
                  {rejoinError && <p className="error" role="alert">{rejoinError}</p>}
                </>
              )}
            </section>
            <section>
              <h2>Scoreboard</h2>
              <Scoreboard scoreboard={state.scoreboard} playerId={playerId} />
            </section>
            {state.rounds?.length > 0 && (
              <section>
                <h2>Rounds</h2>
                <RoundHistory rounds={state.rounds} />
              </section>
            )}
          </div>
          <div className="col-side">
            {chat.wide && <ChatSection chat={chat} />}
            <section>
              <h2>Everyone's guesses</h2>
              <GuessFeed players={state.players} playerId={playerId} />
            </section>
          </div>
        </div>
        <ChatLayer chat={chat} sheetOpen={false} chatToast={chatToast} />
      </>
    );
  }

  const betweenRounds = state.roundState !== "active";
  const awayPlayers = state.players.filter((p) => p.removed && p.leaveReason === "left");

  return (
    <>
      <TopBar code={code} state={state} />
      <div className="two-up">
        <div className="col-main">
          <section>
            <RoundBanner
              state={state}
              playerId={playerId}
              onNextRoundClick={nextRound}
              nextRoundBusy={nextRoundBusy}
            />
            {showGuessForm && (
              <>
                <button type="button" className="secondary sheet-open" onClick={openSheet}>Scratch sheet</button>
                <DigitEntry
                  id="g"
                  label="Your guess"
                  value={guess}
                  onChange={setGuess}
                  digits={digits}
                  disabled={!canGuess || guessBusy}
                  autoFocus={canGuess}
                  onEnter={submitGuess}
                  guard="guess"
                />
                <DuplicateWarning dup={dup} />
                <button data-guard="guess-btn" onClick={submitGuess} disabled={guessBusy || guess.length !== digits || !canGuess || !!dup}>
                  {guessButtonLabel({ canGuess, players: state.players, currentPlayerId: state.currentPlayerId })}
                </button>
                {guessError && <p className="error" role="alert">{guessError}</p>}
                <Legend />
              </>
            )}
            {!showGuessForm && state.roundState === "active" && (
              <button type="button" className="secondary sheet-open" onClick={openSheet}>Scratch sheet</button>
            )}
          </section>

          {state.mode === "rotating" && state.isHost && state.roundState === "pending" && (
            <PickSecretForm code={code} cred={cred} digits={digits} onDone={onAction} />
          )}
          {iAmHostThisRound && state.roundState === "active" && state.secret && (
            <SecretReveal secret={state.secret} />
          )}

          {betweenRounds && (
            <section>
              <h2>Scoreboard</h2>
              <Scoreboard scoreboard={state.scoreboard} playerId={playerId} />
            </section>
          )}

          {showNotesAndDraft && (
            <>
              <section>
                <PlayerNotes notes={notes} onToggleDigit={toggleDigit} onClear={clear} />
              </section>
              <section>
                <h3>My draft</h3>
                <p className="small muted notes-hint">Your own scratch guess — doesn't do anything until you use it.</p>
                <DraftBoxes
                  draft={notes.draft}
                  digits={digits}
                  digitNotes={notes.digits}
                  onChangeDraft={setDraft}
                  onClearDraft={clearDraft}
                  onUseAsGuess={useDraftAsGuess}
                />
              </section>
            </>
          )}

          <section>
            <h2>Players ({state.players.filter((p) => !p.removed).length})</h2>
            <PlayerList
              players={state.players}
              playerId={playerId}
              currentPlayerId={state.roundState === "active" ? state.currentPlayerId : null}
              rotatingHostName={state.mode === "rotating" ? state.hostName : null}
              organizerName={state.organizerName}
              controlsHolderName={state.mode === "rotating" && !state.hostName ? state.controlsHolderName : null}
              protectedIds={[playerId, state.hostId, state.controlsHolderId].filter(Boolean)}
              onRemove={isControlsHolder ? removePlayerFromGame : null}
              removeBusyId={removeBusyId}
            />
            {removeError && <p className="error" role="alert">{removeError}</p>}
            {isControlsHolder && state.players.some((p) => p.removed && p.leaveReason === "removed") && (
              <>
                <h3>Removed players</h3>
                <ul className="players">
                  {state.players
                    .filter((p) => p.removed && p.leaveReason === "removed")
                    .map((p) => (
                      <li key={p.id} className="who">
                        <span className="who-name">
                          <span className="who-name-text">{p.name}</span>
                        </span>
                        <button
                          type="button"
                          className="secondary who-remove"
                          onClick={() => restorePlayerInGame(p.id)}
                          disabled={!!removeBusyId}
                        >
                          Restore
                        </button>
                      </li>
                    ))}
                </ul>
              </>
            )}
            {awayPlayers.length > 0 && isControlsHolder && (
              <p className="small muted away-note">Players marked "(away)" left on their own and can come back anytime with their name and PIN.</p>
            )}
            {isControlsHolder ? (
              <HostControls code={code} cred={cred} state={state} onAction={onAction} />
            ) : (
              <div className="leave-row">
                <LeaveGameControl code={code} cred={cred} onLeft={onAction} quiet />
              </div>
            )}
          </section>
        </div>

        <div className="col-side">
          {chat.wide && <ChatSection chat={chat} />}
          <section>
            <h2>Scoreboard</h2>
            <Scoreboard scoreboard={state.scoreboard} playerId={playerId} />
          </section>
          {state.rounds?.length > 0 && (
            <section>
              <h2>Rounds</h2>
              <RoundHistory rounds={state.rounds} />
            </section>
          )}
          <section>
            <h2>Everyone's guesses</h2>
            <GuessFeed players={state.players} playerId={playerId} digitNotes={notes.digits} />
          </section>

        </div>
      </div>

      {(showNotesAndDraft || sheetOpen) && (
        <ScratchSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          players={state.players}
          playerId={playerId}
          notes={notes}
          digits={digits}
          onToggleDigit={toggleDigit}
          onChangeDraft={changeDraftFromSheet}
          onClearDraft={clearDraft}
          onUseAsGuess={(d) => { useDraftAsGuess(d); setSheetOpen(false); }}
          onSubmitGuess={submitDraftGuess}
          submitDisabled={!draftCanSubmit}
          submitBusy={draftGuessBusy}
          submitMessage={draftSubmitMessage}
          turnStatus={sheetStatus({
            roundState: state.roundState,
            isHostThisRound: iAmHostThisRound,
            solved: state.me.solved,
            currentPlayerId: state.currentPlayerId,
            playerId,
            players: state.players,
            hostName: state.hostName,
          })}
          overlay={sheetOpen ? <ChatToasts chat={chat} inSheet /> : null}
          headerExtra={sheetOpen ? <QuickPicker chat={chat} id="sheet" placement="below" /> : null}
          topToast={sheetOpen ? sheetToast : null}
        />
      )}
      {pageToast}
      <ChatLayer chat={chat} sheetOpen={sheetOpen} chatToast={chatToast} />
    </>
  );
}

// The chat's fixed-position pieces. On phones: the chat bar along the bottom
// (with a spacer of the same height so the last things on the page stay
// reachable) and the chat sheet. On tablets and laptops: the notification
// stack and, below it, the 😀 button in the corner.
// Toasts sit at the page root — except while the scratch sheet is open, when
// they're rendered inside it (see ScratchSheet's `overlay`).
function ChatLayer({ chat, sheetOpen, chatToast }) {
  return (
    <>
      {!chat.wide && <div className="chat-clearance" aria-hidden="true" />}
      {!chat.wide && <ChatDock chat={chat} hidden={sheetOpen} />}
      {!chat.wide && <ChatSheet chat={chat} topToast={chatToast} />}
      {chat.wide && !sheetOpen && <ChatToasts chat={chat} />}
      {chat.wide && !sheetOpen && <ChatCorner chat={chat} />}
    </>
  );
}

function PlayerList({
  players, playerId, currentPlayerId, rotatingHostName, organizerName, controlsHolderName,
  protectedIds, onRemove, removeBusyId,
}) {
  const [confirmId, setConfirmId] = useState(null);
  const active = players.filter((p) => !p.removed);
  const away = players.filter((p) => p.removed && p.leaveReason === "left");
  if (active.length === 0 && away.length === 0) {
    return <p className="muted">It's just you so far. Send the invite to get others in.</p>;
  }
  return (
    <ul className="players">
      {active.map((p) => {
        const tags = [];
        if (p.name === rotatingHostName) tags.push("host");
        else if (p.name === controlsHolderName) tags.push("filling in as host");
        if (p.name === organizerName) tags.push("organizer");
        if (p.id === playerId) tags.push("you");
        const canRemove = onRemove && !(protectedIds || []).includes(p.id);
        const confirming = confirmId === p.id;
        return (
          <li key={p.id} className={`who${p.id === currentPlayerId ? " who--turn" : ""}`}>
            <span className="who-name">
              {p.id === currentPlayerId ? <span className="turn-arrow" aria-hidden="true">▶</span> : null}
              <span className="who-name-text">{p.name}{tags.length ? ` (${tags.join(", ")})` : ""}</span>
            </span>
            <span className={`who-tries ${p.solved ? "solved" : "muted"}`}>
              {p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}
            </span>
            {canRemove && !confirming && (
              <button type="button" className="secondary who-remove" onClick={() => setConfirmId(p.id)} disabled={!!removeBusyId}>
                Remove
              </button>
            )}
            {canRemove && confirming && (
              <div className="who-confirm" role="group" aria-label={`Remove ${p.name}?`}>
                <span className="who-confirm-text">Remove {p.name}?</span>
                <button type="button" className="secondary who-remove who-remove--yes" disabled={!!removeBusyId}
                  onClick={async () => { await onRemove(p.id); setConfirmId(null); }}>
                  Yes
                </button>
                <button type="button" className="secondary who-remove" onClick={() => setConfirmId(null)} disabled={!!removeBusyId}>
                  Cancel
                </button>
              </div>
            )}
          </li>
        );
      })}
      {away.map((p) => (
        <li key={p.id} className="who who--away">
          <span className="who-name">
            <span className="who-name-text">{p.name}{awayTag(p)}{p.id === playerId ? " (you)" : ""}</span>
          </span>
          <span className="who-tries muted">{p.tries} {p.tries === 1 ? "try" : "tries"}</span>
        </li>
      ))}
    </ul>
  );
}
