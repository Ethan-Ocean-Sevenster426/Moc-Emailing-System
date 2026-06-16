"use client";

import { useSidebar } from "./SidebarContext";
import type { ReactNode } from "react";

export default function MainContent({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();

  // No left margin on mobile (sidebar is an overlay drawer); margin only at lg+.
  return (
    <div
      className={`flex-1 min-w-0 transition-all duration-300 ml-0 ${
        collapsed ? "lg:ml-[68px]" : "lg:ml-[230px]"
      }`}
    >
      {children}
    </div>
  );
}
