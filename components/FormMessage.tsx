"use client";

import type { ActionResult } from "@/app/actions";

export function FormMessage({ res }: { res: ActionResult | null }) {
  if (!res) return null;
  return (
    <p
      role="status"
      className={
        "rounded-md border px-3 py-2 text-sm " +
        (res.ok
          ? "border-positive/40 text-positive"
          : "border-danger/50 text-danger")
      }
    >
      {res.message}
    </p>
  );
}
