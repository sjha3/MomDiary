// One-time native shell initialisation.
//
// Called from `main.tsx` *before* `createRoot()` so the first React render
// already sees:
//   - the in-memory kvStorage mirror hydrated from @capacitor/preferences
//   - the status bar styled to match the app palette
//   - a back-button listener registered so Android's hardware back closes
//     modals before exiting the app
//
// On web this is a no-op: every helper checks `isNativePlatform()` first.

import { hydrateKvStorage } from "@/shared/kvStorage";
import { setupOAuthDeepLink } from "@/shared/nativeOAuth";
import { isNativePlatform } from "@/shared/platform";

let bootPromise: Promise<void> | null = null;

/**
 * Idempotent. Always returns the same promise so callers can `await` it from
 * multiple entry points without re-running the boot sequence.
 */
export function bootNativeShell(): Promise<void> {
  if (!bootPromise) {
    bootPromise = runBoot();
  }
  return bootPromise;
}

async function runBoot(): Promise<void> {
  // Step 1: hydrate kvStorage mirror. This runs on every platform; on web
  // it returns immediately, on native it pre-loads the persisted values
  // before the first useState reader runs.
  await hydrateKvStorage();

  if (!isNativePlatform()) return;

  // Step 2: configure the status bar. We use the app's warm sand palette
  // (peach #FFFAF5 background, dark text). Failures are silently ignored
  // so a missing plugin (e.g. unsupported device) never blocks boot.
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: "#FFFAF5" });
  } catch {
    // ignore
  }

  // Step 3: hide the splash screen now that React is about to render.
  // The native shell shows the splash from launch until this call; if we
  // never call it, the splash hangs forever (configurable via
  // SplashScreen.launchShowDuration in capacitor.config.ts, default 500ms).
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // ignore
  }

  // Step 4: register an Android back-button handler. Without this, pressing
  // back from anywhere in the app exits to the launcher. We want it to
  // close modals first; only exit if we are at the root with nothing open.
  try {
    const { App } = await import("@capacitor/app");
    await App.addListener("backButton", ({ canGoBack }) => {
      // If the WebView history has a previous entry, walk back through it.
      if (canGoBack) {
        window.history.back();
        return;
      }
      // Otherwise let the OS handle it (exits app on Android).
      void App.exitApp();
    });
  } catch {
    // ignore
  }

  // Step 5: keep the keyboard from shoving fixed elements out of view.
  // On iOS, Capacitor uses the "native" resize mode by default which
  // moves the WebView viewport up. Setting accessoryBarVisible=false hides
  // the iOS keyboard accessory bar that otherwise eats vertical space.
  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    await Keyboard.setAccessoryBarVisible({ isVisible: false });
  } catch {
    // ignore (Android no-ops the accessory call)
  }

  // Step 6: register the OAuth deep-link bridge so Clerk's Google /
  // OAuth providers can complete after redirecting back to
  // `com.momdiary.app://oauth-callback`. See nativeOAuth.ts for details.
  try {
    await setupOAuthDeepLink();
  } catch {
    // ignore — OAuth UI will surface the error if the bridge is missing
  }
}
