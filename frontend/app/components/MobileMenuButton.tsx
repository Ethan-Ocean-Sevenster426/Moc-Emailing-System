"use client";

import { useSidebar } from "./SidebarContext";

/** Hamburger button shown only on mobile (< lg) to open the sidebar drawer. */
export default function MobileMenuButton({ className = "" }: { className?: string }) {
  const { openMobile } = useSidebar();
  return (
    <button
      onClick={openMobile}
      aria-label="Open menu"
      className={`btn-press flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#f0f4f7] text-[#054B70] transition-colors hover:bg-[#054B70] hover:text-white lg:hidden ${className}`}
    >
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
      </svg>
    </button>
  );
}
