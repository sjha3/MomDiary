import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor configuration for the MomDiary native shells.
//
// `webDir` is the Vite production output directory; `npm run cap:sync` copies
// this into `ios/App/App/public` and `android/app/src/main/assets/public`.
//
// `server.androidScheme = "https"` means the Android WebView serves the app at
// `https://localhost` instead of the default `http://localhost`. This matches
// the iOS WKWebView origin (`capacitor://localhost` for iOS, but treated as a
// secure context) so things like Web Speech API, getUserMedia, storage
// quotas, and Clerk cookies behave consistently across both platforms.
const config: CapacitorConfig = {
  appId: "com.momdiary.app",
  appName: "MomDiary",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
