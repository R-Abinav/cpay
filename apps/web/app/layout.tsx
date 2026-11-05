import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/app-shell.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "CPay",
  description: "A privacy-first wallet with hands-free glasses. Keys stay on your phone.",
  applicationName: "CPay",
  appleWebApp: { capable: true, title: "CPay", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// System fonts only: no font CDN, no trackers (CROPS).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
