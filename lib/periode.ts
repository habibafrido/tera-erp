/**
 * ============================================================
 * PERIODE RELATIF
 * ============================================================
 * Dipakai bersama oleh registry alat AI dan registry laporan ekspor.
 *
 * Aturannya sama di kedua tempat: nilai periode divalidasi ke daftar
 * literal di bawah LEBIH DULU, lalu yang disambung ke teks SQL adalah
 * ekspresi dari peta ini — bukan masukan pengguna maupun model.
 *
 * Tanggalnya sengaja diterjemahkan Postgres, bukan dihitung di
 * JavaScript. Jam proses Node bisa berbeda zona waktu dari database,
 * dan pergeseran sehari pada laporan tidak memunculkan error apa pun —
 * hanya angka periode yang salah.
 *
 * "N hari terakhir" inklusif hari ini. Periode bulan dan tahun memakai
 * rentang penuh, sehingga dokumen bertanggal akhir bulan tetap terhitung.
 */
export const PERIODE = {
  hari_ini: { dari: "CURRENT_DATE", sampai: "CURRENT_DATE" },
  "7_hari_terakhir": {
    dari: "CURRENT_DATE - INTERVAL '6 days'",
    sampai: "CURRENT_DATE",
  },
  "30_hari_terakhir": {
    dari: "CURRENT_DATE - INTERVAL '29 days'",
    sampai: "CURRENT_DATE",
  },
  "90_hari_terakhir": {
    dari: "CURRENT_DATE - INTERVAL '89 days'",
    sampai: "CURRENT_DATE",
  },
  bulan_ini: {
    dari: "date_trunc('month', CURRENT_DATE)",
    sampai: "date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day'",
  },
  bulan_lalu: {
    dari: "date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'",
    sampai: "date_trunc('month', CURRENT_DATE) - INTERVAL '1 day'",
  },
  tahun_ini: {
    dari: "date_trunc('year', CURRENT_DATE)",
    sampai: "date_trunc('year', CURRENT_DATE) + INTERVAL '1 year' - INTERVAL '1 day'",
  },
  tahun_lalu: {
    dari: "date_trunc('year', CURRENT_DATE) - INTERVAL '1 year'",
    sampai: "date_trunc('year', CURRENT_DATE) - INTERVAL '1 day'",
  },
} as const;

export type Periode = keyof typeof PERIODE;
export const PERIODE_SAH = Object.keys(PERIODE) as Periode[];

export const adalahPeriode = (v: unknown): v is Periode =>
  typeof v === "string" && (PERIODE_SAH as string[]).includes(v);

/** Label untuk manusia, dipakai di header berkas ekspor. */
export const LABEL_PERIODE: Record<Periode, string> = {
  hari_ini: "hari ini",
  "7_hari_terakhir": "7 hari terakhir",
  "30_hari_terakhir": "30 hari terakhir",
  "90_hari_terakhir": "90 hari terakhir",
  bulan_ini: "bulan ini",
  bulan_lalu: "bulan lalu",
  tahun_ini: "tahun ini",
  tahun_lalu: "tahun lalu",
};
