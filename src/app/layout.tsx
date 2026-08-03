import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "MindTree",
  description: "A private tree for developing thoughts into clear, approved syntheses.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#050608",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
