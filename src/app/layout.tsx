import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MjengoOS — The evidence-backed operating system for construction",
  description:
    "Every site. Every milestone. Accounted for. MjengoOS connects procurement, inventory, workforce, deliveries, site evidence and owner-approved payments on one platform — with human verification at its core.",
  keywords: [
    "construction management",
    "site evidence",
    "procurement",
    "inventory",
    "workforce",
    "payments",
    "MjengoOS",
  ],
  authors: [{ name: "MjengoOS" }],
  openGraph: {
    title: "MjengoOS — Build with clarity",
    description:
      "The evidence-backed operating system for construction. Every site. Every milestone. Accounted for.",
    siteName: "MjengoOS",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#fafaf9",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
