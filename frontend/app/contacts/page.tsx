"use client";

import { useState, useEffect, useRef } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import Select from "../components/Select";
import { motion, AnimatePresence } from "motion/react";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

// Snappy Filament-style spring shared by the board animations
const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 };

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
  last_campaign_id: number | null;
  last_campaign_name: string | null;
  import_group_id: number | null;
  import_group_name: string | null;
  segment_id: number | null;
  segment_name: string | null;
  tags: { id: number; name: string }[];
  custom_data: Record<string, string>;
  created_at: string;
  updated_at: string;
}

interface TagInfo {
  id: number;
  name: string;
  contact_count: number;
}

interface ImportPreview {
  headers: string[];
  samples: string[][];
  guessed_mapping: string[];
  row_count: number;
  builtin_fields: { key: string; label: string }[];
  custom_fields: string[];
}

interface PendingApproval {
  id: number;
  contact_id: number;
  email: string;
  org_name: string;
  contact_name: string;
  opt_out_reason: string;
  source: string;
  payload: Record<string, unknown>;
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

// The import dialog's selectable fields (Email has its own required picker)
const BUILTIN_FIELDS = [
  { key: "org_name", label: "Organization" },
  { key: "contact_name", label: "Contact" },
  { key: "phone", label: "Phone" },
  { key: "status", label: "Status" },
];

// Legacy/SES "bounced" is shown as Undeliverable.
function displayStatusValue(status: string) {
  return status === "bounced" ? "undeliverable" : status;
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
  const [formCustom, setFormCustom] = useState<Record<string, string>>({});
  const [newFieldName, setNewFieldName] = useState("");

  // Custom columns + Beacon-style import (fields as chips, columns per field)
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [parsing, setParsing] = useState(false);
  const [selectedFields, setSelectedFields] = useState<string[]>([]); // builtin keys + "custom:Name"
  const [fieldCols, setFieldCols] = useState<Record<string, number | "">>({});
  const [emailCol, setEmailCol] = useState<number | "">("");
  const [importNewField, setImportNewField] = useState("");

  // Opt-out protection: pending approvals + reactivation history
  const [pendingCount, setPendingCount] = useState(0);
  const [showApprovals, setShowApprovals] = useState(false);
  const [approvalsTab, setApprovalsTab] = useState<"pending" | "history">("pending");
  const [pendingList, setPendingList] = useState<PendingApproval[]>([]);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  // Approvals at scale: search + per-row selection for batch decisions
  const [approvalSearch, setApprovalSearch] = useState("");
  const [approvalSel, setApprovalSel] = useState<Set<number>>(new Set());
  // Import dialog chrome: add/remove-field toggles + tag placeholder
  const [showAddField, setShowAddField] = useState(false);
  const [showRemoveField, setShowRemoveField] = useState(false);
  const [removeFieldName, setRemoveFieldName] = useState("");
  const [showNewTag, setShowNewTag] = useState(false);
  const [importTagName, setImportTagName] = useState("");
  // Real tags: available list + this upload's picks (existing ids and brand-new names)
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [importTagIds, setImportTagIds] = useState<string[]>([]);
  const [importNewTags, setImportNewTags] = useState<string[]>([]);

  // Beacon table chrome: filter popover, "Groups & segments" panel, row menus, org opt-out
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showGroupsPanel, setShowGroupsPanel] = useState(false);
  const [rowMenuFor, setRowMenuFor] = useState<number | null>(null);
  const [optOutOrgFor, setOptOutOrgFor] = useState<Contact | null>(null);
  const [optOutOrgReason, setOptOutOrgReason] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState<null | "delete" | "group" | "segment">(null);
  const [campaignFilter, setCampaignFilter] = useState("");
  const [cfFilters, setCfFilters] = useState<Record<string, string>>({});
  // Filament table pagination
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  // Filament table chrome: sorting + toggleable columns
  const [sortCol, setSortCol] = useState<"contact" | "status">("contact");
  const [sortDesc, setSortDesc] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [visibleCols, setVisibleCols] = useState<Record<string, boolean>>({
    campaign: true, group: true, country: true, tags: true, segment: false,
  });

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
        if (data.tags) setAllTags(data.tags);
        if (data.custom_fields) setCustomFields(data.custom_fields);
        if (typeof data.pending_approvals === "number") setPendingCount(data.pending_approvals);
      }
    } catch { /* */ }
    setLoaded(true);
  }

  useEffect(() => {
    fetchContacts();
  }, [filter, search, tpFilter, groupFilter, segmentFilter]);

  // Allow deep-links like /contacts?status=undeliverable (used by Reporting)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (status) setFilter(status);
  }, []);

  async function fetchApprovals() {
    try {
      const [pRes, hRes] = await Promise.all([
        fetch(`${API}/contacts/pending-approvals/`, { credentials: "include" }),
        fetch(`${API}/contacts/reactivation-history/`, { credentials: "include" }),
      ]);
      const p = await pRes.json();
      const h = await hRes.json();
      if (p.ok) { setPendingList(p.pending); setPendingCount(p.count); }
      if (h.ok) setHistoryList(h.history);
    } catch { /* */ }
  }

  async function decideApproval(ids: number[], action: "approve" | "keep") {
    try {
      const res = await fetch(`${API}/contacts/pending-approvals/decide/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast(action === "approve" ? `Reactivated ${data.decided} contact(s)` : `Kept ${data.decided} contact(s) opted out`);
        fetchApprovals();
        fetchContacts();
      } else {
        showToast(data.error || "Error");
      }
    } catch {
      showToast("Error deciding approval");
    }
  }

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
      body: JSON.stringify({ ...form, custom_data: formCustom }),
      credentials: "include",
    });
    const data = await res.json();
    if (data.ok) {
      setShowAdd(false);
      setForm({ org_name: "", contact_name: "", email: "", phone: "", status: "active", notes: "" });
      setFormCustom({});
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
      body: JSON.stringify({ id: editing, ...form, custom_data: formCustom }),
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
    setFormCustom({ ...(c.custom_data || {}) });
  }

  // Add/remove custom fields right from the contact form
  async function addCustomField() {
    const name = newFieldName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${API}/contacts/custom-fields/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        if (!customFields.includes(data.name)) setCustomFields([...customFields, data.name]);
        setNewFieldName("");
      } else {
        showToast(data.error || "Could not add field");
      }
    } catch {
      showToast("Could not add field");
    }
  }

  async function removeCustomField(name: string) {
    if (!confirm(`Remove the "${name}" field? Existing values are kept but no longer shown.`)) return;
    try {
      const res = await fetch(`${API}/contacts/custom-fields/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setCustomFields(customFields.filter((f) => f !== name));
        showToast(`Removed field "${name}"`);
      }
    } catch {
      showToast("Could not remove field");
    }
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

  // Open Beacon's "Import clients" dialog — the file is chosen inside it.
  function openImportModal() {
    setPendingFile(null);
    setPreview(null);
    setParsing(false);
    setSelectedFields([]);
    setFieldCols({});
    setEmailCol("");
    setImportNewField("");
    setImportGroupId("");
    setImportGroupName("");
    setImportSegmentId("");
    setImportSegmentName("");
    setImportTagIds([]);
    setImportNewTags([]);
    setImportTagName("");
    setShowNewTag(false);
    setShowImportModal(true);
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setPreview(null);
    setParsing(true);
    if (fileRef.current) fileRef.current.value = "";
    // Parse headers + sample rows, then pre-select fields from the auto-guess
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/contacts/import/preview/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setPreview(data);
        setCustomFields(data.custom_fields);
        const sel: string[] = [];
        const cols: Record<string, number | ""> = {};
        let email: number | "" = "";
        (data.guessed_mapping as string[]).forEach((m, i) => {
          if (m === "email") email = i;
          else if (m && m !== "ignore") {
            if (!sel.includes(m)) {
              sel.push(m);
              cols[m] = i;
            }
          }
        });
        setSelectedFields(sel);
        setFieldCols(cols);
        setEmailCol(email);
      } else {
        showToast(data.error || "Could not read the file");
        setPendingFile(null);
      }
    } catch {
      showToast("Could not read the file");
      setPendingFile(null);
    }
    setParsing(false);
  }

  function toggleField(key: string) {
    setSelectedFields((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));
  }

  // "Add a field": creates a custom field chip (or re-adds a built-in by name)
  async function addImportField() {
    const raw = importNewField.trim();
    if (!raw) return;
    const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    const builtin = BUILTIN_FIELDS.find(
      (b) => b.key.replace(/[^a-z0-9]/g, "") === norm || b.label.toLowerCase().replace(/[^a-z0-9]/g, "") === norm
    );
    if (builtin) {
      if (!selectedFields.includes(builtin.key)) toggleField(builtin.key);
    } else {
      try {
        const res = await fetch(`${API}/contacts/custom-fields/create/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: raw }),
          credentials: "include",
        });
        const data = await res.json();
        if (!data.ok) { showToast(data.error || "Could not add field"); return; }
        if (!customFields.includes(data.name)) setCustomFields([...customFields, data.name]);
        const key = `custom:${data.name}`;
        if (!selectedFields.includes(key)) setSelectedFields((prev) => [...prev, key]);
      } catch {
        showToast("Could not add field");
        return;
      }
    }
    setImportNewField("");
  }

  // Build the column-indexed mapping the backend expects from the field choices
  function buildMapping(): string[] | null {
    if (!preview || emailCol === "") return null;
    const mapping: string[] = preview.headers.map(() => "ignore");
    mapping[emailCol as number] = "email";
    for (const key of selectedFields) {
      const col = fieldCols[key];
      if (col === "" || col === undefined || col === emailCol) continue;
      mapping[col as number] = key;
    }
    return mapping;
  }

  async function handleImport() {
    if (!pendingFile) { showToast("Choose a CSV or Excel file first"); return; }
    const mapping = buildMapping();
    if (!mapping) { showToast("Pick which column holds the email addresses"); return; }
    setImporting(true);
    setShowImportModal(false);
    const fd = new FormData();
    fd.append("file", pendingFile);
    fd.append("mapping", JSON.stringify(mapping));
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
    // Tags for this upload: existing picks + brand-new names
    if (importTagIds.length) fd.append("tag_ids", JSON.stringify(importTagIds.map(Number)));
    if (importNewTags.length) fd.append("new_tags", JSON.stringify(importNewTags));
    try {
      const res = await fetch(`${API}/contacts/import/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        const groupMsg = data.import_group ? ` into "${data.import_group.name}"` : "";
        const segMsg = data.segment ? ` · ${data.segment.name}` : "";
        const updatedMsg = data.updated ? `, ${data.updated} re-tagged` : "";
        const pendingMsg = data.pending_approval ? ` — ${data.pending_approval} opted-out contact(s) held for approval` : "";
        showToast(`Imported ${data.created} contacts${groupMsg}${segMsg} (${data.skipped} skipped${updatedMsg})${pendingMsg}`);
        fetchContacts();
      } else {
        showToast(data.error || "Import failed");
      }
    } catch {
      showToast("Import error");
    }
    setImporting(false);
    setPendingFile(null);
    setPreview(null);
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

  // Bulk "Remove from their group / segment" — Beacon's bulk actions
  async function bulkClear(field: "group" | "segment") {
    const ids = Array.from(selected);
    try {
      await fetch(`${API}/contacts/bulk-update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(field === "group" ? { ids, import_group_id: null } : { ids, segment_id: null }),
        credentials: "include",
      });
      setBulkConfirm(null);
      setSelected(new Set());
      setToast(`${ids.length} contact${ids.length === 1 ? "" : "s"} removed from their ${field}`);
      setTimeout(() => setToast(null), 3500);
      fetchContacts();
    } catch { /* */ }
  }

  // "Opt out org" — everyone with this organisation is marked opted out
  async function optOutOrganisation() {
    if (!optOutOrgFor) return;
    const ids = contacts.filter((x) => x.org_name === optOutOrgFor.org_name).map((x) => x.id);
    try {
      await fetch(`${API}/contacts/bulk-update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status: "opted_out", opt_out_reason: optOutOrgReason.trim() }),
        credentials: "include",
      });
      setToast(`${ids.length} contact${ids.length === 1 ? "" : "s"} opted out at "${optOutOrgFor.org_name}"`);
      setTimeout(() => setToast(null), 3500);
      setOptOutOrgFor(null);
      setOptOutOrgReason("");
      fetchContacts();
    } catch { /* */ }
  }

  // Open the existing Add/Edit modal prefilled with a contact
  function openEditContact(c: Contact) {
    setEditing(c.id);
    setForm({
      org_name: c.org_name,
      contact_name: c.contact_name,
      email: c.email,
      phone: c.phone,
      status: displayStatusValue(c.status),
      notes: c.notes,
    });
    setFormCustom({ ...(c.custom_data || {}) });
    setShowAdd(true);
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
  const cellInput = "w-full bg-transparent border border-[#054B70]/20 rounded-lg px-2 py-1.5 text-[12px] text-gray-900 outline-none focus:border-[#054B70] focus:ring-1 focus:ring-[#054B70]/20 transition-all";

  // --- Group / segment pill-filter helpers ---
  const groupPillCls = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all ${
      active
        ? "bg-[#054B70] text-white shadow-sm ring-1 ring-gray-950/5"
        : "bg-white text-gray-500 border border-gray-200 hover:border-[#054B70] hover:text-[#054B70]"
    }`;
  const segPillCls = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all ${
      active
        ? "bg-teal-600 text-white shadow-sm ring-1 ring-gray-950/5"
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
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
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
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        {/* Slim top bar — the page heading lives in the content, like Filament */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:hidden">
          <MobileMenuButton />
          <h1 className="text-[15px] font-bold text-gray-900">Contacts</h1>
        </header>

        <main className="p-4 sm:p-8">
          {/* Filament page header: breadcrumb, big heading, actions on the same row */}
          <p className="mb-1 text-[12px] text-gray-400">Contacts <span className="mx-1">›</span> List</p>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-[28px] font-bold tracking-tight text-gray-950">Contacts</h1>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowGroupsPanel((v) => !v)}
                className="btn-press flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
              >
                <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 01-1.125-1.125v-3.75zM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-8.25zM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-2.25z" /></svg>
                Groups &amp; segments
              </button>
              {canEdit && (
                <>
                  <a
                    href="/contacts/pending-approval"
                    className="btn-press flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                    title="Opted-out contacts waiting for approval"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Pending approval{pendingCount > 0 ? ` (${pendingCount})` : ""}
                  </a>
                  <button
                    onClick={openImportModal}
                    className="btn-press flex items-center gap-1.5 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                  >
                    <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
                    {importing ? "Importing…" : "Import clients"}
                  </button>
                  <button
                    onClick={() => { setShowAdd(true); setEditing(null); setForm({ org_name: "", contact_name: "", email: "", phone: "", status: "active", notes: "" }); setFormCustom({}); }}
                    className="btn-press flex items-center gap-1.5 rounded-lg bg-[#054B70] px-5 py-2.5 text-[13px] font-bold text-white"
                  >
                    New Contact
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Toast */}
          {toast && (
            <div className="mb-5 flex items-center gap-2 rounded-lg bg-[#054B70]/5 px-4 py-3 text-[13px] font-semibold text-[#054B70] animate-slide-in">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
              {toast}
            </div>
          )}

          {/* "Groups & segments" panel — opened from the header button */}
          {showGroupsPanel && importGroups.length > 0 && (
            <div className="mb-5 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up" style={{ animationDelay: "0.07s" }}>
              {/* Groups row */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">Groups</span>
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
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                  <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">Segments</span>
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
                <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 text-[11px] text-gray-500">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Segments</span>
                  <span>No segments yet — select contacts below and click <strong className="font-semibold text-[#054B70]">Assign Segment</strong> to create one.</span>
                </div>
              )}
            </div>
          )}

          {/* Filament table card: toolbar (bulk actions · search · filters) + columns */}
          {(() => {
            const filtered = contacts
              .filter((c) => (campaignFilter ? String(c.last_campaign_id ?? "") === campaignFilter : true))
              .filter((c) => Object.entries(cfFilters).every(([k, v]) => !v || (c.custom_data || {})[k] === v))
              .sort((a, b) => {
                const av = sortCol === "contact" ? (a.org_name || a.contact_name || "") : displayStatusValue(a.status);
                const bv = sortCol === "contact" ? (b.org_name || b.contact_name || "") : displayStatusValue(b.status);
                return (sortDesc ? -1 : 1) * av.localeCompare(bv);
              });
            const activeFilterCount = [filter, tpFilter, groupFilter, segmentFilter, campaignFilter, ...Object.values(cfFilters)].filter(Boolean).length;
            const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
            const curPage = Math.min(page, totalPages);
            const shownContacts = filtered.slice((curPage - 1) * perPage, curPage * perPage);
            const showFrom = filtered.length === 0 ? 0 : (curPage - 1) * perPage + 1;
            const showTo = Math.min(curPage * perPage, filtered.length);
            const campaignOptions = Array.from(
              new Map(contacts.filter((c) => c.last_campaign_id).map((c) => [String(c.last_campaign_id), c.last_campaign_name || "Campaign"])).entries()
            ).sort((a, b) => a[1].localeCompare(b[1]));
            const filtersActive = Boolean(filter || tpFilter || groupFilter || segmentFilter || campaignFilter || Object.values(cfFilters).some(Boolean));
            const beaconBadge = (status: string) => {
              const s = displayStatusValue(status);
              const label = STATUS_OPTIONS.find((o) => o.value === s)?.label || status;
              const cls = s === "active" ? "bg-emerald-500/[.12] text-emerald-800"
                : s === "inactive" ? "bg-gray-400/[.15] text-gray-600"
                : s === "moved_to_hubspot" ? "bg-amber-500/[.14] text-amber-700"
                : "bg-red-500/[.12] text-red-700";
              return <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
            };
            return (
          <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up -mx-4 sm:mx-0" style={{ animationDelay: "0.05s" }}>
            {/* Toolbar */}
            <div className="relative flex flex-wrap items-center justify-between gap-2 border-b border-gray-950/5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {selected.size > 0 && canEdit ? (
                  <>
                    <span className="text-[12px] font-semibold text-gray-500">{selected.size} selected</span>
                    <Select
                      value=""
                      onChange={(v) => { if (v) bulkStatusChange(v); }}
                      options={STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }))}
                      placeholder="Change status…"
                      size="sm"
                    />
                    <button
                      onClick={() => {
                        setAssignGroupId(groupFilter && groupFilter !== "none" ? groupFilter : "");
                        setAssignGroupName(""); setAssignSegmentId(""); setAssignSegmentName("");
                        setShowAssignSegment(true);
                      }}
                      className="rounded-lg border border-gray-400/30 px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Assign segment
                    </button>
                    <button onClick={() => setBulkConfirm("group")} className="rounded-lg border border-gray-400/30 px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50">
                      Remove from their group
                    </button>
                    <button onClick={() => setBulkConfirm("segment")} className="rounded-lg border border-gray-400/30 px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50">
                      Remove from their segment
                    </button>
                    <button onClick={() => setBulkConfirm("delete")} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-red-50">
                      Delete contacts
                    </button>
                  </>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative w-full max-w-xs">
                  <svg className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                  </svg>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search"
                    className="w-full rounded-lg bg-white py-2 pl-8 pr-3 text-[13px] text-gray-950 placeholder-gray-400 shadow-sm outline-none ring-1 ring-gray-950/10 focus:ring-2 focus:ring-[#054B70]"
                  />
                </div>
                <button
                  onClick={() => setFiltersOpen((v) => !v)}
                  title="Filter"
                  className={`relative rounded-lg p-2 transition-colors ${filtersOpen || filtersActive ? "bg-[#054B70]/10 text-[#054B70]" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
                  </svg>
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gray-500/20 px-1 text-[10px] font-bold text-gray-600">
                    {activeFilterCount}
                  </span>
                </button>
                <div className="relative">
                  <button
                    onClick={() => setColsOpen((v) => !v)}
                    title="Toggle columns"
                    className={`rounded-lg p-2 transition-colors ${colsOpen ? "bg-[#054B70]/10 text-[#054B70]" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15M5.25 4.5h13.5c.621 0 1.125.504 1.125 1.125v12.75c0 .621-.504 1.125-1.125 1.125H5.25a1.125 1.125 0 01-1.125-1.125V5.625c0-.621.504-1.125 1.125-1.125z" /></svg>
                  </button>
                  {colsOpen && (
                    <div className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl bg-white p-2 shadow-lg ring-1 ring-gray-950/10">
                      <p className="px-2 pb-1 pt-0.5 text-[11px] font-bold uppercase tracking-wide text-gray-400">Columns</p>
                      {[
                        ["campaign", "Campaign"], ["group", "Group"], ["country", "Country"], ["tags", "Tags"], ["segment", "Segment"],
                        ...customFields.map((f) => [`cf:${f}`, f] as [string, string]),
                      ].map(([key, label]) => (
                        <label key={key} className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-950 hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={visibleCols[key] ?? true}
                            onChange={(e) => setVisibleCols((prev) => ({ ...prev, [key]: e.target.checked }))}
                            className="accent-[#054B70]"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Filter panel — Filament's two-column filters popover */}
              {filtersOpen && (
                <div className="absolute right-4 top-full z-40 mt-1 w-[36rem] max-w-[calc(100vw-3rem)] rounded-xl bg-white p-4 shadow-lg ring-1 ring-gray-950/10">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-gray-950">Status</label>
                      <Select
                        value={filter}
                        onChange={setFilter}
                        options={[{ value: "", label: "All" }, ...STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }))]}
                        size="sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-gray-950">Campaign</label>
                      <Select
                        value={campaignFilter}
                        onChange={setCampaignFilter}
                        options={[{ value: "", label: "All" }, ...campaignOptions.map(([id, name]) => ({ value: id, label: name }))]}
                        size="sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-gray-950">Touchpoint</label>
                      <Select
                        value={tpFilter}
                        onChange={setTpFilter}
                        options={[
                          { value: "", label: "All" },
                          { value: "none", label: "No touchpoint sent" },
                          ...Array.from(new Set(contacts.map((c) => c.last_touchpoint).filter((n) => n > 0))).sort((a, b) => a - b).map((n) => ({ value: String(n), label: `Touchpoint ${n}` })),
                        ]}
                        size="sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-gray-950">Group</label>
                      <Select
                        value={groupFilter}
                        onChange={(v) => { setGroupFilter(v); setSegmentFilter(""); }}
                        options={[
                          { value: "", label: "All" },
                          ...importGroups.map((g) => ({ value: String(g.id), label: g.name })),
                          { value: "none", label: "No group" },
                        ]}
                        size="sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-gray-950">Segment</label>
                      <Select
                        value={segmentFilter}
                        onChange={setSegmentFilter}
                        options={[
                          { value: "", label: "All" },
                          ...segments
                            .filter((s) => !groupFilter || groupFilter === "none" ? true : String(s.import_group_id) === groupFilter)
                            .map((s) => ({ value: String(s.id), label: s.name })),
                          { value: "none", label: "No segment" },
                        ]}
                        size="sm"
                      />
                    </div>
                    {customFields.map((f) => {
                      const values = Array.from(new Set(contacts.map((c) => (c.custom_data || {})[f]).filter(Boolean))).sort();
                      return (
                        <div key={`cf-${f}`}>
                          <label className="mb-1 block text-[12px] font-medium text-gray-950">{f}</label>
                          <Select
                            value={cfFilters[f] || ""}
                            onChange={(v) => setCfFilters((prev) => ({ ...prev, [f]: v }))}
                            options={[{ value: "", label: "All" }, ...values.map((v) => ({ value: v, label: v }))]}
                            size="sm"
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <a href={`${API}/contacts/export/`} className="text-[12px] font-semibold text-[#0369a1] hover:underline">Export CSV</a>
                    <div className="flex items-center gap-4">
                      {canEdit && (
                        <button onClick={downloadTemplate} className="text-[12px] font-semibold text-gray-500 hover:text-[#054B70]">CSV template</button>
                      )}
                      <button
                        onClick={() => { setFilter(""); setTpFilter(""); setGroupFilter(""); setSegmentFilter(""); setCampaignFilter(""); setCfFilters({}); }}
                        className="text-[12px] font-semibold text-gray-500 hover:text-[#054B70]"
                      >
                        Reset filters
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {!loaded ? (
              <div className="p-8">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="mb-3 h-12 rounded-lg bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                ))}
              </div>
            ) : shownContacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-400/15">
                  <svg className="h-6 w-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </span>
                <p className="text-[15px] font-bold text-gray-950">No Contacts</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left">
                <thead>
                  <tr className="border-b border-gray-950/5">
                    <th className="w-10 px-3 py-3 sm:px-4">
                      <input type="checkbox" checked={selected.size === contacts.length && contacts.length > 0} onChange={toggleAll} className="rounded border-gray-300" />
                    </th>
                    <th className="px-3 py-3 sm:px-4">
                      <button
                        onClick={() => { if (sortCol === "contact") setSortDesc(!sortDesc); else { setSortCol("contact"); setSortDesc(false); } }}
                        className="flex items-center gap-1 text-[13px] font-semibold text-gray-950"
                      >
                        Contact
                        <svg className={`h-3.5 w-3.5 text-gray-400 transition-transform ${sortCol === "contact" && sortDesc ? "rotate-180" : ""} ${sortCol === "contact" ? "" : "opacity-0"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                      </button>
                    </th>
                    <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Email</th>
                    <th className="px-3 py-3 sm:px-4">
                      <button
                        onClick={() => { if (sortCol === "status") setSortDesc(!sortDesc); else { setSortCol("status"); setSortDesc(false); } }}
                        className="flex items-center gap-1 text-[13px] font-semibold text-gray-950"
                      >
                        Status
                        <svg className={`h-3.5 w-3.5 text-gray-400 transition-transform ${sortCol === "status" && sortDesc ? "rotate-180" : ""} ${sortCol === "status" ? "" : "opacity-0"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                      </button>
                    </th>
                    {(visibleCols.campaign ?? true) && <th className="px-3 py-3 text-[13px] font-semibold text-gray-950 sm:px-4">Campaign</th>}
                    {(visibleCols.group ?? true) && <th className="hidden px-3 py-3 text-[13px] font-semibold text-gray-950 lg:table-cell sm:px-4">Group</th>}
                    {(visibleCols.country ?? true) && <th className="hidden px-3 py-3 text-[13px] font-semibold text-gray-950 lg:table-cell sm:px-4">Country</th>}
                    {(visibleCols.tags ?? true) && <th className="hidden px-3 py-3 text-[13px] font-semibold text-gray-950 lg:table-cell sm:px-4">Tags</th>}
                    {(visibleCols.segment ?? false) && <th className="hidden px-3 py-3 text-[13px] font-semibold text-gray-950 lg:table-cell sm:px-4">Segment</th>}
                    {customFields.filter((f) => visibleCols[`cf:${f}`] ?? true).map((f) => (
                      <th key={`h-${f}`} className="hidden px-3 py-3 text-[13px] font-semibold text-gray-950 xl:table-cell sm:px-4">{f}</th>
                    ))}
                    {canEdit && <th className="w-14 px-3 py-3 sm:px-4" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-950/5">
                  {shownContacts.map((c) => (
                    <tr key={c.id} className="transition-colors hover:bg-gray-50">
                      <td className="px-3 py-3 sm:px-4">
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="rounded border-gray-300" />
                      </td>

                      {/* Contact + organisation stacked — no duplicate line when they match */}
                      <td className="px-3 py-3 sm:px-4">
                        <span className="block text-[13px] font-bold text-gray-950">{c.contact_name || c.org_name || "—"}</span>
                        {c.org_name && c.org_name !== c.contact_name && (
                          <span className="block text-[12px] text-gray-500">{c.org_name}</span>
                        )}
                      </td>

                      {/* Email with the phone underneath */}
                      <td className="px-3 py-3 sm:px-4">
                        <span className="block break-all text-[13px] text-gray-950">{c.email}</span>
                        {c.phone && <span className="block text-[12px] text-gray-500">{c.phone}</span>}
                      </td>

                      {/* Status badge — Beacon colors */}
                      <td className="px-3 py-3 sm:px-4">
                        {beaconBadge(c.status)}
                        {displayStatusValue(c.status) === "opted_out" && c.opt_out_reason && (
                          <p className="mt-0.5 max-w-[160px] truncate text-[11px] text-gray-400" title={c.opt_out_reason}>{c.opt_out_reason}</p>
                        )}
                      </td>

                      {/* Journey: campaign on top, touchpoint under it */}
                      {(visibleCols.campaign ?? true) && (
                        <td className="px-3 py-3 sm:px-4">
                          {c.last_campaign_name ? (
                            <>
                              <span className="block text-[13px] text-gray-950">{c.last_campaign_name}</span>
                              {c.last_touchpoint > 0 && <span className="block text-[12px] text-gray-500">On touchpoint {c.last_touchpoint}</span>}
                            </>
                          ) : (
                            <span className="text-[13px] text-gray-400">Not in a campaign yet</span>
                          )}
                        </td>
                      )}
                      {(visibleCols.group ?? true) && (
                        <td className="hidden px-3 py-3 text-[13px] text-gray-950 lg:table-cell sm:px-4">
                          {c.import_group_name || <span className="text-gray-400">—</span>}
                        </td>
                      )}
                      {(visibleCols.country ?? true) && (
                        <td className="hidden px-3 py-3 text-[13px] text-gray-400 lg:table-cell sm:px-4">—</td>
                      )}
                      {(visibleCols.tags ?? true) && (
                        <td className="hidden px-3 py-3 lg:table-cell sm:px-4">
                          {c.tags && c.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {c.tags.map((t) => (
                                <span key={t.id} className="rounded-full bg-[#054B70]/5 px-2 py-0.5 text-[11px] font-semibold text-[#054B70]">{t.name}</span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[13px] text-gray-400">—</span>
                          )}
                        </td>
                      )}
                      {(visibleCols.segment ?? false) && (
                        <td className="hidden px-3 py-3 text-[13px] text-gray-950 lg:table-cell sm:px-4">
                          {c.segment_name || <span className="text-gray-400">—</span>}
                        </td>
                      )}

                      {customFields.filter((f) => visibleCols[`cf:${f}`] ?? true).map((f) => (
                        <td key={`v-${f}`} className="hidden px-3 py-3 text-[13px] text-gray-950 xl:table-cell sm:px-4">
                          {(c.custom_data || {})[f] || <span className="text-gray-400">—</span>}
                        </td>
                      ))}

                      {/* Row actions — Filament's ⋮ action group: Edit · Opt out org · Delete */}
                      {canEdit && (
                        <td className="relative px-3 py-3 text-right sm:px-4">
                          <button
                            onClick={() => setRowMenuFor(rowMenuFor === c.id ? null : c.id)}
                            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                            title="Actions"
                          >
                            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" /></svg>
                          </button>
                          {rowMenuFor === c.id && (
                            <div className="absolute right-4 top-10 z-40 w-44 rounded-lg bg-white p-1 text-left shadow-lg ring-1 ring-gray-950/10">
                              <button
                                onClick={() => { setRowMenuFor(null); openEditContact(c); }}
                                className="block w-full rounded-md px-3 py-2 text-left text-[13px] text-gray-950 hover:bg-gray-50"
                              >
                                Edit
                              </button>
                              {c.org_name && (
                                <button
                                  onClick={() => { setRowMenuFor(null); setOptOutOrgFor(c); setOptOutOrgReason(""); }}
                                  className="block w-full rounded-md px-3 py-2 text-left text-[13px] text-red-600 hover:bg-red-50"
                                >
                                  Opt out org
                                </button>
                              )}
                              {user?.role === "admin" && (
                                <button
                                  onClick={() => { setRowMenuFor(null); handleDelete([c.id]); }}
                                  className="block w-full rounded-md px-3 py-2 text-left text-[13px] text-red-600 hover:bg-red-50"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}

            {/* Filament pagination footer */}
            {loaded && filtered.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-950/5 px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] text-gray-500">
                  <span>
                    Showing <strong className="text-gray-950">{showFrom}</strong> to <strong className="text-gray-950">{showTo}</strong> of{" "}
                    <strong className="text-gray-950">{filtered.length}</strong> results
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-[12px] text-gray-500">
                    <span>Per page</span>
                    <Select
                      value={String(perPage)}
                      onChange={(v) => { setPerPage(Number(v)); setPage(1); }}
                      options={[
                        { value: "10", label: "10" },
                        { value: "25", label: "25" },
                        { value: "50", label: "50" },
                        { value: "100", label: "100" },
                      ]}
                      size="sm"
                    />
                  </div>
                  {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage(Math.max(1, curPage - 1))}
                        disabled={curPage === 1}
                        className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                        aria-label="Previous"
                      >
                        ‹
                      </button>
                      {pageItems(curPage, totalPages).map((n, i) => (
                        n === "…" ? (
                          <span key={`gap-${i}`} className="px-1.5 text-[13px] text-gray-400">…</span>
                        ) : (
                          <button
                            key={n}
                            onClick={() => setPage(n)}
                            className={`min-w-8 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold ${
                              n === curPage ? "bg-[#054B70]/10 text-[#054B70]" : "text-gray-500 hover:bg-gray-100"
                            }`}
                          >
                            {n}
                          </button>
                        )
                      ))}
                      <button
                        onClick={() => setPage(Math.min(totalPages, curPage + 1))}
                        disabled={curPage === totalPages}
                        className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                        aria-label="Next"
                      >
                        ›
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
            );
          })()}

          {/* "Opt out everyone at …?" — Beacon's org opt-out confirmation */}
          {optOutOrgFor && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setOptOutOrgFor(null)}>
              <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
                <h2 className="mb-1 text-[16px] font-bold text-gray-900">Opt out everyone at &ldquo;{optOutOrgFor.org_name}&rdquo;?</h2>
                <p className="mb-4 text-[12px] text-gray-500">
                  Every contact with this organisation is marked as opted out and stops receiving all sends and flows. This is recorded in the opt-out metrics.
                </p>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">Reason (optional)</label>
                <textarea
                  rows={2}
                  value={optOutOrgReason}
                  onChange={(e) => setOptOutOrgReason(e.target.value)}
                  placeholder="e.g. Company requested removal on 8 July"
                  className="input-glow mb-5 w-full resize-none rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setOptOutOrgFor(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
                  <button onClick={optOutOrganisation} className="btn-press rounded-lg bg-red-600 px-6 py-2.5 text-[12px] font-bold text-white hover:bg-red-700">
                    Opt out organisation
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bulk action confirmations — Beacon's wording */}
          {bulkConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setBulkConfirm(null)}>
              <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
                <h2 className="mb-1 text-[16px] font-bold text-gray-900">
                  {bulkConfirm === "delete" ? "Delete the selected contacts?"
                    : bulkConfirm === "group" ? "Remove the selected contacts from their group?"
                    : "Remove the selected contacts from their segment?"}
                </h2>
                <p className="mb-5 text-[12px] text-gray-500">
                  {bulkConfirm === "delete" ? "Are you sure? They are removed for good."
                    : bulkConfirm === "group" ? "Are you sure? The group itself stays — these contacts just stop belonging to one."
                    : "Are you sure? The segment itself stays."}
                </p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setBulkConfirm(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
                  {bulkConfirm === "delete" ? (
                    <button
                      onClick={() => { setBulkConfirm(null); handleDelete(Array.from(selected)); }}
                      className="btn-press rounded-lg bg-red-600 px-6 py-2.5 text-[12px] font-bold text-white hover:bg-red-700"
                    >
                      Yes, delete them
                    </button>
                  ) : (
                    <button
                      onClick={() => bulkClear(bulkConfirm)}
                      className="btn-press rounded-lg bg-red-600 px-6 py-2.5 text-[12px] font-bold text-white hover:bg-red-700"
                    >
                      Yes, remove them
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </MainContent>

      {/* Beacon's "Import clients" dialog: File & target on the left, Fields to import on the right */}
      <AnimatePresence>
      {showImportModal && (
        <motion.div
          key="import-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setShowImportModal(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={SPRING}
            className="max-h-[94vh] w-full max-w-6xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-start justify-between gap-4">
              <h2 className="text-[16px] font-bold text-gray-900">Import clients</h2>
              <button
                type="button"
                title="Close"
                aria-label="Close"
                onClick={() => setShowImportModal(false)}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <p className="mb-5 text-[13px] text-gray-500">
              Upload a CSV or Excel (.xlsx) file, then match each of its columns to the field it should feed. Existing contacts (matched by email) are always updated with the mapped columns; new emails are always imported as new contacts.
            </p>

            <div className={`grid grid-cols-1 gap-5 ${preview ? "lg:grid-cols-5" : ""}`}>
              {/* ── File & target — Filament section ── */}
              <div className={`rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5 ${preview ? "lg:col-span-2" : ""}`}>
                <div className="border-b border-gray-950/5 px-5 py-3">
                  <h3 className="text-[14px] font-semibold text-gray-950">File &amp; target</h3>
                </div>
                <div className="p-4">
                <label className="mb-1.5 block text-[13px] font-medium text-gray-950">CSV or Excel file<sup className="font-medium text-red-600">*</sup></label>
                <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={handleFileSelect} />
                {pendingFile || parsing ? (
                  /* FilePond-style upload bar: gray while "uploading", green on complete */
                  <button
                    type="button"
                    onClick={() => { setPendingFile(null); setPreview(null); setEmailCol(""); setFieldCols({}); if (fileRef.current) fileRef.current.value = ""; }}
                    className={`flex w-full items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors ${parsing ? "bg-gray-500/80" : "bg-emerald-600"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-white">{pendingFile?.name}</span>
                      <span className="block text-[11px] text-white/70">
                        {pendingFile ? `${Math.max(1, Math.round(pendingFile.size / 1024))} KB` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[12px] font-semibold text-white">{parsing ? "Uploading" : "Upload complete"}</span>
                      <span className="block text-[10px] text-white/70">{parsing ? "tap to cancel" : "tap to undo"}</span>
                    </span>
                    {parsing ? (
                      <svg className="h-5 w-5 shrink-0 animate-spin text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    ) : (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/25">
                        <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M6 18L18 6M6 6l12 12" /></svg>
                      </span>
                    )}
                  </button>
                ) : (
                  <label
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files?.[0];
                      if (f) handleFileSelect({ target: { files: [f] } } as unknown as React.ChangeEvent<HTMLInputElement>);
                    }}
                    className="flex cursor-pointer items-center justify-center rounded-xl border border-gray-300 bg-gray-50 px-4 py-8 text-[13px] text-gray-500 transition-colors hover:bg-gray-100"
                  >
                    <span>Drag &amp; Drop your files or <span className="font-semibold text-[#054B70]">Browse</span></span>
                    <input type="file" accept=".csv,.xlsx" className="hidden" onChange={handleFileSelect} />
                  </label>
                )}

                {preview && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={SPRING}
                  className="mt-3 space-y-3"
                >
                  {/* Import into group — pick one, or create a new one with + */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Import into group</label>
                    <div className="flex gap-2">
                      <Select
                        value={importGroupId === "new" ? "" : importGroupId}
                        onChange={(v) => { setImportGroupId(v); setImportGroupName(""); setImportSegmentId(""); setImportSegmentName(""); }}
                        options={[{ value: "", label: "Select an option" }, ...importGroups.map((g) => ({ value: String(g.id), label: g.name }))]}
                        placeholder="Select an option"
                        searchable
                        className="flex-1"
                      />
                      <button
                        type="button"
                        title="Create a new group"
                        onClick={() => { const on = importGroupId === "new"; setImportGroupId(on ? "" : "new"); setImportGroupName(""); setImportSegmentId(""); setImportSegmentName(""); }}
                        className={`w-10 shrink-0 rounded-lg text-[16px] font-bold shadow-sm ring-1 transition-colors ${
                          importGroupId === "new" ? "bg-[#054B70] text-white ring-[#054B70]" : "bg-white text-gray-500 ring-gray-950/10 hover:bg-gray-50"
                        }`}
                      >
                        +
                      </button>
                    </div>
                    {importGroupId === "new" && (
                      <input
                        type="text"
                        value={importGroupName}
                        onChange={(e) => setImportGroupName(e.target.value)}
                        placeholder="e.g., American Data, Q2 2026"
                        className="input-glow mt-2 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                        autoFocus
                      />
                    )}
                    <p className="mt-1.5 text-[12px] text-gray-500">The group every imported contact joins. Create one with +.</p>
                  </div>

                  {/* Into segment (optional) */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">
                      Into segment <span className="font-normal text-gray-400">(optional)</span>
                    </label>
                    <div className="flex gap-2">
                      <Select
                        value={importSegmentId === "new" ? "" : importSegmentId}
                        onChange={(v) => { setImportSegmentId(v); setImportSegmentName(""); }}
                        options={[
                          { value: "", label: "Select an option" },
                          ...(importGroupId && importGroupId !== "new"
                            ? segments.filter((s) => String(s.import_group_id) === importGroupId).map((s) => ({ value: String(s.id), label: s.name }))
                            : []),
                        ]}
                        placeholder="Select an option"
                        className="flex-1"
                      />
                      <button
                        type="button"
                        title="Create a new segment"
                        onClick={() => { const on = importSegmentId === "new"; setImportSegmentId(on ? "" : "new"); setImportSegmentName(""); }}
                        className={`w-10 shrink-0 rounded-lg text-[16px] font-bold shadow-sm ring-1 transition-colors ${
                          importSegmentId === "new" ? "bg-[#054B70] text-white ring-[#054B70]" : "bg-white text-gray-500 ring-gray-950/10 hover:bg-gray-50"
                        }`}
                      >
                        +
                      </button>
                    </div>
                    {importSegmentId === "new" && (
                      <input
                        type="text"
                        value={importSegmentName}
                        onChange={(e) => setImportSegmentName(e.target.value)}
                        placeholder="e.g., California, Enterprise"
                        className="input-glow mt-2 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                        autoFocus
                      />
                    )}
                    <p className="mt-1.5 text-[12px] text-gray-500">When a group is chosen, only its segments show. Leave blank to import into the whole group.</p>
                  </div>

                  {/* Tag this upload (optional) — arrives with the tagging feature */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">
                      Tag this upload <span className="font-normal text-gray-400">(optional)</span>
                    </label>
                    <div className="flex gap-2">
                      <Select
                        multiple
                        searchable
                        values={importTagIds}
                        onToggle={(v) => setImportTagIds((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
                        options={allTags.map((t) => ({ value: String(t.id), label: t.name }))}
                        placeholder="Select an option"
                        className="flex-1"
                      />
                      <button
                        type="button"
                        title="Create a new tag"
                        onClick={() => setShowNewTag((v) => !v)}
                        className={`w-10 shrink-0 rounded-lg text-[16px] font-bold shadow-sm ring-1 transition-colors ${
                          showNewTag ? "bg-[#054B70] text-white ring-[#054B70]" : "bg-white text-gray-500 ring-gray-950/10 hover:bg-gray-50"
                        }`}
                      >
                        +
                      </button>
                    </div>
                    {showNewTag && (
                      <input
                        type="text"
                        value={importTagName}
                        onChange={(e) => setImportTagName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const name = importTagName.trim();
                            if (!name) return;
                            setImportNewTags((prev) => prev.includes(name) ? prev : [...prev, name]);
                            setImportTagName("");
                            setShowNewTag(false);
                          }
                        }}
                        placeholder="e.g. Q3 upload — Enter to add"
                        className="input-glow mt-2 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                        autoFocus
                      />
                    )}
                    {importNewTags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {importNewTags.map((t) => (
                          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-[#054B70]/5 px-2.5 py-1 text-[11px] font-semibold text-[#054B70]">
                            {t}
                            <button
                              type="button"
                              title="Remove this new tag"
                              onClick={() => setImportNewTags((prev) => prev.filter((x) => x !== t))}
                              className="font-bold hover:opacity-70"
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="mt-1.5 text-[12px] text-gray-500">Add tags to every contact in this upload — pick existing ones or create a new one with +.</p>
                  </div>
                </motion.div>
                )}
                </div>
              </div>

              {/* ── Fields to import — appears once a file is chosen ── */}
              {preview && (
              <motion.div
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={SPRING}
                className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5 lg:col-span-3"
              >
                <div className="border-b border-gray-950/5 px-5 py-3">
                  <h3 className="text-[14px] font-semibold text-gray-950">Fields to import</h3>
                </div>
                <div className="p-4">
                <p className="mb-3 text-[11px] text-gray-500">
                  Click the fields you want — they light up when selected — then choose which spreadsheet column feeds each.
                </p>

                {/* Field chips */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {BUILTIN_FIELDS.map((b) => {
                    const on = selectedFields.includes(b.key);
                    return (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => toggleField(b.key)}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                          on ? "bg-[#054B70] text-white shadow-sm" : "bg-white text-gray-600 ring-1 ring-gray-300 hover:ring-[#054B70]/50 hover:text-gray-900"
                        }`}
                      >
                        {b.label}
                      </button>
                    );
                  })}
                  {customFields.map((cf) => {
                    const key = `custom:${cf}`;
                    const on = selectedFields.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleField(key)}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                          on ? "bg-[#054B70] text-white shadow-sm" : "bg-white text-gray-600 ring-1 ring-gray-300 hover:ring-[#054B70]/50 hover:text-gray-900"
                        }`}
                      >
                        {cf}
                      </button>
                    );
                  })}
                </div>

                {/* Add / remove fields — like Beacon's two buttons */}
                <div className="mb-4 space-y-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setShowAddField((v) => !v); setShowRemoveField(false); }}
                      className="rounded-lg bg-white px-3 py-2 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                    >
                      + Add a field
                    </button>
                    {customFields.length > 0 && (
                      <button
                        type="button"
                        onClick={() => { setShowRemoveField((v) => !v); setShowAddField(false); }}
                        className="rounded-lg bg-red-600 px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-red-700"
                      >
                        Remove a field
                      </button>
                    )}
                  </div>
                  {showAddField && (
                    <div className="flex gap-2">
                      <input
                        value={importNewField}
                        onChange={(e) => setImportNewField(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addImportField(); } }}
                        placeholder="Field name (e.g. Industry)"
                        autoFocus
                        className="input-glow flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-[12px] text-gray-900 placeholder-gray-400 outline-none"
                      />
                      <button
                        type="button"
                        onClick={addImportField}
                        className="rounded-lg bg-[#054B70] px-4 py-2 text-[12px] font-bold text-white"
                      >
                        Add
                      </button>
                    </div>
                  )}
                  {showRemoveField && (
                    <div className="flex gap-2">
                      <Select
                        value={removeFieldName}
                        onChange={setRemoveFieldName}
                        options={customFields.map((f) => ({ value: f, label: f }))}
                        placeholder="Pick a field to remove"
                        size="sm"
                        className="flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => { if (removeFieldName) { removeCustomField(removeFieldName); setRemoveFieldName(""); setShowRemoveField(false); } }}
                        disabled={!removeFieldName}
                        className="rounded-lg bg-red-600 px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                {/* Column assignment — appears once a file is parsed */}
                {preview ? (
                  <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label className="mb-1.5 block text-[13px] font-medium text-gray-950">
                        Email column<sup className="font-medium text-red-600">*</sup>
                      </label>
                      <Select
                        value={emailCol === "" ? "" : String(emailCol)}
                        onChange={(v) => setEmailCol(v === "" ? "" : Number(v))}
                        options={preview.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))}
                        placeholder="Choose the column…"
                      />
                      <p className="mt-1.5 text-[12px] text-gray-500">
                        The unique reference: rows matching an existing contact&apos;s email UPDATE that contact — duplicates are never created.
                      </p>
                    </div>
                    {selectedFields.map((key) => {
                      const label = key === "org_name" ? "Organization column"
                        : key === "contact_name" ? "Contact / client name column"
                        : key === "phone" ? "Phone column"
                        : key === "status" ? "Status column"
                        : `${key.replace(/^custom:/, "")} column`;
                      return (
                        <div key={`col-${key}`}>
                          <label className="mb-1.5 block text-[13px] font-medium text-gray-950">{label}</label>
                          <Select
                            value={fieldCols[key] === "" || fieldCols[key] === undefined ? "" : String(fieldCols[key])}
                            onChange={(v) => setFieldCols((prev) => ({ ...prev, [key]: v === "" ? "" : Number(v) }))}
                            options={preview.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))}
                            placeholder="Select an option"
                          />
                          {key === "org_name" && (
                            <p className="mt-1.5 text-[12px] text-gray-500">
                              Auto-locates organisations: a name matching one already in the system (ignoring case, punctuation and Pty/Ltd) is stored under the existing spelling.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg bg-gray-50 px-3 py-2.5 text-[11px] text-gray-400">
                    Choose a file on the left — the columns show up here for matching.
                  </p>
                )}
                </div>
              </motion.div>
              )}
            </div>

            {/* Footer — Import first, left-aligned like Beacon */}
            <div className="mt-5 flex gap-2">
              <button
                onClick={handleImport}
                disabled={!pendingFile || parsing || emailCol === ""}
                className="btn-press rounded-lg bg-[#054B70] px-8 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="rounded-lg bg-white px-5 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Assign-to-segment modal (bulk) */}
      {showAssignSegment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowAssignSegment(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Assign to Segment</h2>
            <p className="mb-5 text-[12px] text-gray-500">
              Tag {selected.size} selected contact(s) with a segment so you can target them when sending.
            </p>

            {/* Import group */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Import Group</label>
              <select
                value={assignGroupId}
                onChange={(e) => { setAssignGroupId(e.target.value); setAssignSegmentId(""); setAssignSegmentName(""); }}
                className="w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-[13px] text-gray-900 outline-none"
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
                  className="input-glow mt-2 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                />
              )}
            </div>

            {/* Segment — pick an existing one or type a new name */}
            {(assignGroupId === "new" || (assignGroupId && assignGroupId !== "new")) && (
              <div className="mb-4">
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Segment</label>
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
                              active ? "bg-teal-600 text-white shadow-sm ring-1 ring-gray-950/5" : "bg-white text-teal-600 border border-teal-200 hover:bg-teal-50"
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
                  className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                />
                <p className="mt-1.5 text-[11px] text-gray-500">Pick an existing segment above, or type a name to create a new one.</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowAssignSegment(false)}
                className="flex-1 rounded-lg border border-gray-300 py-2.5 text-[12px] font-semibold text-gray-500 transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignSegment}
                className="btn-press flex-1 rounded-lg bg-[#054B70] py-2.5 text-[12px] font-bold text-white"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending approvals + reactivation history modal */}
      {showApprovals && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowApprovals(false)}>
          <div className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[16px] font-bold text-gray-900">Opt-out Protection</h2>
              <button onClick={() => setShowApprovals(false)} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <p className="mb-4 text-[12px] text-gray-500">
              Imports can never overwrite or reactivate an opted-out contact. Approve to bring them back, or keep them opted out.
            </p>

            {/* Tabs */}
            <div className="mb-4 flex gap-1 rounded-lg bg-gray-100 p-1">
              {(["pending", "history"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setApprovalsTab(tab)}
                  className={`flex-1 rounded-lg py-2 text-[12px] font-bold transition-colors ${
                    approvalsTab === tab ? "bg-white text-[#054B70] shadow-sm ring-1 ring-gray-950/5" : "text-gray-500 hover:text-[#054B70]"
                  }`}
                >
                  {tab === "pending" ? `Pending approval (${pendingList.length})` : "Reactivation history"}
                </button>
              ))}
            </div>

            {approvalsTab === "pending" ? (
              pendingList.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-gray-500">Nothing waiting for approval.</p>
              ) : (
                (() => {
                  const q = approvalSearch.trim().toLowerCase();
                  const filteredPending = q
                    ? pendingList.filter((p) =>
                        [p.email, p.contact_name, p.org_name, p.opt_out_reason, p.source]
                          .some((v) => (v || "").toLowerCase().includes(q)))
                    : pendingList;
                  const visible = filteredPending.slice(0, 200);
                  const allSelected = filteredPending.length > 0 && filteredPending.every((p) => approvalSel.has(p.id));
                  const selIds = filteredPending.filter((p) => approvalSel.has(p.id)).map((p) => p.id);
                  const act = (ids: number[], action: "approve" | "keep") => {
                    decideApproval(ids, action);
                    setApprovalSel(new Set());
                  };
                  return (
                <div className="space-y-2">
                  {/* Search + select-all toolbar — built for approving thousands at once */}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[220px] flex-1">
                      <svg className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                      </svg>
                      <input
                        value={approvalSearch}
                        onChange={(e) => setApprovalSearch(e.target.value)}
                        placeholder="Search by email, name, organisation or reason"
                        className="w-full rounded-lg bg-white py-2 pl-8 pr-3 text-[13px] text-gray-950 placeholder-gray-400 shadow-sm outline-none ring-1 ring-gray-950/10 focus:ring-2 focus:ring-[#054B70]"
                      />
                    </div>
                    {q && (
                      <span className="text-[12px] text-gray-500">{filteredPending.length} match{filteredPending.length === 1 ? "" : "es"}</span>
                    )}
                  </div>

                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-950/5 bg-gray-50 px-3 py-2">
                      <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] font-semibold text-gray-700">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={(e) => setApprovalSel(e.target.checked
                            ? new Set([...approvalSel, ...filteredPending.map((p) => p.id)])
                            : new Set([...approvalSel].filter((id) => !filteredPending.some((p) => p.id === id))))}
                          className="accent-[#054B70]"
                        />
                        Select all{q ? " matches" : ""} ({filteredPending.length})
                      </label>
                      {selIds.length > 0 && (
                        <>
                          <span className="text-[12px] text-gray-500">{selIds.length} selected</span>
                          <button
                            onClick={() => act(selIds, "approve")}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-700"
                          >
                            Approve selected ({selIds.length})
                          </button>
                          <button
                            onClick={() => act(selIds, "keep")}
                            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-500 hover:bg-gray-100"
                          >
                            Keep selected opted out
                          </button>
                        </>
                      )}
                      <div className="ml-auto flex gap-2">
                        <button
                          onClick={() => act(filteredPending.map((p) => p.id), "approve")}
                          className="rounded-lg bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
                        >
                          Approve all{q ? " matches" : ""}
                        </button>
                        <button
                          onClick={() => act(filteredPending.map((p) => p.id), "keep")}
                          className="rounded-lg bg-gray-100 px-3 py-1.5 text-[11px] font-bold text-gray-500 hover:bg-gray-200"
                        >
                          Keep all opted out
                        </button>
                      </div>
                    </div>
                  )}

                  {filteredPending.length === 0 && (
                    <p className="py-6 text-center text-[13px] text-gray-500">Nothing matches your search.</p>
                  )}
                  {visible.map((p) => (
                    <div key={p.id} className={`rounded-lg border p-3 ${approvalSel.has(p.id) ? "border-[#054B70]/30 bg-[#054B70]/[.04]" : "border-amber-100 bg-amber-50/40"}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-2.5">
                          {canEdit && (
                            <input
                              type="checkbox"
                              checked={approvalSel.has(p.id)}
                              onChange={() => setApprovalSel((prev) => {
                                const next = new Set(prev);
                                if (next.has(p.id)) next.delete(p.id);
                                else next.add(p.id);
                                return next;
                              })}
                              className="mt-1 accent-[#054B70]"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-semibold text-gray-900">{p.email}</p>
                            <p className="truncate text-[11px] text-gray-500">
                              {[p.contact_name, p.org_name].filter(Boolean).join(" · ") || "—"}
                            </p>
                            <p className="mt-0.5 text-[10px] text-gray-500">
                              {p.source} · {new Date(p.created_at).toLocaleString()}
                            </p>
                            {p.opt_out_reason && (
                              <p className="mt-0.5 text-[10px] text-amber-600">Opted out: {p.opt_out_reason}</p>
                            )}
                          </div>
                        </div>
                        {canEdit && (
                          <div className="flex shrink-0 gap-2">
                            <button
                              onClick={() => act([p.id], "approve")}
                              className="btn-press rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-emerald-700"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => act([p.id], "keep")}
                              className="btn-press rounded-lg border border-gray-300 bg-white px-3 py-2 text-[11px] font-semibold text-gray-500 hover:bg-gray-100"
                            >
                              Keep opted out
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {filteredPending.length > visible.length && (
                    <p className="py-2 text-center text-[12px] text-gray-500">
                      Showing the first {visible.length} of {filteredPending.length} — refine the search to narrow it down.
                      Select all still covers every match.
                    </p>
                  )}
                </div>
                  );
                })()
              )
            ) : historyList.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-gray-500">No decisions yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                {historyList.map((h, i) => (
                  <div key={h.id} className={`flex items-center justify-between gap-3 px-3 py-2.5 ${i > 0 ? "border-t border-gray-100" : ""}`}>
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-semibold text-gray-900">{h.email}</p>
                      <p className="truncate text-[10px] text-gray-500">{h.source}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                        h.status === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"
                      }`}>
                        {h.status === "approved" ? "Reactivated" : "Kept opted out"}
                      </span>
                      <p className="mt-0.5 text-[10px] text-gray-500">
                        {h.decided_by} · {h.decided_at ? new Date(h.decided_at).toLocaleString() : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {(showAdd || editing) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => { setShowAdd(false); setEditing(null); }}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-5 text-[16px] font-bold text-gray-900">{editing ? "Edit Contact" : "Add Contact"}</h2>
            <form onSubmit={editing ? (e) => { e.preventDefault(); handleUpdate(); } : handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Organization</label>
                  <input value={form.org_name} onChange={(e) => setForm({ ...form, org_name: e.target.value })} className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Contact Name</label>
                  <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Email *</label>
                <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none">
                    {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none resize-none" />
              </div>

              {/* Custom fields */}
              <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">Custom Fields</p>
                {customFields.length > 0 && (
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    {customFields.map((f) => (
                      <div key={`form-${f}`}>
                        <div className="mb-0.5 flex items-center justify-between">
                          <label className="text-[10px] font-semibold text-gray-500">{f}</label>
                          <button
                            type="button"
                            onClick={() => removeCustomField(f)}
                            className="text-[10px] font-semibold text-gray-400 hover:text-red-500"
                            title={`Remove the "${f}" field`}
                          >
                            remove
                          </button>
                        </div>
                        <input
                          value={formCustom[f] || ""}
                          onChange={(e) => setFormCustom({ ...formCustom, [f]: e.target.value })}
                          className="input-glow w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-[12px] text-gray-900 outline-none"
                        />
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    value={newFieldName}
                    onChange={(e) => setNewFieldName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomField(); } }}
                    placeholder="Add a field (e.g. Industry, LinkedIn)"
                    className="input-glow flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-[12px] text-gray-900 placeholder-gray-400 outline-none"
                  />
                  <button type="button" onClick={addCustomField} className="rounded-lg bg-[#054B70]/10 px-3 py-2 text-[11px] font-bold text-[#054B70] hover:bg-[#054B70] hover:text-white transition-colors">
                    Add Field
                  </button>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setShowAdd(false); setEditing(null); }} className="rounded-lg px-5 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white">
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
