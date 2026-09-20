import ExcelJS from "exceljs";
import { JENIS_BARIS } from "./reports";
import type { Kolom, Laporan, NilaiFilter, TipeKolom } from "./reports";

/**
 * ============================================================
 * PENULIS XLSX
 * ============================================================
 * XLSX asli, bukan CSV berganti ekstensi. Alasannya konkret: Excel
 * dengan locale Indonesia memakai TITIK KOMA sebagai pemisah CSV, dan
 * angka berformat Indonesia (1.500.000,50) hancur begitu dipisah koma.
 * XLSX tidak punya kelas masalah itu sama sekali.
 *
 * Aturan yang dipegang berkas ini:
 *  1. Angka ditulis sebagai NUMBER, bukan teks. "Rp 1.500.000" sebagai
 *     teks tidak bisa di-SUM, dan menjumlahkan adalah hal PERTAMA yang
 *     dilakukan orang keuangan begitu berkas terbuka.
 *  2. Tampilan diatur numFmt, bukan dengan memformat nilainya.
 *  3. Tanggal masuk sebagai teks 'YYYY-MM-DD' dari SQL lalu dibangun
 *     jadi tanggal Excel dari komponennya. Objek Date dari driver pg
 *     tidak pernah dilewatkan — pergeseran sehari di zona waktu positif
 *     sudah pernah terjadi dan tidak boleh kembali.
 */

/** Tiga baris konteks di atas tabel, lalu satu baris kosong. */
const BARIS_HEADER = 4;

const NUM_FMT: Record<TipeKolom, string | undefined> = {
  teks: undefined,
  uang: "#,##0",
  qty: "#,##0.00",
  persen: "0.00%",
  tanggal: "dd/mm/yyyy",
  integer: "#,##0",
};

const BISA_DIJUMLAH: TipeKolom[] = ["uang", "qty", "integer"];

/**
 * Tanggal Excel dibangun dari komponen teks, BUKAN lewat new Date(teks).
 *
 * `new Date("2026-09-20")` diurai sebagai tengah malam UTC; di zona waktu
 * negatif tanggalnya mundur sehari saat ditulis. Konstruktor komponen
 * menghasilkan tengah malam waktu lokal, dan itulah yang dipetakan ExcelJS
 * ke serial tanggal Excel.
 */
function tanggalExcel(v: unknown): Date | string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function nilaiSel(kolom: Kolom, v: unknown): string | number | Date | null {
  if (v === null || v === undefined) return null;

  if (kolom.tipe === "tanggal") return tanggalExcel(v);
  if (kolom.tipe === "teks") return String(v);

  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n;
}

/** Lebar kolom disesuaikan isi, dengan batas supaya tidak melebar liar. */
function lebar(kolom: Kolom, baris: Record<string, unknown>[]): number {
  let maks = kolom.judul.length;
  for (const b of baris) {
    const v = b[kolom.kunci];
    if (v === null || v === undefined) continue;
    const panjang =
      kolom.tipe === "uang" || kolom.tipe === "qty" || kolom.tipe === "integer"
        ? Math.round(Number(v)).toLocaleString("id-ID").length
        : String(v).length;
    if (panjang > maks) maks = panjang;
  }
  return Math.min(Math.max(maks + 2, 10), 48);
}

export type IsiBerkas = {
  laporan: Laporan;
  filter: NilaiFilter;
  ringkasan: string;
  /** Waktu cetak dari DATABASE, bukan dari jam Node. */
  dicetakPada: string;
  baris: Record<string, unknown>[];
};

/**
 * Mengubah baris subtotal dan selisih menjadi formula hidup.
 *
 * Dipanggil SETELAH semua baris data ditulis, karena nomor barisnya baru
 * pasti pada saat itu.
 */
