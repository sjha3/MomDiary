import { SignIn, useSignIn } from "@clerk/clerk-react";
import { useState } from "react";
import { startNativeOAuthSignIn } from "@/shared/nativeOAuth";
import { isNativePlatform } from "@/shared/platform";

/**
 * Clerk-hosted sign-in widget (FR-001, FR-006).
 *
 * `routing="path"` lets Clerk own subpaths under `/sign-in/*` (email
 * verification, factor selection, social callbacks). After sign-in we land
 * back on `/` where `<SignedIn>` reveals the app shell.
 *
 * On Capacitor (native) we hide Clerk's built-in social buttons — they
 * navigate the embedded WebView to Google, which Google refuses with
 * "disallowed_useragent". A custom button row above the widget instead
 * routes through `@capacitor/browser` + a deep-link callback; see
 * `frontend/src/shared/nativeOAuth.ts`.
 */
export function SignInPage(): JSX.Element {
  const native = isNativePlatform();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-amber-50 p-4">
      {native ? <NativeOAuthRow /> : null}
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        afterSignInUrl="/"
        appearance={
          native
            ? {
                elements: {
                  // Hide Clerk's social-button section on native; we render
                  // our own above. Keep email/password and divider visible.
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
  const { signIn, isLoaded } = useSignIn();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onGoogle(): Promise<void> {
    if (!isLoaded || !signIn) return;
    setError(null);
    setPending(true);
    try {
      await startNativeOAuthSignIn(signIn, "oauth_google");
      // Browser opens; control returns when the user finishes OAuth and the
      // deep-link handler reloads the WebView. Leave `pending=true` so the
      // button stays disabled until then.
    } catch (e) {
      setPending(false);
      setError(e instanceof Error ? e.message : "Google sign-in failed.");
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
