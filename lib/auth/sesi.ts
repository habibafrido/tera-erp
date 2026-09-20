import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { cookies, headers } from "next/headers";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { query } from "../db";
import { adalahPeran, type Peran } from "./izin";

/**
 * ============================================================
 * SESI DAN KATA SANDI
 * ============================================================
 * Dua fungsi hash yang berbeda, dipilih untuk dua masalah yang berbeda:
 *
 *   kata sandi -> argon2id, sengaja lambat dan boros memori
 *   token sesi -> SHA-256, sengaja cepat
 *
 * Kelihatan tidak konsisten, padahal justru sebaliknya. Kata sandi
 * dipilih manusia, jadi ruang tebakannya kecil dan satu-satunya
 * pertahanan adalah membuat setiap tebakan mahal. Token sesi berisi 256
 * bit dari CSPRNG — tidak ada yang bisa ditebak, dan ia diperiksa pada
 * setiap permintaan, sehingga hash lambat hanya akan memperlambat
 * pengguna yang sah.
 */

export const NAMA_COOKIE = "tera_sesi";

/**
 * Argon2id.
 *
 * Ditulis sebagai angka, bukan lewat enum Algorithm milik pustaka:
 * enum itu `const enum`, dan `isolatedModules` di tsconfig proyek ini
 * melarang mengaksesnya karena nilainya harus di-inline saat kompilasi
 * per-berkas. Nilainya bagian dari format argon2 dan tidak berubah.
 */
const ARGON2ID = 2;

/** Masa berlaku menganggur. Diperpanjang selama sesi dipakai. */
const IDLE_MS = 8 * 60 * 60 * 1000;

/** Batas mutlak. Sesi yang terus dipakai pun akhirnya harus masuk lagi. */
const MUTLAK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sesi diperpanjang paling cepat sekali per interval ini.
 *
 * Tanpa jeda, setiap klik halaman menghasilkan satu UPDATE ke tabel
 * sesi. Itu tulisan yang tidak membawa informasi baru.
 */
const JEDA_PERPANJANG_MS = 5 * 60 * 1000;

export type Pengguna = {
  id: string;
  email: string;
  nama: string;
  peran: Peran;
};

// ------------------------------------------------------------
// Kata sandi
// ------------------------------------------------------------

/**
 * Parameter argon2id dibiarkan pada bawaan pustaka (m=19 MiB, t=2, p=1),
 * yang mengikuti anjuran OWASP. Nilainya tersimpan DI DALAM string hash,
 * jadi menaikkannya nanti tidak membuat kata sandi lama berhenti bekerja.
 */
export async function hashKataSandi(kataSandi: string): Promise<string> {
  return argonHash(kataSandi, { algorithm: ARGON2ID });
}

export async function kataSandiCocok(
  hashTersimpan: string | null,
  kataSandi: string
): Promise<boolean> {
  // Akun sistem tidak punya hash, jadi tidak ada kata sandi yang cocok.
  if (!hashTersimpan) return false;
  try {
    return await argonVerify(hashTersimpan, kataSandi);
  } catch {
    // Hash rusak atau format asing: perlakukan sebagai tidak cocok,
    // jangan sampai menjadi galat yang membocorkan bentuk datanya.
    return false;
  }
}

// ------------------------------------------------------------
// Token
// ------------------------------------------------------------

const sidik = (token: string) => createHash("sha256").update(token).digest("hex");

/** Token 256 bit, aman untuk ditaruh di cookie. */
const tokenBaru = () => randomBytes(32).toString("base64url");

/** Pembandingan setara-waktu, supaya panjang kecocokan tidak terukur. */
function samaPersis(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------
// Konteks permintaan
// ------------------------------------------------------------

/**
 * Alamat IP pemanggil.
 *
 * x-forwarded-for bisa berisi daftar dan bisa dipalsukan klien; yang
 * diambil hanya entri pertama, dan ia DIVALIDASI sebagai alamat IP
 * sungguhan sebelum masuk ke kolom bertipe inet. Nilai ngawur menjadi
 * null, bukan galat — jejak audit yang gagal tertulis lebih buruk
 * daripada jejak audit tanpa alamat IP.
 */
export async function alamatIp(): Promise<string | null> {
  const h = await headers();
  const kandidat =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip")?.trim() ??
    null;
  if (!kandidat) return null;
  const bersih = kandidat.replace(/^\[|\]$/g, "");
  return isIP(bersih) ? bersih : null;
}

export async function agenPengguna(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent")?.slice(0, 300) ?? null;
}

// ------------------------------------------------------------
// Membuat dan membaca sesi
// ------------------------------------------------------------

/**
 * Membuat sesi dan memasang cookienya.
 *
 * httpOnly  : JavaScript halaman tidak bisa membacanya, jadi satu XSS
 *             tidak langsung berarti token tercuri. Ini juga alasan
 *             token TIDAK disimpan di localStorage — di sana ia bisa
 *             dibaca skrip mana pun yang berhasil masuk ke halaman.
 * sameSite  : lax, supaya permintaan lintas situs tidak membawa cookie
 *             pada aksi yang mengubah data.
 * secure    : dinyalakan di produksi. Di pengembangan ia dimatikan
 *             karena `next dev` berjalan di http biasa, dan cookie
 *             Secure di atas http tidak akan pernah terpasang — masuk
 *             akan gagal tanpa pesan apa pun. Di produksi nilainya
 *             selalu true.
 */
export async function buatSesi(penggunaId: string): Promise<string> {
  const token = tokenBaru();
  const ip = await alamatIp();
  const ua = await agenPengguna();

  await query(
    `INSERT INTO user_session
       (token_hash, user_id, expires_at, hard_expires_at, ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval,
                     now() + ($4 || ' milliseconds')::interval, $5, $6)`,
    [sidik(token), penggunaId, IDLE_MS, MUTLAK_MS, ip, ua]
  );

  await query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [penggunaId]);

  const jar = await cookies();
  jar.set(NAMA_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(MUTLAK_MS / 1000),
  });

  return token;
}

