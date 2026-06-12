// Native (Capacitor) OAuth bridge for Clerk.
//
// Google (and most providers) refuse to render OAuth inside an embedded
// WebView (`disallowed_useragent`). The portable workaround is:
//
//   1. Ask Clerk to generate the OAuth URL with a custom-scheme redirect
//      back to our app (`com.momdiary.app://oauth-callback`).
//   2. Open that URL in an in-app Chrome Custom Tab via `@capacitor/browser`
//      — that is a real Chrome instance, so Google accepts it.
//   3. Google → Clerk callback → Clerk redirects to the custom scheme.
//   4. Android's intent filter (AndroidManifest.xml) reopens our app and
//      fires `App.addListener('appUrlOpen', ...)`.
//   5. We close the Custom Tab and navigate the WebView to
//      `/sign-in/sso-callback?<original-query>` (or `/sign-up/sso-callback`),
//      which is the route Clerk's `<SignIn>` / `<SignUp>` widgets handle to
//      finalize the session.
//
// On web this module is a no-op shim.

import type { useSignIn, useSignUp } from "@clerk/clerk-react";
import { isNativePlatform } from "@/shared/platform";

/** Non-null `signIn` resource exposed by `useSignIn()`. */
type SignInResource = NonNullable<ReturnType<typeof useSignIn>["signIn"]>;
/** Non-null `signUp` resource exposed by `useSignUp()`. */
type SignUpResource = NonNullable<ReturnType<typeof useSignUp>["signUp"]>;

/** Must match the `<data android:scheme="...">` in AndroidManifest.xml and
 * the URLScheme entry we'll add to iOS Info.plist when iOS is wired up. */
const DEEP_LINK_SCHEME = "com.momdiary.app";
const REDIRECT_URL = `${DEEP_LINK_SCHEME}://oauth-callback`;
const REDIRECT_URL_COMPLETE = `${DEEP_LINK_SCHEME}://oauth-callback`;

type OAuthStrategy = `oauth_${string}`;

let deepLinkListenerRegistered = false;

/**
 * Registers a one-time `appUrlOpen` listener that closes any open Custom Tab
 * and routes OAuth callbacks back into the WebView. Idempotent. Safe to call
 * on web (returns immediately).
 */
export async function setupOAuthDeepLink(): Promise<void> {
  if (!isNativePlatform()) return;
  if (deepLinkListenerRegistered) return;
  deepLinkListenerRegistered = true;

  try {
    const { App } = await import("@capacitor/app");
    await App.addListener("appUrlOpen", async ({ url }) => {
      if (!url.startsWith(`${DEEP_LINK_SCHEME}://`)) return;

      // Close the OAuth Custom Tab if it's still open. Browser.close is a
      // no-op if nothing is showing.
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.close();
      } catch {
        // ignore — plugin may not be available in test envs
      }

      // The redirect URL looks like:
      //   com.momdiary.app://oauth-callback?__clerk_status=...&...#...
      // We want to forward the query + hash into the WebView at the path
      // Clerk's <SignIn>/<SignUp> widgets use for SSO completion.
      const queryStart = url.indexOf("?");
      const hashStart = url.indexOf("#");
      let tail = "";
      if (queryStart >= 0) tail += url.slice(queryStart);
      else if (hashStart >= 0) tail += url.slice(hashStart);

      // Default to the sign-in completion route. If the user was in the
      // sign-up flow, the same JWT works there too — but Clerk's SSO
      // callback path differs (`/sign-up/sso-callback`). We pick based on
      // the WebView's current path so signup vs signin is preserved.
      const onSignUp = window.location.pathname.startsWith("/sign-up");
      const completionPath = onSignUp
        ? "/sign-up/sso-callback"
        : "/sign-in/sso-callback";

      // Use replace() so the dead "loading" intermediate state isn't in
      // the back-history.
      window.location.replace(`${completionPath}${tail}`);
    });
  } catch {
    // @capacitor/app missing — only happens on web or in tests.
  }
}

/**
 * Kicks off a Clerk OAuth flow from the native SignInPage. Pass the
 * `signIn` resource from `useSignIn()`.
 *
 * Throws if called on web — callers should branch on `isNativePlatform()`
 * and use Clerk's `<SignIn>` widget for the web flow.
 */
export async function startNativeOAuthSignIn(
  signIn: SignInResource,
  strategy: OAuthStrategy,
): Promise<void> {
  if (!isNativePlatform()) {
    throw new Error("startNativeOAuthSignIn() is only valid in a Capacitor app.");
  }
  // Cast the params: Clerk's TS overloads narrow `strategy` per-call, but we
  // pass it dynamically. The runtime call accepts every OAuth strategy.
  await signIn.create({
    strategy,
    redirectUrl: REDIRECT_URL,
    redirectUrlComplete: REDIRECT_URL_COMPLETE,
  } as Parameters<SignInResource["create"]>[0]);
  const oauthUrl =
    signIn.firstFactorVerification?.externalVerificationRedirectURL?.toString();
  if (!oauthUrl) {
    throw new Error(
      "Clerk did not return an OAuth redirect URL. Check that the OAuth provider is enabled in the Clerk dashboard.",
    );
  }
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url: oauthUrl, presentationStyle: "popover" });
}

/**
 * Same as `startNativeOAuthSignIn`, but for the sign-up flow. Pass the
 * `signUp` resource from `useSignUp()`.
 */
export async function startNativeOAuthSignUp(
  signUp: SignUpResource,
  strategy: OAuthStrategy,
): Promise<void> {
  if (!isNativePlatform()) {
    throw new Error("startNativeOAuthSignUp() is only valid in a Capacitor app.");
  }
  await signUp.create({
    strategy,
    redirectUrl: REDIRECT_URL,
    redirectUrlComplete: REDIRECT_URL_COMPLETE,
  } as Parameters<SignUpResource["create"]>[0]);
  const oauthUrl =
    signUp.verifications?.externalAccount?.externalVerificationRedirectURL?.toString();
  if (!oauthUrl) {
    throw new Error(
      "Clerk did not return an OAuth redirect URL for sign-up. Check that the OAuth provider is enabled in the Clerk dashboard.",
    );
  }
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url: oauthUrl, presentationStyle: "popover" });
}

export const NATIVE_OAUTH_REDIRECT_URL = REDIRECT_URL;
