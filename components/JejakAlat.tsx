"use client";

import { useState } from "react";
import { SelPanjang } from "./Markdown";
import { rupiah, tanggal } from "@/lib/format";

export type PanggilanAlat = {
  id: string;
  nama: string;
  args: Record<string, unknown>;
  ok?: boolean;
  /** True kalau hasilnya diambil dari cache giliran ini, bukan kueri baru. */
  cache?: boolean;
  meta?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  error?: string;
};

/**
 * Nama alat untuk manusia. Nama teknisnya tetap ada, tapi hanya muncul di
 * lapis "data mentah" — itu untuk menelusuri bug, bukan untuk staf gudang.
 */
const NAMA_TAMPILAN: Record<string, string> = {
  cari_barang: "Cari barang",
  nilai_persediaan: "Nilai persediaan",
  saldo_stok: "Saldo stok",
  kartu_stok: "Kartu stok",
  batch_kedaluwarsa: "Batch kedaluwarsa",
  stok_mengendap: "Stok mengendap",
  ringkasan_penjualan: "Ringkasan penjualan",
  umur_piutang: "Umur piutang",
  cari_dokumen: "Cari dokumen",
  jurnal_dokumen: "Jurnal dokumen",
};

export const namaTampilan = (n: string) =>
  NAMA_TAMPILAN[n] ?? n.replace(/_/g, " ");

// ------------------------------------------------------------------
// Format angka: ditentukan ARTI kolom, bukan tipe datanya
// ------------------------------------------------------------------

type Jenis = "rupiah" | "persen" | "tanggal" | "polos";

/**
 * Menebak format dari tipe data adalah cara paling mudah untuk salah:
 * "total_qty" dan "total_nilai" sama-sama angka, tapi yang pertama jumlah
 * unit dan yang kedua rupiah. Memberi prefiks Rp pada kuantitas membuat
 * laporan terlihat salah besar.
 *
 * Urutan pemeriksaan penting. Kata uang diperiksa LEBIH DULU daripada kata
 * kuantitas, karena "total_nilai_penerimaan" mengandung keduanya dan yang
 * menentukan artinya adalah "nilai".
 */
export function jenisKolom(kolom: string): Jenis {
  const k = kolom.toLowerCase();

  if (/persen/.test(k)) return "persen";
  if (/tanggal|kedaluwarsa|posted_at|keluar_terakhir|jatuh_tempo/.test(k)) {
    return "tanggal";
  }
  if (
    /nilai|subtotal|hpp|margin|harga|biaya|piutang|debit|kredit|credit/.test(k) ||
    // Ember umur piutang: total_0_30, umur_31_60, total_di_atas_90 — semuanya
    // rupiah, dan namanya tidak memuat satu pun kata uang di atas.
    /(^|_)(\d+_\d+|di_atas_\d+)$/.test(k)
  ) {
    return "rupiah";
  }
  // Sisanya yang jelas kuantitas atau cacahan: tampil polos.
  if (
    /qty|kuantitas|unit|jumlah|baris|sku|batch|hari|masuk|keluar|mutasi|kelompok|pelanggan|barang|faktur|penerimaan|dokumen/.test(
      k
    )
  ) {
    return "polos";
  }
  // Tidak dikenali: polos. JANGAN menebak rupiah.
  return "polos";
}

