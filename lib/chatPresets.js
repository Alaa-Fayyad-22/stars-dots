// Quick statements for the chat — the ONLY place they are defined. The server
// (lib/game.js) and the chat UI (app/Chat.js) both read this list.
//
// Each entry is { id, text, sound }:
//   id     A short, unique, stable name (letters, numbers, dashes). Messages
//          remember it, so don't reuse an id for a different statement.
//   text   What everyone sees in the chat (the server looks this up by id, so
//          a player can never send made-up statement text).
//   sound  OPTIONAL. A file under public/sounds/, written as "/sounds/name.mp3".
//          It plays on the other players' devices when the statement arrives.
//          Leave it out — or point at a file that's missing or can't load — and
//          the default chat sound plays instead.
//
// To add a statement: copy a line, give it a new id and text.
// To edit one: change its text (and sound). To remove one: delete its line.
// To add a sound: drop the file into public/sounds/ and set `sound` to
// "/sounds/<file name>". No other file needs to change.
//
// Example with a sound:
//   { id: "cheer", text: "Woohoo! 🎉", sound: "/sounds/cheer.mp3" },
export const CHAT_PRESETS = [
  { id: "nice-guess", text: "Nice guess!" },
  { id: "so-close", text: "So close!" },
  { id: "hurry-up", text: "Hurry up 😄" },
  { id: "got-it", text: "I've got it!" },
  { id: "good-game", text: "Good game!" },
];

export function findChatPreset(id) {
  if (typeof id !== "string") return null;
  return CHAT_PRESETS.find((p) => p.id === id) || null;
}
