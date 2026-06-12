/// <reference types="vitest" />
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base so the same `dist/` works both at the SWA root and inside
  // a Capacitor WebView (which serves files via the `capacitor://` scheme).
  base: "./",
  plugins: [
    react(),
    VitePWA({
      // Auto-update keeps the SPA in sync with backend API contract changes
      // without forcing the user to clear app data.
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-maskable.svg"],
      manifest: {
        name: "MomDiary",
        short_name: "MomDiary",
        description:
          "Caregiver diary for feeds, sleeps, diapers, and appointments — with an AI assistant.",
        theme_color: "#f97316",
        background_color: "#fffaf5",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "icon-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Network-first for the API so a stale SW never serves a 200 with
        // the wrong shape; stale-while-revalidate for static assets so the
        // app loads instantly on cold start.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/v1/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "momdiary-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 5 },
            },
          },
        ],
        // Don't precache the API; it's covered by runtime caching above.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
      devOptions: {
        // Disable the SW in `vite dev` to avoid stale-asset confusion.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/_msw/setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/**/*.d.ts",
        "src/**/__mocks__/**",
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
  },
});
