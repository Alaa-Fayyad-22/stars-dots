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
