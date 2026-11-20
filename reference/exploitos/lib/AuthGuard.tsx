"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthContext";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  // While Firebase resolves the session, show nothing (avoids flash)
  if (loading) {
    return (
      <div className="auth-loading">
        <div className="spinner tracing-spinner" />
      </div>
    );
  }

  // Not logged in — the redirect is in flight, render nothing
  if (!user) return null;

  return <>{children}</>;
}
