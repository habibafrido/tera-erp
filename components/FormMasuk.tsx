"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import { masuk } from "@/app/auth-actions";
import type { ActionResult } from "@/app/actions";

export function FormMasuk() {
  const router = useRouter();
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const kirim = (fd: FormData) =>
    start(async () => {
      const r = await masuk(fd);
      setRes(r);
      // Pengalihan dilakukan setelah cookie terpasang, lewat refresh
      // supaya layout terlindungi membaca sesi yang baru.
      if (r.ok) {
        router.replace("/");
        router.refresh();
      }
    });

  return (
    <form action={kirim} className="card space-y-4 p-5">
      <label className="block">
        <span className="mb-1 block text-xs text-muted">Email</span>
        <input
          className="field"
          type="email"
          name="email"
          autoComplete="username"
          required
          autoFocus
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs text-muted">Kata sandi</span>
        <input
          className="field"
          type="password"
          name="kata_sandi"
          autoComplete="current-password"
          required
        />
      </label>

      <button type="submit" className="btn w-full" disabled={pending} aria-busy={pending}>
        {pending ? "Memeriksa…" : "Masuk"}
      </button>

      {res && <FormMessage res={res} />}
    </form>
  );
}
