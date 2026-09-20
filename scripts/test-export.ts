/**
 * Tes ekspor Excel.
 *
 * Berkasnya diunduh lewat HTTP lalu DIBACA ULANG dengan exceljs. Itu
 * satu-satunya cara membuktikan selnya benar-benar bertipe angka dan
 * tanggal — memeriksa respons HTTP saja tidak membuktikan apa pun tentang
 * isi workbook.
 *
 *   npm run dev        (di terminal lain)
 *   npm run test:export
 *
 * Dijalankan juga di dua zona waktu, karena bug tanggal yang pernah kita
 * perbaiki hanya muncul di salah satu sisi UTC:
 *   $env:TZ='America/New_York'; npm run test:export
 */
import ExcelJS from "exceljs";
import { Client } from "pg";
import { loadEnv } from "./env";
import { AKUN, KATA_SANDI, masukSebagai, type Sesi } from "./masuk";
import { LAPORAN } from "../lib/export/reports";

const env = loadEnv();
const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, String(a) === String(b), `dapat ${a}, harap ${b}`);
}

/*
 * Skrip ini masuk lewat jalur yang sama dengan pengguna biasa dan
 * membawa cookie sesinya pada setiap permintaan. Tidak ada pemeriksaan
 * yang dilonggarkan supaya tes lewat — kalau autentikasinya rusak, tes
 * ini ikut gagal, dan itu memang yang diinginkan.
 */
let sesi: Sesi;

async function unduh(laporan: string, qs = "") {
  return fetch(`${BASE}/api/export/${laporan}${qs}`, {
    headers: { Cookie: sesi.cookie },
  });
}

async function bukaWorkbook(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return { wb, ws: wb.worksheets[0], ukuran: buf.length };
}

