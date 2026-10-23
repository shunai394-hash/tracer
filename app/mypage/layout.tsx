import type { ReactNode } from "react";

export const metadata = { title: "マイページ", robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
