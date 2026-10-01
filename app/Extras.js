"use client";

// Newer screens, kept apart from Board.js/Chat.js: sound settings, round
// replays, the summary and Game over screen, ending the game, and the pieces
// that only exist in a duel.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Pegs, Swatch } from "./Board";
import { post, fetchReplay, fetchSummary, classifyDigits, awayTag, loadFlag, saveFlag } from "@/lib/client";
import { soundEnabled, setSoundEnabled } from "@/lib/audio";

// ---- A modal dialog: bottom sheet on phones, centered dialog on wider screens ----
// Mounted only while open. Pins the page behind it (iOS needs `position: fixed`
// on the body, not just overflow: hidden) and restores the scroll position.
function useModalDialog(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    const scrollY = window.scrollY;
    const { body } = document;
    const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    const onCancel = (e) => { e.preventDefault(); closeRef.current(); };
    dlg.addEventListener("cancel", onCancel);
    return () => {
      dlg.removeEventListener("cancel", onCancel);
      if (dlg.open) dlg.close();
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY);
    };
  }, []);
  return ref;
}

function Modal({ title, titleId, onClose, children, className = "" }) {
  const ref = useModalDialog(onClose);
  return (
    <dialog ref={ref} className={`modal ${className}`} aria-labelledby={titleId} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="secondary modal-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

// ---- Sound settings ------------------------------------------------------------
function SpeakerIcon({ muted }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      {muted ? (
        <>
          <line x1="16" y1="9" x2="22" y2="15" />
          <line x1="22" y1="9" x2="16" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

function SwitchRow({ label, hint, on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="switch-row" onClick={() => onChange(!on)}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        <span className="switch-hint small muted">{hint}</span>
      </span>
      <span className={`switch-track${on ? " switch-track--on" : ""}`} aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}

// The speaker button in the top bar. Two switches, saved on this device only.
// The icon shows a muted speaker whenever any sound is off.
export function SoundSettings() {
  const [open, setOpen] = useState(false);
  const [chatOn, setChatOn] = useState(true);
  const [turnOn, setTurnOn] = useState(true);
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  // Open it right-aligned with the button, then nudge it so it never runs off
  // either edge of the screen (the button isn't always at the right edge).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const pop = popRef.current;
      const btn = btnRef.current;
      if (!pop || !btn) return;
      const vw = document.documentElement.clientWidth;
      const b = btn.getBoundingClientRect();
      const w = pop.offsetWidth;
      const left = Math.max(8, Math.min(b.right - w, vw - w - 8));
      pop.style.left = `${left - b.left}px`;
      pop.style.right = "auto";
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    setChatOn(soundEnabled("chat"));
    setTurnOn(soundEnabled("turn"));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    };
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown, true); };
  }, [open]);

  const muted = !chatOn || !turnOn;
  return (
    <div className="sound" ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className="secondary sound-btn"
        aria-label={muted ? "Sound settings (some sounds are off)" : "Sound settings"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <SpeakerIcon muted={muted} />
      </button>
      {open && (
        <div className="sound-pop" role="dialog" aria-label="Sound settings" ref={popRef}>
          <SwitchRow label="Chat sounds" hint="Incoming messages and statements" on={chatOn}
            onChange={(v) => { setChatOn(v); setSoundEnabled("chat", v); }} />
          <SwitchRow label="Turn alert sound" hint={"The “Your turn” beep"} on={turnOn}
            onChange={(v) => { setTurnOn(v); setSoundEnabled("turn", v); }} />
          <p className="small muted sound-note">Saved on this device. Notifications and vibration still happen.</p>
        </div>
      )}
    </div>
  );
}

// ---- Round replay ------------------------------------------------------------------
const MODE_NAME = { rotating: "Rotating host", computer: "Computer host", duel: "Duel" };

function DigitTiles({ value, against, big }) {
  const marks = against ? classifyDigits(against, value) : null;
  const LABEL = { right: "right place", wrong: "wrong place", none: "not in the number" };
  return (
    <span className="tiles">
      {value.split("").map((d, i) => (
        <span key={i} className={`tile${big ? " tile--lg" : " tile--sm"}${marks ? ` tile--${marks[i]}` : ""}`} aria-label={marks ? `${d}, ${LABEL[marks[i]]}` : undefined}>
          {d}
        </span>
      ))}
    </span>
  );
}

function DigitLegend() {
  return (
    <ul className="digit-legend small" aria-label="Digit colors">
      <li><span className="tile tile--sm tile--right" aria-hidden="true">3</span> right place</li>
      <li><span className="tile tile--sm tile--wrong" aria-hidden="true">3</span> wrong place</li>
      <li><span className="tile tile--sm tile--none" aria-hidden="true">3</span> not in the number</li>
    </ul>
  );
}

const fmtTime = (at) => {
  try { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return ""; }
};

function Who({ p, suffix }) {
  return <span className="who-inline"><Swatch color={p.color} />{p.name}{suffix}</span>;
}

function ReplayBody({ details }) {
  const { digits, guesses, winners, outcome } = details;
  const duel = details.mode === "duel";
  const numberFor = (g) => (duel ? (details.secrets || []).find((s) => s.id === g.target)?.secret : details.secret);
  const winner = winners && winners[0];

  let result;
  if (outcome === "win" && winner) {
    result = <><Who p={winner} /> won in {winner.tries} {winner.tries === 1 ? "try" : "tries"}</>;
  } else if (outcome === "draw") {
    result = "Draw — both players cracked it";
  } else if (outcome === "gameover") {
    result = "No winner — the game was ended during this round";
  } else {
    result = "No winner — the round was ended early";
  }

  return (
    <>
      <section className="replay-numbers" aria-label={duel ? "The two numbers" : "The number"}>
        {duel ? (
          (details.secrets || []).map((s) => (
            <div key={s.id} className="replay-number">
              <div className="replay-number-label small"><Who p={s} suffix="'s number" /></div>
              {s.secret ? <DigitTiles value={s.secret} big /> : <span className="muted small">Not picked</span>}
            </div>
          ))
        ) : (
          <div className="replay-number">
            <div className="replay-number-label small muted">The number</div>
            {details.secret ? <DigitTiles value={details.secret} big /> : null}
          </div>
        )}
      </section>

      <dl className="replay-meta">
        <div><dt>Result</dt><dd>{result}</dd></div>
        {details.host && <div><dt>Host</dt><dd><Who p={details.host} suffix={details.host.left ? " (left mid-round)" : ""} /></dd></div>}
        <div><dt>Game</dt><dd>{MODE_NAME[details.mode] || details.mode} · {digits} digits</dd></div>
      </dl>

      <h3 className="replay-h">Guesses</h3>
      {guesses.length === 0 ? (
        <p className="muted">No guesses in this round.</p>
      ) : (
        <>
          <DigitLegend />
          <ol className="replay-list">
            {guesses.map((g) => {
              const cracked = g.stars === digits;
              const won = cracked && outcome === "win" && winners.some((w) => w.id === g.playerId);
              const target = duel ? (details.secrets || []).find((s) => s.id === g.target) : null;
              return (
                <li key={g.n} className={`replay-guess${won ? " replay-guess--win" : cracked ? " replay-guess--crack" : ""}`}>
                  <div className="replay-guess-head">
                    <span className="replay-n">{g.n}</span>
                    <span className="replay-name"><Who p={g} />{target ? <span className="muted small"> → {target.name}'s number</span> : null}</span>
                    <span className="replay-time small muted">{fmtTime(g.at)}</span>
                  </div>
                  <div className="replay-guess-body">
                    <DigitTiles value={g.guess} against={numberFor(g)} />
                    <Pegs stars={g.stars} dots={g.dots} total={digits} />
                    {won ? <span className="replay-badge">★ Winning guess</span> : cracked ? <span className="replay-badge replay-badge--soft">★ Cracked it</span> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}

// One finished round's replay, loaded only now (never with the poll).
export function ReplayDialog({ code, cred, round, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    fetchReplay(code, round, cred).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [code, round, cred]);

  return (
    <Modal title={`Round ${round} replay`} titleId="replay-title" onClose={onClose} className="modal--replay">
      {error ? <p className="error" role="alert">{error}</p>
        : !data ? <p className="muted" role="status">Loading the replay…</p>
        : data.available === false ? <p className="muted">Details not available for this round.</p>
        : <ReplayBody details={data.details} />}
    </Modal>
  );
}

// ---- Summary (so far / game over) -------------------------------------------------------
export function SummaryBody({ summary, playerId, final, headRight }) {
  const { standings, awards, roundsPlayed, totalGuesses } = summary;
  const leader = standings.find((e) => e.rank != null)?.rank ?? null;
  return (
    <div className="summary">
      <h3 className="summary-h summary-h--row"><span>{final ? "Final standings" : "Standings so far"}</span>{headRight}</h3>
      <ol className="standings">
        {standings.map((e) => (
          <li key={e.id} className={`standing${e.rank != null && e.rank === leader ? " standing--leader" : ""}${e.id === playerId ? " standing--me" : ""}`}>
            <span className="standing-rank">{e.rank ?? "–"}</span>
            <span className="standing-name"><Swatch color={e.color} />{e.name}{awayTag(e)}{e.id === playerId ? " (you)" : ""}</span>
            <span className="standing-wins">{e.wins} {e.wins === 1 ? "win" : "wins"}</span>
            <span className="standing-avg muted small">{e.avgTries != null ? `${e.avgTries.toFixed(1)} avg` : "–"}</span>
          </li>
        ))}
      </ol>

      <h3 className="summary-h">Awards</h3>
      {awards.length === 0 ? (
        <p className="muted small">No awards yet — they appear once rounds have been played.</p>
      ) : (
        <ul className="awards">
          {awards.map((a) => (
            <li key={a.key} className="award">
              <span className="award-title">{a.title}</span>
              <span className="award-line">
                <span className="award-who">
                  {a.winners.map((w, i) => (
                    <span key={w.id} className="award-name"><Swatch color={w.color} />{w.name}{i < a.winners.length - 1 ? "," : ""}</span>
                  ))}
                </span>
                <span className="award-value">
                  {a.guess ? <><span className="award-guess">{a.guess}</span> </> : null}{a.value}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="summary-stats small">
        <span><strong>{roundsPlayed}</strong> {roundsPlayed === 1 ? "round" : "rounds"} played</span>
        <span><strong>{totalGuesses}</strong> {totalGuesses === 1 ? "guess" : "guesses"} in total</span>
      </p>
    </div>
  );
}

function useSummary(code, cred, refreshKey) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    fetchSummary(code, cred).then((d) => { if (alive) setSummary(d); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [code, cred, refreshKey]);
  return { summary, error };
}

// "Summary so far", opened from the scoreboard during the game.
export function SummaryDialog({ code, cred, playerId, onClose }) {
  const { summary, error } = useSummary(code, cred, 0);
  return (
    <Modal title="Summary so far" titleId="summary-title" onClose={onClose} className="modal--summary">
      {error ? <p className="error" role="alert">{error}</p>
        : !summary ? <p className="muted" role="status">Working out the awards…</p>
        : <SummaryBody summary={summary} playerId={playerId} final={summary.gameOver} />}
    </Modal>
  );
}

export function SummaryButton({ onClick }) {
  return <button type="button" className="secondary summary-open" onClick={onClick}>Summary so far</button>;
}

// The end-of-night screen everyone sees once the game has been ended.
// `rounds` (the Rounds table with replays) is shown on request, below the card.
export function GameOverScreen({ code, cred, playerId, rounds }) {
  const { summary, error } = useSummary(code, cred, 0);
  const [showRounds, setShowRounds] = useState(false);
  return (
    <section className="gameover" aria-labelledby="gameover-title">
      <div className="gameover-card">
        <div className="gameover-head">
          <div className="gameover-sound"><SoundSettings /></div>
          <div className="gameover-title-row">
            <span className="brand-pegs" aria-hidden="true">
              <span className="peg star">★</span>
              <span className="peg dot" />
              <span className="peg star">★</span>
            </span>
            <h1 id="gameover-title">Game over</h1>
          </div>
        </div>
        {error ? <p className="error" role="alert">{error}</p>
          : !summary ? <p className="muted" role="status">Working out the awards…</p>
          : <SummaryBody summary={summary} playerId={playerId} final headRight={<span className="summary-code">Stars &amp; Dots · game {code}</span>} />}
        <div className="gameover-actions">
          <Link href="/" className="button-link">Start a new game</Link>
          <button type="button" className="secondary" aria-expanded={showRounds} onClick={() => setShowRounds(!showRounds)}>
            {showRounds ? "Hide rounds" : "Rounds & replays"}
          </button>
        </div>
      </div>
      {showRounds && (
        <div className="gameover-rounds">
          <h2>Rounds</h2>
          {rounds}
        </div>
      )}
    </section>
  );
}

// ---- Ending the game ---------------------------------------------------------------------
export function EndGameControl({ code, cred, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true); setError("");
    try { await post("/api/endgame", { code }, cred); setConfirming(false); await onDone(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  if (!confirming) {
    return <button type="button" className="secondary" onClick={() => setConfirming(true)}>End game</button>;
  }
  return (
    <div className="confirm-box" role="group" aria-label="End the game?">
      <p className="small">End the game for everyone? No more rounds can be played.</p>
      <div className="confirm-actions">
        <button type="button" className="secondary" onClick={confirm} disabled={busy}>Yes, end game</button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// ---- Duel ------------------------------------------------------------------------------
export function DuelReveal({ state, playerId, opp }) {
  const numbers = state.duel.numbers;
  if (!numbers) return null;
  const mine = state.players.find((p) => p.id === playerId);
  return (
    <div className="duel-reveal">
      {[mine, opp].filter(Boolean).map((p) => (
        <div key={p.id} className="replay-number">
          <div className="replay-number-label small">
            {p.id === playerId ? <><Swatch color={p.color} />Your number</> : <Who p={p} suffix="'s number" />}
          </div>
          {numbers[p.id] ? <DigitTiles value={numbers[p.id]} /> : <span className="muted small">Not picked</span>}
        </div>
      ))}
    </div>
  );
}

// The duel's version of the round banner: what's happening now and whose move it is.
export function DuelBanner({ state, playerId, view, onNextRound, nextRoundBusy, onOpenReplay }) {
  const { opp, oppName } = view;
  const { roundState } = state;
  const banner = (cls, icon, body) => (
    <div className={`turn-banner ${cls}`} role="status">
      <span className="turn-banner-icon" aria-hidden="true">{icon}</span>
      <span>{body}</span>
    </div>
  );

  if (!opp) return banner("turn-banner--waiting", "⏳", <>Waiting for an opponent to join. Share the code <strong>{state.code}</strong>.</>);
  const away = view.away ? banner("turn-banner--waiting", "⏳", `${oppName} left the duel. Waiting for them to come back.`) : null;

  if (roundState === "pending") {
    if (away) return away;
    if (!view.myPicked) {
      return (
        <>
          {view.oppPicked && <p className="small banner-note">{oppName} has picked their number.</p>}
          {banner("turn-banner--mine", "✎", "Pick your secret number to start this round.")}
        </>
      );
    }
    return banner("turn-banner--waiting", "⏳", `Waiting for ${oppName} to pick their number…`);
  }

  if (roundState === "ended") {
    const w = state.winner;
    let text;
    let cls = "turn-banner--over";
    let icon = "●";
    if (w) {
      const iWon = w.id === playerId;
      cls = iWon ? "turn-banner--won" : "turn-banner--over";
      icon = iWon ? "★" : "●";
      text = iWon ? `You won this round in ${w.tries} ${w.tries === 1 ? "try" : "tries"}!` : `${w.name} won this round in ${w.tries} ${w.tries === 1 ? "try" : "tries"}.`;
    } else if (state.draw) {
      text = "It's a draw — you both cracked it.";
    } else {
      text = "The round ended with no winner.";
    }
    return (
      <>
        <div className={`turn-banner ${cls}`} role="status">
          <span className="turn-banner-icon" aria-hidden="true">{icon}</span>
          <span>
            {text}
            <br />
            <span className="banner-actions">
              <button type="button" className="secondary banner-action" onClick={onNextRound} disabled={nextRoundBusy || view.away}>Next round</button>
              <button type="button" className="secondary banner-action" onClick={() => onOpenReplay(state.round)}>View replay</button>
            </span>
          </span>
        </div>
        {away}
        <DuelReveal state={state} playerId={playerId} opp={opp} />
      </>
    );
  }

  // active
  if (away) return away;
  if (view.myTurn) {
    return banner("turn-banner--mine", "▶", view.finalTurn
      ? `Final turn! ${oppName} cracked your number — crack theirs to draw.`
      : `Your turn — guess ${oppName}'s number!`);
  }
  if (state.duel.crackedBy === playerId) {
    return banner("turn-banner--waiting", "★", `You cracked ${oppName}'s number! ${oppName} gets one final turn.`);
  }
  return banner("turn-banner--waiting", "⏳", `Waiting for ${oppName}…`);
}

// Both guess lists, clearly labeled: mine at their number, theirs at mine.
export function DuelGuessLists({ mine, opp, digitNotes }) {
  const list = (p, notes) => {
    const rows = [...(p ? p.history : [])].map((h, i) => ({ ...h, tryNum: i + 1 })).sort((a, b) => b.at - a.at);
    if (rows.length === 0) return <p className="muted small">No guesses yet.</p>;
    return (
      <ul className="guess-feed">
        {rows.map((g, i) => (
          <li key={g.at} className="guess-feed-item">
            <div className="guess-feed-head">
              <span className="guess-feed-try small muted">Try {g.tryNum}</span>
            </div>
            <DuelRow g={g} fresh={i === 0} digitNotes={notes} />
          </li>
        ))}
      </ul>
    );
  };
  return (
    <>
      {mine && (
        <div className="duel-list">
          <h3 className="duel-list-h"><Swatch color={mine.color} /><span>{opp ? "Your guesses at " : "Your guesses"}</span>{opp ? <Who p={opp} suffix="'s number" /> : null}</h3>
          {list(mine, digitNotes)}
        </div>
      )}
      {opp && (
        <div className="duel-list">
          <h3 className="duel-list-h"><Who p={opp} suffix="'s guesses at " /><span>your number</span></h3>
          {list(opp, null)}
        </div>
      )}
    </>
  );
}

function DuelRow({ g, fresh, digitNotes }) {
  return (
    <div className={`row${fresh ? " fresh" : ""}`}>
      <span className="tiles">
        {g.guess.split("").map((d, i) => {
          const mark = digitNotes?.[d];
          return <span key={i} className={`tile${mark ? ` tile--${mark}` : ""}`}>{d}</span>;
        })}
      </span>
      <Pegs stars={g.stars} dots={g.dots} total={g.guess.length} />
    </div>
  );
}

// Duel controls: End round, End game and Leave game, in a section that opens
// and closes (same look and remembered state as the host controls).
export function DuelControls({ state, endRound, endGame, leave }) {
  const [open, setOpen] = useState(() => loadFlag("sd:hostctl-open", false));
  const active = state.roundState === "active";
  const current = state.players.find((p) => p.id === state.currentPlayerId && !p.removed);
  const summary = active ? (current ? `${current.name}'s turn` : "Waiting") : state.roundState === "pending" ? "Picking numbers" : "Round over";
  const toggle = useCallback(() => {
    setOpen((o) => { saveFlag("sd:hostctl-open", !o); return !o; });
  }, []);
  return (
    <div className="hostctl">
      <button type="button" className="secondary hostctl-head" aria-expanded={open} aria-controls="hostctl-body" onClick={toggle}>
        <span className="hostctl-title">Duel controls</span>
        <span className="hostctl-summary">{active && current ? <><span aria-hidden="true">▶ </span>{summary}</> : summary}</span>
        <span className="hostctl-chevron" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="hostctl-body" id="hostctl-body">
          {active && endRound}
          {endGame}
          {leave}
        </div>
      )}
    </div>
  );
}
