// Platform-pluggable dialog helpers.
//
// Web build → falls back to `window.confirm` (synchronous-looking, but the
//   helper returns a Promise so the rest of the app can pretend it's async).
// Native build (Capacitor) → uses `@capacitor/dialog` `Dialog.confirm({...})`
//   which renders the native UIAlertController / AlertDialog.
//
// Why async even on web: the native API is async; callers shouldn't have to
// branch on platform. Plus React 19's transitions like async event handlers.

import { isNativePlatform } from "@/shared/platform";

interface ConfirmOptions {
  /** Optional dialog title (used on native; ignored by `window.confirm`). */
  title?: string;
  /** OK button label (used on native; ignored by `window.confirm`). */
  okText?: string;
  /** Cancel button label (used on native; ignored by `window.confirm`). */
  cancelText?: string;
}

export async function confirm(
  message: string,
  opts: ConfirmOptions = {},
): Promise<boolean> {
  if (isNativePlatform()) {
    try {
      const { Dialog } = await import("@capacitor/dialog");
      const { value } = await Dialog.confirm({
        title: opts.title ?? "Confirm",
        message,
        okButtonTitle: opts.okText,
        cancelButtonTitle: opts.cancelText,
      });
      return value === true;
    } catch {
      // Plugin missing for some reason — fall through to the web path.
    }
  }
  if (typeof window === "undefined") return false;
  return window.confirm(message);
}
