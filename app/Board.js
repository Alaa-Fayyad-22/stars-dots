import { useEffect, useRef } from "react";
import { digitsOnly, isValidNumber } from "@/lib/client";

// A guess shown as 4 tiles with star/dot pegs next to it. `digitNotes` (from
// the digit notepad) optionally fades/highlights individual digits — it
// never changes the pegs.
export function Pegs({ stars, dots }) {
  const pegs = [];
  for (let i = 0; i < 4; i++) {
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
      {stars != null && <Pegs stars={stars} dots={dots} />}
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
export function DigitEntry({ id, label, value, onChange, disabled, mask, autoFocus, onEnter, help }) {
  return (
    <div className="digit-entry">
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        className="digits-input"
        inputMode="numeric"
        autoComplete="off"
        type={mask ? "password" : "text"}
        placeholder="⋯ ⋯ ⋯ ⋯"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(digitsOnly(e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && onEnter && onEnter()}
      />
      {help && <p className="small muted digit-entry-help">{help}</p>}
    </div>
  );
}

// A short, worked "how to play" explanation for people who've never played.
export function HowToPlay() {
  return (
    <div className="how-to-play">
      <ol className="how-steps">
        <li>One person hosts and secretly picks a 4-digit number — 4 different digits, not starting with 0, like <strong>3184</strong>.</li>
        <li>Everyone else takes turns guessing 4-digit numbers (same rule: no repeats, no leading 0).</li>
        <li>Every guess gets stars and dots: a <strong>★ star</strong> for each digit in the exact right spot, a <strong>● dot</strong> for each digit that's correct but in the wrong spot.</li>
        <li>First to guess all 4 in the right spot (★★★★) wins the round.</li>
      </ol>
      <div className="example">
        <div className="example-label small muted">Example — the secret is 3184, you guess:</div>
        <GuessRow guess="3421" stars={1} dots={2} big />
        <ul className="example-breakdown small muted">
          <li><span className="peg star">★</span> <strong>3</strong> is in the right place.</li>
          <li><span className="peg dot" /> <strong>4</strong> and <strong>1</strong> are in the secret, just the wrong spot.</li>
          <li><span className="peg empty" /> <strong>2</strong> isn't in the secret at all.</li>
        </ul>
      </div>
    </div>
  );
}

// The single most important thing on the game screen: whose turn it is.
export function TurnBanner({ myTurn, waitingFor, winner, iWon, solved, hostName }) {
  if (winner) {
    return (
      <div className={`turn-banner ${iWon ? "turn-banner--won" : "turn-banner--over"}`} role="status">
        <span className="turn-banner-icon" aria-hidden="true">{iWon ? "★" : "●"}</span>
        <span>{iWon ? "You cracked it!" : `${winner.name} cracked it.`} Wait for {hostName} to start a new round.</span>
      </div>
    );
  }
  if (solved) {
    return (
      <div className="turn-banner turn-banner--waiting" role="status">
        <span className="turn-banner-icon" aria-hidden="true">★</span>
        <span>You already found it. Waiting for the round to end.</span>
      </div>
    );
  }
  if (myTurn) {
    return (
      <div className="turn-banner turn-banner--mine" role="status">
        <span className="turn-banner-icon" aria-hidden="true">▶</span>
        <span>Your turn — take a guess!</span>
      </div>
    );
  }
  return (
    <div className="turn-banner turn-banner--waiting" role="status">
      <span className="turn-banner-icon" aria-hidden="true">⏳</span>
      <span>Waiting for {waitingFor || "the next player"}…</span>
    </div>
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
                {mine ? "You" : g.name}
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
const EMPTY_DRAFT = ["", "", "", ""];

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

// The 4-box "draft number" scratchpad, reused by both the main player view
// and the scratch sheet. It's a memory aid only: it never validates while
// editing, and never computes or suggests an answer.
export function DraftBoxes({ draft, digitNotes, onChangeDraft, onClearDraft, onUseAsGuess, idPrefix = "draft", compact }) {
  const refs = useRef([]);
  const valid = draft.every(Boolean) && isValidNumber(draft.join(""));

  function commit(index, char) {
    const next = [...draft];
    next[index] = char;
    onChangeDraft(next);
  }

  function handleChange(index, e) {
    const digitsIn = e.target.value.replace(/\D/g, "");
    const char = digitsIn.slice(-1) || "";
    commit(index, char);
    if (char && index < 3) refs.current[index + 1]?.focus();
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
    const chars = text.replace(/\D/g, "").slice(0, 4).split("");
    if (!chars.length) return;
    const next = [...EMPTY_DRAFT];
    chars.forEach((c, i) => { next[i] = c; });
    onChangeDraft(next);
    refs.current[Math.min(chars.length, 3)]?.focus();
  }

  return (
    <div className={`draft-boxes-wrap${compact ? " draft-boxes-wrap--compact" : ""}`}>
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
      </div>
    </div>
  );
}

// A dense, paper-styled dialog: every guess from every player in one
// scannable table, the same digit notepad, and the draft pinned at the
// bottom. It only ever displays existing state and the player's own notes —
// nothing here computes or reveals anything about the secret.
export function ScratchSheet({ open, onClose, players, playerId, notes, onToggleDigit, onChangeDraft, onClearDraft, onUseAsGuess }) {
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
      all.push({ key: `${p.id}-${h.at}`, playerId: p.id, name: p.name, tryNum: i + 1, guess: h.guess, stars: h.stars, dots: h.dots, at: h.at });
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
        <h2>Scratch sheet</h2>
        <button type="button" ref={closeRef} className="secondary sheet-close" onClick={onClose} aria-label="Close scratch sheet">✕</button>
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
                <span className="sheet-col sheet-name" title={g.name}>{mine ? "You" : g.name}</span>
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
      </div>

      <div className="sheet-draft">
        <div className="sheet-row sheet-draft-row">
          <span className="sheet-col sheet-num" aria-hidden="true" />
          <span className="sheet-col sheet-name">My draft</span>
          <DraftBoxes
            draft={notes.draft}
            digitNotes={notes.digits}
            onChangeDraft={onChangeDraft}
            onClearDraft={onClearDraft}
            onUseAsGuess={onUseAsGuess}
            idPrefix="sheet-draft"
            compact
          />
        </div>
      </div>
    </dialog>
  );
}
