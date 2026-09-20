/**
 * Tes format angka pada jejak alat.
 *
 * Bug yang melatarbelakanginya: "total qty" tampil sebagai "Rp 750".
 * Formatnya harus ditentukan ARTI kolom, bukan tipe datanya — keduanya
 * sama-sama angka, tapi yang satu jumlah unit dan yang lain rupiah.
 *
 * Jalankan: npm run test:format
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Jejak, formatNilai, jenisKolom, namaTampilan } from "../components/JejakAlat";
import type { PanggilanAlat } from "../components/JejakAlat";

let gagal = 0;
function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!benar) gagal++;
}

const RUPIAH = [
  "nilai", "total_nilai", "subtotal", "total_subtotal", "hpp", "total_hpp",
  "margin", "total_margin", "biaya_rata_rata", "biaya_satuan", "harga",
  "total_piutang", "umur_0_30", "total_0_30", "total_di_atas_90",
  "total_debit", "total_kredit", "debit", "credit",
  "saldo_nilai_setelah", "nilai_persediaan",
  "total_nilai_penerimaan", "total_nilai_faktur",
];
const POLOS = [
  "qty", "total_qty", "saldo_qty", "qty_terjual", "saldo_qty_setelah",
  "total_qty_semua_barang", "jumlah_sku", "jumlah_batch", "jumlah_barang",
  "jumlah_baris_saldo", "jumlah_baris", "jumlah_baris_seluruhnya",
  "sisa_hari", "total_masuk", "total_keluar", "mutasi_bersih",
  "jumlah_pelanggan", "jumlah_penerimaan", "jumlah_faktur",
  "jumlah_kelompok_seluruhnya", "baris_seluruhnya",
];
const PERSEN = ["margin_persen", "total_margin_persen"];
const TANGGAL = ["tanggal", "kedaluwarsa", "posted_at", "keluar_terakhir"];

console.log("\n--- Jenis kolom ---");
for (const k of RUPIAH) ok(`${k} → rupiah`, jenisKolom(k) === "rupiah", jenisKolom(k));
for (const k of POLOS) ok(`${k} → polos`, jenisKolom(k) === "polos", jenisKolom(k));
for (const k of PERSEN) ok(`${k} → persen`, jenisKolom(k) === "persen", jenisKolom(k));
for (const k of TANGGAL) ok(`${k} → tanggal`, jenisKolom(k) === "tanggal", jenisKolom(k));

console.log("\n--- Nilai terformat ---");
ok('total_qty 750 tanpa "Rp"', !formatNilai("total_qty", "750").includes("Rp"),
   formatNilai("total_qty", "750"));
ok("total_nilai 7635000 pakai Rp", formatNilai("total_nilai", "7635000.00").startsWith("Rp"),
   formatNilai("total_nilai", "7635000.00"));
ok("margin_persen 34.78 jadi persen", formatNilai("margin_persen", "34.78") === "34,78%",
   formatNilai("margin_persen", "34.78"));
ok("jumlah_baris_saldo polos", formatNilai("jumlah_baris_saldo", "4") === "4",
   formatNilai("jumlah_baris_saldo", "4"));
ok("kolom tak dikenal tidak diberi Rp",
   !formatNilai("kolom_aneh_123", "999").includes("Rp"),
   formatNilai("kolom_aneh_123", "999"));

console.log("\n--- Nama tampilan (E6) ---");
const alat = ["cari_barang","nilai_persediaan","saldo_stok","kartu_stok",
  "batch_kedaluwarsa","stok_mengendap","ringkasan_penjualan","umur_piutang",
  "cari_dokumen","jurnal_dokumen"];
for (const a of alat) {
  const n = namaTampilan(a);
  ok(`${a} → "${n}"`, !n.includes("_") && n[0] === n[0].toUpperCase());
}

// ------------------------------------------------------------------
// Tampilan nota sumber
// ------------------------------------------------------------------
const render = (a: PanggilanAlat) =>
  renderToStaticMarkup(createElement(Jejak, { a }));

console.log("\n--- Nota sumber: hasil SATU baris ---");
{
  const satu: PanggilanAlat = {
    id: "1",
    nama: "nilai_persediaan",
    args: {},
    ok: true,
    meta: {
      gudang: "semua gudang",
      satuan_nilai: "IDR",
      dihitung_pada: "2026-09-20",
      sumber: "v_stock_balance (buku besar stok append-only)",
    },
    rows: [
      {
        total_nilai: "7635000.00",
        total_qty: "750.000000",
        jumlah_sku: "3",
        jumlah_baris_saldo: "4",
      },
    ],
  };
  const h = render(satu);

  ok("tertutup secara bawaan (tanpa atribut open)", !/<details[^>]*\sopen/.test(h));
  ok("memakai nama tampilan manusia", h.includes("Nilai persediaan"));
  ok("nama teknis tidak muncul di tampilan bawaan", !h.includes("nilai_persediaan"));
  ok(
    "baris sumber menyebut gudang dan tanggal",
    h.includes("semua gudang") && h.includes("20 Sep 2026")
  );
  ok("TIDAK merender tabel untuk hasil satu baris", !h.includes("<table"));
  ok("tidak ada JSON di tampilan bawaan", !h.includes("&quot;total_nilai&quot;"));
  ok('menyediakan tautan "Lihat data mentah"', h.includes("Lihat data mentah"));
  ok("tidak ada label Parameter / Konteks hasil", !/Parameter|Konteks hasil/.test(h));
}

console.log("\n--- Nota sumber: hasil BANYAK baris ---");
{
  const banyak: PanggilanAlat = {
    id: "2",
    nama: "ringkasan_penjualan",
    args: { periode: "bulan_ini", per: "pelanggan" },
    ok: true,
    meta: {
      tanggal_mulai: "2026-09-01",
      tanggal_akhir: "2026-09-30",
      keterangan: "subtotal belum termasuk PPN; hpp memakai biaya rata-rata bergerak",
      total_subtotal: "1900000.00",
    },
    rows: [
      { pelanggan: "Minimarket Amanah", subtotal: "1380000.00", margin_persen: "34.78" },
      { pelanggan: "Toko Makmur Jaya", subtotal: "520000.00", margin_persen: "38.46" },
    ],
  };
  const h = render(banyak);

  ok("tertutup secara bawaan", !/<details[^>]*\sopen/.test(h));
  ok("merender tabel untuk hasil banyak baris", h.includes("<table"));
  ok(
    "baris sumber menyebut rentang tanggal",
    h.includes("1 Sep 2026") && h.includes("30 Sep 2026")
  );
  ok("keterangan tampil sebagai kalimat biasa", h.includes("subtotal belum termasuk PPN"));
  ok("subtotal diformat rupiah", h.includes("1.380.000"));
  ok("persen diformat persen", h.includes("34,78%"));
  ok("tidak ada JSON di tampilan bawaan", !h.includes("&quot;pelanggan&quot;"));
}

console.log("\n--- Nota sumber: kuantitas tidak diberi Rp ---");
{
  const kartu: PanggilanAlat = {
    id: "3",
    nama: "kartu_stok",
    args: { sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini" },
    ok: true,
    meta: {
      tanggal_mulai: "2026-01-01",
      tanggal_akhir: "2026-12-31",
      total_masuk: "400.000000",
      total_keluar: "180.000000",
      satuan_qty: "PCS",
    },
    rows: [
      { jenis: "PURCHASE_RECEIPT", qty: "200.000000", satuan: "PCS",
        biaya_satuan: "14000.000000" },
      { jenis: "SALES_ISSUE", qty: "-120.000000", satuan: "PCS",
        biaya_satuan: "15000.000000" },
    ],
  };
  const h = render(kartu);
  const sel = h.match(/<td class="td-num">([^<]*)<\/td>/g) ?? [];
  console.log("    sel angka: " + sel.join("  "));

  ok("qty 200 tidak diberi Rp", sel.some((x) => x.includes(">200 ")));
  ok("qty -120 tidak diberi Rp", sel.some((x) => x.includes(">-120 ")));
  ok("biaya_satuan tetap rupiah", sel.some((x) => x.includes("Rp") && x.includes("14.000")));
}

console.log("\n--- Satuan menempel pada kuantitas ---");
{
  const kartu: PanggilanAlat = {
    id: "4",
    nama: "kartu_stok",
    args: { sku: "SKU-1001", gudang: "WH-PST", periode: "tahun_ini" },
    ok: true,
    meta: { tanggal_mulai: "2026-01-01", tanggal_akhir: "2026-12-31", satuan_qty: "PCS" },
    rows: [
      { jenis: "PURCHASE_RECEIPT", qty: "200.000000", satuan: "PCS",
        biaya_satuan: "14000.000000", saldo_qty_setelah: "200.000000" },
      { jenis: "SALES_ISSUE", qty: "-120.000000", satuan: "PCS",
        biaya_satuan: "15000.000000", saldo_qty_setelah: "80.000000" },
    ],
  };
  const h = render(kartu);
  const sel = h.match(/<td class="td-num">([^<]*)<\/td>/g) ?? [];
  console.log("    sel angka: " + sel.join("  "));

  ok("qty disertai satuan", sel.some((x) => x.includes(">200 PCS<")));
  ok("qty negatif disertai satuan", sel.some((x) => x.includes(">-120 PCS<")));
  ok("saldo berjalan disertai satuan", sel.some((x) => x.includes(">80 PCS<")));
  ok(
    "kolom uang TIDAK diberi satuan barang",
    !sel.some((x) => /Rp[^<]*PCS/.test(x)),
    sel.filter((x) => x.includes("Rp")).join(" ")
  );

  /*
   * Asersi inti permintaan ini: kalau baris punya kolom satuan, tidak boleh
   * ada satu pun sel kuantitas yang tampil polos tanpa satuannya.
   */
  const kolomQty = ["qty", "saldo_qty_setelah"];
  let telanjang = 0;
  for (const baris of kartu.rows ?? []) {
    for (const k of kolomQty) {
      const teks = formatNilai(k, baris[k]);
      const tampil = h.includes(">" + teks + " " + baris.satuan + "<");
      if (!tampil) {
        telanjang++;
        console.log("    telanjang: " + k + " = " + teks);
      }
    }
  }
  ok("tidak ada kuantitas tampil tanpa satuan", telanjang === 0);

  // Tanpa kolom satuan, angka tetap tampil polos — bukan diberi satuan karangan.
  const tanpa: PanggilanAlat = {
    id: "5",
    nama: "saldo_stok",
    args: {},
    ok: true,
    meta: {},
    // Dua baris supaya tabelnya memang dirender (hasil satu baris sengaja
    // tidak ditabelkan — lihat aturan E5).
    rows: [
      { sku: "X", qty: "10.000000", nilai: "1000.00" },
      { sku: "Y", qty: "20.000000", nilai: "2000.00" },
    ],
  };
  const h2 = render(tanpa);
  ok(
    "tanpa kolom satuan, qty tetap polos (bukan diberi satuan karangan)",
    h2.includes(">10<") && h2.includes(">20<")
  );
}

console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
process.exit(gagal === 0 ? 0 : 1);
