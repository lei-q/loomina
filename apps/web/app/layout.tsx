import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "织光机 Loomina",
  description: "把一条想法，变成能发的竖屏短剧。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
