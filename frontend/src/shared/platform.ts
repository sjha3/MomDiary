// Single source of truth for "are we running inside a Capacitor native shell?"
//
// Every `src/shared/*` wrapper that has a native branch should consult these
// helpers — never call `Capacitor.getPlatform()` directly. This keeps the
// mocking surface small in tests (vi.mock("@/shared/platform")) and lets us
// swap detection logic later (e.g. when we add a desktop Tauri build).

import { Capacitor } from "@capacitor/core";

/** True when the JS is running inside the iOS or Android Capacitor WebView. */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** "ios", "android", or "web". */
export function getPlatform(): "ios" | "android" | "web" {
  try {
    const p = Capacitor.getPlatform();
    if (p === "ios" || p === "android") return p;
    return "web";
  } catch {
    return "web";
  }
}