function tulisBarisFormula(
  ws: ExcelJS.Worksheet,
  laporan: Laporan,
  baris: Record<string, unknown>[]
): void {
  const cfg = laporan.barisFormula!;
  const huruf = (i: number) => ws.getColumn(i + 1).letter;

  // Indeks kolom yang nilainya bisa dijumlahkan, dan kolom persen.
  const kolomJumlah = laporan.kolom
    .map((k, i) => ({ k, i }))
    .filter((x) => BISA_DIJUMLAH.includes(x.k.tipe));
  const kolomPersen = laporan.kolom
    .map((k, i) => ({ k, i }))
    .filter((x) => x.k.tipe === "persen");

  const iNilai = cfg.persenDari
    ? laporan.kolom.findIndex((k) => k.kunci === cfg.persenDari!.nilai)
    : -1;
  const iDasar = cfg.persenDari
    ? laporan.kolom.findIndex((k) => k.kunci === cfg.persenDari!.dasar)
    : -1;

  /** Nomor baris Excel dari indeks data. */
  const barisKe = (i: number) => BARIS_HEADER + 2 + i;

  /** Kedalaman akun pada baris data; null untuk baris yang bukan akun. */
  const dalam = (i: number): number | null => {
    if (!cfg.kolomKedalaman) return null;
    const v = baris[i][cfg.kolomKedalaman];
    return v === null || v === undefined ? null : Number(v);
  };

  /** Baris data yang ikut dijumlahkan sebuah subtotal bagian. */
  const isiBagian = (i: number): number | null => {
    let awal = i;
    while (awal > 0) {
      const j = String(baris[awal - 1][cfg.kolom] ?? "");
      if (j !== JENIS_BARIS.akun && j !== JENIS_BARIS.header) break;
      awal--;
    }
    return awal === i ? null : awal;
  };

  // Baris subtotal yang sudah ditulis, untuk dipakai baris "selisih".
  const subtotal: number[] = [];

  baris.forEach((b, i) => {
    const jenis = String(b[cfg.kolom] ?? "");
    if (
      jenis !== JENIS_BARIS.header &&
      jenis !== JENIS_BARIS.subtotal &&
      jenis !== JENIS_BARIS.selisih
    ) {
      return;
    }

    const r = barisKe(i);
    ws.getRow(r).font = { bold: true };

    for (const { k, i: c } of kolomJumlah) {
      const sel = ws.getCell(r, c + 1);
      const h = huruf(c);

      if (jenis === JENIS_BARIS.header) {
        /*
         * Akun header menjumlahkan SELURUH turunannya: baris-baris
         * sesudahnya yang lebih dalam, sampai bertemu baris yang
         * kedalamannya sama atau lebih dangkal.
         *
         * Rentangnya boleh memuat header lain — Excel dan LibreOffice
         * mengabaikan SUBTOTAL yang bersarang di dalam rentang SUBTOTAL,
         * jadi cucu tidak terhitung dua kali lewat anaknya.
         */
        const d = dalam(i);
        if (d === null) continue;
        let akhir = i;
        while (akhir + 1 < baris.length) {
          const dn = dalam(akhir + 1);
          if (dn === null || dn <= d) break;
          akhir++;
        }
        if (akhir === i) continue; // header tanpa turunan yang tampil
        sel.value = {
          formula: `SUBTOTAL(109,${h}${barisKe(i + 1)}:${h}${barisKe(akhir)})`,
        };
      } else if (jenis === JENIS_BARIS.subtotal) {
        // Rentang: seluruh baris akun dan header berurutan di atas baris
        // ini. Header di dalamnya diabaikan otomatis, seperti di atas.
        const awal = isiBagian(i);
        if (awal === null) continue;
        sel.value = {
          formula: `SUBTOTAL(109,${h}${barisKe(awal)}:${h}${barisKe(i - 1)})`,
        };
      } else {
        // selisih = subtotal pertama dikurangi semua subtotal sesudahnya.
        // Pada Neraca itu Aset − Liabilitas − Ekuitas; pada Laba Rugi
        // Pendapatan − Beban. Identitas yang sama, dua laporan.
        if (subtotal.length < 2) continue;
        const [pertama, ...sisa] = subtotal;
        sel.value = {
          formula:
            `${h}${pertama}` + sisa.map((x) => `-${h}${x}`).join(""),
        };
      }

      const fmt = NUM_FMT[k.tipe];
      if (fmt) sel.numFmt = fmt;
    }

    // Persen bukan besaran yang bisa dijumlahkan, jadi ia dihitung ulang
    // dari kolom nilai dan dasar pada BARIS YANG SAMA — tetap formula,
    // supaya tidak menjadi angka mati di antara sel-sel hidup.
    if (iNilai >= 0 && iDasar >= 0) {
      const hn = huruf(iNilai);
      const hd = huruf(iDasar);
      for (const { i: c } of kolomPersen) {
        const sel = ws.getCell(r, c + 1);
        sel.value = {
          formula: `IF(${hd}${r}=0,"",(${hn}${r}-${hd}${r})/ABS(${hd}${r}))`,
        };
        if (NUM_FMT.persen) sel.numFmt = NUM_FMT.persen;
      }
    }

    if (jenis === JENIS_BARIS.subtotal) subtotal.push(r);
  });
}

