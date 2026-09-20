/**
 * Tes lapisan AI yang tidak melibatkan model bahasa sama sekali.
 *
 *   1. Role tera_readonly benar-benar ditolak saat menulis.
 *   2. Setiap alat berjalan, mengembalikan data terstruktur, dan
 *      menolak parameter tidak sah dengan rapi.
 *   3. Angka dari alat sama persis dengan angka yang dipakai halaman.
 *
 * Tidak butuh OPENROUTER_API_KEY dan tidak menulis apa pun ke database.
 * Jalankan: npm run test:ai
 */
import { Client } from "pg";
import { loadEnv } from "./env";
import { start } from "./pgctl";

const env = loadEnv();

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  const sama = String(a) === String(b) || Number(a) === Number(b);
  ok(label, sama, `dapat ${a}, harap ${b}`);
}

async function tesRoleReadonly() {
  console.log("\n--- Role tera_readonly ---");

  const url = process.env.READONLY_DATABASE_URL;
  if (!url) {
    ok("READONLY_DATABASE_URL terisi", false, "belum diatur di .env.local");
    return;
  }

  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const who = await c.query("SELECT current_user AS u");
    eq("terhubung sebagai tera_readonly", who.rows[0].u, "tera_readonly");

    const baca = await c.query("SELECT COUNT(*) AS n FROM product");
    ok("SELECT diizinkan", Number(baca.rows[0].n) >= 0, `product: ${baca.rows[0].n} baris`);

    // Setiap penulisan harus ditolak. Kode 42501 = insufficient_privilege,
    // 25006 = read_only_sql_transaction (dari default_transaction_read_only).
    const tolak = async (label: string, sql: string) => {
      try {
        await c.query(sql);
        ok(label, false, "perubahan LOLOS, padahal seharusnya ditolak");
      } catch (e) {
        const kode = (e as { code?: string }).code;
        const diterima = kode === "42501" || kode === "25006";
        ok(label, diterima, `ditolak SQLSTATE ${kode}: ${(e as Error).message.split("\n")[0]}`);
      }
    };

    await tolak(
      "INSERT ditolak",
      `INSERT INTO warehouse (code, name) VALUES ('HACK-1','Gudang sisipan')`
    );
    await tolak("UPDATE ditolak", `UPDATE product SET name = 'diubah' WHERE true`);
    await tolak("DELETE ditolak", `DELETE FROM partner WHERE true`);
    await tolak("TRUNCATE ditolak", `TRUNCATE journal_line`);
    await tolak(
      "CREATE TABLE ditolak",
      `CREATE TABLE seharusnya_gagal (id int)`
    );
  } finally {
    await c.end();
  }
}

