"use client";

import { useState, useEffect, useRef } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface Contact {
  id: number;
  org_name: string;
  contact_name: string;
  email: string;
  phone: string;
  status: string;
  opt_out_reason: string;
  notes: string;
  last_touchpoint: number;
  import_group_id: number | null;
  import_group_name: string | null;
  segment_id: number | null;
  segment_name: string | null;
  created_at: string;
  updated_at: string;
}

interface Counts {
  total: number;
  active: number;
  inactive: number;
  opted_out: number;
  undeliverable: number;
  bounced: number;
  moved_to_hubspot: number;
}

interface ImportGroupInfo {
  id: number;
  name: string;
  contact_count: number;
  created_at: string;
}

interface SegmentInfo {
  id: number;
  name: string;
  import_group_id: number;
  contact_count: number;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  { value: "inactive", label: "Inactive", color: "bg-gray-100 text-gray-600", dot: "bg-gray-400" },
  { value: "undeliverable", label: "Undeliverable", color: "bg-orange-50 text-orange-600", dot: "bg-orange-500" },
  { value: "opted_out", label: "Opt-out", color: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  { value: "moved_to_hubspot", label: "Moved to HubSpot", color: "bg-blue-50 text-blue-600", dot: "bg-blue-500" },
];

// Legacy/SES "bounced" is shown as Undeliverable.
function displayStatusValue(status: string) {
  return status === "bounced" ? "undeliverable" : status;
}

function statusBadge(status: string) {
  const displayStatus = displayStatusValue(status);
  const opt = STATUS_OPTIONS.find((s) => s.value === displayStatus);
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${opt?.color || "bg-gray-100 text-gray-500"}`}>
      {opt?.label || status}
    </span>
  );
}

export default function ContactsPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [counts, setCounts] = useState<Counts>({ total: 0, active: 0, inactive: 0, opted_out: 0, undeliverable: 0, bounced: 0, moved_to_hubspot: 0 });
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [tpFilter, setTpFilter] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const [groupFilter, setGroupFilter] = useState<string>("");
  const [segmentFilter, setSegmentFilter] = useState<string>("");
  const [importGroups, setImportGroups] = useState<ImportGroupInfo[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // Import target selection. *Id "" + name "" = none; *Id "new" = create from *Name.
  const [importGroupId, setImportGroupId] = useState<string>("");
  const [importGroupName, setImportGroupName] = useState("");
  const [importSegmentId, setImportSegmentId] = useState<string>("");
  const [importSegmentName, setImportSegmentName] = useState("");
  // Bulk assign-to-segment
  const [showAssignSegment, setShowAssignSegment] = useState(false);
  const [assignGroupId, setAssignGroupId] = useState<string>("");
  const [assignGroupName, setAssignGroupName] = useState("");
  const [assignSegmentId, setAssignSegmentId] = useState<string>("");
  const [assignSegmentName, setAssignSegmentName] = useState("");

  // Inline editing state: maps contact id -> field -> value
  const [inlineEdits, setInlineEdits] = useState<Record<number, Record<string, string>>>({});
  const [savingInline, setSavingInline] = useState<Set<number>>(new Set());

  // Add/edit form
  const [form, setForm] = useState({ org_name: "", contact_name: "", email: "", phone: "", status: "active", notes: "" });

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function fetchContacts() {
    try {
      const params = new URLSearchParams();
      if (filter) params.set("status", filter);
      if (search) params.set("search", search);
      if (tpFilter) params.set("last_touchpoint", tpFilter);
      if (groupFilter) params.set("import_group", groupFilter);
      if (segmentFilter) params.set("segment", segmentFilter);
      const res = await fetch(`${API}/contacts/?${params}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setContacts(data.contacts);
        setCounts(data.counts);
        if (data.import_groups) setImportGroups(data.import_groups);
        if (data.segments) setSegments(data.segments);
      }
    } catch { /* */ }
    setLoaded(true);
  }

  useEffect(() => {
    fetchContacts();
  }, [filter, search, tpFilter, groupFilter, segmentFilter]);

  // --- Inline editing helpers ---
  function startInlineEdit(c: Contact) {
    setInlineEdits((prev) => ({
      ...prev,
      [c.id]: {
        org_name: c.org_name,
        contact_name: c.contact_name,
        email: c.email,
        phone: c.phone,
        status: c.status,
        opt_out_reason: c.opt_out_reason || "",
        notes: c.notes,
      },
    }));
  }

  function cancelInlineEdit(id: number) {
    setInlineEdits((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function updateInlineField(id: number, field: string, value: string) {
    setInlineEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  }

  async function saveInlineEdit(id: number) {
    const edits = inlineEdits[id];
    if (!edits) return;

    setSavingInline((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`${API}/contacts/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...edits }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        cancelInlineEdit(id);
        showToast("Contact updated");
        fetchContacts();
      } else {
        showToast(data.error || "Error");
      }
    } catch {
      showToast("Error saving");
    }
    setSavingInline((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // Quick status change (no need to enter full edit mode)
  async function quickStatusChange(id: number, newStatus: string) {
    try {
      const res = await fetch(`${API}/contacts/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: newStatus }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast("Status updated");
        fetchContacts();
      } else {
        showToast(data.error || "Error");
      }
    } catch {
      showToast("Error updating status");
    }
  }

  // Bulk status change
  async function bulkStatusChange(newStatus: string) {
    if (selected.size === 0) return;
    try {
      const res = await fetch(`${API}/contacts/bulk-update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), status: newStatus }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Updated ${data.updated} contact(s) to ${STATUS_OPTIONS.find(s => s.value === newStatus)?.label}`);
        setSelected(new Set());
        fetchContacts();
      } else {
        showToast(data.error || "Error");
      }
    } catch {
      showToast("Error updating");
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(`${API}/contacts/create/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
      credentials: "include",
    });
    const data = await res.json();
    if (data.ok) {
      setShowAdd(false);
      setForm({ org_name: "", contact_name: "", email: "", phone: "", status: "active", notes: "" });
      showToast("Contact added");
      fetchContacts();
    } else {
      showToast(data.error || "Error");
    }
  }

  async function handleUpdate() {
    if (!editing) return;
    const res = await fetch(`${API}/contacts/update/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editing, ...form }),
      credentials: "include",
    });
    const data = await res.json();
    if (data.ok) {
      setEditing(null);
      showToast("Contact updated");
      fetchContacts();
    } else {
      showToast(data.error || "Error");
    }
  }

  function startEdit(c: Contact) {
    setEditing(c.id);
    setForm({ org_name: c.org_name, contact_name: c.contact_name, email: c.email, phone: c.phone, status: c.status, notes: c.notes });
  }

  async function handleDelete(ids: number[]) {
    if (!confirm(`Delete ${ids.length} contact(s)?`)) return;
    const res = await fetch(`${API}/contacts/delete/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      credentials: "include",
    });
    const data = await res.json();
    if (data.ok) {
      setSelected(new Set());
      showToast(`Deleted ${data.deleted} contact(s)`);
      fetchContacts();
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setImportGroupId("");
    setImportGroupName("");
    setImportSegmentId("");
    setImportSegmentName("");
    setShowImportModal(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleImport() {
    if (!pendingFile) return;
    setImporting(true);
    setShowImportModal(false);
    const fd = new FormData();
    fd.append("file", pendingFile);
    // Import group: existing id, or a new name
    if (importGroupId === "new" && importGroupName.trim()) {
      fd.append("group_name", importGroupName.trim());
    } else if (importGroupId && importGroupId !== "new") {
      fd.append("group_id", importGroupId);
    }
    // Segment: existing id, or a new name (requires a group)
    if (importSegmentId === "new" && importSegmentName.trim()) {
      fd.append("segment_name", importSegmentName.trim());
    } else if (importSegmentId && importSegmentId !== "new") {
      fd.append("segment_id", importSegmentId);
    }
    try {
      const res = await fetch(`${API}/contacts/import/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        const groupMsg = data.import_group ? ` into "${data.import_group.name}"` : "";
        const segMsg = data.segment ? ` · ${data.segment.name}` : "";
        const updatedMsg = data.updated ? `, ${data.updated} re-tagged` : "";
        showToast(`Imported ${data.created} contacts${groupMsg}${segMsg} (${data.skipped} skipped${updatedMsg})`);
        fetchContacts();
      } else {
        showToast(data.error || "Import failed");
      }
    } catch {
      showToast("Import error");
    }
    setImporting(false);
    setPendingFile(null);
  }

  // Assign selected contacts to a segment (existing or newly created)
  async function handleAssignSegment() {
    if (selected.size === 0) return;
    let segmentId: number | null = null;
    try {
      // Typing a name always creates/reuses a new segment; otherwise use the picked chip.
      if (assignSegmentName.trim()) {
        const body: Record<string, unknown> = { name: assignSegmentName.trim() };
        if (assignGroupId === "new" && assignGroupName.trim()) body.group_name = assignGroupName.trim();
        else if (assignGroupId && assignGroupId !== "new") body.group_id = Number(assignGroupId);
        else { showToast("Pick or name an import group first"); return; }
        const res = await fetch(`${API}/segments/create/`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), credentials: "include",
        });
        const data = await res.json();
        if (!data.ok) { showToast(data.error || "Could not create segment"); return; }
        segmentId = data.segment.id;
      } else if (assignSegmentId && assignSegmentId !== "new") {
        segmentId = Number(assignSegmentId);
      } else {
        showToast("Pick a segment or type a new name"); return;
      }

      const res = await fetch(`${API}/contacts/bulk-update/`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), segment_id: segmentId }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Assigned ${data.updated} contact(s) to segment`);
        setShowAssignSegment(false);
        setSelected(new Set());
        setAssignGroupId(""); setAssignGroupName(""); setAssignSegmentId(""); setAssignSegmentName("");
        fetchContacts();
      } else {
        showToast(data.error || "Error assigning segment");
      }
    } catch {
      showToast("Error assigning segment");
    }
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === contacts.length) setSelected(new Set());
    else setSelected(new Set(contacts.map((c) => c.id)));
  }

  function downloadTemplate() {
    const headers = "org_name,contact_name,email,phone";
    const example1 = "Acme Corp,John Smith,john@acmecorp.com,555-123-4567";
    const example2 = "Global Industries,Jane Doe,jane@globalind.com,555-987-6543";
    const csv = `${headers}\n${example1}\n${example2}\n`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts_import_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Inline cell class
  const cellInput = "w-full bg-transparent border border-[#054B70]/20 rounded-lg px-2 py-1.5 text-[12px] text-[#0a2a3c] outline-none focus:border-[#054B70] focus:ring-1 focus:ring-[#054B70]/20 transition-all";

  // --- Group / segment pill-filter helpers ---
  const groupPillCls = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all ${
      active
        ? "bg-[#054B70] text-white shadow-sm"
        : "bg-white text-[#6b8a9e] border border-[#e0e8ee] hover:border-[#054B70] hover:text-[#054B70]"
    }`;
  const segPillCls = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all ${
      active
        ? "bg-teal-600 text-white shadow-sm"
        : "bg-white text-teal-600 border border-teal-200 hover:bg-teal-50"
    }`;
  const sumGroupCounts = importGroups.reduce((a, g) => a + g.contact_count, 0);
  const noGroupCount = Math.max(0, counts.total - sumGroupCounts);
  const selectedGroup = importGroups.find((g) => String(g.id) === groupFilter);
  // Segments to show: scoped to the selected group, else all segments across groups.
  const groupSegments =
    groupFilter && groupFilter !== "none"
      ? segments.filter((s) => String(s.import_group_id) === groupFilter)
      : segments;
  const segmentScopeTotal = selectedGroup ? selectedGroup.contact_count : counts.total;
  const groupNoSegmentCount = Math.max(
    0,
    segmentScopeTotal - groupSegments.reduce((a, s) => a + s.contact_count, 0)
  );

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f4f7]">
        <div className="flex flex-col items-center gap-3">
          <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#f0f4f7]">
      <Sidebar />
      <MainContent>
        {/* Header */}
        <header className="sticky top-0 z-30 border-b border-[#e0e8ee] bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <MobileMenuButton />
              <div className="min-w-0">
                <h1 className="text-[15px] font-bold text-[#0a2a3c] sm:text-[16px]">Contacts Database</h1>
                <p className="truncate text-[10px] text-[#8ca3b3] sm:text-[11px]">Manage your contact list, imports, and statuses</p>
              </div>
            </div>
            {canEdit && (
              <button
                onClick={() => { setShowAdd(true); setEditing(null); setForm({ org_name: "", contact_name: "", email: "", phone: "", status: "active", notes: "" }); }}
                className="btn-press flex items-center gap-1.5 rounded-xl bg-[#054B70] px-4 py-2 text-[12px] font-bold text-white sm:hidden"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
                Add
              </button>
            )}
          </div>
          {canEdit && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={downloadTemplate}
                className="btn-press flex items-center gap-1.5 rounded-xl bg-[#f0f4f7] px-3 py-2 text-[11px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#054B70] hover:text-white sm:px-4 sm:py-2.5 sm:text-[12px]"
                title="Download a sample CSV template with the correct columns"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <span className="hidden xs:inline">CSV</span> Template
              </button>
              <label className="btn-press flex cursor-pointer items-center gap-1.5 rounded-xl bg-[#f0f4f7] px-3 py-2 text-[11px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#054B70] hover:text-white sm:px-4 sm:py-2.5 sm:text-[12px]">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                {importing ? "Importing..." : "Import CSV"}
                <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileSelect} />
              </label>
              <a
                href={`${API}/contacts/export/`}
                className="btn-press flex items-center gap-1.5 rounded-xl bg-[#f0f4f7] px-3 py-2 text-[11px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#054B70] hover:text-white sm:px-4 sm:py-2.5 sm:text-[12px]"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                Export CSV
              </a>
              <button
                onClick={() => { setShowAdd(true); setEditing(null); setForm({ org_name: "", contact_name: "", email: "", phone: "", status: "active", notes: "" }); }}
                className="btn-press hidden items-center gap-1.5 rounded-xl bg-[#054B70] px-5 py-2.5 text-[12px] font-bold text-white sm:flex"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
                Add Contact
              </button>
            </div>
          )}
        </header>

        <main className="p-4 sm:p-8">
          {/* Toast */}
          {toast && (
            <div className="mb-5 flex items-center gap-2 rounded-xl bg-[#054B70]/5 px-4 py-3 text-[13px] font-semibold text-[#054B70] animate-slide-in">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
              {toast}
            </div>
          )}

          {/* Stats cards */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 animate-fade-in">
            {[
              { label: "Total", value: counts.total, color: "text-[#054B70]", bg: "bg-[#054B70]/5", filterVal: "" },
              { label: "Active", value: counts.active, color: "text-emerald-600", bg: "bg-emerald-50", filterVal: "active" },
              { label: "Inactive", value: counts.inactive, color: "text-gray-600", bg: "bg-gray-100", filterVal: "inactive" },
              { label: "Undeliverable", value: counts.undeliverable, color: "text-orange-600", bg: "bg-orange-50", filterVal: "undeliverable" },
              { label: "Opt-out", value: counts.opted_out, color: "text-amber-600", bg: "bg-amber-50", filterVal: "opted_out" },
              { label: "Moved to HubSpot", value: counts.moved_to_hubspot, color: "text-blue-600", bg: "bg-blue-50", filterVal: "moved_to_hubspot" },
            ].map((s) => (
              <button
                key={s.label}
                onClick={() => setFilter(filter === s.filterVal ? "" : s.filterVal)}
                className={`group rounded-2xl p-5 text-left shadow-sm transition-all duration-200 ${
                  filter === s.filterVal ? `${s.bg} ring-2 ring-current ${s.color}` : "bg-white hover:shadow-md"
                }`}
              >
                <p className={`text-[24px] font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[11px] font-semibold text-[#8ca3b3] mt-1">{s.label}</p>
              </button>
            ))}
          </div>

          {/* Filters bar */}
          <div className="mb-5 flex flex-wrap items-center gap-2 sm:gap-3 animate-fade-in-up" style={{ animationDelay: "0.05s" }}>
            <div className="relative w-full sm:flex-1 sm:max-w-md">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#b0c4d0]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts..."
                className="input-glow w-full rounded-xl border border-[#d0dce4] bg-white py-2.5 pl-10 pr-4 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
              />
            </div>

            {/* Status filter */}
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="flex-1 min-w-0 rounded-xl border border-[#d0dce4] bg-white px-3 py-2.5 text-[12px] font-medium text-[#0a2a3c] outline-none sm:flex-none"
            >
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>

            {/* Touchpoint filter */}
            <select
              value={tpFilter}
              onChange={(e) => setTpFilter(e.target.value)}
              className="flex-1 min-w-0 rounded-xl border border-[#d0dce4] bg-white px-3 py-2.5 text-[12px] font-medium text-[#0a2a3c] outline-none sm:flex-none"
            >
              <option value="">All Touchpoints</option>
              <option value="none">No Touchpoint Sent</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>Touchpoint {n}</option>
              ))}
            </select>

            {/* Clear filters */}
            {(filter || search || tpFilter || groupFilter || segmentFilter) && (
              <button
                onClick={() => { setFilter(""); setSearch(""); setTpFilter(""); setGroupFilter(""); setSegmentFilter(""); }}
                className="flex items-center gap-1 rounded-xl px-3 py-2.5 text-[12px] font-medium text-[#8ca3b3] transition-colors hover:bg-[#f0f4f7] hover:text-[#054B70]"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                Clear
              </button>
            )}

            {/* Bulk actions when items selected */}
            {selected.size > 0 && canEdit && (
              <div className="flex items-center gap-2 ml-auto animate-fade-in">
                <span className="text-[12px] font-semibold text-[#6b8a9e]">{selected.size} selected</span>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      bulkStatusChange(e.target.value);
                      e.target.value = "";
                    }
                  }}
                  className="rounded-xl border border-[#054B70]/20 bg-[#054B70]/5 px-3 py-2 text-[12px] font-semibold text-[#054B70] outline-none cursor-pointer"
                >
                  <option value="" disabled>Change Status...</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    setAssignGroupId(groupFilter && groupFilter !== "none" ? groupFilter : "");
                    setAssignGroupName(""); setAssignSegmentId(""); setAssignSegmentName("");
                    setShowAssignSegment(true);
                  }}
                  className="btn-press rounded-xl border border-purple-200 bg-purple-50 px-4 py-2 text-[12px] font-semibold text-purple-600 transition-all hover:bg-purple-100"
                >
                  Assign Segment
                </button>
                <button
                  onClick={() => handleDelete(Array.from(selected))}
                  className="btn-press rounded-xl border border-red-200 px-4 py-2 text-[12px] font-semibold text-red-500 transition-all hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          {/* Group & segment pill filter */}
          {importGroups.length > 0 && (
            <div className="mb-5 rounded-2xl bg-white p-4 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.07s" }}>
              {/* Groups row */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Groups</span>
                <button
                  onClick={() => { setGroupFilter(""); setSegmentFilter(""); }}
                  className={groupPillCls(groupFilter === "")}
                >
                  All <span className="opacity-60">{counts.total}</span>
                </button>
                {importGroups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => { setGroupFilter(String(g.id)); setSegmentFilter(""); }}
                    className={groupPillCls(groupFilter === String(g.id))}
                  >
                    {g.name} <span className="opacity-60">{g.contact_count}</span>
                  </button>
                ))}
                {noGroupCount > 0 && (
                  <button
                    onClick={() => { setGroupFilter("none"); setSegmentFilter(""); }}
                    className={groupPillCls(groupFilter === "none")}
                  >
                    No Group <span className="opacity-60">{noGroupCount}</span>
                  </button>
                )}
              </div>

              {/* Segments row — shows whenever segments exist (scoped to the selected group) */}
              {groupSegments.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#f0f4f7] pt-3">
                  <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Segments</span>
                  <button
                    onClick={() => setSegmentFilter("")}
                    className={segPillCls(segmentFilter === "")}
                  >
                    All
                  </button>
                  {groupSegments.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { if (!groupFilter || groupFilter === "none") setGroupFilter(""); setSegmentFilter(String(s.id)); }}
                      className={segPillCls(segmentFilter === String(s.id))}
                    >
                      {s.name} <span className="opacity-60">{s.contact_count}</span>
                    </button>
                  ))}
                  {groupNoSegmentCount > 0 && (
                    <button
                      onClick={() => setSegmentFilter("none")}
                      className={segPillCls(segmentFilter === "none")}
                    >
                      No Segment <span className="opacity-60">{groupNoSegmentCount}</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 border-t border-[#f0f4f7] pt-3 text-[11px] text-[#8ca3b3]">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Segments</span>
                  <span>No segments yet — select contacts below and click <strong className="font-semibold text-[#054B70]">Assign Segment</strong> to create one.</span>
                </div>
              )}
            </div>
          )}

          {/* Table */}
          <div className="rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in-up -mx-4 sm:mx-0" style={{ animationDelay: "0.1s" }}>
            {!loaded ? (
              <div className="p-8">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="mb-3 h-12 rounded-xl bg-gradient-to-r from-[#f0f4f7] via-white to-[#f0f4f7] bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                ))}
              </div>
            ) : contacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-[#8ca3b3]">
                <svg className="mb-3 h-12 w-12 text-[#d0dce4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1">
                  <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <p className="text-[14px] font-semibold">No contacts found</p>
                <p className="mt-1 text-[12px]">Import a CSV or add contacts manually</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[700px]">
                <thead>
                  <tr className="border-b border-[#e8eff3] text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    <th className="px-3 py-3 w-10 sm:px-4">
                      <input type="checkbox" checked={selected.size === contacts.length && contacts.length > 0} onChange={toggleAll} className="rounded border-[#d0dce4]" />
                    </th>
                    <th className="px-3 py-3 sm:px-4">Organization</th>
                    <th className="px-3 py-3 sm:px-4">Contact</th>
                    <th className="px-3 py-3 sm:px-4">Email</th>
                    <th className="hidden px-3 py-3 md:table-cell sm:px-4">Phone</th>
                    <th className="px-3 py-3 sm:px-4">Status</th>
                    <th className="hidden px-3 py-3 lg:table-cell sm:px-4">Group</th>
                    <th className="hidden px-3 py-3 lg:table-cell sm:px-4">Segment</th>
                    <th className="hidden px-3 py-3 lg:table-cell sm:px-4">Last TP</th>
                    {canEdit && <th className="px-3 py-3 w-24 sm:px-4 sm:w-28">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const isInlineEditing = !!inlineEdits[c.id];
                    const isSaving = savingInline.has(c.id);
                    const edit = inlineEdits[c.id];

                    return (
                      <tr key={c.id} className={`border-b border-[#f0f4f7] transition-colors ${isInlineEditing ? "bg-[#054B70]/[0.02]" : "hover:bg-[#f7f9fb]"}`}>
                        <td className="px-3 py-2.5 sm:px-4">
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="rounded border-[#d0dce4]" />
                        </td>

                        {/* Organization */}
                        <td className="px-3 py-2.5 sm:px-4">
                          {isInlineEditing ? (
                            <input
                              value={edit.org_name}
                              onChange={(e) => updateInlineField(c.id, "org_name", e.target.value)}
                              className={cellInput}
                            />
                          ) : (
                            <span className="text-[12px] font-medium text-[#0a2a3c] sm:text-[13px]">{c.org_name || "—"}</span>
                          )}
                        </td>

                        {/* Contact Name */}
                        <td className="px-3 py-2.5 sm:px-4">
                          {isInlineEditing ? (
                            <input
                              value={edit.contact_name}
                              onChange={(e) => updateInlineField(c.id, "contact_name", e.target.value)}
                              className={cellInput}
                            />
                          ) : (
                            <span className="text-[12px] text-[#4a6a7a] sm:text-[13px]">{c.contact_name || "—"}</span>
                          )}
                        </td>

                        {/* Email */}
                        <td className="px-3 py-2.5 sm:px-4">
                          {isInlineEditing ? (
                            <input
                              type="email"
                              value={edit.email}
                              onChange={(e) => updateInlineField(c.id, "email", e.target.value)}
                              className={`${cellInput} font-mono`}
                            />
                          ) : (
                            <span className="text-[11px] text-[#6b8a9e] font-mono sm:text-[13px] break-all">{c.email}</span>
                          )}
                        </td>

                        {/* Phone */}
                        <td className="hidden px-3 py-2.5 md:table-cell sm:px-4">
                          {isInlineEditing ? (
                            <input
                              value={edit.phone}
                              onChange={(e) => updateInlineField(c.id, "phone", e.target.value)}
                              className={cellInput}
                            />
                          ) : (
                            <span className="text-[13px] text-[#6b8a9e]">{c.phone || "—"}</span>
                          )}
                        </td>

                        {/* Status - styled dropdown that looks like a badge */}
                        <td className="px-4 py-2.5">
                          {canEdit ? (
                            (() => {
                              const rawStatus = isInlineEditing ? edit.status : c.status;
                              const currentStatus = displayStatusValue(rawStatus);
                              const opt = STATUS_OPTIONS.find((s) => s.value === currentStatus);
                              return (
                                <div>
                                  <div className="relative inline-block">
                                    <select
                                      value={currentStatus}
                                      onChange={(e) => {
                                        if (isInlineEditing) {
                                          updateInlineField(c.id, "status", e.target.value);
                                        } else {
                                          quickStatusChange(c.id, e.target.value);
                                        }
                                      }}
                                      className={`appearance-none rounded-full px-2.5 py-0.5 pr-6 text-[10px] font-semibold outline-none cursor-pointer border-0 ${opt?.color || "bg-gray-100 text-gray-500"}`}
                                    >
                                      {STATUS_OPTIONS.map((s) => (
                                        <option key={s.value} value={s.value}>{s.label}</option>
                                      ))}
                                    </select>
                                    <svg className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M19 9l-7 7-7-7" /></svg>
                                  </div>
                                  {/* Opt-out reason */}
                                  {currentStatus === "opted_out" && isInlineEditing && (
                                    <input
                                      value={edit.opt_out_reason || ""}
                                      onChange={(e) => updateInlineField(c.id, "opt_out_reason", e.target.value)}
                                      placeholder="Reason for opt-out..."
                                      className="mt-1 w-full rounded-lg border border-amber-200 bg-amber-50/50 px-2 py-1 text-[10px] text-amber-700 placeholder-amber-300 outline-none focus:border-amber-400"
                                    />
                                  )}
                                  {currentStatus === "opted_out" && !isInlineEditing && c.opt_out_reason && (
                                    <p className="mt-0.5 text-[10px] text-amber-500 truncate max-w-[140px]" title={c.opt_out_reason}>
                                      {c.opt_out_reason}
                                    </p>
                                  )}
                                </div>
                              );
                            })()
                          ) : (
                            <div>
                              {statusBadge(c.status)}
                              {c.status === "opted_out" && c.opt_out_reason && (
                                <p className="mt-0.5 text-[10px] text-amber-500 truncate max-w-[140px]" title={c.opt_out_reason}>
                                  {c.opt_out_reason}
                                </p>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Group */}
                        <td className="hidden px-3 py-2.5 lg:table-cell sm:px-4">
                          {c.import_group_name ? (
                            <button
                              onClick={() => setGroupFilter(String(c.import_group_id))}
                              className="rounded-full bg-purple-50 px-2.5 py-0.5 text-[10px] font-semibold text-purple-600 hover:bg-purple-100 transition-colors"
                              title={`Filter by "${c.import_group_name}"`}
                            >
                              {c.import_group_name}
                            </button>
                          ) : (
                            <span className="text-[13px] text-[#c0cdd6]">—</span>
                          )}
                        </td>

                        {/* Segment */}
                        <td className="hidden px-3 py-2.5 lg:table-cell sm:px-4">
                          {c.segment_name ? (
                            <button
                              onClick={() => { if (c.import_group_id) setGroupFilter(String(c.import_group_id)); setSegmentFilter(String(c.segment_id)); }}
                              className="rounded-full bg-teal-50 px-2.5 py-0.5 text-[10px] font-semibold text-teal-600 hover:bg-teal-100 transition-colors"
                              title={`Filter by segment "${c.segment_name}"`}
                            >
                              {c.segment_name}
                            </button>
                          ) : (
                            <span className="text-[13px] text-[#c0cdd6]">—</span>
                          )}
                        </td>

                        {/* Last TP */}
                        <td className="hidden px-3 py-2.5 text-[13px] text-[#8ca3b3] lg:table-cell sm:px-4">
                          {c.last_touchpoint > 0 ? (
                            <span className="rounded-full bg-[#054B70]/8 px-2 py-0.5 text-[10px] font-semibold text-[#054B70]">TP {c.last_touchpoint}</span>
                          ) : "—"}
                        </td>

                        {/* Actions */}
                        {canEdit && (
                          <td className="px-3 py-2.5 sm:px-4">
                            {isInlineEditing ? (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => saveInlineEdit(c.id)}
                                  disabled={isSaving}
                                  className="rounded-lg bg-[#054B70] p-1.5 text-white hover:bg-[#043d5c] disabled:opacity-50 transition-colors"
                                  title="Save"
                                >
                                  {isSaving ? (
                                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                  ) : (
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
                                  )}
                                </button>
                                <button
                                  onClick={() => cancelInlineEdit(c.id)}
                                  className="rounded-lg bg-gray-100 p-1.5 text-[#6b8a9e] hover:bg-gray-200 transition-colors"
                                  title="Cancel"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-1">
                                <button onClick={() => startInlineEdit(c)} className="rounded-lg p-1.5 text-[#8ca3b3] hover:bg-[#054B70]/5 hover:text-[#054B70]" title="Edit">
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                </button>
                                {user?.role === "admin" && (
                                  <button onClick={() => handleDelete([c.id])} className="rounded-lg p-1.5 text-[#8ca3b3] hover:bg-red-50 hover:text-red-500" title="Delete">
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </div>
        </main>
      </MainContent>

      {/* Import modal: choose import group + segment (existing or new) */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => { setShowImportModal(false); setPendingFile(null); }}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-[#0a2a3c]">Import Contacts</h2>
            <p className="mb-5 text-[12px] text-[#8ca3b3]">
              Group this batch by region (import group) and optionally tag it with a segment. New contacts start at Touchpoint 1.
            </p>

            {/* Import group */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                Import Group
              </label>
              <select
                value={importGroupId}
                onChange={(e) => { setImportGroupId(e.target.value); setImportSegmentId(""); setImportSegmentName(""); }}
                className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] outline-none"
              >
                <option value="">No group</option>
                {importGroups.map((g) => (
                  <option key={g.id} value={String(g.id)}>{g.name} ({g.contact_count})</option>
                ))}
                <option value="new">+ Create new group…</option>
              </select>
              {importGroupId === "new" && (
                <input
                  type="text"
                  value={importGroupName}
                  onChange={(e) => setImportGroupName(e.target.value)}
                  placeholder="e.g., American Data, Q2 2026"
                  className="input-glow mt-2 w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  autoFocus
                />
              )}
            </div>

            {/* Segment (only when a group is chosen/created) */}
            {(importGroupId === "new" || (importGroupId && importGroupId !== "new")) && (
              <div className="mb-4">
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                  Segment <span className="font-medium normal-case text-[#b0c4d0]">(optional)</span>
                </label>
                <select
                  value={importSegmentId}
                  onChange={(e) => setImportSegmentId(e.target.value)}
                  className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] outline-none"
                >
                  <option value="">No segment</option>
                  {importGroupId !== "new" && segments
                    .filter((s) => String(s.import_group_id) === importGroupId)
                    .map((s) => (
                      <option key={s.id} value={String(s.id)}>{s.name} ({s.contact_count})</option>
                    ))}
                  <option value="new">+ Create new segment…</option>
                </select>
                {importSegmentId === "new" && (
                  <input
                    type="text"
                    value={importSegmentName}
                    onChange={(e) => setImportSegmentName(e.target.value)}
                    placeholder="e.g., California, Enterprise"
                    className="input-glow mt-2 w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  />
                )}
              </div>
            )}

            <div className="mb-4 flex items-center gap-2 rounded-xl bg-[#f0f4f7] px-4 py-3">
              <svg className="h-4 w-4 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <span className="text-[12px] font-medium text-[#0a2a3c] truncate">{pendingFile?.name}</span>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setShowImportModal(false); setPendingFile(null); }}
                className="flex-1 rounded-xl border border-[#d0dce4] py-2.5 text-[12px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#f0f4f7]"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                className="btn-press flex-1 rounded-xl bg-[#054B70] py-2.5 text-[12px] font-bold text-white"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign-to-segment modal (bulk) */}
      {showAssignSegment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowAssignSegment(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-[#0a2a3c]">Assign to Segment</h2>
            <p className="mb-5 text-[12px] text-[#8ca3b3]">
              Tag {selected.size} selected contact(s) with a segment so you can target them when sending.
            </p>

            {/* Import group */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Import Group</label>
              <select
                value={assignGroupId}
                onChange={(e) => { setAssignGroupId(e.target.value); setAssignSegmentId(""); setAssignSegmentName(""); }}
                className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] outline-none"
              >
                <option value="">Select group…</option>
                {importGroups.map((g) => (
                  <option key={g.id} value={String(g.id)}>{g.name} ({g.contact_count})</option>
                ))}
                <option value="new">+ Create new group…</option>
              </select>
              {assignGroupId === "new" && (
                <input
                  type="text"
                  value={assignGroupName}
                  onChange={(e) => setAssignGroupName(e.target.value)}
                  placeholder="e.g., American Data"
                  className="input-glow mt-2 w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                />
              )}
            </div>

            {/* Segment — pick an existing one or type a new name */}
            {(assignGroupId === "new" || (assignGroupId && assignGroupId !== "new")) && (
              <div className="mb-4">
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Segment</label>
                {assignGroupId !== "new" && segments.filter((s) => String(s.import_group_id) === assignGroupId).length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {segments
                      .filter((s) => String(s.import_group_id) === assignGroupId)
                      .map((s) => {
                        const active = assignSegmentId === String(s.id) && !assignSegmentName.trim();
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => { setAssignSegmentId(String(s.id)); setAssignSegmentName(""); }}
                            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all ${
                              active ? "bg-teal-600 text-white shadow-sm" : "bg-white text-teal-600 border border-teal-200 hover:bg-teal-50"
                            }`}
                          >
                            {s.name} <span className="opacity-60">{s.contact_count}</span>
                          </button>
                        );
                      })}
                  </div>
                )}
                <input
                  type="text"
                  value={assignSegmentName}
                  onChange={(e) => { setAssignSegmentName(e.target.value); setAssignSegmentId(""); }}
                  placeholder="Type a new segment name (e.g. Cape Town)"
                  className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                />
                <p className="mt-1.5 text-[11px] text-[#8ca3b3]">Pick an existing segment above, or type a name to create a new one.</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowAssignSegment(false)}
                className="flex-1 rounded-xl border border-[#d0dce4] py-2.5 text-[12px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#f0f4f7]"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignSegment}
                className="btn-press flex-1 rounded-xl bg-[#054B70] py-2.5 text-[12px] font-bold text-white"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {(showAdd || editing) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => { setShowAdd(false); setEditing(null); }}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-5 text-[16px] font-bold text-[#0a2a3c]">{editing ? "Edit Contact" : "Add Contact"}</h2>
            <form onSubmit={editing ? (e) => { e.preventDefault(); handleUpdate(); } : handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Organization</label>
                  <input value={form.org_name} onChange={(e) => setForm({ ...form, org_name: e.target.value })} className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Contact Name</label>
                  <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Email *</label>
                <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none">
                    {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] outline-none resize-none" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setShowAdd(false); setEditing(null); }} className="rounded-xl px-5 py-2.5 text-[12px] font-semibold text-[#6b8a9e] hover:bg-[#f0f4f7]">
                  Cancel
                </button>
                <button type="submit" className="btn-press rounded-xl bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white">
                  {editing ? "Save Changes" : "Add Contact"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
