"use client";

import { useState, useEffect, useRef } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import Select from "../components/Select";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface SendJob {
  id: number;
  touchpoint_number: number;
  campaign_id: number | null;
  campaign_name: string;
  subject: string;
  template_name: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  soft_bounces: number;
  hard_bounces: number;
  optout_count: number;
  target_summary: string;
  started_by?: string;
  is_test?: boolean;
  created_at: string;
  completed_at: string | null;
  current_contact?: string | null;
}

interface ReportPerson {
  email: string;
  contact_name: string;
  org_name: string;
  error: string;
  sent_at: string | null;
}

interface JobReport {
  job: SendJob & { template_name?: string };
  failure_reasons: { kind: string; reason: string; count: number }[];
  people: Record<string, ReportPerson[]>;
}

/** Laravel-style diffForHumans: "3 minutes ago". */
function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

/** Beacon's finished stamp: "Sun, 3 May 2026 9:05 AM". */
function finishedStamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${date} ${time}`;
}

const HISTORY_STATUSES = ["completed", "cancelled", "failed"];

export default function SendProgressPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [jobs, setJobs] = useState<SendJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History filters — '' / 'all' / false means no filtering (like Beacon)
  const [histCampaign, setHistCampaign] = useState("");
  const [histStatus, setHistStatus] = useState("all");
  const [histFailuresOnly, setHistFailuresOnly] = useState(false);

  // "New Send" modal — pick the email and who receives it
  const [nsOpen, setNsOpen] = useState(false);
  const [nsCampaignId, setNsCampaignId] = useState("");
  const [nsTouchpoint, setNsTouchpoint] = useState("");
  const [nsTemplateId, setNsTemplateId] = useState("");
  const [nsGroupId, setNsGroupId] = useState("");
  const [nsSegmentIds, setNsSegmentIds] = useState<string[]>([]);
  const [nsTagIds, setNsTagIds] = useState<string[]>([]);
  const [nsStarting, setNsStarting] = useState(false);
  const [campaigns, setCampaigns] = useState<{ id: number; name: string; segment_id: number | null }[]>([]);
  const [nsTPs, setNsTPs] = useState<{ touchpoint_number: number; subject: string }[]>([]);
  const [libraryTemplates, setLibraryTemplates] = useState<{ id: number; name: string }[]>([]);
  const [importGroups, setImportGroups] = useState<{ id: number; name: string }[]>([]);
  const [segments, setSegments] = useState<{ id: number; name: string }[]>([]);

  // Per-send report (opened by clicking a history card)
  const [report, setReport] = useState<JobReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportTab, setReportTab] = useState<"sent" | "failed" | "skipped">("sent");

  async function openReport(jobId: number) {
    setReportLoading(true);
    setReport(null);
    try {
      const res = await fetch(`${API}/send/report/?job_id=${jobId}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setReport(data);
        setReportTab(data.job.failed_count > 0 ? "failed" : "sent");
      } else {
        showToast(data.error || "Could not load the report");
      }
    } catch {
      showToast("Could not load the report");
    }
    setReportLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function fetchJobs() {
    try {
      const res = await fetch(`${API}/send/progress/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setJobs(data.jobs);
    } catch { /* */ }
    setLoaded(true);
  }

  useEffect(() => {
    fetchJobs();
    pollingRef.current = setInterval(fetchJobs, 2000);
    // Options for the New Send modal
    Promise.all([
      fetch(`${API}/campaigns/`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/templates-library/`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/contacts/`, { credentials: "include" }).then((r) => r.json()),
    ])
      .then(([cData, tData, contactData]) => {
        if (cData?.ok && Array.isArray(cData.campaigns)) setCampaigns(cData.campaigns);
        if (tData?.ok && Array.isArray(tData.templates)) setLibraryTemplates(tData.templates);
        if (contactData?.ok) {
          if (contactData.import_groups) setImportGroups(contactData.import_groups);
          if (contactData.segments) setSegments(contactData.segments);
        }
      })
      .catch(() => {});
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hasRunning = jobs.some((j) => j.status === "running" || j.status === "pending");
    if (!hasRunning && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    } else if (hasRunning && !pollingRef.current) {
      pollingRef.current = setInterval(fetchJobs, 2000);
    }
  }, [jobs]);

  // Picking a campaign loads its touchpoints and prefills its default audience
  function pickCampaign(id: string) {
    setNsCampaignId(id);
    setNsTouchpoint("");
    setNsTPs([]);
    const campaign = campaigns.find((c) => String(c.id) === id);
    setNsSegmentIds(campaign?.segment_id ? [String(campaign.segment_id)] : []);
    if (!id) return;
    fetch(`${API}/flow/board/?campaign_id=${id}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setNsTPs(d.touchpoints); })
      .catch(() => {});
  }

  async function startSend(touchpointNumber?: number, campaignId?: number | null) {
    const tp = touchpointNumber ?? Number(nsTouchpoint);
    const cid = campaignId !== undefined ? campaignId : (nsCampaignId ? Number(nsCampaignId) : undefined);
    if (!tp) return;
    setNsStarting(true);
    try {
      const res = await fetch(`${API}/send/start/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touchpoint_number: tp,
          only_unsent: true,
          ...(cid ? { campaign_id: cid } : {}),
          ...(touchpointNumber === undefined && nsTemplateId ? { template_id: Number(nsTemplateId) } : {}),
          ...(touchpointNumber === undefined && nsGroupId ? { import_group_id: Number(nsGroupId) } : {}),
          ...(touchpointNumber === undefined && nsSegmentIds.length ? { segment_ids: nsSegmentIds.map(Number) } : {}),
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast("Send started — watch its progress fill in below.");
        setNsOpen(false);
        fetchJobs();
        if (!pollingRef.current) pollingRef.current = setInterval(fetchJobs, 2000);
      } else {
        showToast(data.error || "Failed to start send");
      }
    } catch {
      showToast("Network error");
    }
    setNsStarting(false);
  }

  async function cancelJob(jobId: number) {
    try {
      const res = await fetch(`${API}/send/cancel/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast("Send cancelled");
        fetchJobs();
      } else {
        showToast(data.error || "Cannot cancel");
      }
    } catch { /* */ }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "pending");
  const allHistory = jobs.filter((j) => HISTORY_STATUSES.includes(j.status));
  const filtersActive = histCampaign !== "" || histStatus !== "all" || histFailuresOnly;
  const historyJobs = allHistory
    .filter((j) => (histCampaign === "" ? true : String(j.campaign_id ?? "") === histCampaign))
    .filter((j) => (histStatus === "all" ? true : j.status === histStatus))
    .filter((j) => (histFailuresOnly ? j.failed_count > 0 : true));

  // Campaigns that appear in history, for the filter dropdown
  const histCampaignOptions = Array.from(
    new Map(allHistory.filter((j) => j.campaign_id).map((j) => [String(j.campaign_id), j.campaign_name || "Campaign"])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  const jobTitle = (j: SendJob) => `${j.campaign_name || "Campaign"} · Touchpoint ${j.touchpoint_number || "?"}`;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div className="min-w-0">
              <p className="text-[11px] text-gray-400">Sends <span className="mx-1">›</span> List Campaign Sends</p>
              <h1 className="text-[16px] font-bold text-gray-900">Send Progress</h1>
              <p className="truncate text-[11px] text-gray-500">Track bulk sends live — every run, its outcome, and what&apos;s coming up.</p>
            </div>
          </div>
          {canEdit && (
            <button
              onClick={() => { setNsOpen(true); setNsCampaignId(""); setNsTouchpoint(""); setNsTemplateId(""); setNsGroupId(""); setNsSegmentIds([]); setNsTagIds([]); setNsTPs([]); }}
              className="btn-press flex shrink-0 items-center gap-2 rounded-lg bg-[#054B70] px-3 py-2 text-[12px] font-bold text-white sm:px-5 sm:py-2.5"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
              New Send
            </button>
          )}
        </header>

        <main className="p-4 sm:p-8">
          {toast && (
            <div className="mb-5 flex items-center gap-2 rounded-lg bg-[#054B70]/5 px-4 py-3 text-[13px] font-semibold text-[#054B70] animate-slide-in">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
              {toast}
            </div>
          )}

          {!loaded ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-28 rounded-xl bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Nothing at all yet — dashed empty state, like Beacon */}
              {activeJobs.length === 0 && allHistory.length === 0 && !filtersActive && (
                <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-400/40 px-4 py-16">
                  <svg className="h-10 w-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
                  <p className="text-[14px] font-semibold text-gray-900">No sends yet</p>
                  <p className="text-[13px] text-gray-500">Start a bulk send to watch its progress here.</p>
                </div>
              )}

              {/* ── Active / running sends — big live cards ── */}
              {activeJobs.map((job) => {
                const processed = job.sent_count + job.failed_count + job.skipped_count;
                const pct = job.total_recipients > 0 ? Math.round((processed / job.total_recipients) * 100) : 0;
                const running = job.status === "running";

                return (
                  <div key={job.id} className="overflow-hidden rounded-2xl border border-blue-600/25 bg-white shadow-sm">
                    {/* accent bar */}
                    <div className="h-1 bg-gradient-to-r from-[#1d4ed8] via-[#60a5fa] to-[#1d4ed8]" />

                    <div className="px-5 py-4">
                      {/* header */}
                      <div className="mb-2.5 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#1d4ed8] text-[13px] font-extrabold text-white">
                            {job.touchpoint_number || "—"}
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5 text-[14px] font-bold text-gray-950">
                              {jobTitle(job)}
                              {job.is_test && <span className="rounded bg-purple-600/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple-600">Test</span>}
                            </div>
                            <div className="text-[11px] text-gray-500">
                              Started {timeAgo(job.created_at)}
                              {job.template_name && <> · <span className="font-semibold text-[#1d4ed8]">via &ldquo;{job.template_name}&rdquo;</span></>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2.5">
                          {running ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-600/30 bg-blue-600/[.08] px-3 py-1 text-[11px] font-semibold text-[#1d4ed8]">
                              <span className="relative inline-flex h-2 w-2">
                                <span className="absolute inset-0 animate-ping rounded-full bg-[#60a5fa] opacity-75" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#2563eb]" />
                              </span>
                              Sending…
                            </span>
                          ) : (
                            <span className="rounded-full bg-gray-400/15 px-3 py-1 text-[11px] font-semibold text-gray-500">Queued</span>
                          )}
                          {canEdit && (
                            <button
                              onClick={() => cancelJob(job.id)}
                              className="rounded-lg border border-red-500/40 px-3 py-1.5 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-50"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>

                      {/* live counter + currently sending to, one tight row */}
                      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[22px] font-extrabold leading-none text-[#1d4ed8] tabular-nums">{processed}</span>
                        <span className="text-[13px] font-medium text-slate-400">/ {job.total_recipients}</span>
                        <span className="text-[12px] font-bold text-[#1d4ed8]">{pct}%</span>
                        {running && job.current_contact && (
                          <span className="ml-2 text-[12px] text-[#6b8a9e]">
                            · sending to <strong className="text-gray-900">{job.current_contact}</strong>
                          </span>
                        )}
                      </div>

                      {/* progress bar */}
                      <div className="mb-2.5 h-2 w-full overflow-hidden rounded-full bg-gray-400/20">
                        <div className="h-full rounded-full bg-gradient-to-r from-[#1d4ed8] to-[#60a5fa] transition-all duration-700 ease-out" style={{ width: `${pct}%` }} />
                      </div>

                      {/* stat pills */}
                      <div className="flex flex-wrap gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/[.12] px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" /> Sent {job.sent_count}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/[.12] px-2.5 py-1 text-[11px] font-semibold text-red-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444]" /> Failed {job.failed_count}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/[.14] px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#f59e0b]" /> Skipped {job.skipped_count}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* ── History — newest first ── */}
              <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">History — newest first</p>

              {/* filter toolbar */}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-400/20 bg-gray-500/[.03] px-3.5 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[#6b8a9e]">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
                  </svg>
                  Filter
                </span>
                <Select
                  value={histCampaign}
                  onChange={setHistCampaign}
                  options={[{ value: "", label: "All campaigns" }, ...histCampaignOptions.map(([id, name]) => ({ value: id, label: name }))]}
                  size="sm"
                  className="min-w-[10.5rem]"
                />
                <Select
                  value={histStatus}
                  onChange={setHistStatus}
                  options={[
                    { value: "all", label: "All outcomes" },
                    { value: "completed", label: "Completed" },
                    { value: "cancelled", label: "Cancelled" },
                    { value: "failed", label: "Failed" },
                  ]}
                  size="sm"
                  className="min-w-[10.5rem]"
                />
                <label className={`inline-flex cursor-pointer select-none items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                  histFailuresOnly ? "border-red-500/45 bg-red-500/[.08] text-red-700" : "border-gray-400/30 text-[#6b8a9e]"
                }`}>
                  <input type="checkbox" checked={histFailuresOnly} onChange={(e) => setHistFailuresOnly(e.target.checked)} className="accent-red-500" />
                  Only with failures
                </label>
                {filtersActive && (
                  <button
                    onClick={() => { setHistCampaign(""); setHistStatus("all"); setHistFailuresOnly(false); }}
                    className="ml-auto rounded-lg border border-gray-400/30 px-3 py-1.5 text-[12px] font-semibold text-gray-700 transition-colors hover:bg-gray-100"
                  >
                    Clear filters ✕
                  </button>
                )}
              </div>

              {historyJobs.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-400/30 px-4 py-6 text-center text-[13px] text-gray-500">
                  Nothing matches these filters.
                </div>
              )}

              {historyJobs.map((job) => {
                const processed = job.sent_count + job.failed_count + job.skipped_count;
                const pct = job.total_recipients > 0 ? Math.round((processed / job.total_recipients) * 100) : 0;
                const barColor = job.status === "completed" ? "#10b981" : job.status === "cancelled" ? "#f59e0b" : "#ef4444";
                const badge = job.status === "completed"
                  ? { bg: "bg-emerald-500/[.12]", fg: "text-emerald-800", dot: "#10b981" }
                  : job.status === "cancelled"
                  ? { bg: "bg-amber-500/[.14]", fg: "text-amber-700", dot: "#f59e0b" }
                  : { bg: "bg-red-500/[.12]", fg: "text-red-700", dot: "#ef4444" };

                return (
                  <div
                    key={job.id}
                    onClick={() => openReport(job.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") openReport(job.id); }}
                    title="Click anywhere for this send's full details"
                    className="cursor-pointer rounded-[0.85rem] border border-gray-400/20 bg-white px-4 py-4 shadow-sm transition-all duration-150 hover:-translate-y-px hover:border-blue-600/40 hover:shadow-md"
                  >
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-[2.1rem] w-[2.1rem] shrink-0 items-center justify-center rounded-[0.55rem] bg-blue-600/10 text-[13px] font-bold text-[#1d4ed8]">
                          {job.touchpoint_number || "—"}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5 text-[13px] font-bold text-gray-950">
                            {jobTitle(job)}
                            {job.is_test && <span className="rounded bg-purple-600/15 px-1 py-0.5 text-[9px] font-bold uppercase text-purple-600">Test</span>}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {job.subject && <>&ldquo;{job.subject.length > 60 ? `${job.subject.slice(0, 60)}…` : job.subject}&rdquo; · </>}
                            to {job.target_summary || "all contacts"}
                            {job.template_name && <> · <span className="text-[#1d4ed8]">via &ldquo;{job.template_name}&rdquo;</span></>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${badge.bg} ${badge.fg}`}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: badge.dot }} />
                          {job.status}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openReport(job.id); }}
                          title="See exactly who received it, who was skipped and who failed"
                          className="rounded-md border border-gray-400/35 px-2.5 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          Details
                        </button>
                        {canEdit && (job.status === "failed" || job.status === "cancelled") && job.touchpoint_number > 0 && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startSend(job.touchpoint_number, job.campaign_id); }}
                            className="rounded-md border border-blue-600/35 px-2.5 py-1 text-[11px] font-semibold text-[#1d4ed8] hover:bg-blue-50"
                          >
                            Send again
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="mb-2.5 flex items-center gap-3">
                      <div className="h-[0.45rem] flex-1 overflow-hidden rounded-full bg-gray-400/20">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
                      </div>
                      <span className="text-[12px] font-bold text-gray-900 tabular-nums">{processed}/{job.total_recipients}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[#6b8a9e]">
                      <span title="See exactly who it went through to">Sent <strong className="text-emerald-800">{job.sent_count}</strong></span>
                      <span title="See who failed and why">Failed <strong className="text-red-700">{job.failed_count}</strong></span>
                      <span title="Soft bounce = temporary failure (mailbox full, timeout) — worth retrying.">Soft bounces <strong className="text-amber-700">{job.soft_bounces}</strong></span>
                      <span title="Hard bounce = permanent failure (address does not exist) — stop sending.">Hard bounces <strong className="text-red-700">{job.hard_bounces}</strong></span>
                      <span title="See who was skipped and why">Skipped <strong className="text-amber-700">{job.skipped_count}</strong></span>
                      <span title="Recipients of this run who opted out after it">Opt-outs <strong className="text-purple-800">{job.optout_count}</strong></span>
                      {job.completed_at && (
                        <span className="ml-auto text-[11px] text-slate-400">
                          Finished {finishedStamp(job.completed_at)} ({timeAgo(job.completed_at)})
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </MainContent>

      {/* Per-send detail modal — every recipient of the run and what happened */}
      {(report || reportLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => { setReport(null); setReportLoading(false); }}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            {reportLoading || !report ? (
              <div className="flex items-center justify-center py-16">
                <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            ) : (
              <>
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="text-[16px] font-bold text-gray-900">
                    {report.job.campaign_name || "Send"} · Touchpoint {report.job.touchpoint_number || "?"}
                    {report.job.is_test && <span className="ml-2 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-purple-600">Test</span>}
                  </h2>
                  <button onClick={() => setReport(null)} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <p className="mb-4 text-[11px] text-gray-500">
                  Every recipient of this run and what happened to them.
                  {report.job.started_by && ` Started by ${report.job.started_by}.`}
                  {report.job.template_name && ` Sent via "${report.job.template_name}".`}
                </p>

                {/* Tiles */}
                <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: "Arrived", value: report.job.sent_count, cls: "bg-emerald-50 text-emerald-700" },
                    { label: "Failed", value: report.job.failed_count, cls: "bg-red-50 text-red-600" },
                    { label: "Skipped", value: report.job.skipped_count, cls: "bg-amber-50 text-amber-700" },
                    { label: "Recipients", value: report.job.total_recipients, cls: "bg-[#054B70]/5 text-[#054B70]" },
                  ].map((t) => (
                    <div key={t.label} className={`rounded-xl p-4 ${t.cls}`}>
                      <p className="text-[22px] font-bold leading-none">{t.value}</p>
                      <p className="mt-1 text-[11px] font-semibold opacity-80">{t.label}</p>
                    </div>
                  ))}
                </div>

                {/* Failure reasons grouped with bars */}
                {report.failure_reasons.length > 0 && (
                  <div className="mb-5">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">Why they failed</p>
                    <div className="space-y-2">
                      {report.failure_reasons.map((r) => {
                        const max = report.failure_reasons[0].count;
                        return (
                          <div key={`${r.kind}-${r.reason}`}>
                            <div className="mb-0.5 flex items-center justify-between text-[11px]">
                              <span className="font-medium text-gray-600">
                                {r.reason}
                                <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                  r.kind === "hard" ? "bg-red-50 text-red-500" : r.kind === "soft" ? "bg-amber-50 text-amber-600" : "bg-gray-100 text-gray-500"
                                }`}>{r.kind}</span>
                              </span>
                              <span className="font-bold text-gray-900 tabular-nums">{r.count}</span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                              <div
                                className={`h-full rounded-full ${r.kind === "hard" ? "bg-red-400" : r.kind === "soft" ? "bg-amber-400" : "bg-gray-300"}`}
                                style={{ width: `${Math.max(6, (r.count / max) * 100)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Per-person lists */}
                <div className="mb-3 flex gap-1 rounded-lg bg-gray-100 p-1">
                  {(["sent", "failed", "skipped"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setReportTab(tab)}
                      className={`flex-1 rounded-lg py-2 text-[12px] font-bold capitalize transition-colors ${
                        reportTab === tab ? "bg-white text-[#054B70] shadow-sm ring-1 ring-gray-950/5" : "text-gray-500 hover:text-[#054B70]"
                      }`}
                    >
                      {tab === "sent" ? "Went through" : tab} ({(report.people[tab] || []).length})
                    </button>
                  ))}
                </div>
                {(report.people[reportTab] || []).length === 0 ? (
                  <p className="py-6 text-center text-[12px] text-gray-500">Nobody in this list.</p>
                ) : (
                  <div className="grid max-h-72 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                    {(report.people[reportTab] || []).map((p, i) => (
                      <div key={`${p.email}-${i}`} className="min-w-0 rounded-md border border-gray-400/15 bg-gray-500/[.03] px-2.5 py-1.5">
                        <p className="truncate text-[12px] font-semibold text-gray-900">{p.contact_name || p.org_name || p.email}</p>
                        <p className="truncate text-[11px] text-gray-500">{p.email}</p>
                        {p.error && reportTab !== "sent" && (
                          <p className="mt-0.5 truncate text-[10px] text-red-400" title={p.error}>{p.error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Link through to this campaign's report — like Beacon's sendDetail footer */}
                {(() => {
                  const cid = jobs.find((j) => j.id === report.job.id)?.campaign_id;
                  return cid ? (
                    <div className="mt-4 border-t border-gray-400/15 pt-3">
                      <a href={`/reporting?campaign_id=${cid}`} className="text-[13px] font-semibold text-[#0369a1] hover:underline">
                        See the full report for this campaign →
                      </a>
                    </div>
                  ) : null;
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* "New Send" — Start Bulk Send (matches Beacon's modal) */}
      {nsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setNsOpen(false)}>
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              title="Close"
              aria-label="Close"
              onClick={() => setNsOpen(false)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Start Bulk Send</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              Sends the picked touchpoint to its eligible audience — for real. Runs cap at 500 contacts unless you set a limit.
            </p>

            <label className="mb-1 block text-[13px] font-medium text-gray-950">Campaign<sup className="text-red-600">*</sup></label>
            <Select
              value={nsCampaignId}
              onChange={pickCampaign}
              searchable
              options={campaigns.map((c) => ({ value: String(c.id), label: c.name }))}
              placeholder="Select an option"
              className="mb-4"
            />

            {nsCampaignId && (
              <>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">Touchpoint<sup className="text-red-600">*</sup></label>
                <Select
                  value={nsTouchpoint}
                  onChange={setNsTouchpoint}
                  searchable
                  options={nsTPs.map((t) => ({
                    value: String(t.touchpoint_number),
                    label: `Touchpoint ${t.touchpoint_number}${t.subject ? ` — ${t.subject}` : ""}`,
                  }))}
                  placeholder="Select an option"
                  className="mb-4"
                />
              </>
            )}

            <label className="mb-1 block text-[13px] font-medium text-gray-950">Template (optional)</label>
            <Select
              value={nsTemplateId}
              onChange={setNsTemplateId}
              searchable
              options={[{ value: "", label: "Select an option" }, ...libraryTemplates.map((t) => ({ value: String(t.id), label: t.name }))]}
              placeholder="Select an option"
              className="mb-1"
            />
            <p className="mb-4 text-[12px] text-gray-500">Send a saved template from the Template Library instead of the touchpoint&apos;s own content. Leave blank to use the touchpoint.</p>

            <label className="mb-1 block text-[13px] font-medium text-gray-950">Target group</label>
            <Select
              value={nsGroupId}
              onChange={setNsGroupId}
              searchable
              options={[{ value: "", label: "Select an option" }, ...importGroups.map((g) => ({ value: String(g.id), label: g.name }))]}
              placeholder="Select an option"
              className="mb-1"
            />
            <p className="mb-4 text-[12px] text-gray-500">Who to send to. Leave blank to target all contacts.</p>

            <label className="mb-1 block text-[13px] font-medium text-gray-950">Target segments</label>
            <Select
              multiple
              searchable
              values={nsSegmentIds}
              onToggle={(v) => setNsSegmentIds((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))}
              options={segments.map((s) => ({ value: String(s.id), label: s.name }))}
              placeholder="Select an option"
              className="mb-1"
            />
            <p className="mb-4 text-[12px] text-gray-500">Pick as many as you need — the audience is everyone in ANY of them. Dynamic segments compute from tags and dimensions.</p>

            <label className="mb-1 block text-[13px] font-medium text-gray-950">Target tags</label>
            <Select
              multiple
              searchable
              values={nsTagIds}
              onToggle={(v) => setNsTagIds((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))}
              options={[]}
              placeholder="Select an option"
              className="mb-1"
            />
            <p className="mb-5 text-[12px] text-gray-500">Also include every contact carrying ANY of these tags. Contacts who already received the touchpoint are always skipped.</p>

            <div className="flex justify-end gap-2">
              <button onClick={() => setNsOpen(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={() => startSend()}
                disabled={nsStarting || !nsCampaignId || !nsTouchpoint}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {nsStarting ? "Starting…" : "Start sending"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

