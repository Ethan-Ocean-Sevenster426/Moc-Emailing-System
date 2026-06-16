"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8000/api";

function SetPasswordForm() {
  const searchParams = useSearchParams();
  const purpose = searchParams.get("purpose") || "reset"; // "reset" or "setup"
  const prefillEmail = searchParams.get("email") || "";

  const [email, setEmail] = useState(prefillEmail);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    const endpoint = purpose === "setup" ? "set-password" : "reset-password";
    try {
      const res = await fetch(`${API}/auth/${endpoint}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, new_password: newPassword }),
        credentials: "include",
      });
      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
      } else {
        setError(data.error || "Something went wrong");
      }
    } catch {
      setError("Could not connect to the server.");
    }
    setLoading(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f0f4f7]">
      <div className="w-full max-w-[420px] animate-fade-in-up">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#054B70] shadow-lg shadow-[#054B70]/20">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-[20px] font-bold text-[#0a2a3c]">Magnum Opus Consultants</h1>
          <p className="mt-1 text-[13px] text-[#8ca3b3]">
            {purpose === "setup" ? "Set Up Your Account" : "Reset Your Password"}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-white p-8 shadow-sm">
          {success ? (
            <div className="animate-fade-in text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#054B70]/8 animate-scale-in">
                <svg className="h-7 w-7 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="mb-2 text-[16px] font-bold text-[#0a2a3c]">Password Set Successfully</h2>
              <p className="mb-6 text-[13px] text-[#8ca3b3]">
                You can now sign in with your new password.
              </p>
              <Link
                href="/"
                className="btn-press inline-flex items-center gap-2 rounded-xl bg-[#054B70] px-6 py-3 text-[14px] font-bold text-white"
              >
                Go to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="animate-fade-in">
              <h2 className="mb-1 text-[16px] font-bold text-[#0a2a3c]">
                {purpose === "setup" ? "Set Your Password" : "Reset Password"}
              </h2>
              <p className="mb-6 text-[13px] text-[#8ca3b3]">
                Enter the code you received via email along with your new password.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    Email Address
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    Verification Code
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                    className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-center font-mono text-[18px] font-bold tracking-[0.3em] text-[#0a2a3c] placeholder-[#d0dce4] outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    New Password
                  </label>
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#8ca3b3]">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat your password"
                    className="input-glow w-full rounded-xl border border-[#d0dce4] bg-[#f7f9fb] px-4 py-3 text-sm text-[#0a2a3c] placeholder-[#b0c4d0] outline-none"
                  />
                </div>
              </div>

              {error && (
                <div className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-[13px] font-medium text-red-600">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="btn-press mt-6 w-full rounded-xl bg-[#054B70] py-3 text-[14px] font-bold text-white disabled:opacity-50"
              >
                {loading ? "Setting password..." : "Set Password"}
              </button>

              <div className="mt-4 text-center">
                <Link href="/" className="text-[12px] font-medium text-[#054B70] hover:underline">
                  Back to login
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
