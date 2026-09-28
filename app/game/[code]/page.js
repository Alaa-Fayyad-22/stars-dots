"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Legend, DigitEntry, PinEntry, RoundBanner, GuessFeed, PlayerNotes, DraftBoxes,
  ScratchSheet, Scoreboard, RoundHistory, DuplicateWarning,
} from "../../Board";
import { savePlayer, loadPlayer, post, usePlayerNotes, digitsOnly, findDuplicateGuess, draftGuessReason, canPlayerGuess } from "@/lib/client";


const POLL_MS = 2000;

const MODE_LABEL = { rotating: "Rotating host", computer: "Computer host" };
// A short beep for "your turn". Phones only allow sound after the player
// has tapped the page at least once, so the sound is unlocked on the
// first tap (see unlockAudio below).
let audioCtx = null;

function unlockAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}

function playBeep() {
  try {
    if (!audioCtx || audioCtx.state !== "running") return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  } catch {}
}

export default function Game() {
  const code = String(useParams().code || "").toUpperCase();
  const [playerId, setPlayerId] = useState(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setPlayerId(loadPlayer(code));
    setReady(true);
  }, [code]);

  const refresh = useCallback(async () => {
    const id = ++requestIdRef.current;
    const res = await fetch(`/api/state?code=${code}&playerId=${playerId || ""}`, { cache: "no-store" });
    // A newer request may have started (and even finished) while this one was
    // in flight. If so, its response is stale — drop it instead of letting it
    // clobber more recent state.
    if (id !== requestIdRef.current) return;
    if (res.status === 404) { setNotFound(true); return; }
    if (res.ok) setState(await res.json());
  }, [code, playerId]);

  // Poll so everyone's phone stays in sync
  useEffect(() => {
    if (!ready) return;
    refresh();
    // Every 2 seconds while visible; every 10 seconds while the tab is in the
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

  // Opened an invite link but not in the game yet (or lost localStorage)
  if (!state.me) {
    return <EntryForm code={code} state={state} onJoined={(id) => { savePlayer(code, id); setPlayerId(id); }} />;
  }

  return <GameView state={state} code={code} playerId={playerId} onAction={refresh} />;
}

function TopBar({ code, state }) {
  const [copied, setCopied] = useState(false);
  async function invite() {
    const url = `${location.origin}/game/${code}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Stars & Dots", text: `Join my game: ${code}`, url }); } catch {}
      return;
    }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }
  return (
    <div className="topbar">
      <div>
        <div className="small muted">Game code · round {state.round} · {state.digits} digits · {MODE_LABEL[state.mode]}</div>
        <div className="room-code">{code}</div>
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
  const activePlayers = state.players.filter((p) => !p.removed);

  async function join() {
    if (busy || !name.trim() || pin.length !== 4) return;
    setBusy(true); setError("");
    try { const { playerId } = await post("/api/join", { code, name, pin }); onJoined(playerId); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  async function rejoin() {
    if (busy || !rejoinName || rejoinPin.length !== 4) return;
    setBusy(true); setError("");
    try { const { playerId } = await post("/api/rejoin", { code, name: rejoinName, pin: rejoinPin }); onJoined(playerId); }
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
          {activePlayers.length === 0 ? (
            <p className="muted small">No players yet.</p>
          ) : (
            <>
              <label htmlFor="rn">Your name</label>
              <select id="rn" value={rejoinName} onChange={(e) => setRejoinName(e.target.value)}>
                <option value="">Choose your name…</option>
                {activePlayers.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
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

function PickSecretForm({ code, playerId, digits, onDone }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || secret.length !== digits) return;
    setBusy(true); setError("");
    try { await post("/api/pick", { code, playerId, secret }); setSecret(""); await onDone(); }
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

function EndRoundControl({ code, playerId, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true); setError("");
    try { await post("/api/endround", { code, playerId }); setConfirming(false); await onDone(); }
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

// The rotating host / computer organizer's only way to give up their seat.
// Confirmed, since it can't be undone from that device.
function LeaveGameControl({ code, playerId, mode, onLeft }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true); setError("");
    try { await post("/api/leave", { code, playerId }); await onLeft(); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  const roleWord = mode === "rotating" ? "host" : "organizer";
  if (!confirming) {
    return <button type="button" className="secondary" onClick={() => setConfirming(true)}>Leave game</button>;
  }
  return (
    <div className="confirm-box">
      <p className="small">
        Leave the game for good? You'll stop being {roleWord}, someone else will take over the controls, and you can't rejoin this seat.
      </p>
      <div className="confirm-actions">
        <button type="button" className="secondary" onClick={confirm} disabled={busy}>Yes, leave the game</button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
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

function GameView({ state, code, playerId, onAction }) {
  const { digits } = state;
  const [guess, setGuess] = useState("");
  const [guessError, setGuessError] = useState("");
  const [guessBusy, setGuessBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draftGuessBusy, setDraftGuessBusy] = useState(false);
  const [draftGuessError, setDraftGuessError] = useState("");
  const [nextRoundBusy, setNextRoundBusy] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState("");
  const [removeBusyId, setRemoveBusyId] = useState(null);
  const [removeError, setRemoveError] = useState("");

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
  // player becomes the actual host (wins a round, or takes over after "End
  // round"/the previous host leaving between rounds), their player tools —
  // including the scratch sheet — go away, so close it if it was open.
  useEffect(() => {
    if (iAmHostThisRound) setSheetOpen(false);
  }, [iAmHostThisRound]);

  // "Your turn" alert: vibrate (Android), beep, and change the tab title
// the moment the turn passes to this player.
const wasMyTurn = useRef(false);
const originalTitle = useRef(null);

useEffect(() => {
  window.addEventListener("pointerdown", unlockAudio);
  return () => window.removeEventListener("pointerdown", unlockAudio);
}, []);

useEffect(() => {
  if (canGuess && !wasMyTurn.current) {
    try { navigator.vibrate?.([200, 100, 200]); } catch {}
    playBeep();
  }
  wasMyTurn.current = canGuess;
}, [canGuess]);

useEffect(() => {
  if (originalTitle.current === null) originalTitle.current = document.title;
  document.title = canGuess ? "▶ Your turn! · Stars & Dots" : originalTitle.current;
  return () => { document.title = originalTitle.current; };
}, [canGuess]);

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
      await post("/api/guess", { code, playerId, guess: value });
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
    try { await post("/api/newround", { code, playerId }); await onAction(); }
    catch { /* surfaced via banner state on next poll */ }
    setNextRoundBusy(false);
  }

  // Host-only (rotating) / organizer-only (computer) skip, checked server-side.
  async function skipTurn() {
    if (skipBusy) return;
    setSkipBusy(true); setSkipError("");
    try { await post("/api/skipturn", { code, playerId }); await onAction(); }
    catch (e) { setSkipError(e.message); }
    setSkipBusy(false);
  }

  async function removePlayerFromGame(targetPlayerId) {
    if (removeBusyId) return;
    setRemoveBusyId(targetPlayerId); setRemoveError("");
    try { await post("/api/remove", { code, playerId, targetPlayerId }); await onAction(); }
    catch (e) { setRemoveError(e.message); }
    setRemoveBusyId(null);
  }

  async function restorePlayerInGame(targetPlayerId) {
    if (removeBusyId) return;
    setRemoveBusyId(targetPlayerId); setRemoveError("");
    try { await post("/api/restore", { code, playerId, targetPlayerId }); await onAction(); }
    catch (e) { setRemoveError(e.message); }
    setRemoveBusyId(null);
}

  if (state.me.removed) {
    const leftVoluntarily = state.me.leaveReason === "left";
    return (
      <>
        <TopBar code={code} state={state} />
        <div className="two-up">
          <div className="col-main">
            <section>
              <div className="turn-banner turn-banner--waiting" role="status">
                <span>
                  {leftVoluntarily
                    ? "You left this game. You can't rejoin this seat."
                    : "You've been removed from this game by the host."}
                </span>
              </div>
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
            <section>
              <h2>Everyone's guesses</h2>
              <GuessFeed players={state.players} playerId={playerId} />
            </section>
            
          </div>
        </div>
      </>
    );
  }

  const current = state.players.find((p) => p.id === state.currentPlayerId);
  const betweenRounds = state.roundState !== "active";

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
                />
                <DuplicateWarning dup={dup} />
                <button onClick={submitGuess} disabled={guessBusy || guess.length !== digits || !canGuess || !!dup}>
                  {canGuess ? "Check guess" : "Not your turn"}
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
            <PickSecretForm code={code} playerId={playerId} digits={digits} onDone={onAction} />
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
            {isControlsHolder && (
              <>
                {state.roundState === "active" && (
                  <>
                    <button className="secondary" onClick={skipTurn} disabled={skipBusy}>
                      Skip {current ? current.name : "player"}'s turn
                    </button>
                    <p className="small muted">Use this if someone leaves and the game gets stuck.</p>
                    <EndRoundControl code={code} playerId={playerId} onDone={onAction} />
                    {skipError && <p className="error" role="alert">{skipError}</p>}
                  </>
                )}
                <LeaveGameControl code={code} playerId={playerId} mode={state.mode} onLeft={onAction} />
              </>
            )}
          </section>
        </div>

        <div className="col-side">
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
        />
      )}
    </>
  );
}

function PlayerList({
  players, playerId, currentPlayerId, rotatingHostName, organizerName, controlsHolderName,
  protectedIds, onRemove, removeBusyId,
}) {
  const active = players.filter((p) => !p.removed);
  if (active.length === 0) {
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
        return (
          <li key={p.id} className={`who${p.id === currentPlayerId ? " who--turn" : ""}`}>
            <span className="who-name">
              {p.id === currentPlayerId ? <span className="turn-arrow" aria-hidden="true">▶</span> : null}
              <span className="who-name-text">{p.name}{tags.length ? ` (${tags.join(", ")})` : ""}</span>
            </span>
            <span className={`who-tries ${p.solved ? "solved" : "muted"}`}>
              {p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}
            </span>
            {canRemove && (
              <button type="button" className="secondary who-remove" onClick={() => onRemove(p.id)} disabled={!!removeBusyId}>
                Remove
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
