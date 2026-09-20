import { query } from "@/lib/db";
import { penggunaUntukApi } from "@/lib/auth/penjaga";
import { catat } from "@/lib/auth/jejak";
import {
  FilterTidakSah,
  cariLaporan,
  ringkasFilter,
  validasiFilter,
} from "@/lib/export/reports";
import { namaBerkas, tulisWorkbook } from "@/lib/export/xlsx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Batas keras. Ekspor sengaja MENGABAIKAN batas baris tampilan — orang
 * mengunduh justru untuk mendapat data utuh — tapi tetap perlu langit-langit
 * supaya satu permintaan tidak menghabiskan memori server.
 */
const MAKS_BARIS = 100_000;

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ laporan: string }> }
) {
  const pengguna = await penggunaUntukApi("laporan.unduh");
  if (!pengguna) {
    return Response.json(
      { error: "Sesi tidak ditemukan atau peran tidak berwenang." },
      { status: 401 }
    );
  }

  const { laporan: nama } = await ctx.params;
  const laporan = cariLaporan(nama);

  if (!laporan) {
    return Response.json(
      {
        error:
          `Laporan "${nama}" tidak dikenal. Yang tersedia: ` +
          (await import("@/lib/export/reports")).LAPORAN.map((l) => l.nama).join(", "),
      },
      { status: 400 }
    );
  }

  const params = new URL(req.url).searchParams;

  let filter;
  try {
    filter = validasiFilter(laporan, params);
  } catch (e) {
    if (e instanceof FilterTidakSah) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  try {
    const k = laporan.sql(filter);

    // Satu baris lebih dari batas diambil sengaja: itulah yang membedakan
    // "pas di batas" dari "terpotong diam-diam".
    const baris = await query<Record<string, unknown>>(
      `SELECT * FROM (${k.text}) AS laporan LIMIT ${MAKS_BARIS + 1}`,
      k.values
    );

    if (baris.length > MAKS_BARIS) {
      return Response.json(
        {
          error:
            `Hasil melebihi ${MAKS_BARIS.toLocaleString("id-ID")} baris. ` +
            "Persempit filternya — misalnya pilih periode yang lebih pendek " +
            "atau satu gudang saja — lalu unduh lagi.",
        },
        { status: 413 }
      );
    }

    // Waktu cetak berasal dari DATABASE, bukan jam Node: keduanya bisa
    // berbeda zona waktu, dan stempel waktu yang meleset membuat orang
    // ragu pada isi berkasnya.
    const [cap] = await query<{ dicetak: string; hari: string }>(
      `SELECT to_char(now(), 'DD Mon YYYY HH24:MI') AS dicetak,
              to_char(CURRENT_DATE, 'YYYY-MM-DD')  AS hari`
    );

    const buf = await tulisWorkbook({
      laporan,
      filter,
      ringkasan: ringkasFilter(laporan, filter),
      dicetakPada: cap.dicetak,
      baris,
    });

    /*
     * Unduhan ikut dicatat. Berkas ekspor adalah salinan data yang
     * meninggalkan sistem dan bisa beredar ke mana saja — "siapa yang
     * mengunduh daftar pelanggan bulan lalu" adalah pertanyaan yang
     * hanya bisa dijawab kalau jawabannya sudah dicatat saat itu.
     */
    await catat({
      aksi: "laporan.unduh",
      hasil: "BERHASIL",
      pengguna,
      dokumenJenis: "laporan",
      dokumenNo: laporan.nama,
      detail: { baris: baris.length, filter: ringkasFilter(laporan, filter) },
    });

    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${namaBerkas(laporan, cap.hari)}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[api/export]", e);
    return Response.json(
      { error: "Gagal menyusun berkas. Coba lagi sebentar lagi." },
      { status: 500 }
    );
  }
}
