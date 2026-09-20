import { cookies } from "next/headers";
import { query } from "../db";
import type { Pengguna } from "./sesi";

/**
 * ============================================================
 * JALUR PENGGUNA SISTEM
 * ============================================================
 * Skrip — migrasi, data contoh, rangkaian tes, audit tanggal — memanggil
 * server action langsung dari Node, di luar permintaan HTTP mana pun.
 * Di sana tidak ada cookie untuk dibaca, jadi pemeriksaan sesi biasa
 * akan menolak semuanya.
 *
 * KENAPA INI BUKAN PELONGGARAN
 *
 * Jalurnya menuntut DUA syarat yang tidak bisa dipenuhi bersamaan oleh
 * sebuah permintaan HTTP:
 *
 *   1. TIDAK ADA konteks permintaan sama sekali. Selama ada permintaan,
 *      cookies() berhasil dan fungsi ini langsung menyerah. Artinya
 *      sebuah request — dengan cookie, tanpa cookie, dengan cookie
 *      palsu, apa pun — tidak akan pernah sampai ke sini.
 *
 *   2. process.env.TERA_SKRIP === "1", yang hanya disetel oleh berkas
 *      skrip itu sendiri di baris pertamanya. Perintah `next dev` dan
 *      `next start` tidak pernah menyetelnya.
 *
 * Syarat pertama saja sebenarnya sudah cukup: kode yang berjalan tanpa
 * permintaan HTTP tidak bisa dipicu dari jaringan. Syarat kedua ada
 * supaya proses latar yang suatu saat berjalan di dalam server — cron,
 * antrean — tidak diam-diam mendapat wewenang pengawas hanya karena ia
 * kebetulan berada di luar permintaan.
 *
 * Yang dijalankan skrip tetap DICATAT di audit_log, atas nama akun
 * sistem. Jejaknya tidak hilang, ia hanya menunjuk pelaku yang benar.
 */

let cache: Pengguna | null = null;

export async function penggunaSistem(): Promise<Pengguna | null> {
  if (process.env.TERA_SKRIP !== "1") return null;

  try {
    await cookies();
    // Berhasil berarti ADA permintaan HTTP. Ini bukan jalur skrip.
    return null;
  } catch {
    // Tidak ada konteks permintaan — memang dijalankan dari skrip.
  }

  if (cache) return cache;

  const rows = await query<{ id: string; email: string; nama: string }>(
    `SELECT id, email, name AS nama FROM app_user
      WHERE email = 'sistem@tera.local' AND is_system`
  );
  const u = rows[0];
  if (!u) return null;

  cache = { id: u.id, email: u.email, nama: u.nama, peran: "pengawas" };
  return cache;
}

/** Dipakai tes: memastikan cache tidak menyeberang antar database. */
export function lupakanPenggunaSistem() {
  cache = null;
}
