import { Pool } from "pg";

/**
 * Koneksi khusus chat AI. SENGAJA terpisah dari lib/db.ts.
 *
 * lib/db.ts memakai role pemilik yang bisa menulis — itu yang dipakai
 * mesin posting. Kalau chat ikut memakai pool yang sama, satu-satunya
 * penghalang perubahan data adalah kode aplikasi: registry alat dan
 * prompt sistem. Keduanya bisa keliru, dan prompt bisa disusupi lewat
 * isi data yang ikut terbaca.
 *
 * Di sini chat terhubung sebagai tera_readonly, yang secara hak akses
 * database memang tidak punya INSERT, UPDATE, DELETE, atau TRUNCATE.
 * Kalimat tidak bisa membujuk GRANT.
 */
const g = globalThis as unknown as { __aiPool?: Pool };

function makePool() {
  const url = process.env.READONLY_DATABASE_URL;
  if (!url) {
    throw new Error(
      "READONLY_DATABASE_URL belum diatur. Lihat .env.example; role dibuat oleh " +
        "`npm run db:migrate` (db/004_ai_role.sql)."
    );
  }

  return new Pool({
    connectionString: url,
    max: 4,

    /**
     * Sabuk pengaman kedua, di atas hak akses role:
     *
     *   default_transaction_read_only  — setiap transaksi dimulai baca-saja,
     *     sehingga penulisan ditolak bahkan seandainya suatu hari role ini
     *     salah diberi GRANT.
     *   statement_timeout              — satu kueri yang melenceng tidak bisa
     *     menahan koneksi sampai chat terasa menggantung.
     *   idle_in_transaction_session_timeout — transaksi yang tertinggal tidak
     *     menahan lock.
     */
    options:
      "-c default_transaction_read_only=on " +
      "-c statement_timeout=8000 " +
      "-c idle_in_transaction_session_timeout=15000",
  });
}

export function aiPool(): Pool {
  if (!g.__aiPool) g.__aiPool = makePool();
  return g.__aiPool;
}

/** Semua alat memakai fungsi ini. Tidak ada jalur lain ke database. */
export async function aiQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const r = await aiPool().query(sql, params as never[]);
  return r.rows as T[];
}
