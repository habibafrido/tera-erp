import { catat } from "./jejak";
import { bolehkah, type Aksi, type Peran } from "./izin";
import { penggunaSaatIni, type Pengguna } from "./sesi";
import { penggunaSistem } from "./sistem";

/**
 * ============================================================
 * PENJAGA SERVER ACTION
 * ============================================================
 * Middleware SAJA tidak cukup, dan ini bukan soal ketelitian.
 *
 * Server action adalah endpoint HTTP tersendiri. Klien memanggilnya
 * dengan POST ke URL halaman yang membawa header Next-Action berisi id
 * action-nya — tanpa pernah menavigasi ke halaman mana pun. Middleware
 * yang memeriksa "halaman apa yang sedang dibuka" karena itu bisa
 * dilewati sepenuhnya: yang diperiksanya memang bukan jalur yang
 * dipakai penyerang.
 *
 * Karena itu setiap server action memeriksa sesi dan perannya SENDIRI,
 * di baris pertama, lewat pembungkus di berkas ini.
 */

export type HasilAksi = { ok: boolean; message: string };

/** Galat yang sudah tercatat di jejak audit; tidak perlu dicatat lagi. */
export class DitolakError extends Error {}

/**
 * Konteks yang diberikan ke fungsi yang dibungkus: pengguna yang sudah
 * dipastikan ada, sudah aktif, dan sudah lolos pemeriksaan peran.
 */
export type Konteks = { pengguna: Pengguna };

const PESAN_TANPA_SESI =
  "Sesi Anda sudah berakhir. Muat ulang halaman dan masuk kembali.";

const pesanTolak = (aksi: string, peran: Peran) =>
  `Peran Anda (${peran}) tidak berwenang untuk ${aksi}.`;

/**
 * Membungkus sebuah server action.
 *
 *     export const simpanFaktur = denganPeran(
 *       ["staf_keuangan"],
 *       "penjualan.posting",
 *       async ({ pengguna }, payload) => { ... }
 *     );
 *
 * `peran` ditulis eksplisit supaya terbaca di tempat action-nya
 * didefinisikan. Pengawas selalu ikut diizinkan tanpa perlu disebut —
 * lihat bolehkah() — dan daftar di lib/auth/izin.ts tetap menjadi acuan
 * yang diperiksa, sehingga dua sumber ini tidak bisa berselisih tanpa
 * ketahuan: pemeriksaannya memakai keduanya.
 *
 * Fungsi ini juga menangkap galat dari fn dan mencatatnya sebagai GAGAL,
 * sehingga posting yang meledak di tengah tetap meninggalkan jejak.
 */
export function denganPeran<A extends unknown[], R>(
  peran: readonly Peran[],
  aksi: Aksi,
  fn: (ctx: Konteks, ...args: A) => Promise<R>
): (...args: A) => Promise<R | HasilAksi> {
  return async (...args: A): Promise<R | HasilAksi> => {
    // Sesi HTTP lebih dulu; jalur skrip hanya dipakai kalau memang
    // TIDAK ADA permintaan sama sekali. Lihat lib/auth/sistem.ts.
    const pengguna = (await penggunaSaatIni()) ?? (await penggunaSistem());

    if (!pengguna) {
      await catat({ aksi, hasil: "DITOLAK", alasan: "tanpa sesi" });
      return { ok: false, message: PESAN_TANPA_SESI };
    }

    // Dua pemeriksaan yang harus SAMA-SAMA lolos: daftar di tempat
    // pemanggilan dan peta izin terpusat. Kalau keduanya berselisih,
    // yang menang adalah penolakan.
    const diizinkanDiSini =
      pengguna.peran === "pengawas" || peran.includes(pengguna.peran);
    const diizinkanPeta = bolehkah(pengguna.peran, aksi);

    if (!diizinkanDiSini || !diizinkanPeta) {
      await catat({
        aksi,
        hasil: "DITOLAK",
        pengguna,
        alasan: `peran ${pengguna.peran} tidak berwenang`,
        detail: { diizinkanDiSini, diizinkanPeta, dibutuhkan: peran },
      });
      return { ok: false, message: pesanTolak(aksi, pengguna.peran) };
    }

    try {
      return await fn({ pengguna }, ...args);
    } catch (e) {
      const pesan = e instanceof Error ? e.message : String(e);
      await catat({ aksi, hasil: "GAGAL", pengguna, alasan: pesan.slice(0, 500) });
      throw e;
    }
  };
}

/**
 * Penjaga untuk route handler (API), yang tidak mengembalikan HasilAksi
 * melainkan Response.
 *
 * Mengembalikan pengguna kalau boleh, atau null setelah mencatat
 * penolakannya. Pemanggil yang menyusun responsnya, karena bentuk galat
 * tiap route berbeda.
 */
export async function penggunaUntukApi(aksi: Aksi): Promise<Pengguna | null> {
  const pengguna = (await penggunaSaatIni()) ?? (await penggunaSistem());

  if (!pengguna) {
    await catat({ aksi, hasil: "DITOLAK", alasan: "tanpa sesi" });
    return null;
  }
  if (!bolehkah(pengguna.peran, aksi)) {
    await catat({
      aksi,
      hasil: "DITOLAK",
      pengguna,
      alasan: `peran ${pengguna.peran} tidak berwenang`,
    });
    return null;
  }
  return pengguna;
}
