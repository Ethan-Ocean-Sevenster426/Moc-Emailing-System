"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import Select from "../components/Select";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface Stats {
  results: {
    people_reached: number;
    emails_per_person: number;
    added: number;
    lost: number;
    window_label: string;
    weeks: { added: number; lost: number }[];
    grade: string;
    hard_rate: number;
    opt_rate: number;
  };
  by_campaign: { id: number; name: string; sent: number; failed: number }[];
  scorecard: {
    id: number; name: string; automated: boolean; touchpoints: number; sent: number;
    rate: number | null; soft: number; hard: number; optouts: number; upcoming: number; last_at: string | null;
    replies: number | null; segment_id: number | null;
  }[];
  funnel: { campaign: string; auto: boolean; steps: { n: number; count: number; pct: number }[] } | null;
  audience_groups: { name: string; count: number }[];
  optouts: {
    total: number;
    with_reason: number;
    by_org: { org: string; count: number }[];
    by_reason: { reason: string; count: number }[];
    recent: { email: string; contact_name: string; org_name: string; reason: string; at: string }[];
  };
  weekday_split: {
    weekday: { sent: number; failed: number; rate: number };
    weekend: { sent: number; failed: number; rate: number };
    days: { day: string; sent: number; failed: number; rate: number }[];
  };
  bounces: {
    hard: number; soft: number; other: number;
    reasons: { kind: string; reason: string; count: number }[];
    dead_addresses: { email: string; org_name: string; updated_at: string }[];
    dead_total: number;
  };
  overview: { total_jobs: number; total_sent: number; total_failed: number; total_skipped: number; total_recipients: number; delivery_rate: number };
  contacts: { total: number; active: number; inactive: number; bounced: number; opted_out: number; undeliverable: number; moved_to_hubspot: number };
  touchpoints: { touchpoint_number: number; sent?: number; failed?: number; total_jobs?: number; recipients?: number }[];
  recent_jobs: { id: number; touchpoint_number: number; status: string; sent_count: number; failed_count: number; created_at: string }[];
  daily_chart: { date: string; sent: number; failed: number; rate: number }[];
  positive_replies: number;
  filter_options?: {
    groups: { id: number; name: string }[];
    segments: { id: number; name: string; group_name: string }[];
    tags: { id: number; name: string }[];
  };
}

const GRADE_WORDS: Record<string, string> = {
  A: "Excellent", B: "Good", C: "Fair", D: "Needs work", F: "Poor",
};

function shortDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function dateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`;
}

/** A Beacon/Filament report section: heading, gray description, content. */
function Section({ heading, description, children }: { heading: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
      <div className="border-b border-gray-950/5 px-6 py-4">
        <h2 className="text-[15px] font-semibold text-gray-950">{heading}</h2>
        {description && <p className="mt-0.5 text-[12px] text-gray-500">{description}</p>}
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}

const MINI = "mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-400";

function ReportingPageInner() {
  const { loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [campaignFocus, setCampaignFocus] = useState("");
  const [groupFocus, setGroupFocus] = useState("");
  const [segmentFocus, setSegmentFocus] = useState("");
  const [tagFocus, setTagFocus] = useState("");

  const [refreshing, setRefreshing] = useState(false);
  // Inline "Replies" editing on the scorecard (stored on the campaign's default segment)
  const [editingReplies, setEditingReplies] = useState<number | null>(null);

  const fetchStats = useCallback(async (f: { campaign?: string; group?: string; segment?: string; tag?: string }) => {
    setRefreshing(true);
    const t0 = Date.now();
    try {
      const p = new URLSearchParams();
      if (f.campaign) p.set("campaign_id", f.campaign);
      if (f.group) p.set("import_group", f.group);
      if (f.segment) p.set("segment_id", f.segment);
      if (f.tag) p.set("tag_id", f.tag);
      const qs = p.toString() ? `?${p}` : "";
      const res = await fetch(`${API}/reporting/stats/${qs}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setStats(data);
    } catch { /* */ }
    // Keep the overlay visible long enough to register, even on fast responses
    const remain = 450 - (Date.now() - t0);
    if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain));
    setRefreshing(false);
    setLoaded(true);
  }, []);

  // ?campaign_id= (e.g. from a send's "See the full report" link) scopes the report
  useEffect(() => {
    const cid = searchParams.get("campaign_id") || "";
    setCampaignFocus(cid);
    fetchStats({ campaign: cid || undefined });
  }, [searchParams, fetchStats]);

  async function saveReplies(segmentId: number, raw: string) {
    setEditingReplies(null);
    const n = Math.max(0, parseInt(raw, 10) || 0);
    try {
      await fetch(`${API}/segments/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: segmentId, positive_replies: n }),
        credentials: "include",
      });
      applyFilters({});
    } catch { /* */ }
  }

  // One place to change any filter: updates state and refetches with the full set
  function applyFilters(next: { campaign?: string; group?: string; segment?: string; tag?: string }) {
    const f = {
      campaign: next.campaign ?? campaignFocus,
      group: next.group ?? groupFocus,
      segment: next.segment ?? segmentFocus,
      tag: next.tag ?? tagFocus,
    };
    if (next.campaign !== undefined) setCampaignFocus(next.campaign);
    if (next.group !== undefined) setGroupFocus(next.group);
    if (next.segment !== undefined) setSegmentFocus(next.segment);
    if (next.tag !== undefined) setTagFocus(next.tag);
    fetchStats({
      campaign: f.campaign || undefined,
      group: f.group || undefined,
      segment: f.segment || undefined,
      tag: f.tag || undefined,
    });
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

  const r = stats;
  const kpis = r ? [
    { label: "Emails sent", value: r.overview.total_sent, color: "#6366f1" },
    { label: "Arrived safely", value: `${r.overview.delivery_rate}%`, color: "#10b981" },
    { label: "People you can email", value: r.contacts.active, color: "#0ea5e9" },
    { label: "Opted out", value: r.contacts.opted_out, color: "#f59e0b" },
    { label: "Became leads", value: r.positive_replies, color: "#3b82f6" },
  ] : [];

  // Donut for "Who's in your contact list" via conic-gradient
  const donutParts = r ? [
    { label: "Active", value: r.contacts.active, color: "#10b981" },
    { label: "Inactive", value: r.contacts.inactive, color: "#9ca3af" },
    { label: "Undeliverable", value: r.contacts.undeliverable, color: "#ef4444" },
    { label: "Opted out", value: r.contacts.opted_out, color: "#f59e0b" },
    { label: "Moved to HubSpot", value: r.contacts.moved_to_hubspot, color: "#3b82f6" },
  ].filter((p) => p.value > 0) : [];
  const donutTotal = donutParts.reduce((a, p) => a + p.value, 0);
  let acc = 0;
  const donutStops = donutParts.map((p) => {
    const from = (acc / Math.max(donutTotal, 1)) * 360;
    acc += p.value;
    const to = (acc / Math.max(donutTotal, 1)) * 360;
    return `${p.color} ${from}deg ${to}deg`;
  }).join(", ");

  const last14 = r ? r.daily_chart.slice(-14) : [];
  const maxDay = Math.max(1, ...last14.map((d) => d.sent + d.failed));
  const maxCampaign = r ? Math.max(1, ...r.by_campaign.map((c) => c.sent + c.failed)) : 1;
  const maxWeek = r ? Math.max(1, ...r.results.weeks.map((w) => Math.max(w.added, w.lost))) : 1;
  const maxGroup = r ? Math.max(1, ...r.audience_groups.map((g) => g.count)) : 1;
  const allBounces = r ? r.bounces.soft + r.bounces.hard + r.bounces.other : 0;
  const maxReason = r ? Math.max(1, ...r.bounces.reasons.map((x) => x.count)) : 1;

  const tpRows = r ? r.touchpoints.map((t) => {
    const sent = t.sent ?? 0;
    const failed = t.failed ?? 0;
    const att = sent + failed;
    return { n: t.touchpoint_number, sent, failed, rate: att ? Math.round((sent / att) * 100) : null };
  }) : [];

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div>
              <h1 className="text-[16px] font-bold text-gray-900">Reporting</h1>
              <p className="text-[11px] text-gray-500">The client&apos;s results in plain words.</p>
            </div>
          </div>
        </header>

        <main className="space-y-5 p-4 sm:p-8">
          {!loaded || !r ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-32 rounded-xl bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
              ))}
            </div>
          ) : (
            <>
              {/* Filter toolbar */}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-400/20 bg-gray-500/[.03] px-3.5 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[#6b8a9e]">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
                  </svg>
                  Filter
                </span>
                <Select
                  value={campaignFocus}
                  onChange={(v) => applyFilters({ campaign: v })}
                  options={[{ value: "", label: "Most active campaign" }, ...r.scorecard.map((c) => ({ value: String(c.id), label: c.name }))]}
                  size="sm"
                  className="min-w-[12rem]"
                />
                <Select
                  value={groupFocus}
                  onChange={(v) => applyFilters({ group: v, segment: "" })}
                  options={[{ value: "", label: "All groups" }, ...(r.filter_options?.groups || []).map((g) => ({ value: String(g.id), label: g.name }))]}
                  size="sm"
                  searchable
                  className="min-w-[10rem]"
                />
                <Select
                  value={segmentFocus}
                  onChange={(v) => applyFilters({ segment: v })}
                  options={[{ value: "", label: "All segments" }, ...(r.filter_options?.segments || []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.group_name})` }))]}
                  size="sm"
                  searchable
                  className="min-w-[10rem]"
                />
                <Select
                  value={tagFocus}
                  onChange={(v) => applyFilters({ tag: v })}
                  options={[{ value: "", label: "All tags" }, ...(r.filter_options?.tags || []).map((t) => ({ value: String(t.id), label: t.name }))]}
                  size="sm"
                  searchable
                  className="min-w-[9rem]"
                />
                {(campaignFocus || groupFocus || segmentFocus || tagFocus) && (
                  <button
                    onClick={() => applyFilters({ campaign: "", group: "", segment: "", tag: "" })}
                    className="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100"
                  >
                    Clear
                  </button>
                )}
                {refreshing && (
                  <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#054B70]">
                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Updating…
                  </span>
                )}
              </div>

              {/* While a filter change is loading: dim the report and show a spinner */}
              <div className="relative">
              {refreshing && (
                <div className="absolute inset-0 z-20 rounded-xl bg-white/80 backdrop-blur-[1.5px]">
                  <div className="sticky top-40 flex justify-center pt-10">
                    <div className="flex items-center gap-3 rounded-xl bg-white px-5 py-3.5 shadow-lg ring-1 ring-gray-950/10">
                      <svg className="h-5 w-5 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span className="text-[13px] font-semibold text-gray-700">Applying filters…</span>
                    </div>
                  </div>
                </div>
              )}
              <div className={`space-y-5 transition-opacity duration-200 ${refreshing ? "pointer-events-none opacity-50" : ""}`}>

              {/* 1 · Results at a glance */}
              <Section
                heading="Results at a glance"
                description="The client's results in plain words — how many real people you reached, whether the list is growing, and how healthy it is."
              >
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">People reached</div>
                    <div className="mt-1 text-[26px] font-extrabold leading-none text-gray-950 tabular-nums">{r.results.people_reached.toLocaleString()}</div>
                    <div className="mt-1 text-[12px] text-gray-500">real people got at least one email</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Emails per person</div>
                    <div className="mt-1 text-[26px] font-extrabold leading-none text-gray-950 tabular-nums">{r.results.emails_per_person}</div>
                    <div className="mt-1 text-[12px] text-gray-500">on average, per contact reached</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Audience growth ({r.results.window_label})</div>
                    <div className={`mt-1 text-[26px] font-extrabold leading-none tabular-nums ${r.results.added - r.results.lost >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                      {r.results.added - r.results.lost >= 0 ? "+" : ""}{(r.results.added - r.results.lost).toLocaleString()}
                    </div>
                    <div className="mt-1 text-[12px] text-gray-500">{r.results.added} added · {r.results.lost} lost</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">List quality</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-[26px] font-extrabold leading-none text-gray-950">{r.results.grade}</span>
                      <span className={`text-[14px] font-bold ${["A", "B"].includes(r.results.grade) ? "text-emerald-700" : r.results.grade === "C" ? "text-amber-700" : "text-red-700"}`}>
                        {GRADE_WORDS[r.results.grade] || ""}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-gray-500">
                      a health score from A (best) to F — {r.results.hard_rate}% of emails hit dead addresses, {r.results.opt_rate}% of people reached opted out
                    </div>
                  </div>
                </div>

                <div className="mt-6">
                  <p className={MINI}>Audience added vs lost — last 8 weeks</p>
                  <div className="flex h-24 items-end gap-2">
                    {r.results.weeks.map((w, i) => (
                      <div key={i} className="flex flex-1 items-end justify-center gap-1">
                        <div className="w-3 rounded-t bg-[#10b981]" style={{ height: `${Math.max(3, (w.added / maxWeek) * 88)}px` }} title={`+${w.added} added`} />
                        <div className="w-3 rounded-t bg-[#ef4444]" style={{ height: `${Math.max(3, (w.lost / maxWeek) * 88)}px` }} title={`−${w.lost} lost`} />
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[12px] text-gray-500">
                    <span className="font-bold text-[#10b981]">■</span> added&nbsp;&nbsp;
                    <span className="font-bold text-[#ef4444]">■</span> lost (opted out)
                  </p>
                </div>
              </Section>

              {/* 2 · KPI row */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {kpis.map((k) => (
                  <div key={k.label} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-950/5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{k.label}</div>
                    <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums" style={{ color: k.color }}>
                      {typeof k.value === "number" ? k.value.toLocaleString() : k.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* 3 · Who's in your contact list + Emails sent per day */}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <Section heading="Who's in your contact list" description="Every contact, split by whether you can still email them.">
                  {donutTotal === 0 ? (
                    <p className="text-[13px] text-gray-500">No contacts yet.</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-6">
                      <div className="relative h-36 w-36 shrink-0 rounded-full" style={{ background: `conic-gradient(${donutStops})` }}>
                        <div className="absolute inset-4 flex flex-col items-center justify-center rounded-full bg-white">
                          <span className="text-[22px] font-extrabold leading-none text-gray-950 tabular-nums">{r.contacts.total.toLocaleString()}</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">contacts</span>
                        </div>
                      </div>
                      <div className="min-w-[180px] flex-1 space-y-1.5">
                        {donutParts.map((p) => (
                          <div key={p.label} className="flex items-center gap-2 text-[13px]">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                            <span className="flex-1 text-gray-950">{p.label}</span>
                            <span className="font-bold tabular-nums">{p.value.toLocaleString()}</span>
                            <span className="w-11 text-right text-gray-400">{Math.round((p.value / donutTotal) * 100)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Section>

                <Section heading="Emails sent per day" description="The last 14 days of sending.">
                  {last14.length === 0 ? (
                    <p className="text-[13px] text-gray-500">No sends in the last 14 days.</p>
                  ) : (
                    <div className="flex h-36 items-end gap-1.5">
                      {last14.map((d) => (
                        <div key={d.date} className="group flex flex-1 flex-col items-center gap-1" title={`${shortDate(d.date)} — ${d.sent} sent, ${d.failed} failed`}>
                          <div className="flex w-full max-w-6 flex-col justify-end" style={{ height: "116px" }}>
                            {d.failed > 0 && <div className="w-full rounded-t bg-[#ef4444]" style={{ height: `${(d.failed / maxDay) * 110}px` }} />}
                            <div className={`w-full bg-[#10b981] ${d.failed > 0 ? "" : "rounded-t"}`} style={{ height: `${Math.max(2, (d.sent / maxDay) * 110)}px` }} />
                          </div>
                          <span className="text-[9px] text-gray-400">{shortDate(d.date)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </div>

              {/* 4 · Sent by campaign */}
              <Section heading="Sent by campaign" description="Green = delivered, red = failed.">
                {r.by_campaign.length === 0 ? (
                  <p className="text-[13px] text-gray-500">Nothing sent yet.</p>
                ) : (
                  <div className="space-y-2.5">
                    {r.by_campaign.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 text-[13px]">
                        <span className="w-44 shrink-0 truncate font-bold text-[#0369a1]">{c.name}</span>
                        <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                          <div className="h-full bg-[#10b981]" style={{ width: `${(c.sent / maxCampaign) * 100}%` }} />
                          <div className="h-full bg-[#ef4444]" style={{ width: `${(c.failed / maxCampaign) * 100}%` }} />
                        </div>
                        <span className="w-24 shrink-0 text-right tabular-nums text-gray-500">
                          <strong className="text-emerald-700">{c.sent.toLocaleString()}</strong>
                          {c.failed > 0 && <> · <strong className="text-red-700">{c.failed}</strong></>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* 5 · Campaign scorecard */}
              <Section heading="Campaign scorecard" description={<>The full picture per campaign — sends, arrival rate, bounces, opt-outs, replies you&apos;ve received back (click the count to update it), and what&apos;s coming up.</>}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left">
                    <thead>
                      <tr className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-2 py-2">Campaign</th>
                        <th className="px-2 py-2 text-right">Sent</th>
                        <th className="px-2 py-2 text-right">Arrival rate</th>
                        <th className="px-2 py-2 text-right">Soft</th>
                        <th className="px-2 py-2 text-right">Hard</th>
                        <th className="px-2 py-2 text-right">Opt-outs</th>
                        <th className="px-2 py-2 text-right">Replies</th>
                        <th className="px-2 py-2 text-right">Upcoming</th>
                        <th className="px-2 py-2 text-right">Last send</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-950/5">
                      {r.scorecard.map((c) => (
                        <tr key={c.id} className="text-[13px]">
                          <td className="px-2 py-2.5">
                            <a href={`/email-templates?campaign=${c.id}`} className="font-bold text-[#0369a1] underline decoration-[#0369a1]/50 underline-offset-2">
                              {c.name}
                            </a>
                            {c.automated && <span className="ml-1.5 rounded-full bg-emerald-500/[.16] px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">auto</span>}
                          </td>
                          <td className="px-2 py-2.5 text-right font-bold tabular-nums">{c.sent.toLocaleString()}</td>
                          <td className="px-2 py-2.5 text-right">
                            {c.rate === null ? <span className="text-gray-400">—</span> : (
                              <span className={`font-bold ${c.rate >= 95 ? "text-emerald-700" : c.rate >= 85 ? "text-amber-700" : "text-red-700"}`}>{c.rate}%</span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-amber-700">{c.soft || "—"}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-red-700">{c.hard || "—"}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{c.optouts || "—"}</td>
                          <td className="px-2 py-2.5 text-right">
                            {c.segment_id === null ? (
                              <span className="text-gray-400" title="Set a default audience segment on the campaign to track replies">—</span>
                            ) : editingReplies === c.id ? (
                              <input
                                autoFocus
                                type="number"
                                min={0}
                                defaultValue={c.replies ?? 0}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveReplies(c.segment_id!, (e.target as HTMLInputElement).value);
                                  if (e.key === "Escape") setEditingReplies(null);
                                }}
                                onBlur={(e) => saveReplies(c.segment_id!, e.target.value)}
                                className="w-16 rounded-md bg-gray-50 px-1.5 py-0.5 text-right text-[13px] text-gray-950 outline-none ring-2 ring-[#054B70]"
                              />
                            ) : (
                              <button
                                onClick={() => setEditingReplies(c.id)}
                                title="Replies you've received back from this campaign — click to update the count"
                                className="rounded px-1.5 py-0.5 font-bold tabular-nums text-[#054B70] hover:bg-[#054B70]/5"
                              >
                                {c.replies ?? 0} ✎
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{c.upcoming || "—"}</td>
                          <td className="px-2 py-2.5 text-right text-gray-500">{c.last_at ? dateTime(c.last_at) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* 6 · How far people got */}
              <Section
                heading={`How far people got — ${r.funnel?.campaign ?? "no campaign yet"}`}
                description={`${r.funnel?.auto ? "Your most active campaign — pick one in the filter to see another. " : ""}How many contacts reached each step of the flow.`}
              >
                {!r.funnel || r.funnel.steps.length === 0 ? (
                  <p className="text-[13px] text-gray-500">No journey data yet.</p>
                ) : (
                  <div className="space-y-2">
                    {r.funnel.steps.map((s) => (
                      <div key={s.n} className="flex items-center gap-3 text-[13px]">
                        <span className="w-28 shrink-0 font-semibold text-gray-950">Touchpoint {s.n}</span>
                        <div className="h-4 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                          <div className="h-full rounded-full bg-[#054B70]" style={{ width: `${s.pct}%` }} />
                        </div>
                        <span className="w-28 shrink-0 text-right font-bold tabular-nums">
                          {s.count.toLocaleString()} <span className="font-medium text-gray-400">· {s.pct}%</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* 7 · Weekday vs weekend sending */}
              <Section
                heading="Weekday vs weekend sending"
                description="You aim to send on weekdays. Weekend bars are flagged — anything there usually means a schedule landed on a Saturday or Sunday."
              >
                {r.weekday_split.weekend.sent + r.weekday_split.weekend.failed > 0 ? (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[.05] px-3 py-2 text-[13px]">
                    <span className="rounded border border-red-500/50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">Heads up</span>
                    <span><strong className="text-red-700">{(r.weekday_split.weekend.sent + r.weekday_split.weekend.failed).toLocaleString()}</strong> email{r.weekday_split.weekend.sent + r.weekday_split.weekend.failed === 1 ? "" : "s"} went out on a weekend — check the schedules for those campaigns.</span>
                  </div>
                ) : (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[.05] px-3 py-2 text-[13px]">
                    <span className="rounded border border-emerald-500/50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">All good</span>
                    <span>All <strong>{(r.weekday_split.weekday.sent + r.weekday_split.weekday.failed).toLocaleString()}</strong> sends went out on weekdays — no weekend sends.</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  {r.weekday_split.days.map((d) => {
                    const att = d.sent + d.failed;
                    const maxAtt = Math.max(1, ...r.weekday_split.days.map((x) => x.sent + x.failed));
                    const weekend = d.day === "Saturday" || d.day === "Sunday";
                    return (
                      <div key={d.day} className="flex items-center gap-3 text-[13px]">
                        <span className={`w-24 shrink-0 ${weekend ? "font-bold text-red-700" : "text-gray-950"}`}>{d.day}</span>
                        <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                          <div className={`h-full rounded-full ${weekend ? "bg-[#ef4444]" : "bg-[#054B70]"}`} style={{ width: `${(att / maxAtt) * 100}%` }} />
                        </div>
                        <span className="w-16 shrink-0 text-right font-bold tabular-nums">{att.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </Section>

              {/* 8 · How each email performs */}
              <Section
                heading="How each email performs"
                description="Every email (touchpoint) in your flows. The bar shows what share of attempted deliveries actually arrived; failures are the bounces."
              >
                {tpRows.length === 0 ? (
                  <p className="text-[13px] text-gray-500">No touchpoint sends yet.</p>
                ) : (
                  <div className="space-y-2">
                    {tpRows.map((t) => (
                      <div key={t.n} className="flex items-center gap-3 text-[13px]">
                        <span className="w-28 shrink-0 font-semibold text-gray-950">Touchpoint {t.n}</span>
                        <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                          <div
                            className={`h-full rounded-full ${t.rate === null ? "" : t.rate >= 95 ? "bg-[#059669]" : t.rate >= 80 ? "bg-[#b45309]" : "bg-[#b91c1c]"}`}
                            style={{ width: `${t.rate ?? 0}%` }}
                          />
                        </div>
                        <span className="w-28 shrink-0 text-right tabular-nums text-gray-500">
                          {t.rate === null ? "—" : (
                            <><strong className={t.rate >= 95 ? "text-emerald-700" : t.rate >= 80 ? "text-amber-700" : "text-red-700"}>{t.rate}%</strong> · {t.sent.toLocaleString()} sent</>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* 9 · Audience by group + Recent sends */}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <Section heading="Audience by group">
                  {r.audience_groups.length === 0 ? (
                    <p className="text-[13px] text-gray-500">No groups yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {r.audience_groups.map((g) => (
                        <div key={g.name} className="flex items-center gap-3 text-[13px]">
                          <span className="w-40 shrink-0 truncate text-gray-950">{g.name}</span>
                          <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                            <div className="h-full rounded-full bg-[#054B70]" style={{ width: `${(g.count / maxGroup) * 100}%` }} />
                          </div>
                          <span className="w-12 shrink-0 text-right font-bold tabular-nums">{g.count.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                <Section heading="Recent sends">
                  {r.recent_jobs.length === 0 ? (
                    <p className="text-[13px] text-gray-500">Nothing sent yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {r.recent_jobs.slice(0, 8).map((j) => (
                        <div key={j.id} className="flex items-center gap-3 text-[13px]">
                          <span className="w-12 shrink-0 font-semibold text-gray-950">TP {j.touchpoint_number || "—"}</span>
                          <span className="flex-1 text-gray-500">{dateTime(j.created_at)}</span>
                          <span className="shrink-0 tabular-nums">
                            <strong className="text-emerald-700">{j.sent_count}</strong> sent
                            {j.failed_count > 0 && <> · <strong className="text-red-700">{j.failed_count}</strong> failed</>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </div>

              {/* 10 · Bounces */}
              <Section
                heading="Bounces — emails that couldn't be delivered"
                description="Soft = temporary problem, worth retrying. Hard = the address doesn't exist, we stop sending to it."
              >
                {allBounces === 0 ? (
                  <p className="text-[13px] text-gray-500">No bounces — every attempted email was delivered.</p>
                ) : (
                  <>
                    <div className="mb-1 flex h-4 overflow-hidden rounded-full bg-gray-400/15">
                      <div className="h-full bg-[#f59e0b]" style={{ width: `${(r.bounces.soft / allBounces) * 100}%` }} />
                      <div className="h-full bg-[#ef4444]" style={{ width: `${(r.bounces.hard / allBounces) * 100}%` }} />
                    </div>
                    <p className="mb-5 text-[12px] text-gray-500">
                      <strong className="text-amber-700">{allBounces ? Math.round((r.bounces.soft / allBounces) * 100) : 0}%</strong> soft (retryable) &nbsp;·&nbsp;
                      <strong className="text-red-700">{allBounces ? Math.round((r.bounces.hard / allBounces) * 100) : 0}%</strong> hard (permanent)
                    </p>

                    {r.bounces.reasons.length > 0 && (
                      <div className="mb-5">
                        <p className={MINI}>Why they bounced{campaignFocus ? " (this campaign)" : ""}</p>
                        <div className="space-y-2">
                          {r.bounces.reasons.map((x) => (
                            <div key={`${x.kind}-${x.reason}`} className="flex flex-col gap-1 text-[13px] sm:flex-row sm:items-center sm:gap-3">
                              <span className="min-w-0 font-semibold text-gray-950 sm:w-[45%] sm:shrink-0" style={{ overflowWrap: "anywhere" }}>
                                {x.reason}
                              </span>
                              <div className="flex min-w-0 flex-1 items-center gap-3">
                                <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                                  <div className={`h-full rounded-full ${x.kind === "hard" ? "bg-[#ef4444]" : "bg-[#f59e0b]"}`} style={{ width: `${(x.count / maxReason) * 100}%` }} />
                                </div>
                                <span className="shrink-0 text-right font-bold tabular-nums">
                                  {x.count} <span className="font-medium text-gray-400">· {allBounces ? Math.round((x.count / allBounces) * 100) : 0}%</span>
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {r.bounces.dead_addresses.length > 0 && (
                      <div>
                        <p className={MINI}>
                          Dead addresses{r.bounces.dead_total > r.bounces.dead_addresses.length ? ` — latest ${r.bounces.dead_addresses.length}` : ""}
                        </p>
                        <div className="space-y-1">
                          {r.bounces.dead_addresses.map((d) => (
                            <div key={d.email} className="flex items-baseline gap-3 text-[13px]">
                              <span className="max-w-[260px] truncate font-bold text-gray-950">{d.email}</span>
                              <span className="flex-1 truncate text-gray-500">{d.org_name}</span>
                              <span className="shrink-0 text-[12px] text-gray-400">{shortDate(d.updated_at)}</span>
                            </div>
                          ))}
                        </div>
                        <a href="/contacts" className="mt-2.5 inline-block text-[12px] font-bold text-[#0369a1]">
                          See all {r.bounces.dead_total} dead address{r.bounces.dead_total === 1 ? "" : "es"} in Contacts →
                        </a>
                      </div>
                    )}
                  </>
                )}
              </Section>

              {/* 11 · Opt-outs */}
              <Section
                heading="Opt-outs — people who opted out"
                description="Everyone who opted out, how they did it, and which organisations they belong to."
              >
                {r.optouts.total === 0 ? (
                  <p className="text-[13px] text-gray-500">Nobody has opted out.</p>
                ) : (
                  <>
                    <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-sm">
                      <div className="rounded-lg border border-gray-400/20 px-4 py-3 text-center">
                        <div className="text-[22px] font-extrabold leading-none tabular-nums text-amber-700">{r.optouts.total}</div>
                        <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Opted out</div>
                      </div>
                      <div className="rounded-lg border border-gray-400/20 px-4 py-3 text-center">
                        <div className="text-[22px] font-extrabold leading-none tabular-nums text-gray-950">{r.optouts.with_reason}</div>
                        <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Gave a reason</div>
                      </div>
                    </div>

                    <div className="mb-6">
                      <p className={MINI}>Why they left — the reasons people typed when unsubscribing{campaignFocus ? " (this campaign)" : ""}</p>
                      <div className="space-y-2">
                        {(r.optouts.by_reason || []).map((x) => {
                          const maxReason = Math.max(1, ...(r.optouts.by_reason || []).map((y) => y.count));
                          return (
                            <div key={x.reason} className="flex items-center gap-3 text-[13px]">
                              <span className="min-w-0 max-w-[55%] shrink-0 truncate font-medium text-gray-950" title={x.reason}>
                                &ldquo;{x.reason}&rdquo;
                              </span>
                              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-400/15">
                                <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${(x.count / maxReason) * 100}%` }} />
                              </div>
                              <span className="shrink-0 font-bold tabular-nums">
                                {x.count} <span className="font-normal text-gray-500">{x.count === 1 ? "person" : "people"}</span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                      <div>
                        <p className={MINI}>By organisation</p>
                        <div className="space-y-1">
                          {r.optouts.by_org.map((o) => (
                            <div key={o.org} className="flex items-center gap-3 text-[13px]">
                              <span className="flex-1 truncate text-gray-950">{o.org}</span>
                              <span className="shrink-0 font-bold tabular-nums">{o.count}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className={MINI}>Most recent</p>
                        <div className="space-y-1.5">
                          {r.optouts.recent.map((o) => (
                            <div key={o.email} className="flex items-baseline gap-2 text-[13px]">
                              <span className="shrink-0 font-bold text-gray-950">{o.contact_name || o.email}</span>
                              <span className="min-w-0 flex-1 truncate text-right text-[12px] text-gray-400">
                                {o.reason || "No reason given"} · {shortDate(o.at)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </Section>
              </div>
              </div>
            </>
          )}
        </main>
      </MainContent>
    </div>
  );
}

/* useSearchParams needs a Suspense boundary in Next.js */
export default function ReportingPage() {
  return (
    <Suspense fallback={null}>
      <ReportingPageInner />
    </Suspense>
  );
}
