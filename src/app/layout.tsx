import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LedgerCore — Multi-Tenant FinTech Ledger & Reconciliation Engine",
  description:
    "Double-entry ledger, split payments, idempotent webhooks and PSP reconciliation on Next.js, Supabase (RLS) and Vercel.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}>
      <body className="min-h-full bg-canvas text-ink">{children}</body>
    </html>
  );
}
