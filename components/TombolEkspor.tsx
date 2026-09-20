"use client";

import { useState } from "react";

/**
 * Tombol unduh Excel.
 *
 * Sengaja TIDAK memakai <a download> biasa: kalau server menolak (filter
 * tidak sah, hasil terlalu besar), browser akan mengunduh berkas JSON
 * berisi pesan galat alih-alih menampilkannya. Permintaannya karena itu
 * dijalankan lewat fetch, galatnya dibaca, dan unduhan baru dipicu
 * setelah responsnya benar-benar berupa berkas.
 */
export function TombolEkspor({
  laporan,
  filter,
  label = "Unduh Excel",
}: {
  laporan: string;
  filter?: Record<string, string | number | undefined>;
  label?: string;
}) {
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const unduh = async () => {
    if (sibuk) return;
    setSibuk(true);
    setGalat(null);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter ?? {})) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }

    try {
      const res = await fetch(
        `/api/export/${encodeURIComponent(laporan)}${qs.size ? "?" + qs : ""}`
      );

      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setGalat(j?.error ?? `Gagal mengunduh (HTTP ${res.status}).`);
        return;
      }

      const blob = await res.blob();
      const nama =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
        `tera_${laporan}.xlsx`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nama;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setGalat("Tidak bisa menghubungi server.");
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={unduh}
        disabled={sibuk}
        aria-busy={sibuk}
        className="btn-ghost"
      >
        {sibuk ? "Menyiapkan…" : label}
      </button>
      {galat && (
        <p role="alert" className="max-w-xs text-right text-xs text-danger">
          {galat}
        </p>
      )}
    </div>
  );
}
