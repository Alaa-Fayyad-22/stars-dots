"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { loadFlag, saveFlag } from "@/lib/client";
import { getInstallPrompt, subscribeInstall, runInstallPrompt } from "@/lib/install";

const DISMISS_KEY = "sd:install-hint-dismissed";

function isStandalone() {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  } catch { return false; }
}

// iPhone / iPad Safari only (other iOS browsers and in-app browsers have no
// "Add to Home Screen" in the same place). iPadOS reports itself as a Mac.
function isIosSafari() {
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\/|MicroMessenger/.test(ua);
}

// A small, dismissible "install the app" hint for the home page. Never shown
// in the installed app, after it's been dismissed on this device, or when the
// browser has nothing to offer.
export default function InstallHint() {
  const [env, setEnv] = useState(null); // null until we're on the client
  const prompt = useSyncExternalStore(subscribeInstall, getInstallPrompt, () => null);

  useEffect(() => {
    setEnv({ standalone: isStandalone(), ios: isIosSafari(), dismissed: loadFlag(DISMISS_KEY, false) });
  }, []);

  if (!env || env.standalone || env.dismissed) return null;
  const showIos = env.ios;
  const showInstall = !showIos && !!prompt;
  if (!showIos && !showInstall) return null;

  function dismiss() {
    saveFlag(DISMISS_KEY, true);
    setEnv({ ...env, dismissed: true });
  }
  async function install() {
    const outcome = await runInstallPrompt();
    if (outcome === "accepted") dismiss();
  }

  return (
    <aside className="install-hint" aria-label="Install the app">
      {showIos ? (
        <p className="small">Add Stars &amp; Dots to your home screen: tap Share, then Add to Home Screen.</p>
      ) : (
        <>
          <p className="small">Play full-screen from your home screen.</p>
          <button type="button" className="secondary install-btn" onClick={install}>Install app</button>
        </>
      )}
      <button type="button" className="secondary install-dismiss" onClick={dismiss} aria-label="Dismiss install hint">✕</button>
    </aside>
  );
}
