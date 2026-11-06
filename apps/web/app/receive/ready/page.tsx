import type { Metadata, Viewport } from "next";
import { ReadyScreen } from "./ready-screen.js";

export const metadata: Metadata = { title: "CPay · Ready to get paid" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0a0a", viewportFit: "cover" };

export default function ReadyPage() {
  return <ReadyScreen />;
}