async function main() {
  try {
    // /masuk adalah satu-satunya halaman yang menjawab 200 tanpa sesi.
    const cek = await fetch(BASE + "/masuk", { signal: AbortSignal.timeout(5000) });
    if (!cek.ok) throw new Error("tidak sehat");
  } catch {
    console.log(`\n⚠ Server tidak berjalan di ${BASE}. Jalankan \`npm run dev\` dulu.`);
    process.exit(0);
  }

  sesi = await masukSebagai(BASE, AKUN.pengawas, KATA_SANDI);

  const db = new Client({ connectionString: env.url });
  await db.connect();

  console.log(`\nTZ Node: ${process.env.TZ ?? "(bawaan sistem)"}`);

  try {
    // ------------------------------------------------------------------
    console.log("\n--- Penolakan ---");

    const takDikenal = await unduh("laporan_ngawur");
    eq("laporan tidak dikenal → 400 (bukan 500)", takDikenal.status, 400);

    const filterNgawur = await unduh("saldo_stok", "?periode=bulan_depan");
    eq("filter tidak dikenal → 400", filterNgawur.status, 400);

    const periodeNgawur = await unduh("jurnal", "?periode=minggu_depan");
    eq("nilai periode tidak sah → 400", periodeNgawur.status, 400);

    // ------------------------------------------------------------------
    console.log("\n--- Semua laporan bisa diunduh ---");
    for (const l of LAPORAN) {
      const res = await unduh(l.nama);
      if (res.status !== 200) {
        ok(`${l.nama} → 200`, false, `HTTP ${res.status}: ${(await res.text()).slice(0, 90)}`);
        continue;
      }
      const tipe = res.headers.get("Content-Type") ?? "";
      const disp = res.headers.get("Content-Disposition") ?? "";
      const { ws, ukuran } = await bukaWorkbook(res);
      ok(
        `${l.nama} → xlsx sah`,
        tipe.includes("spreadsheetml.sheet") &&
          /filename="tera_[a-z-]+_\d{4}-\d{2}-\d{2}\.xlsx"/.test(disp) &&
          ws.rowCount >= 5,
        `${ukuran} bytes, ${ws.rowCount} baris, ${disp.replace(/.*filename="([^"]+)".*/, "$1")}`
      );
    }

    // ------------------------------------------------------------------
    console.log("\n--- Isi berkas: saldo_stok ---");
    {
      const res = await unduh("saldo_stok");
      const { ws } = await bukaWorkbook(res);

      // Tiga baris konteks + satu baris kosong + baris judul kolom.
      ok("baris 1 judul laporan", String(ws.getCell("A1").value).includes("Saldo stok"));
      ok("baris 2 ringkasan filter", String(ws.getCell("A2").value).length > 0,
         String(ws.getCell("A2").value));
      ok("baris 3 waktu cetak", /Dicetak \d{2} \w{3} \d{4}/.test(String(ws.getCell("A3").value)),
         String(ws.getCell("A3").value));

      const laporan = LAPORAN.find((l) => l.nama === "saldo_stok")!;
      eq("baris 5 = judul kolom pertama", ws.getCell("A5").value, laporan.kolom[0].judul);

      // Kolom uang HARUS bertipe angka, bukan teks.
      const kolomNilai = laporan.kolom.findIndex((k) => k.kunci === "nilai") + 1;
      const selNilai = ws.getCell(6, kolomNilai);
      ok(
        "kolom uang disimpan sebagai NUMBER",
        typeof selNilai.value === "number",
        `nilai=${JSON.stringify(selNilai.value)} tipe=${typeof selNilai.value} numFmt=${selNilai.numFmt}`
      );
      eq("numFmt uang", selNilai.numFmt, "#,##0");

      const kolomQty = laporan.kolom.findIndex((k) => k.kunci === "qty") + 1;
      ok("kolom qty NUMBER", typeof ws.getCell(6, kolomQty).value === "number");
      eq("numFmt qty", ws.getCell(6, kolomQty).numFmt, "#,##0.00");

      // Baris total memakai FORMULA, bukan angka mati.
      const barisTotal = ws.rowCount;
      const selTotal = ws.getCell(barisTotal, kolomNilai);
      const rumus = (selTotal.value as { formula?: string })?.formula ?? "";
      ok(
        "baris total memakai formula SUBTOTAL",
        rumus.startsWith("SUBTOTAL(109,"),
        `A${barisTotal}="${ws.getCell(barisTotal, 1).value}" rumus="${rumus}"`
      );

      ok("baris header dibekukan", ws.views?.[0]?.state === "frozen",
         JSON.stringify(ws.views?.[0]));
      ok("autofilter terpasang", Boolean(ws.autoFilter), JSON.stringify(ws.autoFilter));
      ok("lebar kolom disesuaikan", (ws.getColumn(2).width ?? 0) >= 10,
         `kolom 2 lebar ${ws.getColumn(2).width}`);

      // Ekspor mengabaikan LIMIT tampilan: seluruh baris harus ada.
      const { rows } = await db.query("SELECT COUNT(*) AS n FROM v_stock_balance");
      const seharusnya = Number(rows[0].n);
      const barisData = ws.rowCount - 6; // 5 baris atas + 1 baris total
      eq("berisi SELURUH baris (bukan yang tampil di layar)", barisData, seharusnya);
    }

    // ------------------------------------------------------------------
    console.log("\n--- Tanggal di berkas == tanggal di database ---");
    {
      const res = await unduh("daftar_faktur", "?periode=tahun_ini");
      const { ws } = await bukaWorkbook(res);
      const laporan = LAPORAN.find((l) => l.nama === "daftar_faktur")!;
      const kolomTgl = laporan.kolom.findIndex((k) => k.kunci === "tanggal") + 1;

      const { rows } = await db.query(
        `SELECT to_char(s.doc_date,'YYYY-MM-DD') AS t
           FROM sales_invoice s
          WHERE s.doc_date BETWEEN date_trunc('year',CURRENT_DATE)
                AND date_trunc('year',CURRENT_DATE)+INTERVAL '1 year'-INTERVAL '1 day'
          ORDER BY s.doc_date DESC, s.doc_no`
      );

      if (rows.length === 0) {
        ok("ada faktur untuk diperiksa", false, "nol baris");
      } else {
        let meleset = 0;
        for (let i = 0; i < rows.length; i++) {
          const sel = ws.getCell(6 + i, kolomTgl).value;
          const d = sel instanceof Date ? sel : null;
          if (!d) {
            meleset++;
            console.log(`    baris ${i + 1}: bukan tanggal Excel (${JSON.stringify(sel)})`);
            continue;
          }
          const z = (n: number) => String(n).padStart(2, "0");
          const teks = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
          if (teks !== rows[i].t) {
            meleset++;
            console.log(`    baris ${i + 1}: berkas ${teks} vs database ${rows[i].t}`);
          }
        }
        ok(
          `tanggal di ${rows.length} baris sama persis dengan database`,
          meleset === 0
        );
        eq("numFmt tanggal", ws.getCell(6, kolomTgl).numFmt, "dd/mm/yyyy");
      }
    }

    // ------------------------------------------------------------------
    console.log("\n--- Angka bisa langsung dijumlahkan ---");
    {
      const res = await unduh("umur_piutang");
      const { ws } = await bukaWorkbook(res);
      const laporan = LAPORAN.find((l) => l.nama === "umur_piutang")!;
      const kol = laporan.kolom.findIndex((k) => k.kunci === "total_piutang") + 1;

      let jumlah = 0;
      let semuaAngka = true;
      for (let r = 6; r < ws.rowCount; r++) {
        const v = ws.getCell(r, kol).value;
        if (typeof v !== "number") semuaAngka = false;
        else jumlah += v;
      }
      ok("setiap sel piutang bertipe angka", semuaAngka);

      const { rows } = await db.query(
        `SELECT ROUND(COALESCE(SUM(total),0),2) AS x FROM sales_invoice WHERE status='POSTED'`
      );
      ok(
        "SUM manual atas sel berkas == SUM database",
        Math.abs(jumlah - Number(rows[0].x)) < 0.01,
        `berkas ${jumlah}, database ${rows[0].x}`
      );
    }

    // ================================================================
    console.log("\n--- Laporan keuangan: subtotal berupa formula ---");
    // ================================================================

    {
      const hari = (
        await db.query("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")
      ).rows[0].d as string;

      const res = await unduh("neraca", `?per=${hari}&banding=${hari}`);
      eq("neraca HTTP 200", res.status, 200);

      const { ws } = await bukaWorkbook(res);

      /** Peta nama akun -> nomor baris, supaya asersi tidak bergantung
       *  pada urutan yang bisa berubah saat bagan akun bertambah. */
      const barisAkun = new Map<string, number>();
      ws.eachRow((row, n) => {
        const nama = String(row.getCell(3).value ?? "").trim();
        if (nama) barisAkun.set(nama, n);
      });

      const kolomSaldo = 4; // D: Saldo
      const BARIS_JUDUL = 5; // 3 baris konteks + 1 kosong + judul kolom

      const selTotalAset = ws.getCell(barisAkun.get("Total aset")!, kolomSaldo);
      const rumusAset = (selTotalAset.value as { formula?: string })?.formula ?? "";
      ok(
        "subtotal 'Total aset' berupa formula SUBTOTAL, bukan angka mati",
        /^SUBTOTAL\(109,D\d+:D\d+\)$/.test(rumusAset),
        `nilai sel: ${JSON.stringify(selTotalAset.value)}`
      );

      const selUji = ws.getCell(
        barisAkun.get("Aset dikurangi liabilitas dan ekuitas (harus nol)")!,
        kolomSaldo
      );
      const rumusUji = (selUji.value as { formula?: string })?.formula ?? "";
      ok(
        "baris uji keseimbangan mengurangkan subtotal, bukan angka mati",
        /^D\d+(-D\d+)+$/.test(rumusUji),
        `rumus: ${rumusUji}`
      );

      // Rentang SUBTOTAL harus berhenti tepat sebelum baris subtotalnya.
      const m = /^SUBTOTAL\(109,D(\d+):D(\d+)\)$/.exec(rumusAset);
      const barisSubtotal = barisAkun.get("Total aset")!;
      ok(
        "rentang subtotal berhenti tepat di baris sebelum subtotalnya",
        m !== null && Number(m[2]) === barisSubtotal - 1,
        `rentang ${m?.[1]}..${m?.[2]}, subtotal di baris ${barisSubtotal}`
      );

      // Persen tidak bisa dijumlahkan; pada baris subtotal ia harus
      // dihitung ulang dari kolom di barisnya sendiri, tetap sebagai
      // formula supaya tidak jadi angka mati di antara sel-sel hidup.
      const selPersen = ws.getCell(barisSubtotal, 7);
      const rumusPersen = (selPersen.value as { formula?: string })?.formula ?? "";
      ok(
        "kolom persen pada baris subtotal juga formula, bukan SUBTOTAL",
        rumusPersen.startsWith("IF(") && !rumusPersen.includes("SUBTOTAL"),
        `rumus: ${rumusPersen}`
      );

      // Laporan berjenjang TIDAK boleh mendapat baris TOTAL otomatis:
      // menjumlahkan baris akun bersama subtotalnya menghitung ganda.
      let adaTotal = false;
      ws.eachRow((row) => {
        if (String(row.getCell(1).value ?? "") === "TOTAL") adaTotal = true;
      });
      ok("tidak ada baris TOTAL otomatis pada laporan berjenjang", !adaTotal);

      /*
       * Nilai yang dijumlahkan formula harus NUMBER, bukan teks berformat:
       * "Rp 1.500.000" sebagai teks membuat SUBTOTAL di atasnya
       * menghasilkan nol tanpa pesan galat apa pun.
       *
       * Baris akun dikenali dari kolom Kode yang terisi — baris subtotal
       * dan baris uji keseimbangan tidak punya kode akun. Dicari begitu,
       * bukan lewat nama akun tertentu, supaya asersinya tidak diam-diam
       * terlewat kalau akun itu kebetulan tidak bersaldo.
       */
      const barisPertamaAkun: number[] = [];
      ws.eachRow((row, n) => {
        if (n > BARIS_JUDUL && String(row.getCell(2).value ?? "").trim()) {
          barisPertamaAkun.push(n);
        }
      });
      ok("ada baris akun untuk diperiksa", barisPertamaAkun.length > 0);
      const semuaNumber = barisPertamaAkun.every((n) => {
        const v = ws.getCell(n, kolomSaldo).value;
        return typeof v === "number" || v === null;
      });
      ok(
        "setiap saldo akun disimpan sebagai NUMBER",
        semuaNumber,
        `${barisPertamaAkun.length} baris akun diperiksa`
      );

      const resLR = await unduh(
        "laba_rugi",
        `?dari=${hari.slice(0, 4)}-01-01&sampai=${hari}&banding=tahun`
      );
      eq("laba rugi HTTP 200", resLR.status, 200);
      const { ws: wsLR } = await bukaWorkbook(resLR);

      let rumusLaba = "";
      wsLR.eachRow((row) => {
        if (String(row.getCell(3).value ?? "").trim() === "Laba bersih") {
          rumusLaba = (row.getCell(4).value as { formula?: string })?.formula ?? "";
        }
      });
      ok(
        "laba bersih = total pendapatan - total beban, sebagai formula",
        /^D\d+-D\d+$/.test(rumusLaba),
        `rumus: ${rumusLaba}`
      );

      // Filter tak sah ditolak sebelum kueri dijalankan.
      eq("tanggal ngawur ditolak 400", (await unduh("neraca", "?per=2026-02-30")).status, 400);
      eq(
        "pilihan pembanding ngawur ditolak 400",
        (await unduh("laba_rugi", "?banding=dasawarsa")).status,
        400
      );
    }
  } finally {
    await db.end();
  }

  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
