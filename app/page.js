"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GuessRow, Legend } from "./Board";
import { savePlayer, post, digitsOnly } from "@/lib/client";

export default function Home() {
  const router = useRouter();
  const [hostName, setHostName] = useState("");
  const [secret, setSecret] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [error, setError] = useState({});
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true); setError({});
    try {
      const { code, playerId } = await post("/api/create", { name: hostName, secret });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ create: e.message }); setBusy(false); }
  }

  async function join() {
    setBusy(true); setError({});
    const code = joinCode.trim().toUpperCase();
    try {
      const { playerId } = await post("/api/join", { code, name: joinName });
      savePlayer(code, playerId);
      router.push(`/game/${code}`);
    } catch (e) { setError({ join: e.message }); setBusy(false); }
  }

  return (
    <>
      <section>
        <h1>Stars &amp; Dots</h1>
        <p className="muted">One person picks a secret 4-digit number. Everyone else races to crack it.</p>
        <GuessRow guess="1243" stars={2} dots={2} big />
        <Legend />
      </section>

      <section>
        <h2>Start a game</h2>
        <label htmlFor="hn">Your name</label>
        <input id="hn" value={hostName} onChange={(e) => setHostName(e.target.value)} maxLength={20} autoComplete="nickname" />
        <label htmlFor="sec">Secret number</label>
        <input
          id="sec" className="digits-input" type="password" inputMode="numeric" autoComplete="off"
          value={secret} onChange={(e) => setSecret(digitsOnly(e.target.value))} placeholder="????"
        />
        <p className="small muted" style={{ marginTop: "0.4rem" }}>Only you will see it. Repeated digits are allowed.</p>
        <button onClick={create} disabled={busy || !hostName.trim() || secret.length !== 4}>Create game</button>
        {error.create && <p className="error">{error.create}</p>}
      </section>

      <section>
        <h2>Join a game</h2>
        <label htmlFor="jc">Game code</label>
        <input id="jc" className="code-input" value={joinCode} maxLength={5} autoCapitalize="characters" autoComplete="off"
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
        <label htmlFor="jn">Your name</label>
        <input id="jn" value={joinName} onChange={(e) => setJoinName(e.target.value)} maxLength={20} autoComplete="nickname" />
        <button className="secondary" onClick={join} disabled={busy || joinCode.trim().length !== 5 || !joinName.trim()}>Join game</button>
        {error.join && <p className="error">{error.join}</p>}
      </section>
    </>
  );
}
