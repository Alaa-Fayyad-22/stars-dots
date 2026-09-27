"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { GuessRow, Legend } from "../../Board";
import { savePlayer, loadPlayer, post, digitsOnly } from "@/lib/client";

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
      <section>
        <h1>Game not found</h1>
        <p className="muted">The code {code} doesn't match a game. Games are removed after 24 hours.</p>
        <Link href="/"><button>Start or join a game</button></Link>
      </section>
    );
  }
  if (!ready || !state) return <p className="muted">Loading game {code}…</p>;

  // Opened an invite link but not in the game yet
  if (!state.isHost && !state.me) {
    return <JoinForm code={code} hostName={state.hostName} onJoined={(id) => { savePlayer(code, id); setPlayerId(id); }} />;
  }

  return (
    <>
      <TopBar code={code} round={state.round} />
      {state.winner && (
        <div className="banner">
          <strong>{state.winner.id === playerId ? "You" : state.winner.name}</strong> cracked it in {state.winner.tries}{" "}
          {state.winner.tries === 1 ? "try" : "tries"}.
        </div>
      )}
      {state.isHost ? <HostView state={state} code={code} playerId={playerId} /> : <PlayerView state={state} code={code} playerId={playerId} onGuess={refresh} />}
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
      <button className="secondary" onClick={invite}>{copied ? "Link copied" : "Invite"}</button>
      <Link href="/"><button className="secondary">New game</button></Link>  
    </div>
  );
}

function JoinForm({ code, hostName, onJoined }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function join() {
    setBusy(true); setError("");
    try { const { playerId } = await post("/api/join", { code, name }); onJoined(playerId); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <section>
      <h1>Join {hostName}'s game</h1>
      <p className="muted">Game code <span className="room-code" style={{ fontSize: "1.2rem" }}>{code}</span></p>
      <label htmlFor="n">Your name</label>
      <input id="n" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus autoComplete="nickname"
        onKeyDown={(e) => e.key === "Enter" && name.trim() && join()} />
      <button onClick={join} disabled={busy || !name.trim()}>Join game</button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function PlayerView({ state, code, playerId, onGuess }) {
  const [guess, setGuess] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const history = state.me.history;

  async function submit() {
    if (guess.length !== 4) return;
    setBusy(true); setError("");
    try { await post("/api/guess", { code, playerId, guess }); setGuess(""); await onGuess(); }
    catch (e) { setError(e.message); }
    setBusy(false);
    inputRef.current?.focus();
  }

  return (
    <>
      <section>
        {state.me.solved ? (
          <p><strong>You found it in {history.length} {history.length === 1 ? "try" : "tries"}.</strong> Wait for {state.hostName} to start a new round.</p>
        ) : (
          <>
            <label htmlFor="g">Your guess</label>
            <input
              id="g" ref={inputRef} className="digits-input" inputMode="numeric" autoComplete="off" placeholder="????"
              value={guess} onChange={(e) => setGuess(digitsOnly(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button onClick={submit} disabled={busy || guess.length !== 4}>Check guess</button>
            {error && <p className="error">{error}</p>}
          </>
        )}
        <Legend />
      </section>

      <section>
        <h2>Your guesses</h2>
        {history.length === 0 ? (
          <p className="muted">Your guesses and their stars and dots will show up here.</p>
        ) : (
          [...history].reverse().map((h, i) => (
            <GuessRow key={h.at} guess={h.guess} stars={h.stars} dots={h.dots} num={history.length - i} fresh={i === 0} />
          ))
        )}
      </section>

      <section>
        <h2>Players</h2>
        <PlayerList players={state.players} playerId={playerId} />
      </section>
    </>
  );
}

function HostView({ state, code, playerId }) {
  const [show, setShow] = useState(false);
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function startRound() {
    setBusy(true); setError("");
    try { await post("/api/newround", { code, playerId, secret: next }); setNext(""); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <>
      <section>
        <h2>Your secret</h2>
        <div className="secret-box">
          <GuessRow guess={show ? state.secret : "????"} big />
          <button className="secondary" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
        </div>
        <p className="small muted" style={{ marginTop: "0.6rem" }}>Tap Invite to send the link. You can watch everyone's guesses below.</p>
      </section>

      <section>
        <h2>Players ({state.players.length})</h2>
        {state.players.length === 0 ? (
          <p className="muted">Nobody has joined yet. Share the code {code} or tap Invite.</p>
        ) : (
          <ul className="players">
            {state.players.map((p) => (
              <li key={p.id}>
                <div className="who">
                  <span>{p.name}</span>
                  <span className={p.solved ? "solved" : "muted"}>{p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}</span>
                </div>
                {p.history.slice(-5).reverse().map((h) => (
                  <GuessRow key={h.at} guess={h.guess} stars={h.stars} dots={h.dots} />
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>New round</h2>
        <p className="small muted">Pick a new secret. Everyone's guesses will be cleared.</p>
        <input className="digits-input" type="password" inputMode="numeric" autoComplete="off" placeholder="????"
          value={next} onChange={(e) => setNext(digitsOnly(e.target.value))} />
        <button className="secondary" onClick={startRound} disabled={busy || next.length !== 4}>Start new round</button>
        {error && <p className="error">{error}</p>}
      </section>
    </>
  );
}

function PlayerList({ players, playerId }) {
  return (
    <ul className="players">
      {players.map((p) => (
        <li key={p.id} className="who">
          <span>{p.name}{p.id === playerId ? " (you)" : ""}</span>
          <span className={p.solved ? "solved" : "muted"}>{p.solved ? `Solved in ${p.tries}` : `${p.tries} ${p.tries === 1 ? "try" : "tries"}`}</span>
        </li>
      ))}
    </ul>
  );
}
