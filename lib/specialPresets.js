// Special quick statements — only players with special access can see or send
// these. SERVER-ONLY: import this file from lib/game.js (and other server code),
// never from a component or anything the browser loads, or the phrases would end
// up in the site's JavaScript. The server sends the list to a person only in
// their own part of the game state, and only if they have access.
//
// Same entry shape and editing rules as CHAT_PRESETS in lib/chatPresets.js:
// { id, text, sound } — ids are unique and stable (and must not clash with an id
// in CHAT_PRESETS), `sound` is optional ("/sounds/name.mp3").
export const SPECIAL_PRESETS = [
  { id: "special-asre3-lw-samaht", text: "اسرع لو سمحت" },
  { id: "special-faster-please", text: "Faster please" },
  { id: "special-yalla-khaye", text: "yalla khaye" },
  { id: "special-hahaha", text: "هههه" },
  { id: "special-iq-null", text: "IQ Level: null" },
  { id: "special-bqellak-bss", text: "bqellak bss ma btez3al ?" },
  { id: "special-ya-lateef", text: "ya lateeffff" },
  { id: "special-awttt", text: "AWTTT" },
];

export function findSpecialPreset(id) {
  if (typeof id !== "string") return null;
  return SPECIAL_PRESETS.find((p) => p.id === id) || null;
}
