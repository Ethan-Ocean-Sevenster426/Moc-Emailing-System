"use client";

import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import RichTextEditor from "../components/RichTextEditor";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

const DEFAULT_OPT_OUT_TEXT =
  "If you'd prefer not to receive further communication from us, you can opt out here.";

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

const EMPTY_FORM = {
  name: "",
  subject: "",
  body_html: "",
  body: "",
  signature: "",
  opt_out_text: DEFAULT_OPT_OUT_TEXT,
  attachment_name: "",
  signature_image_name: "",
};

/** Filament's dateTime column format: "Aug 8, 2026 23:12". */
function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Template Library — Beacon's Filament table (Name · Subject · Updated at,
 * Edit/Delete per row) with the wide "Content + Live preview" editor modal.
 */
export default function TemplateLibraryPage() {
  const { user, loading: authLoading } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "editor";

  const [templates, setTemplates] = useState<LibraryTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "updated_at">("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  // Editor modal — null closed, 0 = new, otherwise the template id being edited
  const [editorFor, setEditorFor] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [pendingAttach, setPendingAttach] = useState<File | null>(null);
  const [pendingSig, setPendingSig] = useState<File | null>(null);
  const [clearAttach, setClearAttach] = useState(false);
  const [clearSig, setClearSig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteFor, setDeleteFor] = useState<LibraryTemplate | null>(null);

  useEffect(() => {
    fetchTemplates();
  }, []);

  function showToast(text: string, ok: boolean) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3500);
  }

  async function fetchTemplates() {
    try {
      const res = await fetch(`${API}/templates-library/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setTemplates(data.templates);
    } catch { /* */ }
    setLoaded(true);
  }

  function openNew() {
    setForm({ ...EMPTY_FORM });
    setPendingAttach(null);
    setPendingSig(null);
    setClearAttach(false);
    setClearSig(false);
    setEditorFor(0);
  }

  function openEdit(t: LibraryTemplate) {
    setForm({
      name: t.name,
      subject: t.subject,
      body_html: t.body_html,
      body: t.body,
      signature: t.signature,
      opt_out_text: t.opt_out_text,
      attachment_name: t.attachment_name,
      signature_image_name: t.signature_image_name,
    });
    setPendingAttach(null);
    setPendingSig(null);
    setClearAttach(false);
    setClearSig(false);
    setEditorFor(t.id);
  }

  async function save() {
    if (!form.name.trim() || !form.subject.trim()) {
      showToast("Name and subject are required", false);
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      if (editorFor) fd.append("id", String(editorFor));
      fd.append("name", form.name.trim());
      fd.append("subject", form.subject);
      fd.append("body_html", form.body_html);
      fd.append("body", form.body);
      fd.append("signature", form.signature);
      fd.append("opt_out_text", form.opt_out_text);
      if (pendingAttach) fd.append("attachment", pendingAttach);
      if (clearAttach) fd.append("clear_attachment", "1");
      if (pendingSig) fd.append("signature_image", pendingSig);
      if (clearSig) fd.append("clear_signature_image", "1");
      const res = await fetch(`${API}/templates-library/save/`, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setEditorFor(null);
        showToast(editorFor ? "Saved" : "Created", true);
        fetchTemplates();
      } else {
        showToast(data.error || "Could not save", false);
      }
    } catch {
      showToast("Network error", false);
    }
    setSaving(false);
  }

  async function doDelete() {
    if (!deleteFor) return;
    try {
      await fetch(`${API}/templates-library/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteFor.id }),
        credentials: "include",
      });
      setDeleteFor(null);
      showToast("Deleted", true);
      fetchTemplates();
    } catch {
      showToast("Could not delete", false);
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
  const shown = templates
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q))
    .sort((a, b) => {
      const cmp = sortBy === "name" ? a.name.localeCompare(b.name) : a.updated_at.localeCompare(b.updated_at);
      return sortDesc ? -cmp : cmp;
    });

  function headerSort(col: "name" | "updated_at") {
    if (sortBy === col) setSortDesc(!sortDesc);
    else { setSortBy(col); setSortDesc(false); }
  }

  const sigShowing = !clearSig && (pendingSig || form.signature_image_name);
  const attachShowing = !clearAttach && (pendingAttach || form.attachment_name);

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <h1 className="text-[16px] font-bold text-gray-900">Email Templates</h1>
          </div>
          {canEdit && (
            <button
              onClick={openNew}
              className="btn-press flex shrink-0 items-center gap-2 rounded-lg bg-[#054B70] px-3 py-2 text-[12px] font-bold text-white sm:px-5 sm:py-2.5"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
              New Template
            </button>
          )}
        </header>

        <main className="p-4 sm:p-8">
          {toast && (
            <div className={`mb-5 rounded-lg px-4 py-3 text-[13px] font-semibold animate-slide-in ${
              toast.ok ? "bg-[#054B70]/5 text-[#054B70]" : "bg-red-50 text-red-600"
            }`}>
              {toast.text}
            </div>
          )}

          <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
            <div className="flex items-center justify-end border-b border-gray-950/5 px-4 py-3">
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
            </div>

            {!loaded ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-10 rounded-lg bg-gradient-to-r from-gray-100 via-white to-gray-100 bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-gray-500">No email templates</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="border-b border-gray-950/5">
                      <th className="px-4 py-3">
                        <button onClick={() => headerSort("name")} className="flex items-center gap-1 text-[13px] font-semibold text-gray-950">
                          Name {sortBy === "name" && <span className="text-gray-400">{sortDesc ? "↓" : "↑"}</span>}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-[13px] font-semibold text-gray-950">Subject</th>
                      <th className="px-4 py-3">
                        <button onClick={() => headerSort("updated_at")} className="flex items-center gap-1 text-[13px] font-semibold text-gray-950">
                          Updated at {sortBy === "updated_at" && <span className="text-gray-400">{sortDesc ? "↓" : "↑"}</span>}
                        </button>
                      </th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-950/5">
                    {shown.map((t) => (
                      <tr key={t.id} className="transition-colors hover:bg-gray-50">
                        <td className="px-4 py-3.5 text-[13px] text-gray-950">{t.name}</td>
                        <td className="px-4 py-3.5 text-[13px] text-gray-950">
                          {t.subject ? (t.subject.length > 50 ? `${t.subject.slice(0, 50)}…` : t.subject) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3.5 text-[13px] text-gray-950">{dateTime(t.updated_at)}</td>
                        <td className="px-4 py-3.5 text-right">
                          {canEdit && (
                            <div className="flex justify-end gap-3">
                              <button onClick={() => openEdit(t)} className="text-[13px] font-semibold text-[#054B70] hover:underline">Edit</button>
                              <button onClick={() => setDeleteFor(t)} className="text-[13px] font-semibold text-red-600 hover:underline">Delete</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </MainContent>

      {/* Delete confirmation */}
      {deleteFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setDeleteFor(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-[16px] font-bold text-gray-900">Delete &ldquo;{deleteFor.name}&rdquo;?</h2>
            <p className="mb-5 text-[12px] text-gray-500">Are you sure you would like to do this?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteFor(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={doDelete} className="btn-press rounded-lg bg-red-600 px-6 py-2.5 text-[12px] font-bold text-white hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Template editor — Beacon's 7xl "Content + Live preview" modal */}
      {editorFor !== null && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30 p-4 backdrop-blur-sm animate-fade-in" onClick={() => setEditorFor(null)}>
          <div className="mx-auto my-4 w-full max-w-[80rem] rounded-xl bg-white shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="relative border-b border-gray-950/5 px-6 py-4 pr-14">
              <button
                type="button"
                title="Close"
                aria-label="Close"
                onClick={() => setEditorFor(null)}
                className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
              </button>
              <h2 className="text-[16px] font-bold text-gray-950">{editorFor ? "Edit Template" : "Create Template"}</h2>
            </div>

            <div className="p-6">
              {/* Name — full width */}
              <div className="mb-5">
                <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Name<sup className="font-medium text-red-600">*</sup></label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={300}
                  className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                {/* Section: Content */}
                <div className="xl:col-span-2">
                  <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
                    <div className="border-b border-gray-950/5 px-6 py-4">
                      <h3 className="text-[15px] font-semibold text-gray-950">Content</h3>
                    </div>
                    <div className="space-y-5 p-6">
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Subject<sup className="font-medium text-red-600">*</sup></label>
                        <input
                          value={form.subject}
                          onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                          maxLength={500}
                          className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Email body (HTML)</label>
                        <RichTextEditor
                          value={form.body_html}
                          onChange={(html) => setForm((f) => ({ ...f, body_html: html }))}
                          minHeight="4rem"
                        />
                        <p className="mt-1.5 text-[12px] text-gray-500">{"Variables: {{org_name}}, {{contact_name}}, {{email}}, {{phone}}, {{opt_out}}"}</p>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Plain-text fallback</label>
                        <textarea
                          rows={3}
                          value={form.body}
                          onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                          className="input-glow w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Signature</label>
                        <textarea
                          rows={3}
                          value={form.signature}
                          onChange={(e) => setForm((f) => ({ ...f, signature: e.target.value }))}
                          className="input-glow w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Opt-out sentence</label>
                        <textarea
                          rows={2}
                          value={form.opt_out_text}
                          onChange={(e) => setForm((f) => ({ ...f, opt_out_text: e.target.value }))}
                          className="input-glow w-full resize-y rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-[13px] text-gray-900 outline-none"
                        />
                      </div>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Attachment</label>
                          {!attachShowing ? (
                            <label className="flex cursor-pointer items-center justify-center rounded-xl border border-gray-300 bg-gray-50 px-4 py-7 text-[13px] text-gray-500 transition-colors hover:bg-gray-100">
                              <span>Drag &amp; Drop your files or <span className="font-semibold text-[#054B70]">Browse</span></span>
                              <input
                                type="file"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) { setPendingAttach(f); setClearAttach(false); }
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          ) : (
                            <div className="flex items-center gap-3 rounded-lg border border-[#054B70]/15 bg-[#054B70]/5 px-3 py-3">
                              <span className="flex-1 truncate text-[12px] font-medium text-gray-900">{pendingAttach?.name || form.attachment_name}</span>
                              <button
                                onClick={() => { setPendingAttach(null); setClearAttach(true); }}
                                className="rounded-full p-1.5 text-gray-500 transition-all hover:bg-red-50 hover:text-red-500"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[13px] font-medium text-gray-950">Signature image</label>
                          {!sigShowing ? (
                            <label className="flex cursor-pointer items-center justify-center rounded-xl border border-gray-300 bg-gray-50 px-4 py-7 text-[13px] text-gray-500 transition-colors hover:bg-gray-100">
                              <span>Drag &amp; Drop your files or <span className="font-semibold text-[#054B70]">Browse</span></span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) { setPendingSig(f); setClearSig(false); }
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          ) : (
                            <div className="flex items-center gap-3 rounded-lg border border-[#054B70]/15 bg-[#054B70]/5 px-3 py-3">
                              <span className="flex-1 truncate text-[12px] font-medium text-gray-900">{pendingSig?.name || form.signature_image_name}</span>
                              <button
                                onClick={() => { setPendingSig(null); setClearSig(true); }}
                                className="rounded-full p-1.5 text-gray-500 transition-all hover:bg-red-50 hover:text-red-500"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section: Live preview */}
                <div>
                  <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
                    <div className="border-b border-gray-950/5 px-6 py-4">
                      <h3 className="text-[15px] font-semibold text-gray-950">Live preview</h3>
                    </div>
                    <div className="p-6">
                      <div style={{ border: "1px solid rgba(120,120,120,.22)", borderRadius: ".6rem", overflow: "hidden" }}>
                        <div style={{ padding: ".6rem .9rem", borderBottom: "1px solid rgba(120,120,120,.2)", fontSize: ".8rem", color: "#6b7280" }}>
                          <strong>Subject:</strong>{" "}
                          {form.subject.trim() !== "" ? form.subject : <span style={{ color: "#9ca3af" }}>(no subject)</span>}
                        </div>
                        <div className="beacon-body-editor" style={{ padding: "1rem .9rem", background: "#fff", color: "#111827", lineHeight: 1.5, minHeight: "8rem" }}>
                          <div dangerouslySetInnerHTML={{ __html: form.body_html }} />
                          {form.signature.trim() !== "" && (
                            <>
                              <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid rgba(120,120,120,.25)" }} />
                              <div style={{ whiteSpace: "pre-line" }}>{form.signature}</div>
                            </>
                          )}
                          {form.opt_out_text.trim() !== "" && (
                            <p style={{ marginTop: "1.25rem", color: "#9ca3af", fontSize: ".8rem" }}>{form.opt_out_text}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-950/5 px-6 py-4">
              <button
                onClick={save}
                disabled={saving}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {saving ? "Saving…" : editorFor ? "Save" : "Create"}
              </button>
              <button
                onClick={() => setEditorFor(null)}
                className="rounded-lg bg-white px-5 py-2.5 text-[12px] font-semibold text-gray-700 shadow-sm ring-1 ring-gray-950/10 transition-colors hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
