import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vorion Tracker",
  description: "Time tracking & screenshot monitoring for your team",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/vorion-with-bg-192.png", type: "image/png", sizes: "192x192" },
      { url: "/vorion-with-bg-512.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: "/vorion-with-bg-192.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
