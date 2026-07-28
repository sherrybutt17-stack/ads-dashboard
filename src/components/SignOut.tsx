"use client";

import { useRouter } from "next/navigation";

export function SignOut() {
  const router = useRouter();
  async function signOut() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={signOut}
      className="rounded-[9px] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
      style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
    >
      Sign out
    </button>
  );
}
