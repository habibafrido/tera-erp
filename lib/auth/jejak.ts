import { query } from "../db";
import { agenPengguna, alamatIp, type Pengguna } from "./sesi";
import type { Aksi } from "./izin";

/**
 * ============================================================
 * JEJAK AUDIT
 * ============================================================
 * audit_log append-only, dijaga trigger. Yang ditulis di sini tidak bisa
 * diambil kembali — termasuk oleh kode ini sendiri.
 *
 * Upaya yang DITOLAK ikut dicatat, dan itu bukan sekadar kelengkapan:
 * seratus penolakan berturut-turut pada aksi yang sama dari satu akun
 * adalah satu-satunya hal yang bisa membedakan orang yang salah klik
 * dari orang yang sedang mencoba-coba. Log yang hanya memuat
 * keberhasilan tidak pernah bisa menunjukkan itu.
 */

export type Keluaran = "BERHASIL" | "DITOLAK" | "GAGAL";

export type IsiJejak = {
  aksi: Aksi | string;
  hasil: Keluaran;
  alasan?: string | null;
  pengguna?: Pengguna | null;
  dokumenJenis?: string | null;
  dokumenId?: string | null;
  dokumenNo?: string | null;
  detail?: unknown;
};

/**
 * Menulis satu baris jejak.
 *
 * TIDAK PERNAH melempar. Jejak audit yang gagal ditulis tidak boleh
 * menggagalkan aksi yang sudah berhasil — dan kegagalannya sendiri
 * dilaporkan ke log server supaya tidak hilang diam-diam.
 */
export async function catat(isi: IsiJejak): Promise<void> {
  try {
    const [ip, ua] = await Promise.all([alamatIp(), agenPengguna()]);
    await query(
      `INSERT INTO audit_log
         (user_id, email, role, action, outcome, reason,
          doc_type, doc_id, doc_no, ip, user_agent, detail)
       VALUES ($1,$2,$3::app_role,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        isi.pengguna?.id ?? null,
        isi.pengguna?.email ?? null,
        isi.pengguna?.peran ?? null,
        isi.aksi,
        isi.hasil,
        isi.alasan ?? null,
        isi.dokumenJenis ?? null,
        isi.dokumenId ?? null,
        isi.dokumenNo ?? null,
        ip,
        ua,
        isi.detail === undefined ? null : JSON.stringify(isi.detail),
      ]
    );
  } catch (e) {
    console.error(
      "[audit] gagal menulis jejak untuk " + isi.aksi + ": " +
        (e instanceof Error ? e.message : String(e))
    );
  }
}
