"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Sidebar from "../../components/Sidebar";
import MainContent from "../../components/MainContent";
import MobileMenuButton from "../../components/MobileMenuButton";
import Select from "../../components/Select";
import { useAuth } from "../../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface PendingApproval {
  id: number;
  contact_id: number;
  email: string;
  org_name: string;
  contact_name: string;
  opt_out_reason: string;
  source: string;
  created_at: string;
}

interface HistoryEntry {
  id: number;
  email: string;
  org_name: string;
  contact_name: string;
  source: string;
  status: string;
  decided_by: string;
  decided_at: string;
  created_at: string;
}

function dateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

// Windowed pagination: 1 … 5 6 7 … 592 instead of every page number.
function pageItems(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | "…")[] = [1];
  const lo = Math.max(2, current - 1);
  const hi = Math.min(total - 1, current + 1);
  if (lo > 2) items.push("…");
  for (let n = lo; n <= hi; n++) items.push(n);
  if (hi < total - 1) items.push("…");
  items.push(total);
  return items;
}

/**
 * Pending approval — Beacon's dedicated page: opted-out contacts an import
 * tried to touch. Approve to bring them back, or keep them opted out.
 * "Who was approved" swaps to the reactivation history.
 */
export default function PendingApprovalPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [view, setView] = useState<"pending" | "history">("pending");
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<"org" | "seen">("seen");
  const [sortDesc, setSortDesc] = useState(true);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function fetchAll() {
    try {
      const [pRes, hRes] = await Promise.all([
        fetch(`${API}/contacts/pending-approvals/`, { credentials: "include" }),
        fetch(`${API}/contacts/reactivation-history/`, { credentials: "include" }),
      ]);
      const pData = await pRes.json();
      const hData = await hRes.json();
      if (pData.ok) setPending(pData.pending);
      if (hData.ok) setHistory(hData.history || hData.items || []);
    } catch { /* */ }
    setLoaded(true);
  }

  async function decide(ids: number[], action: "approve" | "keep") {
    try {
      const res = await fetch(`${API}/contacts/pending-approvals/decide/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast(action === "approve"
          ? `${data.decided} contact${data.decided === 1 ? "" : "s"} made active again`
          : `${data.decided} contact${data.decided === 1 ? "" : "s"} kept opted out`);
        setSel(new Set());
        fetchAll();
      } else {
        showToast(data.error || "Could not save the decision");
      }
    } catch {
      showToast("Network error");
    }
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

  const q = search.trim().toLowerCase();
  const filtered = pending
    .filter((p) => !q || [p.email, p.contact_name, p.org_name, p.opt_out_reason, p.source]
      .some((v) => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => {
      const cmp = sortCol === "org"
        ? (a.org_name || "").localeCompare(b.org_name || "")
        : a.created_at.localeCompare(b.created_at);
      return sortDesc ? -cmp : cmp;
    });
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const curPage = Math.min(page, totalPages);
  const shown = filtered.slice((curPage - 1) * perPage, curPage * perPage);
  const allSelected = filtered.length > 0 && filtered.every((p) => sel.has(p.id));
  const selIds = filtered.filter((p) => sel.has(p.id)).map((p) => p.id);

  const filteredHistory = history.filter((h) => !q || [h.email, h.contact_name, h.org_name, h.source, h.decided_by]
    .some((v) => (v || "").toLowerCase().includes(q)));

  function headerSort(col: "org" | "seen") {
    if (sortCol === col) setSortDesc(!sortDesc);
    else { setSortCol(col); setSortDesc(col === "seen"); }
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:hidden">
          <MobileMenuButton />
          <h1 className="text-[15px] font-bold text-gray-900">Pending approval</h1>
        </header>

        <main className="p-4 sm:p-8">
          {/* Filament page header: breadcrumb, big heading, actions */}
          <p className="mb-1 text-[12px] text-gray-400">
            <Link href="/contacts" className="hover:text-[#054B70] hover:underline">Contacts</Link>
            <span className="mx-1">›</span>
            {view === "pending" ? "Pending approval" : "Who was approved"}
          </p>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-[28px] font-bold tracking-tight text-gray-950">
              {view === "pending" ? "Pending approval" : "Who was approved"}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              {view === "pending" ? (
                <button
                  onClick={() => { setView("history"); setSearch(""); setPage(1); }}
                  className="btn-press flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                >
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  Who was approved
                </button>
              ) : (
                <button
                  onClick={() => { setView("pending"); setSearch(""); setPage(1); }}
                  className="btn-press flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                >
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" /></svg>
                  Pending approval
                </button>
              )}
              <Link
                href="/contacts"
                className="btn-press flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
              >
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" /></svg>
                Back to contacts
              </Link>
            </div>
          </div>
          {view === "history" && (
            <p className="mb-4 text-[13px] text-gray-500">Every opted-out contact that was made active again, and who approved it.</p>
          )}
          {view === "pending" && <div className="mb-4" />}

          {toast && (
            <div className="mb-5 rounded-lg bg-[#054B70]/5 px-4 py-3 text-[13px] font-semibold text-[#054B70] animate-slide-in">
              {toast}
            </div>
          )}

          {/* Filament table card */}
          <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
            {/* Toolbar: bulk actions left · search right */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-950/5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {view === "pending" && canEdit && selIds.length > 0 && (
                  <>
                    <span className="text-[12px] font-semibold text-gray-500">{selIds.length} selected</span>
                    <button
                      onClick={() => decide(selIds, "approve")}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-emerald-700"
                    >
                      Make active ({selIds.length})
                    </button>
                    <button
                      onClick={() => decide(selIds, "keep")}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100"
                    >
                      Keep opted out
                    </button>
                  </>
                )}
              </div>
              <div className="relative w-full max-w-xs">
                <svg className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search"
                  className="w-full rounded-lg bg-white py-2 pl-8 pr-3 text-[13px] text-gray-950 placeholder-gray-400 shadow-sm outline-none ring-1 ring-gray-950/10 focus:ring-2 focus:ring-[#054B70]"
                />
              </div>
            </div>

            {!loaded ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-10 rounded-lg bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                ))}
              </div>
            ) : view === "pending" ? (
              filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-400/15">
                    <svg className="h-6 w-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </span>
                  <p className="text-[15px] font-bold text-gray-950">Nothing waiting for approval</p>
                  <p className="max-w-md text-center text-[13px] text-gray-500">
                    When an import includes someone who opted out, they are left unchanged and show up here for you to review.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left">
                    <thead>
                      <tr className="border-b border-gray-950/5">
                        {canEdit && (
                          <th className="w-10 px-3 py-3 sm:px-4">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={(e) => setSel(e.target.checked
                                ? new Set([...sel, ...filtered.map((p) => p.id)])
                                : new Set([...sel].filter((id) => !filtered.some((p) => p.id === id))))}
                              className="rounded border-gray-300"
                            />
                          </th>
                        )}
                        <th className="px-3 py-3 sm:px-4">
                          <button onClick={() => headerSort("org")} className="flex items-center gap-1 text-[13px] font-semibold text-gray-950">
                            Organisation
                            <svg className={`h-3.5 w-3.5 text-gray-400 transition-transform ${sortCol === "org" && sortDesc ? "rotate-180" : ""} ${sortCol === "org" ? "" : "opacity-0"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                          </button>
                        </th>
                        <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Contact</th>
                        <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Email</th>
                        <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Why they opted out</th>
                        <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Seen in an import</th>
                        <th className="px-3 py-3 sm:px-4">
                          <button onClick={() => headerSort("seen")} className="flex items-center gap-1 whitespace-nowrap text-[13px] font-semibold text-gray-950">
                            Date of import
                            <svg className={`h-3.5 w-3.5 text-gray-400 transition-transform ${sortCol === "seen" && sortDesc ? "rotate-180" : ""} ${sortCol === "seen" ? "" : "opacity-0"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                          </button>
                        </th>
                        {canEdit && <th className="px-3 py-3 sm:px-4" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-950/5">
                      {shown.map((p) => (
                        <tr key={p.id} className="transition-colors hover:bg-gray-50">
                          {canEdit && (
                            <td className="px-3 py-3.5 sm:px-4">
                              <input
                                type="checkbox"
                                checked={sel.has(p.id)}
                                onChange={() => setSel((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(p.id)) next.delete(p.id);
                                  else next.add(p.id);
                                  return next;
                                })}
                                className="rounded border-gray-300"
                              />
                            </td>
                          )}
                          <td className="whitespace-nowrap px-3 py-3.5 text-[13px] font-bold text-gray-950 sm:px-4">{p.org_name || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-[13px] text-gray-950 sm:px-4">{p.contact_name || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-[13px] text-gray-950 sm:px-4">{p.email}</td>
                          <td className="w-full max-w-[320px] truncate px-3 py-3.5 text-[13px] text-gray-500 sm:px-4" title={p.opt_out_reason}>
                            {p.opt_out_reason || <span className="text-gray-400">No reason given</span>}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-[13px] text-gray-950 sm:px-4">
                            {p.source.replace(/^Import:\s*/i, "") || "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-[13px] text-gray-500 sm:px-4">
                            {dateTime(p.created_at)}
                          </td>
                          {canEdit && (
                            <td className="whitespace-nowrap px-3 py-3.5 text-right sm:px-4">
                              <div className="flex justify-end gap-1.5">
                                <button
                                  onClick={() => decide([p.id], "approve")}
                                  className="btn-press inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                                >
                                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
                                  Make active
                                </button>
                                <button
                                  onClick={() => decide([p.id], "keep")}
                                  className="btn-press inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-500 hover:bg-gray-100"
                                >
                                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                                  Keep opted out
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-400/15">
                  <svg className="h-6 w-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </span>
                <p className="text-[15px] font-bold text-gray-950">No decisions yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left">
                  <thead>
                    <tr className="border-b border-gray-950/5">
                      <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Organisation</th>
                      <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Contact</th>
                      <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Email</th>
                      <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Decision</th>
                      <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Approved by</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-950/5">
                    {filteredHistory.map((h) => (
                      <tr key={h.id} className="transition-colors hover:bg-gray-50">
                        <td className="px-3 py-3.5 text-[13px] font-bold text-gray-950 sm:px-4">{h.org_name || "—"}</td>
                        <td className="px-3 py-3.5 text-[13px] text-gray-950 sm:px-4">{h.contact_name || "—"}</td>
                        <td className="px-3 py-3.5 text-[13px] text-gray-950 sm:px-4">{h.email}</td>
                        <td className="px-3 py-3.5 sm:px-4">
                          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                            h.status === "approved" ? "bg-emerald-500/[.12] text-emerald-800" : "bg-gray-400/[.15] text-gray-600"
                          }`}>
                            {h.status === "approved" ? "Made active" : "Kept opted out"}
                          </span>
                        </td>
                        <td className="px-3 py-3.5 sm:px-4">
                          <span className="block text-[13px] text-gray-950">{h.decided_by || "—"}</span>
                          {h.decided_at && <span className="block text-[12px] text-gray-500">{dateTime(h.decided_at)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination footer (pending view) */}
            {loaded && view === "pending" && filtered.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-950/5 px-4 py-3">
                <span className="text-[12px] text-gray-500">
                  Showing <strong className="text-gray-950">{(curPage - 1) * perPage + 1}</strong> to{" "}
                  <strong className="text-gray-950">{Math.min(curPage * perPage, filtered.length)}</strong> of{" "}
                  <strong className="text-gray-950">{filtered.length}</strong> results
                </span>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-[12px] text-gray-500">
                    <span>Per page</span>
                    <Select
                      value={String(perPage)}
                      onChange={(v) => { setPerPage(Number(v)); setPage(1); }}
                      options={[{ value: "10", label: "10" }, { value: "25", label: "25" }, { value: "50", label: "50" }, { value: "100", label: "100" }]}
                      size="sm"
                    />
                  </div>
                  {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => setPage(Math.max(1, curPage - 1))} disabled={curPage === 1} className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-gray-500 hover:bg-gray-100 disabled:opacity-40" aria-label="Previous">‹</button>
                      {pageItems(curPage, totalPages).map((n, i) => (
                        n === "…" ? (
                          <span key={`gap-${i}`} className="px-1.5 text-[13px] text-gray-400">…</span>
                        ) : (
                          <button
                            key={n}
                            onClick={() => setPage(n)}
                            className={`min-w-8 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold ${n === curPage ? "bg-[#054B70]/10 text-[#054B70]" : "text-gray-500 hover:bg-gray-100"}`}
                          >
                            {n}
                          </button>
                        )
                      ))}
                      <button onClick={() => setPage(Math.min(totalPages, curPage + 1))} disabled={curPage === totalPages} className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-gray-500 hover:bg-gray-100 disabled:opacity-40" aria-label="Next">›</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </MainContent>
    </div>
  );
}
