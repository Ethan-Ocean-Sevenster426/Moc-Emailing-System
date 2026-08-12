"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";

// Snappy Filament-style spring shared by the board animations
const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 };
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import DatePicker from "../components/DatePicker";
import Select from "../components/Select";
import RichTextEditor from "../components/RichTextEditor";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

// Goodbye emails are stored as touchpoint_number = GOODBYE_OFFSET + the touchpoint they follow
// (matches TouchpointTemplate.GOODBYE_OFFSET on the backend).
const GOODBYE_OFFSET = 1000000;

interface Template {
  touchpoint_number: number;
  subject: string;
  body: string;
  body_html: string;
  signature: string;
  opt_out_text: string;
  attachment_name: string;
  attachment_url: string;
  signature_image_name: string;
  signature_image_url: string;
  signature_image_height: number;
  signature_image_width: number;
  days_after_previous: number;
}

interface ActiveJob {
  id: number;
  touchpoint_number: number;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  current_contact?: string | null;
}

interface LibraryTemplate {
  id: number;
  name: string;
  subject: string;
  body?: string;
  body_html?: string;
  signature?: string;
  opt_out_text?: string;
}

const DEFAULT_OPT_OUT_TEXT = "If you'd prefer not to receive further communication from us, you can opt out here.";

const EMPTY_TEMPLATE: Omit<Template, "touchpoint_number"> = {
  subject: "",
  body: "",
  body_html: "",
  signature: "",
  opt_out_text: DEFAULT_OPT_OUT_TEXT,
  attachment_name: "",
  attachment_url: "",
  signature_image_name: "",
  signature_image_url: "",
  signature_image_height: 90,
  signature_image_width: 0,
  days_after_previous: 7,
};

const VARIABLES = [
  { key: "{{org_name}}", label: "Organisation" },
  { key: "{{contact_name}}", label: "Contact name" },
  { key: "{{email}}", label: "Email address" },
  { key: "{{phone}}", label: "Phone" },
  { key: "{{opt_out}}", label: "Opt-out link" },
];

