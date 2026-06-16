"use client";

import { useState, useEffect } from "react";
import Sidebar from "../components/Sidebar";
import MainContent from "../components/MainContent";
import MobileMenuButton from "../components/MobileMenuButton";
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
  jobs_started?: number;
  emails_sent?: number;
  emails_failed?: number;
  last_activity?: string | null;
}

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-[#054B70]/10 text-[#054B70]",
  editor: "bg-[#94bccc]/20 text-[#054B70]",
  viewer: "bg-[#f0f4f7] text-[#8ca3b3]",
};

const ROLE_DESC: Record<string, string> = {
  admin: "Full access + user management",
  editor: "Edit templates + send emails",
  viewer: "View-only access",
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function UsersPage() {
  const { user: authUser, loading: authLoading } = useAuth("admin");
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ first_name: "", last_name: "", email: "", role: "viewer" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [editingRole, setEditingRole] = useState<number | null>(null);

  useEffect(() => {
    if (authUser) fetchUsers();
  }, [authUser]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchUsers() {
    try {
      // Fetch users + stats in parallel
      const [usersRes, statsRes] = await Promise.all([
        fetch(`${API}/users/`, { credentials: "include" }),
        fetch(`${API}/users/stats/`, { credentials: "include" }),
      ]);
      const usersData = await usersRes.json();
      const statsData = await statsRes.json();

      if (usersData.ok && statsData.ok) {
        // Merge stats into user records
        const statsMap = new Map<number, UserRecord>();
        for (const s of statsData.users) {
          statsMap.set(s.id, s);
        }
        const merged = usersData.users.map((u: UserRecord) => {
          const stats = statsMap.get(u.id);
          return {
            ...u,
            jobs_started: stats?.jobs_started ?? 0,
            emails_sent: stats?.emails_sent ?? 0,
            emails_failed: stats?.emails_failed ?? 0,
            last_activity: stats?.last_activity ?? null,
          };
        });
        setUsers(merged);
      } else if (usersData.ok) {
        setUsers(usersData.users);
      }
    } catch { /* ignore */ }
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
        setCreateForm({ first_name: "", last_name: "", email: "", role: "viewer" });
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

  async function handleUpdateRole(userId: number, newRole: string) {
    try {
      const res = await fetch(`${API}/users/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, role: newRole }),
        credentials: "include",
      });
      const data = await res.json();

      if (data.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
        showToast("Role updated", true);
      } else {
        showToast(data.error || "Failed to update role", false);
      }
    } catch {
      showToast("Network error", false);
    }
    setEditingRole(null);
  }

  async function handleDelete(userId: number) {
    try {
      const res = await fetch(`${API}/users/delete/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
        credentials: "include",
      });
      const data = await res.json();

      if (data.ok) {
        setUsers((prev) => prev.filter((u) => u.id !== userId));
        showToast("User deleted", true);
      } else {
        showToast(data.error || "Failed to delete user", false);
      }
    } catch {
      showToast("Network error", false);
    }
    setDeleteConfirm(null);
  }

  async function handleResendSetup(userId: number) {
    try {
      const res = await fetch(`${API}/users/resend-setup/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
        credentials: "include",
      });
      const data = await res.json();

      if (data.ok) {
        showToast("Setup email resent", true);
      } else {
        showToast(data.error || "Failed to resend", false);
      }
    } catch {
      showToast("Network error", false);
    }
  }

  function showToast(text: string, ok: boolean) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  }

  // Summary stats
  const totalUsers = users.length;
  const adminCount = users.filter((u) => u.role === "admin").length;
  const editorCount = users.filter((u) => u.role === "editor").length;
  const viewerCount = users.filter((u) => u.role === "viewer").length;
  const totalEmailsSent = users.reduce((a, u) => a + (u.emails_sent || 0), 0);

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

      <MainContent>
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#e0e8ee] bg-white/80 px-4 py-3 backdrop-blur-md sm:px-8 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton />
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold text-[#0a2a3c]">User Management</h1>
              <p className="truncate text-[11px] text-[#8ca3b3]">Manage team members, roles, and activity</p>
            </div>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreateError(""); }}
            className="btn-press flex shrink-0 items-center gap-2 rounded-xl bg-[#054B70] px-3 py-2 text-[12px] font-bold text-white sm:px-5 sm:py-2.5"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 4v16m8-8H4" />
            </svg>
            <span className="hidden sm:inline">Add User</span>
            <span className="sm:hidden">Add</span>
          </button>
        </header>

        <main className="p-4 sm:p-8">
          {/* Toast */}
          {toast && (
            <div className={`mb-5 flex items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold animate-slide-in ${
              toast.ok ? "bg-[#054B70]/5 text-[#054B70]" : "bg-red-50 text-red-600"
            }`}>
              {toast.ok ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              {toast.text}
            </div>
          )}

          {/* Summary cards */}
          {loaded && users.length > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5 animate-fade-in">
              {[
                { label: "Total Users", value: totalUsers, color: "text-[#054B70]", bg: "bg-[#054B70]/5", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" },
                { label: "Admins", value: adminCount, color: "text-[#054B70]", bg: "bg-[#054B70]/10", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
                { label: "Editors", value: editorCount, color: "text-[#054B70]", bg: "bg-[#94bccc]/20", icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
                { label: "Viewers", value: viewerCount, color: "text-[#8ca3b3]", bg: "bg-[#f0f4f7]", icon: "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" },
                { label: "Total Emails Sent", value: totalEmailsSent, color: "text-emerald-600", bg: "bg-emerald-50", icon: "M12 19l9 2-9-18-9 18 9-2zm0 0v-8" },
              ].map((card) => (
                <div key={card.label} className="rounded-2xl bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${card.bg}`}>
                      <svg className={`h-5 w-5 ${card.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d={card.icon} />
                      </svg>
                    </div>
                    <div>
                      <p className={`text-[22px] font-bold ${card.color}`}>{card.value}</p>
                      <p className="text-[10px] font-semibold text-[#8ca3b3] uppercase tracking-wider">{card.label}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Users table */}
          {!loaded ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-[72px] rounded-2xl bg-white shadow-sm">
                  <div className="h-full rounded-2xl bg-gradient-to-r from-[#f0f4f7] via-white to-[#f0f4f7] bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
                </div>
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="card-hover flex items-center justify-center rounded-2xl bg-white px-6 py-20 shadow-sm animate-fade-in-up">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#054B70]/8">
                  <svg className="h-7 w-7 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <p className="text-[15px] font-semibold text-[#0a2a3c]">No users yet</p>
                <p className="mt-1.5 text-[13px] text-[#8ca3b3]">Click &quot;Add User&quot; to create the first team member.</p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-white shadow-sm animate-fade-in-up overflow-hidden -mx-4 sm:mx-0">
              <div className="overflow-x-auto">
              <div className="min-w-[820px]">
              {/* Table header */}
              <div className="grid grid-cols-[1fr_1fr_110px_90px_100px_100px_100px_120px] gap-3 border-b border-[#e0e8ee] px-6 py-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Name</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Email</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Role</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Status</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Emails Sent</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Jobs</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3]">Last Active</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8ca3b3] text-right">Actions</span>
              </div>

              {/* Table rows */}
              {users.map((u, i) => {
                const isMe = u.username === authUser?.username;
                return (
                  <div
                    key={u.id}
                    className={`grid grid-cols-[1fr_1fr_110px_90px_100px_100px_100px_120px] gap-3 items-center px-6 py-4 transition-colors hover:bg-[#f7f9fb] animate-fade-in-up ${
                      i < users.length - 1 ? "border-b border-[#f0f4f7]" : ""
                    }`}
                    style={{ animationDelay: `${0.03 * i}s` }}
                  >
                    {/* Name */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#054B70]/8 text-[12px] font-bold text-[#054B70]">
                        {u.first_name?.[0]?.toUpperCase() || u.email[0].toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-[#0a2a3c]">
                          {u.first_name} {u.last_name}
                          {isMe && <span className="ml-1.5 text-[10px] font-medium text-[#8ca3b3]">(you)</span>}
                        </p>
                        <p className="truncate text-[11px] text-[#8ca3b3]">@{u.username}</p>
                      </div>
                    </div>

                    {/* Email */}
                    <p className="truncate text-[13px] text-[#6b8a9e]">{u.email}</p>

                    {/* Role */}
                    {editingRole === u.id ? (
                      <select
                        defaultValue={u.role}
                        onChange={(e) => handleUpdateRole(u.id, e.target.value)}
                        onBlur={() => setEditingRole(null)}
                        autoFocus
                        className="rounded-lg border border-[#d0dce4] bg-[#f7f9fb] px-2 py-1 text-[12px] text-[#0a2a3c] outline-none focus:border-[#054B70]"
                      >
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    ) : (
                      <button
                        onClick={() => !isMe && setEditingRole(u.id)}
                        className={`w-fit rounded-full px-3 py-1 text-[11px] font-semibold capitalize ${ROLE_BADGE[u.role] || ROLE_BADGE.viewer} ${
                          !isMe ? "cursor-pointer transition-opacity hover:opacity-70" : "cursor-default"
                        }`}
                        title={isMe ? "Cannot change your own role" : `Click to change role · ${ROLE_DESC[u.role]}`}
                      >
                        {u.role}
                      </button>
                    )}

                    {/* Status */}
                    <span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                      u.is_active ? "bg-green-50 text-green-600" : "bg-[#f0f4f7] text-[#a0b4c0]"
                    }`}>
                      {u.is_active ? "Active" : "Inactive"}
                    </span>

                    {/* Emails Sent */}
                    <div>
                      <p className="text-[13px] font-bold text-[#0a2a3c]">{u.emails_sent ?? 0}</p>
                      {(u.emails_failed ?? 0) > 0 && (
                        <p className="text-[10px] text-red-400">{u.emails_failed} failed</p>
                      )}
                    </div>

                    {/* Jobs */}
                    <p className="text-[13px] font-medium text-[#4a6a7a]">{u.jobs_started ?? 0}</p>

                    {/* Last Active */}
                    <p className="text-[12px] text-[#8ca3b3]">
                      {u.last_activity ? timeAgo(u.last_activity) : "Never"}
                    </p>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-1.5">
                      {deleteConfirm === u.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(u.id)}
                            className="rounded-lg bg-red-500 px-2.5 py-1.5 text-[10px] font-bold text-white transition-colors hover:bg-red-600"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="rounded-lg bg-[#f0f4f7] px-2.5 py-1.5 text-[10px] font-semibold text-[#6b8a9e]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => handleResendSetup(u.id)}
                            title="Resend setup email"
                            className="rounded-lg p-1.5 text-[#8ca3b3] transition-colors hover:bg-[#054B70]/5 hover:text-[#054B70]"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                              <polyline points="22,6 12,13 2,6" />
                            </svg>
                          </button>
                          {!isMe && (
                            <button
                              onClick={() => setDeleteConfirm(u.id)}
                              title="Delete user"
                              className="rounded-lg p-1.5 text-[#8ca3b3] transition-colors hover:bg-red-50 hover:text-red-500"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
              </div>
            </div>
          )}

          {/* Role legend */}
          {loaded && users.length > 0 && (
            <div className="mt-6 rounded-2xl bg-white p-5 shadow-sm animate-fade-in-up" style={{ animationDelay: "0.15s" }}>
              <h3 className="text-[12px] font-bold text-[#0a2a3c] mb-3">Role Permissions</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  { role: "Admin", desc: "Full access to all features including user management, email templates, contacts, sending, and reporting", badge: ROLE_BADGE.admin },
                  { role: "Editor", desc: "Can edit email templates, manage contacts, send emails, and view reporting. Cannot manage users", badge: ROLE_BADGE.editor },
                  { role: "Viewer", desc: "Read-only access to email templates and reporting. Cannot edit, send, or manage anything", badge: ROLE_BADGE.viewer },
                ].map((r) => (
                  <div key={r.role} className="rounded-xl border border-[#f0f4f7] p-4">
                    <span className={`inline-block rounded-full px-3 py-1 text-[11px] font-semibold ${r.badge}`}>{r.role}</span>
                    <p className="mt-2 text-[11px] text-[#6b8a9e] leading-relaxed">{r.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </MainContent>

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-[440px] rounded-2xl bg-white p-8 shadow-xl animate-scale-in">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-[16px] font-bold text-[#0a2a3c]">Add New User</h2>
                <p className="mt-0.5 text-[12px] text-[#8ca3b3]">They&apos;ll receive an email to set their password</p>
              </div>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg p-1.5 text-[#8ca3b3] transition-colors hover:bg-[#f0f4f7] hover:text-[#0a2a3c]"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    First Name
                  </label>
                  <input
                    type="text"
                    required
                    value={createForm.first_name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, first_name: e.target.value }))}
                    placeholder="John"
                    className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    Last Name
                  </label>
                  <input
                    type="text"
                    value={createForm.last_name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, last_name: e.target.value }))}
                    placeholder="Doe"
                    className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={createForm.email}
                  onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="john@example.com"
                  className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                  Role
                </label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value }))}
                  className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] outline-none"
                >
                  <option value="viewer">Viewer — can view templates (read-only)</option>
                  <option value="editor">Editor — can edit and send templates</option>
                  <option value="admin">Admin — full access including user management</option>
                </select>
              </div>

              {createError && (
                <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-[13px] font-medium text-red-600">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {createError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="flex-1 rounded-xl border border-[#d0dce4] py-3 text-[13px] font-semibold text-[#6b8a9e] transition-colors hover:bg-[#f0f4f7]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn-press flex-1 rounded-xl bg-[#054B70] py-3 text-[13px] font-bold text-white disabled:opacity-50"
                >
                  {creating ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Creating...
                    </span>
                  ) : (
                    "Create User"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
