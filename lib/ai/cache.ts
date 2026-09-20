/**
 * Cache pemanggilan alat, hidup HANYA selama satu giliran percakapan.
 *
 * Model kadang memanggil alat yang sama dengan parameter identik dua kali
 * dalam satu giliran — sekali untuk memeriksa, sekali untuk menyusun
 * jawaban. Kueri kedua tidak menambah informasi apa pun, hanya menambah
 * waktu tunggu dan beban database.
 *
 * Sengaja TIDAK dipertahankan antar giliran: data ERP berubah begitu
 * dokumen diposting, dan jawaban basi di sini jauh lebih berbahaya
 * daripada satu kueri tambahan. Instansnya dibuat dan dibuang per
 * permintaan.
 *
 * Dipisah dari route handler supaya normalisasi kuncinya bisa diuji tanpa
 * memanggil model; lihat scripts/test-ai.ts.
 */
export type CacheGiliran<T> = {
  /** Kunci ternormalkan untuk satu pemanggilan alat. */
  kunci(nama: string, args: Record<string, unknown>): string;
  ambil(kunci: string): T | undefined;
  simpan(kunci: string, nilai: T): void;
  jumlah(): number;
};

/**
 * Kunci JSON diurutkan supaya {dari, sampai} dan {sampai, dari} dianggap
 * panggilan yang sama. Parameter yang bernilai undefined dibuang, karena
 * "tidak diisi" dan "diisi undefined" berarti sama bagi handler alat.
 * Parameter alat semuanya skalar, jadi pengurutan dangkal sudah cukup.
 */
export function kunciCache(nama: string, args: Record<string, unknown>): string {
  const rapi: Record<string, unknown> = {};
  for (const k of Object.keys(args ?? {}).sort()) {
    if (args[k] !== undefined) rapi[k] = args[k];
  }
  return nama + ":" + JSON.stringify(rapi);
}

export function buatCacheGiliran<T>(): CacheGiliran<T> {
  const isi = new Map<string, T>();
  return {
    kunci: kunciCache,
    ambil: (k) => isi.get(k),
    simpan: (k, v) => {
      isi.set(k, v);
    },
    jumlah: () => isi.size,
  };
}