function EmailTemplatesPageInner() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeTP, setActiveTP] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [savedTPs, setSavedTPs] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [clearAttach, setClearAttach] = useState(false);
  const [pendingSigImg, setPendingSigImg] = useState<File | null>(null);
  const [clearSigImg, setClearSigImg] = useState(false);
  const [sigPreviewUrl, setSigPreviewUrl] = useState("");
  const [testEmails, setTestEmails] = useState<string[]>([]);
  const [testEmailInput, setTestEmailInput] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [schedError, setSchedError] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "editor" | "schedules">("dashboard");
  // "Also save this as a reusable template (optional)" — Beacon's editor footer field
  const [alsoSaveName, setAlsoSaveName] = useState("");
  // "Start from a saved template (optional)" — Beacon's editor top select
  const [startFromTemplate, setStartFromTemplate] = useState("");
  // Drag-corner resize box in the live preview syncs back to the sliders
  const sigResizeRef = useRef<HTMLDivElement>(null);
  // The rich "Email body" editor element — merge-variable pills insert here at the caret
  const richBodyRef = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showBulkSend, setShowBulkSend] = useState<number | null>(null);
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkGroupId, setBulkGroupId] = useState<string>("");
  const [bulkSegmentIds, setBulkSegmentIds] = useState<string[]>([]);
  const [bulkTemplateId, setBulkTemplateId] = useState<string>("");
  const [bulkLimit, setBulkLimit] = useState<string>("");
  const [bulkEligible, setBulkEligible] = useState<number | null>(null);
  // Reusable templates (read-only here; created/edited on the Template Library page)
  const [libraryTemplates, setLibraryTemplates] = useState<LibraryTemplate[]>([]);
  const router = useRouter();
  const [importGroups, setImportGroups] = useState<{ id: number; name: string; contact_count: number }[]>([]);
  const [segments, setSegments] = useState<{ id: number; name: string; import_group_id: number; contact_count: number }[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const jobPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Which campaign this board belongs to (?campaign=ID from the groups page).
  // Blank falls back to the backend's default campaign.
  const searchParams = useSearchParams();
  const campaignId = searchParams.get("campaign") || "";
  const cq = campaignId ? `campaign_id=${campaignId}` : "";
  const [campaignName, setCampaignName] = useState<string>("");
  const [campaignAudience, setCampaignAudience] = useState<string>("");
  useEffect(() => {
    if (!campaignId) return;
    (async () => {
      try {
        const res = await fetch(`${API}/campaigns/detail/?id=${campaignId}`, { credentials: "include" });
        const data = await res.json();
        if (data.ok) {
          setCampaignName(data.campaign.name);
          setCampaignAudience(data.campaign.audience || "");
        }
      } catch { /* */ }
    })();
  }, [campaignId]);

  // Board data: journey progress, bounce splits, waits, goodbyes per touchpoint
  interface BoardGoodbye { name: string; subject: string; has_content: boolean; test_number: number }
  interface WaitParts { months: number; weeks: number; days: number; hours: number; minutes: number }
  interface BoardTP {
    touchpoint_number: number;
    name: string;
    subject: string;
    has_content: boolean;
    days_after_previous: number;
    wait_minutes: number;
    wait_label: string;
    wait_parts: WaitParts;
    send_time: string;
    scheduled_date: string;
    received: number;
    audience: number;
    bounces_soft: number;
    bounces_hard: number;
    optouts: number;
    goodbye: BoardGoodbye | null;
  }
  const [board, setBoard] = useState<BoardTP[]>([]);
  const [boardLoaded, setBoardLoaded] = useState(false);

  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch(`${API}/flow/board/?${cq}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setBoard(data.touchpoints);
    } catch { /* */ }
    setBoardLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cq]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  // ── Board modals: add, wait, delete, test, goodbye, flow templates ──
  // "Add an email": where it sits, what it starts from, and the wait before it
  const EMPTY_WAIT: WaitParts = { months: 0, weeks: 1, days: 0, hours: 0, minutes: 0 };
  const [showAddTp, setShowAddTp] = useState(false);
  const [addAfter, setAddAfter] = useState("0");
  const [addParts, setAddParts] = useState<WaitParts>(EMPTY_WAIT);
  const [addTime, setAddTime] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addTemplateId, setAddTemplateId] = useState("");
  // Explicit "fresh vs template" choice so the two paths are obvious
  const [addFrom, setAddFrom] = useState<"fresh" | "template">("fresh");
  const [addBusy, setAddBusy] = useState(false);

  function openAddTouchpoint() {
    setAddAfter(String(board.length ? board[board.length - 1].touchpoint_number : 0));
    setAddParts(EMPTY_WAIT);
    setAddTime("");
    setAddDate("");
    setAddTemplateId("");
    setAddFrom("fresh");
    setShowAddTp(true);
  }

  async function addTouchpoint() {
    setAddBusy(true);
    try {
      const res = await fetch(`${API}/flow/touchpoint/add/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaignId || undefined,
          after: Number(addAfter),
          ...addParts,
          send_time: addTime,
          send_date: addDate,
          template_id: addTemplateId ? Number(addTemplateId) : undefined,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowAddTp(false);
        notifyBoard(
          `Step ${data.touchpoint_number} added${data.copied_from ? ` from "${data.copied_from}"` : ""}` +
          (data.touchpoint_number > 1
            ? ` — goes out ${(data.wait_label || "").toLowerCase()} after step ${data.touchpoint_number - 1}.`
            : " — it sends as soon as the flow starts.")
        );
        await Promise.all([fetchBoard(), fetchTemplates()]);
        // Written from scratch → straight into the editor to write it now.
        // Copied from a template → it's ready; stay on the board.
        if (!addTemplateId) openEditor(data.touchpoint_number);
      } else notifyBoard(data.error || "Could not add");
    } catch { notifyBoard("Could not add"); }
    setAddBusy(false);
  }

  // Inline rename: a custom label for a touchpoint (or a goodbye email,
  // addressed by its storage number) instead of the default name
  const [renameTp, setRenameTp] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");

  function startRename(tpNumber: number, currentName: string) {
    setRenameTp(tpNumber);
    setRenameVal(currentName);
  }

  async function saveRename() {
    if (renameTp === null) return;
    const tp = renameTp;
    const name = renameVal.trim();
    setRenameTp(null);
    const prev = tp >= GOODBYE_OFFSET
      ? (board.find((b) => b.goodbye?.test_number === tp)?.goodbye?.name || "")
      : (board.find((b) => b.touchpoint_number === tp)?.name || "");
    if (name === prev) return;
    try {
      const res = await fetch(`${API}/flow/touchpoint/rename/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint_number: tp, name, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        const fallback = tp >= GOODBYE_OFFSET ? "Goodbye email" : `Touchpoint ${tp}`;
        notifyBoard(name ? `Renamed to "${name}"` : `Name cleared — back to "${fallback}"`);
        fetchBoard();
      } else notifyBoard(data.error || "Could not rename");
    } catch { notifyBoard("Could not rename"); }
  }

  // Schedule the whole flow from the board (same endpoint the campaigns list uses)
  const [showScheduleFlow, setShowScheduleFlow] = useState(false);
  const [schStartAt, setSchStartAt] = useState("");
  const [schGroupId, setSchGroupId] = useState("");
  const [schSegmentId, setSchSegmentId] = useState("");
  const [schBusy, setSchBusy] = useState(false);

  function openScheduleFlow() {
    const t = new Date(Date.now() + 86400000);
    const pad = (x: number) => String(x).padStart(2, "0");
    setSchStartAt(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T09:00`);
    setSchGroupId("");
    setSchSegmentId("");
    setShowScheduleFlow(true);
  }

  async function submitScheduleFlow() {
    if (!schStartAt) return;
    setSchBusy(true);
    try {
      const res = await fetch(`${API}/schedules/schedule-campaign/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaignId || undefined,
          when: "later",
          start_at: new Date(schStartAt).toISOString(),
          ...(schGroupId ? { import_group_id: Number(schGroupId) } : {}),
          ...(schSegmentId ? { segment_id: Number(schSegmentId) } : {}),
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowScheduleFlow(false);
        notifyBoard(`On the schedule — ${data.scheduled} email${data.scheduled === 1 ? "" : "s"}${data.skipped ? ` (${data.skipped} empty skipped)` : ""}. See it on the Schedule page.`);
      } else notifyBoard(data.error || "Could not schedule");
    } catch { notifyBoard("Could not schedule"); }
    setSchBusy(false);
  }

  const [waitTp, setWaitTp] = useState<number | null>(null);
  const [waitParts, setWaitParts] = useState<WaitParts>(EMPTY_WAIT);
  const [waitTime, setWaitTime] = useState("");
  const [waitDate, setWaitDate] = useState("");

  function openWaitEditor(bt: BoardTP) {
    setWaitTp(bt.touchpoint_number);
    setWaitParts({ ...bt.wait_parts });
    setWaitTime(bt.send_time || "");
    setWaitDate(bt.scheduled_date || "");
  }
  const [delTp, setDelTp] = useState<number | null>(null);
  // Test target: a touchpoint or a goodbye (identified by its storage number)
  const [testFor, setTestFor] = useState<{ label: string; number: number } | null>(null);
  const [testAddr, setTestAddr] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  // Remove-goodbye confirmation
  const [rmGoodbyeFor, setRmGoodbyeFor] = useState<number | null>(null);
  // Add-goodbye dialog — like Add touchpoint: copy a saved email or write from scratch
  const [addGbFor, setAddGbFor] = useState<number | null>(null);
  const [addGbTemplateId, setAddGbTemplateId] = useState("");
  const [gbFrom, setGbFrom] = useState<"fresh" | "template">("fresh");
  // Flow templates ("Use template" / "Save as template")
  const [showUseTemplate, setShowUseTemplate] = useState(false);
  const [flowTemplates, setFlowTemplates] = useState<{ id: number; name: string; touchpoint_count: number; goodbye_count: number }[]>([]);
  const [useTemplateId, setUseTemplateId] = useState("");
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [flowName, setFlowName] = useState("");
  const [boardToast, setBoardToast] = useState<string | null>(null);

  function notifyBoard(msg: string) {
    setBoardToast(msg);
    setTimeout(() => setBoardToast(null), 3500);
  }

  async function saveWait() {
    if (waitTp === null) return;
    try {
      const res = await fetch(`${API}/flow/wait/save/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touchpoint_number: waitTp,
          ...waitParts,
          send_time: waitTime,
          send_date: waitDate,
          campaign_id: campaignId || undefined,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setWaitTp(null);
        notifyBoard(
          waitDate
            ? `Pinned to ${waitDate}${waitTime ? ` at ${waitTime}` : ""} — the wait is ignored`
            : data.wait_minutes === 0
            ? "Wait removed — sends immediately after the previous touchpoint"
            : `Wait updated — ${data.wait_label}${waitTime ? `, then at ${waitTime}` : ""}`
        );
        fetchBoard();
      } else notifyBoard(data.error || "Error");
    } catch { notifyBoard("Error saving wait"); }
  }

  async function removeWait(tp: number) {
    try {
      await fetch(`${API}/flow/wait/save/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touchpoint_number: tp,
          months: 0, weeks: 0, days: 0, hours: 0, minutes: 0,
          send_time: "",
          send_date: "",
          campaign_id: campaignId || undefined,
        }),
        credentials: "include",
      });
      notifyBoard("Wait removed — sends immediately after the previous touchpoint");
      fetchBoard();
    } catch { /* */ }
  }

  async function clearTouchpoint() {
    if (delTp === null) return;
    try {
      const res = await fetch(`${API}/flow/touchpoint/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint_number: delTp, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      if ((await res.json()).ok) {
        setDelTp(null);
        notifyBoard("Touchpoint deleted");
        fetchBoard();
        fetchTemplates();
      }
    } catch { notifyBoard("Error"); }
  }

  async function sendBoardTest() {
    if (!testFor) return;
    const addrs = testAddr.split(",").map((s) => s.trim()).filter((s) => s.includes("@"));
    if (!addrs.length) { notifyBoard("No valid email addresses — enter at least one, comma-separated for multiple."); return; }
    setTestBusy(true);
    try {
      const res = await fetch(`${API}/email-templates/send-test/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint_number: testFor.number, recipients: addrs, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        notifyBoard(`Test of ${testFor.label} sent — ${addrs.length} email${addrs.length === 1 ? "" : "s"} sent to the addresses you gave.`);
        setTestFor(null);
      } else notifyBoard(data.error || "Test failed");
    } catch { notifyBoard("Test failed"); }
    setTestBusy(false);
  }

  // Beacon opens the FULL email editor for goodbyes — same schema as a touchpoint.
  // Load the goodbye's content into the templates list under its storage number, then open
  // the editor. When adding, an optional saved email can be copied in as the starting point.
  async function openGoodbye(forTp: number, fromTemplateId?: string) {
    const num = GOODBYE_OFFSET + forTp;
    let g: {
      subject?: string; body?: string; body_html?: string; signature?: string; opt_out_text?: string;
      attachment_name?: string; attachment_url?: string; signature_image_name?: string; signature_image_url?: string;
      signature_image_height?: number; signature_image_width?: number;
    } | null = null;
    try {
      const res = await fetch(`${API}/flow/goodbye/?goodbye_for=${forTp}&${cq}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) g = data.goodbye;
    } catch { /* open blank */ }
    const lib = fromTemplateId ? libraryTemplates.find((t) => String(t.id) === fromTemplateId) : undefined;
    setTemplates((prev) => {
      const entry: Template = {
        ...EMPTY_TEMPLATE,
        touchpoint_number: num,
        subject: lib ? (lib.subject ?? "") : (g?.subject || ""),
        body: lib ? (lib.body ?? "") : (g?.body || ""),
        body_html: lib ? (lib.body_html ?? "") : (g?.body_html || ""),
        signature: lib ? (lib.signature ?? "") : (g?.signature || ""),
        // "Leave the opt-out sentence blank — they have already opted out."
        opt_out_text: lib ? (lib.opt_out_text ?? "") : (g?.opt_out_text || ""),
        attachment_name: g?.attachment_name || "",
        attachment_url: g?.attachment_url || "",
        signature_image_name: g?.signature_image_name || "",
        signature_image_url: g?.signature_image_url || "",
        signature_image_height: g?.signature_image_height ?? 90,
        signature_image_width: g?.signature_image_width ?? 0,
      };
      const idx = prev.findIndex((t) => t.touchpoint_number === num);
      if (idx >= 0) { const list = [...prev]; list[idx] = entry; return list; }
      return [...prev, entry];
    });
    openEditor(num);
    if (lib && fromTemplateId) {
      setStartFromTemplate(fromTemplateId);
      setDirty(true); // copied content isn't saved yet
    }
  }

  // "Use a saved template" for a goodbye: it's saved straight to the board,
  // ready to go — the editor only opens for emails written from scratch.
  async function addGoodbyeFromTemplate(forTp: number, tplId: string) {
    const lib = libraryTemplates.find((t) => String(t.id) === tplId);
    if (!lib) { openGoodbye(forTp, tplId); return; }
    const fd = new FormData();
    fd.append("touchpoint_number", String(GOODBYE_OFFSET + forTp));
    if (campaignId) fd.append("campaign_id", campaignId);
    fd.append("subject", lib.subject ?? "");
    fd.append("body", lib.body ?? "");
    fd.append("body_html", lib.body_html ?? "");
    fd.append("signature", lib.signature ?? "");
    // "Leave the opt-out sentence blank — they have already opted out."
    fd.append("opt_out_text", lib.opt_out_text ?? "");
    fd.append("days_after_previous", "0");
    try {
      const res = await fetch(`${API}/email-templates/save/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        notifyBoard(`Goodbye email added from "${lib.name}" — it's ready. Click Edit to tweak it.`);
        await Promise.all([fetchBoard(), fetchTemplates()]);
      } else notifyBoard(data.error || "Could not add the goodbye email");
    } catch { notifyBoard("Could not add the goodbye email"); }
  }

  async function removeGoodbye(forTp: number) {
    try {
      await fetch(`${API}/flow/goodbye/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goodbye_for: forTp, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      setRmGoodbyeFor(null);
      notifyBoard("Goodbye email removed");
      fetchBoard();
    } catch { /* */ }
  }

  async function fetchFlowTemplates() {
    try {
      const res = await fetch(`${API}/flow/templates/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setFlowTemplates(data.flow_templates);
    } catch { /* */ }
  }

  async function applyFlowTemplate() {
    const t = flowTemplates.find((f) => String(f.id) === useTemplateId);
    if (!t) return;
    try {
      const res = await fetch(`${API}/flow/templates/apply/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowUseTemplate(false);
        notifyBoard(`Journey replaced by "${t.name}" — ${t.touchpoint_count} step${t.touchpoint_count === 1 ? "" : "s"}, fresh start, edit them as needed.`);
        fetchBoard();
        fetchTemplates();
      } else notifyBoard(data.error || "Error");
    } catch { notifyBoard("Error applying template"); }
  }

  async function saveFlowAsTemplate() {
    const name = flowName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${API}/flow/templates/save/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowSaveTemplate(false);
        setFlowName("");
        notifyBoard(`Template saved. Reproduce it any time with "Use template".`);
      } else notifyBoard(data.error || "Error");
    } catch { notifyBoard("Error saving template"); }
  }

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const sigInputRef = useRef<HTMLInputElement>(null);

  const getTemplate = useCallback(
    (num: number): Template => {
      return (
        templates.find((t) => t.touchpoint_number === num) || {
          touchpoint_number: num,
          ...EMPTY_TEMPLATE,
        }
      );
    },
    [templates]
  );

  const current = activeTP ? getTemplate(activeTP) : null;
  const hasContent = (num: number) => {
    const t = templates.find((t) => t.touchpoint_number === num);
    return t && (t.subject || t.body || t.body_html);
  };

  // Helper: get the running job for a touchpoint (if any)
  const getActiveJob = (tpNum: number) => activeJobs.find((j) => j.touchpoint_number === tpNum);

  // Poll for active send jobs
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/send/progress/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        const running = (data.jobs as ActiveJob[]).filter((j) => j.status === "running" || j.status === "pending");
        setActiveJobs(running);
      }
    } catch { /* */ }
  }, []);

  useEffect(() => {
    fetchJobs();
    jobPollingRef.current = setInterval(fetchJobs, 2000);
    return () => { if (jobPollingRef.current) clearInterval(jobPollingRef.current); };
  }, [fetchJobs]);

  // Stop polling when no active jobs, resume when there are
  useEffect(() => {
    if (activeJobs.length === 0 && jobPollingRef.current) {
      clearInterval(jobPollingRef.current);
      jobPollingRef.current = null;
    } else if (activeJobs.length > 0 && !jobPollingRef.current) {
      jobPollingRef.current = setInterval(fetchJobs, 2000);
    }
  }, [activeJobs, fetchJobs]);

  async function cancelJob(jobId: number) {
    try {
      await fetch(`${API}/send/cancel/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
        credentials: "include",
      });
      fetchJobs();
    } catch { /* */ }
  }

  // Refetch just the touchpoint content list (used after board actions)
  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${API}/email-templates/?${cq}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setTemplates(data.templates);
    } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cq]);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/email-templates/?${cq}`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/email-templates/get-schedules/?${cq}`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/email-templates/test-emails/`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/contacts/`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/templates-library/`, { credentials: "include" }).then((r) => r.json()),
    ])
      .then(([tplData, schedData, testEmailData, contactData, libData]) => {
        if (tplData.ok) {
          setTemplates(tplData.templates);
          setSavedTPs(new Set(tplData.templates.map((t: Template) => t.touchpoint_number)));
        }
        if (schedData.ok) {
          setSchedules(schedData.schedules);
          if (schedData.limits) setLimits(schedData.limits);
        }
        if (testEmailData.ok && Array.isArray(testEmailData.emails)) {
          // Backend returns a list of email strings; keep only valid ones.
          setTestEmails(testEmailData.emails.filter((e: unknown): e is string => typeof e === "string" && e.length > 0));
        }
        if (contactData.ok) {
          if (contactData.import_groups) setImportGroups(contactData.import_groups);
          if (contactData.segments) setSegments(contactData.segments);
        }
        if (libData?.ok && Array.isArray(libData.templates)) setLibraryTemplates(libData.templates);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cq]);

  useEffect(() => {
    setPendingFile(null);
    setClearAttach(false);
    setPendingSigImg(null);
    setClearSigImg(false);
    setSigPreviewUrl("");
    setSaveStatus(null);
    setTestResult(null);
    setDirty(false);
    if (attachInputRef.current) attachInputRef.current.value = "";
    if (sigInputRef.current) sigInputRef.current.value = "";
  }, [activeTP]);

  // True when the current touchpoint has unsaved edits or was never saved
  const needsSave = activeTP != null && (dirty || !savedTPs.has(activeTP));

  // Fetch how many contacts are eligible for the touchpoint being sent (respects audience).
  useEffect(() => {
    if (showBulkSend === null) { setBulkEligible(null); return; }
    const params = new URLSearchParams({ touchpoint_number: String(showBulkSend) });
    if (bulkGroupId) params.set("import_group_id", bulkGroupId);
    if (bulkSegmentIds[0]) params.set("segment_id", bulkSegmentIds[0]);
    setBulkEligible(null);
    let cancelled = false;
    fetch(`${API}/send/eligible-count/?${params}&${cq}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.ok) setBulkEligible(d.eligible); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showBulkSend, bulkGroupId, bulkSegmentIds]);

  // The editor opens as a Beacon-style modal (7xl) over the board — not a separate page.
  function openEditor(n: number) {
    setActiveTP(n);
    setStartFromTemplate("");
    setAlsoSaveName("");
    setSaveStatus(null);
    // Don't carry pending uploads from a previously edited email
    setPendingFile(null);
    setClearAttach(false);
    setPendingSigImg(null);
    setClearSigImg(false);
    setSigPreviewUrl("");
    if (attachInputRef.current) attachInputRef.current.value = "";
    if (sigInputRef.current) sigInputRef.current.value = "";
  }

  function closeEditor() {
    setActiveTP(null);
    setDirty(false); // discarded edits shouldn't linger as "unsaved changes"
  }

  function openLibrary() {
    router.push("/template-library");
  }

  // The board's stat pills link through to this campaign's analytics
  function openCampaignReport() {
    router.push(campaignId ? `/reporting?campaign_id=${campaignId}` : "/reporting");
  }

  async function handleBulkSend(tpNum: number) {
    setBulkSending(true);
    setBulkResult(null);
    try {
      const res = await fetch(`${API}/send/start/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touchpoint_number: tpNum,
          campaign_id: campaignId || undefined,
          ...(bulkGroupId ? { import_group_id: Number(bulkGroupId) } : {}),
          ...(bulkSegmentIds.length ? { segment_ids: bulkSegmentIds.map(Number) } : {}),
          ...(bulkTemplateId ? { template_id: Number(bulkTemplateId) } : {}),
          ...(bulkLimit && Number(bulkLimit) > 0 ? { limit: Number(bulkLimit) } : {}),
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setBulkResult(`Sending started — ${data.total_recipients} recipients`);
        setTimeout(() => { setBulkResult(null); setShowBulkSend(null); }, 3000);
        fetchJobs();
        if (!jobPollingRef.current) {
          jobPollingRef.current = setInterval(fetchJobs, 2000);
        }
      } else {
        setBulkResult(data.error || "Failed to start send");
      }
    } catch {
      setBulkResult("Network error");
    }
    setBulkSending(false);
  }

  // Insert a merge variable into the email body at the caret (or at the end when
  // the editor isn't focused) — mirrors Beacon's beaconInsertVar.
  function insertVar(v: string) {
    const editor = richBodyRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand("insertText", false, v);
    updateCurrent("body_html", editor.innerHTML);
  }



  function updateCurrent(field: keyof Template, value: string | number) {
    if (!activeTP) return;
    setDirty(true);
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.touchpoint_number === activeTP);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], [field]: value };
        return updated;
      }
      return [...prev, { touchpoint_number: activeTP, ...EMPTY_TEMPLATE, [field]: value }];
    });
  }

  // "Start from a saved template" — fill the email fields from the shared library, then tweak.
  function applyStartTemplate(id: string) {
    setStartFromTemplate(id);
    if (!id || !activeTP) return;
    const t = libraryTemplates.find((lt) => String(lt.id) === id);
    if (!t) return;
    setDirty(true);
    setTemplates((prev) => {
      const fill = {
        subject: t.subject ?? "",
        body_html: t.body_html ?? "",
        body: t.body ?? "",
        signature: t.signature ?? "",
        opt_out_text: t.opt_out_text ?? "",
      };
      const idx = prev.findIndex((tp) => tp.touchpoint_number === activeTP);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...fill };
        return updated;
      }
      return [...prev, { touchpoint_number: activeTP, ...EMPTY_TEMPLATE, ...fill }];
    });
  }

  // Sync the drag-corner resize box in the preview back to the height/width sliders
  function syncSigResize() {
    const el = sigResizeRef.current;
    if (!el || !canEdit) return;
    const h = Math.max(0, Math.min(240, Math.round(el.offsetHeight)));
    const w = Math.max(0, Math.min(480, Math.round(el.offsetWidth)));
    if (h !== (current?.signature_image_height ?? 90)) updateCurrent("signature_image_height", h);
    if (w !== (current?.signature_image_width ?? 0)) updateCurrent("signature_image_width", w);
  }

  async function saveTemplate(): Promise<boolean> {
    if (!activeTP || !current) return false;
    let saved = false;
    setSaving(true);
    setSaveStatus(null);

    const fd = new FormData();
    fd.append("touchpoint_number", String(activeTP));
    if (campaignId) fd.append("campaign_id", campaignId);
    fd.append("subject", current.subject);
    fd.append("body", current.body);
    fd.append("body_html", current.body_html);
    fd.append("signature", current.signature);
    fd.append("opt_out_text", current.opt_out_text ?? "");
    fd.append("days_after_previous", String(current.days_after_previous));
    fd.append("signature_image_height", String(current.signature_image_height ?? 90));
    fd.append("signature_image_width", String(current.signature_image_width ?? 0));
    if (pendingFile) fd.append("attachment", pendingFile);
    if (clearAttach) fd.append("clear_attachment", "1");
    if (pendingSigImg) fd.append("signature_image", pendingSigImg);
    if (clearSigImg) fd.append("clear_signature_image", "1");

    try {
      const res = await fetch(`${API}/email-templates/save/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setTemplates((prev) => {
          const idx = prev.findIndex((t) => t.touchpoint_number === activeTP);
          const updated: Template = {
            ...current,
            body_html: data.body_html || current.body_html,
            attachment_name: data.attachment_name || "",
            attachment_url: data.attachment_url || "",
            signature_image_name: data.signature_image_name || "",
            signature_image_url: data.signature_image_url || "",
          };
          if (idx >= 0) {
            const list = [...prev];
            list[idx] = updated;
            return list;
          }
          return [...prev, updated];
        });
        setPendingFile(null);
        setClearAttach(false);
        setPendingSigImg(null);
        setClearSigImg(false);
        setSigPreviewUrl("");
        if (attachInputRef.current) attachInputRef.current.value = "";
        if (sigInputRef.current) sigInputRef.current.value = "";
        setSavedTPs((prev) => new Set(prev).add(activeTP));
        setDirty(false);
        saved = true;
        fetchBoard();
        const savedLabel = activeTP >= GOODBYE_OFFSET ? "Goodbye email saved" : "Touchpoint saved";
        let savedMsg = savedLabel;
        // "Also save this as a reusable template" — same library the other emails use
        if (alsoSaveName.trim()) {
          try {
            const tfd = new FormData();
            tfd.append("name", alsoSaveName.trim());
            tfd.append("subject", current.subject);
            tfd.append("body", current.body);
            tfd.append("body_html", current.body_html);
            tfd.append("signature", current.signature);
            tfd.append("opt_out_text", current.opt_out_text ?? "");
            const tRes = await fetch(`${API}/templates-library/save/`, { method: "POST", body: tfd, credentials: "include" });
            const tData = await tRes.json();
            if (tData.ok) {
              savedMsg = `${savedLabel}. Also saved as template "${alsoSaveName.trim()}".`;
              setAlsoSaveName("");
              const libRes = await fetch(`${API}/templates-library/`, { credentials: "include" });
              const libData = await libRes.json();
              if (libData?.ok && Array.isArray(libData.templates)) setLibraryTemplates(libData.templates);
            }
          } catch { /* touchpoint itself saved fine */ }
        }
        // Beacon behaviour: the modal closes on save and a notification appears
        notifyBoard(savedMsg);
        closeEditor();
      } else {
        setSaveStatus({ text: data.error || "Error saving!", ok: false });
      }
    } catch {
      setSaveStatus({ text: "Error saving!", ok: false });
    }
    setSaving(false);
    setTimeout(() => setSaveStatus(null), 3000);
    return saved;
  }

  const [pendingSend, setPendingSend] = useState<null | "test" | "bulk">(null);

  // Open the bulk-send modal, but prompt to save first if there are unsaved changes
  function openBulkSend(force = false) {
    if (!force && needsSave) { setPendingSend("bulk"); setShowSavePrompt(true); return; }
    setShowBulkSend(activeTP);
    setBulkResult(null); setBulkGroupId(""); setBulkSegmentIds([]); setBulkTemplateId(""); setBulkLimit("");
  }

  async function saveThenContinue() {
    const ok = await saveTemplate();
    if (!ok) return;
    setShowSavePrompt(false);
    const action = pendingSend;
    setPendingSend(null);
    if (action === "test") sendTestEmail(true);
    else if (action === "bulk") openBulkSend(true);
  }

  function addTestEmail() {
    const raw = testEmailInput.trim();
    if (!raw) return;
    const newEmails = raw.split(",").map((e) => e.trim()).filter((e) => e && e.includes("@"));
    if (newEmails.length === 0) return;
    const toAdd = newEmails.filter((e) => !testEmails.includes(e));
    if (toAdd.length === 0) { setTestEmailInput(""); return; }
    setTestEmails((prev) => [...prev, ...toAdd]);
    setTestEmailInput("");
    for (const email of toAdd) {
      fetch(`${API}/email-templates/test-emails/save/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", email }),
        credentials: "include",
      }).catch(() => {});
    }
  }

  function removeTestEmail(email: string) {
    setTestEmails((prev) => prev.filter((e) => e !== email));
    fetch(`${API}/email-templates/test-emails/save/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", email }),
      credentials: "include",
    }).catch(() => {});
  }

  async function sendTestEmail(force = false) {
    if (testEmails.length === 0) return;
    if (!force && needsSave) { setPendingSend("test"); setShowSavePrompt(true); return; }

    setTestSending(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API}/email-templates/send-test/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint_number: activeTP, recipients: testEmails, campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        const ok = data.results.filter((r: { ok: boolean }) => r.ok);
        setTestResult(`Sent to ${ok.length}/${data.results.length} recipients.`);
      } else {
        setTestResult(data.error || "Unknown error");
      }
    } catch {
      setTestResult("Network error");
    }
    setTestSending(false);
  }

  async function setSchedule(tpNum: number) {
    const dateEl = document.getElementById(`schedDate${tpNum}`) as HTMLInputElement;
    const limitEl = document.getElementById(`schedLimit${tpNum}`) as HTMLInputElement;
    const dateVal = dateEl?.value;
    if (!dateVal) return;
    setSchedError(null);
    try {
      const limitVal = limitEl?.value ? parseInt(limitEl.value, 10) : 0;
      const res = await fetch(`${API}/email-templates/set-schedule/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touchpoint_number: tpNum,
          scheduled_date: dateVal,
          daily_send_limit: limitVal,
          campaign_id: campaignId || undefined,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setSchedules((prev) => ({ ...prev, [String(tpNum)]: data.date }));
        if (data.daily_send_limit > 0) {
          setLimits((prev) => ({ ...prev, [String(tpNum)]: data.daily_send_limit }));
        } else {
          setLimits((prev) => { const next = { ...prev }; delete next[String(tpNum)]; return next; });
        }
      } else {
        setSchedError(data.error || "Failed to set schedule");
        setTimeout(() => setSchedError(null), 4000);
      }
    } catch { /* ignore */ }
  }

  async function clearSchedule(tpNum: number) {
    try {
      const res = await fetch(`${API}/email-templates/set-schedule/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint_number: tpNum, scheduled_date: "", campaign_id: campaignId || undefined }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setSchedules((prev) => {
          const next = { ...prev };
          delete next[String(tpNum)];
          return next;
        });
        setLimits((prev) => {
          const next = { ...prev };
          delete next[String(tpNum)];
          return next;
        });
      }
    } catch { /* ignore */ }
  }

  const showingAttachment = !clearAttach && (pendingFile || (current?.attachment_name ?? ""));
  const showingSigImg = !clearSigImg && (pendingSigImg || (current?.signature_image_name ?? ""));
  // Preview box dimensions — mirror the backend's signature-image sizing (both 0 → 90px height)
  const sigPrevH0 = Math.max(0, Math.min(240, current?.signature_image_height ?? 90));
  const sigPrevW = Math.max(0, Math.min(480, current?.signature_image_width ?? 0));
  const sigPrevH = sigPrevH0 === 0 && sigPrevW === 0 ? 90 : sigPrevH0;

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-[13px] text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />

      {/* ── Main area ── */}
      <MainContent>
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div>
              {view !== "schedules" && (
                <p className="text-[11px] text-gray-400">
                  <Link href="/campaign-groups" className="hover:text-[#054B70] hover:underline">Campaigns &amp; Flows</Link>
                  <span className="mx-1">›</span>
                  {campaignName || "Campaign"}
                </p>
              )}
              <h1 className="text-[16px] font-bold text-gray-900">
                {view === "schedules" ? "Touchpoint Schedules" : (campaignName || "Campaign")}
              </h1>
              <p className="text-[11px] text-gray-500">
                {view === "schedules"
                  ? "Set send dates for touchpoints 2–10"
                  : "The journey: emails and the waits between them."}
              </p>
              {view === "dashboard" && campaignId && (
                <p
                  className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-[#054B70]"
                  title="The campaign's default audience — set under Edit Campaign; you can still pick a different audience on any send or schedule."
                >
                  <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                  </svg>
                  <span className="truncate">Sends to: {campaignAudience || "all active contacts"}</span>
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {canEdit && view === "dashboard" && (
              <>
                {board.length > 0 && (
                  <button
                    onClick={() => {
                      const first = board.find((b) => b.has_content)?.touchpoint_number || board[0].touchpoint_number;
                      setShowBulkSend(first); setBulkResult(null); setBulkGroupId(""); setBulkSegmentIds([]); setBulkTemplateId(""); setBulkLimit("");
                    }}
                    className="btn-press flex items-center gap-2 rounded-lg bg-green-600 px-3 py-2.5 text-[12px] font-bold text-white transition-colors hover:bg-green-700 sm:px-4"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" /></svg>
                    <span className="hidden md:inline">Start campaign flow</span>
                    <span className="md:hidden">Start</span>
                  </button>
                )}
                {board.length > 0 && (
                  <button
                    onClick={openScheduleFlow}
                    title="Pick a launch date & time — touchpoint 1 goes out then, the rest follow their waits"
                    className="btn-press flex items-center gap-2 rounded-lg bg-white px-3 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50 sm:px-4"
                  >
                    <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
                    <span className="hidden md:inline">Schedule</span>
                    <span className="md:hidden">Schedule</span>
                  </button>
                )}
                <button
                  onClick={openAddTouchpoint}
                  className="btn-press flex items-center gap-2 rounded-lg bg-[#054B70] px-3 py-2.5 text-[12px] font-bold text-white sm:px-4"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
                  <span className="hidden md:inline">Add touchpoint</span>
                  <span className="md:hidden">Add</span>
                </button>
                <button
                  onClick={() => { setShowUseTemplate(true); setUseTemplateId(""); fetchFlowTemplates(); }}
                  className="btn-press hidden items-center gap-2 rounded-lg bg-white px-3 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50 md:flex sm:px-4"
                >
                  <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path d="M16.5 3.75V16.5L12 14.25 7.5 16.5V3.75m9 0H18A2.25 2.25 0 0120.25 6v12A2.25 2.25 0 0118 20.25H6A2.25 2.25 0 013.75 18V6A2.25 2.25 0 016 3.75h1.5m9 0h-9" /></svg>
                  Use template
                </button>
                <button
                  onClick={() => { setShowSaveTemplate(true); setFlowName(""); }}
                  className="btn-press hidden items-center gap-2 rounded-lg bg-white px-3 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50 md:flex sm:px-4"
                >
                  <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" /></svg>
                  Save as template
                </button>
              </>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="p-4 sm:p-8">
          {view === "dashboard" ? (
            <div className="animate-fade-in">
              <AnimatePresence>
                {boardToast && (
                  <motion.div
                    initial={{ opacity: 0, y: -12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={SPRING}
                    className="mx-auto mb-4 flex max-w-[640px] items-center gap-2 rounded-lg bg-white px-4 py-3 text-[13px] font-semibold text-gray-900 shadow-lg ring-1 ring-gray-950/5"
                  >
                    <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
                    {boardToast}
                  </motion.div>
                )}
              </AnimatePresence>
              {!loaded || !boardLoaded ? (
                <div className="mx-auto max-w-[640px] space-y-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={`h-[110px] rounded-lg bg-white shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up stagger-${i + 1}`}>
                      <div className="h-full rounded-lg bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                    </div>
                  ))}
                </div>
              ) : board.length === 0 ? (
                /* Beacon's empty state: the campaign has no touchpoints yet */
                <div className="mx-auto max-w-[640px] rounded-[13px] border border-dashed border-gray-400/40 px-4 py-10 text-center">
                  <p className="mb-1 text-[15px] font-semibold text-gray-500">No touchpoints yet</p>
                  <p className="text-[13px] text-gray-400">Use &quot;Add touchpoint&quot; above to start building this campaign&apos;s sequence.</p>
                </div>
              ) : (
                /* The sequence, top to bottom: touchpoint → wait → touchpoint → … (Beacon board) */
                <div className="mx-auto flex w-full max-w-[640px] flex-col items-center">
                  {board.map((bt, idx) => {
                    const n = bt.touchpoint_number;
                    const next = board[idx + 1];
                    const configured = bt.has_content;
                    const job = getActiveJob(n);
                    const jobProcessed = job ? job.sent_count + job.failed_count + job.skipped_count : 0;
                    const jobPct = job && job.total_recipients > 0 ? Math.round((jobProcessed / job.total_recipients) * 100) : 0;

                    const hasBounces = bt.bounces_soft + bt.bounces_hard > 0;
                    return (
                      <motion.div
                        key={n}
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ ...SPRING, delay: idx * 0.045 }}
                        className="flex w-full flex-col items-center"
                      >
                        {/* wait connector: line — wait pill (+ remove) — line */}
                        {idx > 0 && (
                          <>
                            <div className="h-[14px] w-[2px] bg-gray-400/40" />
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => { if (canEdit) openWaitEditor(bt); }}
                                title="Click to change the wait"
                                className="inline-flex items-center gap-2 rounded-lg border border-gray-400/40 bg-white px-4 py-1.5 text-[12px] font-semibold text-gray-900"
                                style={{ cursor: canEdit ? "pointer" : "default" }}
                              >
                                <svg className="h-[14px] w-[14px] text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                {bt.scheduled_date
                                  ? `Sends on ${bt.scheduled_date}${bt.send_time ? ` at ${bt.send_time}` : ""}`
                                  : bt.wait_minutes === 0
                                  ? "No wait — sends immediately"
                                  : `Wait ${bt.wait_label.toLowerCase()}${bt.send_time ? `, then at ${bt.send_time}` : ""}`}
                              </button>
                              {bt.wait_minutes > 0 && canEdit && (
                                <button
                                  type="button"
                                  onClick={() => removeWait(n)}
                                  title="Remove the wait — send immediately after the previous touchpoint"
                                  className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-400/40 text-[11px] font-bold text-gray-400 hover:text-gray-600"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                            <div className="h-[14px] w-[2px] bg-gray-400/40" />
                          </>
                        )}

                        {/* Touchpoint tile */}
                        <motion.div
                          whileHover={{ y: -2, boxShadow: "0 6px 18px -6px rgba(3, 7, 18, 0.12)" }}
                          transition={SPRING}
                          className="w-full rounded-[11px] border border-gray-400/25 bg-white px-4 py-3"
                        >
                          <div className="flex items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/10 text-[14px] font-extrabold text-blue-700">
                              {n}
                            </span>
                            {renameTp === n && activeTP === null ? (
                              <div className="min-w-0 flex-1">
                                <input
                                  autoFocus
                                  value={renameVal}
                                  onChange={(e) => setRenameVal(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenameTp(null); }}
                                  onBlur={saveRename}
                                  placeholder={`Touchpoint ${n}`}
                                  maxLength={200}
                                  className="w-full rounded-md bg-gray-50 px-2 py-1 text-[14px] font-bold text-gray-950 outline-none ring-2 ring-[#054B70]"
                                />
                                <span className="block truncate text-[11px] text-gray-500">Enter to save · Esc to cancel · empty goes back to Touchpoint {n}</span>
                              </div>
                            ) : (
                              <button type="button" onClick={() => openEditor(n)} className="group min-w-0 flex-1 text-left">
                                <span className="flex items-center gap-1.5 text-[14px] font-bold text-gray-950">
                                  <span className="truncate">{bt.name || `Touchpoint ${n}`}</span>
                                  {canEdit && (
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      title="Rename — use your own name for this touchpoint"
                                      onClick={(e) => { e.stopPropagation(); startRename(n, bt.name || ""); }}
                                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); startRename(n, bt.name || ""); } }}
                                      className="shrink-0 rounded p-0.5 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"
                                    >
                                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                                      </svg>
                                    </span>
                                  )}
                                </span>
                                <span className="block truncate text-[12px] text-gray-500">
                                  {bt.subject || "No subject yet — click to edit"}
                                </span>
                              </button>
                            )}
                            {(renameTp !== n || activeTP !== null) && (configured ? (
                              <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold text-green-700">Ready</span>
                            ) : (
                              <span className="shrink-0 rounded-full bg-gray-400/15 px-2 py-0.5 text-[10px] font-semibold text-gray-500">Empty</span>
                            ))}
                            {(renameTp !== n || activeTP !== null) && canEdit && (
                              <div className="flex shrink-0 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openEditor(n)}
                                  className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { setTestFor({ label: `touchpoint ${n}`, number: n }); setTestAddr(""); }}
                                  title="Send a [TEST] of this email to addresses of your choice — real sending happens in order via Start flow"
                                  className="rounded-md border border-gray-400/40 px-2.5 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
                                >
                                  Test
                                </button>
                                {job ? (
                                  <button
                                    type="button"
                                    onClick={() => cancelJob(job.id)}
                                    title="Stop this send"
                                    className="rounded-md border border-red-500/40 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50"
                                  >
                                    Stop
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setDelTp(n)}
                                    title="Delete this touchpoint"
                                    className="rounded-md border border-red-500/40 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Second row: plain-language journey stats (zeros stay quiet) */}
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[2.7rem]">
                            {bt.received === 0 ? (
                              <span className="rounded-full bg-gray-400/10 px-2 py-0.5 text-[10px] font-semibold text-gray-500">
                                Not sent to anyone yet
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={openCampaignReport}
                                title="How many of this campaign's audience have received this email so far. Click to open this campaign's report."
                                className="rounded-full bg-blue-600/10 px-2 py-0.5 text-[10px] font-semibold text-blue-700 transition-colors hover:bg-blue-600/20 hover:underline"
                              >
                                {bt.received} of {bt.audience} got this email
                              </button>
                            )}
                            {hasBounces && (
                              <button
                                type="button"
                                onClick={openCampaignReport}
                                title={`${bt.bounces_soft} temporary (soft — mailbox full or timeout, worth retrying) · ${bt.bounces_hard} permanent (hard — the address doesn't exist, we stop sending). Click to open this campaign's report.`}
                                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors hover:underline ${
                                  bt.bounces_hard > 0 ? "bg-red-500/15 text-red-700 hover:bg-red-500/25" : "bg-yellow-500/20 text-yellow-700 hover:bg-yellow-500/30"
                                }`}
                              >
                                {bt.bounces_soft + bt.bounces_hard} couldn&apos;t be delivered
                              </button>
                            )}
                            {bt.optouts > 0 && (
                              <button
                                type="button"
                                onClick={openCampaignReport}
                                title="People who unsubscribed right after this email — the goodbye branch on the right is what they receive. Click to open this campaign's report."
                                className="rounded-full bg-purple-600/10 px-2 py-0.5 text-[10px] font-semibold text-purple-700 transition-colors hover:bg-purple-600/20 hover:underline"
                              >
                                {bt.optouts} unsubscribed after this
                              </button>
                            )}
                            {schedules[String(n)] && (
                              <span className="rounded-full bg-blue-600/10 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                                Scheduled {schedules[String(n)]}
                              </span>
                            )}
                            {job && (
                              <span className="rounded-full bg-blue-600/10 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                                Sending — {jobProcessed}/{job.total_recipients} ({jobPct}%)
                              </span>
                            )}
                          </div>
                        </motion.div>

                        {/* Mailchimp-style split: trunk continues (left), goodbye branch (right) */}
                        <div className="flex w-full max-w-[640px] items-stretch">
                          {/* Left lane: "stayed subscribed" — the trunk continues down. */}
                          <div className="flex basis-1/2 flex-col items-end">
                            <div className="mb-0.5 mr-2.5 mt-1.5 flex items-center gap-1.5">
                              <span className="whitespace-nowrap rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-700">
                                Stayed · continues
                              </span>
                            </div>
                            <div className="min-h-[1.8rem] w-[2px] flex-1 bg-gray-400/40" />
                          </div>
                          {/* Right lane: "opted out" — branches to the goodbye email. */}
                          <div className="flex basis-1/2 items-start pt-4">
                            <div className="mt-4 h-[2px] w-[22px] shrink-0 bg-amber-500/60" />
                            <div className="min-w-0 flex-1">
                              {bt.goodbye ? (
                                <div className="rounded-[11px] border-[1.5px] border-amber-500/50 bg-amber-500/[0.07] px-4 py-3">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={openCampaignReport}
                                      title="How many contacts opted out after this touchpoint — they received (or will receive) this goodbye email. Click to open this campaign's report."
                                      className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 transition-colors hover:bg-amber-500/25 hover:underline"
                                    >
                                      Opted out{bt.optouts > 0 ? ` · ${bt.optouts}` : ""}
                                    </button>
                                    {renameTp === bt.goodbye.test_number && activeTP === null ? (
                                      <input
                                        autoFocus
                                        value={renameVal}
                                        onChange={(e) => setRenameVal(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenameTp(null); }}
                                        onBlur={saveRename}
                                        placeholder="Goodbye email"
                                        maxLength={200}
                                        className="min-w-0 flex-1 rounded-md bg-white px-2 py-1 text-[14px] font-bold text-gray-950 outline-none ring-2 ring-[#054B70]"
                                      />
                                    ) : (
                                      <>
                                        <span className="flex min-w-0 items-center gap-1.5 text-[14px] font-bold text-gray-950">
                                          <span className="truncate">{bt.goodbye.name || "Goodbye email"}</span>
                                          {canEdit && (
                                            <button
                                              type="button"
                                              title="Rename — use your own name for this goodbye email"
                                              onClick={() => startRename(bt.goodbye!.test_number, bt.goodbye!.name || "")}
                                              className="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:bg-amber-500/10 hover:text-gray-600"
                                            >
                                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                                              </svg>
                                            </button>
                                          )}
                                        </span>
                                        {bt.goodbye.has_content ? (
                                          <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold text-green-700">Ready</span>
                                        ) : (
                                          <span className="rounded-full bg-gray-400/15 px-2 py-0.5 text-[10px] font-semibold text-gray-500">Empty</span>
                                        )}
                                      </>
                                    )}
                                  </div>
                                  <p className="my-1.5 truncate text-[12px] text-gray-500">{bt.goodbye.subject || "No subject yet"}</p>
                                  {canEdit && (
                                    <div className="flex gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => openGoodbye(n)}
                                        className="rounded-md bg-amber-700 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-800"
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => { setTestFor({ label: "the goodbye email", number: bt.goodbye!.test_number }); setTestAddr(""); }}
                                        className="rounded-md border border-gray-400/40 px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50"
                                      >
                                        Test
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setRmGoodbyeFor(n)}
                                        className="rounded-md border border-red-500/40 px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-red-50"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ) : canEdit ? (
                                <button
                                  type="button"
                                  onClick={() => { setAddGbFor(n); setAddGbTemplateId(""); setGbFrom("fresh"); }}
                                  className="block w-full rounded-[11px] border-[1.5px] border-dashed border-amber-500/50 bg-amber-500/[0.03] px-4 py-3.5 text-left text-[13px] font-bold text-amber-700 hover:bg-amber-500/[0.08]"
                                >
                                  + Add an opt-out goodbye email
                                </button>
                              ) : (
                                <div className="rounded-[11px] border-[1.5px] border-dashed border-gray-300 px-4 py-3.5 text-[12px] text-gray-400">
                                  No goodbye email
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}

                  {/* Bottom of the sequence: add the next email */}
                  {canEdit && (
                    <>
                      <div className="h-[14px] w-[2px] bg-gray-400/40" />
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.98 }}
                        onClick={openAddTouchpoint}
                        className="w-full rounded-[11px] border-[1.5px] border-dashed border-gray-400/40 px-4 py-2.5 text-[13px] font-semibold text-gray-500 transition-colors hover:border-gray-400/60 hover:text-gray-700"
                      >
                        + Add touchpoint
                      </motion.button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : null}

          {/* Touchpoint / goodbye email editor — Beacon-style 7xl modal over the board */}
          {activeTP !== null && current ? (
            <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30 p-4 backdrop-blur-sm animate-fade-in" onClick={closeEditor}>
              <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={SPRING}
                className="mx-auto my-4 w-full max-w-[80rem] rounded-xl bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Modal heading */}
                <div className="relative border-b border-gray-950/5 px-6 py-4 pr-14">
                  <button
                    type="button"
                    title="Close"
                    aria-label="Close"
                    onClick={closeEditor}
                    className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                  </button>
                  {activeTP >= GOODBYE_OFFSET ? (
                    <>
                      {renameTp === activeTP ? (
                        <input
                          autoFocus
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenameTp(null); }}
                          onBlur={saveRename}
                          placeholder="Goodbye email"
                          maxLength={200}
                          className="w-full max-w-md rounded-md bg-gray-50 px-2 py-1 text-[16px] font-bold text-gray-950 outline-none ring-2 ring-[#054B70]"
                        />
                      ) : (
                        <h2 className="flex items-center gap-2 text-[16px] font-bold text-gray-950">
                          <span className="truncate">
                            {board.find((b) => b.goodbye?.test_number === activeTP)?.goodbye?.name || `Goodbye email — if they opt out after Touchpoint ${activeTP - GOODBYE_OFFSET}`}
                          </span>
                          {canEdit && board.some((b) => b.goodbye?.test_number === activeTP) && (
                            <button
                              type="button"
                              title="Rename — use your own name for this goodbye email"
                              onClick={() => startRename(activeTP, board.find((b) => b.goodbye?.test_number === activeTP)?.goodbye?.name || "")}
                              className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                              </svg>
                            </button>
                          )}
                        </h2>
                      )}
                      <p className="mt-0.5 text-[12px] text-gray-500">Sent once, automatically, when someone opts out right after this touchpoint. Leave the opt-out sentence blank — they have already opted out.</p>
                    </>
                  ) : renameTp === activeTP ? (
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenameTp(null); }}
                      onBlur={saveRename}
                      placeholder={`Touchpoint ${activeTP}`}
                      maxLength={200}
                      className="w-full max-w-md rounded-md bg-gray-50 px-2 py-1 text-[16px] font-bold text-gray-950 outline-none ring-2 ring-[#054B70]"
                    />
                  ) : (
                    <h2 className="flex items-center gap-2 text-[16px] font-bold text-gray-950">
                      <span className="truncate">{board.find((b) => b.touchpoint_number === activeTP)?.name || `Touchpoint ${activeTP}`}</span>
                      {canEdit && (
                        <button
                          type="button"
                          title="Rename — use your own name instead of Touchpoint N"
                          onClick={() => startRename(activeTP, board.find((b) => b.touchpoint_number === activeTP)?.name || "")}
                          className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                          </svg>
                        </button>
                      )}
                    </h2>
                  )}
                </div>

                <div className="p-6">
              {/* Save status toast */}
              {saveStatus && (
                <div className={`mb-5 flex items-center gap-2 rounded-lg px-4 py-3 text-[13px] font-semibold animate-slide-in ${
                  saveStatus.ok ? "bg-[#054B70]/5 text-[#054B70]" : "bg-red-50 text-red-600"
                }`}>
                  {saveStatus.ok ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                  {saveStatus.text}
                </div>
              )}

              {/* Start from a saved template (optional) — same library the normal emails use */}
              <div className="mb-5 rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up" style={{ animationDelay: "0.05s" }}>
                <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Start from a saved template (optional)</label>
                <Select
                  value={startFromTemplate}
                  onChange={applyStartTemplate}
                  options={libraryTemplates.map((t) => ({ value: String(t.id), label: t.name }))}
                  placeholder="Select an option"
                  disabled={!canEdit}
                  searchable
                  className="max-w-md"
                />
                <p className="mt-1.5 text-[12px] text-gray-500">Any saved template can be used here — the same library your normal emails use. Pick one to fill the email below, then tweak it.</p>
              </div>

              {/* Beacon editor: Grid(3) — Section "Email" (2/3) + Section "Live preview" (1/3) */}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                {/* Section: Email */}
                <div className="xl:col-span-2">
                  <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up" style={{ animationDelay: "0.08s" }}>
                    <div className="border-b border-gray-950/5 px-6 py-4">
                      <h3 className="text-[15px] font-semibold text-gray-950">Email</h3>
                    </div>
                    <div className="space-y-5 p-6">
                  {/* Subject */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">
                      Subject<sup className="font-medium text-red-600">*</sup>
                    </label>
                    <input
                      type="text"
                      value={current.subject}
                      onChange={(e) => updateCurrent("subject", e.target.value)}
                      readOnly={!canEdit}
                      maxLength={500}
                      className={`input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                  </div>

                  {/* Email body — rich editor with Beacon's exact toolbar */}
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-gray-950">Email body</label>
                    <p className="mb-1.5 text-[12px] text-gray-500">
                      Normal text and HTML both work here — type and style with the toolbar, or paste a ready-made HTML email straight in. The live preview shows exactly how it lands.
                    </p>
                    <RichTextEditor
                      value={current.body_html}
                      onChange={(html) => updateCurrent("body_html", html)}
                      readOnly={!canEdit}
                      editorRef={richBodyRef}
                    />
                  </div>

                  {/* Merge-variable pills — "Insert into the email:" */}
                  <div className="-mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-gray-500">Insert into the email:</span>
                    {VARIABLES.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => insertVar(v.key)}
                        title="Click to insert — it fills in per contact when sending"
                        className="rounded-full border border-gray-400/40 bg-transparent px-2.5 py-1 text-[12px] font-semibold text-gray-700 transition-colors hover:bg-gray-100"
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>

                  {/* Plain-text fallback */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Plain-text fallback</label>
                    <textarea
                      ref={bodyRef}
                      value={current.body}
                      onChange={(e) => updateCurrent("body", e.target.value)}
                      readOnly={!canEdit}
                      rows={3}
                      className={`input-glow w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-900 placeholder-gray-400 outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                    <p className="mt-1.5 text-[12px] text-gray-500">Optional — a simple text version, used when an email program can&apos;t show the designed email above.</p>
                  </div>

                  {/* Signature */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Signature</label>
                    <textarea
                      value={current.signature ?? ""}
                      onChange={(e) => updateCurrent("signature", e.target.value)}
                      readOnly={!canEdit}
                      rows={3}
                      className={`input-glow w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-900 placeholder-gray-400 outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                  </div>

                  {/* Opt-out sentence */}
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Opt-out sentence</label>
                    <textarea
                      value={current.opt_out_text ?? ""}
                      onChange={(e) => updateCurrent("opt_out_text", e.target.value)}
                      readOnly={!canEdit}
                      placeholder={DEFAULT_OPT_OUT_TEXT}
                      rows={2}
                      className={`input-glow w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-[13px] text-gray-900 placeholder-gray-400 outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                  </div>

                  {/* Attachment + Signature image uploads */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Attachment</label>
                      {!showingAttachment ? (
                        <label
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const file = e.dataTransfer.files?.[0];
                            if (file && canEdit) { setPendingFile(file); setClearAttach(false); }
                          }}
                          className="flex cursor-pointer items-center justify-center rounded-xl border border-gray-300 bg-gray-50 px-4 py-7 text-[13px] text-gray-500 transition-colors hover:bg-gray-100"
                        >
                          <span>Drag &amp; Drop your files or <span className="font-semibold text-[#054B70]">Browse</span></span>
                          <input
                            ref={attachInputRef}
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                setPendingFile(file);
                                setClearAttach(false);
                              }
                            }}
                          />
                        </label>
                      ) : (
                        <div className="flex items-center gap-3 rounded-lg border border-[#054B70]/15 bg-[#054B70]/5 px-3 py-3 animate-scale-in">
                          <svg className="h-4 w-4 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <span className="flex-1 truncate text-[12px] font-medium text-gray-900">
                            {pendingFile?.name || current.attachment_name}
                          </span>
                          <button
                            onClick={() => {
                              setPendingFile(null);
                              setClearAttach(true);
                              if (attachInputRef.current) attachInputRef.current.value = "";
                            }}
                            className="rounded-full p-1.5 text-gray-500 transition-all hover:bg-red-50 hover:text-red-500"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                              <path d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Signature image</label>
                      {!showingSigImg ? (
                        <label
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const file = e.dataTransfer.files?.[0];
                            if (file && canEdit) {
                              setPendingSigImg(file);
                              setClearSigImg(false);
                              const reader = new FileReader();
                              reader.onload = (ev) => setSigPreviewUrl(ev.target?.result as string);
                              reader.readAsDataURL(file);
                            }
                          }}
                          className="flex cursor-pointer items-center justify-center rounded-xl border border-gray-300 bg-gray-50 px-4 py-7 text-[13px] text-gray-500 transition-colors hover:bg-gray-100"
                        >
                          <span>Drag &amp; Drop your files or <span className="font-semibold text-[#054B70]">Browse</span></span>
                          <input
                            ref={sigInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                setPendingSigImg(file);
                                setClearSigImg(false);
                                const reader = new FileReader();
                                reader.onload = (ev) => setSigPreviewUrl(ev.target?.result as string);
                                reader.readAsDataURL(file);
                              }
                            }}
                          />
                        </label>
                      ) : (
                        <div className="flex items-center gap-3 rounded-lg border border-[#054B70]/15 bg-[#054B70]/5 px-3 py-3 animate-scale-in">
                          {(sigPreviewUrl || current.signature_image_url) && (
                            <img src={sigPreviewUrl || `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}${current.signature_image_url}`} alt="Signature" className="h-10 w-auto rounded-lg border border-gray-300 bg-white object-contain" />
                          )}
                          <span className="flex-1 truncate text-[12px] font-medium text-gray-900">
                            {pendingSigImg?.name || current.signature_image_name}
                          </span>
                          <button
                            onClick={() => {
                              setPendingSigImg(null);
                              setClearSigImg(true);
                              setSigPreviewUrl("");
                              if (sigInputRef.current) sigInputRef.current.value = "";
                            }}
                            className="rounded-full p-1.5 text-gray-500 transition-all hover:bg-red-50 hover:text-red-500"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                              <path d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Signature image size sliders — visible only when an image is set */}
                  {showingSigImg && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Signature image height</label>
                        <input
                          type="range"
                          min={0}
                          max={240}
                          step={10}
                          value={current.signature_image_height ?? 90}
                          onChange={(e) => updateCurrent("signature_image_height", Number(e.target.value))}
                          disabled={!canEdit}
                          className="w-full accent-[#054B70]"
                        />
                        <p className="mt-1 text-[12px] text-gray-500">
                          Drag to resize — {(current.signature_image_height ?? 90) > 0 ? `${current.signature_image_height ?? 90}px` : "Auto (keeps proportions)"}
                        </p>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Signature image width</label>
                        <input
                          type="range"
                          min={0}
                          max={480}
                          step={10}
                          value={current.signature_image_width ?? 0}
                          onChange={(e) => updateCurrent("signature_image_width", Number(e.target.value))}
                          disabled={!canEdit}
                          className="w-full accent-[#054B70]"
                        />
                        <p className="mt-1 text-[12px] text-gray-500">
                          Drag to resize — {(current.signature_image_width ?? 0) > 0 ? `${current.signature_image_width}px` : "Auto (keeps proportions)"}
                        </p>
                      </div>
                    </div>
                  )}

                    </div>
                  </div>
                </div>

                {/* Section: Live preview */}
                <div>
                  <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up" style={{ animationDelay: "0.10s" }}>
                    <div className="border-b border-gray-950/5 px-6 py-4">
                      <h3 className="text-[15px] font-semibold text-gray-950">Live preview</h3>
                    </div>
                    <div className="p-6">
                      <div style={{ border: "1px solid rgba(120,120,120,.22)", borderRadius: ".6rem", overflow: "hidden" }}>
                        <div style={{ padding: ".6rem .9rem", borderBottom: "1px solid rgba(120,120,120,.2)", fontSize: ".8rem", color: "#6b7280" }}>
                          <strong>Subject:</strong>{" "}
                          {current.subject.trim() !== "" ? current.subject : <span style={{ color: "#9ca3af" }}>(no subject)</span>}
                        </div>
                        <div className="beacon-body-editor" style={{ padding: "1rem .9rem", background: "#fff", color: "#111827", lineHeight: 1.5 }}>
                          {current.body_html.replace(/<[^>]*>/g, "").trim() !== "" ? (
                            <div dangerouslySetInnerHTML={{ __html: current.body_html }} />
                          ) : (
                            <span style={{ color: "#9ca3af" }}>(no content yet — start typing on the left)</span>
                          )}
                          {(current.signature ?? "").trim() !== "" && (
                            <>
                              <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid rgba(120,120,120,.25)" }} />
                              <div style={{ whiteSpace: "pre-line" }}>{current.signature}</div>
                            </>
                          )}
                          {showingSigImg && (sigPreviewUrl || current.signature_image_url) && (
                            <div style={{ marginTop: ".6rem" }}>
                              {/* Drag the box's corner to resize — synced back to the sliders on release */}
                              <div
                                ref={sigResizeRef}
                                onMouseUp={syncSigResize}
                                style={{
                                  resize: canEdit ? ("both" as const) : ("none" as const),
                                  overflow: "hidden",
                                  display: "inline-block",
                                  border: "1px dashed rgba(120,120,120,.45)",
                                  borderRadius: 4,
                                  width: sigPrevW > 0 ? sigPrevW : "auto",
                                  height: sigPrevH > 0 ? sigPrevH : "auto",
                                  minWidth: 30,
                                  minHeight: 30,
                                  maxWidth: 480,
                                  maxHeight: 240,
                                }}
                              >
                                <img
                                  src={sigPreviewUrl || `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}${current.signature_image_url}`}
                                  alt="Signature"
                                  draggable={false}
                                  style={{ width: "100%", height: "100%", objectFit: "fill", pointerEvents: "none", display: "block" }}
                                />
                              </div>
                              <div style={{ fontSize: ".7rem", color: "rgb(150,150,150)", marginTop: ".25rem" }}>
                                Drag the corner of the image to resize it — the size is saved with this email.
                              </div>
                            </div>
                          )}
                          {(current.opt_out_text ?? "").trim() !== "" && (
                            <p style={{ marginTop: "1.25rem", color: "#9ca3af", fontSize: ".8rem" }}>
                              {current.opt_out_text} <span style={{ textDecoration: "underline" }}>unsubscribe</span>
                            </p>
                          )}
                        </div>
                        {showingAttachment ? (
                          <div style={{ padding: ".5rem .9rem", borderTop: "1px solid rgba(120,120,120,.2)", fontSize: ".78rem", color: "#374151", background: "#f9fafb" }}>
                            <strong>Attachment:</strong> {pendingFile?.name || current.attachment_name}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Also save this as a reusable template (optional) */}
              <div className="mt-5 rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up" style={{ animationDelay: "0.12s" }}>
                <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Also save this as a reusable template (optional)</label>
                <input
                  type="text"
                  maxLength={300}
                  value={alsoSaveName}
                  onChange={(e) => setAlsoSaveName(e.target.value)}
                  readOnly={!canEdit}
                  className={`input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                />
                <p className="mt-1.5 text-[12px] text-gray-500">Give it a name to add it to your template library — usable on any email, opt-out or normal, on other touchpoints or campaigns.</p>
              </div>
                </div>

                {/* Modal footer — Save / Cancel, like Beacon's modal actions */}
                <div className="flex items-center justify-end gap-2 border-t border-gray-950/5 px-6 py-4">
                  {canEdit ? (
                    <>
                      <button
                        onClick={saveTemplate}
                        disabled={saving}
                        className="btn-press flex items-center gap-2 rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
                      >
                        {saving && (
                          <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        )}
                        <span>{saving ? "Saving…" : "Save"}</span>
                      </button>
                      <button
                        onClick={closeEditor}
                        className="rounded-lg bg-white px-5 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={closeEditor}
                      className="rounded-lg bg-white px-5 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
                    >
                      Close
                    </button>
                  )}
                </div>
              </motion.div>
            </div>
          ) : null}

          {view === "schedules" ? (
            <div className="animate-fade-in">
              {/* Schedule overview bar */}
              <div className="mb-5 flex items-center gap-4 rounded-xl bg-white px-6 py-4 shadow-sm ring-1 ring-gray-950/5 animate-fade-in-up">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#054B70]/8">
                  <svg className="h-5 w-5 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-gray-900">
                    {Object.keys(schedules).length} of 9 touchpoints scheduled
                  </p>
                  <p className="text-[11px] text-gray-500">
                    Only <strong>Tuesday, Wednesday, Thursday</strong> allowed. Set daily email limits or leave blank to send all.
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                    <div
                      key={n}
                      className={`h-2.5 w-2.5 rounded-full transition-colors ${schedules[String(n)] ? "bg-[#054B70]" : "bg-gray-200"}`}
                      title={`TP ${n}: ${schedules[String(n)] || "Not scheduled"}`}
                    />
                  ))}
                </div>
              </div>

              {/* Error toast */}
              {schedError && (
                <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-[12px] font-semibold text-red-600 animate-slide-in">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {schedError}
                </div>
              )}

              {/* Allowed days hint */}
              <div className="mb-5 flex items-center gap-2 animate-fade-in-up" style={{ animationDelay: "0.03s" }}>
                <span key="label" className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Allowed days:</span>
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => {
                  const allowed = ["Tue", "Wed", "Thu"].includes(day);
                  return (
                    <span
                      key={day}
                      className={`rounded-lg px-2.5 py-1 text-[10px] font-bold ${
                        allowed
                          ? "bg-[#054B70]/8 text-[#054B70]"
                          : "bg-red-50 text-red-300 line-through"
                      }`}
                    >
                      {day}
                    </span>
                  );
                })}
              </div>

              {/* Schedule cards grid */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => {
                  const dateVal = schedules[String(n)] || "";
                  const limitVal = limits[String(n)] || 0;
                  const tpl = templates.find(t => t.touchpoint_number === n);
                  const configured = tpl && (tpl.subject || tpl.body || tpl.body_html);
                  const isPast = dateVal && new Date(dateVal) < new Date(new Date().toDateString());

                  return (
                    <div
                      key={n}
                      className={`card-hover rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5 overflow-hidden animate-fade-in-up stagger-${n - 1}`}
                    >
                      {/* Colored top accent */}
                      <div className={`h-1 ${dateVal ? (isPast ? "bg-emerald-400" : "bg-[#054B70]") : "bg-gray-200"}`} />

                      <div className="p-5">
                        {/* Header */}
                        <div className="flex items-center gap-3 mb-4">
                          <div className={`flex h-10 w-10 items-center justify-center rounded-lg text-[14px] font-bold transition-colors ${
                            dateVal ? "bg-[#054B70]/10 text-[#054B70]" : "bg-gray-100 text-gray-400"
                          }`}>
                            {n}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-gray-900">{board.find((b) => b.touchpoint_number === n)?.name || `Touchpoint ${n}`}</p>
                            <p className="text-[10px] text-gray-500 truncate">
                              {tpl?.subject || "No subject set"}
                            </p>
                          </div>
                          {!configured && (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-semibold text-amber-600">
                              No template
                            </span>
                          )}
                        </div>

                        {/* Scheduled date display */}
                        {dateVal && (
                          <div className={`mb-3 flex items-center gap-2 rounded-lg px-3 py-2.5 ${isPast ? "bg-emerald-50" : "bg-[#054B70]/5"}`}>
                            <svg className={`h-4 w-4 shrink-0 ${isPast ? "text-emerald-600" : "text-[#054B70]"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                              {isPast ? (
                                <path d="M5 13l4 4L19 7" />
                              ) : (
                                <path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              )}
                            </svg>
                            <div className="flex-1 min-w-0">
                              <span className={`text-[12px] font-semibold ${isPast ? "text-emerald-700" : "text-[#054B70]"}`}>
                                {new Date(dateVal + 'T00:00:00').toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })}
                              </span>
                              {limitVal > 0 && (
                                <span className="ml-2 rounded-full bg-white/60 px-2 py-0.5 text-[9px] font-semibold text-[#054B70]">
                                  {limitVal}/day
                                </span>
                              )}
                            </div>
                            {isPast && (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-semibold text-emerald-700">Past</span>
                            )}
                          </div>
                        )}

                        {/* Date picker */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <DatePicker
                              key={`sched-${n}-${dateVal}`}
                              inputId={`schedDate${n}`}
                              defaultValue={dateVal}
                              allowedWeekdays={[2, 3, 4]}
                              placeholder="Pick a Tue / Wed / Thu"
                              className="flex-1"
                            />
                            {dateVal && (
                              <button
                                onClick={() => clearSchedule(n)}
                                className="rounded-lg p-2.5 text-gray-500 transition-all hover:bg-red-50 hover:text-red-500"
                                title="Clear schedule"
                              >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                  <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>

                          {/* Daily limit + save */}
                          <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                              <input
                                type="number"
                                id={`schedLimit${n}`}
                                min="0"
                                defaultValue={limitVal || ""}
                                placeholder="All contacts"
                                className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 pr-16 text-[12px] text-gray-900 outline-none"
                              />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-gray-500">
                                /day
                              </span>
                            </div>
                            <button
                              onClick={() => setSchedule(n)}
                              className="btn-press rounded-lg bg-[#054B70] px-4 py-2.5 text-[11px] font-bold text-white transition-colors hover:bg-[#043d5c]"
                            >
                              {dateVal ? "Update" : "Set"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </main>
      </MainContent>

      {/* Bulk Send Confirmation Modal */}
      {/* Add an email — joins the journey, optionally copied from a saved template */}
      {showAddTp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowAddTp(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={SPRING}
            className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title="Close"
              aria-label="Close"
              onClick={() => setShowAddTp(false)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
            <h2 className="mb-1 text-[16px] font-bold text-gray-950">Add an email</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              {board.length === 0
                ? "The first email of the journey — it sends as soon as the flow starts."
                : "It joins the journey and sends after the wait you set."}
            </p>

            {board.length > 0 && (
              <>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">
                  It comes after <span className="text-red-500">*</span>
                </label>
                <Select
                  value={addAfter}
                  onChange={setAddAfter}
                  options={[
                    { value: "0", label: "Nothing — make it the first email" },
                    ...board.map((b) => ({
                      value: String(b.touchpoint_number),
                      label: `Email ${b.touchpoint_number}${b.subject ? ` — ${b.subject.slice(0, 40)}` : " (still empty)"}`,
                    })),
                  ]}
                  className="mb-4"
                />
              </>
            )}

            <label className="mb-1 block text-[13px] font-medium text-gray-950">What should it start from?</label>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setAddFrom("fresh"); setAddTemplateId(""); }}
                className={`rounded-lg p-3 text-left transition-all ${addFrom === "fresh" ? "bg-[#054B70]/5 ring-2 ring-[#054B70]" : "bg-white ring-1 ring-gray-950/10 hover:ring-gray-950/20"}`}
              >
                <span className={`block text-[13px] font-semibold ${addFrom === "fresh" ? "text-[#054B70]" : "text-gray-950"}`}>Write a fresh email</span>
                <span className="mt-0.5 block text-[11px] text-gray-500">Start empty — the editor opens right after.</span>
              </button>
              <button
                type="button"
                onClick={() => setAddFrom("template")}
                className={`rounded-lg p-3 text-left transition-all ${addFrom === "template" ? "bg-[#054B70]/5 ring-2 ring-[#054B70]" : "bg-white ring-1 ring-gray-950/10 hover:ring-gray-950/20"}`}
              >
                <span className={`block text-[13px] font-semibold ${addFrom === "template" ? "text-[#054B70]" : "text-gray-950"}`}>Use a saved template</span>
                <span className="mt-0.5 block text-[11px] text-gray-500">Copy one from your Template Library.</span>
              </button>
            </div>
            {addFrom === "template" && (
              <>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">
                  Which template? <span className="text-red-500">*</span>
                </label>
                <Select
                  value={addTemplateId}
                  onChange={setAddTemplateId}
                  options={libraryTemplates.map((t) => ({ value: String(t.id), label: t.name }))}
                  placeholder="Select a template…"
                  searchable
                  className="mb-1"
                />
                <p className="mb-4 text-[12px] text-gray-500">It&apos;s copied in — you can still tweak it afterwards.</p>
              </>
            )}

            {board.length > 0 && (
              <fieldset className="mb-4 rounded-lg border border-gray-200 p-4">
                <legend className="px-1 text-[13px] font-medium text-gray-950">How long to wait before it sends</legend>
                <div className="mb-3 grid grid-cols-5 gap-2">
                  {([["months", "Months"], ["weeks", "Weeks"], ["days", "Days"], ["hours", "Hours"], ["minutes", "Minutes"]] as const).map(([unit, label]) => (
                    <div key={unit}>
                      <label className="mb-1 block text-[13px] font-medium text-gray-950">{label}</label>
                      <input
                        type="number"
                        min={0}
                        value={addParts[unit]}
                        onChange={(e) => setAddParts((p) => ({ ...p, [unit]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                        className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-2 py-2 text-center text-[13px] text-gray-950 outline-none"
                      />
                    </div>
                  ))}
                </div>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">Then send at (optional)</label>
                <input
                  type="time"
                  value={addTime}
                  onChange={(e) => setAddTime(e.target.value)}
                  className="input-glow mb-1 w-40 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-[13px] text-gray-950 outline-none"
                />
                <p className="text-[12px] text-gray-500">
                  Combine units freely — e.g. 1 week and 3 days. All zeros = sends immediately. The time pins the clock, e.g. at 9:00 AM.
                </p>
                <label className="mb-1 mt-3 block text-[13px] font-medium text-gray-950">Or pick an exact date on the calendar (optional)</label>
                <DatePicker value={addDate} onChange={setAddDate} placeholder="Pick a date…" className="mb-1 w-52" />
                <p className="text-[12px] text-gray-500">
                  A date here overrides the wait — the email goes out on that day (at the &quot;Then send at&quot; time if set).
                </p>
              </fieldset>
            )}

            <div className="flex gap-2">
              <button
                onClick={addTouchpoint}
                disabled={addBusy || (addFrom === "template" && !addTemplateId)}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {addBusy ? "Adding…" : "Add email"}
              </button>
              <button onClick={() => setShowAddTp(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Schedule the flow — pick a launch date & time (Beacon's Schedule a campaign) */}
      {showScheduleFlow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowScheduleFlow(false)}>
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={SPRING} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-950">Schedule {campaignName ? `"${campaignName}"` : "this campaign"}</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              Touchpoint 1 goes out at the launch time; each next touchpoint follows after its own wait. Watch and cancel it on the Schedule page.
            </p>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Target group</label>
            <Select
              value={schGroupId}
              onChange={(v) => { setSchGroupId(v); setSchSegmentId(""); }}
              options={[{ value: "", label: "Campaign default — or all active contacts" }, ...importGroups.map((g) => ({ value: String(g.id), label: g.name }))]}
              searchable
              className="mb-3 w-full"
            />
            {schGroupId && segments.some((s) => String(s.import_group_id) === schGroupId) && (
              <>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Segment (optional)</label>
                <Select
                  value={schSegmentId}
                  onChange={setSchSegmentId}
                  options={[{ value: "", label: "Whole group" }, ...segments.filter((s) => String(s.import_group_id) === schGroupId).map((s) => ({ value: String(s.id), label: s.name }))]}
                  searchable
                  className="mb-3 w-full"
                />
              </>
            )}
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Launch at</label>
            <DatePicker withTime value={schStartAt} onChange={setSchStartAt} className="mb-5 w-full" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowScheduleFlow(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={submitScheduleFlow}
                disabled={schBusy || !schStartAt}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {schBusy ? "Working…" : "Put it on the schedule"}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Wait editor — "Wait before Touchpoint N", units combined freely */}
      {waitTp !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setWaitTp(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Wait before Touchpoint {waitTp}</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              How long the journey pauses after the previous email — combine units freely, e.g. 1 week and 3 days. Optionally pin the clock time it sends at.
            </p>
            <div className="mb-3 grid grid-cols-5 gap-2">
              {([["months", "Months"], ["weeks", "Weeks"], ["days", "Days"], ["hours", "Hours"], ["minutes", "Minutes"]] as const).map(([unit, label]) => (
                <div key={unit}>
                  <label className="mb-1 block text-[13px] font-medium text-gray-950">{label}</label>
                  <input
                    type="number"
                    min={0}
                    value={waitParts[unit]}
                    onChange={(e) => setWaitParts((p) => ({ ...p, [unit]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                    className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-2 py-2 text-center text-[13px] text-gray-900 outline-none"
                  />
                </div>
              ))}
            </div>
            <label className="mb-1 block text-[13px] font-medium text-gray-950">Then send at (optional)</label>
            <input
              type="time"
              value={waitTime}
              onChange={(e) => setWaitTime(e.target.value)}
              className="input-glow mb-1 w-40 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-[13px] text-gray-900 outline-none"
            />
            <p className="mb-3 text-[11px] text-gray-500">
              Pins the clock time — e.g. wait 1 week and 3 days, then send at 9:00 AM. Blank = exactly after the wait.
            </p>
            <label className="mb-1 block text-[13px] font-medium text-gray-950">Or pick an exact date on the calendar (optional)</label>
            <DatePicker value={waitDate} onChange={setWaitDate} placeholder="Pick a date…" className="mb-1 w-52" />
            <p className="mb-5 text-[11px] text-gray-500">
              A date here overrides the wait — this email goes out on that day (at the &quot;Then send at&quot; time if set). Use Clear in the calendar to go back to the wait.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setWaitTp(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={saveWait} className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete touchpoint — "Its content and schedule are removed." */}
      {delTp !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setDelTp(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Delete Touchpoint {delTp}?</h2>
            <p className="mb-5 text-[12px] text-gray-500">Its content and schedule are removed. Past sends keep their history.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDelTp(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={clearTouchpoint} className="btn-press rounded-lg bg-red-600 px-6 py-2.5 text-[12px] font-bold text-white hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Test a single email — "[TEST] … real sending always happens in order." */}
      {testFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setTestFor(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">
              {testFor.label === "the goodbye email" ? "Test the goodbye email" : `Test email ${testFor.number}`}
            </h2>
            <p className="mb-4 text-[12px] text-gray-500">
              Sends just this email, marked [TEST], to the addresses below. The journey itself is untouched — real sending always happens in order.
            </p>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Send to</label>
            <input
              autoFocus
              value={testAddr}
              onChange={(e) => setTestAddr(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendBoardTest(); }}
              placeholder="you@example.com, colleague@example.com"
              className="input-glow mb-1 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none"
            />
            <p className="mb-5 text-[11px] text-gray-500">Add more separated by commas.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setTestFor(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={sendBoardTest}
                disabled={testBusy}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {testBusy ? "Sending…" : "Send test"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add a goodbye email — like Add touchpoint: copy a saved email or write from scratch */}
      {addGbFor !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setAddGbFor(null)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={SPRING}
            className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title="Close"
              aria-label="Close"
              onClick={() => setAddGbFor(null)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
            <h2 className="mb-1 pr-8 text-[16px] font-bold text-gray-950">Goodbye email — if they opt out after Touchpoint {addGbFor}</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              Sent once, automatically, when someone opts out right after this touchpoint. Leave the opt-out sentence blank — they have already opted out.
            </p>

            <label className="mb-1 block text-[13px] font-medium text-gray-950">What should it start from?</label>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setGbFrom("fresh"); setAddGbTemplateId(""); }}
                className={`rounded-lg p-3 text-left transition-all ${gbFrom === "fresh" ? "bg-[#054B70]/5 ring-2 ring-[#054B70]" : "bg-white ring-1 ring-gray-950/10 hover:ring-gray-950/20"}`}
              >
                <span className={`block text-[13px] font-semibold ${gbFrom === "fresh" ? "text-[#054B70]" : "text-gray-950"}`}>Write a fresh email</span>
                <span className="mt-0.5 block text-[11px] text-gray-500">Start empty — the editor opens right after.</span>
              </button>
              <button
                type="button"
                onClick={() => setGbFrom("template")}
                className={`rounded-lg p-3 text-left transition-all ${gbFrom === "template" ? "bg-[#054B70]/5 ring-2 ring-[#054B70]" : "bg-white ring-1 ring-gray-950/10 hover:ring-gray-950/20"}`}
              >
                <span className={`block text-[13px] font-semibold ${gbFrom === "template" ? "text-[#054B70]" : "text-gray-950"}`}>Use a saved template</span>
                <span className="mt-0.5 block text-[11px] text-gray-500">Copy one from your Template Library.</span>
              </button>
            </div>
            {gbFrom === "template" && (
              <>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">
                  Which template? <span className="text-red-500">*</span>
                </label>
                <Select
                  value={addGbTemplateId}
                  onChange={setAddGbTemplateId}
                  options={libraryTemplates.map((t) => ({ value: String(t.id), label: t.name }))}
                  placeholder="Select a template…"
                  searchable
                  className="mb-1"
                />
                <p className="mb-4 text-[12px] text-gray-500">It&apos;s copied in — you can still tweak it afterwards.</p>
              </>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => {
                  const forTp = addGbFor;
                  const tplId = addGbTemplateId;
                  setAddGbFor(null);
                  if (forTp === null) return;
                  // From a template → saved directly, stay on the board.
                  // From scratch → straight into the editor to write it now.
                  if (tplId) addGoodbyeFromTemplate(forTp, tplId);
                  else openGoodbye(forTp);
                }}
                disabled={gbFrom === "template" && !addGbTemplateId}
                className="btn-press rounded-lg bg-[#054B70] px-5 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                Add email
              </button>
              <button onClick={() => setAddGbFor(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Remove goodbye email — confirmation */}
      {rmGoodbyeFor !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setRmGoodbyeFor(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Remove this goodbye email?</h2>
            <p className="mb-5 text-[12px] text-gray-500">People who opt out after this touchpoint will no longer receive a farewell email. This does not affect who is opted out.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setRmGoodbyeFor(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={() => removeGoodbye(rmGoodbyeFor)} className="btn-press rounded-lg bg-red-600 px-6 py-2.5 text-[12px] font-bold text-white hover:bg-red-700">Remove</button>
            </div>
          </div>
        </div>
      )}

      {/* Use a saved template — replaces the journey */}
      {showUseTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowUseTemplate(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Use a saved template</h2>
            <p className="mb-4 text-[12px] text-gray-500">Pick a template — the current journey is replaced by its emails and waits.</p>
            {flowTemplates.length === 0 ? (
              <p className="mb-5 rounded-lg bg-gray-50 px-4 py-3 text-[12px] text-gray-500">No flow templates saved yet — use &quot;Save as template&quot; first.</p>
            ) : (
              <Select
                value={useTemplateId}
                onChange={setUseTemplateId}
                options={flowTemplates.map((f) => ({
                  value: String(f.id),
                  label: `${f.name} (${f.touchpoint_count} step${f.touchpoint_count === 1 ? "" : "s"}${f.goodbye_count ? `, ${f.goodbye_count} goodbye${f.goodbye_count === 1 ? "" : "s"}` : ""})`,
                }))}
                placeholder="Pick a template…"
                className="mb-5"
              />
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowUseTemplate(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={applyFlowTemplate}
                disabled={!useTemplateId}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                Use template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save flow as template */}
      {showSaveTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowSaveTemplate(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Save flow as template</h2>
            <p className="mb-4 text-[12px] text-gray-500">
              Captures every touchpoint — content and waits — so this flow can be reproduced whenever needed.
            </p>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-gray-500">Template name</label>
            <input
              autoFocus
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveFlowAsTemplate(); }}
              className="input-glow mb-5 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowSaveTemplate(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={saveFlowAsTemplate}
                disabled={!flowName.trim()}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                Save template
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkSend !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowBulkSend(null)}>
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-center gap-3">
              <Select
                value={String(showBulkSend)}
                onChange={(v) => setShowBulkSend(Number(v))}
                options={board.map((b) => ({ value: String(b.touchpoint_number), label: String(b.touchpoint_number) }))}
                size="sm"
                className="shrink-0"
              />
              <div>
                <h2 className="text-[16px] font-bold text-gray-900">Send Touchpoint {showBulkSend}</h2>
                <p className="text-[11px] text-gray-500">
                  {bulkSegmentIds.length
                    ? `Targeting ${bulkSegmentIds.length} segment${bulkSegmentIds.length > 1 ? "s" : ""}`
                    : bulkGroupId
                    ? `Targeting group: ${importGroups.find((g) => String(g.id) === bulkGroupId)?.name || ""}`
                    : "Choose an audience and template below, or send to all active contacts"}
                </p>
              </div>
            </div>

            {/* Targeting: pick a group first, then a segment within it */}
            {(importGroups.length > 0 || segments.length > 0) && (() => {
              const groupSegments = bulkGroupId
                ? segments.filter((s) => String(s.import_group_id) === bulkGroupId)
                : [];
              return (
              <div className="mb-4 space-y-2">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500">1 · Audience</label>

                {/* Group */}
                <div>
                  <p className="mb-1 text-[10px] font-medium text-gray-500">Import group</p>
                  <Select
                    value={bulkGroupId}
                    onChange={(v) => { setBulkGroupId(v); setBulkSegmentIds([]); }}
                    options={[
                      { value: "", label: "All import groups" },
                      ...importGroups.map((g) => ({ value: String(g.id), label: `${g.name} (${g.contact_count})` })),
                    ]}
                  />
                </div>

                {/* Segment — only after a specific group is chosen */}
                {bulkGroupId && (
                  <div>
                    <p className="mb-1 text-[10px] font-medium text-gray-500">Segment</p>
                    {groupSegments.length > 0 ? (
                      <Select
                        value={bulkSegmentIds[0] || ""}
                        onChange={(v) => setBulkSegmentIds(v ? [v] : [])}
                        options={[
                          { value: "", label: "All segments in this group" },
                          ...groupSegments.map((s) => ({ value: String(s.id), label: `${s.name} (${s.contact_count})` })),
                        ]}
                      />
                    ) : (
                      <p className="text-[11px] text-gray-500">
                        No segments in this group yet.{" "}
                        <button type="button" onClick={() => router.push("/contacts")} className="font-semibold text-[#054B70] hover:underline">
                          Create one on the Contacts page
                        </button>.
                      </p>
                    )}
                  </div>
                )}
              </div>
              );
            })()}

            {/* Email template — optional; falls back to this touchpoint's own content */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-500">2 · Email template</label>
              <div className="flex gap-2">
                <Select
                  value={bulkTemplateId}
                  onChange={setBulkTemplateId}
                  options={[
                    { value: "", label: "Use this touchpoint's content" },
                    ...libraryTemplates.map((t) => ({ value: String(t.id), label: t.name })),
                  ]}
                  className="w-full"
                />
                <button
                  type="button"
                  onClick={openLibrary}
                  title="Open the Template Library"
                  className="btn-press shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-[12px] font-semibold text-[#054B70] transition-colors hover:bg-[#054B70] hover:text-white"
                >
                  Library
                </button>
              </div>
            </div>

            {/* How many + batch cap */}
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-gray-600">
                  Eligible for Touchpoint {showBulkSend}
                </span>
                <span className="text-[14px] font-bold text-[#054B70] tabular-nums">
                  {bulkEligible === null ? "…" : bulkEligible}
                </span>
              </div>
              <p className="mb-2.5 text-[10px] text-gray-500 leading-snug">
                Only contacts who already received Touchpoint {(showBulkSend ?? 1) - 1} are eligible (the rest are skipped).
              </p>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-500">Send to at most</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={bulkLimit}
                  onChange={(e) => setBulkLimit(e.target.value)}
                  placeholder={bulkEligible !== null ? `All ${bulkEligible}` : "All"}
                  className="w-28 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[13px] font-semibold text-gray-900 outline-none focus:border-[#054B70]"
                />
                <span className="text-[11px] text-gray-500">contacts (blank = all eligible)</span>
              </div>
              {bulkLimit && bulkEligible !== null && Number(bulkLimit) < bulkEligible && (
                <p className="mt-1.5 text-[10px] font-medium text-[#054B70]">
                  Sends {bulkLimit} now · {bulkEligible - Number(bulkLimit)} left for the next batch.
                </p>
              )}
            </div>

            {bulkResult && (
              <div className="mb-4 flex items-center gap-2 rounded-lg bg-[#054B70]/5 px-4 py-3 text-[12px] font-semibold text-[#054B70] animate-fade-in">
                <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
                {bulkResult}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowBulkSend(null)}
                className="rounded-lg px-5 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBulkSend(showBulkSend)}
                disabled={bulkSending}
                className="btn-press flex items-center gap-2 rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {bulkSending ? (
                  <>
                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Starting...
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                    Start Sending
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save-first prompt */}
      {showSavePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => { setShowSavePrompt(false); setPendingSend(null); }}>
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-amber-50">
              <svg className="h-6 w-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" /></svg>
            </div>
            <h2 className="text-[16px] font-bold text-gray-900">Save the template first</h2>
            <p className="mt-1 mb-5 text-[13px] leading-relaxed text-gray-500">
              This touchpoint has unsaved changes. Save it so your email goes out with the latest content, then it&apos;ll {pendingSend === "test" ? "send the test" : "open the send dialog"}.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowSavePrompt(false); setPendingSend(null); }}
                className="rounded-lg px-5 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={saveThenContinue}
                disabled={saving}
                className="btn-press flex items-center gap-2 rounded-lg bg-[#054B70] px-5 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Template"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router.
export default function EmailTemplatesPage() {
  return (
    <Suspense fallback={null}>
      <EmailTemplatesPageInner />
    </Suspense>
  );
}
