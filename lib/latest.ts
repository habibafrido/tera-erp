/**
 * Penjaga "hanya permintaan terbaru yang boleh menulis hasil".
 *
 * Permintaan jaringan tidak dijamin selesai berurutan. Mengetik "m" lalu
 * cepat-cepat menjadi "min" bisa membuat balasan untuk "m" tiba belakangan
 * dan menimpa hasil "min" — layar lalu menampilkan hasil yang tidak cocok
 * dengan isi kotak pencarian, tanpa error apa pun.
 *
 * Dipisah dari komponen supaya bisa diuji tanpa browser; lihat
 * scripts/test-search.ts.
 */
export type Latest = {
  /** Menandai mulainya permintaan baru. Kembalikan nomor urutnya. */
  next(): number;
  /** True hanya kalau nomor ini masih yang terbaru. */
  isCurrent(n: number): boolean;
  /**
   * Membatalkan semua permintaan yang sedang berjalan tanpa memulai yang
   * baru. Dipakai saat input turun di bawah panjang minimum: balasan yang
   * masih di jalan harus ikut dibuang, bukan ditampilkan.
   */
  invalidate(): void;
};

export function createLatest(): Latest {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (n: number) => n === seq,
    invalidate: () => {
      seq++;
    },
  };
}
