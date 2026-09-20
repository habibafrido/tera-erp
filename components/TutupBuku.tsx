"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import { Badge } from "./ui";
import {
  bukaKembaliPeriodeAksi,
  periksaPeriodeAksi,
  tutupPeriodeAksi,
} from "@/app/actions";
import type { ActionResult } from "@/app/actions";
import type { Masalah, Periode } from "@/lib/tutup-buku";

const NAMA_BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const label = (p: Periode) => `${NAMA_BULAN[p.bulan] ?? p.bulan} ${p.tahun}`;

/**
 * Daftar periode dengan tombol tutup dan buka kembali.
 *
 * Susunannya sengaja tidak simetris. Tombol "Periksa syarat" ada di
 * depan dan besar; tombol "Buka kembali" bersembunyi di balik satu klik
 * dan menuntut alasan yang diketik. Orang akan langsung mencari tombol
 * buka kembali begitu postingnya ditolak, dan yang mereka butuhkan pada
 * saat itu justru bukan tombol itu.
 */
export function TutupBuku({
  periode,
  bolehKelola,
}: {
  periode: Periode[];
  bolehKelola: boolean;
}) {
  const router = useRouter();
  const [res, setRes] = useState<ActionResult | null>(null);
  const [masalah, setMasalah] = useState<{ kunci: string; daftar: Masalah[] } | null>(
    null
  );
  const [bukaUntuk, setBukaUntuk] = useState<string | null>(null);
  const [alasan, setAlasan] = useState("");
  const [pending, start] = useTransition();

  const kunci = (p: Periode) => `${p.tahun}-${p.bulan}`;

  const periksa = (p: Periode) =>
    start(async () => {
      setRes(null);
      const hasil = await periksaPeriodeAksi(p.tahun, p.bulan);
      if (!Array.isArray(hasil)) {
        setRes(hasil);
        return;
      }
      setMasalah({ kunci: kunci(p), daftar: hasil });
    });

  const tutup = (p: Periode) =>
    start(async () => {
      const hasil = await tutupPeriodeAksi(p.tahun, p.bulan);
      setRes({ ok: hasil.ok, message: hasil.message });
      // Penolakan dari denganPeran() tidak membawa daftar masalah;
      // penolakan dari pemeriksaan syarat membawanya.
      const daftar = "masalah" in hasil ? hasil.masalah : undefined;
      setMasalah(daftar ? { kunci: kunci(p), daftar } : null);
      if (hasil.ok) router.refresh();
    });

  const bukaKembali = (p: Periode) =>
    start(async () => {
      const hasil = await bukaKembaliPeriodeAksi(p.tahun, p.bulan, alasan);
      setRes(hasil);
      if (hasil.ok) {
        setBukaUntuk(null);
        setAlasan("");
        router.refresh();
      }
    });

  return (
    <div className="space-y-4">
      {res && <FormMessage res={res} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="th">Periode</th>
              <th className="th">Rentang</th>
              <th className="th">Status</th>
              <th className="th">Jejak</th>
              <th className="th text-right">Tindakan</th>
            </tr>
          </thead>
          <tbody>
            {periode.map((p) => {
              const k = kunci(p);
              const tertutup = p.status === "DITUTUP";
              return (
                <tr key={k}>
                  <td className="td font-medium">{label(p)}</td>
                  <td className="td text-muted tnum">
                    {p.awal} – {p.akhir}
                  </td>
                  <td className="td">
                    <Badge tone={tertutup ? "muted" : "positive"}>
                      {tertutup ? "Ditutup" : "Terbuka"}
                    </Badge>
                    {p.pernahDibuka && (
                      <span className="ml-2 inline-block align-middle">
                        {/*
                          Penanda permanen. Tidak hilang meski periodenya
                          ditutup lagi — auditor mencari justru ini.
                        */}
                        <Badge tone="warning">
                          pernah dibuka kembali
                          {p.jumlahDibukaKembali > 1 && ` ${p.jumlahDibukaKembali}×`}
                        </Badge>
                      </span>
                    )}
                  </td>
                  <td className="td text-xs text-muted">
                    {p.ditutupPada && (
                      <span className="block">
                        Ditutup {p.ditutupPada}
                        {p.ditutupOleh ? ` oleh ${p.ditutupOleh}` : ""}
                      </span>
                    )}
                    {p.dibukaPada && (
                      <span className="block">
                        Dibuka {p.dibukaPada}
                        {p.dibukaOleh ? ` oleh ${p.dibukaOleh}` : ""}
                      </span>
                    )}
                    {p.alasan && (
                      <span className="block italic">“{p.alasan}”</span>
                    )}
                    {!p.ditutupPada && !p.dibukaPada && "—"}
                  </td>
                  <td className="td td-num">
                    {!bolehKelola ? (
                      <span className="text-xs text-muted">pengawas saja</span>
                    ) : tertutup ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={pending}
                        onClick={() => {
                          setBukaUntuk(bukaUntuk === k ? null : k);
                          setAlasan("");
                          setRes(null);
                        }}
                      >
                        {bukaUntuk === k ? "Batal" : "Buka kembali…"}
                      </button>
                    ) : (
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={pending}
                          onClick={() => periksa(p)}
                        >
                          Periksa syarat
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={pending}
                          onClick={() => tutup(p)}
                        >
                          Tutup
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}

            {periode.map((p) => {
              const k = kunci(p);
              if (bukaUntuk !== k) return null;
              return (
                <tr key={k + "-buka"}>
                  <td className="td" colSpan={5}>
                    <div className="rounded-md border border-line p-4">
                      <p className="mb-2 text-sm font-medium text-danger">
                        Membuka kembali {label(p)} adalah jalan terakhir.
                      </p>
                      <p className="mb-3 text-sm text-muted">
                        Hampir semua kesalahan di periode tertutup dikoreksi
                        dengan <strong className="text-ink">jurnal pembalik
                        bertanggal di periode yang masih terbuka</strong> —
                        caranya ada di tombol Batalkan pada dokumennya. Cara itu
                        membiarkan laporan yang sudah dicetak dan dikirim tetap
                        apa adanya, dan mencatat koreksinya di bulan tempat ia
                        benar-benar diketahui.
                      </p>
                      <p className="mb-3 text-sm text-muted">
                        Membuka kembali membuat angka periode yang sudah
                        dilaporkan bisa berubah lagi. Periode ini akan bertanda
                        “pernah dibuka kembali” selamanya, dan alasan di bawah
                        tersimpan di jejak audit yang tidak bisa dihapus.
                      </p>
                      <label className="block">
                        <span className="mb-1 block text-xs text-muted">
                          Alasan (minimal 10 huruf, tercatat permanen)
                        </span>
                        <input
                          className="field"
                          value={alasan}
                          onChange={(e) => setAlasan(e.target.value)}
                          placeholder="mis. koreksi kurs bank atas instruksi auditor"
                        />
                      </label>
                      <button
                        type="button"
                        className="btn mt-3"
                        disabled={pending || alasan.trim().length < 10}
                        onClick={() => bukaKembali(p)}
                      >
                        {pending ? "Memproses…" : "Saya mengerti, buka kembali"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {masalah && (
        <div className="card p-4">
          <h2 className="mb-1 text-sm font-semibold">
            {masalah.daftar.length === 0
              ? "Semua syarat terpenuhi"
              : `${masalah.daftar.length} hal harus dibereskan dulu`}
          </h2>
          {masalah.daftar.length === 0 ? (
            <p className="text-sm text-muted">
              Periode ini siap ditutup.
            </p>
          ) : (
            <ul className="mt-3 space-y-4">
              {masalah.daftar.map((m) => (
                <li key={m.kode}>
                  <p className="text-sm font-medium text-danger">{m.judul}</p>
                  <p className="text-sm text-muted">{m.tindakan}</p>
                  {m.rincian.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
                      {m.rincian.slice(0, 12).map((r, i) => (
                        <li key={i} className="tnum">
                          {r}
                        </li>
                      ))}
                      {m.rincian.length > 12 && (
                        <li>…dan {m.rincian.length - 12} lagi</li>
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
