"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const API = "http://localhost:8000/api";

export interface AuthUser {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  role: "admin" | "editor" | "viewer";
}

export function useAuth(requiredRole?: string | string[]) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch(`${API}/auth/me/`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Not authenticated");
        return res.json();
      })
      .then((data) => {
        if (requiredRole) {
          const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
          if (!roles.includes(data.role)) {
            router.replace("/email-templates");
            return;
          }
        }
        setUser(data);
      })
      .catch(() => {
        router.replace("/");
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { user, loading };
}
