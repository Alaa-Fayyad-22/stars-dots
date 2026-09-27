"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { GuessRow, Legend, DigitEntry, TurnBanner, PlayerHistories } from "../../Board";
import { savePlayer, loadPlayer, post } from "@/lib/client";

const POLL_MS = 2000;

export default function Game() {
  const code = String(useParams().code || "").toUpperCase();
  const [playerId, setPlayerId] = useState(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setPlayerId(loadPlayer(code));
    setReady(true);
  }, [code]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/state?code=${code}&playerId=${playerId || ""}`, { cache: "no-store" });
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

  // Opened an invite link but not in the game yet
  if (!state.isHost && !state.me) {
    return <JoinForm code={code} hostName={state.hostName} onJoined={(id) => { savePlayer(code, id); setPlayerId(id); }} />;
  }

  return (
    <>
      <TopBar code={code} round={state.round} />
      <div className="two-up">
        {state.isHost ? (
          <HostView state={state} code={code} playerId={playerId} onAction={refresh} />
        ) : (
          <PlayerView state={state} code={code} playerId={playerId} onGuess={refresh} />
        )}
      </div>
    </>
  );
}

function TopBar({ code, round }) {
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
        <div className="small muted">Game code · round {round}</div>
        <div className="room-code">{code}</div>
      </div>
      <div className="topbar-actions">
        <button className="secondary" onClick={invite}>{copied ? "Link copied" : "Invite"}</button>
        <Link href="/"><button className="secondary">New game</button></Link>
      </div>
    </div>
  );
}

function JoinForm({ code, hostName, onJoined }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function join() {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    try { const { playerId } = await post("/api/join", { code, name }); onJoined(playerId); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <section className="state-card">
      <h1>Join {hostName}'s game</h1>
      <p className="muted">Game code</p>
      <div className="room-code room-code--big">{code}</div>
      <label htmlFor="n">Your name</label>
      <input id="n" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus autoComplete="nickname"
        onKeyDown={(e) => e.key === "Enter" && join()} />
      <button onClick={join} disabled={busy || !name.trim()}>Join game</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function PlayerView({ state, code, playerId, onGuess }) {
  const [guess, setGuess] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const myTurn = state.currentPlayerId === playerId;
  const current = state.players.find((p) => p.id === state.currentPlayerId);
  const canGuess = myTurn && !state.winner && !state.me.solved;

  async function submit() {
    if (busy || guess.length !== 4 || !canGuess) return;
    setBusy(true); setError("");
    try { await post("/api/guess", { code, playerId, guess }); setGuess(""); await onGuess(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <>
      <div className="col-main">
        <section>
          <TurnBanner
            myTurn={myTurn}
            waitingFor={current?.name}
            winner={state.winner}
            iWon={state.winner?.id === playerId}
            solved={state.me.solved && !state.winner}
            hostName={state.hostName}
          />
          {!state.winner && !state.me.solved && (
            <>
              <DigitEntry
                id="g"
                label="Your guess"
                value={guess}
                onChange={setGuess}
                disabled={!canGuess || busy}
                autoFocus={myTurn}
                onEnter={submit}
              />
              <button onClick={submit} disabled={busy || guess.length !== 4 || !canGuess}>
                {myTurn ? "Check guess" : "Not your turn"}
              </button>
              {error && <p className="error" role="alert">{error}</p>}
            </>
          )}
          <Legend />
        </section>

        <section>
          <h2>Everyone's guesses</h2>
          <PlayerHistories
            players={state.players}
            playerId={playerId}
            currentPlayerId={state.winner ? null : state.currentPlayerId}
          />
        </section>
      </div>

      <div className="col-side">
        <section>
          <h2>Players</h2>
          <PlayerList players={state.players} playerId={playerId} currentPlayerId={state.winner ? null : state.currentPlayerId} />
        </section>
      </div>
    </>
  );
}

function HostView({ state, code, playerId, onAction }) {
  const [show, setShow] = useState(false);
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState("");
  const current = state.players.find((p) => p.id === state.currentPlayerId);

  async function startRound() {
    if (busy || next.length !== 4) return;
    setBusy(true); setError("");
    try { await post("/api/newround", { code, playerId, secret: next }); setNext(""); setShow(false); await onAction(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function skipTurn() {
    if (skipBusy) return;
    setSkipBusy(true); setSkipError("");
    try { await post("/api/skipturn", { code, playerId }); await onAction(); }
    catch (e) { setSkipError(e.message); }
    setSkipBusy(false);
  }

  return (
    <>
      <div className="col-main">
        {state.winner && (
          <div className="turn-banner turn-banner--over" role="status">
            <span className="turn-banner-icon" aria-hidden="true">★</span>
            <span>{state.winner.name} cracked it in {state.winner.tries} {state.winner.tries === 1 ? "try" : "tries"}. Start a new round when you're ready.</span>
          </div>
        )}
        <section>
          <h2>Your secret</h2>
          <div className="secret-box">
            <GuessRow guess={show ? state.secret : "••••"} big />
            <button className="secondary" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
          </div>
          {!state.winner && (
            <p className="small muted" style={{ marginTop: "0.6rem" }}>
              {current ? <>Waiting on <strong>{current.name}</strong> to guess.</> : "Share the code so people can join."}
            </p>
          )}
        </section>

        <section>
          <h2>New round</h2>
          <p className="small muted">Pick a new secret. Everyone's guesses will be cleared and the turn resets.</p>
          <DigitEntry id="nr" value={next} onChange={setNext} mask onEnter={startRound} />
          <button className="secondary" onClick={startRound} disabled={busy || next.length !== 4}>Start new round</button>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      </div>

      <div className="col-side">
        <section>
          <h2>Players ({state.players.length})</h2>
          {state.players.length === 0 ? (
            <div className="state-card state-card--inline">
              <p className="muted">Nobody has joined yet.</p>
              <p className="small muted">Share the code <strong>{code}</strong> or tap Invite above.</p>
            </div>
          ) : (
            <>
              <ul className="players">
                {state.players.map((p) => (
                  <li key={p.id}>
                    <div className="who">
                      <span>{p.id === state.currentPlayerId && !state.winner ? <span className="turn-arrow" aria-hidden="true">▶</span> : null}{p.name}</span>
                      <span className={p.solved ? "solved" : "muted"}>{p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}</span>
                    </div>
                    {p.history.slice(-5).reverse().map((h) => (
                      <GuessRow key={h.at} guess={h.guess} stars={h.stars} dots={h.dots} />
                    ))}
                  </li>
                ))}
              </ul>
              {!state.winner && (
                <>
                  <button className="secondary" onClick={skipTurn} disabled={skipBusy}>
                    Skip {current ? current.name : "player"}'s turn
                  </button>
                  <p className="small muted">Use this if someone leaves and the game gets stuck.</p>
                  {skipError && <p className="error" role="alert">{skipError}</p>}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function PlayerList({ players, playerId, currentPlayerId }) {
  if (players.length === 0) {
    return <p className="muted">It's just you so far. Send the invite to get others in.</p>;
  }
  return (
    <ul className="players">
      {players.map((p) => (
        <li key={p.id} className={`who${p.id === currentPlayerId ? " who--turn" : ""}`}>
          <span>
            {p.id === currentPlayerId ? <span className="turn-arrow" aria-hidden="true">▶</span> : null}
            {p.name}{p.id === playerId ? " (you)" : ""}
          </span>
          <span className={p.solved ? "solved" : "muted"}>
            {p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
