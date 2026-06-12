// Top-of-app banner that appears when the device loses network connectivity.
//
// Sources:
//   - Web: `navigator.onLine` + `online`/`offline` window events.
//   - Native: `@capacitor/network` Network.addListener('networkStatusChange').
//
// Renders nothing while online. When offline, mounts a sticky banner above
// the app chrome that survives navigation and disappears when connectivity
// returns. Intentionally minimal: no retry buttons, no error queues. The
// existing apiClient already surfaces `code: "network_error"` per request;
// this banner is just an ambient hint that those errors are expected.

import { useEffect, useState } from "react";
import { isNativePlatform } from "@/shared/platform";

export function OfflineBanner(): JSX.Element | null {
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  });

  useEffect(() => {
    // Web listeners always work, even inside a Capacitor WebView, so wire
    // them on every platform as a baseline.
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Native listener: more authoritative on iOS/Android than navigator.onLine.
    let nativeRemove: (() => void) | null = null;
    if (isNativePlatform()) {
      void (async () => {
        try {
          const { Network } = await import("@capacitor/network");
          const initial = await Network.getStatus();
          setOnline(initial.connected);
          const handle = await Network.addListener("networkStatusChange", (status) => {
            setOnline(status.connected);
          });
          nativeRemove = () => {
            void handle.remove();
          };
        } catch {
          // Plugin unavailable: web listeners above still cover the gap.
        }
      })();
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (nativeRemove) nativeRemove();
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 w-full bg-rose-600 px-4 py-2 text-center text-sm font-medium text-white shadow-md"
    >
      You are offline. Some actions will not save until connection is restored.
    </div>
  );
}
