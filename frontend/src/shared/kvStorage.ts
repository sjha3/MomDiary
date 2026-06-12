// Synchronous key-value storage abstraction.
//
// Web build  → backed by `window.localStorage`.
// Native (Capacitor) build → backed by `@capacitor/preferences`, which is
//   async. To keep a single sync `get()/set()/remove()` API for callers
//   (they call it inside `useState` initializers), the native path mirrors
//   all known keys in an in-memory map that is **hydrated at app boot** via
//   `hydrateKvStorage()` (called from `main.tsx` *before* React renders).
//   Writes update the mirror immediately and fire-and-forget the async
//   Preferences write.
//
// SSR / non-browser environments (tests, Vite SSR) get a silent in-memory
// fallback so callers never need to wrap reads in `typeof window !== "undefined"`.

import { isNativePlatform } from "@/shared/platform";

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const ls = window.localStorage;
    // Safari in private mode throws on setItem — probe once.
    const probe = "__momdiary_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function createMemoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) ?? null) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

// In-memory mirror used by the native branch. The web branch reads/writes
// `localStorage` directly so it doesn't need this.
const nativeMirror: Map<string, string> = new Map();
let nativeHydrated = false;

// Known keys the app persists. On native we pre-fetch these at boot.
// Adding a new key requires adding it here so the cold-start read sees it.
const KNOWN_KEYS = ["momdiary.chatMode", "momdiary.chatVisible"] as const;

const webBacking: Storage = getBrowserStorage() ?? createMemoryStorage();

export const kvStorage = {
  get(key: string): string | null {
    if (isNativePlatform()) {
      return nativeMirror.has(key) ? (nativeMirror.get(key) ?? null) : null;
    }
    return webBacking.getItem(key);
  },
  set(key: string, value: string): void {
    if (isNativePlatform()) {
      nativeMirror.set(key, value);
      // Fire-and-forget — the mirror is the source of truth between writes;
      // Preferences only needs to catch up before the next cold start.
      void writePreference(key, value);
      return;
    }
    webBacking.setItem(key, value);
  },
  remove(key: string): void {
    if (isNativePlatform()) {
      nativeMirror.delete(key);
      void removePreference(key);
      return;
    }
    webBacking.removeItem(key);
  },
};

async function writePreference(key: string, value: string): Promise<void> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.set({ key, value });
  } catch {
    // Native plugin may be missing in tests / web — mirror is still valid.
  }
}

async function removePreference(key: string): Promise<void> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.remove({ key });
  } catch {
    // ignore
  }
}

/**
 * Hydrates the in-memory mirror from `@capacitor/preferences`.
 *
 * Called once from `main.tsx` on native before `createRoot()` so the very
 * first React render sees the persisted values. On web this is a no-op.
 *
 * Idempotent: a second call returns immediately after the first hydration.
 */
export async function hydrateKvStorage(): Promise<void> {
  if (nativeHydrated) return;
  if (!isNativePlatform()) {
    nativeHydrated = true;
    return;
  }
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Promise.all(
      KNOWN_KEYS.map(async (key) => {
        const { value } = await Preferences.get({ key });
        if (value !== null && value !== undefined) {
          nativeMirror.set(key, value);
        }
      }),
    );
  } catch {
    // If hydration fails the mirror stays empty; callers fall back to defaults.
  } finally {
    nativeHydrated = true;
  }
}
