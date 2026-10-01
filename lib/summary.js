// End-of-night summary: the awards, worked out from the saved round details.
// Pure functions (no database, no network) so they're easy to test; lib/game.js
// loads the data and calls these only when someone opens the summary.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Everyone who ties for the best value under `score` (higher is better).
function bestPlayers(byPlayer, score) {
  let best = -Infinity;
  for (const v of byPlayer.values()) best = Math.max(best, score(v));
  if (!(best > 0)) return { best: 0, ids: [] };
  return { best, ids: [...byPlayer.entries()].filter(([, v]) => score(v) === best).map(([id]) => id) };
}

// `details`  — saved round details (see lib/game.js buildRoundDetails)
// `scoreboard` — the same list the scoreboard shows: { id, wins, ... }
// `who(id)`  — { id, name, color } for a person
// Returns the awards in a fixed order; an award nobody can win is left out.
export function computeAwards({ details, scoreboard, mode, who }) {
  const awards = [];
  const person = (id) => who(id);
  const make = (key, title, ids, value, extra = {}) => ({ key, title, winners: ids.map(person), value, ...extra });

  const guesses = [];
  for (const d of details) {
    for (const g of d.guesses || []) guesses.push({ ...g, round: d.round, digits: d.digits });
  }

  // Fastest solve: the fewest tries anyone needed to win a round.
  const solves = new Map();
  for (const d of details) {
    for (const w of d.winners || []) {
      if (d.outcome !== "win") continue;
      const cur = solves.get(w.id);
      if (!cur || w.tries < cur.tries) solves.set(w.id, { tries: w.tries });
    }
  }
  if (solves.size) {
    const fewest = Math.min(...[...solves.values()].map((v) => v.tries));
    const ids = [...solves.entries()].filter(([, v]) => v.tries === fewest).map(([id]) => id);
    awards.push(make("fastest", "Fastest solve", ids, plural(fewest, "try", "tries")));
  }

  // Most wins: straight from the scoreboard, so it always agrees with the standings.
  const topWins = Math.max(0, ...scoreboard.map((e) => e.wins));
  if (topWins > 0) {
    awards.push(make("wins", "Most wins", scoreboard.filter((e) => e.wins === topWins).map((e) => e.id), plural(topWins, "win", "wins")));
  }

  // Closest miss: the guess with the most stars that didn't win; ties go to
  // more dots, then to the earlier guess. (A full-stars guess is a solve, not a miss.)
  let miss = null;
  for (const g of guesses) {
    if (g.stars >= g.digits) continue;
    if (
      !miss || g.stars > miss.stars ||
      (g.stars === miss.stars && (g.dots > miss.dots || (g.dots === miss.dots && g.at < miss.at)))
    ) miss = g;
  }
  if (miss && miss.stars + miss.dots > 0) {
    awards.push(make("closest", "Closest miss", [miss.playerId], `${"★".repeat(miss.stars)}${"●".repeat(miss.dots)}`, {
      guess: miss.guess, stars: miss.stars, dots: miss.dots, round: miss.round,
    }));
  }

  // Most dots in one guess.
  const dotsBy = new Map();
  for (const g of guesses) dotsBy.set(g.playerId, { n: Math.max(g.dots, dotsBy.get(g.playerId)?.n || 0) });
  const dots = bestPlayers(dotsBy, (v) => v.n);
  if (dots.ids.length) awards.push(make("dots", "Most dots in one guess", dots.ids, plural(dots.best, "dot", "dots")));

  // Most guesses made.
  const madeBy = new Map();
  for (const g of guesses) madeBy.set(g.playerId, { n: (madeBy.get(g.playerId)?.n || 0) + 1 });
  const made = bestPlayers(madeBy, (v) => v.n);
  if (made.ids.length) awards.push(make("guesses", "Most guesses made", made.ids, plural(made.best, "guess", "guesses")));

  // Most rounds hosted (rotating mode only).
  if (mode === "rotating") {
    const hostedBy = new Map();
    for (const d of details) if (d.host && d.host.id) hostedBy.set(d.host.id, { n: (hostedBy.get(d.host.id)?.n || 0) + 1 });
    const hosted = bestPlayers(hostedBy, (v) => v.n);
    if (hosted.ids.length) awards.push(make("hosted", "Most rounds hosted", hosted.ids, plural(hosted.best, "round", "rounds")));
  }

  return awards;
}