async function tesAlat() {
  console.log("\n--- Registry alat ---");

  const { TOOLS, runTool } = await import("../lib/ai/tools");
  const { aiPool } = await import("../lib/ai/db");

  // Koneksi biasa (bukan role baca-saja) untuk menghitung pembanding
  // langsung dari database, supaya angka alat diadu dengan angka halaman.
  const pg = new Client({ connectionString: env.url });
  await pg.connect();
  const halamanQuery = async (sql: string) => (await pg.query(sql)).rows[0];

  try {
    ok("sepuluh alat terdaftar", TOOLS.length === 10, `jumlah: ${TOOLS.length}`);

    // Setiap alat wajib punya deskripsi dan skema parameter.
    const lengkap = TOOLS.every(
      (t) => t.name && t.description.length > 20 && t.parameters && t.handler
    );
    ok("semua alat punya nama, deskripsi, skema, handler", lengkap);

    // --- parameter tidak sah harus jadi hasil terbaca, bukan exception ---
    const salah = [
      ["kartu_stok tanpa sku", "kartu_stok", {}],
      ["tanggal ngawur", "kartu_stok", { sku: "X", gudang: "Y", dari: "kemarin", sampai: "2026-01-01" }],
      ["dari setelah sampai", "ringkasan_penjualan", { dari: "2026-12-31", sampai: "2026-01-01" }],
      ["per tidak dikenal", "ringkasan_penjualan", { dari: "2026-01-01", sampai: "2026-12-31", per: "gudang" }],
      ["limit di luar rentang", "cari_barang", { teks: "a", limit: 9999 }],
      ["alat tidak ada", "hapus_semua", {}],
    ] as const;

    for (const [label, nama, args] of salah) {
      const r = await runTool(nama, args as Record<string, unknown>);
      ok(
        `${label} → error rapi`,
        r.ok === false && typeof (r as { error: string }).error === "string",
        r.ok === false ? (r as { error: string }).error : "malah berhasil"
      );
    }

    // --- setiap alat bisa dijalankan dengan parameter sah ---
    console.log("");
    const jalan: [string, Record<string, unknown>][] = [
      ["cari_barang", { teks: "a" }],
      ["nilai_persediaan", {}],
      ["saldo_stok", {}],
      ["kartu_stok", { sku: "SKU-1001", gudang: "WH-PST", dari: "2020-01-01", sampai: "2030-12-31" }],
      ["batch_kedaluwarsa", { hari: 90 }],
      ["stok_mengendap", { hari: 60 }],
      ["ringkasan_penjualan", { dari: "2020-01-01", sampai: "2030-12-31", per: "pelanggan" }],
      ["ringkasan_penjualan", { dari: "2020-01-01", sampai: "2030-12-31", per: "barang" }],
      ["ringkasan_penjualan", { dari: "2020-01-01", sampai: "2030-12-31", per: "bulan" }],
      ["umur_piutang", {}],
      ["cari_dokumen", { teks: "/" }],
      ["jurnal_dokumen", { nomor_dokumen: "TIDAK-ADA" }],
    ];

    for (const [nama, args] of jalan) {
      const r = await runTool(nama, args);
      const label = `${nama}(${JSON.stringify(args).slice(0, 52)})`;
      if (!r.ok) {
        ok(label, false, r.error);
        continue;
      }
      ok(
        label,
        Array.isArray(r.rows) && typeof r.meta === "object",
        `${r.rows.length} baris, meta: ${Object.keys(r.meta).join(", ")}`
      );
    }

    // --- kolom satuan pada alat berkuantitas ---
    console.log("\n--- Satuan pada kuantitas ---");
    {
      /**
       * "200" tanpa satuan bisa berarti pcs atau kg. Alat yang melaporkan
       * kuantitas karena itu wajib membawa satuan dasarnya per baris, dan
       * total kuantitas hanya boleh ada kalau satuannya seragam.
       */
      const berkuantitas: [string, Record<string, unknown>][] = [
        ["saldo_stok", {}],
        ["kartu_stok", { sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini" }],
        ["batch_kedaluwarsa", { hari: 3650 }],
      ];

      for (const [nama, args] of berkuantitas) {
        const r = await runTool(nama, args);
        if (!r.ok) {
          ok(`${nama} berjalan`, false, r.error.slice(0, 70));
          continue;
        }
        if (r.rows.length === 0) {
          ok(`${nama} punya baris untuk diperiksa`, false, "nol baris");
          continue;
        }
        const adaSatuan = r.rows.every(
          (b) => typeof b.satuan === "string" && b.satuan !== ""
        );
        ok(
          `${nama}: setiap baris membawa kolom satuan`,
          adaSatuan,
          `contoh: ${String(r.rows[0].satuan)}`
        );

        // Satuannya harus benar-benar satuan dasar barang menurut database.
        const cocok = await halamanQuery(
          `SELECT u.code FROM product p JOIN uom u ON u.id = p.base_uom_id
            WHERE p.sku = $$${String(r.rows[0].sku ?? "SKU-1001")}$$`
        );
        if (cocok) {
          eq(`${nama}: satuan == uom.code milik barang`, r.rows[0].satuan ?? cocok.code, cocok.code);
        }
      }

      // total_qty hanya sah kalau satuannya seragam; satuannya ikut di meta.
      const semua = await runTool("saldo_stok", {});
      if (semua.ok) {
        const seragam = Number(semua.meta.jumlah_satuan ?? 0) === 1;
        ok(
          seragam
            ? "saldo_stok: satuan seragam → total_qty terisi dan satuan_qty ada"
            : "saldo_stok: satuan bercampur → total_qty null",
          seragam
            ? semua.meta.total_qty !== null && typeof semua.meta.satuan_qty === "string"
            : semua.meta.total_qty === null,
          `jumlah_satuan=${semua.meta.jumlah_satuan} total_qty=${semua.meta.total_qty} satuan_qty=${semua.meta.satuan_qty}`
        );
      }

      // Deskripsi alat wajib menyebut kolom satuan.
      for (const nama of ["saldo_stok", "kartu_stok", "batch_kedaluwarsa"]) {
        const t = TOOLS.find((x) => x.name === nama);
        ok(
          `${nama}: deskripsi menyebut kolom satuan`,
          Boolean(t && /satuan/i.test(t.description))
        );
      }
    }

    // --- agregat di meta harus cocok dengan SQL langsung ---
    console.log("\n--- Agregat di meta ---");
    {
      /**
       * Padanan asersi "tidak ada objek Date": bukan menutup satu lubang,
       * tapi menangkap lubang baru. Model akan menjumlahkan baris sendiri
       * kalau alat mengembalikan angka tanpa totalnya — jadi setiap alat
       * yang mengembalikan kolom numerik wajib menyediakan total di meta,
       * dan totalnya wajib sama dengan hasil SQL langsung.
       */
      const bandingkan = async (
        label: string,
        nama: string,
        args: Record<string, unknown>,
        field: string,
        sql: string
      ) => {
        const r = await runTool(nama, args);
        if (!r.ok) {
          ok(label, false, r.error.slice(0, 80));
          return;
        }
        const harap = Object.values(await halamanQuery(sql))[0];
        eq(label, r.meta[field], harap);
      };

      await bandingkan(
        "cari_barang.total_nilai_persediaan", "cari_barang", { teks: "a" },
        "total_nilai_persediaan",
        `SELECT ROUND(COALESCE(SUM(b.nilai),0),2) AS x
           FROM product p
           LEFT JOIN (SELECT product_id, SUM(stock_value) AS nilai
                        FROM v_stock_balance GROUP BY product_id) b
             ON b.product_id = p.id
          WHERE p.is_active AND (p.name ILIKE '%a%' OR p.sku ILIKE '%a%')`
      );

      await bandingkan(
        "saldo_stok.total_nilai", "saldo_stok", {},
        "total_nilai",
        `SELECT ROUND(COALESCE(SUM(stock_value),0),2) AS x FROM v_stock_balance`
      );

      await bandingkan(
        "batch_kedaluwarsa.jumlah_batch", "batch_kedaluwarsa", { hari: 3650 },
        "jumlah_batch",
        `SELECT COUNT(*) AS x FROM v_stock_fefo
          WHERE expiry_date IS NOT NULL AND days_to_expiry <= 3650`
      );

      await bandingkan(
        "stok_mengendap.total_nilai", "stok_mengendap", { hari: 1 },
        "total_nilai",
        `SELECT ROUND(COALESCE(SUM(b.stock_value),0),2) AS x
           FROM (SELECT product_id, SUM(qty_on_hand) AS qty_on_hand,
                        SUM(stock_value) AS stock_value
                   FROM v_stock_balance GROUP BY product_id) b
           LEFT JOIN (SELECT product_id, MAX(posted_at) AS keluar
                        FROM stock_ledger WHERE qty < 0 GROUP BY product_id) k
             ON k.product_id = b.product_id
          WHERE b.qty_on_hand > 0
            AND COALESCE(k.keluar, '1900-01-01'::timestamptz)
                < now() - ('1' || ' days')::interval`
      );

      await bandingkan(
        "umur_piutang.total_piutang", "umur_piutang", {},
        "total_piutang",
        `SELECT ROUND(COALESCE(SUM(total),0),2) AS x
           FROM sales_invoice WHERE status='POSTED'`
      );

      await bandingkan(
        "kartu_stok.total_masuk", "kartu_stok",
        { sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini" },
        "total_masuk",
        `SELECT COALESCE(SUM(CASE WHEN s.qty>0 THEN s.qty END),0) AS x
           FROM stock_ledger s
           JOIN product p ON p.id=s.product_id
           JOIN warehouse w ON w.id=s.warehouse_id
          WHERE p.sku='SKU-1001' AND w.code='WH-PST'
            AND s.posted_at >= date_trunc('year', CURRENT_DATE)
            AND s.posted_at < date_trunc('year', CURRENT_DATE) + INTERVAL '1 year'`
      );

      await bandingkan(
        "cari_dokumen.jumlah_faktur", "cari_dokumen", { teks: "INV" },
        "jumlah_faktur",
        `SELECT COUNT(*) AS x FROM sales_invoice s JOIN partner p ON p.id=s.customer_id
          WHERE s.doc_no ILIKE '%INV%' OR p.name ILIKE '%INV%'`
      );

      await bandingkan(
        "ringkasan_penjualan.total_subtotal", "ringkasan_penjualan",
        { periode: "tahun_ini" }, "total_subtotal",
        `SELECT ROUND(COALESCE(SUM(l.qty*l.unit_price),0),2) AS x
           FROM sales_invoice s JOIN sales_invoice_line l ON l.invoice_id=s.id
          WHERE s.status='POSTED'
            AND s.doc_date BETWEEN date_trunc('year',CURRENT_DATE)
                AND date_trunc('year',CURRENT_DATE)+INTERVAL '1 year'-INTERVAL '1 day'`
      );

      // Jurnal: debit dan kredit harus seimbang, dan alat harus mengatakannya.
      const noFak = (await halamanQuery(
        `SELECT doc_no FROM sales_invoice WHERE status='POSTED' LIMIT 1`
      ))?.doc_no as string | undefined;
      if (noFak) {
        const j = await runTool("jurnal_dokumen", { nomor_dokumen: noFak });
        if (j.ok) {
          eq("jurnal_dokumen.total_debit == total_kredit", j.meta.total_debit, j.meta.total_kredit);
          ok("jurnal_dokumen.seimbang = true", j.meta.seimbang === true);
        } else {
          ok("jurnal_dokumen berjalan", false, j.error);
        }
      }

      // Struktural: setiap alat yang mengembalikan kolom numerik wajib
      // menyediakan setidaknya satu total di meta. Inilah yang akan gagal
      // saat alat kesebelas dibuat tanpa total.
      const semua: [string, Record<string, unknown>][] = [
        ["cari_barang", { teks: "a" }],
        ["nilai_persediaan", {}],
        ["saldo_stok", {}],
        ["kartu_stok", { sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini" }],
        ["batch_kedaluwarsa", { hari: 3650 }],
        ["stok_mengendap", { hari: 1 }],
        ["ringkasan_penjualan", { periode: "tahun_ini" }],
        ["umur_piutang", {}],
        ["cari_dokumen", { teks: "/" }],
        ["jurnal_dokumen", { nomor_dokumen: noFak ?? "TIDAK-ADA" }],
      ];

      let tanpaTotal = 0;
      for (const [nama, args] of semua) {
        const r = await runTool(nama, args);
        if (!r.ok || r.rows.length === 0) continue;
        const adaKolomAngka = Object.entries(r.rows[0]).some(([k, v]) => {
          if (/tanggal|kedaluwarsa|posted_at|keluar_terakhir|bulan/i.test(k)) return false;
          const t = String(v);
          return t.trim() !== "" && Number.isFinite(Number(t));
        });
        if (!adaKolomAngka) continue;

        const adaTotal = Object.keys(r.meta).some((k) => /^total|^jumlah_|mutasi|seimbang/.test(k));

        // Sebagian alat SENDIRI adalah agregat: satu baris yang seluruh
        // kolomnya sudah berupa total (nilai_persediaan). Tidak ada yang
        // bisa dijumlahkan lintas baris di situ, jadi tidak perlu total
        // terpisah di meta.
        const barisnyaAgregat =
          r.rows.length === 1 &&
          Object.keys(r.rows[0]).every((k) => /^total_|^jumlah_/.test(k));

        if (!adaTotal && !barisnyaAgregat) {
          tanpaTotal++;
          console.log(`    ✗ ${nama} mengembalikan kolom numerik tanpa total di meta`);
        }
      }
      eq("setiap alat berkolom numerik menyediakan total di meta", tanpaTotal, 0);
    }

    // --- tanggal di baris hasil: harus teks, bukan objek Date ---
    console.log("\n--- Tanggal di baris hasil ---");
    {
      const hariIni = (
        await halamanQuery("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")
      ).d as string;
      const iso = /^\d{4}-\d{2}-\d{2}$/;

      const batch = await runTool("batch_kedaluwarsa", { hari: 3650 });
      if (batch.ok && batch.rows.length > 0) {
        const v = batch.rows[0].kedaluwarsa;
        ok(
          "batch_kedaluwarsa.kedaluwarsa berupa teks YYYY-MM-DD",
          typeof v === "string" && iso.test(v),
          `nilai: ${String(v)} (tipe ${typeof v})`
        );
        eq("batch_kedaluwarsa.dihitung_pada == CURRENT_DATE", batch.meta.dihitung_pada, hariIni);
      } else {
        ok("batch_kedaluwarsa punya baris untuk diperiksa", false, "tidak ada batch bersaldo");
      }

      const kartu = await runTool("kartu_stok", {
        sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini",
      });
      if (kartu.ok && kartu.rows.length > 0) {
        const v = kartu.rows[0].posted_at;
        ok(
          "kartu_stok.posted_at berupa teks, bukan objek Date",
          typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v),
          `nilai: ${String(v)} (tipe ${typeof v})`
        );
      }

      const mengendap = await runTool("stok_mengendap", { hari: 1 });
      if (mengendap.ok) {
        eq("stok_mengendap.dihitung_pada == CURRENT_DATE", mengendap.meta.dihitung_pada, hariIni);
        const adaDate = mengendap.rows.some((r) => r.keluar_terakhir instanceof Date);
        ok("stok_mengendap.keluar_terakhir bukan objek Date", !adaDate);
      }

      const nilai = await runTool("nilai_persediaan", {});
      eq(
        "nilai_persediaan.dihitung_pada == CURRENT_DATE",
        nilai.ok ? nilai.meta.dihitung_pada : "gagal",
        hariIni
      );

      const posisi = await runTool("saldo_stok", {});
      eq(
        "saldo_stok.posisi_per == CURRENT_DATE",
        posisi.ok ? posisi.meta.posisi_per : "gagal",
        hariIni
      );

      const piutang = await runTool("umur_piutang", {});
      eq(
        "umur_piutang.dihitung_pada == CURRENT_DATE",
        piutang.ok ? piutang.meta.dihitung_pada : "gagal",
        hariIni
      );
    }

    // --- cache alat per giliran ---
    console.log("\n--- Cache alat ---");
    {
      const { buatCacheGiliran, kunciCache } = await import("../lib/ai/cache");

      eq(
        "urutan kunci parameter tidak mengubah kunci cache",
        kunciCache("x", { sampai: "2026-09-30", dari: "2026-09-01" }),
        kunciCache("x", { dari: "2026-09-01", sampai: "2026-09-30" })
      );
      ok(
        "nama alat berbeda menghasilkan kunci berbeda",
        kunciCache("a", { p: 1 }) !== kunciCache("b", { p: 1 })
      );
      ok(
        "nilai parameter berbeda menghasilkan kunci berbeda",
        kunciCache("a", { p: 1 }) !== kunciCache("a", { p: 2 })
      );
      eq(
        "parameter undefined diabaikan",
        kunciCache("a", { p: 1, q: undefined }),
        kunciCache("a", { p: 1 })
      );

      const c = buatCacheGiliran<string>();
      const k1 = c.kunci("ringkasan_penjualan", { per: "pelanggan", periode: "bulan_ini" });
      const k2 = c.kunci("ringkasan_penjualan", { periode: "bulan_ini", per: "pelanggan" });
      ok("belum ada isi sebelum disimpan", c.ambil(k1) === undefined);
      c.simpan(k1, "hasil-pertama");
      eq("panggilan identik kedua dilayani cache", c.ambil(k2), "hasil-pertama");
      eq("cache hanya menyimpan satu entri", c.jumlah(), 1);

      const lain = buatCacheGiliran<string>();
      ok("cache giliran baru selalu kosong", lain.ambil(k1) === undefined);
    }

    // --- periode relatif ---
    console.log("\n--- Periode relatif ---");

    const per = async (args: Record<string, unknown>) =>
      runTool("ringkasan_penjualan", args);

    for (const nama of [
      "hari_ini", "7_hari_terakhir", "30_hari_terakhir", "90_hari_terakhir",
      "bulan_ini", "bulan_lalu", "tahun_ini", "tahun_lalu",
    ]) {
      const r = await per({ periode: nama });
      ok(
        `periode ${nama}`,
        r.ok === true && typeof r.meta.periode === "string",
        r.ok ? `${r.meta.periode} → ${r.rows.length} baris` : r.error
      );
    }

    // Rentang yang dilaporkan harus dihitung Postgres, bukan ditebak model.
    const hariIni = await halamanQuery(
      `SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS awal,
              to_char(date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
                      - INTERVAL '1 day', 'YYYY-MM-DD') AS akhir`
    );
    const bulanIni = await per({ periode: "bulan_ini" });
    if (bulanIni.ok) {
      eq("bulan_ini mulai = awal bulan menurut Postgres", bulanIni.meta.tanggal_mulai, hariIni.awal);
      eq("bulan_ini akhir = akhir bulan menurut Postgres", bulanIni.meta.tanggal_akhir, hariIni.akhir);
    }

    // periode dan dari/sampai saling eksklusif.
    const bentrok = await per({ periode: "bulan_ini", dari: "2026-01-01", sampai: "2026-12-31" });
    ok(
      "periode + dari/sampai ditolak",
      bentrok.ok === false,
      bentrok.ok === false ? bentrok.error.slice(0, 80) : "malah diterima"
    );

    const ngawur = await per({ periode: "minggu_depan" });
    ok(
      "periode tidak dikenal ditolak",
      ngawur.ok === false,
      ngawur.ok === false ? ngawur.error.slice(0, 80) : "malah diterima"
    );

    const kosong = await per({});
    ok(
      "tanpa periode maupun dari/sampai ditolak",
      kosong.ok === false,
      kosong.ok === false ? kosong.error.slice(0, 80) : "malah diterima"
    );

    // kartu_stok juga menerima periode.
    const ks = await runTool("kartu_stok", {
      sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini",
    });
    ok(
      "kartu_stok menerima periode",
      ks.ok === true,
      ks.ok ? `${ks.meta.periode} → ${ks.rows.length} baris` : ks.error
    );

    // --- angka alat harus sama persis dengan angka halaman ---
    console.log("\n--- Kecocokan dengan halaman ---");

    const halaman = new Client({ connectionString: env.url });
    await halaman.connect();
    try {
      // Halaman Saldo stok menjumlahkan stock_value dari v_stock_balance.
      const hal = await halaman.query(
        "SELECT COALESCE(SUM(stock_value),0) AS total FROM v_stock_balance"
      );
      const alat = await runTool("nilai_persediaan", {});
      if (alat.ok) {
        eq(
          "nilai_persediaan == total halaman Saldo stok",
          alat.rows[0].total_nilai,
          hal.rows[0].total
        );
      } else {
        ok("nilai_persediaan berjalan", false, alat.error);
      }

      // Panel beranda: v_stock_fefo, expiry <= 90 hari.
      const halB = await halaman.query(
        `SELECT COUNT(*) AS n FROM v_stock_fefo
          WHERE expiry_date IS NOT NULL AND days_to_expiry <= 90`
      );
      const alatB = await runTool("batch_kedaluwarsa", { hari: 90, limit: 50 });
      if (alatB.ok) {
        eq(
          "batch_kedaluwarsa(90) == panel beranda",
          alatB.rows.length,
          halB.rows[0].n
        );
      } else {
        ok("batch_kedaluwarsa berjalan", false, alatB.error);
      }
    } finally {
      await halaman.end();
    }
  } finally {
    await pg.end().catch(() => {});
    await aiPool().end().catch(() => {});
  }
}

async function main() {
  await start();
  await tesRoleReadonly();
  await tesAlat();
  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
