"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSidebar } from "./SidebarContext";

const API = "http://localhost:8000/api";

const NAV_ITEMS = [
  {
    href: "/email-templates",
    label: "Campaigns",
    icon: (
      <>
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </>
    ),
  },
  {
    href: "/template-library",
    label: "Template Library",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
  },
  {
    href: "/contacts",
    label: "Contacts",
    icon: (
      <>
        <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16" />
        <path d="M3 21h18" />
        <path d="M12 7a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" />
        <path d="M8 17c0-2.21 1.79-3 4-3s4 .79 4 3" />
      </>
    ),
  },
  {
    href: "/send-progress",
    label: "Send Progress",
    icon: (
      <>
        <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
      </>
    ),
  },
  {
    href: "/reporting",
    label: "Reporting",
    icon: (
      <>
        <path d="M3 3v18h18" />
        <path d="M9 17V9m4 8V5m4 12v-4" />
      </>
    ),
  },
  {
    href: "/users",
    label: "Users",
    icon: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggle, mobileOpen, closeMobile } = useSidebar();

  async function handleLogout() {
    try {
      await fetch(`${API}/logout/`, { method: "POST", credentials: "include" });
    } catch { /* ignore */ }
    router.push("/");
  }

  // Collapse is a desktop-only visual (lg:). On mobile the drawer is always expanded.
  const hideWhenCollapsed = collapsed ? "lg:hidden" : "";

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          onClick={closeMobile}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden animate-fade-in"
        />
      )}

      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen flex-col bg-[#054B70] shadow-xl shadow-[#054B70]/15 transition-transform duration-300 lg:transition-all w-[230px] ${
          collapsed ? "lg:w-[68px]" : "lg:w-[230px]"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      >
        {/* Logo */}
        <div className={`py-5 px-5 ${collapsed ? "lg:px-3" : ""}`}>
          <Link
            href="/email-templates"
            onClick={closeMobile}
            className={`flex items-center gap-3 transition-opacity hover:opacity-80 ${
              collapsed ? "lg:justify-center lg:gap-0" : ""
            }`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 backdrop-blur-sm">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </div>
            <div className={hideWhenCollapsed}>
              <p className="text-[13px] font-bold text-white leading-tight">Magnum Opus</p>
              <p className="text-[10px] font-medium text-[#94bccc] leading-tight">Consultants</p>
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav className={`flex-1 pt-2 px-3 ${collapsed ? "lg:px-2" : ""}`}>
          <p className={`mb-3 px-3 text-[9px] font-bold uppercase tracking-[0.2em] text-[#94bccc]/60 ${hideWhenCollapsed}`}>
            Menu
          </p>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeMobile}
                title={collapsed ? item.label : undefined}
                className={`group relative mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${
                  collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
                } ${
                  active
                    ? "bg-white/15 text-white shadow-sm shadow-black/10"
                    : "text-[#94bccc] hover:bg-white/8 hover:text-white"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-white animate-fade-in" />
                )}
                <svg
                  className={`h-[18px] w-[18px] shrink-0 transition-colors ${
                    active ? "text-white" : "text-[#94bccc]/70 group-hover:text-white"
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {item.icon}
                </svg>
                <span className={hideWhenCollapsed}>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Collapse toggle + Logout + footer */}
        <div className={`border-t border-white/10 py-3 px-3 ${collapsed ? "lg:px-2" : ""}`}>
          {/* Toggle button — desktop only (mobile uses the drawer) */}
          <button
            onClick={toggle}
            className={`group mb-2 hidden w-full items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium text-[#94bccc] transition-all duration-200 hover:bg-white/8 hover:text-white lg:flex ${
              collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
            }`}
          >
            <svg
              className={`h-[18px] w-[18px] shrink-0 text-[#94bccc]/70 transition-all group-hover:text-white ${
                collapsed ? "rotate-180" : ""
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 19l-7-7 7-7" />
              <path d="M18 19l-7-7 7-7" />
            </svg>
            <span className={hideWhenCollapsed}>Collapse</span>
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className={`group mb-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium text-[#94bccc] transition-all duration-200 hover:bg-white/8 hover:text-white ${
              collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
            }`}
            title={collapsed ? "Sign Out" : undefined}
          >
            <svg
              className="h-[18px] w-[18px] shrink-0 text-[#94bccc]/70 transition-colors group-hover:text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className={hideWhenCollapsed}>Sign Out</span>
          </button>

          <p className={`px-3 text-[9px] font-medium text-[#94bccc]/40 uppercase tracking-wider ${hideWhenCollapsed}`}>
            Magnum Opus Consultants
          </p>
        </div>
      </aside>
    </>
  );
}
