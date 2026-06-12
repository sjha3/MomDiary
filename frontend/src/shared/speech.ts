// Platform-pluggable speech recognition.
//
// Web build: wraps the browser-native Web Speech API
//   (`webkitSpeechRecognition` on Chrome/Safari/Edge; not implemented on
//   Firefox).
// Native build (Capacitor): delegates to
//   `@capacitor-community/speech-recognition`, which works inside iOS
//   WKWebView (where the Web Speech API does not exist) and Android
//   WebView (where the browser API is less reliable than the native API).
//
// Public surface (same on every platform):
//   - `useSpeechRecognition({ onTranscript, onFinal, silenceMs, lang })`
//     returns `{ supported, listening, error, start, stop, toggle }`.
//   - `silenceMs` controls how long the recognizer waits with no new
//     interim/final results before committing and auto-submitting.
//
// Extracted from `ChatPanel.tsx` so the native swap is a single-file change
// and the chat UI never imports `@capacitor/*` directly.

import { useCallback, useEffect, useRef, useState } from "react";
import { isNativePlatform } from "@/shared/platform";

export interface UseSpeechRecognitionOptions {
  onTranscript: (text: string, isFinal: boolean) => void;
  onFinal?: (text: string) => void;
  lang?: string;
  /**
   * How long the recognizer must hear silence (no new interim/final results)
   * before it commits and auto-submits. Users routinely pause mid-sentence,
   * so this should be generous: default 1800ms.
   */
  silenceMs?: number;
}

