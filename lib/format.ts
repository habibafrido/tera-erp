const idr = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const plain = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

const tgl = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** Nilai uang datang dari pg sebagai string; Number() dipakai hanya untuk tampil. */
export function rupiah(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? idr.format(n) : "—";
}

export function num(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? plain.format(n) : "—";
}

export function tanggal(v: unknown): string {
  if (!v) return "—";

  let d: Date;
  if (v instanceof Date) {
    // Driver pg mengembalikan kolom date sebagai Date tengah malam waktu
    // LOKAL, dan Intl memformat di zona waktu lokal juga, jadi harinya tetap.
    d = v;
  } else {
    const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    // new Date("2026-09-20") diparse sebagai tengah malam UTC menurut
    // spesifikasi, sehingga di zona waktu NEGATIF tanggalnya mundur sehari
    // saat diformat. Tanggal-saja karena itu dibangun dari komponennya.
    // Teks yang memuat jam ("2026-09-20 01:34") tetap lewat parser biasa.
    d = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      : new Date(s);
  }

  return Number.isNaN(d.getTime()) ? "—" : tgl.format(d);
}

/**
 * SENGAJA TIDAK ADA hariIni() di sini.
 *
 * Nilai awal <input type="date"> pada formulir dokumen dulu diambil dari
 * jam proses Node. Ketika zona waktu server berbeda dari zona waktu
 * database — hal biasa pada pemasangan nyata — nilai bawaannya bisa
 * mundur sehari, dan tanggal itu masuk ke buku besar yang append-only.
 * Satu-satunya koreksi setelah itu adalah jurnal pembalik.
 *
 * Tanggal dokumen karena itu diambil dari CURRENT_DATE milik database,
 * lihat app/receipts/new/page.tsx dan app/sales/new/page.tsx.
 */
