"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

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
  days_after_previous: 7,
};

const VARIABLES = [
  { key: "{{org_name}}", label: "Organization" },
  { key: "{{contact_name}}", label: "Contact Name" },
  { key: "{{email}}", label: "Email" },
  { key: "{{phone}}", label: "Phone" },
  { key: "{{opt_out}}", label: "Opt-out link" },
];

export default function EmailTemplatesPage() {
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
  const [showFullPreview, setShowFullPreview] = useState(false);
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

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusedRef = useRef<HTMLTextAreaElement | null>(null);
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

  const SAMPLE_VARS: Record<string, string> = useMemo(() => ({
    "{{org_name}}": "Sample Corp Inc.",
    "{{contact_name}}": "John Doe",
    "{{email}}": "johndoe@samplecorp.com",
    "{{phone}}": "+1 (555) 123-4567",
    "{{touchpoint_number}}": String(activeTP || 1),
  }), [activeTP]);

  const fillVars = useCallback((s: string) => {
    let out = s;
    for (const [k, v] of Object.entries(SAMPLE_VARS)) out = out.split(k).join(v);
    return out;
  }, [SAMPLE_VARS]);

  // Subject as the recipient sees it (sample data filled in)
  const previewSubject = useMemo(() => (current ? fillVars(current.subject) : ""), [current, fillVars]);

  // Build preview HTML that matches what the recipient actually receives.
  // Uses the HTML body if present, otherwise renders the plain-text body.
  const previewHtml = useMemo(() => {
    if (!current) return "";
    const hasHtml = current.body_html.trim();
    const hasText = current.body.trim();

    let html: string;
    if (hasHtml) {
      html = current.body_html;
    } else if (hasText) {
      // Plain-text email: mirror the backend (append signature text), preserve line breaks
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      let text = current.body;
      if (current.signature.trim()) text += "\n\n" + current.signature;
      html = `<div style="font-family:'Poppins',Arial,sans-serif;font-size:9pt;color:#0a2a3c;white-space:pre-wrap">${esc(text)}</div>`;
    } else {
      // No body yet — faint placeholder, but still show the opt-out line below
      html = `<div style="font-family:'Poppins',Arial,sans-serif;font-size:9pt;color:#c0cdd6;font-style:italic">Your email body will appear here…</div>`;
    }

    for (const [key, val] of Object.entries(SAMPLE_VARS)) {
      html = html.split(key).join(val);
    }

    // Signature image — render it in the preview whenever one is uploaded
    const sigUrl = sigPreviewUrl || (current.signature_image_url ? `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}${current.signature_image_url}` : "");
    if (sigUrl) {
      const hasDriveUrl = /https:\/\/drive\.google\.com\/thumbnail\?id=/i.test(html);
      const hasCidRef = /cid:signature_tp\d+/i.test(html);
      if (hasDriveUrl) html = html.replace(/https:\/\/drive\.google\.com\/thumbnail\?id=[^"'&]+(?:&amp;[^"']*|&[^"']*)*/gi, sigUrl);
      else if (hasCidRef) html = html.replace(/cid:signature_tp\d+/gi, sigUrl);
      else html += `<div style="margin-top:16px"><img src="${sigUrl}" alt="Signature" style="max-width:320px;height:auto" /></div>`;
    }

    // Opt-out line — underline the word "here" (non-clickable in preview), matching the email
    const optText = (current.opt_out_text ?? "").trim() || DEFAULT_OPT_OUT_TEXT;
    const optStyle = "color:#054B70;text-decoration:underline";
    const optLink = `<span style="${optStyle}">${optText}</span>`;
    if (html.includes("{{opt_out}}")) html = html.split("{{opt_out}}").join(optLink);
    else html += `<div style="margin-top:18px;font-size:12px;color:#8ca3b3;line-height:1.5">${optLink}</div>`;

    // Open any real links in a new tab so clicks don't navigate the sandboxed preview iframe
    return `<base target="_blank"><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet"><div style="font-family:'Poppins',Arial,sans-serif;font-size:9pt">` + html + `</div>`;
  }, [current, sigPreviewUrl, SAMPLE_VARS]);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/email-templates/`, { credentials: "include" }).then((r) => r.json()),
      fetch(`${API}/email-templates/get-schedules/`, { credentials: "include" }).then((r) => r.json()),
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
  }, []);

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
    fetch(`${API}/send/eligible-count/?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.ok) setBulkEligible(d.eligible); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showBulkSend, bulkGroupId, bulkSegmentIds]);

  function openEditor(n: number) {
    setActiveTP(n);
    setView("editor");
  }

  function backToDashboard() {
    setActiveTP(null);
    setView("dashboard");
  }

  function openLibrary() {
    router.push("/template-library");
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

  function insertVar(v: string) {
    const el = lastFocusedRef.current || htmlRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value;
    const newValue = text.substring(0, start) + v + text.substring(end);
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    nativeInputValueSetter?.call(el, newValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.selectionStart = el.selectionEnd = start + v.length;
    el.focus();
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

  async function saveTemplate(): Promise<boolean> {
    if (!activeTP || !current) return false;
    let saved = false;
    setSaving(true);
    setSaveStatus(null);

    const fd = new FormData();
    fd.append("touchpoint_number", String(activeTP));
    fd.append("subject", current.subject);
    fd.append("body", current.body);
    fd.append("body_html", current.body_html);
    fd.append("signature", current.signature);
    fd.append("opt_out_text", current.opt_out_text ?? "");
    fd.append("days_after_previous", String(current.days_after_previous));
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
        setSaveStatus({ text: "Template saved successfully", ok: true });
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
        body: JSON.stringify({ touchpoint_number: activeTP, recipients: testEmails }),
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
        body: JSON.stringify({ touchpoint_number: tpNum, scheduled_date: "" }),
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

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f4f7]">
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-[13px] text-[#8ca3b3]">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#f0f4f7]">
      <Sidebar />

      {/* ── Main area ── */}
      <MainContent>
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#e0e8ee] bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            {view === "editor" && activeTP ? (
              <div className="flex items-center gap-3">
                <button
                  onClick={backToDashboard}
                  className="btn-press flex h-8 w-8 items-center justify-center rounded-lg bg-[#f0f4f7] text-[#6b8a9e] transition-colors hover:bg-[#054B70] hover:text-white"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <div>
                  <h1 className="text-[16px] font-bold text-[#0a2a3c]">Touchpoint {activeTP}</h1>
                  <p className="text-[11px] text-[#8ca3b3]">{current?.subject || "No subject"}</p>
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-[16px] font-bold text-[#0a2a3c]">
                  {view === "schedules" ? "Touchpoint Schedules" : "Email Templates"}
                </h1>
                <p className="text-[11px] text-[#8ca3b3]">
                  {view === "schedules"
                    ? "Set send dates for touchpoints 2–10"
                    : "Select a touchpoint to edit its content"}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {canEdit && (
              <button
                onClick={openLibrary}
                title="Template library"
                className="btn-press flex items-center gap-2 rounded-xl border border-[#d0dce4] bg-white px-3 py-2.5 text-[12px] font-bold text-[#054B70] transition-colors hover:bg-[#054B70] hover:text-white sm:px-4"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h7" /></svg>
                <span className="hidden sm:inline">Library</span>
              </button>
            )}
            {view === "editor" ? (
              canEdit ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openBulkSend()}
                    className="btn-press flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12px] font-bold text-emerald-700 transition-colors hover:bg-emerald-600 hover:text-white hover:border-emerald-600 sm:px-5"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                    <span className="hidden sm:inline">Send…</span>
                  </button>
                  <button
                    onClick={saveTemplate}
                    disabled={saving}
                    className="btn-press flex items-center gap-2 rounded-xl bg-[#054B70] px-3 py-2.5 text-[12px] font-bold text-white disabled:opacity-50 sm:px-6"
                  >
                    {saving ? (
                      <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    <span className="hidden sm:inline">{saving ? "Saving..." : "Save Template"}</span>
                  </button>
                </div>
              ) : (
                <span className="rounded-xl bg-[#f0f4f7] px-4 py-2.5 text-[12px] font-semibold text-[#8ca3b3]">
                  View Only
                </span>
              )
            ) : (
              <div className="flex items-center rounded-xl bg-[#f0f4f7] p-1">
                <button
                  onClick={() => setView("dashboard")}
                  className={`rounded-lg px-4 py-1.5 text-[12px] font-semibold transition-all duration-200 ${
                    view === "dashboard"
                      ? "bg-[#054B70] text-white shadow-sm"
                      : "text-[#6b8a9e] hover:text-[#0a2a3c]"
                  }`}
                >
                  Templates
                </button>
                <button
                  onClick={() => setView("schedules")}
                  className={`rounded-lg px-4 py-1.5 text-[12px] font-semibold transition-all duration-200 ${
                    view === "schedules"
                      ? "bg-[#054B70] text-white shadow-sm"
                      : "text-[#6b8a9e] hover:text-[#0a2a3c]"
                  }`}
                >
                  Schedules
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="p-4 sm:p-8">
          {view === "dashboard" ? (
            <div className="animate-fade-in">
              {!loaded ? (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className={`h-[120px] rounded-xl bg-white shadow-sm animate-fade-in-up stagger-${i + 1}`}>
                      <div className="h-full rounded-xl bg-gradient-to-r from-[#f0f4f7] via-white to-[#f0f4f7] bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
                    const tpl = getTemplate(n);
                    const configured = hasContent(n);
                    const scheduled = !!schedules[String(n)];
                    const job = getActiveJob(n);
                    const jobProcessed = job ? job.sent_count + job.failed_count + job.skipped_count : 0;
                    const jobPct = job && job.total_recipients > 0 ? Math.round((jobProcessed / job.total_recipients) * 100) : 0;
                    return (
                      <div
                        key={n}
                        className={`card-hover animate-fade-in-up stagger-${n} group relative flex flex-col rounded-xl bg-white text-left shadow-sm overflow-hidden`}
                      >
                        {/* Sending accent bar */}
                        {job && (
                          <div className="h-0.5 bg-gradient-to-r from-[#054B70] via-blue-400 to-[#054B70] bg-[length:200%_100%] animate-[shimmer_2s_infinite]" />
                        )}
                        <button onClick={() => openEditor(n)} className="flex-1 p-4 text-left">
                          <div className="flex items-center gap-3 mb-2">
                            <div
                              className={`flex h-8 w-8 items-center justify-center rounded-lg text-[12px] font-bold transition-all duration-300 ${
                                job ? "bg-blue-500 text-white" :
                                configured
                                  ? "bg-[#054B70]/10 text-[#054B70]"
                                  : "bg-[#f0f4f7] text-[#a0b4c0]"
                              } group-hover:bg-[#054B70] group-hover:text-white`}
                            >
                              {n}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] font-semibold text-[#0a2a3c] leading-tight">TP {n}</p>
                              <p className="text-[10px] text-[#8ca3b3] truncate">{tpl.subject || "No subject"}</p>
                            </div>
                            <svg className="h-3.5 w-3.5 shrink-0 text-[#d0dce4] transition-all group-hover:text-[#054B70] group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                              <path d="M9 5l7 7-7 7" />
                            </svg>
                          </div>

                          {/* Live progress when sending */}
                          {job ? (
                            <div className="mt-1">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-semibold text-blue-600">
                                  {jobProcessed}/{job.total_recipients} sent
                                </span>
                                <span className="text-[10px] font-bold text-[#054B70] tabular-nums">{jobPct}%</span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f0f4f7]">
                                <div
                                  className="h-full rounded-full bg-gradient-to-r from-[#054B70] to-blue-400 transition-all duration-700"
                                  style={{ width: `${jobPct}%` }}
                                />
                              </div>
                              {job.current_contact && (
                                <p className="mt-1 text-[9px] text-[#8ca3b3] truncate">
                                  Sending to {job.current_contact}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                                configured
                                  ? "bg-[#054B70]/8 text-[#054B70]"
                                  : "bg-[#f0f4f7] text-[#a0b4c0]"
                              }`}>
                                {configured ? "Configured" : "Empty"}
                              </span>
                              {scheduled && (
                                <span className="rounded-full bg-[#94bccc]/20 px-2 py-0.5 text-[9px] font-semibold text-[#054B70]">
                                  Scheduled
                                </span>
                              )}
                            </div>
                          )}
                        </button>

                        {/* Action buttons */}
                        {canEdit && (
                          <div className="flex border-t border-[#f0f4f7]">
                            {job ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
                                className="flex flex-1 items-center justify-center gap-1 py-2 text-[10px] font-semibold text-red-500 transition-colors hover:bg-red-50"
                              >
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                                Stop
                              </button>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setShowBulkSend(n); setBulkResult(null); setBulkGroupId(""); setBulkSegmentIds([]); setBulkTemplateId(""); setBulkLimit(""); }}
                                className="flex flex-1 items-center justify-center gap-1 py-2 text-[10px] font-semibold text-[#054B70] transition-colors hover:bg-[#054B70]/5"
                              >
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                                Send
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : view === "editor" && current ? (
            <div className="animate-fade-in">
              {/* Save status toast */}
              {saveStatus && (
                <div className={`mb-5 flex items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold animate-slide-in ${
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

              {/* Variables bar */}
              <div className="mb-5 flex items-center gap-2 rounded-2xl bg-white px-5 py-3.5 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.05s" }}>
                <span key="label" className="text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3] mr-2">
                  Insert
                </span>
                {VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    onClick={() => insertVar(v.key)}
                    className="rounded-lg bg-[#054B70]/5 px-3 py-1.5 font-mono text-[11px] font-semibold text-[#054B70] transition-all duration-200 hover:bg-[#054B70] hover:text-white hover:shadow-md hover:shadow-[#054B70]/15"
                  >
                    {v.key}
                  </button>
                ))}
              </div>

              {/* Two-column layout */}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                {/* Left column (2/3) */}
                <div className="xl:col-span-2 space-y-5">
                  {/* Subject */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.08s" }}>
                    <label className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M4 6h16M4 12h16M4 18h7" />
                      </svg>
                      Subject Line
                    </label>
                    <input
                      type="text"
                      value={current.subject}
                      onChange={(e) => updateCurrent("subject", e.target.value)}
                      readOnly={!canEdit}
                      placeholder="Enter email subject..."
                      className={`input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                  </div>

                  {/* Plain text body */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.11s" }}>
                    <label className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Plain Text Body
                      <span className="font-normal normal-case text-[#c0d0d8]">— fallback</span>
                    </label>
                    <textarea
                      ref={bodyRef}
                      onFocus={() => (lastFocusedRef.current = bodyRef.current)}
                      value={current.body}
                      onChange={(e) => updateCurrent("body", e.target.value)}
                      readOnly={!canEdit}
                      placeholder="Write your email content here..."
                      className={`input-glow min-h-[140px] w-full resize-y rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm leading-relaxed text-[#0a2a3c] placeholder-[#b0c4d0] outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                  </div>

                  {/* HTML body */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.14s" }}>
                    <div className="mb-3 flex items-center justify-between">
                      <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                        </svg>
                        HTML Body
                        <span className="font-normal normal-case text-[#c0d0d8]">— this is what gets sent</span>
                      </label>
                      <button
                        onClick={() => setShowFullPreview(true)}
                        disabled={!previewHtml}
                        className="btn-press flex items-center gap-1.5 rounded-lg bg-[#f0f4f7] px-4 py-2 text-[11px] font-semibold text-[#6b8a9e] hover:bg-[#054B70] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                        </svg>
                        Full Preview
                      </button>
                    </div>
                    <textarea
                      ref={htmlRef}
                      onFocus={() => (lastFocusedRef.current = htmlRef.current)}
                      value={current.body_html}
                      onChange={(e) => updateCurrent("body_html", e.target.value)}
                      readOnly={!canEdit}
                      placeholder={`<div style="font-family: 'Poppins', Arial, sans-serif; font-size: 9pt;">\n  <p>Hi {{contact_name}},</p>\n  <p>Your email content...</p>\n</div>`}
                      className={`input-glow min-h-[280px] w-full resize-y rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 font-mono text-[12px] leading-relaxed text-[#0a2a3c] placeholder-[#b0c4d0] outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                      style={{ tabSize: 2 }}
                    />
                  </div>

                  {/* Opt-out line (required unsubscribe) */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.16s" }}>
                    <label className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                      Opt-out line
                      <span className="font-normal normal-case text-[#c0d0d8]">— becomes a clickable unsubscribe link</span>
                    </label>
                    <textarea
                      value={current.opt_out_text ?? ""}
                      onChange={(e) => updateCurrent("opt_out_text", e.target.value)}
                      readOnly={!canEdit}
                      placeholder={DEFAULT_OPT_OUT_TEXT}
                      rows={2}
                      className={`input-glow w-full resize-y rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none ${!canEdit ? "cursor-default opacity-70" : ""}`}
                    />
                    <p className="mt-2 text-[11px] text-[#8ca3b3] leading-relaxed">
                      Added to the bottom of every email as a unique unsubscribe link. When a recipient clicks it, they&apos;re marked <strong className="text-amber-600">Opted Out</strong> and never emailed again. Place it inside your HTML with <code className="rounded bg-[#f0f4f7] px-1 font-mono text-[10px]">{"{{opt_out}}"}</code>, or it&apos;s appended automatically.
                    </p>
                  </div>

                </div>

                {/* Right column (1/3) */}
                <div className="space-y-5">
                  {/* Live email preview — always visible */}
                  <div className="rounded-2xl bg-white p-5 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.08s" }}>
                    <label className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      Email Preview
                      <span className="font-normal normal-case text-[#c0d0d8]">— as recipient sees it</span>
                    </label>
                    <div className="overflow-hidden rounded-xl border border-[#d0dce4] bg-[#f7f9fb]">
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                        <div className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                        <div className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                        <span className="ml-2 text-[10px] text-[#8ca3b3]">Preview — sample data</span>
                      </div>
                      {/* Subject header */}
                      <div className="border-y border-[#e8eff3] bg-white px-4 py-2.5">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-[#b0c4d0]">Subject</span>
                        <p className="text-[13px] font-semibold text-[#0a2a3c]">{previewSubject || "(No subject)"}</p>
                      </div>
                      {previewHtml ? (
                        <iframe
                          srcDoc={previewHtml}
                          className="w-full border-0 bg-white"
                          style={{ minHeight: 280 }}
                          sandbox="allow-same-origin"
                          title="Email preview"
                        />
                      ) : (
                        <div className="flex min-h-[280px] flex-col items-center justify-center bg-white px-6 text-center">
                          <svg className="mb-2 h-8 w-8 text-[#d0dce4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                          <p className="text-[12px] font-medium text-[#8ca3b3]">No body content yet</p>
                          <p className="mt-0.5 text-[11px] text-[#b0c4d0]">Type into the HTML Body or Plain Text Body to see it here.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Signature image */}
                  <div className="rounded-2xl bg-white p-5 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.10s" }}>
                    <label className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      Signature Image
                    </label>
                    <p className="mb-3 text-[10px] text-[#8ca3b3]">
                      Referenced as <code className="rounded-md bg-[#f0f4f7] px-1.5 py-0.5 text-[10px] text-[#6b8a9e]">cid:signature_tp{activeTP}</code> in HTML
                    </p>
                    {!showingSigImg ? (
                      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#d0dce4] bg-[#f7f9fb] px-4 py-8 text-[12px] text-[#8ca3b3] transition-all duration-300 hover:border-[#054B70] hover:bg-[#054B70]/5 hover:text-[#054B70]">
                        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                          <path d="M12 4v16m8-8H4" />
                        </svg>
                        Upload image
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
                      <div className="flex items-center gap-3 rounded-xl border border-[#054B70]/15 bg-[#054B70]/5 px-3 py-3 animate-scale-in">
                        {(sigPreviewUrl || current.signature_image_url) && (
                          <img src={sigPreviewUrl || `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}${current.signature_image_url}`} alt="Signature" className="h-10 w-auto rounded-lg border border-[#d0dce4] bg-white object-contain" />
                        )}
                        <span className="flex-1 truncate text-[12px] font-medium text-[#0a2a3c]">
                          {pendingSigImg?.name || current.signature_image_name}
                        </span>
                        <button
                          onClick={() => {
                            setPendingSigImg(null);
                            setClearSigImg(true);
                            setSigPreviewUrl("");
                            if (sigInputRef.current) sigInputRef.current.value = "";
                          }}
                          className="rounded-full p-1.5 text-[#8ca3b3] transition-all hover:bg-red-50 hover:text-red-500"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Attachment */}
                  <div className="rounded-2xl bg-white p-5 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.14s" }}>
                    <label className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                      File Attachment
                    </label>
                    <p className="mb-3 text-[10px] text-[#8ca3b3]">Attached to every email for this touchpoint</p>
                    {!showingAttachment ? (
                      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#d0dce4] bg-[#f7f9fb] px-4 py-8 text-[12px] text-[#8ca3b3] transition-all duration-300 hover:border-[#054B70] hover:bg-[#054B70]/5 hover:text-[#054B70]">
                        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                          <path d="M12 4v16m8-8H4" />
                        </svg>
                        Choose file
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
                      <div className="flex items-center gap-3 rounded-xl border border-[#054B70]/15 bg-[#054B70]/5 px-3 py-3 animate-scale-in">
                        <svg className="h-4 w-4 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span className="flex-1 truncate text-[12px] font-medium text-[#0a2a3c]">
                          {pendingFile?.name || current.attachment_name}
                        </span>
                        <button
                          onClick={() => {
                            setPendingFile(null);
                            setClearAttach(true);
                            if (attachInputRef.current) attachInputRef.current.value = "";
                          }}
                          className="rounded-full p-1.5 text-[#8ca3b3] transition-all hover:bg-red-50 hover:text-red-500"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Test email (editors & admins only) */}
                  {canEdit && <div className="rounded-2xl bg-white p-5 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.18s" }}>
                    <div className="mb-2 flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#054B70]/8">
                        <svg className="h-3.5 w-3.5 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                      </div>
                      <span className="text-[13px] font-bold text-[#0a2a3c]">Send Test Email</span>
                    </div>
                    <p className="mb-3 text-[11px] text-[#8ca3b3]">Add recipients and send a preview with sample data.</p>

                    {/* Recipient tags */}
                    {testEmails.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {testEmails.map((email) => (
                          <span
                            key={email}
                            className="flex items-center gap-1 rounded-full bg-[#054B70]/8 px-2.5 py-1 text-[11px] font-medium text-[#054B70] animate-scale-in"
                          >
                            {email}
                            <button
                              onClick={() => removeTestEmail(email)}
                              className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-[#054B70]/15"
                            >
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                                <path d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Add email input */}
                    <div className="mb-3 flex gap-2">
                      <input
                        type="text"
                        value={testEmailInput}
                        onChange={(e) => setTestEmailInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === ",") {
                            e.preventDefault();
                            addTestEmail();
                          }
                        }}
                        placeholder="name@example.com"
                        className="input-glow flex-1 rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2 text-[12px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                      />
                      <button
                        onClick={addTestEmail}
                        className="btn-press rounded-xl bg-[#f0f4f7] px-3 py-2 text-[11px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#054B70] hover:text-white"
                      >
                        Add
                      </button>
                    </div>

                    <button
                      onClick={() => sendTestEmail()}
                      disabled={testSending || testEmails.length === 0}
                      className="btn-press w-full rounded-xl bg-[#054B70] py-2.5 text-[13px] font-bold text-white disabled:opacity-40"
                    >
                      {testSending ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Sending to {testEmails.length}...
                        </span>
                      ) : (
                        `Send Test to ${testEmails.length} recipient${testEmails.length !== 1 ? "s" : ""}`
                      )}
                    </button>
                    {testResult && (
                      <p className="mt-3 text-[12px] font-semibold text-[#054B70] animate-fade-in">{testResult}</p>
                    )}
                  </div>}

                </div>
              </div>
            </div>
          ) : view === "schedules" ? (
            <div className="animate-fade-in">
              {/* Schedule overview bar */}
              <div className="mb-5 flex items-center gap-4 rounded-2xl bg-white px-6 py-4 shadow-sm animate-fade-in-up">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#054B70]/8">
                  <svg className="h-5 w-5 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-[#0a2a3c]">
                    {Object.keys(schedules).length} of 9 touchpoints scheduled
                  </p>
                  <p className="text-[11px] text-[#8ca3b3]">
                    Only <strong>Tuesday, Wednesday, Thursday</strong> allowed. Set daily email limits or leave blank to send all.
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                    <div
                      key={n}
                      className={`h-2.5 w-2.5 rounded-full transition-colors ${schedules[String(n)] ? "bg-[#054B70]" : "bg-[#e0e8ee]"}`}
                      title={`TP ${n}: ${schedules[String(n)] || "Not scheduled"}`}
                    />
                  ))}
                </div>
              </div>

              {/* Error toast */}
              {schedError && (
                <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-[12px] font-semibold text-red-600 animate-slide-in">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {schedError}
                </div>
              )}

              {/* Allowed days hint */}
              <div className="mb-5 flex items-center gap-2 animate-fade-in-up" style={{ animationDelay: "0.03s" }}>
                <span key="label" className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Allowed days:</span>
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
                      className={`card-hover rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in-up stagger-${n - 1}`}
                    >
                      {/* Colored top accent */}
                      <div className={`h-1 ${dateVal ? (isPast ? "bg-emerald-400" : "bg-[#054B70]") : "bg-[#e0e8ee]"}`} />

                      <div className="p-5">
                        {/* Header */}
                        <div className="flex items-center gap-3 mb-4">
                          <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-[14px] font-bold transition-colors ${
                            dateVal ? "bg-[#054B70]/10 text-[#054B70]" : "bg-[#f0f4f7] text-[#a0b4c0]"
                          }`}>
                            {n}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-[#0a2a3c]">Touchpoint {n}</p>
                            <p className="text-[10px] text-[#8ca3b3] truncate">
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
                          <div className={`mb-3 flex items-center gap-2 rounded-xl px-3 py-2.5 ${isPast ? "bg-emerald-50" : "bg-[#054B70]/5"}`}>
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
                            <input
                              type="date"
                              id={`schedDate${n}`}
                              defaultValue={dateVal}
                              className="input-glow flex-1 rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[12px] text-[#0a2a3c] outline-none"
                            />
                            {dateVal && (
                              <button
                                onClick={() => clearSchedule(n)}
                                className="rounded-xl p-2.5 text-[#8ca3b3] transition-all hover:bg-red-50 hover:text-red-500"
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
                                className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 pr-16 text-[12px] text-[#0a2a3c] outline-none"
                              />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-[#8ca3b3]">
                                /day
                              </span>
                            </div>
                            <button
                              onClick={() => setSchedule(n)}
                              className="btn-press rounded-xl bg-[#054B70] px-4 py-2.5 text-[11px] font-bold text-white transition-colors hover:bg-[#043d5c]"
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

      {/* Full-Screen Email Preview Modal */}
      {showFullPreview && previewHtml && current && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#f0f4f7] animate-fade-in">
          {/* Top bar */}
          <div className="flex items-center justify-between border-b border-[#d0dce4] bg-white px-6 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#054B70]">
                <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <span className="text-[14px] font-bold text-[#0a2a3c]">Email Preview — Touchpoint {activeTP}</span>
            </div>
            <button
              onClick={() => setShowFullPreview(false)}
              className="btn-press flex items-center gap-2 rounded-xl bg-[#f0f4f7] px-4 py-2 text-[12px] font-semibold text-[#6b8a9e] hover:bg-[#054B70] hover:text-white transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
              Close
            </button>
          </div>

          {/* Email container */}
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto w-full max-w-[700px]">
              {/* Email header card */}
              <div className="rounded-t-2xl border border-b-0 border-[#d0dce4] bg-white px-8 py-6">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#054B70] text-[14px] font-bold text-white">
                    {(current.subject || "E")[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-[13px] font-bold text-[#0a2a3c]">Magnum Opus Consultants</div>
                    <div className="text-[11px] text-[#8ca3b3]">noreply@magnumopusconsultants.com</div>
                  </div>
                </div>
                <div className="border-t border-[#f0f4f7] pt-4">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Subject</div>
                  <div className="text-[16px] font-semibold text-[#0a2a3c]">{current.subject || "(No subject)"}</div>
                </div>
                <div className="mt-3 flex items-center gap-4 text-[11px] text-[#8ca3b3]">
                  <span className="flex items-center gap-1">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                    To: Sample Corp Inc. &lt;johndoe@samplecorp.com&gt;
                  </span>
                  <span className="flex items-center gap-1">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                  </span>
                </div>
              </div>

              {/* Email body */}
              <div className="border border-[#d0dce4] bg-white">
                <iframe
                  srcDoc={previewHtml}
                  className="w-full border-0 bg-white"
                  style={{ minHeight: 500 }}
                  sandbox="allow-same-origin"
                  title="Full email preview"
                  onLoad={(e) => {
                    const iframe = e.target as HTMLIFrameElement;
                    if (iframe.contentDocument?.body) {
                      iframe.style.height = Math.max(500, iframe.contentDocument.body.scrollHeight + 40) + "px";
                    }
                  }}
                />
              </div>

              {/* Attachment footer */}
              {current.attachment_name && (
                <div className="rounded-b-2xl border border-t-0 border-[#d0dce4] bg-[#f7f9fb] px-8 py-4">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Attachment</div>
                  <div className="flex items-center gap-3 rounded-xl border border-[#d0dce4] bg-white px-4 py-3">
                    <svg className="h-5 w-5 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                      <path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    <span className="text-[13px] font-medium text-[#0a2a3c]">{current.attachment_name}</span>
                  </div>
                </div>
              )}
              {!current.attachment_name && (
                <div className="rounded-b-2xl border border-t-0 border-[#d0dce4] bg-white h-2" />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk Send Confirmation Modal */}
      {showBulkSend !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowBulkSend(null)}>
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#054B70] text-[14px] font-bold text-white">
                {showBulkSend}
              </div>
              <div>
                <h2 className="text-[16px] font-bold text-[#0a2a3c]">Send Touchpoint {showBulkSend}</h2>
                <p className="text-[11px] text-[#8ca3b3]">
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
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">1 · Audience</label>

                {/* Group */}
                <div>
                  <p className="mb-1 text-[10px] font-medium text-[#8ca3b3]">Import group</p>
                  <select
                    value={bulkGroupId}
                    onChange={(e) => { setBulkGroupId(e.target.value); setBulkSegmentIds([]); }}
                    className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[12px] font-medium text-[#0a2a3c] outline-none"
                  >
                    <option key="all" value="">All import groups</option>
                    {importGroups.map((g) => (
                      <option key={g.id} value={String(g.id)}>{g.name} ({g.contact_count})</option>
                    ))}
                  </select>
                </div>

                {/* Segment — only after a specific group is chosen */}
                {bulkGroupId && (
                  <div>
                    <p className="mb-1 text-[10px] font-medium text-[#8ca3b3]">Segment</p>
                    {groupSegments.length > 0 ? (
                      <select
                        value={bulkSegmentIds[0] || ""}
                        onChange={(e) => setBulkSegmentIds(e.target.value ? [e.target.value] : [])}
                        className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[12px] font-medium text-[#0a2a3c] outline-none"
                      >
                        <option value="">All segments in this group</option>
                        {groupSegments.map((s) => (
                          <option key={s.id} value={String(s.id)}>{s.name} ({s.contact_count})</option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-[11px] text-[#8ca3b3]">
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
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">2 · Email template</label>
              <div className="flex gap-2">
                <select
                  value={bulkTemplateId}
                  onChange={(e) => setBulkTemplateId(e.target.value)}
                  className="w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[12px] font-medium text-[#0a2a3c] outline-none"
                >
                  <option key="own" value="">Use this touchpoint&apos;s content</option>
                  {libraryTemplates.map((t) => (
                    <option key={t.id} value={String(t.id)}>{t.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={openLibrary}
                  title="Open the Template Library"
                  className="btn-press shrink-0 rounded-xl border border-[#d0dce4] bg-white px-3 py-2.5 text-[12px] font-semibold text-[#054B70] transition-colors hover:bg-[#054B70] hover:text-white"
                >
                  Library
                </button>
              </div>
            </div>

            {/* How many + batch cap */}
            <div className="mb-4 rounded-xl border border-[#e0e8ee] bg-[#f7f9fb] p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-[#4a6a7a]">
                  Eligible for Touchpoint {showBulkSend}
                </span>
                <span className="text-[14px] font-bold text-[#054B70] tabular-nums">
                  {bulkEligible === null ? "…" : bulkEligible}
                </span>
              </div>
              <p className="mb-2.5 text-[10px] text-[#8ca3b3] leading-snug">
                Only contacts who already received Touchpoint {(showBulkSend ?? 1) - 1} are eligible (the rest are skipped).
              </p>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Send to at most</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={bulkLimit}
                  onChange={(e) => setBulkLimit(e.target.value)}
                  placeholder={bulkEligible !== null ? `All ${bulkEligible}` : "All"}
                  className="w-28 rounded-xl border border-[#d0dce4] bg-white px-3 py-2 text-[13px] font-semibold text-[#0a2a3c] outline-none focus:border-[#054B70]"
                />
                <span className="text-[11px] text-[#8ca3b3]">contacts (blank = all eligible)</span>
              </div>
              {bulkLimit && bulkEligible !== null && Number(bulkLimit) < bulkEligible && (
                <p className="mt-1.5 text-[10px] font-medium text-[#054B70]">
                  Sends {bulkLimit} now · {bulkEligible - Number(bulkLimit)} left for the next batch.
                </p>
              )}
            </div>

            {bulkResult && (
              <div className="mb-4 flex items-center gap-2 rounded-xl bg-[#054B70]/5 px-4 py-3 text-[12px] font-semibold text-[#054B70] animate-fade-in">
                <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
                {bulkResult}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowBulkSend(null)}
                className="rounded-xl px-5 py-2.5 text-[12px] font-semibold text-[#6b8a9e] hover:bg-[#f0f4f7]"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBulkSend(showBulkSend)}
                disabled={bulkSending}
                className="btn-press flex items-center gap-2 rounded-xl bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
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
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50">
              <svg className="h-6 w-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" /></svg>
            </div>
            <h2 className="text-[16px] font-bold text-[#0a2a3c]">Save the template first</h2>
            <p className="mt-1 mb-5 text-[13px] leading-relaxed text-[#6b8a9e]">
              This touchpoint has unsaved changes. Save it so your email goes out with the latest content, then it&apos;ll {pendingSend === "test" ? "send the test" : "open the send dialog"}.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowSavePrompt(false); setPendingSend(null); }}
                className="rounded-xl px-5 py-2.5 text-[12px] font-semibold text-[#6b8a9e] hover:bg-[#f0f4f7]"
              >
                Cancel
              </button>
              <button
                onClick={saveThenContinue}
                disabled={saving}
                className="btn-press flex items-center gap-2 rounded-xl bg-[#054B70] px-5 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
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
