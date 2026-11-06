import type { Metadata, Viewport } from "next";
import { Page } from "../../components/app-shell.js";
import { ReceiveApp } from "./receive-app.js";

export const metadata: Metadata = { title: "CPay · Receive" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0a0a" };

export default function ReceivePage() {
  return (
    <Page>
      <ReceiveApp />
    </Page>
  );
}
