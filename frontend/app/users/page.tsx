"use client";

import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
import Select from "../components/Select";
import { useAuth } from "../hooks/useAuth";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

interface UserRecord {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
  date_joined: string;
}

// Assignable roles — admin accounts are never created or granted from the UI.
const ROLES = [
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
];

/**
 * Users — Beacon's minimal Filament table: Name · Email · User type ·
 * Active icon, searchable, an Edit action per row, and a "New user" modal.
 */
export default function UsersPage() {
  const { user: authUser, loading: authLoading } = useAuth(["admin", "editor"]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  // New user modal
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ first_name: "", last_name: "", email: "", role: "editor" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Edit modal
  const [editing, setEditing] = useState<UserRecord | null>(null);
  const [editRole, setEditRole] = useState("viewer");
  const [savingEdit, setSavingEdit] = useState(false);
  const [resending, setResending] = useState(false);
  const [busyAction, setBusyAction] = useState<"" | "reset" | "active" | "delete">("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (authUser) fetchUsers();
  }, [authUser]); // eslint-disable-line react-hooks/exhaustive-deps

  function showToast(text: string, ok: boolean) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3500);
  }

  async function fetchUsers() {
    try {
      const res = await fetch(`${API}/users/`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) setUsers(data.users);
    } catch { /* */ }
    setLoaded(true);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      const res = await fetch(`${API}/users/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setShowCreate(false);
        setCreateForm({ first_name: "", last_name: "", email: "", role: "editor" });
        showToast(data.message, true);
        fetchUsers();
      } else {
        setCreateError(data.error || "Failed to create user");
      }
    } catch {
      setCreateError("Network error");
    }
    setCreating(false);
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`${API}/users/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: editing.id, role: editRole }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast("User saved", true);
        setEditing(null);
        fetchUsers();
      } else {
        showToast(data.error || "Could not save", false);
      }
    } catch {
      showToast("Network error", false);
    }
    setSavingEdit(false);
  }

  async function resendSetup() {
    if (!editing) return;
    setResending(true);
    try {
      const res = await fetch(`${API}/users/resend-setup/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: editing.id }),
        credentials: "include",
      });
      const data = await res.json();
      showToast(data.ok ? "Setup email sent again" : (data.error || "Could not send"), Boolean(data.ok));
    } catch {
      showToast("Network error", false);
    }
    setResending(false);
  }

  async function sendReset() {
    if (!editing) return;
    setBusyAction("reset");
    try {
      const res = await fetch(`${API}/users/send-reset/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: editing.id }),
        credentials: "include",
      });
      const data = await res.json();
      showToast(data.ok ? data.message : (data.error || "Could not send"), Boolean(data.ok));
    } catch {
      showToast("Network error", false);
    }
    setBusyAction("");
  }

  async function toggleActive() {
    if (!editing) return;
    setBusyAction("active");
    try {
      const res = await fetch(`${API}/users/set-active/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: editing.id, active: !editing.is_active }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast(data.message, true);
        setEditing(null);
        fetchUsers();
      } else showToast(data.error || "Could not change", false);
    } catch {
      showToast("Network error", false);
    }
    setBusyAction("");
  }

  async function deleteUser() {
    if (!editing) return;
    setBusyAction("delete");
    try {
      const res = await fetch(`${API}/users/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: editing.id }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        showToast("User deleted", true);
        setEditing(null);
        fetchUsers();
      } else showToast(data.error || "Could not delete", false);
    } catch {
      showToast("Network error", false);
    }
    setBusyAction("");
  }

  if (authLoading || !authUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <svg className="h-8 w-8 animate-spin text-[#054B70]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  const displayName = (u: UserRecord) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username;
  const q = search.trim().toLowerCase();
  const shown = users
    .filter((u) => !q || displayName(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <MainContent>
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div>
              <h1 className="text-[16px] font-bold text-gray-900">Users</h1>
            </div>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreateError(""); }}
            className="btn-press flex shrink-0 items-center gap-2 rounded-lg bg-[#054B70] px-3 py-2 text-[12px] font-bold text-white sm:px-5 sm:py-2.5"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4" /></svg>
            New user
          </button>
        </header>

        <main className="p-4 sm:p-8">
          {toast && (
            <div className={`mb-5 flex items-center gap-2 rounded-lg px-4 py-3 text-[13px] font-semibold animate-slide-in ${
              toast.ok ? "bg-[#054B70]/5 text-[#054B70]" : "bg-red-50 text-red-600"
            }`}>
              {toast.text}
            </div>
          )}

          {/* Filament-style table card */}
          <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-950/5">
            {/* Toolbar: search, right-aligned like Filament */}
            <div className="flex items-center justify-end gap-2 border-b border-gray-950/5 px-4 py-3">
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
              <p className="px-4 py-10 text-center text-[13px] text-gray-500">No users</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="border-b border-gray-950/5">
                      <th className="px-4 py-3 text-[13px] font-semibold text-gray-950">Name</th>
                      <th className="px-4 py-3 text-[13px] font-semibold text-gray-950">Email</th>
                      <th className="px-4 py-3 text-[13px] font-semibold text-gray-950">User type</th>
                      <th className="px-4 py-3 text-[13px] font-semibold text-gray-950">Active</th>
                      <th className="py-3 pl-4 pr-6 text-right text-[13px] font-semibold text-gray-950">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-950/5">
                    {shown.map((u) => (
                      <tr key={u.id} className="transition-colors hover:bg-gray-50">
                        <td className="px-4 py-3.5 text-[13px] text-gray-950">{displayName(u)}</td>
                        <td className="px-4 py-3.5 text-[13px] text-gray-950">{u.email}</td>
                        <td className="px-4 py-3.5 text-[13px] text-gray-950">{u.role.charAt(0).toUpperCase() + u.role.slice(1)}</td>
                        <td className="px-4 py-3.5">
                          {u.is_active ? (
                            <svg className="h-5 w-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          ) : (
                            <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          )}
                        </td>
                        <td className="py-3.5 pl-4 pr-6 text-right">
                          {(u.role !== "admin" || authUser?.is_superuser) && u.username !== authUser?.username ? (
                            <button
                              onClick={() => { setEditing(u); setEditRole(u.role); setConfirmDelete(false); }}
                              className="text-[13px] font-semibold text-[#054B70] hover:underline"
                            >
                              Edit
                            </button>
                          ) : (
                            <span
                              className="text-[13px] text-gray-400"
                              title={u.username === authUser?.username ? "This is you — your own account can't be changed here" : "Admin accounts are managed outside the app"}
                            >
                              —
                            </span>
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

      {/* New user modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setShowCreate(false)}>
          <form
            onSubmit={handleCreate}
            className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title="Close"
              aria-label="Close"
              onClick={() => setShowCreate(false)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
            <h2 className="mb-4 text-[16px] font-bold text-gray-900">New user</h2>

            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">First name<sup className="text-red-600">*</sup></label>
                <input
                  required
                  value={createForm.first_name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, first_name: e.target.value }))}
                  className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium text-gray-950">Last name</label>
                <input
                  value={createForm.last_name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, last_name: e.target.value }))}
                  className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none"
                />
              </div>
            </div>
            <label className="mb-1 block text-[13px] font-medium text-gray-950">Email<sup className="text-red-600">*</sup></label>
            <input
              required
              type="email"
              value={createForm.email}
              onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
              className="input-glow mb-3 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-900 outline-none"
            />
            <label className="mb-1 block text-[13px] font-medium text-gray-950">User type</label>
            <Select
              value={createForm.role}
              onChange={(v) => setCreateForm((f) => ({ ...f, role: v }))}
              options={ROLES}
              className="mb-1"
            />
            <p className="mb-4 text-[12px] text-gray-500">They&apos;ll get an email with a code to set their password.</p>

            {createError && <p className="mb-3 text-[12px] font-semibold text-red-600">{createError}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                type="submit"
                disabled={creating}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit user modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setEditing(null)}>
          <div className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              title="Close"
              aria-label="Close"
              onClick={() => setEditing(null)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
            <h2 className="mb-4 text-[16px] font-bold text-gray-900">Edit user</h2>

            <label className="mb-1 block text-[13px] font-medium text-gray-950">Name</label>
            <input
              value={displayName(editing)}
              readOnly
              className="mb-3 w-full cursor-default rounded-lg border border-gray-300 bg-gray-100 px-3 py-2.5 text-[13px] text-gray-500 outline-none"
            />
            <label className="mb-1 block text-[13px] font-medium text-gray-950">Email</label>
            <input
              value={editing.email}
              readOnly
              className="mb-3 w-full cursor-default rounded-lg border border-gray-300 bg-gray-100 px-3 py-2.5 text-[13px] text-gray-500 outline-none"
            />
            <label className="mb-1 block text-[13px] font-medium text-gray-950">User type</label>
            <Select
              value={editRole}
              onChange={setEditRole}
              options={authUser?.is_superuser ? [...ROLES, { value: "admin", label: "Admin" }] : ROLES}
              className="mb-4"
            />

            {!editing.is_active && (
              <button
                type="button"
                onClick={resendSetup}
                disabled={resending}
                className="mb-4 rounded-lg border border-gray-300 bg-white px-4 py-2 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {resending ? "Sending…" : "Resend setup email"}
              </button>
            )}

            {/* Account actions: reset password, deactivate, delete */}
            <div className="mb-4 rounded-lg border border-gray-200 p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">Account actions</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={sendReset}
                  disabled={busyAction === "reset"}
                  className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {busyAction === "reset" ? "Sending…" : "Send password reset"}
                </button>
                <button
                  type="button"
                  onClick={toggleActive}
                  disabled={busyAction === "active"}
                  className={`rounded-lg border px-3.5 py-2 text-[12px] font-semibold disabled:opacity-50 ${
                    editing.is_active
                      ? "border-amber-500/40 bg-white text-amber-700 hover:bg-amber-50"
                      : "border-emerald-500/40 bg-white text-emerald-700 hover:bg-emerald-50"
                  }`}
                >
                  {busyAction === "active" ? "Working…" : editing.is_active ? "Deactivate" : "Reactivate"}
                </button>
                {authUser?.role === "admin" && (
                  confirmDelete ? (
                    <button
                      type="button"
                      onClick={deleteUser}
                      disabled={busyAction === "delete"}
                      className="rounded-lg bg-red-600 px-3.5 py-2 text-[12px] font-bold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {busyAction === "delete" ? "Deleting…" : "Really delete? This is permanent"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-lg border border-red-500/40 bg-white px-3.5 py-2 text-[12px] font-semibold text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  )
                )}
              </div>
              <p className="mt-2 text-[11px] text-gray-500">
                Reset emails them a code for the set-password page. Deactivated accounts can&apos;t sign in until reactivated. Delete removes the account for good.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="rounded-lg px-4 py-2.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
              <button
                onClick={saveEdit}
                disabled={savingEdit}
                className="btn-press rounded-lg bg-[#054B70] px-6 py-2.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {savingEdit ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
