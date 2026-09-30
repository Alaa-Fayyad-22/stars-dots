import { useEffect, useRef } from "react";
import { digitsOnly, isValidNumber, pinOnly, describePegs, awayTag } from "@/lib/client";

// A guess shown as N tiles with star/dot pegs next to it. `digitNotes` (from
// the digit notepad) optionally fades/highlights individual digits — it
// never changes the pegs.
export function Pegs({ stars, dots, total }) {
  const pegs = [];
  for (let i = 0; i < total; i++) {
    if (i < stars) pegs.push(<span key={i} className="peg star">★</span>);
    else if (i < stars + dots) pegs.push(<span key={i} className="peg dot" />);
    else pegs.push(<span key={i} className="peg empty" />);
  }
  return (
    <span className="pegs" aria-label={`${stars} stars, ${dots} dots`}>
      {pegs}
    </span>
  );
}

export function GuessRow({ guess, stars, dots, num, big, fresh, digitNotes }) {
  return (
    <div className={`row${big ? " big" : ""}${fresh ? " fresh" : ""}`}>
      {num != null && <span className="try-num">{num}</span>}
      <span className="tiles">
        {guess.split("").map((d, i) => {
          const mark = digitNotes?.[d];
          return (
            <span key={i} className={`tile${mark ? ` tile--${mark}` : ""}`}>
              {d}
            </span>
          );
        })}
      </span>
      {stars != null && <Pegs stars={stars} dots={dots} total={guess.length} />}
    </div>
  );
}

export function Legend() {
  return (
    <p className="legend muted">
      <span><span className="peg star">★</span> right digit, right place</span>
      <span><span className="peg dot" /> right digit, wrong place</span>
    </p>
  );
}

// Text input for the secret / a guess. Both typing and pasting go through
// digitsOnly so repeats and a leading 0 never make it into the value.
export function DigitEntry({ id, label, value, onChange, disabled, mask, autoFocus, onEnter, help, digits = 4, guard }) {
  return (
    <div className="digit-entry" data-guard={guard}>
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        className="digits-input"
        inputMode="numeric"
        autoComplete="off"
        type={mask ? "password" : "text"}
        placeholder={Array(digits).fill("⋯").join(" ")}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(digitsOnly(e.target.value, digits))}
        onKeyDown={(e) => e.key === "Enter" && onEnter && onEnter()}
      />
      {help && <p className="small muted digit-entry-help">{help}</p>}
    </div>
  );
}

