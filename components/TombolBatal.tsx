"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { batalkanDokumenAksi } from "@/app/actions";
import type { ActionResult } from "@/app/actions";
import type { JenisDokumen } from "@/lib/posting";

/**
 * Tombol batalkan untuk satu dokumen.
 *
 * Tanggal pembalik BAWAANNYA hari ini, bukan tanggal dokumennya — dan
 * itulah keputusan terpenting di komponen ini. Koreksi dicatat di
 * periode tempat ia diketahui, sehingga laporan periode lama tidak
 * berubah dan periode yang sudah ditutup tidak perlu dibuka.
 */
export function TombolBatal({
  jenis,
  dokumenId,
  docNo,
  hariIni,
  sudahBatal,
}: {
  jenis: JenisDokumen;
  dokumenId: string;
  docNo: string;
  hariIni: string;
  sudahBatal?: boolean;
}) {
  const router = useRouter();
  const [buka, setBuka] = useState(false);
  const [tanggal, setTanggal] = useState(hariIni);
  const [alasan, setAlasan] = useState("");
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  if (sudahBatal) {
    return <span className="text-xs text-muted">dibatalkan</span>;
  }

  const kirim = () =>
    start(async () => {
      const r = await batalkanDokumenAksi({
        jenis,
        dokumen_id: dokumenId,
        tanggal_pembalik: tanggal,
        alasan,
      });
      setRes(r);
      if (r.ok) {
        setBuka(false);
        setAlasan("");
        router.refresh();
      }
    });

  return (
    <div className="inline-block text-left">
      <button
        type="button"
        className="btn-ghost"
        onClick={() => {
          setBuka((v) => !v);
          setRes(null);
        }}
      >
        {buka ? "Tutup" : "Batalkan"}
      </button>

      {buka && (
        <div className="mt-2 w-72 rounded-md border border-line p-3">
          <p className="mb-2 text-xs text-muted">
            {docNo} akan dibalik dengan jurnal baru — debit dan kredit ditukar,
            pergerakan stoknya dikembalikan. Dokumen aslinya tetap ada.
          </p>

          <label className="block">
            <span className="mb-1 block text-xs text-muted">
              Tanggal pembalik (harus di periode terbuka)
            </span>
            <input
              className="field"
              type="date"
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
            />
          </label>

          <label className="mt-2 block">
            <span className="mb-1 block text-xs text-muted">
              Alasan (minimal 5 huruf, tercatat permanen)
            </span>
            <input
              className="field"
              value={alasan}
              onChange={(e) => setAlasan(e.target.value)}
              placeholder="mis. salah gudang"
            />
          </label>

          <button
            type="button"
            className="btn mt-3 w-full"
            disabled={pending || alasan.trim().length < 5}
            onClick={kirim}
          >
            {pending ? "Memproses…" : "Batalkan"}
          </button>

          {res && (
            <p
              role="status"
              className={
                "mt-2 text-xs " + (res.ok ? "text-positive" : "text-danger")
              }
            >
              {res.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