export function formatNilai(kolom: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "ya" : "tidak";

  const s = String(v);
  const n = Number(s);
  const angka = s.trim() !== "" && Number.isFinite(n);

  const jenis = jenisKolom(kolom);
  if (jenis === "tanggal") return tanggal(s);
  if (!angka) return s;

  if (jenis === "persen") {
    return (
      n.toLocaleString("id-ID", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + "%"
    );
  }
  if (jenis === "rupiah") return rupiah(n);
  return n.toLocaleString("id-ID", { maximumFractionDigits: 6 });
}

/**
 * Menempelkan satuan di sebelah angka kuantitas.
 *
 * "200" saja ambigu: bisa pcs, bisa kg. Satuannya ikut sebagai kolom pada
 * hasil alat, jadi dipasang di sini agar angkanya terbaca utuh. Kolom uang
 * dan persen tidak tersentuh — satuannya sudah jelas dari formatnya.
 */
function denganSatuan(
  kolom: string,
  teks: string,
  baris: Record<string, unknown>
): string {
  if (jenisKolom(kolom) !== "polos") return teks;
  if (teks === "—") return teks;

  // Hanya kuantitas yang memakai satuan dasar. Cacahan seperti
  // "jumlah_batch" atau "sisa_hari" bukan kuantitas barang.
  if (!/qty|kuantitas|masuk|keluar|mutasi/.test(kolom.toLowerCase())) return teks;

  const satuan = baris.satuan;
  if (typeof satuan !== "string" || satuan === "") return teks;
  return teks + " " + satuan;
}

/** Kolom angka dirata-kanankan. Tidak ada warna — warna hanya untuk kredit. */
function rataKanan(kolom: string, rows: Record<string, unknown>[]): boolean {
  if (jenisKolom(kolom) === "tanggal") return false;
  const contoh = rows.find((r) => r[kolom] !== null && r[kolom] !== undefined);
  if (!contoh) return false;
  const v = contoh[kolom];
  if (typeof v === "boolean") return false;
  const s = String(v);
  return s.trim() !== "" && Number.isFinite(Number(s));
}

function TabelHasil({ rows }: { rows: Record<string, unknown>[] }) {
  const kolom = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            {kolom.map((k) => (
              <th key={k} className={rataKanan(k, rows) ? "th text-right" : "th"}>
                {k.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {kolom.map((k) =>
                rataKanan(k, rows) ? (
                  <td key={k} className="td-num">
                    {denganSatuan(k, formatNilai(k, r[k]), r)}
                  </td>
                ) : (
                  <SelPanjang key={k} isi={formatNilai(k, r[k])} kelas="td" />
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------
// Baris sumber
// ------------------------------------------------------------------

/**
 * Satu baris berbahasa manusia yang menjawab "angka ini dari mana".
 * Contoh: "Nilai persediaan · semua gudang · per 20 Sep 2026".
 */
export function ringkasSumber(a: PanggilanAlat): string[] {
  const bagian: string[] = [];
  const m = a.meta ?? {};
  const g = a.args ?? {};

  if (typeof g.gudang === "string") bagian.push(String(g.gudang));
  else if (typeof m.gudang === "string") bagian.push(String(m.gudang));

  if (typeof g.sku === "string") bagian.push(String(g.sku));
  if (typeof g.per === "string") bagian.push("per " + String(g.per));
  if (typeof g.teks === "string") bagian.push(`"${g.teks}"`);
  if (typeof g.nomor_dokumen === "string") bagian.push(String(g.nomor_dokumen));
  if (typeof g.pelanggan === "string") bagian.push(String(g.pelanggan));
  if (typeof g.hari === "number") bagian.push(`${g.hari} hari ke depan`);

  // Periode: rentang kalau ada, kalau tidak tanggal posisinya.
  const dari = m.tanggal_mulai;
  const sampai = m.tanggal_akhir;
  if (typeof dari === "string" && typeof sampai === "string") {
    bagian.push(`${tanggal(dari)} – ${tanggal(sampai)}`);
  } else {
    const per = m.dihitung_pada ?? m.posisi_per;
    if (typeof per === "string") bagian.push("per " + tanggal(per));
  }

  if (a.cache) bagian.push("dari cache");
  return bagian;
}

/**
 * Nota sumber. Tertutup secara bawaan — yang terlihat hanya satu baris
 * tenang. Jawaban adalah produknya; ini notanya.
 */
export function Jejak({ a }: { a: PanggilanAlat }) {
  const [mentah, setMentah] = useState(false);

  const keterangan = typeof a.meta?.keterangan === "string" ? a.meta.keterangan : null;
  const baris = a.rows ?? [];

  /*
   * Hasil satu baris biasanya SUDAH disebut di kalimat jawaban. Merender
   * ulang sebagai tabel hanya mengulang hal yang sama dengan bentuk lain.
   * Tabel ditampilkan hanya kalau memang ada beberapa baris untuk dilihat.
   */
  const perluTabel = baris.length > 1;

  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted">
        <span>Sumber: {namaTampilan(a.nama)}</span>
        {ringkasSumber(a).map((b, i) => (
          <span key={i}>{" · " + b}</span>
        ))}
        {a.ok === false && <span>{" · gagal"}</span>}
      </summary>

      <div className="card mt-1.5 px-3 py-2">
        {a.error ? (
          <p className="text-xs text-danger">{a.error}</p>
        ) : (
          <>
            {keterangan && <p className="text-xs text-muted">{keterangan}</p>}

            {!perluTabel && baris.length === 1 && (
              <p className="mt-1 text-xs text-muted">
                Satu baris hasil, angkanya sudah disebut di jawaban.
              </p>
            )}
            {baris.length === 0 && (
              <p className="mt-1 text-xs text-muted">Tidak ada baris.</p>
            )}

            {perluTabel && (
              <div className="-mx-3 mt-2 border-t border-line">
                <TabelHasil rows={baris} />
              </div>
            )}
          </>
        )}

        {/* Lapis kedua: untuk menelusuri bug, bukan untuk pengguna sehari-hari. */}
        <button
          type="button"
          onClick={() => setMentah((v) => !v)}
          aria-expanded={mentah}
          className="mt-2 cursor-pointer text-xs text-action underline"
        >
          {mentah ? "Sembunyikan data mentah" : "Lihat data mentah"}
        </button>

        {mentah && (
          <pre className="mt-1.5 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-muted">
            {JSON.stringify(
              { alat: a.nama, parameter: a.args, meta: a.meta, baris: a.rows },
              null,
              2
            )}
          </pre>
        )}
      </div>
    </details>
  );
}
