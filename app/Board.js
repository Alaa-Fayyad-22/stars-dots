import { digitsOnly } from "@/lib/client";

// A guess shown as 4 tiles with star/dot pegs next to it
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

export function GuessRow({ guess, stars, dots, num, big, fresh }) {
  return (
    <div className={`row${big ? " big" : ""}${fresh ? " fresh" : ""}`}>
      {num != null && <span className="try-num">{num}</span>}
      <span className="tiles">
        {guess.split("").map((d, i) => (
          <span key={i} className="tile">{d}</span>
        ))}
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

// Big-tap on-screen keypad. Digits already in `value` are disabled since a
// guess can never repeat a digit.
export function NumberPad({ value, onChange, disabled }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "gap", "0", "back"];
  return (
    <div className="numpad" role="group" aria-label="Digit keypad">
      {keys.map((key, i) => {
        if (key === "gap") return <span key={i} className="numpad-gap" aria-hidden="true" />;
        if (key === "back") {
          return (
            <button
              key={i}
              type="button"
              className="numpad-key numpad-back"
              disabled={disabled || !value.length}
              onClick={() => onChange(value.slice(0, -1))}
              aria-label="Delete last digit"
            >
              ⌫
            </button>
          );
        }
        const used = value.includes(key);
        return (
          <button
            key={i}
            type="button"
            className="numpad-key"
            disabled={disabled || used || value.length >= 4}
            onClick={() => onChange(digitsOnly(value + key))}
            aria-label={`Digit ${key}`}
          >
            {key}
          </button>
        );
      })}
    </div>
  );
}

// Text input (for typing/pasting on a real keyboard) paired with the on-screen
// keypad (for big, easy taps on a phone). Both write through digitsOnly so
// repeats never make it into the value.
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
      <NumberPad value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// A short, worked "how to play" explanation for people who've never played.
export function HowToPlay() {
  return (
    <div className="how-to-play">
      <ol className="how-steps">
        <li>One person hosts and secretly picks a 4-digit number — no repeated digits, like <strong>3184</strong>.</li>
        <li>Everyone else takes turns guessing 4-digit numbers (also no repeats).</li>
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
