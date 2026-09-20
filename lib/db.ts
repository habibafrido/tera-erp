import { Pool, PoolClient } from "pg";

/**
 * Satu pool untuk seluruh proses. Di mode dev Next.js memuat ulang modul
 * setiap kali file berubah, jadi pool disimpan di globalThis supaya tidak
 * menumpuk koneksi sampai Postgres menolak.
 */
const g = globalThis as unknown as { __pool?: Pool };

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL belum diatur. Salin .env.example menjadi .env.local."
    );
  }
  return new Pool({ connectionString: url, max: 10 });
}

export function pool(): Pool {
  if (!g.__pool) g.__pool = makePool();
  return g.__pool;
}

/**
 * Semua kolom numeric(18,x) dikembalikan pg sebagai string supaya presisi
 * tidak hilang lewat float JavaScript. Itu disengaja: angka uang diformat
 * dari string, dan semua aritmetika dikerjakan Postgres.
 */
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const r = await pool().query(sql, params);
  return r.rows as T[];
}

/**
 * Pembungkus transaksi. Callback menerima client yang sama dari awal sampai
 * akhir, sehingga pg_advisory_xact_lock dan constraint trigger DEFERRED
 * bekerja pada transaksi yang benar.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // Koneksi sudah mati; error aslinya yang penting.
    }
    throw e;
  } finally {
    c.release();
  }
}
