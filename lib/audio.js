// Sounds for the game screen. Phones only allow sound after the player has
// tapped the page at least once, so the shared audio context is unlocked on
// the first tap (see unlockAudio). Both the "Your turn" beep and the chat
// sounds go through this one context.
let audioCtx = null;

export function unlockAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}

// The "Your turn" beep. About twice as loud as it used to be (peak gain 0.30,
// was 0.15) and clearly louder than the chat sounds (peak 0.14, softer
// triangle wave). A 6 ms fade-in and a smooth fade-out keep it click-free, and
// 0.30 leaves plenty of headroom, so it can't clip or crackle.
export function playBeep() {
  try {
    if (!audioCtx || audioCtx.state !== "running") return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.006);
    gain.gain.setValueAtTime(0.3, t0 + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.34);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.36);
  } catch {}
}

// The default chat sound: two quick, soft rising notes on a triangle wave —
// clearly different from the single higher "Your turn" beep.
function playChatDefault() {
  try {
    if (!audioCtx || audioCtx.state !== "running") return;
    const t0 = audioCtx.currentTime;
    [[523.25, 0], [783.99, 0.11]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.14, t0 + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + delay + 0.16);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.18);
    });
  } catch {}
}

// Sound files are decoded once and played through the same unlocked context
// (so they work on iPhone too). A file that's missing or can't be decoded
// resolves to null, and the default chat sound plays in its place.
const buffers = new Map();

function loadBuffer(src) {
  if (!buffers.has(src)) {
    buffers.set(src, (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) return null;
        const data = await res.arrayBuffer();
        return await new Promise((resolve) => {
          const p = audioCtx.decodeAudioData(data, resolve, () => resolve(null));
          if (p && p.catch) p.then(resolve, () => resolve(null));
        });
      } catch {
        return null;
      }
    })());
  }
  return buffers.get(src);
}

export function preloadChatSounds(sources) {
  try {
    unlockAudio();
    if (!audioCtx) return;
    for (const src of sources) if (src) loadBuffer(src);
  } catch {}
}

// `src` is a statement's own sound file (or nothing for the default sound).
export async function playChatSound(src) {
  try {
    if (!audioCtx || audioCtx.state !== "running") return;
    const buffer = src ? await loadBuffer(src) : null;
    if (!buffer) { playChatDefault(); return; }
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start();
  } catch {
    playChatDefault();
  }
}
