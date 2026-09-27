"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DigitEntry, HowToPlay, Legend } from "./Board";
import { savePlayer, post } from "@/lib/client";

export default function Home() {
  const router = useRouter();
  const [hostName, setHostName] = useState("");
  const [secret, setSecret] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [error, setError] = useState({});
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy || !hostName.trim() || secret.length !== 4) return;
    setBusy(true); setError({});
    try {
      const { code, playerId } = await post("/api/create", { name: hostName, secret });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ create: e.message }); setBusy(false); }
  }

  async function join() {
    const code = joinCode.trim().toUpperCase();
    if (busy || code.length !== 5 || !joinName.trim()) return;
    setBusy(true); setError({});
    try {
      const { playerId } = await post("/api/join", { code, name: joinName });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ join: e.message }); setBusy(false); }
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
        <p className="muted lead">One person picks a secret 4-digit number. Everyone else races to crack it — no accounts, just a code.</p>
      </section>

      <section>
        <h2>How to play</h2>
        <HowToPlay />
        <Legend />
      </section>

      <div className="two-up">
        <section className="panel">
          <h2>Host a game</h2>
          <label htmlFor="hn">Your name</label>
          <input id="hn" value={hostName} onChange={(e) => setHostName(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="e.g. Sam" />
          <DigitEntry
            id="sec"
            label="Secret number"
            value={secret}
            onChange={setSecret}
            mask
            help="Only you will see it. 4 different digits, not starting with 0."
            onEnter={create}
          />
          <button onClick={create} disabled={busy || !hostName.trim() || secret.length !== 4}>Create game</button>
          {error.create && <p className="error" role="alert">{error.create}</p>}
        </section>

        <section className="panel">
          <h2>Join a game</h2>
          <p className="small muted">Got a code or an invite link from the host? Enter it here.</p>
          <label htmlFor="jc">Game code</label>
          <input id="jc" className="code-input" value={joinCode} maxLength={5} autoCapitalize="characters" autoComplete="off"
            placeholder="ABCDE"
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && join()}
          />
          <label htmlFor="jn">Your name</label>
          <input id="jn" value={joinName} onChange={(e) => setJoinName(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="e.g. Alex"
            onKeyDown={(e) => e.key === "Enter" && join()}
          />
          <button className="secondary" onClick={join} disabled={busy || joinCode.trim().length !== 5 || !joinName.trim()}>Join game</button>
          {error.join && <p className="error" role="alert">{error.join}</p>}
        </section>
      </div>
    </>
  );
}
