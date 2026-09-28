"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PinEntry, HowToPlay, Legend, ModeChoice, DigitsChoice } from "./Board";
import { savePlayer, post } from "@/lib/client";

export default function Home() {
  const router = useRouter();
  const [hostName, setHostName] = useState("");
  const [hostPin, setHostPin] = useState("");
  const [mode, setMode] = useState("rotating");
  const [digits, setDigits] = useState(4);
  const [error, setError] = useState({});
  const [busy, setBusy] = useState(false);

  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinPin, setJoinPin] = useState("");

  const [rejoining, setRejoining] = useState(false);
  const [rejoinPlayers, setRejoinPlayers] = useState(null);
  const [rejoinLoading, setRejoinLoading] = useState(false);
  const [rejoinName, setRejoinName] = useState("");
  const [rejoinPin, setRejoinPin] = useState("");

  async function create() {
    if (busy || !hostName.trim() || hostPin.length !== 4 || digits < 3) return;
    setBusy(true); setError({});
    try {
      const { code, playerId } = await post("/api/create", { name: hostName, pin: hostPin, mode, digits });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ create: e.message }); setBusy(false); }
  }

  async function join() {
    const code = joinCode.trim().toUpperCase();
    if (busy || code.length !== 5 || !joinName.trim() || joinPin.length !== 4) return;
    setBusy(true); setError({});
    try {
      const { playerId } = await post("/api/join", { code, name: joinName, pin: joinPin });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ join: e.message }); setBusy(false); }
  }

  async function openRejoin() {
    const code = joinCode.trim().toUpperCase();
    setRejoining(true);
    setError({});
    if (code.length !== 5) return;
    setRejoinLoading(true);
    try {
      const res = await fetch(`/api/state?code=${code}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setRejoinPlayers(data.players.filter((p) => !p.removed));
      } else {
        setRejoinPlayers([]);
      }
    } catch { setRejoinPlayers([]); }
    setRejoinLoading(false);
  }

  async function rejoin() {
    const code = joinCode.trim().toUpperCase();
    if (busy || code.length !== 5 || !rejoinName || rejoinPin.length !== 4) return;
    setBusy(true); setError({});
    try {
      const { playerId } = await post("/api/rejoin", { code, name: rejoinName, pin: rejoinPin });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ rejoin: e.message }); setBusy(false); }
  }

  return (
    <>
      <section className="hero">
        <div className="brand">
          <span className="brand-pegs" aria-hidden="true">
            <span className="peg star">★</span>
            <span className="peg dot" />
            <span className="peg star">★</span>
          </span>
          <h1>Stars &amp; Dots</h1>
        </div>
        <p className="muted lead">Someone picks a secret number — or the game does. Everyone else races to crack it, no accounts, just a code.</p>
      </section>

      <section>
        <h2>How to play</h2>
        <HowToPlay digits={digits} />
        <Legend />
      </section>

      <div className="two-up">
        <section className="panel">
          <h2>Host a game</h2>

          <label htmlFor="hn">Your name</label>
          <input id="hn" value={hostName} onChange={(e) => setHostName(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="e.g. Sam" />

          <PinEntry id="hp" label="Pick a PIN" value={hostPin} onChange={setHostPin}
            help="So you can get back in if you lose your spot. Any 4 digits." />

          <label>Game mode</label>
          <ModeChoice value={mode} onChange={setMode} />

          <label>Number of digits</label>
          <DigitsChoice value={digits} onChange={setDigits} />

          {mode === "computer" && (
            <p className="small muted" style={{ marginTop: "0.5rem" }}>
              The game will pick a random number each round — you play too, and you'll never see it while a round is live.
            </p>
          )}

          <button onClick={create} disabled={busy || !hostName.trim() || hostPin.length !== 4}>Create game</button>
          {error.create && <p className="error" role="alert">{error.create}</p>}
        </section>

        <section className="panel">
          <h2>Join a game</h2>
          <p className="small muted">Got a code or an invite link from the host? Enter it here.</p>
          <label htmlFor="jc">Game code</label>
          <input id="jc" className="code-input" value={joinCode} maxLength={5} autoCapitalize="characters" autoComplete="off"
            placeholder="ABCDE"
            onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setRejoining(false); }}
            onKeyDown={(e) => e.key === "Enter" && !rejoining && join()}
          />

          {!rejoining && (
            <>
              <label htmlFor="jn">Your name</label>
              <input id="jn" value={joinName} onChange={(e) => setJoinName(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="e.g. Alex"
                onKeyDown={(e) => e.key === "Enter" && join()}
              />
              <PinEntry id="jp" label="Pick a PIN" value={joinPin} onChange={setJoinPin}
                help="So you can get back in if you lose your spot. Any 4 digits." onEnter={join} />
              <button className="secondary" onClick={join} disabled={busy || joinCode.trim().length !== 5 || !joinName.trim() || joinPin.length !== 4}>Join game</button>
              {error.join && <p className="error" role="alert">{error.join}</p>}

              <button type="button" className="secondary link-button" onClick={openRejoin} disabled={joinCode.trim().length !== 5}>
                Already in this game?
              </button>
            </>
          )}

          {rejoining && (
            <div className="rejoin-panel">
              <p className="small muted">Pick your name and enter your PIN to get your exact seat back.</p>
              {rejoinLoading && <p className="muted small">Loading players…</p>}
              {!rejoinLoading && rejoinPlayers && rejoinPlayers.length === 0 && (
                <p className="muted small">No players found for that code yet.</p>
              )}
              {!rejoinLoading && rejoinPlayers && rejoinPlayers.length > 0 && (
                <>
                  <label htmlFor="rn">Your name</label>
                  <select id="rn" value={rejoinName} onChange={(e) => setRejoinName(e.target.value)}>
                    <option value="">Choose your name…</option>
                    {rejoinPlayers.map((p) => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <PinEntry id="rp" label="Your PIN" value={rejoinPin} onChange={setRejoinPin} onEnter={rejoin} />
                  <button className="secondary" onClick={rejoin} disabled={busy || !rejoinName || rejoinPin.length !== 4}>Rejoin</button>
                  {error.rejoin && <p className="error" role="alert">{error.rejoin}</p>}
                </>
              )}
              <button type="button" className="secondary link-button" onClick={() => setRejoining(false)}>Join as a new player instead</button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
