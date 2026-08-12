"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import { useAuth } from "../hooks/useAuth";
import Select from "../components/Select";
import DatePicker from "../components/DatePicker";
import { motion, AnimatePresence } from "motion/react";

const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 };
const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface Group {
  id: number;
  name: string;
  description: string;
  campaigns: number;
  created_at: string;
}

interface CampaignRow {
  id: number;
  name: string;
  group_id: number;
  group_name: string;
  description: string;
  is_automated: boolean;
  segment_id: number | null;
  import_group_id: number | null;
  tag_id: number | null;
  audience: string;
  runs: number;
  touchpoints: number;
  created_at: string;
}

interface SegmentInfo { id: number; name: string; import_group_id: number; contact_count: number }
interface ImportGroupInfo { id: number; name: string }
interface TagInfo { id: number; name: string }

export default function CampaignGroupsPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";
  const isAdmin = user?.role === "admin";
  const router = useRouter();

  const [groups, setGroups] = useState<Group[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [importGroups, setImportGroups] = useState<ImportGroupInfo[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [perPage, setPerPage] = useState(10);
  const [toast, setToast] = useState<string | null>(null);

  // Drill-down: Edit Campaign Group (form + its campaigns)
  const [openGroup, setOpenGroup] = useState<Group | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [campaignSearch, setCampaignSearch] = useState("");
  const [gName, setGName] = useState("");
  const [gDesc, setGDesc] = useState("");
  const [gSaving, setGSaving] = useState(false);
  // Slide direction for the drill-down transition: 1 = into a group, -1 = back out
  const [dir, setDir] = useState(1);

  // New group modal
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  // Create / edit campaign modal (Beacon's "Create Campaign")
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<CampaignRow | null>(null);
  const [cName, setCName] = useState("");
  const [cGroupId, setCGroupId] = useState("");
  const [cSegmentId, setCSegmentId] = useState("");
  const [cAudGroupId, setCAudGroupId] = useState("");
  const [cTagId, setCTagId] = useState("");
  const [cNotes, setCNotes] = useState("");
  const [cBusy, setCBusy] = useState(false);

  // Schedule-a-campaign modal (row action)
  const [scheduleFor, setScheduleFor] = useState<CampaignRow | null>(null);
  const [schStartAt, setSchStartAt] = useState("");
  const [schBusy, setSchBusy] = useState(false);

  function notify(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch(`${API}/campaign-groups/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setGroups(data.groups);
    } catch { /* */ }
    setLoaded(true);
  }, []);

  const fetchCampaigns = useCallback(async (groupId: number) => {
    try {
      const res = await fetch(`${API}/campaigns/?group_id=${groupId}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setCampaigns(data.campaigns);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    fetchGroups();
    (async () => {
      try {
        const res = await fetch(`${API}/contacts/`, { credentials: "include" });
        const data = await res.json();
        if (data.ok && data.segments) setSegments(data.segments);
        if (data.ok && data.import_groups) setImportGroups(data.import_groups);
        if (data.ok && data.tags) setTags(data.tags);
      } catch { /* */ }
    })();
  }, [fetchGroups]);

  function openGroupView(g: Group) {
    setDir(1);
    setOpenGroup(g);
    setGName(g.name);
    setGDesc(g.description || "");
    setCampaignSearch("");
    fetchCampaigns(g.id);
  }

  function backToGroups() {
    setDir(-1);
    setOpenGroup(null);
  }

  async function createGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${API}/campaign-groups/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowNewGroup(false);
        setNewGroupName("");
        notify(`Group "${name}" created`);
        fetchGroups();
      } else notify(data.error || "Error");
    } catch { notify("Error creating group"); }
  }

  async function saveGroup() {
    if (!openGroup || !gName.trim()) return;
    setGSaving(true);
    try {
      const res = await fetch(`${API}/campaign-groups/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: openGroup.id, name: gName.trim(), description: gDesc }),
        credentials: "include",
      });
      if ((await res.json()).ok) {
        notify("Group saved");
        setOpenGroup({ ...openGroup, name: gName.trim(), description: gDesc });
        fetchGroups();
      }
    } catch { notify("Error saving group"); }
    setGSaving(false);
  }

  async function deleteGroup(g: Group) {
    if (!confirm(`Delete the group "${g.name}"?\n\nEvery campaign inside it — and each campaign's touchpoints — is removed too. Past sends keep their history.`)) return;
    try {
      const res = await fetch(`${API}/campaign-groups/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: g.id }),
        credentials: "include",
      });
      if ((await res.json()).ok) {
        notify(`Group "${g.name}" deleted`);
        if (openGroup?.id === g.id) backToGroups();
        fetchGroups();
      }
    } catch { notify("Error deleting group"); }
  }

  function openCreateCampaign() {
    setEditingCampaign(null);
    setCName("");
    setCGroupId(openGroup ? String(openGroup.id) : "");
    setCSegmentId("");
    setCAudGroupId("");
    setCTagId("");
    setCNotes("");
    setShowCampaignModal(true);
  }

  function openEditCampaign(c: CampaignRow) {
    setEditingCampaign(c);
    setCName(c.name);
    setCGroupId(String(c.group_id));
    setCSegmentId(c.segment_id ? String(c.segment_id) : "");
    setCAudGroupId(c.import_group_id ? String(c.import_group_id) : "");
    setCTagId(c.tag_id ? String(c.tag_id) : "");
    setCNotes(c.description || "");
    setShowCampaignModal(true);
  }

  async function submitCampaign(createAnother: boolean) {
    const name = cName.trim();
    if (!name || !cGroupId) { notify("Name and group are required"); return; }
    setCBusy(true);
    try {
      const url = editingCampaign ? `${API}/campaigns/update/` : `${API}/campaigns/create/`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editingCampaign ? { id: editingCampaign.id } : { group_id: Number(cGroupId) }),
          name,
          segment_id: cSegmentId ? Number(cSegmentId) : null,
          import_group_id: cAudGroupId ? Number(cAudGroupId) : null,
          tag_id: cTagId ? Number(cTagId) : null,
          notes: cNotes,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        if (editingCampaign) {
          setShowCampaignModal(false);
          notify("Campaign saved");
          if (openGroup) fetchCampaigns(openGroup.id);
        } else if (createAnother) {
          notify(`Campaign "${name}" created`);
          setCName("");
          setCNotes("");
          if (openGroup) fetchCampaigns(openGroup.id);
          fetchGroups();
        } else {
          // Land on its flow board to add touchpoints and the waits between them
          router.push(`/email-templates?campaign=${data.id}`);
          return;
        }
      } else notify(data.error || "Error");
    } catch { notify("Error saving campaign"); }
    setCBusy(false);
  }

  async function deleteCampaign(c: CampaignRow) {
    if (!confirm(`Delete the campaign "${c.name}"?\n\nIts flow of touchpoints is removed. Past sends keep their history.`)) return;
    try {
      const res = await fetch(`${API}/campaigns/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id }),
        credentials: "include",
      });
      if ((await res.json()).ok) {
        notify(`Campaign "${c.name}" deleted`);
        if (openGroup) fetchCampaigns(openGroup.id);
        fetchGroups();
      }
    } catch { notify("Error deleting campaign"); }
  }

  async function sendNow(c: CampaignRow) {
    if (!confirm(`Run "${c.name}" now?\n\nTouchpoint 1 goes out immediately; each next touchpoint follows after its own wait. Touchpoints without a subject are skipped.`)) return;
    try {
      const res = await fetch(`${API}/schedules/schedule-campaign/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: c.id, when: "now" }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        notify(`Flow started — ${data.scheduled} email${data.scheduled === 1 ? "" : "s"}${data.skipped ? ` (${data.skipped} empty skipped)` : ""}. Track it on Schedule and Send Progress.`);
        if (openGroup) fetchCampaigns(openGroup.id);
      } else notify(data.error || "Could not start");
    } catch { notify("Could not start"); }
  }

  function openSchedule(c: CampaignRow) {
    setScheduleFor(c);
    const t = new Date(Date.now() + 86400000);
    const pad = (n: number) => String(n).padStart(2, "0");
    setSchStartAt(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T09:00`);
  }

  async function submitSchedule() {
    if (!scheduleFor || !schStartAt) return;
    setSchBusy(true);
    try {
      const res = await fetch(`${API}/schedules/schedule-campaign/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: scheduleFor.id,
          when: "later",
          start_at: new Date(schStartAt).toISOString(),
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setScheduleFor(null);
        notify(`On the schedule — ${data.scheduled} email${data.scheduled === 1 ? "" : "s"}. See it on the Schedule page.`);
      } else notify(data.error || "Could not schedule");
    } catch { notify("Could not schedule"); }
    setSchBusy(false);
  }

  const matchingGroups = groups.filter((g) => !search || g.name.toLowerCase().includes(search.toLowerCase()));
  const matchingCampaigns = campaigns.filter((c) => !campaignSearch || c.name.toLowerCase().includes(campaignSearch.toLowerCase()));
  const visibleGroups = matchingGroups.slice(0, perPage);
  const visibleCampaigns = matchingCampaigns.slice(0, perPage);

  const slideVariants = {
    enter: (d: number) => ({ opacity: 0, x: d * 56 }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: d * -56 }),
  };

  const thCls = "px-4 py-3 text-left text-[12px] font-semibold text-gray-950";
  const tdCls = "px-4 py-3 text-[13px] text-gray-950";
  const rowBtn = "rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors";

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
              <motion.div
                key={openGroup ? `head-${openGroup.id}` : "head-list"}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={SPRING}
                className="min-w-0"
              >
                {openGroup ? (
                  <>
                    <p className="text-[11px] text-gray-400">
                      <button onClick={backToGroups} className="hover:text-[#054B70] hover:underline">Campaign Groups</button>
                      <span className="mx-1">›</span>
                      Edit
                    </p>
                    <h1 className="text-[16px] font-bold text-gray-950">Edit Campaign Group</h1>
                    <p className="truncate text-[11px] text-gray-500">
                      The campaigns in this group are below — open one (or create one) to build its flow of touchpoints and waits.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-gray-400">Campaign Groups <span className="mx-1">›</span> List</p>
                    <h1 className="text-[16px] font-bold text-gray-950">Campaign Groups</h1>
                    <p className="truncate text-[11px] text-gray-500">
                      A group sits a level above campaigns and holds all the campaigns for one audience — e.g. an America group with all your American campaigns inside.
                    </p>
                  </>
                )}
              </motion.div>
            </div>
            {canEdit && (
              <motion.div
                key={openGroup ? "btn-delete" : "btn-group"}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...SPRING, delay: 0.05 }}
              >
                {openGroup ? (
                  isAdmin && (
                    <button
                      onClick={() => deleteGroup(openGroup)}
                      className="btn-press flex items-center gap-2 rounded-lg border border-red-500/40 bg-white px-4 py-2.5 text-[12px] font-bold text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  )
                ) : (
                  <button
                    onClick={() => { setShowNewGroup(true); setNewGroupName(""); }}
                    className="btn-press flex items-center gap-2 rounded-lg bg-[#054B70] px-4 py-2.5 text-[12px] font-bold text-white"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
                    New Group
                  </button>
                )}
              </motion.div>
            )}
          </div>
        </header>

        <main className="p-4 sm:p-8">
          <AnimatePresence>
            {toast && (
              <motion.div
                initial={{ opacity: 0, y: -12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={SPRING}
                className="mb-5 flex items-center gap-2 rounded-lg bg-white px-4 py-3 text-[13px] font-semibold text-gray-900 shadow-lg ring-1 ring-gray-950/5"
              >
                <svg className="h-4 w-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
                {toast}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.div
              key={!loaded ? "loading" : openGroup ? `edit-${openGroup.id}` : "groups"}
              custom={dir}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={SPRING}
            >
              {!loaded ? (
                <div className="overflow-hidden rounded-xl bg-white p-8 shadow-sm ring-1 ring-gray-950/5">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="mb-3 h-12 rounded-lg bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                  ))}
                </div>
              ) : openGroup ? (
                /* ── Edit Campaign Group ── */
                <div className="flex flex-col gap-6">
                  {/* Group form */}
                  <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-950/5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">
                          Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          value={gName}
                          onChange={(e) => setGName(e.target.value)}
                          className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-950 outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Description</label>
                        <input
                          value={gDesc}
                          onChange={(e) => setGDesc(e.target.value)}
                          className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-950 outline-none"
                        />
                      </div>
                    </div>
                    {canEdit && (
                      <div className="mt-4 flex gap-2">
                        <button
                          onClick={saveGroup}
                          disabled={gSaving || !gName.trim()}
                          className="btn-press rounded-lg bg-[#054B70] px-5 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
                        >
                          {gSaving ? "Saving…" : "Save changes"}
                        </button>
                        <button onClick={backToGroups} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Campaigns table */}
                  <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
                      <h2 className="text-[14px] font-bold text-gray-950">Campaigns</h2>
                      <div className="flex items-center gap-2">
                        <div className="relative w-full sm:w-56">
                          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                          </svg>
                          <input
                            value={campaignSearch}
                            onChange={(e) => setCampaignSearch(e.target.value)}
                            placeholder="Search"
                            className="w-full rounded-lg bg-white py-2 pl-9 pr-3 text-[13px] text-gray-950 shadow-sm ring-1 ring-gray-950/10 outline-none placeholder-gray-400 focus:ring-2 focus:ring-[#054B70]"
                          />
                        </div>
                        {canEdit && (
                          <button
                            onClick={openCreateCampaign}
                            className="btn-press flex shrink-0 items-center gap-1.5 rounded-lg bg-[#054B70] px-3.5 py-2 text-[12px] font-bold text-white"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
                            New Campaign
                          </button>
                        )}
                      </div>
                    </div>

                    {visibleCampaigns.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-14 text-gray-400">
                        <p className="text-[14px] font-semibold text-gray-500">No campaigns in this group yet</p>
                        <p className="mt-1 text-[12px]">Use &quot;New Campaign&quot; above to add the first one.</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px]">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className={thCls}>Name</th>
                              <th className={`${thCls} w-20`}>Runs</th>
                              <th className={`${thCls} w-28`}>Touchpoints</th>
                              <th className={thCls}>Audience</th>
                              <th className="w-[340px] px-4 py-3" />
                            </tr>
                          </thead>
                          <tbody>
                            {visibleCampaigns.map((c, i) => (
                              <motion.tr
                                key={c.id}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ ...SPRING, delay: i * 0.03 }}
                                className="border-b border-gray-100 transition-colors last:border-0 hover:bg-gray-50"
                              >
                                <td className={tdCls}>
                                  <span className="font-medium">{c.name}</span>
                                  <span className="ml-2 rounded-full bg-gray-400/15 px-2 py-0.5 text-[10px] font-semibold text-gray-500">
                                    {c.is_automated ? "Automated" : "Normal"}
                                  </span>
                                </td>
                                <td className={tdCls}>{c.runs}</td>
                                <td className={tdCls}>{c.touchpoints}</td>
                                <td className={tdCls}>{c.audience || "—"}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-right">
                                  <button onClick={() => router.push(`/email-templates?campaign=${c.id}`)} className={`${rowBtn} text-[#054B70] hover:bg-[#054B70]/5`}>Open flow</button>
                                  {canEdit && (
                                    <>
                                      <button onClick={() => sendNow(c)} className={`${rowBtn} text-green-700 hover:bg-green-500/10`}>Send now</button>
                                      <button onClick={() => openSchedule(c)} className={`${rowBtn} text-[#054B70] hover:bg-[#054B70]/5`}>Schedule</button>
                                      <button onClick={() => openEditCampaign(c)} className={`${rowBtn} text-gray-600 hover:bg-gray-100`}>Edit</button>
                                    </>
                                  )}
                                  {isAdmin && (
                                    <button onClick={() => deleteCampaign(c)} className={`${rowBtn} text-red-600 hover:bg-red-50`}>Delete</button>
                                  )}
                                </td>
                              </motion.tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3">
                      <p className="text-[12px] text-gray-500">
                        Showing {visibleCampaigns.length} result{visibleCampaigns.length === 1 ? "" : "s"}
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-gray-500">Per page</span>
                        <Select
                          size="sm"
                          className="w-20"
                          value={String(perPage)}
                          onChange={(v) => setPerPage(Number(v))}
                          options={[{ value: "10", label: "10" }, { value: "25", label: "25" }, { value: "50", label: "50" }]}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* ── Groups list ── */
                <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
                  <div className="flex items-center justify-end border-b border-gray-200 px-4 py-3">
                    <div className="relative w-full sm:w-64">
                      <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                      </svg>
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search"
                        className="w-full rounded-lg bg-white py-2 pl-9 pr-3 text-[13px] text-gray-950 shadow-sm ring-1 ring-gray-950/10 outline-none placeholder-gray-400 focus:ring-2 focus:ring-[#054B70]"
                      />
                    </div>
                  </div>

                  {visibleGroups.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                      <p className="text-[14px] font-semibold text-gray-500">No campaign groups yet</p>
                      <p className="mt-1 text-[12px]">Use &quot;New Group&quot; above to create the first one.</p>
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className={thCls}>Name</th>
                          <th className={`${thCls} w-32`}>Campaigns</th>
                          <th className="w-40 px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleGroups.map((g, i) => (
                          <motion.tr
                            key={g.id}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ ...SPRING, delay: i * 0.03 }}
                            onClick={() => openGroupView(g)}
                            className="cursor-pointer border-b border-gray-100 transition-colors last:border-0 hover:bg-gray-50"
                          >
                            <td className={`${tdCls} font-medium`}>{g.name}</td>
                            <td className={tdCls}>{g.campaigns}</td>
                            <td className="px-4 py-3 text-right">
                              <button onClick={(e) => { e.stopPropagation(); openGroupView(g); }} className={`${rowBtn} text-[#054B70] hover:bg-[#054B70]/5`}>Open</button>
                              {isAdmin && (
                                <button onClick={(e) => { e.stopPropagation(); deleteGroup(g); }} className={`${rowBtn} text-red-600 hover:bg-red-50`}>Delete</button>
                              )}
                            </td>
                          </motion.tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3">
                    <p className="text-[12px] text-gray-500">
                      Showing 1 to {visibleGroups.length} of {matchingGroups.length} results
                    </p>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-gray-500">Per page</span>
                      <Select
                        size="sm"
                        className="w-20"
                        value={String(perPage)}
                        onChange={(v) => setPerPage(Number(v))}
                        options={[{ value: "10", label: "10" }, { value: "25", label: "25" }, { value: "50", label: "50" }]}
                      />
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </MainContent>

      {/* New group modal */}
      {showNewGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowNewGroup(false)}>
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={SPRING} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-950">New group</h2>
            <p className="mb-4 text-[12px] text-gray-500">Give it a recognisable name — campaigns live inside groups.</p>
            <input
              autoFocus
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createGroup(); }}
              placeholder="e.g. America"
              className="mb-5 w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-gray-950 shadow-sm ring-1 ring-gray-950/10 outline-none focus:ring-2 focus:ring-[#054B70]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowNewGroup(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={createGroup} disabled={!newGroupName.trim()} className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50">Create</button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Create / edit campaign — Beacon's "Create Campaign" dialog */}
      {showCampaignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowCampaignModal(false)}>
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={SPRING} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-950">{editingCampaign ? "Edit Campaign" : "Create Campaign"}</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              {editingCampaign
                ? "Rename the campaign, or change its default audience and notes."
                : "After creating it you'll land on its flow board to add touchpoints and the waits between them."}
            </p>

            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Campaign name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              className="input-glow mb-3 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-950 outline-none"
            />

            {editingCampaign && (
              <>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Group <span className="text-red-500">*</span>
                </label>
                <Select
                  value={cGroupId}
                  onChange={setCGroupId}
                  disabled
                  className="mb-3 w-full"
                  options={groups.map((g) => ({ value: String(g.id), label: g.name }))}
                  placeholder="Pick a group…"
                />
              </>
            )}

            {/* Default audience: group → segment → tag. Used by sends & schedules unless overridden. */}
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Audience group (optional)</label>
            <Select
              value={cAudGroupId}
              onChange={(v) => { setCAudGroupId(v); setCSegmentId(""); }}
              searchable
              className="mb-3 w-full"
              options={[{ value: "", label: "All active contacts" }, ...importGroups.map((g) => ({ value: String(g.id), label: g.name }))]}
            />

            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Segment (optional)</label>
            <Select
              value={cSegmentId}
              onChange={setCSegmentId}
              searchable
              className="mb-3 w-full"
              options={[
                { value: "", label: cAudGroupId ? "Whole group" : "Select an option" },
                ...(cAudGroupId ? segments.filter((s) => String(s.import_group_id) === cAudGroupId) : segments).map((s) => ({
                  value: String(s.id),
                  label: cAudGroupId ? s.name : `${s.name} (${importGroups.find((g) => g.id === s.import_group_id)?.name || "group"})`,
                })),
              ]}
            />

            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Tag (optional)</label>
            <Select
              value={cTagId}
              onChange={setCTagId}
              searchable
              className="mb-1 w-full"
              options={[{ value: "", label: "No tag — everyone" }, ...tags.map((t) => ({ value: String(t.id), label: t.name }))]}
            />
            <p className="mb-3 text-[11px] text-gray-500">
              Who this campaign sends to — pre-filled on every send and schedule. Leave empty to target all active contacts; you can still override it when sending.
            </p>

            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Notes (optional)</label>
            <textarea
              value={cNotes}
              onChange={(e) => setCNotes(e.target.value)}
              rows={2}
              className="input-glow mb-5 w-full resize-none rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-950 outline-none"
            />

            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => setShowCampaignModal(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              {!editingCampaign && (
                <button
                  onClick={() => submitCampaign(true)}
                  disabled={cBusy || !cName.trim() || !cGroupId}
                  className="rounded-lg bg-white px-4 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 hover:bg-gray-50 disabled:opacity-50"
                >
                  Create &amp; create another
                </button>
              )}
              <button
                onClick={() => submitCampaign(false)}
                disabled={cBusy || !cName.trim() || !cGroupId}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {cBusy ? "Working…" : editingCampaign ? "Save changes" : "Create"}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Schedule a campaign (row action) */}
      {scheduleFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setScheduleFor(null)}>
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={SPRING} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-950">Schedule &quot;{scheduleFor.name}&quot;</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              Touchpoint 1 goes out at the launch time; each next touchpoint follows after its own wait. Watch and cancel it on the Schedule page.
            </p>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Launch at</label>
            <DatePicker withTime value={schStartAt} onChange={setSchStartAt} className="mb-5 w-full" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setScheduleFor(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={submitSchedule}
                disabled={schBusy || !schStartAt}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {schBusy ? "Working…" : "Put it on the schedule"}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