export async function tulisWorkbook(isi: IsiBerkas): Promise<Buffer> {
  const { laporan, ringkasan, dicetakPada, baris } = isi;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Tera ERP";
  const ws = wb.addWorksheet(laporan.judul.slice(0, 31));

  /*
   * Tiga baris konteks. Tanpa ini, berkas yang beredar lewat WhatsApp
   * kehilangan periodenya dan orang berdebat soal angka yang sebenarnya
   * berasal dari rentang berbeda.
   */
  ws.addRow([laporan.judul]);
  ws.addRow([ringkasan]);
  ws.addRow([`Dicetak ${dicetakPada} dari Tera ERP`]);
  ws.addRow([]);

  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(2).font = { size: 10 };
  ws.getRow(3).font = { size: 10, italic: true };

  // Baris judul kolom
  const barisJudul = ws.addRow(laporan.kolom.map((k) => k.judul));
  barisJudul.font = { bold: true };

  for (const b of baris) {
    ws.addRow(laporan.kolom.map((k) => nilaiSel(k, b[k.kunci])));
  }

  // Format dan lebar per kolom
  laporan.kolom.forEach((k, i) => {
    const col = ws.getColumn(i + 1);
    col.width = lebar(k, baris);
    const fmt = NUM_FMT[k.tipe];
    if (fmt) {
      // Baris data saja; baris konteks dan judul dibiarkan apa adanya.
      for (let r = BARIS_HEADER + 2; r <= BARIS_HEADER + 1 + baris.length; r++) {
        ws.getCell(r, i + 1).numFmt = fmt;
      }
    }
  });

  /*
   * Laporan berjenjang (Neraca, Laba Rugi): subtotal di TENGAH tabel.
   *
   * Baris "subtotal" menjumlahkan baris "akun" yang berurutan tepat di
   * atasnya, dan baris "selisih" mengurangkan subtotal kedua dan
   * seterusnya dari subtotal pertama. Semuanya FORMULA: kalau seseorang
   * mengoreksi satu angka akun di dalam berkas, subtotalnya ikut berubah
   * dan ketidakseimbangannya langsung terlihat — yang justru merupakan
   * gunanya laporan keuangan.
   *
   * Baris TOTAL otomatis di bawah sengaja dilewati untuk laporan jenis
   * ini: menjumlahkan baris akun BERSAMA subtotalnya menghitung ganda.
   */
  if (laporan.barisFormula && baris.length > 0) {
    tulisBarisFormula(ws, laporan, baris);
  }

  /*
   * Baris total memakai FORMULA SUBTOTAL(109; …), bukan angka mati.
   *
   * 109 adalah SUM yang mengabaikan baris tersembunyi, sehingga totalnya
   * ikut menyesuaikan begitu pengguna memakai autofilter. Angka mati akan
   * tetap menampilkan total seluruh data dan diam-diam bertentangan
   * dengan apa yang terlihat di layar.
   */
  if (!laporan.barisFormula && baris.length > 0) {
    const barisPertama = BARIS_HEADER + 2;
    const barisTerakhir = BARIS_HEADER + 1 + baris.length;
    const total = ws.addRow([]);
    total.font = { bold: true };

    laporan.kolom.forEach((k, i) => {
      const sel = total.getCell(i + 1);
      if (i === 0) {
        sel.value = "TOTAL";
        return;
      }
      if (!BISA_DIJUMLAH.includes(k.tipe)) return;
      const huruf = ws.getColumn(i + 1).letter;
      sel.value = {
        formula: `SUBTOTAL(109,${huruf}${barisPertama}:${huruf}${barisTerakhir})`,
      };
      const fmt = NUM_FMT[k.tipe];
      if (fmt) sel.numFmt = fmt;
    });
  }

  // Baris judul dibekukan, dan seluruh tabel diberi autofilter.
  ws.views = [{ state: "frozen", ySplit: BARIS_HEADER + 1 }];
  ws.autoFilter = {
    from: { row: BARIS_HEADER + 1, column: 1 },
    to: { row: BARIS_HEADER + 1 + baris.length, column: laporan.kolom.length },
  };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** tera_saldo-stok_2026-09-20.xlsx */
export function namaBerkas(laporan: Laporan, tanggal: string): string {
  const slug = laporan.nama.replace(/_/g, "-");
  return `tera_${slug}_${tanggal}.xlsx`;
}
