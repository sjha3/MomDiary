import { SignUp, useAuth, useSignUp } from "@clerk/clerk-react";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { startNativeOAuthSignUp } from "@/shared/nativeOAuth";
import { isNativePlatform } from "@/shared/platform";

/**
 * Clerk-hosted sign-up widget (FR-001, FR-002).
 *
 * Clerk handles email/password creation, the Google OAuth flow, and the
 * email-verification token exchange. On completion the user is redirected
 * to `/` where the `SignedIn` gate mounts the shell — but writes are still
 * blocked by `<VerifyEmailBanner>` until the verification claim flips true.
 *
 * On native (Capacitor) the `afterSignUpUrl` handoff is unreliable; we
 * additionally watch `useAuth().isSignedIn` and short-circuit to `/` as
 * soon as Clerk reports a live session. Same pattern as `SignInPage`.
 *
 * On Capacitor (native) we hide Clerk's built-in social buttons (Google
 * blocks OAuth inside embedded WebViews with "disallowed_useragent") and
 * render our own button row that goes through `@capacitor/browser` + a
 * `com.momdiary.app://oauth-callback` deep link. See `nativeOAuth.ts`.
 */
export function SignUpPage(): JSX.Element {
  const native = isNativePlatform();
  const { isLoaded, isSignedIn } = useAuth();

  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-amber-50 p-4">
      {native ? <NativeOAuthRow /> : null}
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        afterSignUpUrl="/"
        appearance={
          native
            ? {
                elements: {
                  socialButtonsRoot: { display: "none" },
                  socialButtonsBlockButton: { display: "none" },
                  dividerRow: { display: "none" },
                },
              }
            : undefined
        }
      />
    </main>
  );
}

function NativeOAuthRow(): JSX.Element {
  const { signUp, isLoaded } = useSignUp();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onGoogle(): Promise<void> {
    if (!isLoaded || !signUp) return;
    setError(null);
    setPending(true);
    try {
      await startNativeOAuthSignUp(signUp, "oauth_google");
    } catch (e) {
      setPending(false);
      setError(e instanceof Error ? e.message : "Google sign-up failed.");
    }
  }

  return (
    <div className="w-full max-w-sm rounded-md bg-white p-4 shadow ring-1 ring-slate-200">
      <button
        type="button"
        onClick={() => void onGoogle()}
        disabled={!isLoaded || pending}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-amber-50 disabled:opacity-60"
      >
        {pending ? "Opening Google…" : "Continue with Google"}
      </button>
      {error ? (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      ) : null}
    </div>
  );
}
