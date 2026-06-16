"use client";

import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import { useAuth } from "../hooks/useAuth";

const API = "http://localhost:8000/api";

interface Overview {
  total_jobs: number;
  total_sent: number;
  total_failed: number;
  total_skipped: number;
  total_recipients: number;
  delivery_rate: number;
}

interface ContactStats {
  total: number;
  active: number;
  inactive: number;
  bounced: number;
  opted_out: number;
  undeliverable: number;
  moved_to_hubspot: number;
}

interface TPStat {
  touchpoint_number: number;
  total_jobs: number;
  sent: number;
  failed: number;
  skipped: number;
  recipients: number;
  delivery_rate: number;
  last_sent: string | null;
  last_status: string | null;
}

interface RecentJob {
  id: number;
  touchpoint_number: number;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  started_by: string;
  is_test: boolean;
  created_at: string;
  completed_at: string | null;
}

interface DailyPoint {
  date: string;
  sent: number;
  failed: number;
  rate: number;
}

interface DrilldownRecord {
  id: number;
  email: string;
  contact_name: string;
  org_name: string;
  status: string;
  error: string;
  touchpoint_number: number;
  job_id: number;
  sent_at: string | null;
  job_created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700",
  running: "bg-blue-50 text-blue-700",
  pending: "bg-amber-50 text-amber-700",
  cancelled: "bg-gray-100 text-gray-500",
  failed: "bg-red-50 text-red-600",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ImportGroupOption {
  id: number;
  name: string;
}

interface SegmentStat {
  id: number;
  name: string;
  group_name: string;
  contacts: number;
  active: number;
  sent: number;
  moved_to_hubspot: number;
  undeliverable: number;
  opted_out: number;
}

export default function ReportingPage() {
  const { loading: authLoading } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [contacts, setContacts] = useState<ContactStats | null>(null);
  const [touchpoints, setTouchpoints] = useState<TPStat[]>([]);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [dailyChart, setDailyChart] = useState<DailyPoint[]>([]);
  const [segments, setSegments] = useState<SegmentStat[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Filter state
  const [importGroups, setImportGroups] = useState<ImportGroupOption[]>([]);
  const [filterGroup, setFilterGroup] = useState("");
  const [filterTP, setFilterTP] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  // Drill-down state
  const [drillType, setDrillType] = useState<string | null>(null);
  const [drillRecords, setDrillRecords] = useState<DrilldownRecord[]>([]);
  const [drillTotal, setDrillTotal] = useState(0);
  const [drillPage, setDrillPage] = useState(1);
  const [drillPages, setDrillPages] = useState(1);
  const [drillLoading, setDrillLoading] = useState(false);

  function fetchStats(group = filterGroup, tp = filterTP, from = filterFrom, to = filterTo) {
    setLoaded(false);
    const params = new URLSearchParams();
    if (group) params.set("import_group", group);
    if (tp) params.set("touchpoint", tp);
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    const qs = params.toString();
    fetch(`${API}/reporting/stats/${qs ? `?${qs}` : ""}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setOverview(data.overview);
          setContacts(data.contacts);
          setTouchpoints(data.touchpoints);
          setRecentJobs(data.recent_jobs);
          setDailyChart(data.daily_chart);
          if (data.import_groups) setImportGroups(data.import_groups);
          if (data.segments) setSegments(data.segments);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }

  useEffect(() => {
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDrilldown(type: string, page = 1) {
    setDrillType(type);
    setDrillPage(page);
    setDrillLoading(true);
    try {
      const res = await fetch(`${API}/reporting/drilldown/?type=${type}&page=${page}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setDrillRecords(data.records);
        setDrillTotal(data.total);
        setDrillPages(data.pages);
      }
    } catch { /* */ }
    setDrillLoading(false);
  }

  function closeDrilldown() {
    setDrillType(null);
    setDrillRecords([]);
    setDrillTotal(0);
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f4f7]">
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      </div>
    );
  }

  const maxDailySent = dailyChart.length > 0 ? Math.max(...dailyChart.map((d) => d.sent + d.failed), 1) : 1;

  const DRILL_LABELS: Record<string, { title: string; color: string; bg: string }> = {
    sent: { title: "Sent Emails", color: "text-[#054B70]", bg: "bg-[#054B70]/10" },
    failed: { title: "Failed Emails", color: "text-red-600", bg: "bg-red-50" },
    skipped: { title: "Skipped Emails", color: "text-amber-600", bg: "bg-amber-50" },
  };

  return (
    <div className="flex min-h-screen bg-[#f0f4f7]">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-[#e0e8ee] bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <MobileMenuButton />
          <div className="min-w-0">
            <h1 className="text-[16px] font-bold text-[#0a2a3c]">Reporting</h1>
            <p className="truncate text-[11px] text-[#8ca3b3]">Campaign analytics, delivery metrics, and send history</p>
          </div>
        </header>

        {/* Filters */}
        <div className="border-b border-[#e0e8ee] bg-white px-4 py-3 sm:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
              Filters
            </div>

            {/* Import Group */}
            <select
              value={filterGroup}
              onChange={(e) => { setFilterGroup(e.target.value); fetchStats(e.target.value, filterTP, filterFrom, filterTo); }}
              className="rounded-lg border border-[#d0dce4] bg-[#f7f9fb] px-3 py-1.5 text-[12px] text-[#0a2a3c] outline-none focus:border-[#054B70] focus:ring-1 focus:ring-[#054B70]/20"
            >
              <option value="">All Groups</option>
              {importGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>

            {/* Touchpoint */}
            <select
              value={filterTP}
              onChange={(e) => { setFilterTP(e.target.value); fetchStats(filterGroup, e.target.value, filterFrom, filterTo); }}
              className="rounded-lg border border-[#d0dce4] bg-[#f7f9fb] px-3 py-1.5 text-[12px] text-[#0a2a3c] outline-none focus:border-[#054B70] focus:ring-1 focus:ring-[#054B70]/20"
            >
              <option value="">All Touchpoints</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>Touchpoint {n}</option>
              ))}
            </select>

            {/* Date From */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-[#8ca3b3]">From</span>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => { setFilterFrom(e.target.value); fetchStats(filterGroup, filterTP, e.target.value, filterTo); }}
                className="rounded-lg border border-[#d0dce4] bg-[#f7f9fb] px-3 py-1.5 text-[12px] text-[#0a2a3c] outline-none focus:border-[#054B70] focus:ring-1 focus:ring-[#054B70]/20"
              />
            </div>

            {/* Date To */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-[#8ca3b3]">To</span>
              <input
                type="date"
                value={filterTo}
                onChange={(e) => { setFilterTo(e.target.value); fetchStats(filterGroup, filterTP, filterFrom, e.target.value); }}
                className="rounded-lg border border-[#d0dce4] bg-[#f7f9fb] px-3 py-1.5 text-[12px] text-[#0a2a3c] outline-none focus:border-[#054B70] focus:ring-1 focus:ring-[#054B70]/20"
              />
            </div>

            {/* Clear filters */}
            {(filterGroup || filterTP || filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterGroup(""); setFilterTP(""); setFilterFrom(""); setFilterTo(""); fetchStats("", "", "", ""); }}
                className="btn-press flex items-center gap-1 rounded-lg bg-[#054B70]/5 px-3 py-1.5 text-[11px] font-semibold text-[#054B70] hover:bg-[#054B70]/10 transition-colors"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                Clear
              </button>
            )}
          </div>
        </div>

        <main className="p-4 sm:p-8">
          {!loaded ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-32 rounded-2xl bg-gradient-to-r from-[#f0f4f7] via-white to-[#f0f4f7] bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              {/* KPI cards — business outcomes */}
              <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6 animate-fade-in">
                {[
                  { label: "Emails Sent", value: overview?.total_sent ?? 0, sub: `${overview?.total_recipients ?? 0} recipients queued`, icon: "M12 19l9 2-9-18-9 18 9-2zm0 0v-8", color: "text-[#054B70]", bg: "bg-[#054B70]/8", drill: "sent" },
                  { label: "Delivery Rate", value: `${overview?.delivery_rate ?? 0}%`, sub: `${overview?.total_failed ?? 0} failed`, icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", color: "text-emerald-600", bg: "bg-emerald-50", drill: null },
                  { label: "Active Audience", value: contacts?.active ?? 0, sub: `of ${contacts?.total ?? 0} contacts`, icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z", color: "text-[#054B70]", bg: "bg-[#054B70]/8", drill: null },
                  { label: "Leads → HubSpot", value: contacts?.moved_to_hubspot ?? 0, sub: "moved to CRM", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6", color: "text-blue-600", bg: "bg-blue-50", drill: null },
                  { label: "Opt-outs", value: contacts?.opted_out ?? 0, sub: "unsubscribed", icon: "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636", color: "text-amber-600", bg: "bg-amber-50", drill: null },
                  { label: "Undeliverable", value: contacts?.undeliverable ?? 0, sub: "bad addresses", icon: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z", color: "text-orange-600", bg: "bg-orange-50", drill: null },
                ].map((card) => (
                  <button
                    key={card.label}
                    onClick={() => card.drill && openDrilldown(card.drill)}
                    className={`group relative overflow-hidden rounded-2xl bg-white p-5 text-left shadow-sm transition-all duration-200 ${
                      card.drill ? "cursor-pointer hover:-translate-y-0.5 hover:shadow-md" : "cursor-default"
                    }`}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${card.bg}`}>
                        <svg className={`h-[18px] w-[18px] ${card.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                          <path strokeLinecap="round" strokeLinejoin="round" d={card.icon} />
                        </svg>
                      </div>
                      {card.drill && (
                        <span className="text-[9px] font-bold uppercase tracking-wider text-[#c0cdd6] opacity-0 transition-opacity group-hover:opacity-100">View →</span>
                      )}
                    </div>
                    <p className={`text-[26px] font-bold leading-none ${card.color} tabular-nums`}>{card.value}</p>
                    <p className="mt-1.5 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">{card.label}</p>
                    <p className="mt-0.5 text-[10px] text-[#b0c4d0]">{card.sub}</p>
                  </button>
                ))}
              </div>

              {/* Two-column layout */}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">

                {/* Left: Daily Send Volume Chart */}
                <div className="xl:col-span-2 rounded-2xl bg-white p-6 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.05s" }}>
                  <div className="mb-5 flex items-center justify-between">
                    <div>
                      <h2 className="text-[14px] font-bold text-[#0a2a3c]">Send Volume</h2>
                      <p className="text-[11px] text-[#8ca3b3]">Daily emails sent over the last 30 days</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-[#054B70]" />
                        <span className="text-[10px] font-semibold text-[#8ca3b3]">Delivered</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
                        <span className="text-[10px] font-semibold text-[#8ca3b3]">Failed</span>
                      </div>
                    </div>
                  </div>

                  {dailyChart.length === 0 ? (
                    <div className="flex h-48 items-center justify-center text-[13px] text-[#8ca3b3]">
                      No send data in the last 30 days
                    </div>
                  ) : (
                    <div className="flex items-end gap-1" style={{ height: 180 }}>
                      {dailyChart.map((d) => {
                        const sentH = (d.sent / maxDailySent) * 160;
                        const failedH = (d.failed / maxDailySent) * 160;
                        return (
                          <div key={d.date} className="group relative flex flex-1 flex-col items-center justify-end" style={{ minWidth: 0 }}>
                            {/* Tooltip */}
                            <div className="pointer-events-none absolute -top-14 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#0a2a3c] px-3 py-2 text-[10px] text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                              <p className="font-bold">{formatDate(d.date)}</p>
                              <p>{d.sent} sent, {d.failed} failed ({d.rate}%)</p>
                            </div>
                            {/* Bars */}
                            {d.failed > 0 && (
                              <div
                                className="w-full rounded-t-sm bg-red-400 transition-all duration-300"
                                style={{ height: Math.max(failedH, 2) }}
                              />
                            )}
                            <div
                              className="w-full rounded-t-sm bg-[#054B70] transition-all duration-300 group-hover:bg-[#0a6a9e]"
                              style={{ height: Math.max(sentH, 2) }}
                            />
                            {/* Date label */}
                            <span className="mt-1.5 text-[8px] text-[#b0c4d0] truncate w-full text-center">
                              {new Date(d.date).getDate()}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Right: Contact Health */}
                <div className="rounded-2xl bg-white p-6 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.08s" }}>
                  <h2 className="text-[14px] font-bold text-[#0a2a3c] mb-1">Contact Health</h2>
                  <p className="text-[11px] text-[#8ca3b3] mb-5">Status breakdown of your contact list</p>

                  {contacts && (() => {
                    const pct = (v: number) => (contacts.total > 0 ? (v / contacts.total) * 100 : 0);
                    const rows = [
                      { label: "Active", value: contacts.active, color: "bg-emerald-500" },
                      { label: "Inactive", value: contacts.inactive, color: "bg-gray-400" },
                      { label: "Undeliverable", value: contacts.undeliverable, color: "bg-orange-400" },
                      { label: "Opt-out", value: contacts.opted_out, color: "bg-amber-400" },
                      { label: "Moved to HubSpot", value: contacts.moved_to_hubspot, color: "bg-blue-500" },
                    ].filter((r) => r.value > 0);
                    return (
                    <div className="space-y-4">
                      {/* Visual bar */}
                      <div className="flex h-4 w-full overflow-hidden rounded-full bg-[#f0f4f7]">
                        {contacts.total > 0 && rows.map((r) => (
                          <div key={r.label} className={`${r.color} transition-all duration-500`} style={{ width: `${pct(r.value)}%` }} title={`${r.label}: ${r.value}`} />
                        ))}
                      </div>

                      {/* Breakdown list */}
                      {rows.map((item) => (
                        <div key={item.label} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
                            <span className="text-[12px] font-medium text-[#4a6a7a]">{item.label}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-bold text-[#0a2a3c]">{item.value}</span>
                            <span className="w-8 text-right text-[10px] font-semibold text-[#8ca3b3]">{Math.round(pct(item.value))}%</span>
                          </div>
                        </div>
                      ))}

                      <div className="flex items-center justify-between border-t border-[#f0f4f7] pt-3">
                        <span className="text-[12px] font-semibold text-[#8ca3b3]">Total contacts</span>
                        <span className="text-[14px] font-bold text-[#0a2a3c]">{contacts.total}</span>
                      </div>
                    </div>
                    );
                  })()}
                </div>
              </div>

              {/* Touchpoint Performance */}
              {touchpoints.length > 0 && (
                <div className="rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
                  <div className="px-6 py-5 border-b border-[#f0f4f7]">
                    <h2 className="text-[14px] font-bold text-[#0a2a3c]">Touchpoint Performance</h2>
                    <p className="text-[11px] text-[#8ca3b3]">Delivery metrics per touchpoint</p>
                  </div>
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-[#e8eff3] text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                        <th className="px-6 py-3">Touchpoint</th>
                        <th className="px-6 py-3">Jobs</th>
                        <th className="px-6 py-3">Recipients</th>
                        <th className="px-6 py-3">Delivered</th>
                        <th className="px-6 py-3">Failed</th>
                        <th className="px-6 py-3">Delivery Rate</th>
                        <th className="px-6 py-3">Last Sent</th>
                        <th className="px-6 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {touchpoints.map((tp) => (
                        <tr key={tp.touchpoint_number} className="border-b border-[#f0f4f7] transition-colors hover:bg-[#f7f9fb]">
                          <td className="px-6 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#054B70]/10 text-[12px] font-bold text-[#054B70]">
                                {tp.touchpoint_number}
                              </div>
                              <span className="text-[13px] font-semibold text-[#0a2a3c]">TP {tp.touchpoint_number}</span>
                            </div>
                          </td>
                          <td className="px-6 py-3.5 text-[13px] font-medium text-[#4a6a7a]">{tp.total_jobs}</td>
                          <td className="px-6 py-3.5 text-[13px] font-medium text-[#4a6a7a]">{tp.recipients}</td>
                          <td className="px-6 py-3.5">
                            <span className="text-[13px] font-bold text-emerald-600">{tp.sent}</span>
                          </td>
                          <td className="px-6 py-3.5">
                            <span className={`text-[13px] font-bold ${tp.failed > 0 ? "text-red-500" : "text-[#8ca3b3]"}`}>{tp.failed}</span>
                          </td>
                          <td className="px-6 py-3.5">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#f0f4f7]">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${tp.delivery_rate >= 90 ? "bg-emerald-500" : tp.delivery_rate >= 70 ? "bg-amber-500" : "bg-red-500"}`}
                                  style={{ width: `${tp.delivery_rate}%` }}
                                />
                              </div>
                              <span className={`text-[12px] font-bold ${tp.delivery_rate >= 90 ? "text-emerald-600" : tp.delivery_rate >= 70 ? "text-amber-600" : "text-red-500"}`}>
                                {tp.delivery_rate}%
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-3.5 text-[12px] text-[#8ca3b3]">
                            {tp.last_sent ? timeAgo(tp.last_sent) : "—"}
                          </td>
                          <td className="px-6 py-3.5">
                            {tp.last_status && (
                              <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[tp.last_status] || "bg-gray-100 text-gray-500"}`}>
                                {tp.last_status}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Per-Segment Performance */}
              <div className="rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in-up" style={{ animationDelay: "0.12s" }}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-5 border-b border-[#f0f4f7]">
                  <div>
                    <h2 className="text-[14px] font-bold text-[#0a2a3c]">Segment Performance</h2>
                    <p className="text-[11px] text-[#8ca3b3]">Emails sent, leads, and outcomes per segment</p>
                  </div>
                </div>
                {segments.length === 0 ? (
                  <div className="px-6 py-10 text-center text-[13px] text-[#8ca3b3]">
                    No segments yet. Tag contacts into a segment on the Contacts page to track them here.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[700px] text-left">
                      <thead>
                        <tr className="border-b border-[#e8eff3] text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                          <th className="px-6 py-3">Segment</th>
                          <th className="px-4 py-3 text-right">Contacts</th>
                          <th className="px-4 py-3 text-right">Emails Sent</th>
                          <th className="px-4 py-3 text-right">Leads → HubSpot</th>
                          <th className="px-4 py-3 text-right">Undeliverable</th>
                          <th className="px-4 py-3 text-right">Opt-outs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {segments.map((s) => (
                          <tr key={s.id} className="border-b border-[#f0f4f7] hover:bg-[#f7f9fb] transition-colors">
                            <td className="px-6 py-3.5">
                              <p className="text-[13px] font-semibold text-[#0a2a3c]">{s.name}</p>
                              <p className="text-[11px] text-[#8ca3b3]">{s.group_name}</p>
                            </td>
                            <td className="px-4 py-3.5 text-right text-[13px] font-medium text-[#0a2a3c] tabular-nums">{s.contacts}</td>
                            <td className="px-4 py-3.5 text-right text-[13px] font-semibold text-[#054B70] tabular-nums">{s.sent}</td>
                            <td className="px-4 py-3.5 text-right text-[13px] font-medium text-blue-600 tabular-nums">{s.moved_to_hubspot}</td>
                            <td className="px-4 py-3.5 text-right text-[13px] font-medium text-orange-600 tabular-nums">{s.undeliverable}</td>
                            <td className="px-4 py-3.5 text-right text-[13px] font-medium text-amber-600 tabular-nums">{s.opted_out}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Recent Activity */}
              <div className="rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in-up" style={{ animationDelay: "0.13s" }}>
                <div className="px-6 py-5 border-b border-[#f0f4f7]">
                  <h2 className="text-[14px] font-bold text-[#0a2a3c]">Recent Activity</h2>
                  <p className="text-[11px] text-[#8ca3b3]">Last 10 send jobs</p>
                </div>
                {recentJobs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-[#8ca3b3]">
                    <svg className="mb-3 h-10 w-10 text-[#d0dce4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1">
                      <path d="M3 3v18h18M9 17V9m4 8V5m4 12v-4" />
                    </svg>
                    <p className="text-[13px] font-semibold">No send jobs yet</p>
                    <p className="mt-1 text-[11px]">Send your first email campaign from Email Templates</p>
                  </div>
                ) : (
                  <div className="divide-y divide-[#f0f4f7]">
                    {recentJobs.map((job) => {
                      const processed = job.sent_count + job.failed_count + job.skipped_count;
                      const deliveryRate = (job.sent_count + job.failed_count) > 0
                        ? Math.round((job.sent_count / (job.sent_count + job.failed_count)) * 100)
                        : 0;

                      return (
                        <div key={job.id} className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-[#f7f9fb]">
                          {/* TP badge */}
                          <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-[13px] font-bold ${
                            job.status === "running" ? "bg-blue-100 text-blue-700" :
                            job.status === "completed" ? "bg-[#054B70]/10 text-[#054B70]" :
                            job.status === "cancelled" ? "bg-gray-100 text-gray-500" :
                            "bg-red-50 text-red-500"
                          }`}>
                            {job.touchpoint_number}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-semibold text-[#0a2a3c]">
                                Touchpoint {job.touchpoint_number}
                              </span>
                              {job.is_test && (
                                <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[9px] font-semibold text-purple-600">TEST</span>
                              )}
                              <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${STATUS_COLORS[job.status] || "bg-gray-100 text-gray-500"}`}>
                                {job.status}
                              </span>
                            </div>
                            <p className="text-[11px] text-[#8ca3b3] mt-0.5">
                              {formatDateTime(job.created_at)} by {job.started_by}
                              {job.completed_at && ` · Finished ${formatDateTime(job.completed_at)}`}
                            </p>
                          </div>

                          {/* Stats */}
                          <div className="flex items-center gap-5 text-[12px]">
                            <div className="text-center">
                              <p className="font-bold text-emerald-600">{job.sent_count}</p>
                              <p className="text-[9px] font-semibold text-[#8ca3b3]">Sent</p>
                            </div>
                            <div className="text-center">
                              <p className={`font-bold ${job.failed_count > 0 ? "text-red-500" : "text-[#8ca3b3]"}`}>{job.failed_count}</p>
                              <p className="text-[9px] font-semibold text-[#8ca3b3]">Failed</p>
                            </div>
                            <div className="text-center">
                              <p className={`font-bold ${job.skipped_count > 0 ? "text-amber-500" : "text-[#8ca3b3]"}`}>{job.skipped_count}</p>
                              <p className="text-[9px] font-semibold text-[#8ca3b3]">Skipped</p>
                            </div>
                            <div className="w-16">
                              <div className="flex items-center justify-between mb-0.5">
                                <span className="text-[10px] font-bold text-[#054B70]">{deliveryRate}%</span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f0f4f7]">
                                <div
                                  className={`h-full rounded-full ${deliveryRate >= 90 ? "bg-emerald-500" : deliveryRate >= 70 ? "bg-amber-500" : "bg-red-500"}`}
                                  style={{ width: `${deliveryRate}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </MainContent>

      {/* Drill-down modal */}
      {drillType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={closeDrilldown}>
          <div className="w-full max-w-6xl mx-4 max-h-[85vh] flex flex-col rounded-2xl bg-white shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#f0f4f7]">
              <div className="flex items-center gap-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${DRILL_LABELS[drillType]?.bg}`}>
                  <svg className={`h-4.5 w-4.5 ${DRILL_LABELS[drillType]?.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    {drillType === "sent" && <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />}
                    {drillType === "failed" && <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />}
                    {drillType === "skipped" && <path d="M13 5l7 7-7 7M5 5l7 7-7 7" />}
                  </svg>
                </div>
                <div>
                  <h2 className="text-[15px] font-bold text-[#0a2a3c]">{DRILL_LABELS[drillType]?.title}</h2>
                  <p className="text-[11px] text-[#8ca3b3]">{drillTotal} total records</p>
                </div>
              </div>
              <button onClick={closeDrilldown} className="rounded-lg p-2 text-[#8ca3b3] hover:bg-[#f0f4f7] transition-colors">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              {drillLoading ? (
                <div className="flex items-center justify-center py-16">
                  <svg className="h-6 w-6 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              ) : drillRecords.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-[13px] text-[#8ca3b3]">
                  No records found
                </div>
              ) : (
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-[#e8eff3] text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <th className="px-6 py-3">Contact</th>
                      <th className="px-6 py-3">Email</th>
                      <th className="px-6 py-3">Organization</th>
                      <th className="px-6 py-3">TP</th>
                      <th className="px-6 py-3">Date</th>
                      {drillType === "failed" && <th className="px-6 py-3">Error</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {drillRecords.map((r) => (
                      <tr key={r.id} className="border-b border-[#f0f4f7] hover:bg-[#f7f9fb] transition-colors">
                        <td className="px-6 py-3 text-[13px] font-medium text-[#0a2a3c]">{r.contact_name || "—"}</td>
                        <td className="px-6 py-3 text-[13px] text-[#6b8a9e] font-mono">{r.email}</td>
                        <td className="px-6 py-3 text-[13px] text-[#4a6a7a]">{r.org_name || "—"}</td>
                        <td className="px-6 py-3">
                          <span className="rounded-full bg-[#054B70]/8 px-2 py-0.5 text-[10px] font-semibold text-[#054B70]">
                            TP {r.touchpoint_number}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-[12px] text-[#8ca3b3]">
                          {r.sent_at ? formatDateTime(r.sent_at) : formatDateTime(r.job_created_at)}
                        </td>
                        {drillType === "failed" && (
                          <td className="px-6 py-3 text-[12px] text-red-500 max-w-[200px] truncate" title={r.error}>
                            {r.error || "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            {drillPages > 1 && (
              <div className="flex items-center justify-between border-t border-[#f0f4f7] px-6 py-3">
                <span className="text-[11px] text-[#8ca3b3]">
                  Page {drillPage} of {drillPages}
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={drillPage <= 1}
                    onClick={() => openDrilldown(drillType, drillPage - 1)}
                    className="rounded-lg border border-[#d0dce4] px-3 py-1.5 text-[11px] font-semibold text-[#6b8a9e] disabled:opacity-30 hover:bg-[#f0f4f7] transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    disabled={drillPage >= drillPages}
                    onClick={() => openDrilldown(drillType, drillPage + 1)}
                    className="rounded-lg border border-[#d0dce4] px-3 py-1.5 text-[11px] font-semibold text-[#6b8a9e] disabled:opacity-30 hover:bg-[#f0f4f7] transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
