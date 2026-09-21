import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Toaster } from "@/frontend/ui/sonner";
import { AuthSessionProvider } from "@/frontend/auth/session-provider";
import { I18nProvider } from "@/frontend/i18n/provider";
import { SwUpdatePrompt } from "@/frontend/pwa/sw-update-prompt";
import { InstallCue } from "@/frontend/pwa/install-cue";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MjengoOS — Construction Site OS",
  description:
    "Offline-first construction site OS for Kenya. AI photo progress tracking, Swahili voice-to-invoice, anomaly detection, fundi attendance & M-Pesa-ready wage payments.",
  keywords: ["MjengoOS", "construction", "Kenya", "fundi", "offline-first", "AI", "site management"],
  manifest: "/manifest.webmanifest",
  icons: {
    // favicon.ico (issue #78/FE-9): served from /public at the classic
    // location browsers request — closes the /favicon.ico 404.
    icon: "/favicon.ico",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1c1917",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonce (issue #178): src/proxy.ts stamps it on every
  // request; Next applies it to the scripts IT renders, and this layout passes
  // it to its one hand-written inline script below (the pre-hydration <html
  // lang> flip) so the enforced CSP never blocks it. Reading headers() makes
  // / dynamic — inherent to nonce-based CSP (a per-request nonce cannot be
  // statically cached).
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* Pre-hydration <html lang> sync (issue #130 / audit FE-5): mirrors
            public/offline.html exactly — same `mjengo-os-settings` store, same
            values — so a saved Kiswahili preference gets correct AT
            pronunciation from FIRST PAINT, before React hydrates. The static
            lang="en" above stays the SSR/hydration markup; the post-hydration
            I18nProvider useEffect (src/frontend/i18n/provider.tsx) then keeps
            documentElement.lang in lockstep on every locale switch, and
            suppressHydrationWarning absorbs the en→sw attribute flip the same
            way it absorbs next-themes' class mutation. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              "try{var s=JSON.parse(localStorage.getItem('mjengo-os-settings')||'{}');if(s&&s.state&&s.state.language==='sw'){document.documentElement.lang='sw'}}catch(e){}",
          }}
        />
        {/* i18n (W4-I18N · spec §62) — wraps the session provider so the login
            gate and every surface below it can use t(); locale persists via the
            SAME `mjengo-os-settings` store the Settings tab writes. */}
        <I18nProvider>
          {/* PWA install cue (issue #357 / audit FE-11 residual — the install
              half; #148 landed the staleness half). Slim, dismissible, top-of-
              document bar: browser-native on beforeinstallprompt browsers,
              instructions-only on iOS/Safari (the event never fires there),
              nothing anywhere the browser never offered. BEFORE the app shell
              in flow so it never overlays the sticky header or bottom nav;
              renders null until hydrated and on already-installed sessions.
              Inside I18nProvider because the cue needs useT(). */}
          <InstallCue />
          <AuthSessionProvider>{children}</AuthSessionProvider>
          {/* Service-worker registration + staleness cue (PWA · issue #148 /
              audit FE-11). /api/* is never cached — see public/sw.js. The
              registration moved here from the old nonce'd inline script into
              a unit-tested client module (src/frontend/pwa/) that also
              watches for a new worker installing under the running tab and
              toasts "app updated — reload" — an inline script could never
              show that prompt (no React, no toast system, no i18n). Inside
              I18nProvider because the prompt needs useT(); renders null. */}
          <SwUpdatePrompt />
        </I18nProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
