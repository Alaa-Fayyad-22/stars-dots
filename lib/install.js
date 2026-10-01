// The browser's "install this app" offer (Chrome / Edge / Android). The
// beforeinstallprompt event can fire before the home page is shown (for
// instance if someone opens an invite link and taps "New game" later), so it
// is caught here, for the whole session, and the home page's hint reads it.
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener("appinstalled", () => { deferred = null; notify(); });
}

export const getInstallPrompt = () => deferred;
export function subscribeInstall(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export async function runInstallPrompt() {
  const ev = deferred;
  if (!ev) return null;
  deferred = null; // an event can only be used once
  notify();
  try { await ev.prompt(); const { outcome } = await ev.userChoice; return outcome; } catch { return null; }
}
