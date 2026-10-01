// Player colors. Each person gets one of PALETTE_SIZE colors when they create
// or join a game and keeps it for the whole game. Only the *index* is ever
// stored or sent; the actual shades live in app/globals.css (--pc0 ... --pc9,
// one set for light and one for dark mode).
//
// The palette avoids the amber of the star (★) and the ✓ mark, the steel blue
// of the dot (●) and the red-orange of the ✕ mark. It is always shown as a
// small vertical bar (never a circle or a star) next to the person's name, and
// the name is always shown too — color is never the only signal.
export const PALETTE_SIZE = 10;

export const COLOR_NAMES = ["violet", "teal", "pink", "lime", "indigo", "brown", "plum", "cyan", "green", "graphite"];

// The first color nobody active is using; if every color is taken, colors are
// reused (least-used first, lowest index on ties).
export function pickColor(usedIndexes) {
  const counts = new Array(PALETTE_SIZE).fill(0);
  for (const c of usedIndexes) if (Number.isInteger(c) && c >= 0 && c < PALETTE_SIZE) counts[c]++;
  const free = counts.findIndex((n) => n === 0);
  if (free !== -1) return free;
  const min = Math.min(...counts);
  return counts.indexOf(min);
}

// The color of someone whose record has none (games created before colors
// existed): a stable pick from their place in the join order, so it never
// changes from one poll to the next.
export function fallbackColor(position) {
  return ((position % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
}
