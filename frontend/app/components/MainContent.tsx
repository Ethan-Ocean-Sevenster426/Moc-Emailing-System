"use client";

import { useSidebar } from "./SidebarContext";
import { motion } from "motion/react";
import type { ReactNode } from "react";

export default function MainContent({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();

  // No left margin on mobile (sidebar is an overlay drawer); margin only at lg+.
  // MainContent remounts on every route change, so this entrance animation
  // doubles as the page-to-page transition.
  return (
    <div
      className={`flex-1 min-w-0 transition-all duration-300 ml-0 ${
        collapsed ? "lg:ml-[68px]" : "lg:ml-[230px]"
      }`}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.9 }}
        className="min-h-screen"
      >
        {children}
      </motion.div>
    </div>
  );
}
