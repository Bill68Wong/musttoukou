import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MUST登校",
  description: "擎天汇 ↔ 澳科大 ↔ 横琴 通勤计时与数据采集",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // ★ v1.1.7：原先 maximumScale:1 / userScalable:false —— 而站内有 12px 的小字（档位徽章等），
  //   光线差或老花时读不到却**放不大**（违反 WCAG 1.4.4 缩放要求）。放开到 5 倍。
  //   ⚠️ 布局已加 overflow 保护，放大后不会横向溢出。
  maximumScale: 5,
  userScalable: true,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F9F9FF" },
    { media: "(prefers-color-scheme: dark)", color: "#111318" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
