import {
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  useAuth,
} from "@clerk/clerk-react";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { SignInPage } from "@/features/auth/SignInPage";
import { SignUpPage } from "@/features/auth/SignupPage";
import { VerifyEmailBanner } from "@/features/auth/VerifyEmailBanner";
import { useLogoutMutation, useSession, useTimezoneSync } from "@/features/auth/useSession";
import { onUnauthorized } from "@/shared/apiClient";
import { kvStorage } from "@/shared/kvStorage";
import { BabySwitcher } from "@/features/babies/BabySwitcher";
import { OfflineBanner } from "@/features/network/OfflineBanner";
import { FirstBabyPrompt } from "@/features/babies/FirstBabyPrompt";
import { ChatProvider } from "@/features/chat/ChatContext";
import { SelectedDateProvider } from "@/features/date/useSelectedDate";
import { FeedHistoryPage } from "@/features/home/FeedHistoryPage";
import { HomePage } from "@/features/home/HomePage";
import { PoopHistoryPage } from "@/features/home/PoopHistoryPage";
import { SleepHistoryPage } from "@/features/home/SleepHistoryPage";
import { AppointmentHistoryPage } from "@/features/home/AppointmentHistoryPage";
import { ProfilePage } from "@/features/profile";

const CHAT_VISIBLE_STORAGE_KEY = "momdiary.chatVisible";

const ChatPanel = lazy(() =>
  import("@/features/chat/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);

function ProfileMenu(props: { displayName: string }): JSX.Element {
  const logout = useLogoutMutation();
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-600">{props.displayName}</span>
      <button
        type="button"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        className="rounded bg-white px-2 py-1 text-slate-700 ring-1 ring-slate-200 hover:bg-amber-50 disabled:opacity-60"
      >
        {logout.isPending ? "…" : "Sign out"}
      </button>
    </div>
  );
}

function AppShell(props: {
  displayName: string;
  activeBabyId: number;
  user: import("@/shared/types").CurrentUser;
}): JSX.Element {
  const [chatVisible, setChatVisible] = useState<boolean>(() => {
    return kvStorage.get(CHAT_VISIBLE_STORAGE_KEY) === "true";
  });
  const [chatVoiceOnly, setChatVoiceOnly] = useState(false);

  const [view, setView] = useState<
    | "home"
    | "feedHistory"
    | "poopHistory"
    | "sleepHistory"
    | "appointmentHistory"
    | "profile"
  >("home");

  useEffect(() => {
    kvStorage.set(CHAT_VISIBLE_STORAGE_KEY, String(chatVisible));
  }, [chatVisible]);

  useEffect(() => {
    void import("@/features/chat/ChatPanel");
  }, []);

  const hideChat = useCallback(() => {
    setChatVisible(false);
    setChatVoiceOnly(false);
  }, []);
  const showChat = useCallback(() => {
    setChatVoiceOnly(false);
    setChatVisible(true);
  }, []);
  const showVoice = useCallback(() => {
    setChatVoiceOnly(true);
    setChatVisible(true);
  }, []);

  return (
    <div className="min-h-screen bg-amber-50">
      <VerifyEmailBanner />
      <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 px-4 pt-3">
        <BabySwitcher activeBabyId={props.activeBabyId} />
        <ProfileMenu displayName={props.displayName} />
      </div>

      {view === "home" ? (
        <HomePage
          activeBabyId={props.activeBabyId}
          onOpenChat={showChat}
          onOpenVoice={showVoice}
          onOpenProfile={() => setView("profile")}
          onOpenFeedHistory={() => setView("feedHistory")}
          onOpenPoopHistory={() => setView("poopHistory")}
          onOpenSleepHistory={() => setView("sleepHistory")}
          onOpenAppointmentHistory={() => setView("appointmentHistory")}
        />
      ) : view === "feedHistory" ? (
        <FeedHistoryPage onBack={() => setView("home")} />
      ) : view === "poopHistory" ? (
        <PoopHistoryPage onBack={() => setView("home")} />
      ) : view === "sleepHistory" ? (
        <SleepHistoryPage onBack={() => setView("home")} />
      ) : view === "appointmentHistory" ? (
        <AppointmentHistoryPage onBack={() => setView("home")} />
      ) : (
        <ProfilePage user={props.user} onBack={() => setView("home")} />
      )}

      {chatVisible ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chat"
          className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 sm:items-center"
          onClick={hideChat}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md origin-bottom animate-[chatPop_180ms_ease-out]"
          >
            <Suspense fallback={<div className="p-4 text-slate-500 text-sm">Loading chat…</div>}>
              <ChatPanel onHide={hideChat} voiceOnly={chatVoiceOnly} />
            </Suspense>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inner shell — only mounted once Clerk reports the user is signed in.
 * Fetches the backend's `CurrentUserOut` projection (which lazy-provisions
 * the row on first sight) before revealing the diary surface.
 */
function SignedInShell(): JSX.Element {
  const session = useSession();
  // Feature 009: capture the browser's timezone once the user is loaded.
  useTimezoneSync(session.data?.user);

  if (session.isLoading || (session.isPending && !session.data)) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-500">
        Loading…
      </main>
    );
  }

  const user = session.data?.user;
  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-500">
        Signing you in…
      </main>
    );
  }

  if (user.active_baby_id == null) return <FirstBabyPrompt />;

  return (
    <SelectedDateProvider>
      <ChatProvider>
        <AppShell
          displayName={user.display_name}
          activeBabyId={user.active_baby_id}
          user={user}
        />
      </ChatProvider>
    </SelectedDateProvider>
  );
}

/**
 * On any backend 401, force-sign-out so the `<SignedIn>` gate flips and the
 * caregiver is redirected to the Clerk sign-in page. Without this an expired
 * JWT would leave the UI mounted in a permanently-erroring state.
 */
function UnauthorizedRedirector(): null {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    return onUnauthorized(() => {
      void signOut().finally(() => navigate("/sign-in", { replace: true }));
    });
  }, [signOut, navigate]);
  return null;
}

export default function App(): JSX.Element {
  return (
    <>
      <OfflineBanner />
      <Routes>
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/sign-up/*" element={<SignUpPage />} />
        <Route
          path="/*"
          element={
            <>
              <UnauthorizedRedirector />
              <SignedIn>
                <SignedInShell />
              </SignedIn>
              <SignedOut>
                <RedirectToSignIn />
              </SignedOut>
            </>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