export async function hapusSesi(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(NAMA_COOKIE)?.value;
  if (token) {
    await query(
      `UPDATE user_session SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sidik(token)]
    );
  }
  jar.delete(NAMA_COOKIE);
}

type BarisSesi = {
  sesi_id: string;
  user_id: string;
  email: string;
  nama: string;
  peran: string;
  token_hash: string;
  perlu_perpanjang: boolean;
};

/**
 * Pengguna yang sedang masuk, atau null.
 *
 * Tidak melempar. Pemanggil yang memutuskan apa artinya tidak ada sesi —
 * halaman mengalihkan ke /masuk, server action menolak dan mencatat.
 */
export async function penggunaSaatIni(): Promise<Pengguna | null> {
  /*
   * Di luar permintaan HTTP — misalnya saat sebuah skrip memanggil
   * server action langsung — cookies() melempar. Itu bukan galat,
   * melainkan "tidak ada siapa-siapa yang sedang masuk". Lihat
   * lib/auth/sistem.ts untuk jalur skripnya.
   */
  let jar;
  try {
    jar = await cookies();
  } catch {
    return null;
  }

  const token = jar.get(NAMA_COOKIE)?.value;
  if (!token) return null;

  const rows = await query<BarisSesi>(
    `SELECT s.id AS sesi_id, u.id AS user_id, u.email, u.name AS nama,
            u.role::text AS peran, s.token_hash,
            (s.last_seen_at < now() - ($2 || ' milliseconds')::interval)
              AS perlu_perpanjang
       FROM user_session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.hard_expires_at > now()
        AND u.is_active
        -- Akun sistem tidak pernah punya sesi HTTP; kalau suatu saat ada,
        -- ia bukan sesi yang sah.
        AND NOT u.is_system`,
    [sidik(token), JEDA_PERPANJANG_MS]
  );

  const s = rows[0];
  if (!s) return null;
  // Kecocokan sudah dijamin WHERE, tetapi perbandingan eksplisit membuat
  // kesalahan di kueri tidak berubah menjadi sesi yang diterima.
  if (!samaPersis(s.token_hash, sidik(token))) return null;
  if (!adalahPeran(s.peran)) return null;

  if (s.perlu_perpanjang) {
    /*
     * Perpanjangan menggeser batas MENGANGGUR, bukan batas mutlak.
     * hard_expires_at tidak pernah bergerak, sehingga sesi yang dipakai
     * terus-menerus tetap berakhir pada waktunya.
     */
    await query(
      `UPDATE user_session
          SET last_seen_at = now(),
              expires_at = LEAST(now() + ($2 || ' milliseconds')::interval,
                                 hard_expires_at)
        WHERE id = $1`,
      [s.sesi_id, IDLE_MS]
    );
  }

  return { id: s.user_id, email: s.email, nama: s.nama, peran: s.peran };
}

/** Membatalkan seluruh sesi seorang pengguna. Dipakai saat ganti sandi. */
export async function cabutSemuaSesi(penggunaId: string): Promise<void> {
  await query(
    `UPDATE user_session SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [penggunaId]
  );
}

/** Mencari pengguna untuk proses masuk. Mengembalikan hash kata sandinya. */
export async function cariUntukMasuk(email: string) {
  const rows = await query<{
    id: string;
    email: string;
    nama: string;
    peran: string;
    password_hash: string | null;
    is_active: boolean;
    is_system: boolean;
  }>(
    `SELECT id, email, name AS nama, role::text AS peran,
            password_hash, is_active, is_system
       FROM app_user WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
}
