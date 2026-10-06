import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "QA Copilot", template: "%s · QA Copilot" },
  description: "Website QA, design and brand compliance scanning",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page is rendered per request so its scripts carry that request's CSP nonce (proxy.ts);
  // a page prerendered at build time would have no nonce and its scripts would be blocked.
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
