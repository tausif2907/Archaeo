import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Mono, Host_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const hostGrotesk = Host_Grotesk({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-host-grotesk", display: "swap" });
// No published fallback metrics for this face, so next/font cannot size-adjust its fallback.
const atkinsonMono = Atkinson_Hyperlegible_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-atkinson-mono", display: "swap", adjustFontFallback: false });

export const metadata: Metadata = {
  title: "Archaeo",
  description: "Understand a repo's past, see its present, and fix its future.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${hostGrotesk.variable} ${atkinsonMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
