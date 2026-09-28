"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Legend, DigitEntry, PinEntry, RoundBanner, GuessFeed, PlayerNotes, DraftBoxes,
  ScratchSheet, Scoreboard, DuplicateWarning,
} from "../../Board";
import { savePlayer, loadPlayer, post, usePlayerNotes, digitsOnly, findDuplicateGuess } from "@/lib/client";

const POLL_MS = 2000;

const MODE_LABEL = { rotating: "Rotating host", computer: "Computer host" };

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
    const t = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
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

function GameView({ state, code, playerId, onAction }) {
  const { digits } = state;
  const [guess, setGuess] = useState("");
  const [guessError, setGuessError] = useState("");
  const [guessBusy, setGuessBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [nextRoundBusy, setNextRoundBusy] = useState(false);
  const [makeHostBusy, setMakeHostBusy] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState("");
  const [removeBusyId, setRemoveBusyId] = useState(null);
  const [removeError, setRemoveError] = useState("");

  const isHostOrOrganizer = state.mode === "rotating" ? state.isHost : state.isOrganizer;
  const iAmHostThisRound = state.mode === "rotating" && state.isHost;
  const canGuess = state.roundState === "active" && !iAmHostThisRound && !state.me.solved && state.currentPlayerId === playerId;
  const showGuessForm = state.roundState === "active" && !iAmHostThisRound && !state.me.solved;
  const showNotesAndDraft = !iAmHostThisRound;

  const { notes, toggleDigit, setDraft, clearDraft, clear } = usePlayerNotes(code, state.round, digits);
  const dup = guess.length === digits ? findDuplicateGuess(state.players, guess, playerId) : null;

  async function submitGuess() {
    if (guessBusy || guess.length !== digits || !canGuess || dup) return;
    setGuessBusy(true); setGuessError("");
    try { await post("/api/guess", { code, playerId, guess }); setGuess(""); await onAction(); }
    catch (e) { setGuessError(e.message); }
    setGuessBusy(false);
  }

  function useDraftAsGuess(draftString) {
    setGuess(digitsOnly(draftString, digits));
  }

  async function nextRound() {
    if (nextRoundBusy) return;
    setNextRoundBusy(true);
    try { await post("/api/newround", { code, playerId }); await onAction(); }
    catch { /* surfaced via banner state on next poll */ }
    setNextRoundBusy(false);
  }

  async function makeHost() {
    if (makeHostBusy) return;
    setMakeHostBusy(true);
    try { await post("/api/makehost", { code, playerId }); await onAction(); }
    catch { /* ignore; state will reflect reality on next poll */ }
    setMakeHostBusy(false);
  }

  // Shared by the host/organizer's manual "skip turn" and the stuck-player
  // fallback button — the server decides which one applies to this player.
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

  if (state.me.removed) {
    return (
      <>
        <TopBar code={code} state={state} />
        <div className="two-up">
          <div className="col-main">
            <section>
              <div className="turn-banner turn-banner--waiting" role="status">
                <span>You've been removed from this game by the host.</span>
              </div>
            </section>
            <section>
              <h2>Scoreboard</h2>
              <Scoreboard scoreboard={state.scoreboard} playerId={playerId} />
            </section>
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
              onMakeHost={makeHost}
              makeHostBusy={makeHostBusy}
              onSkipInactive={skipTurn}
              skipBusy={skipBusy}
            />
            {showGuessForm && (
              <>
                <button type="button" className="secondary sheet-open" onClick={() => setSheetOpen(true)}>Scratch sheet</button>
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
              <button type="button" className="secondary sheet-open" onClick={() => setSheetOpen(true)}>Scratch sheet</button>
            )}
          </section>

          {state.mode === "rotating" && state.isHost && state.roundState === "pending" && (
            <PickSecretForm code={code} playerId={playerId} digits={digits} onDone={onAction} />
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
              onRemove={isHostOrOrganizer ? removePlayerFromGame : null}
              removeBusyId={removeBusyId}
            />
            {removeError && <p className="error" role="alert">{removeError}</p>}
            {isHostOrOrganizer && state.roundState === "active" && (
              <>
                <button className="secondary" onClick={skipTurn} disabled={skipBusy}>
                  Skip {current ? current.name : "player"}'s turn
                </button>
                <p className="small muted">Use this if someone leaves and the game gets stuck.</p>
                <EndRoundControl code={code} playerId={playerId} onDone={onAction} />
                {skipError && <p className="error" role="alert">{skipError}</p>}
              </>
            )}
          </section>
        </div>

        <div className="col-side">
          <section>
            <h2>Scoreboard</h2>
            <Scoreboard scoreboard={state.scoreboard} playerId={playerId} />
          </section>
          <section>
            <h2>Everyone's guesses</h2>
            <GuessFeed players={state.players} playerId={playerId} digitNotes={notes.digits} />
          </section>
        </div>
      </div>

      {showNotesAndDraft && (
        <ScratchSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          players={state.players}
          playerId={playerId}
          notes={notes}
          digits={digits}
          onToggleDigit={toggleDigit}
          onChangeDraft={setDraft}
          onClearDraft={clearDraft}
          onUseAsGuess={(d) => { useDraftAsGuess(d); setSheetOpen(false); }}
        />
      )}
    </>
  );
}

function PlayerList({ players, playerId, currentPlayerId, rotatingHostName, organizerName, onRemove, removeBusyId }) {
  const active = players.filter((p) => !p.removed);
  if (active.length === 0) {
    return <p className="muted">It's just you so far. Send the invite to get others in.</p>;
  }
  return (
    <ul className="players">
      {active.map((p) => {
        const tags = [];
        if (p.name === rotatingHostName) tags.push("host");
        if (p.name === organizerName) tags.push("organizer");
        if (p.id === playerId) tags.push("you");
        return (
          <li key={p.id} className={`who${p.id === currentPlayerId ? " who--turn" : ""}`}>
            <span className="who-name">
              {p.id === currentPlayerId ? <span className="turn-arrow" aria-hidden="true">▶</span> : null}
              <span className="who-name-text">{p.name}{tags.length ? ` (${tags.join(", ")})` : ""}</span>
            </span>
            <span className={`who-tries ${p.solved ? "solved" : "muted"}`}>
              {p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}
            </span>
            {onRemove && (
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
