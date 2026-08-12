"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { useSidebar } from "./SidebarContext";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;
const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 };

// The sidebar remounts on every route change; only play the entrance
// stagger the first time the app loads so navigation feels instant.
let navEntrancePlayed = false;

const NAV_ITEMS = [
  {
    href: "/campaign-groups",
    label: "Campaigns & Flows",
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
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <circle cx="8.5" cy="11" r="2" />
        <path d="M5.5 16c0-1.5 1.4-2.2 3-2.2s3 .7 3 2.2" />
        <path d="M15 9.5h4M15 12.5h4" />
      </>
    ),
  },
  {
    href: "/schedules",
    label: "Schedule",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
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

interface Me {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
}

function initials(me: Me) {
  const a = (me.first_name || me.username || "?").trim();
  const b = (me.last_name || "").trim();
  return `${a.charAt(0)}${b.charAt(0) || (a.charAt(1) ?? "")}`.toUpperCase();
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggle, mobileOpen, closeMobile } = useSidebar();
  // Opted-out contacts an import tried to touch, waiting for a decision.
  const [pendingApprovals, setPendingApprovals] = useState(0);
  // Signed-in user, for the account card (no redirects — pages handle auth).
  const [me, setMe] = useState<Me | null>(null);
  // Play the nav stagger only on the first mount of the session
  const [playEntrance] = useState(() => !navEntrancePlayed);
  // Light / dark theme, synced with <html>.dark + localStorage
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    navEntrancePlayed = true;
    setDarkMode(document.documentElement.classList.contains("dark"));
  }, []);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("moc-theme", next ? "dark" : "light"); } catch { /* */ }
  }

  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const res = await fetch(`${API}/contacts/pending-approvals/count/`, { credentials: "include" });
        const data = await res.json();
        if (!cancelled && data.ok) setPendingApprovals(data.count);
      } catch { /* */ }
    }
    async function fetchMe() {
      try {
        const res = await fetch(`${API}/auth/me/`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMe(data);
      } catch { /* */ }
    }
    fetchCount();
    fetchMe();
    const t = setInterval(fetchCount, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pathname]);

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
          className="fixed inset-0 z-40 bg-gray-950/40 lg:hidden animate-fade-in"
        />
      )}

      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen flex-col border-r border-gray-200 bg-white transition-transform duration-300 lg:transition-all w-[230px] ${
          collapsed ? "lg:w-[68px]" : "lg:w-[230px]"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      >
        {/* Logo */}
        <div className={`py-5 px-5 ${collapsed ? "lg:px-3" : ""}`}>
          <Link
            href="/campaign-groups"
            onClick={closeMobile}
            className={`flex items-center gap-3 transition-opacity hover:opacity-80 ${
              collapsed ? "lg:justify-center lg:gap-0" : ""
            }`}
          >
            {/* The real MOC logo (moc-pty.com); white-out filtered in dark mode,
                cropped to its emblem when the sidebar is collapsed. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/moc-logo-light.png"
              alt="Magnum Opus Consultants"
              className={`moc-logo h-9 w-auto shrink-0 ${collapsed ? "lg:w-9 lg:object-cover lg:object-left" : ""}`}
            />
          </Link>
        </div>

        {/* Nav */}
        <nav className={`flex-1 pt-2 px-3 ${collapsed ? "lg:px-2" : ""}`}>
          <p className={`mb-3 px-3 text-[9px] font-bold uppercase tracking-[0.2em] text-gray-400 ${hideWhenCollapsed}`}>
            Beacon
          </p>
          {NAV_ITEMS.map((item, i) => {
            const active =
              pathname === item.href ||
              pathname.startsWith(item.href + "/") ||
              // A campaign's flow board lives under /email-templates but belongs to Campaigns & Flows
              (item.href === "/campaign-groups" && pathname.startsWith("/email-templates"));
            return (
              <motion.div
                key={item.href}
                initial={playEntrance ? { opacity: 0, x: -8 } : false}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...SPRING, delay: playEntrance ? i * 0.025 : 0 }}
              >
                <Link
                  href={item.href}
                  onClick={closeMobile}
                  title={collapsed ? item.label : undefined}
                  className={`group relative mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors duration-150 ${
                    collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
                  } ${
                    active
                      ? "bg-gray-100 text-[#054B70]"
                      : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="sidebar-active-edge"
                      transition={SPRING}
                      className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[#054B70]"
                    />
                  )}
                  <svg
                    className={`h-[18px] w-[18px] shrink-0 transition-colors ${
                      active ? "text-[#054B70]" : "text-gray-400 group-hover:text-gray-500"
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
                  <AnimatePresence>
                    {item.href === "/contacts" && pendingApprovals > 0 && (
                      <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={SPRING}
                        className={`ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white ${
                          collapsed ? "lg:absolute lg:right-1 lg:top-1 lg:ml-0" : ""
                        }`}
                        title={`${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}`}
                      >
                        {pendingApprovals}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Link>
              </motion.div>
            );
          })}
        </nav>

        {/* Account card + collapse + sign out */}
        <div className={`border-t border-gray-200 py-3 px-3 ${collapsed ? "lg:px-2" : ""}`}>
          {/* Signed-in user */}
          {me && (
            <div
              className={`mb-2 flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2.5 ring-1 ring-gray-950/5 ${
                collapsed ? "lg:justify-center lg:gap-0 lg:px-0 lg:bg-transparent lg:ring-0" : ""
              }`}
              title={`${me.username} · ${me.role}`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#054B70] text-[11px] font-bold text-white">
                {initials(me)}
              </span>
              <span className={`min-w-0 ${hideWhenCollapsed}`}>
                <span className="block truncate text-[12px] font-semibold text-gray-900 leading-tight">
                  {me.first_name ? `${me.first_name} ${me.last_name}`.trim() : me.username}
                </span>
                <span className="block text-[10px] font-medium capitalize text-gray-500 leading-tight">{me.role}</span>
              </span>
            </div>
          )}

          {/* Light / dark mode */}
          <button
            onClick={toggleTheme}
            className={`group mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-50 hover:text-gray-900 ${
              collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
            }`}
            title={collapsed ? (darkMode ? "Light mode" : "Dark mode") : undefined}
          >
            <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                {darkMode ? (
                  <motion.svg
                    key="sun"
                    initial={{ rotate: -90, scale: 0, opacity: 0 }}
                    animate={{ rotate: 0, scale: 1, opacity: 1 }}
                    exit={{ rotate: 90, scale: 0, opacity: 0 }}
                    transition={SPRING}
                    className="h-[18px] w-[18px] text-gray-400 group-hover:text-amber-500"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" />
                  </motion.svg>
                ) : (
                  <motion.svg
                    key="moon"
                    initial={{ rotate: 90, scale: 0, opacity: 0 }}
                    animate={{ rotate: 0, scale: 1, opacity: 1 }}
                    exit={{ rotate: -90, scale: 0, opacity: 0 }}
                    transition={SPRING}
                    className="h-[18px] w-[18px] text-gray-400 group-hover:text-[#054B70]"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                  </motion.svg>
                )}
              </AnimatePresence>
            </span>
            <span className={hideWhenCollapsed}>{darkMode ? "Light mode" : "Dark mode"}</span>
          </button>

          {/* Toggle button — desktop only (mobile uses the drawer) */}
          <button
            onClick={toggle}
            className={`group mb-1 hidden w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-50 hover:text-gray-900 lg:flex ${
              collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
            }`}
          >
            <svg
              className={`h-[18px] w-[18px] shrink-0 text-gray-400 transition-all group-hover:text-gray-500 ${
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
            className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-gray-700 transition-colors duration-150 hover:bg-red-50 hover:text-red-600 ${
              collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
            }`}
            title={collapsed ? "Sign Out" : undefined}
          >
            <svg
              className="h-[18px] w-[18px] shrink-0 text-gray-400 transition-colors group-hover:text-red-500"
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
        </div>
      </aside>
    </>
  );
}