export interface SpeechRecognitionApi {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

// ---------------------------------------------------------------------------
// Web implementation: browser-native Web Speech API.
// ---------------------------------------------------------------------------

type SRResult = { isFinal: boolean; 0: { transcript: string } };
interface SRResultList {
  length: number;
  [index: number]: SRResult;
}
interface SREvent {
  resultIndex: number;
  results: SRResultList;
}
interface SRErrorEvent {
  error: string;
}
interface SRInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SRConstructor = new () => SRInstance;

function getSRCtor(): SRConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function useWebSpeechRecognition(
  opts: UseSpeechRecognitionOptions,
): SpeechRecognitionApi {
  const { onTranscript, onFinal, lang, silenceMs = 1800 } = opts;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SRInstance | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  // Cross-restart session state. `start()` resets these; `onend` auto-restart
  // preserves them so the running transcript survives a browser-induced gap.
  const finalAccumRef = useRef("");
  const lastInterimRef = useRef("");
  const silenceTimerRef = useRef<number | null>(null);
  const manualStopRef = useRef(false);
  const committedRef = useRef(false);

  const Ctor = getSRCtor();
  const supported = Ctor !== null;

  const clearSilence = () => {
    if (silenceTimerRef.current != null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  // Fire the final transcript exactly once and stop the recognizer.
  const commit = useCallback(() => {
    if (committedRef.current) return;
    clearSilence();
    committedRef.current = true;
    manualStopRef.current = true;
    const text = (finalAccumRef.current + lastInterimRef.current).trim();
    const rec = recRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    if (text && onFinalRef.current) onFinalRef.current(text);
  }, []);

  // Cancel without submitting (user tapped the cancel pill).
  const stop = useCallback(() => {
    clearSilence();
    committedRef.current = true; // suppress any pending final
    manualStopRef.current = true;
    const rec = recRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  // Creates a fresh recognizer instance and wires its handlers. Used both for
  // a brand-new session (`start`) and to seamlessly resume after a browser
  // auto-end mid-utterance. Resetting of session state happens in `start()`.
  const createAndStart = useCallback(() => {
    if (!Ctor) return;
    let rec: SRInstance;
    try {
      rec = new Ctor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recognition unavailable");
      return;
    }
    rec.lang = lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
    rec.interimResults = true;
    // Continuous mode lets the user pause between words without the engine
    // finalising the utterance the moment they stop talking.
    rec.continuous = true;

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) finalAccumRef.current += t;
        else interim += t;
      }
      lastInterimRef.current = interim;
      const combined = (finalAccumRef.current + interim).trim();
      if (combined) onTranscriptRef.current(combined, false);
      // Any speech activity resets the silence countdown.
      clearSilence();
      silenceTimerRef.current = window.setTimeout(() => {
        commit();
      }, silenceMs);
    };
    rec.onerror = (e) => {
      // "no-speech" is benign: the silence timer will eventually commit (or
      // the user will cancel). Surface anything else.
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
        setError(e.error);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      if (!manualStopRef.current && !committedRef.current) {
        // Browser auto-ended mid-session (Chrome does this even with
        // continuous=true after a few seconds of silence). Resume so the
        // user's pause does not terminate dictation.
        try {
          createAndStartRef.current();
          return;
        } catch {
          // fall through to a graceful close
        }
      }
      clearSilence();
      setListening(false);
      if (!committedRef.current) {
        committedRef.current = true;
        const text = (finalAccumRef.current + lastInterimRef.current).trim();
        if (text && onFinalRef.current) onFinalRef.current(text);
      }
    };

    try {
      rec.start();
      recRef.current = rec;
      setError(null);
      setListening(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start mic");
    }
  }, [Ctor, lang, silenceMs, commit]);

  const createAndStartRef = useRef(createAndStart);
  useEffect(() => {
    createAndStartRef.current = createAndStart;
  }, [createAndStart]);

  const start = useCallback(() => {
    if (!Ctor) return;
    // Fresh session: wipe accumulated transcript and flags.
    finalAccumRef.current = "";
    lastInterimRef.current = "";
    manualStopRef.current = false;
    committedRef.current = false;
    clearSilence();
    if (recRef.current) {
      try {
        recRef.current.abort();
      } catch {
        // ignore
      }
      recRef.current = null;
    }
    createAndStart();
  }, [Ctor, createAndStart]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  useEffect(() => {
    return () => {
      clearSilence();
      const rec = recRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return { supported, listening, error, start, stop, toggle };
}

// ---------------------------------------------------------------------------
// Native implementation: @capacitor-community/speech-recognition.
//
// Plugin surface (v7):
//   SpeechRecognition.available(): { available: boolean }
//   SpeechRecognition.requestPermissions(): { speechRecognition: PermissionState }
//   SpeechRecognition.start({ language, partialResults, popup })
//   SpeechRecognition.stop()
//   SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => void)
//   SpeechRecognition.addListener('listeningState', (data: { status: 'started' | 'stopped' }) => void)
//   SpeechRecognition.removeAllListeners()
//
// `partialResults` fires repeatedly with the current best-match transcript at
// `matches[0]` until `stop()` is called. We treat each partial as an "interim"
// for callers and run the same silenceMs auto-commit logic as the web path.
// ---------------------------------------------------------------------------

type SpeechPluginModule = typeof import("@capacitor-community/speech-recognition");
type SpeechPlugin = SpeechPluginModule["SpeechRecognition"];

let speechPluginPromise: Promise<SpeechPlugin> | null = null;
function loadSpeechPlugin(): Promise<SpeechPlugin> {
  if (!speechPluginPromise) {
    speechPluginPromise = import("@capacitor-community/speech-recognition").then(
      (m) => m.SpeechRecognition,
    );
  }
  return speechPluginPromise;
}

function useNativeSpeechRecognition(
  opts: UseSpeechRecognitionOptions,
): SpeechRecognitionApi {
  const { onTranscript, onFinal, lang, silenceMs = 1800 } = opts;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Native plugin is always assumed supported on iOS/Android; the
  // `available()` async probe updates this if the user's device lacks it.
  const [supported, setSupported] = useState(true);

  const onTranscriptRef = useRef(onTranscript);
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const lastTranscriptRef = useRef("");
  const silenceTimerRef = useRef<number | null>(null);
  const committedRef = useRef(false);
  const pluginRef = useRef<SpeechPlugin | null>(null);

  // One-shot availability probe.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const plugin = await loadSpeechPlugin();
        if (cancelled) return;
        pluginRef.current = plugin;
        const { available } = await plugin.available();
        if (!cancelled) setSupported(Boolean(available));
      } catch {
        if (!cancelled) setSupported(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearSilence = () => {
    if (silenceTimerRef.current != null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const teardown = useCallback(async () => {
    clearSilence();
    const plugin = pluginRef.current;
    if (!plugin) return;
    try {
      await plugin.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      await plugin.stop();
    } catch {
      // ignore: stop() throws if not currently listening
    }
  }, []);

  const commit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const text = lastTranscriptRef.current.trim();
    void teardown().finally(() => setListening(false));
    if (text && onFinalRef.current) onFinalRef.current(text);
  }, [teardown]);

  const stop = useCallback(() => {
    committedRef.current = true; // suppress pending final
    void teardown().finally(() => setListening(false));
  }, [teardown]);

  const start = useCallback(() => {
    lastTranscriptRef.current = "";
    committedRef.current = false;
    clearSilence();
    setError(null);

    void (async () => {
      try {
        const plugin = pluginRef.current ?? (await loadSpeechPlugin());
        pluginRef.current = plugin;

        // Ask for mic + speech permissions if not already granted.
        const perms = await plugin.checkPermissions();
        if (perms.speechRecognition !== "granted") {
          const req = await plugin.requestPermissions();
          if (req.speechRecognition !== "granted") {
            setError("Microphone permission denied");
            return;
          }
        }

        // Re-attach listener fresh each start.
        await plugin.removeAllListeners();
        await plugin.addListener("partialResults", (data: { matches?: string[] }) => {
          const text = data.matches?.[0] ?? "";
          if (!text) return;
          lastTranscriptRef.current = text;
          onTranscriptRef.current(text, false);
          clearSilence();
          silenceTimerRef.current = window.setTimeout(() => {
            commit();
          }, silenceMs);
        });

        await plugin.start({
          language: lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US"),
          partialResults: true,
          popup: false,
        });
        setListening(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not start mic");
        setListening(false);
      }
    })();
  }, [commit, lang, silenceMs]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  useEffect(() => {
    return () => {
      void teardown();
    };
  }, [teardown]);

  return { supported, listening, error, start, stop, toggle };
}

// ---------------------------------------------------------------------------
// Public hook: pick the implementation once at module load.
// ---------------------------------------------------------------------------
// Both implementations have identical signatures, so swapping them at module
// scope (rather than branching inside the hook body) keeps the Rules of Hooks
// happy: the React runtime only ever sees one hook function pointer.

export const useSpeechRecognition: (
  opts: UseSpeechRecognitionOptions,
) => SpeechRecognitionApi = isNativePlatform()
  ? useNativeSpeechRecognition
  : useWebSpeechRecognition;
