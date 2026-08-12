"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const API = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api`;

export default function LoginPage() {
  const [step, setStep] = useState<"credentials" | "forgot">("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const res = await fetch(`${API}/login/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });
      const data = await res.json();

      if (res.ok) {
        router.push("/campaign-groups");
      } else {
        setError(data.error || "Login failed");
      }
    } catch {
      setError("Could not connect to the server.");
    }
    setLoading(false);
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const res = await fetch(`${API}/auth/forgot-password/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
        credentials: "include",
      });
      const data = await res.json();

      if (res.ok) {
        router.push(`/set-password?purpose=reset&email=${encodeURIComponent(forgotEmail)}`);
      } else {
        setError(data.error || "Failed to send reset code");
      }
    } catch {
      setError("Could not connect to the server.");
    }
    setLoading(false);
  }

  function backToLogin() {
    setStep("credentials");
    setError("");
    setMessage("");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-[420px] animate-fade-in-up">
        {/* Logo */}
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/moc-logo-light.png"
            alt="Magnum Opus Consultants"
            className="moc-logo mx-auto mb-4 h-12 w-auto"
          />
          <p className="mt-1 text-[13px] text-gray-500">Email Management System</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-8 shadow-sm ring-1 ring-gray-950/5">

          {/* ── STEP 1: Credentials ── */}
          {step === "credentials" && (
            <form onSubmit={handleLogin} className="animate-fade-in">
              <h2 className="mb-1 text-[16px] font-bold text-gray-900">Sign In</h2>
              <p className="mb-6 text-[13px] text-gray-500">Enter your credentials to continue</p>

              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-500">
                    Email
                  </label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="you@moc-pty.com"
                    className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-500">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none"
                  />
                </div>
              </div>

              {error && (
                <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-[13px] font-medium text-red-600">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-press mt-6 w-full rounded-lg bg-[#054B70] py-3 text-[14px] font-bold text-white disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Signing in...
                  </span>
                ) : (
                  "Sign In"
                )}
              </button>

              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => { setStep("forgot"); setError(""); }}
                  className="text-[12px] font-medium text-[#054B70] hover:underline"
                >
                  Forgot password?
                </button>
                <Link
                  href="/set-password?purpose=setup"
                  className="text-[12px] font-medium text-gray-500 hover:text-[#054B70] hover:underline"
                >
                  Set up account
                </Link>
              </div>
            </form>
          )}

          {/* ── STEP 2: Forgot Password ── */}
          {step === "forgot" && (
            <form onSubmit={handleForgotPassword} className="animate-fade-in">
              <button
                type="button"
                onClick={backToLogin}
                className="mb-4 flex items-center gap-1.5 text-[12px] font-medium text-gray-500 transition-colors hover:text-[#054B70]"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M15 19l-7-7 7-7" />
                </svg>
                Back to login
              </button>

              <h2 className="mb-1 text-[16px] font-bold text-gray-900">Reset Password</h2>
              <p className="mb-6 text-[13px] text-gray-500">
                Enter your email address and we&apos;ll send you a reset code.
              </p>

              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="input-glow w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none"
                />
              </div>

              {error && (
                <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-[13px] font-medium text-red-600">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-press mt-6 w-full rounded-lg bg-[#054B70] py-3 text-[14px] font-bold text-white disabled:opacity-50"
              >
                {loading ? "Sending..." : "Send Reset Code"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