// A 4-digit PIN input. Unlike the secret/guess, a PIN has no digit rules —
// repeats and a leading 0 are both fine.
export function PinEntry({ id, label, value, onChange, help, onEnter, autoFocus }) {
  return (
    <div className="digit-entry">
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        className="digits-input pin-input"
        inputMode="numeric"
        autoComplete="off"
        type="password"
        placeholder="⋯ ⋯ ⋯ ⋯"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(pinOnly(e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && onEnter && onEnter()}
      />
      {help && <p className="small muted digit-entry-help">{help}</p>}
    </div>
  );
}

// Hand-picked example secret/guess pairs, one per supported digit count,
// each chosen to show a star, a dot, and a miss.
const EXAMPLES = {
  3: { secret: "394", guess: "342" },
  4: { secret: "3184", guess: "3421" },
  5: { secret: "31846", guess: "34219" },
};

function classifyExample(secret, guess) {
  const stars = [], dots = [], misses = [];
  for (let i = 0; i < guess.length; i++) {
    const g = guess[i];
    if (secret[i] === g) stars.push(g);
    else if (secret.includes(g)) dots.push(g);
    else misses.push(g);
  }
  return { stars, dots, misses };
}

// A short, worked "how to play" explanation for people who've never played.
export function HowToPlay({ digits = 4 }) {
  const { secret, guess } = EXAMPLES[digits] || EXAMPLES[4];
  const result = classifyExample(secret, guess);
  const allStars = "★".repeat(digits);
  return (
    <div className="how-to-play">
      <ol className="how-steps">
        <li>One person hosts and secretly picks a {digits}-digit number — {digits} different digits, not starting with 0, like <strong>{secret}</strong>. In a rotating game, hosting goes around so everyone gets a turn, in the order players joined.</li>
        <li>Everyone else takes turns guessing {digits}-digit numbers (same rule: no repeats, no leading 0).</li>
        <li>Every guess gets stars and dots: a <strong>★ star</strong> for each digit in the exact right spot, a <strong>● dot</strong> for each digit that's correct but in the wrong spot.</li>
        <li>First to guess all {digits} in the right spot ({allStars}) wins the round.</li>
      </ol>
      <div className="example">
        <div className="example-label small muted">Example — the secret is {secret}, you guess:</div>
        <GuessRow guess={guess} stars={result.stars.length} dots={result.dots.length} big />
        <ul className="example-breakdown small muted">
          {result.stars.map((d) => (
            <li key={`s${d}`}><span className="peg star">★</span> <strong>{d}</strong> is in the right place.</li>
          ))}
          {result.dots.length > 0 && (
            <li><span className="peg dot" /> <strong>{result.dots.join(" and ")}</strong> {result.dots.length > 1 ? "are" : "is"} in the secret, just the wrong spot.</li>
          )}
          {result.misses.length > 0 && (
            <li><span className="peg empty" /> <strong>{result.misses.join(" and ")}</strong> {result.misses.length > 1 ? "aren't" : "isn't"} in the secret at all.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

// The choice between game modes, made once when creating a game.
export function ModeChoice({ value, onChange }) {
  return (
    <div className="mode-choice" role="radiogroup" aria-label="Game mode">
      <button
        type="button"
        className={`mode-card${value === "rotating" ? " mode-card--selected" : ""}`}
        aria-pressed={value === "rotating"}
        onClick={() => onChange("rotating")}
      >
        <div className="mode-card-title">Rotating host</div>
        <div className="mode-card-desc small muted">Hosting rotates through everyone, in the order they joined. Each round, the next player picks the number.</div>
      </button>
      <button
        type="button"
        className={`mode-card${value === "computer" ? " mode-card--selected" : ""}`}
        aria-pressed={value === "computer"}
        onClick={() => onChange("computer")}
      >
        <div className="mode-card-title">Computer host</div>
        <div className="mode-card-desc small muted">The game picks the number. Everyone plays every round — no one sits out.</div>
      </button>
    </div>
  );
}

// The choice between 3, 4, or 5 digits, made once when creating a game.
export function DigitsChoice({ value, onChange }) {
  return (
    <div className="digits-choice" role="radiogroup" aria-label="Number of digits">
      {[3, 4, 5].map((d) => (
        <button
          key={d}
          type="button"
          className={`digits-pill${value === d ? " digits-pill--selected" : ""}`}
          aria-pressed={value === d}
          onClick={() => onChange(d)}
        >
          {d} digits
        </button>
      ))}
    </div>
  );
}

// The single most important thing on the game screen: what's happening
// right now, and whether it's my turn.
export function RoundBanner({ state, playerId, onNextRoundClick, nextRoundBusy }) {
  const {
    mode, roundState, winner, revealedSecret, isHost, hostName, isControlsHolder, controlsHolderName,
    currentPlayerId, me, players,
  } = state;
  const current = players.find((p) => p.id === currentPlayerId);
  const iAmCurrent = currentPlayerId === playerId;
  const nextName = mode === "rotating" ? hostName : null;

  // Mid-round, the rotating host can leave without ending the round: the
  // secret they picked stays hidden and in play, nobody takes it over, and
  // someone else just picks up the host controls. Every other player still
  // sees the normal turn banner below — this is just an FYI line above it.
  const hostlessNote = mode === "rotating" && roundState === "active" && !hostName && controlsHolderName ? (
    <p className="small muted hostless-note">
      The host left this round — play continues, and nobody holds the secret right now.
      {isControlsHolder ? " You're holding the host controls until the round ends." : ` ${controlsHolderName} is holding the host controls.`}
    </p>
  ) : null;

  if (roundState === "pending") {
    // Rotating mode moves straight from "active" to "pending" the instant a
    // round ends (hosting passes to the next player in the rotation), so this
    // is the only state where the just-finished round's outcome is ever visible —
    // winner/revealedSecret stay populated here until the new host picks a
    // number, at which point pickSecret() clears them.
    const justEnded = winner ? (
      <p className="small banner-note">
        {winner.id === playerId ? "You cracked it!" : `${winner.name} cracked it in ${winner.tries} ${winner.tries === 1 ? "try" : "tries"}.`}
        {revealedSecret ? ` The number was ${revealedSecret}.` : ""}
      </p>
    ) : revealedSecret ? (
      <p className="small banner-note">The round ended with no winner. The number was {revealedSecret}.</p>
    ) : null;

    if (isHost) {
      return (
        <>
          {justEnded}
          <div className="turn-banner turn-banner--mine" role="status">
            <span className="turn-banner-icon" aria-hidden="true">✎</span>
            <span>It's your turn to host — pick a number to start this round.</span>
          </div>
        </>
      );
    }
    return (
      <>
        {justEnded}
        <div className="turn-banner turn-banner--waiting" role="status">
          <span className="turn-banner-icon" aria-hidden="true">⏳</span>
          <span>Waiting for {hostName || "the host"} to pick the number…</span>
        </div>
      </>
    );
  }

  if (roundState === "ended") {
    const revealText = revealedSecret ? `The number was ${revealedSecret}.` : "";
    const nextStep = mode === "computer"
      ? <button type="button" className="secondary banner-action" onClick={onNextRoundClick} disabled={nextRoundBusy}>Next round</button>
      : isHost
        ? <span className="banner-note small">Pick a number to start the next round.</span>
        : <span className="banner-note small">Waiting for {nextName || "the next host"} to start the next round.</span>;

    if (winner) {
      const iWon = winner.id === playerId;
      return (
        <div className={`turn-banner ${iWon ? "turn-banner--won" : "turn-banner--over"}`} role="status">
          <span className="turn-banner-icon" aria-hidden="true">{iWon ? "★" : "●"}</span>
          <span>
            {iWon ? "You cracked it!" : `${winner.name} cracked it in ${winner.tries} ${winner.tries === 1 ? "try" : "tries"}.`} {revealText}
            <br />{nextStep}
          </span>
        </div>
      );
    }
    return (
      <div className="turn-banner turn-banner--over" role="status">
        <span className="turn-banner-icon" aria-hidden="true">●</span>
        <span>The round ended with no winner. {revealText}<br />{nextStep}</span>
      </div>
    );
  }

  // active
  if (mode === "rotating" && isHost) {
    return (
      <div className="turn-banner turn-banner--waiting" role="status">
        <span className="turn-banner-icon" aria-hidden="true">👀</span>
        <span>You're hosting this round — sit back and watch the guesses come in.</span>
      </div>
    );
  }
  if (me?.solved) {
    return (
      <>
        {hostlessNote}
        <div className="turn-banner turn-banner--waiting" role="status">
          <span className="turn-banner-icon" aria-hidden="true">★</span>
          <span>You already found it. Waiting for the round to end.</span>
        </div>
      </>
    );
  }
  if (iAmCurrent) {
    return (
      <>
        {hostlessNote}
        <div className="turn-banner turn-banner--mine" role="status">
          <span className="turn-banner-icon" aria-hidden="true">▶</span>
          <span>Your turn — take a guess!</span>
        </div>
      </>
    );
  }
  return (
    <>
      {hostlessNote}
      <div className="turn-banner turn-banner--waiting" role="status">
        <span className="turn-banner-icon" aria-hidden="true">⏳</span>
        <span>Waiting for {current?.name || "the next player"}…</span>
      </div>
    </>
  );
}

// The scoreboard: wins and average tries per player, across every round in
// this game. Visible to everyone, most useful between rounds.
export function Scoreboard({ scoreboard, playerId }) {
  if (!scoreboard || scoreboard.length === 0) return null;
  const leaderRank = scoreboard.find((e) => e.rank != null)?.rank ?? null;
  return (
    <div className="scoreboard">
      <table className="scoreboard-table">
        <thead>
          <tr>
            <th className="scoreboard-rank">#</th>
            <th>Player</th>
            <th className="scoreboard-num">Wins</th>
            <th className="scoreboard-num">Avg tries</th>
          </tr>
        </thead>
        <tbody>
          {scoreboard.map((e) => (
            <tr
              key={e.id}
              className={[
                e.id === playerId ? "scoreboard-row--me" : "",
                e.rank != null && e.rank === leaderRank ? "scoreboard-row--leader" : "",
              ].filter(Boolean).join(" ")}
            >
              <td className="scoreboard-rank">{e.rank ?? "–"}</td>
              <td className="scoreboard-name">
                {e.name}{awayTag(e)}{e.id === playerId ? " (you)" : ""}
              </td>
              <td className="scoreboard-num">{e.wins}</td>
              <td className="scoreboard-num">{e.avgTries != null ? e.avgTries.toFixed(1) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One row per finished round: who won, what the number was, and how many
// guesses everyone made in total. Newest round first.
export function RoundHistory({ rounds }) {
  if (!rounds || rounds.length === 0) return null;
  return (
    <div className="scoreboard">
      <table className="scoreboard-table">
        <thead>
          <tr>
            <th className="scoreboard-rank">Round</th>
            <th>Winner</th>
            <th className="scoreboard-num">Number</th>
            <th className="scoreboard-num">Total tries</th>
          </tr>
        </thead>
        <tbody>
          {[...rounds].reverse().map((r) => (
            <tr key={r.round}>
              <td className="scoreboard-rank">{r.round}</td>
              <td className="scoreboard-name">{r.winnerName || "No winner"}</td>
              <td className="scoreboard-num">{r.secret}</td>
              <td className="scoreboard-num">{r.totalTries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A warning shown as soon as the player types a number someone has already
// guessed this round — before they even try to submit it.
export function DuplicateWarning({ dup }) {
  if (!dup) return null;
  return (
    <p className="error" role="alert">
      {dup.name} already tried this: {describePegs(dup.stars, dup.dots)}
    </p>
  );
}

// Every guess from every player, newest first, in one list. Used by both the
// player view (own guesses labeled "You" and colored) and the host view
// (nobody is "mine" there, so playerId is just omitted).
export function GuessFeed({ players, playerId, digitNotes }) {
  const all = [];
  for (const p of players) {
    p.history.forEach((h, i) => {
      all.push({
        key: `${p.id}-${h.at}`,
        playerId: p.id,
        name: p.name,
        tag: awayTag(p),
        tryNum: i + 1,
        guess: h.guess,
        stars: h.stars,
        dots: h.dots,
        at: h.at,
      });
    });
  }
  all.sort((a, b) => b.at - a.at);

  if (all.length === 0) {
    return <p className="muted">Guesses will show up here as players take their turns.</p>;
  }

  return (
    <ul className="guess-feed">
      {all.map((g, i) => {
        const mine = g.playerId === playerId;
        return (
          <li key={g.key} className="guess-feed-item">
            <div className="guess-feed-head">
              <span className={`guess-feed-name${mine ? " guess-feed-name--mine" : ""}`} title={g.name}>
                {mine ? "You" : g.name}{g.tag}
              </span>
              <span className="guess-feed-try small muted">Try {g.tryNum}</span>
            </div>
            <GuessRow guess={g.guess} stars={g.stars} dots={g.dots} fresh={i === 0} digitNotes={digitNotes} />
          </li>
        );
      })}
    </ul>
  );
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

function markSymbol(state) {
  return state === "cross" ? "✕" : state === "sure" ? "✓" : "";
}

function markStateLabel(state) {
  return state === "cross" ? "marked not in the number" : state === "sure" ? "marked definitely in the number" : "not marked";
}

// Private, manual note-taking for players only: a digit notepad. Nothing
// here ever computes or suggests an answer — every mark is a plain tap the
// player makes themselves.
export function PlayerNotes({ notes, onToggleDigit, onClear }) {
  return (
    <div className="notes">
      <div className="notes-head">
        <h3>Your notes</h3>
        <button type="button" className="secondary notes-clear" onClick={onClear}>Clear notes</button>
      </div>
      <p className="small muted notes-hint">Private to you — tap a digit to mark it.</p>

      <div className="notepad-digits" role="group" aria-label="Digit notes">
        {DIGITS.map((d) => {
          const state = notes.digits[d];
          return (
            <button
              key={d}
              type="button"
              className={`notepad-digit${state ? ` notepad-digit--${state}` : ""}`}
              onClick={() => onToggleDigit(d)}
              aria-label={`Digit ${d}, ${markStateLabel(state)}`}
            >
              <span className="notepad-digit-num">{d}</span>
              {state && <span className="notepad-digit-mark" aria-hidden="true">{markSymbol(state)}</span>}
            </button>
          );
        })}
      </div>
      <p className="legend muted notepad-legend">
        <span>✕ not in the number</span>
        <span>✓ definitely in the number</span>
      </p>
    </div>
  );
}

// A compact, single-line version of the digit notepad for the scratch
// sheet. Same notes state as the main notepad — marks made here show up
// there and vice versa.
function CompactNotepad({ notes, onToggleDigit }) {
  return (
    <div className="sheet-notepad" role="group" aria-label="Digit notes">
      {DIGITS.map((d) => {
        const state = notes.digits[d];
        return (
          <button
            key={d}
            type="button"
            className={`sheet-notepad-digit${state ? ` sheet-notepad-digit--${state}` : ""}`}
            onClick={() => onToggleDigit(d)}
            aria-label={`Digit ${d}, ${markStateLabel(state)}`}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

// The N-box "draft number" scratchpad, reused by both the main player view
// and the scratch sheet. It's a memory aid only: it never validates while
// editing, and never computes or suggests an answer.
export function DraftBoxes({ draft, digits = 4, digitNotes, onChangeDraft, onClearDraft, onUseAsGuess, idPrefix = "draft", compact, onSubmitGuess, submitDisabled, submitBusy, submitMessage }) {
  const refs = useRef([]);
  const valid = draft.every(Boolean) && isValidNumber(draft.join(""), digits);

  function commit(index, char) {
    const next = [...draft];
    next[index] = char;
    onChangeDraft(next);
  }

  function handleChange(index, e) {
    const digitsIn = e.target.value.replace(/\D/g, "");
    const char = digitsIn.slice(-1) || "";
    commit(index, char);
    if (char && index < digits - 1) refs.current[index + 1]?.focus();
  }

  function handleKeyDown(index, e) {
    if (e.key === "Backspace" && !draft[index] && index > 0) {
      e.preventDefault();
      refs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text") || "";
    const chars = text.replace(/\D/g, "").slice(0, digits).split("");
    if (!chars.length) return;
    const next = Array(digits).fill("");
    chars.forEach((c, i) => { next[i] = c; });
    onChangeDraft(next);
    refs.current[Math.min(chars.length, digits - 1)]?.focus();
  }

  return (
    <div className={`draft-boxes-wrap${compact ? " draft-boxes-wrap--compact" : ""}`} data-guard="draft">
      <div className="draft-boxes" role="group" aria-label="Draft number">
        {draft.map((val, i) => {
          const faded = !!val && digitNotes?.[val] === "cross";
          return (
            <input
              key={i}
              ref={(el) => { refs.current[i] = el; }}
              id={`${idPrefix}-${i}`}
              className={`draft-box${compact ? " draft-box--compact" : ""}${faded ? " draft-box--faded" : ""}`}
              inputMode="numeric"
              autoComplete="off"
              maxLength={1}
              value={val}
              onFocus={(e) => e.target.select()}
              onChange={(e) => handleChange(i, e)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              aria-label={`Position ${i + 1}`}
            />
          );
        })}
      </div>
      <div className="draft-actions">
        <button type="button" className="secondary draft-clear" onClick={onClearDraft}>Clear draft</button>
        {valid && (
          <button type="button" className="secondary draft-use" onClick={() => onUseAsGuess(draft.join(""))}>
            Use as guess
          </button>
        )}
        {onSubmitGuess && (
          <button type="button" className="secondary draft-submit" data-guard="submit" onClick={onSubmitGuess} disabled={submitDisabled || submitBusy}>
            {submitBusy ? "Submitting…" : "Submit guess"}
          </button>
        )}
      </div>
      {onSubmitGuess && submitMessage && (
        <p className="error small draft-submit-message" role="alert">{submitMessage}</p>
      )}
    </div>
  );
}

// A dense, paper-styled dialog: every guess from every player in one
// scannable table, the same digit notepad, and the draft pinned at the
// bottom. It only ever displays existing state and the player's own notes —
// nothing here computes or reveals anything about the secret.
export function ScratchSheet({
  open, onClose, players, playerId, notes, digits = 4, onToggleDigit, onChangeDraft, onClearDraft, onUseAsGuess,
  onSubmitGuess, submitDisabled, submitBusy, submitMessage, turnStatus, overlay, headerExtra, topToast,
}) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const listRef = useRef(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  // Lock the page behind the sheet so only the sheet's own guess list
  // scrolls. `overflow: hidden` on body isn't enough on iOS Safari, which
  // still allows the page to scroll/bounce underneath a fixed overlay — so
  // instead we pin the body in place at its current scroll offset and
  // restore the real scroll position when the sheet closes (in any way:
  // the close button, Escape, "Use as guess", or this component unmounting,
  // since all of those end up flipping `open` to false or unmounting, and
  // the effect cleanup below always runs either way).
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const { body } = document;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };
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

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handleCancel = (e) => { e.preventDefault(); onClose(); };
    const handleClose = () => onClose();
    dlg.addEventListener("cancel", handleCancel);
    dlg.addEventListener("close", handleClose);
    return () => {
      dlg.removeEventListener("cancel", handleCancel);
      dlg.removeEventListener("close", handleClose);
    };
  }, [onClose]);

  useEffect(() => {
    if (open) {
      pinnedRef.current = true;
      closeRef.current?.focus();
    }
  }, [open]);

  const all = [];
  for (const p of players) {
    p.history.forEach((h, i) => {
      all.push({ key: `${p.id}-${h.at}`, playerId: p.id, name: p.name, tag: awayTag(p), tryNum: i + 1, guess: h.guess, stars: h.stars, dots: h.dots, at: h.at });
    });
  }
  all.sort((a, b) => a.at - b.at);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [open, all.length]);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
  }

  return (
    <dialog ref={dialogRef} className="sheet">
      <div className="sheet-head">
        <div className="sheet-head-text">
          <h2>Scratch sheet</h2>
          {turnStatus && (
            <p className={`sheet-status${turnStatus.mine ? " sheet-status--mine" : ""}`} role="status">{turnStatus.text}</p>
          )}
        </div>
        <div className="sheet-head-actions">
          {headerExtra}
          <button type="button" ref={closeRef} className="secondary sheet-close" onClick={onClose} aria-label="Close scratch sheet">✕</button>
        </div>
        {overlay}
        {topToast}
      </div>

      <CompactNotepad notes={notes} onToggleDigit={onToggleDigit} />

      <div className="sheet-list" ref={listRef} onScroll={handleScroll}>
        {all.length === 0 ? (
          <p className="muted small">No guesses yet.</p>
        ) : (
          all.map((g, i) => {
            const mine = g.playerId === playerId;
            const noPegs = g.stars === 0 && g.dots === 0;
            return (
              <div key={g.key} className="sheet-row">
                <span className="sheet-col sheet-num">{i + 1}</span>
                <span className="sheet-col sheet-name" title={g.name}>{mine ? "You" : g.name}{g.tag}</span>
                <span className="sheet-col sheet-digits">
                  {g.guess.split("").map((ch, di) => {
                    const mark = notes.digits[ch];
                    return (
                      <span key={di} className={`sheet-digit-cell${mark ? ` sheet-digit-cell--${mark}` : ""}`}>{ch}</span>
                    );
                  })}
                </span>
                <span className="sheet-col sheet-result">
                  {noPegs ? (
                    <span className="sheet-dash">–</span>
                  ) : (
                    <>
                      {Array.from({ length: g.stars }).map((_, si) => (
                        <span key={`s${si}`} className="sheet-star">★</span>
                      ))}
                      {Array.from({ length: g.dots }).map((_, di) => (
                        <span key={`d${di}`} className="sheet-dot">●</span>
                      ))}
                    </>
                  )}
                </span>
              </div>
            );
          })
        )}
        <div className="sheet-draft">
          <div className="sheet-row sheet-draft-row">
            <span className="sheet-col sheet-num" aria-hidden="true" />
            <span className="sheet-col sheet-name">My draft</span>
            <DraftBoxes
              draft={notes.draft}
              digits={digits}
              digitNotes={notes.digits}
              onChangeDraft={onChangeDraft}
              onClearDraft={onClearDraft}
              onUseAsGuess={onUseAsGuess}
              idPrefix="sheet-draft"
              compact
              onSubmitGuess={onSubmitGuess}
              submitDisabled={submitDisabled}
              submitBusy={submitBusy}
              submitMessage={submitMessage}
            />
          </div>
        </div>
      </div>
    </dialog>
  );
}
