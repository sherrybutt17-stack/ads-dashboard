"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SignOut() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * 🔴 Navigating away is the dangerous part, so it only happens on success.
   *
   * This was `await fetch(...).catch(() => {})` followed by an unconditional
   * `router.push("/login")`. A network blip or a 500 from the route was
   * swallowed, the browser landed on the sign-in page, and the person walked
   * away believing they had signed out — while the session cookie was still
   * valid and the back button, or typing `/`, returned them straight into the
   * dashboard. On a shared machine that is the whole of the risk, and it was
   * manufactured by the UI rather than reported by it.
   *
   * `res.ok` is checked as well as the throw: a failing route answers with a
   * response, not an exception, so `.catch` alone never sees it.
   */
  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/logout", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      router.push("/login");
      router.refresh();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {failed && (
        <span
          role="alert"
          className="text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          Sign-out failed — you are still signed in. Try again.
        </span>
      )}
      <button
        onClick={signOut}
        disabled={busy}
        className="rounded-[9px] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-60"
        style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
