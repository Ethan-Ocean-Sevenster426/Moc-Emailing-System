"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import DatePicker from "../components/DatePicker";
import Select from "../components/Select";
import { useAuth } from "../hooks/useAuth";
import { motion } from "motion/react";

const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 };

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface BatchEmail {
  touchpoint_number: number;
  subject: string;
  scheduled_for: string;
  status: string; // scheduled | sending
}

interface Batch {
  batch_key: string;
  id: number;
  campaign_id: number | null;
  campaign_name: string;
  starts_at: string;
  target: string;
  import_group_id: number | null;
  segment_id: number | null;
  limit: number;
  created_by: string;
  emails: BatchEmail[];
}

interface PastRun {
  id: number;
  campaign_name: string;
  subject: string;
  touchpoint_number: number;
  scheduled_for: string;
  status: string;
  import_group_name: string;
  segment_name: string;
  job: { sent: number; failed: number; skipped: number; total: number; status: string } | null;
}

interface CampaignOption { id: number; name: string; group_name: string; touchpoints: number }
interface GroupInfo { id: number; name: string; contact_count: number }
interface SegmentInfo { id: number; name: string; import_group_id: number; contact_count: number }

/** Beacon's "Starts" phrasing: today / tomorrow / in N days + the full date. */
function startsPhrase(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  const rel = days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 60 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
  return `${rel} — ${d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function SchedulePage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [comingUp, setComingUp] = useState<Batch[]>([]);
  const [past, setPast] = useState<PastRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);

  // "Schedule a campaign" modal — what launches and when, who receives it
  const [showSchedule, setShowSchedule] = useState(false);
  const [schCampaignId, setSchCampaignId] = useState("");
  const [schWhen, setSchWhen] = useState<"now" | "later">("now");
  const [schStartAt, setSchStartAt] = useState("");
  const [schGroupId, setSchGroupId] = useState("");
  const [schSegmentId, setSchSegmentId] = useState("");
  const [schBusy, setSchBusy] = useState(false);

  // Edit-batch modal
  const [editBatch, setEditBatch] = useState<Batch | null>(null);
  const [editStartAt, setEditStartAt] = useState("");
  const [editGroupId, setEditGroupId] = useState("");
  const [editSegmentId, setEditSegmentId] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  function notify(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await fetch(`${API}/schedules/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setComingUp(data.coming_up);
        setPast(data.already_went_out);
      }
    } catch { /* */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    fetchSchedules();
    const t = setInterval(fetchSchedules, 30000);
    (async () => {
      try {
        const [cRes, gRes] = await Promise.all([
          fetch(`${API}/campaigns/`, { credentials: "include" }),
          fetch(`${API}/contacts/`, { credentials: "include" }),
        ]);
        const c = await cRes.json();
        const g = await gRes.json();
        if (c.ok) setCampaigns(c.campaigns);
        if (g.ok) {
          setGroups(g.import_groups || []);
          setSegments(g.segments || []);
        }
      } catch { /* */ }
    })();
    return () => clearInterval(t);
  }, [fetchSchedules]);

  async function scheduleCampaign() {
    if (!schCampaignId) { notify("Pick a campaign first"); return; }
    if (schWhen === "later" && !schStartAt) { notify("Pick the launch date"); return; }
    setSchBusy(true);
    try {
      const res = await fetch(`${API}/schedules/schedule-campaign/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: Number(schCampaignId),
          when: schWhen,
          start_at: schWhen === "later" ? new Date(schStartAt).toISOString() : "",
          import_group_id: schGroupId ? Number(schGroupId) : null,
          segment_id: schSegmentId ? Number(schSegmentId) : null,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowSchedule(false);
        notify(
          data.ran_now
            ? `Flow started — ${data.scheduled} email${data.scheduled === 1 ? "" : "s"}${data.skipped ? ` (${data.skipped} empty touchpoint${data.skipped > 1 ? "s" : ""} skipped)` : ""}. Track it below and on Send Progress.`
            : `On the schedule — ${data.scheduled} email${data.scheduled === 1 ? "" : "s"}${data.skipped ? ` (${data.skipped} empty skipped)` : ""}.`
        );
        fetchSchedules();
      } else notify(data.error || "Could not schedule");
    } catch { notify("Could not schedule"); }
    setSchBusy(false);
  }

  async function runBatchNow(b: Batch) {
    if (!confirm(`Run "${b.campaign_name}" now?\n\nThe flow starts immediately — its waits stay as set.`)) return;
    try {
      const res = await fetch(`${API}/schedules/batch/run-now/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_key: b.batch_key }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) { notify("Flow started — watch it on Send Progress"); fetchSchedules(); }
      else notify(data.error || "Could not run");
    } catch { notify("Could not run"); }
  }

  async function cancelBatch(b: Batch) {
    if (!confirm(`Turn off & cancel "${b.campaign_name}"?\n\nEvery email still coming up in this batch is cancelled. Sends that already went out are untouched.`)) return;
    try {
      const res = await fetch(`${API}/schedules/batch/cancel/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_key: b.batch_key }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) { notify("Cancelled"); fetchSchedules(); }
      else notify(data.error || "Could not cancel");
    } catch { notify("Could not cancel"); }
  }

  function openEdit(b: Batch) {
    setEditBatch(b);
    const d = new Date(b.starts_at);
    const pad = (n: number) => String(n).padStart(2, "0");
    setEditStartAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    setEditGroupId(b.import_group_id ? String(b.import_group_id) : "");
    setEditSegmentId(b.segment_id ? String(b.segment_id) : "");
  }

  async function saveEdit() {
    if (!editBatch) return;
    setEditBusy(true);
    try {
      const res = await fetch(`${API}/schedules/batch/edit/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_key: editBatch.batch_key,
          start_at: editStartAt ? new Date(editStartAt).toISOString() : "",
          import_group_id: editGroupId ? Number(editGroupId) : null,
          segment_id: editSegmentId ? Number(editSegmentId) : null,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) { setEditBatch(null); notify("Schedule updated"); fetchSchedules(); }
      else notify(data.error || "Could not save");
    } catch { notify("Could not save"); }
    setEditBusy(false);
  }

  function verdict(run: PastRun) {
    if (run.status === "cancelled") return { label: "Cancelled", cls: "bg-gray-100 text-gray-500" };
    const j = run.job;
    // Ran but created no send job: nobody was eligible (e.g. everyone already
    // received the touchpoint, or the target had no one at the right step).
    if (!j) return { label: "Nothing to send — nobody was eligible", cls: "bg-yellow-500/20 text-yellow-700" };
    if (j.status === "failed" || (j.sent === 0 && j.failed > 0)) return { label: "Failed", cls: "bg-red-500/15 text-red-700" };
    if (j.failed > 0) return { label: `Worked, ${j.failed} failed`, cls: "bg-yellow-500/20 text-yellow-700" };
    return { label: "Worked", cls: "bg-green-500/15 text-green-700" };
  }

  const schSegments = segments.filter((s) => !schGroupId || String(s.import_group_id) === schGroupId);
  const editSegments = segments.filter((s) => !editGroupId || String(s.import_group_id) === editGroupId);

  const labelCls = "w-[5.5rem] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400";

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <MobileMenuButton />
              <div className="min-w-0">
                <h1 className="text-[16px] font-bold text-gray-950">Schedule</h1>
                <p className="truncate text-[11px] text-gray-500">
                  Plan campaigns ahead and see what went out, what worked, and what&apos;s coming up.
                </p>
              </div>
            </div>
            {canEdit && (
              <button
                onClick={() => {
                  setShowSchedule(true);
                  setSchCampaignId(campaigns[0] ? String(campaigns[0].id) : "");
                  setSchWhen("now");
                  const t = new Date(Date.now() + 86400000);
                  const pad = (n: number) => String(n).padStart(2, "0");
                  setSchStartAt(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T09:00`);
                  setSchGroupId("");
                  setSchSegmentId("");
                }}
                className="btn-press flex items-center gap-2 rounded-lg bg-[#054B70] px-4 py-2.5 text-[12px] font-bold text-white"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                Schedule a campaign
              </button>
            )}
          </div>
        </header>

        <main className="flex flex-col gap-8 p-4 sm:p-8">
          {toast && (
            <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-3 text-[13px] font-semibold text-gray-900 shadow-lg ring-1 ring-gray-950/5 animate-slide-in">
              <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
              {toast}
            </div>
          )}

          {/* ── Coming up ── */}
          <section>
            <h2 className="text-[16px] font-bold text-gray-950">Coming up</h2>
            <p className="mb-3 text-[12px] text-gray-500">
              One card per scheduled campaign, its emails listed inside — edit or cancel it before it fires.
            </p>
            {!loaded ? (
              <div className="h-32 rounded-lg bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
            ) : comingUp.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-400/40 px-4 py-10 text-center text-[13px] text-gray-500">
                Nothing scheduled yet — use &quot;Schedule a campaign&quot; above to plan one ahead.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {comingUp.map((b, i) => (
                  <motion.div
                    key={b.batch_key || b.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...SPRING, delay: i * 0.05 }}
                    className="rounded-[11px] border-[1.5px] border-dashed border-gray-400/40 bg-white p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                      {b.campaign_id ? (
                        <Link href={`/email-templates?campaign=${b.campaign_id}`} className="text-[14px] font-bold text-gray-950 underline decoration-gray-300 underline-offset-2 hover:decoration-[#054B70]">
                          {b.campaign_name}
                        </Link>
                      ) : (
                        <span className="text-[14px] font-bold text-gray-950">{b.campaign_name}</span>
                      )}
                      {canEdit && (
                        <div className="ml-auto flex gap-1.5">
                          <button onClick={() => runBatchNow(b)} className="rounded-md bg-green-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-green-700">Run now</button>
                          <button onClick={() => openEdit(b)} className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700">Edit</button>
                          <button onClick={() => cancelBatch(b)} className="rounded-md border border-red-500/40 px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-red-50">Turn off &amp; cancel</button>
                        </div>
                      )}
                    </div>

                    <div className="mt-3 flex flex-col gap-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className={labelCls}>Starts</span>
                        <span className="text-[13px] text-gray-950">{startsPhrase(b.starts_at)}</span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className={labelCls}>Going to</span>
                        <span className="text-[13px] text-gray-950">{b.target}{b.limit > 0 ? ` · capped at ${b.limit}` : ""}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className={`${labelCls} pt-1`}>Its {b.emails.length} email{b.emails.length === 1 ? "" : "s"}</span>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          {b.emails.map((e) => (
                            <div key={e.touchpoint_number} className="flex items-center gap-2">
                              <span className="shrink-0 rounded-md bg-blue-600/10 px-2 py-0.5 text-[11px] font-bold text-blue-700">Touchpoint {e.touchpoint_number}</span>
                              <span className="shrink-0 text-[12px] text-gray-500">{fmtDay(e.scheduled_for)}</span>
                              <span className="min-w-0 truncate text-[12px] text-gray-950">
                                {e.subject ? `“${e.subject}”` : "No subject"}
                              </span>
                              {e.status === "sending" ? (
                                <span className="ml-auto shrink-0 rounded-full bg-blue-600/10 px-2 py-0.5 text-[10px] font-semibold text-blue-700">Sending now</span>
                              ) : (
                                <span className="ml-auto shrink-0 rounded-full bg-gray-400/15 px-2 py-0.5 text-[10px] font-semibold text-gray-500">Scheduled</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </section>

          {/* ── Already went out ── */}
          <section>
            <h2 className="text-[16px] font-bold text-gray-950">Already went out</h2>
            <p className="mb-3 text-[12px] text-gray-500">
              The {past.length || 8} most recent sends — the full, searchable history is on Send Progress.
            </p>
            {loaded && past.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-400/40 px-4 py-8 text-center text-[13px] text-gray-500">
                Nothing has gone out yet.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {past.map((run) => {
                  const v = verdict(run);
                  const target = run.segment_name || run.import_group_name || "All contacts";
                  return (
                    <motion.div
                      key={run.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...SPRING, delay: 0.1 }}
                      className="rounded-[11px] border border-gray-400/25 bg-white px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-bold text-gray-950">
                          {new Date(run.scheduled_for).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                          {" — "}{run.campaign_name || "Campaign"}
                        </span>
                        <span className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${v.cls}`}>{v.label}</span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-gray-500">
                        {run.job
                          ? `${run.job.sent} sent · ${run.job.failed} failed · ${run.job.skipped} skipped · Touchpoint ${run.touchpoint_number} · to ${target}`
                          : `Touchpoint ${run.touchpoint_number} · to ${target}`}
                      </p>
                    </motion.div>
                  );
                })}
              </div>
            )}
            <Link href="/send-progress" className="mt-3 inline-block text-[12px] font-semibold text-[#054B70] hover:underline">
              See all past sends in Send Progress →
            </Link>
          </section>
        </main>
      </MainContent>

      {/* Schedule a campaign modal */}
      {showSchedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowSchedule(false)}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-[16px] font-bold text-gray-950">Schedule a campaign</h2>

            <fieldset className="mb-4 rounded-lg border border-gray-200 p-4">
              <legend className="px-1 text-[12px] font-semibold text-gray-700">What launches, and when</legend>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Campaign</label>
              <Select
                value={schCampaignId}
                onChange={setSchCampaignId}
                placeholder="Pick a campaign…"
                className="mb-3 w-full"
                options={campaigns.map((c) => ({
                  value: String(c.id),
                  label: `${c.name} (${c.group_name}${c.touchpoints ? ` · ${c.touchpoints} email${c.touchpoints === 1 ? "" : "s"}` : " · empty"})`,
                }))}
              />

              <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">When should it go out?</p>
              <label className="mb-1 flex cursor-pointer items-center gap-2 text-[13px] text-gray-950">
                <input type="radio" checked={schWhen === "now"} onChange={() => setSchWhen("now")} className="accent-[#054B70]" />
                Run now
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-gray-950">
                <input type="radio" checked={schWhen === "later"} onChange={() => setSchWhen("later")} className="accent-[#054B70]" />
                Schedule it — pick the launch date
              </label>
              {schWhen === "later" && (
                <div className="mt-2">
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Launch at</label>
                  <DatePicker withTime value={schStartAt} onChange={setSchStartAt} className="w-full" />
                  <p className="mt-1 text-[11px] text-gray-500">Touchpoint 1 goes out then; each next touchpoint follows after its own wait. Watch and cancel it here.</p>
                </div>
              )}
            </fieldset>

            <fieldset className="mb-5 rounded-lg border border-gray-200 p-4">
              <legend className="px-1 text-[12px] font-semibold text-gray-700">Who receives it</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Target group</label>
                  <Select
                    value={schGroupId}
                    onChange={(v) => { setSchGroupId(v); setSchSegmentId(""); }}
                    className="w-full"
                    options={[{ value: "", label: "All contacts" }, ...groups.map((g) => ({ value: String(g.id), label: g.name }))]}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Target segment</label>
                  <Select
                    value={schSegmentId}
                    onChange={setSchSegmentId}
                    className="w-full"
                    options={[{ value: "", label: "All segments" }, ...schSegments.map((s) => ({ value: String(s.id), label: s.name }))]}
                  />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-gray-500">Contacts who already received a touchpoint carry on from where they are; the rest start at touchpoint 1.</p>
            </fieldset>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowSchedule(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={scheduleCampaign}
                disabled={schBusy || !schCampaignId}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {schBusy ? "Working…" : schWhen === "now" ? "Run it now" : "Put it on the schedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit this scheduled campaign */}
      {editBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setEditBatch(null)}>
          <div className="w-full max-w-xl rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-950">Edit this scheduled campaign</h2>
            <p className="mb-4 text-[12px] text-gray-500">{editBatch.campaign_name} — moving the launch shifts every email; the waits between them stay as set.</p>

            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Launch at</label>
            <DatePicker withTime value={editStartAt} onChange={setEditStartAt} className="mb-3 w-full" />

            <div className="mb-5 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Target group</label>
                <Select
                  value={editGroupId}
                  onChange={(v) => { setEditGroupId(v); setEditSegmentId(""); }}
                  className="w-full"
                  options={[{ value: "", label: "All contacts" }, ...groups.map((g) => ({ value: String(g.id), label: g.name }))]}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Target segment</label>
                <Select
                  value={editSegmentId}
                  onChange={setEditSegmentId}
                  className="w-full"
                  options={[{ value: "", label: "All segments" }, ...editSegments.map((s) => ({ value: String(s.id), label: s.name }))]}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setEditBatch(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={saveEdit}
                disabled={editBusy}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {editBusy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
