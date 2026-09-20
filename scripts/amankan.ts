/**
 * Mengacak kata sandi role baca-saja untuk pemasangan sungguhan.
 *
 * db/004_ai_role.sql membuat role tera_readonly dengan kata sandi yang
 * TERTULIS DI DALAM BERKAS ITU. Untuk database di komputer sendiri itu
 * tidak apa-apa — tidak ada yang bisa menjangkaunya. Begitu databasenya
 * terkelola dan repositorinya bisa dibaca publik, kata sandi itu
 * berubah menjadi kredensial yang diketahui siapa saja.
 *
 * Skrip ini menggantinya dengan 32 byte acak dan mencetak
 * READONLY_DATABASE_URL yang baru. Kata sandinya hanya ditampilkan
 * SEKALI; ia tidak disimpan ke berkas mana pun karena berkas itulah
 * yang bermasalah sejak awal.
 *
 * Jalankan: npm run db:amankan
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { loadEnv } from "./env";

const env = loadEnv();

async function main() {
  const host = new URL(env.url).hostname;
  const sandi = randomBytes(24).toString("base64url");

  const c = new Client({ connectionString: env.url });
  await c.connect();

  try {
    const ada = await c.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'tera_readonly'`
    );
    if (ada.rows.length === 0) {
      throw new Error(
        "Role tera_readonly belum ada. Jalankan `npm run db:migrate` dulu.\n" +
          "Kalau migrasi 004 gagal karena hak akses, penyedia database Anda " +
          "tidak mengizinkan CREATE ROLE — laporkan supaya jalur asisten AI " +
          "bisa disesuaikan."
      );
    }

    /*
     * ALTER ROLE tidak menerima parameter terikat, jadi kata sandinya
     * harus ikut ke dalam teks perintah. Yang membuatnya aman bukan
     * anggapan melainkan PEMERIKSAAN: base64url hanya menghasilkan
     * A-Z a-z 0-9 _ dan -, dan itu ditegaskan di sini sebelum dipakai.
     * Kalau suatu saat cara pembangkitannya diubah dan menghasilkan
     * tanda kutip, baris ini berhenti — bukan menyuntikkan apa pun.
     */
    if (!/^[A-Za-z0-9_-]+$/.test(sandi)) {
      throw new Error("Kata sandi acak mengandung karakter di luar dugaan.");
    }
    await c.query(`ALTER ROLE tera_readonly PASSWORD '${sandi}'`);

    const u = new URL(env.url);

    /*
     * Pooler Supabase (Supavisor) merutekan berdasarkan NAMA PENGGUNA:
     * bentuknya `<role>.<project-ref>`, dan tanpa akhiran itu ia
     * menolak dengan "no tenant identifier provided". Akhirannya
     * diambil dari pengguna yang sedang dipakai, bukan ditebak.
     *
     * Untuk PostgreSQL biasa tidak ada titik di nama penggunanya, dan
     * cabang ini terlewati begitu saja.
     */
    const titik = u.username.indexOf(".");
    const tenant = titik === -1 ? "" : u.username.slice(titik);
    u.username = "tera_readonly" + tenant;
    u.password = sandi;

    console.log("\n✓ Kata sandi tera_readonly diganti pada " + host + ".\n");
    console.log("Salin baris ini ke variabel lingkungan Vercel:\n");
    console.log("READONLY_DATABASE_URL=" + u.toString() + "\n");
    console.log(
      "Kata sandinya TIDAK disimpan di mana pun. Kalau hilang, jalankan\n" +
        "skrip ini lagi untuk membuat yang baru.\n"
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
