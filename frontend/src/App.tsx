import { useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { DateBar } from "@/features/date/DateBar";
import { SelectedDateProvider, useSelectedDate } from "@/features/date/useSelectedDate";
import { AppointmentsSection } from "@/features/appointments/AppointmentsSection";
import { FeedsSection } from "@/features/feeds/FeedsSection";
import { PoopsSection } from "@/features/poops/PoopsSection";
import { SleepsSection } from "@/features/sleeps/SleepsSection";
import { queryKeys } from "@/shared/queryKeys";

const CHAT_VISIBLE_STORAGE_KEY = "momdiary.chatVisible";
const CHATENTRY_VISIBLE_STORAGE_KEY = "momdiary.chatEntryVisible";

const ChatPanel = lazy(() =>
  import("@/features/chat/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);

const ChatEntryPanel = lazy(() =>
  import("@/features/chatentry/ChatEntryPanel").then((m) => ({ default: m.ChatEntryPanel })),
);

const SECTION_KEYS = new Set(["feeds", "sleeps", "poops", "appointments"]);

function RefreshButton(): JSX.Element {
  const qc = useQueryClient();
  const { date } = useSelectedDate();
  const onClick = () => {
    for (const key of queryKeys.allForDate(date)) {
      qc.invalidateQueries({ queryKey: key });
    }
    // Also catch any stale keys for past dates the user might have navigated through.
    qc.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && SECTION_KEYS.has(q.queryKey[0]),
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Refresh all sections"
      className="rounded bg-slate-200 px-2 py-1 text-sm hover:bg-slate-300"
    >
      ⟳
    </button>
  );
}

function AppShell(): JSX.Element {
  const [chatVisible, setChatVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(CHAT_VISIBLE_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  });
  const [chatEntryVisible, setChatEntryVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(CHATENTRY_VISIBLE_STORAGE_KEY);
    return stored === null ? false : stored === "true";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_VISIBLE_STORAGE_KEY, String(chatVisible));
  }, [chatVisible]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHATENTRY_VISIBLE_STORAGE_KEY, String(chatEntryVisible));
  }, [chatEntryVisible]);

  const hideChat = useCallback(() => setChatVisible(false), []);
  const showChat = useCallback(() => setChatVisible(true), []);
  const hideChatEntry = useCallback(() => setChatEntryVisible(false), []);
  const showChatEntry = useCallback(() => setChatEntryVisible(true), []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">MomDiary</h1>
        <div className="flex items-center gap-2">
          <DateBar />
          <RefreshButton />
        </div>
      </header>
      <FeedsSection />
      <SleepsSection />
      <PoopsSection />
      <AppointmentsSection />
      {chatVisible ? (
        <div
          className="fixed right-4 bottom-4 z-20 w-[min(calc(100vw-2rem),26rem)] origin-bottom-right animate-[chatPop_180ms_ease-out]"
          role="dialog"
          aria-label="Chat"
        >
          <Suspense fallback={<div className="p-4 text-slate-500 text-sm">Loading chat…</div>}>
            <ChatPanel onHide={hideChat} />
          </Suspense>
        </div>
      ) : (
        <button
          type="button"
          onClick={showChat}
          aria-label="Show chat"
          className="fixed right-4 bottom-4 z-20 rounded-full bg-slate-900 px-4 py-3 text-sm text-white shadow-lg hover:bg-slate-700"
        >
          💬 Chat
        </button>
      )}
      {chatEntryVisible ? (
        <div
          className="fixed bottom-4 left-4 z-20 w-[min(calc(100vw-2rem),26rem)] origin-bottom-left animate-[chatPop_180ms_ease-out]"
          role="dialog"
          aria-label="Direct-LLM chat"
        >
          <Suspense
            fallback={<div className="p-4 text-slate-500 text-sm">Loading direct-LLM chat…</div>}
          >
            <ChatEntryPanel onHide={hideChatEntry} />
          </Suspense>
        </div>
      ) : (
        <button
          type="button"
          onClick={showChatEntry}
          aria-label="Show direct-LLM chat"
          className="fixed bottom-4 left-4 z-20 rounded-full bg-indigo-600 px-4 py-3 text-sm text-white shadow-lg hover:bg-indigo-500"
        >
          ⚡ Direct LLM
        </button>
      )}
    </main>
  );
}

export default function App(): JSX.Element {
  return (
    <SelectedDateProvider>
      <AppShell />
    </SelectedDateProvider>
  );
}
