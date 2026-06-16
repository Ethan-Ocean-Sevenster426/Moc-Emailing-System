"use client";

import { useState, useEffect, useRef } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import { useAuth } from "../hooks/useAuth";

const API = "http://localhost:8000/api";

interface SendJob {
  id: number;
  touchpoint_number: number;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  started_by?: string;
  is_test?: boolean;
  created_at: string;
  completed_at: string | null;
  current_contact?: string | null;
}

function statusBadge(status: string) {
  switch (status) {
    case "running":
      return { bg: "bg-blue-50 border-blue-200", text: "text-blue-600", dot: "bg-blue-500 animate-pulse" };
    case "completed":
      return { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-500" };
    case "failed":
      return { bg: "bg-red-50 border-red-200", text: "text-red-600", dot: "bg-red-500" };
    case "cancelled":
      return { bg: "bg-amber-50 border-amber-200", text: "text-amber-700", dot: "bg-amber-500" };
    default:
      return { bg: "bg-gray-50 border-gray-200", text: "text-gray-500", dot: "bg-gray-400" };
  }
}

export default function SendProgressPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [jobs, setJobs] = useState<SendJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sendingTP, setSendingTP] = useState<number | null>(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [selectedTP, setSelectedTP] = useState(1);
  const [onlyUnsent, setOnlyUnsent] = useState(true);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    pollingRef.current = setInterval(fetchJobs, 1500);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  useEffect(() => {
    const hasRunning = jobs.some((j) => j.status === "running" || j.status === "pending");
    if (!hasRunning && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    } else if (hasRunning && !pollingRef.current) {
      pollingRef.current = setInterval(fetchJobs, 1500);
    }
  }, [jobs]);

  async function startSend() {
    setSendingTP(selectedTP);
    try {
      const res = await fetch(`${API}/send/start/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint_number: selectedTP, only_unsent: onlyUnsent }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Send job started for Touchpoint ${selectedTP} — ${data.total_recipients} recipients`);
        setShowSendModal(false);
        fetchJobs();
        if (!pollingRef.current) {
          pollingRef.current = setInterval(fetchJobs, 1500);
        }
      } else {
        showToast(data.error || "Failed to start send");
      }
    } catch {
      showToast("Network error");
    }
    setSendingTP(null);
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
        showToast("Job cancellation requested");
        fetchJobs();
      } else {
        showToast(data.error || "Cannot cancel");
      }
    } catch { /* */ }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f4f7]">
        <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  // Separate running/pending jobs from history
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "pending");
  const historyJobs = jobs.filter((j) => j.status !== "running" && j.status !== "pending");

  return (
    <div className="flex min-h-screen bg-[#f0f4f7]">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#e0e8ee] bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold text-[#0a2a3c]">Send Progress</h1>
              <p className="truncate text-[11px] text-[#8ca3b3]">Track bulk email send jobs and their progress</p>
            </div>
          </div>
          {canEdit && (
            <button
              onClick={() => setShowSendModal(true)}
              className="btn-press flex shrink-0 items-center gap-2 rounded-xl bg-[#054B70] px-3 py-2 text-[12px] font-bold text-white sm:px-5 sm:py-2.5"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
              <span className="hidden sm:inline">New Bulk Send</span>
              <span className="sm:hidden">Send</span>
            </button>
          )}
        </header>

        <main className="p-4 sm:p-8">
          {toast && (
            <div className="mb-5 flex items-center gap-2 rounded-xl bg-[#054B70]/5 px-4 py-3 text-[13px] font-semibold text-[#054B70] animate-slide-in">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
              {toast}
            </div>
          )}

          {!loaded ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-28 rounded-2xl bg-gradient-to-r from-[#f0f4f7] via-white to-[#f0f4f7] bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl bg-white py-20 shadow-sm">
              <svg className="mb-3 h-12 w-12 text-[#d0dce4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1">
                <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
              <p className="text-[14px] font-semibold text-[#0a2a3c]">No send jobs yet</p>
              <p className="mt-1 text-[12px] text-[#8ca3b3]">Start a bulk send to see progress here</p>
            </div>
          ) : (
            <div className="space-y-6">

              {/* ── Active / Running Jobs ── */}
              {activeJobs.map((job) => {
                const processed = job.sent_count + job.failed_count + job.skipped_count;
                const pct = job.total_recipients > 0 ? Math.round((processed / job.total_recipients) * 100) : 0;

                return (
                  <div key={job.id} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-blue-100 animate-fade-in-up">
                    {/* Pulsing top accent */}
                    <div className="h-1 bg-gradient-to-r from-[#054B70] via-blue-400 to-[#054B70] bg-[length:200%_100%] animate-[shimmer_2s_infinite]" />

                    <div className="p-6">
                      {/* Header row */}
                      <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-3">
                          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#054B70] text-[15px] font-bold text-white shadow-md shadow-[#054B70]/20">
                            {job.touchpoint_number}
                          </div>
                          <div>
                            <p className="text-[15px] font-bold text-[#0a2a3c]">
                              Touchpoint {job.touchpoint_number}
                              {job.is_test && <span className="ml-2 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-purple-600">Test</span>}
                            </p>
                            <p className="text-[11px] text-[#8ca3b3]">
                              Started {new Date(job.created_at).toLocaleString()}
                              {job.started_by && ` by ${job.started_by}`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[11px] font-semibold text-blue-600">
                            <span className="relative flex h-2 w-2">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                            </span>
                            Sending...
                          </span>
                          {canEdit && (
                            <button
                              onClick={() => cancelJob(job.id)}
                              className="rounded-xl border border-red-200 px-4 py-2 text-[11px] font-semibold text-red-500 transition-all hover:bg-red-50"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Big live counter */}
                      <div className="mb-5 flex items-end gap-2">
                        <span className="text-[42px] font-extrabold leading-none text-[#054B70] tabular-nums">
                          {processed}
                        </span>
                        <span className="mb-1 text-[20px] font-medium text-[#8ca3b3]">
                          / {job.total_recipients}
                        </span>
                        <span className="mb-1.5 ml-2 text-[14px] font-bold text-[#054B70]">
                          {pct}%
                        </span>
                      </div>

                      {/* Currently sending to */}
                      {job.current_contact && (
                        <div className="mb-4 flex items-center gap-2 text-[12px] text-[#6b8a9e]">
                          <svg className="h-3.5 w-3.5 animate-pulse text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                          </svg>
                          Sending to <strong className="text-[#0a2a3c]">{job.current_contact}</strong>
                        </div>
                      )}

                      {/* Progress bar */}
                      <div className="mb-4">
                        <div className="h-3 w-full overflow-hidden rounded-full bg-[#f0f4f7]">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-[#054B70] to-blue-400 transition-all duration-700 ease-out"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>

                      {/* Stats row */}
                      <div className="flex gap-6">
                        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                          <span className="text-[12px] font-semibold text-emerald-700">Sent {job.sent_count}</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
                          <span className="text-[12px] font-semibold text-red-600">Failed {job.failed_count}</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                          <span className="text-[12px] font-semibold text-amber-700">Skipped {job.skipped_count}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* ── History section ── */}
              {historyJobs.length > 0 && (
                <>
                  {activeJobs.length > 0 && (
                    <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.15em] text-[#8ca3b3]/60">
                      History
                    </p>
                  )}
                  {historyJobs.map((job) => {
                    const processed = job.sent_count + job.failed_count + job.skipped_count;
                    const pct = job.total_recipients > 0 ? Math.round((processed / job.total_recipients) * 100) : 0;
                    const badge = statusBadge(job.status);

                    return (
                      <div key={job.id} className="rounded-2xl bg-white p-5 shadow-sm animate-fade-in-up">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#054B70]/8 text-[13px] font-bold text-[#054B70]">
                              {job.touchpoint_number}
                            </div>
                            <div>
                              <p className="text-[13px] font-bold text-[#0a2a3c]">
                                Touchpoint {job.touchpoint_number}
                                {job.is_test && <span className="ml-1.5 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-purple-600">Test</span>}
                              </p>
                              <p className="text-[10px] text-[#8ca3b3]">
                                {new Date(job.created_at).toLocaleString()}
                                {job.started_by && ` · ${job.started_by}`}
                              </p>
                            </div>
                          </div>
                          <span className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold capitalize ${badge.bg} ${badge.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                            {job.status}
                          </span>
                        </div>

                        {/* Compact progress */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="flex-1">
                            <div className="h-2 w-full overflow-hidden rounded-full bg-[#f0f4f7]">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  job.status === "completed" ? "bg-emerald-500" :
                                  job.status === "cancelled" ? "bg-amber-400" :
                                  "bg-red-400"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                          <span className="text-[12px] font-bold text-[#0a2a3c] tabular-nums">
                            {processed}/{job.total_recipients}
                          </span>
                        </div>

                        {/* Stats */}
                        <div className="flex items-center gap-5 text-[11px] text-[#6b8a9e]">
                          <span>Sent <strong className="text-emerald-600">{job.sent_count}</strong></span>
                          <span>Failed <strong className="text-red-600">{job.failed_count}</strong></span>
                          <span>Skipped <strong className="text-amber-600">{job.skipped_count}</strong></span>
                          {job.completed_at && (
                            <span className="ml-auto text-[10px] text-[#a0b4c0]">
                              Finished {new Date(job.completed_at).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </main>
      </MainContent>

      {/* New Send Modal */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowSendModal(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-5 text-[16px] font-bold text-[#0a2a3c]">Start Bulk Send</h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Touchpoint</label>
                <select
                  value={selectedTP}
                  onChange={(e) => setSelectedTP(Number(e.target.value))}
                  className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none"
                >
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>Touchpoint {n}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => setOnlyUnsent(!onlyUnsent)}
                className="flex items-center gap-3 rounded-xl border border-[#e0e8ee] bg-[#f7f9fb] px-4 py-3 text-left transition-colors hover:bg-[#f0f4f7] w-full"
              >
                <div className={`relative flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ${onlyUnsent ? "bg-[#054B70]" : "bg-[#d0dce4]"}`}>
                  <div className={`absolute h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${onlyUnsent ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                </div>
                <span className="text-[12px] font-medium text-[#4a6a7a] leading-snug">
                  Only send to contacts who haven&apos;t received this touchpoint yet
                </span>
              </button>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowSendModal(false)} className="rounded-xl px-5 py-2.5 text-[12px] font-semibold text-[#6b8a9e] hover:bg-[#f0f4f7]">
                  Cancel
                </button>
                <button
                  onClick={startSend}
                  disabled={sendingTP !== null}
                  className="btn-press rounded-xl bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
                >
                  {sendingTP !== null ? "Starting..." : "Start Sending"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
