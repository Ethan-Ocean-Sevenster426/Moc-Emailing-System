"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;
const BACKEND = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface LibraryTemplate {
  id: number;
  name: string;
  subject: string;
  body_html: string;
  body: string;
  signature: string;
  opt_out_text: string;
  attachment_name: string;
  attachment_url: string;
  signature_image_name: string;
  signature_image_url: string;
  updated_at: string;
}

const DEFAULT_OPT_OUT_TEXT = "If you'd prefer not to receive further communication from us, you can opt out here.";

const EMPTY_FORM = {
  id: null as number | null,
  name: "",
  subject: "",
  body_html: "",
  body: "",
  signature: "",
  opt_out_text: DEFAULT_OPT_OUT_TEXT,
  signature_image_name: "",
  signature_image_url: "",
  attachment_name: "",
};

const VARIABLES = ["{{org_name}}", "{{contact_name}}", "{{email}}", "{{phone}}", "{{opt_out}}"];

export default function TemplateLibraryPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [templates, setTemplates] = useState<LibraryTemplate[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const [sigFile, setSigFile] = useState<File | null>(null);
  const [clearSig, setClearSig] = useState(false);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [clearAttach, setClearAttach] = useState(false);
  const sigRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [editorTab, setEditorTab] = useState<"edit" | "preview">("edit");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  function showToast(text: string, ok = true) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  }

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/templates-library/`, { credentials: "include" });
      const d = await r.json();
      if (d.ok) setTemplates(d.templates);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function resetFiles() {
    setSigFile(null); setClearSig(false);
    setAttachFile(null); setClearAttach(false);
    if (sigRef.current) sigRef.current.value = "";
    if (attachRef.current) attachRef.current.value = "";
  }

  function newTemplate() {
    setForm(EMPTY_FORM);
    resetFiles();
    setPickerOpen(false);
    setEditorTab("edit");
  }

  function editTemplate(t: LibraryTemplate) {
    setForm({
      id: t.id,
      name: t.name,
      subject: t.subject,
      body_html: t.body_html,
      body: t.body,
      signature: t.signature,
      opt_out_text: t.opt_out_text || DEFAULT_OPT_OUT_TEXT,
      signature_image_name: t.signature_image_name,
      signature_image_url: t.signature_image_url,
      attachment_name: t.attachment_name,
    });
    resetFiles();
    setPickerOpen(false);
  }

  function insertVar(v: string) {
    const el = bodyRef.current;
    if (!el) { setForm((f) => ({ ...f, body_html: f.body_html + v })); return; }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = form.body_html.slice(0, start) + v + form.body_html.slice(end);
    setForm((f) => ({ ...f, body_html: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + v.length;
    });
  }

  async function save(asNew = false) {
    if (!form.name.trim()) { showToast("Template name is required", false); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      if (form.id && !asNew) fd.append("id", String(form.id));
      fd.append("name", form.name.trim());
      fd.append("subject", form.subject);
      fd.append("body_html", form.body_html);
      fd.append("body", form.body);
      fd.append("signature", form.signature);
      fd.append("opt_out_text", form.opt_out_text ?? "");
      if (sigFile) fd.append("signature_image", sigFile);
      if (clearSig) fd.append("clear_signature_image", "1");
      if (attachFile) fd.append("attachment", attachFile);
      if (clearAttach) fd.append("clear_attachment", "1");
      // When branching an existing template, carry its files over
      if (asNew && form.id) fd.append("copy_files_from", String(form.id));

      const res = await fetch(`${API}/templates-library/save/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        showToast(asNew ? "Saved as new template" : form.id ? "Template updated" : "Template created");
        await refresh();
        editTemplate(data.template);
      } else {
        showToast(data.error || "Could not save", false);
      }
    } catch {
      showToast("Network error", false);
    }
    setSaving(false);
  }

  async function sendTest() {
    if (!form.id) { showToast("Save the template first, then send a test", false); return; }
    const email = testEmail.trim();
    if (!email || !email.includes("@")) { showToast("Enter a valid test email", false); return; }
    setTestSending(true);
    try {
      const res = await fetch(`${API}/templates-library/send-test/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: form.id, recipients: [email] }),
        credentials: "include",
      });
      const data = await res.json();
      showToast(data.ok ? data.message : (data.error || "Could not send test"), !!data.ok);
    } catch {
      showToast("Network error sending test", false);
    }
    setTestSending(false);
  }

  async function remove(id: number) {
    if (!confirm("Delete this template?")) return;
    try {
      const res = await fetch(`${API}/templates-library/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast("Template deleted");
        if (form.id === id) newTemplate();
        await refresh();
      }
    } catch { /* ignore */ }
  }

  // Live preview HTML with sample data
  const previewHtml = (() => {
    let html = form.body_html || "<p style='color:#9aab3'>Nothing to preview yet.</p>";
    const sample: Record<string, string> = {
      "{{org_name}}": "Sample Corp Inc.",
      "{{contact_name}}": "John Doe",
      "{{email}}": "john@samplecorp.com",
      "{{phone}}": "+1 555 0100",
    };
    for (const [k, v] of Object.entries(sample)) html = html.split(k).join(v);
    const sigUrl = sigFile ? URL.createObjectURL(sigFile) : (!clearSig && form.signature_image_url ? `${BACKEND}${form.signature_image_url}` : "");
    if (sigUrl) html = html.replace(/cid:signature_tpl?\w*/gi, sigUrl);
    if (sigUrl && !/<img/i.test(form.body_html)) {
      html += `<div style="margin-top:16px"><img src="${sigUrl}" alt="Signature" style="max-width:200px;height:auto" /></div>`;
    }
    if (form.signature) html += `<div style="margin-top:12px;white-space:pre-wrap">${form.signature}</div>`;
    // Opt-out line (rendered as a link; not clickable in preview)
    const optText = (form.opt_out_text ?? "").trim() || DEFAULT_OPT_OUT_TEXT;
    const optLink = `<a href="#" style="color:#054B70">${optText}</a>`;
    if (html.includes("{{opt_out}}")) html = html.split("{{opt_out}}").join(optLink);
    else html += `<div style="margin-top:18px;font-size:12px;color:#8ca3b3;line-height:1.5">${optLink}</div>`;
    return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0a2a3c;padding:4px">${html}</div>`;
  })();

  const inputCls = "input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-3 py-2.5 text-[13px] text-[#0a2a3c] placeholder-[#b0c4d0] outline-none";

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

  return (
    <div className="flex min-h-screen bg-[#f0f4f7]">
      <Sidebar />
      <MainContent>
        {/* Header */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#e0e8ee] bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div className="min-w-0">
              <h1 className="text-[15px] font-bold text-[#0a2a3c] sm:text-[16px]">Template Library</h1>
              <p className="truncate text-[10px] text-[#8ca3b3] sm:text-[11px]">Reusable email templates you can pick when sending a touchpoint</p>
            </div>
          </div>
          {canEdit && (
            <button
              onClick={newTemplate}
              className="btn-press flex shrink-0 items-center gap-2 rounded-xl bg-[#054B70] px-3 py-2 text-[12px] font-bold text-white sm:px-5 sm:py-2.5"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
              <span className="hidden sm:inline">New Template</span>
              <span className="sm:hidden">New</span>
            </button>
          )}
        </header>

        <main className="p-4 sm:p-8">
          {toast && (
            <div className={`mb-5 flex items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold animate-slide-in ${toast.ok ? "bg-[#054B70]/5 text-[#054B70]" : "bg-red-50 text-red-600"}`}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d={toast.ok ? "M5 13l4 4L19 7" : "M6 18L18 6M6 6l12 12"} /></svg>
              {toast.text}
            </div>
          )}

          <div className="w-full">
            {/* Editor */}
            <div className="space-y-5">
              {/* Toolbar: template picker · tabs · new */}
              <div className="flex flex-wrap items-center gap-3">
                {/* Searchable template dropdown */}
                <div className="relative">
                  <button
                    onClick={() => { setPickerOpen((o) => !o); setPickerSearch(""); }}
                    className="flex min-w-[220px] items-center justify-between gap-3 rounded-xl border border-[#d0dce4] bg-white px-4 py-2.5 text-[12px] font-semibold text-[#0a2a3c] shadow-sm transition-colors hover:border-[#054B70]"
                  >
                    <span className="truncate">{form.id ? form.name || "Untitled" : "Open a template…"}</span>
                    <svg className={`h-4 w-4 shrink-0 text-[#8ca3b3] transition-transform ${pickerOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  {pickerOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setPickerOpen(false)} />
                      <div className="absolute left-0 top-full z-40 mt-1 w-[320px] max-w-[85vw] rounded-xl border border-[#e0e8ee] bg-white p-2 shadow-xl animate-fade-in">
                        <div className="relative mb-2">
                          <svg className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#b0c4d0]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
                          <input
                            autoFocus
                            value={pickerSearch}
                            onChange={(e) => setPickerSearch(e.target.value)}
                            placeholder="Filter templates…"
                            className="w-full rounded-lg border border-[#d0dce4] bg-[#f7f9fb] py-2 pl-8 pr-3 text-[12px] text-[#0a2a3c] outline-none"
                          />
                        </div>
                        <div className="max-h-[260px] overflow-y-auto">
                          {templates.filter((t) => (t.name + " " + t.subject).toLowerCase().includes(pickerSearch.toLowerCase())).length === 0 ? (
                            <p className="px-2 py-4 text-center text-[12px] text-[#8ca3b3]">No matching templates</p>
                          ) : (
                            templates
                              .filter((t) => (t.name + " " + t.subject).toLowerCase().includes(pickerSearch.toLowerCase()))
                              .map((t) => (
                                <div
                                  key={t.id}
                                  onClick={() => editTemplate(t)}
                                  className={`group flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-[#054B70]/5 ${form.id === t.id ? "bg-[#054B70]/5" : ""}`}
                                >
                                  <div className="min-w-0">
                                    <p className="truncate text-[12px] font-semibold text-[#0a2a3c]">{t.name}</p>
                                    <p className="truncate text-[11px] text-[#8ca3b3]">{t.subject || "No subject"}</p>
                                  </div>
                                  {canEdit && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); remove(t.id); }}
                                      title="Delete"
                                      className="shrink-0 rounded-lg p-1 text-[#c0cdd6] opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                                    >
                                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    </button>
                                  )}
                                </div>
                              ))
                          )}
                        </div>
                        <div className="mt-1 border-t border-[#f0f4f7] pt-1">
                          <button onClick={newTemplate} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold text-[#054B70] hover:bg-[#054B70]/5">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
                            New blank template
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Edit / Preview tabs */}
                <div className="flex items-center rounded-xl bg-white p-1 shadow-sm">
                  {(["edit", "preview"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setEditorTab(t)}
                      className={`rounded-lg px-5 py-1.5 text-[12px] font-semibold capitalize transition-all duration-200 ${
                        editorTab === t ? "bg-[#054B70] text-white shadow-sm" : "text-[#6b8a9e] hover:text-[#0a2a3c]"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>

                <span className="ml-auto truncate text-[12px] font-semibold text-[#8ca3b3]">
                  {form.id ? `Editing: ${form.name || "Untitled"}` : "New template"}
                </span>
              </div>

              {editorTab === "edit" ? (
              <>
              <div className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-[14px] font-bold text-[#0a2a3c]">{form.id ? "Edit Template" : "New Template"}</h2>
                  {form.id && (
                    <button onClick={newTemplate} className="text-[12px] font-semibold text-[#6b8a9e] hover:text-[#054B70]">
                      + Start new
                    </button>
                  )}
                </div>

                <fieldset disabled={!canEdit} className="space-y-3.5">
                  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Template Name</label>
                      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Spring Promo" className={inputCls} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Subject Line</label>
                      <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Subject" className={inputCls} />
                    </div>
                  </div>

                  {/* Variable insert bar */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Insert</span>
                    {VARIABLES.map((v) => (
                      <button key={v} type="button" onClick={() => insertVar(v)} className="rounded-lg bg-[#054B70]/5 px-2.5 py-1 font-mono text-[11px] font-semibold text-[#054B70] hover:bg-[#054B70] hover:text-white">
                        {v}
                      </button>
                    ))}
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">HTML Body</label>
                    <textarea
                      ref={bodyRef}
                      value={form.body_html}
                      onChange={(e) => setForm({ ...form, body_html: e.target.value })}
                      placeholder="<p>Hello {{contact_name}}…</p>"
                      rows={12}
                      className={`${inputCls} resize-y font-mono text-[12px]`}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Signature</label>
                    <textarea value={form.signature} onChange={(e) => setForm({ ...form, signature: e.target.value })} placeholder="Best regards, The MOC Team" rows={2} className={`${inputCls} resize-y`} />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Opt-out line</label>
                    <textarea value={form.opt_out_text} onChange={(e) => setForm({ ...form, opt_out_text: e.target.value })} placeholder={DEFAULT_OPT_OUT_TEXT} rows={2} className={`${inputCls} resize-y`} />
                    <p className="mt-1 text-[11px] text-[#8ca3b3]">Appended as a unique unsubscribe link. Clicking it marks the recipient <strong className="text-amber-600">Opted Out</strong>. Use <code className="rounded bg-[#f0f4f7] px-1 font-mono text-[10px]">{"{{opt_out}}"}</code> to place it inline.</p>
                  </div>

                  {/* Signature image + attachment */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Signature Image</label>
                      {(sigFile || (!clearSig && form.signature_image_name)) ? (
                        <div className="flex items-center gap-2 rounded-xl border border-[#e0e8ee] bg-[#f7f9fb] px-3 py-2">
                          <img
                            src={sigFile ? URL.createObjectURL(sigFile) : `${BACKEND}${form.signature_image_url}`}
                            alt="sig"
                            className="h-8 w-auto rounded bg-white object-contain"
                          />
                          <span className="flex-1 truncate text-[12px] text-[#0a2a3c]">{sigFile?.name || form.signature_image_name}</span>
                          <button type="button" onClick={() => { setSigFile(null); setClearSig(true); if (sigRef.current) sigRef.current.value = ""; }} className="rounded-lg p-1 text-[#8ca3b3] hover:bg-red-50 hover:text-red-500">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ) : (
                        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-[#d0dce4] bg-[#f7f9fb] px-3 py-2 text-[12px] font-semibold text-[#6b8a9e] hover:border-[#054B70] hover:text-[#054B70]">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                          Upload image
                          <input ref={sigRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setSigFile(f); setClearSig(false); } }} />
                        </label>
                      )}
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Attachment</label>
                      {(attachFile || (!clearAttach && form.attachment_name)) ? (
                        <div className="flex items-center gap-2 rounded-xl border border-[#e0e8ee] bg-[#f7f9fb] px-3 py-2">
                          <svg className="h-4 w-4 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                          <span className="flex-1 truncate text-[12px] text-[#0a2a3c]">{attachFile?.name || form.attachment_name}</span>
                          <button type="button" onClick={() => { setAttachFile(null); setClearAttach(true); if (attachRef.current) attachRef.current.value = ""; }} className="rounded-lg p-1 text-[#8ca3b3] hover:bg-red-50 hover:text-red-500">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ) : (
                        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-[#d0dce4] bg-[#f7f9fb] px-3 py-2 text-[12px] font-semibold text-[#6b8a9e] hover:border-[#054B70] hover:text-[#054B70]">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                          Attach a file
                          <input ref={attachRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setAttachFile(f); setClearAttach(false); } }} />
                        </label>
                      )}
                    </div>
                  </div>

                  {canEdit && (
                    <div className="flex flex-wrap justify-end gap-2 pt-1">
                      {form.id && <button type="button" onClick={newTemplate} className="rounded-xl px-4 py-2.5 text-[12px] font-semibold text-[#6b8a9e] hover:bg-[#f0f4f7]">Cancel</button>}
                      {form.id && (
                        <button type="button" onClick={() => save(true)} disabled={saving} className="btn-press rounded-xl border border-[#d0dce4] bg-white px-5 py-2.5 text-[12px] font-bold text-[#054B70] transition-colors hover:bg-[#054B70] hover:text-white disabled:opacity-50">
                          Save as new
                        </button>
                      )}
                      <button type="button" onClick={() => save(false)} disabled={saving} className="btn-press rounded-xl bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50">
                        {saving ? "Saving…" : form.id ? "Update Template" : "Create Template"}
                      </button>
                    </div>
                  )}
                </fieldset>
              </div>

              {/* Send a test */}
              {canEdit && (
                <div className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
                  <h3 className="mb-1 text-[13px] font-bold text-[#0a2a3c]">Send a test</h3>
                  <p className="mb-3 text-[11px] text-[#8ca3b3]">
                    {form.id ? "Send this template (with sample data) to yourself before using it." : "Save the template first to enable test sends."}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") sendTest(); }}
                      placeholder="you@example.com"
                      className={inputCls}
                    />
                    <button
                      type="button"
                      onClick={sendTest}
                      disabled={testSending || !form.id}
                      className="btn-press shrink-0 rounded-xl bg-[#054B70] px-4 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
                    >
                      {testSending ? "Sending…" : "Send Test"}
                    </button>
                  </div>
                </div>
              )}
              </>
              ) : (
                /* Preview tab */
                <div className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">Email Preview</span>
                    <span className="text-[10px] text-[#b0c4d0]">— as the recipient sees it, with sample data</span>
                  </div>
                  <div className="mx-auto max-w-[680px] overflow-hidden rounded-xl border border-[#e8eff3] bg-white">
                    {/* Email header */}
                    <div className="border-b border-[#e8eff3] bg-[#f7f9fb] px-5 py-3">
                      <p className="text-[9px] font-bold uppercase tracking-wider text-[#b0c4d0]">Subject</p>
                      <p className="text-[14px] font-semibold text-[#0a2a3c]">{form.subject || "(No subject)"}</p>
                      <p className="mt-1 text-[11px] text-[#8ca3b3]">To: Sample Corp Inc. &lt;johndoe@samplecorp.com&gt;</p>
                    </div>
                    <iframe srcDoc={previewHtml} title="preview" sandbox="allow-same-origin" className="h-[520px] w-full bg-white" />
                    {form.attachment_name && !clearAttach && (
                      <div className="flex items-center gap-2 border-t border-[#e8eff3] bg-[#f7f9fb] px-5 py-3">
                        <svg className="h-4 w-4 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        <span className="text-[12px] text-[#0a2a3c]">{attachFile?.name || form.attachment_name}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </MainContent>
    </div>
  );
}
