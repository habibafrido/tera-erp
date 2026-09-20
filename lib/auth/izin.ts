/**
 * ============================================================
 * PETA HAK AKSES
 * ============================================================
 * Satu berkas, tanpa impor apa pun, supaya bisa dibaca middleware
 * (runtime Edge) maupun server action tanpa menarik driver database.
 *
 * Tiga peran, dan pengawas selalu termasuk:
 *
 *   operator_gudang  barang masuk dan keluar gudang
 *   staf_keuangan    faktur, pembayaran, jurnal
 *   pengawas         semuanya, plus yang tidak bisa dibatalkan
 */

export const PERAN = ["operator_gudang", "staf_keuangan", "pengawas"] as const;
export type Peran = (typeof PERAN)[number];

export const LABEL_PERAN: Record<Peran, string> = {
  operator_gudang: "Operator gudang",
  staf_keuangan: "Staf keuangan",
  pengawas: "Pengawas",
};

export function adalahPeran(v: unknown): v is Peran {
  return typeof v === "string" && (PERAN as readonly string[]).includes(v);
}

/**
 * Aksi yang bisa dilakukan, beserta peran yang boleh melakukannya.
 *
 * Nama aksi dipakai apa adanya di audit_log, jadi ia sekaligus menjadi
 * kosakata yang muncul di jejak audit. Menambah aksi berarti menambah
 * satu baris di sini — dan sebuah aksi yang tidak terdaftar akan
 * DITOLAK, bukan diizinkan. Bawaan yang aman adalah menolak.
 */
export const IZIN = {
  // --- Gudang ---
  "penerimaan.posting": ["operator_gudang"],
  "gudang.buat": ["operator_gudang"],

  // --- Keuangan ---
  "penjualan.posting": ["staf_keuangan"],
  "pembayaran.posting": ["staf_keuangan"],
  "pembayaran_pemasok.posting": ["staf_keuangan"],
  "faktur_beli.posting": ["staf_keuangan"],
  "barang.buat": ["staf_keuangan"],
  "mitra.buat": ["staf_keuangan"],

  /*
   * Menyetujui selisih kuantitas berarti menerima tagihan atas barang
   * yang tidak pernah tercatat masuk gudang. Itu pengakuan kerugian,
   * bukan pekerjaan tata usaha — jadi ia milik pengawas saja, meski
   * fakturnya sendiri diposting staf keuangan.
   */
  "faktur_beli.setujui_selisih": [],

  // --- Hanya pengawas ---
  /*
   * Pembatalan dan tutup buku hanya untuk pengawas.
   *
   * Keduanya mengubah angka yang sudah pernah dilaporkan ke luar. Yang
   * satu membalikkan dokumen yang sudah masuk buku besar; yang lain
   * menentukan sampai mana angka boleh berubah sama sekali. Daftar
   * kosong berarti "tidak ada peran lain" — pengawas selalu ikut lewat
   * bolehkah().
   */
  "dokumen.batalkan": [],
  "buku.tutup": [],
  "buku.buka_kembali": [],
  "pengguna.kelola": [],

  // --- Membaca: ketiga peran ---
  "data.baca": ["operator_gudang", "staf_keuangan"],
  "laporan.unduh": ["operator_gudang", "staf_keuangan"],
  "asisten.tanya": ["operator_gudang", "staf_keuangan"],
  "pencarian.cari": ["operator_gudang", "staf_keuangan"],
} as const satisfies Record<string, readonly Peran[]>;

export type Aksi = keyof typeof IZIN;

/**
 * Pengawas selalu boleh. Ini ditulis SEKALI di sini alih-alih diulang
 * di setiap baris IZIN, supaya tidak ada aksi yang diam-diam terlewat
 * menyertakannya.
 */
export function bolehkah(peran: Peran, aksi: Aksi): boolean {
  if (peran === "pengawas") return true;
  const daftar = IZIN[aksi] as readonly string[] | undefined;
  return Array.isArray(daftar) && daftar.includes(peran);
}

/** Halaman yang boleh dibuka tanpa masuk. */
export const RUTE_PUBLIK = ["/masuk"];

/**
 * Halaman yang hanya relevan untuk peran tertentu.
 *
 * Ini KENYAMANAN, bukan pengamanan: menyembunyikan tautan tidak
 * menghentikan siapa pun yang mengetik alamatnya. Penegakan yang
 * sebenarnya ada di setiap server action dan di setiap route handler.
 */
export const HALAMAN_PERAN: Record<string, readonly Peran[]> = {
  "/receipts": ["operator_gudang", "pengawas"],
  "/purchases": ["staf_keuangan", "pengawas"],
  "/sales": ["staf_keuangan", "pengawas"],
  "/payments": ["staf_keuangan", "pengawas"],
  "/supplier-payments": ["staf_keuangan", "pengawas"],
  "/tutup-buku": ["staf_keuangan", "pengawas"],
};
