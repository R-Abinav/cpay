import type { Metadata } from "next";
import { PayScreen } from "./pay-screen.js";

export const metadata: Metadata = { title: "CPay · Pay" };

export default function PayPage() {
  return <PayScreen />;
}
