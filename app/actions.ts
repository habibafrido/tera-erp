"use server";

import { revalidatePath } from "next/cache";
import { query, tx } from "@/lib/db";
import { denganPeran } from "@/lib/auth/penjaga";
import { catat } from "@/lib/auth/jejak";
import {
  batalkanDokumen,
  postGoodsReceipt,
  postPaymentReceipt,
  postPurchaseInvoice,
  postSalesInvoice,
  postSupplierPayment,
  type JenisDokumen,
} from "@/lib/posting";
import {
  bukaKembaliPeriode,
  labelPeriode,
  periksaPenutupan,
  tutupPeriode,
  type Masalah,
} from "@/lib/tutup-buku";

/**
 * ============================================================
 * SERVER ACTION
 * ============================================================
 * SETIAP aksi di berkas ini dibungkus denganPeran(). Tanpa pengecualian.
 *
 * Alasannya bukan kerapian. Server action adalah endpoint HTTP
 * tersendiri: klien memanggilnya lewat POST dengan header Next-Action,
 * tanpa pernah menavigasi ke halaman mana pun. Middleware dan layout
 * yang memeriksa "halaman apa yang dibuka" karena itu tidak pernah
 * dilewati — jadi kalau satu aksi di sini lupa dibungkus, ia bisa
 * dipanggil siapa saja dengan satu perintah curl.
 *
 * Aksi masuk dan keluar ada di app/auth-actions.ts, terpisah, karena
 * keduanya memang belum punya sesi untuk diperiksa.
 */
export type ActionResult = { ok: boolean; message: string };

// ---------------- Data induk ----------------

export const createProduct = denganPeran(
  ["staf_keuangan"],
  "barang.buat",
  async ({ pengguna }, fd: FormData): Promise<ActionResult> => {
  const sku = String(fd.get("sku") || "").trim();
  const name = String(fd.get("name") || "").trim();
  const uom = String(fd.get("uom") || "PCS");
  const batch = fd.get("is_batch_tracked") === "on";
  if (!sku || !name) return { ok: false, message: "SKU dan nama barang wajib diisi." };

  try {
    await query(
      `INSERT INTO product (sku, name, base_uom_id, is_batch_tracked)
       VALUES ($1,$2,(SELECT id FROM uom WHERE code=$3),$4)`,
      [sku, name, uom, batch]
    );
  } catch (e: any) {
    if (e.code === "23505") return { ok: false, message: "SKU " + sku + " sudah dipakai." };
    return { ok: false, message: e.message };
  }
  revalidatePath("/products");
  await catat({ aksi: "barang.buat", hasil: "BERHASIL", pengguna,
                dokumenJenis: "product", dokumenNo: sku });
  return { ok: true, message: "Barang " + sku + " tersimpan." };
  }
);

export const createPartner = denganPeran(
  ["staf_keuangan"],
  "mitra.buat",
  async ({ pengguna }, fd: FormData): Promise<ActionResult> => {
  const code = String(fd.get("code") || "").trim();
  const name = String(fd.get("name") || "").trim();
  const isCustomer = fd.get("is_customer") === "on";
  const isSupplier = fd.get("is_supplier") === "on";
  const term = Number(fd.get("payment_term_days") || 0);
  if (!code || !name) return { ok: false, message: "Kode dan nama wajib diisi." };
  if (!isCustomer && !isSupplier)
    return { ok: false, message: "Pilih minimal satu peran: pelanggan atau pemasok." };

  try {
    await query(
      `INSERT INTO partner (code,name,is_customer,is_supplier,payment_term_days)
       VALUES ($1,$2,$3,$4,$5)`,
      [code, name, isCustomer, isSupplier, term]
    );
  } catch (e: any) {
    if (e.code === "23505") return { ok: false, message: "Kode " + code + " sudah dipakai." };
    return { ok: false, message: e.message };
  }
  revalidatePath("/partners");
  await catat({ aksi: "mitra.buat", hasil: "BERHASIL", pengguna,
                dokumenJenis: "partner", dokumenNo: code });
  return { ok: true, message: name + " tersimpan." };
  }
);

export const createWarehouse = denganPeran(
  ["operator_gudang"],
  "gudang.buat",
  async ({ pengguna }, fd: FormData): Promise<ActionResult> => {
  const code = String(fd.get("code") || "").trim();
  const name = String(fd.get("name") || "").trim();
  if (!code || !name) return { ok: false, message: "Kode dan nama gudang wajib diisi." };
  try {
    await query(`INSERT INTO warehouse (code,name) VALUES ($1,$2)`, [code, name]);
  } catch (e: any) {
    if (e.code === "23505") return { ok: false, message: "Kode " + code + " sudah dipakai." };
    return { ok: false, message: e.message };
  }
  revalidatePath("/warehouses");
  await catat({ aksi: "gudang.buat", hasil: "BERHASIL", pengguna,
                dokumenJenis: "warehouse", dokumenNo: code });
  return { ok: true, message: "Gudang " + name + " tersimpan." };
  }
);

// ---------------- Penerimaan barang ----------------

type LineIn = {
  product_id: string;
  qty: string;
  unit_cost?: string;
  unit_price?: string;
  batch_no?: string;
  expiry_date?: string;
};

export const saveAndPostReceipt = denganPeran(
  ["operator_gudang"],
  "penerimaan.posting",
  async ({ pengguna }, payload: {
  doc_date: string;
  supplier_id: string;
  warehouse_id: string;
  supplier_ref: string;
  lines: LineIn[];
}): Promise<ActionResult> => {
  const lines = payload.lines.filter((l) => l.product_id && Number(l.qty) > 0);
  if (lines.length === 0) return { ok: false, message: "Tambahkan minimal satu baris barang." };

  let receiptId: string;
  try {
    receiptId = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO goods_receipt
           (doc_date, supplier_id, warehouse_id, supplier_ref, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [payload.doc_date, payload.supplier_id, payload.warehouse_id,
         payload.supplier_ref || null, pengguna.id]
      );
      const id = r.rows[0].id;
      let n = 1;
      for (const l of lines) {
        await c.query(
          `INSERT INTO goods_receipt_line
             (receipt_id,line_no,product_id,batch_no,expiry_date,qty,unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, n++, l.product_id, l.batch_no || null, l.expiry_date || null,
           l.qty, l.unit_cost || 0]
        );
      }
      return id;
    });
  } catch (e: any) {
    return { ok: false, message: "Gagal menyimpan: " + e.message };
  }

  try {
    const res = await postGoodsReceipt(receiptId);
    await catat({
      aksi: "penerimaan.posting", hasil: "BERHASIL", pengguna,
      dokumenJenis: "goods_receipt", dokumenId: receiptId, dokumenNo: res.docNo,
      detail: { nilai: res.total, baris: lines.length },
    });
    revalidatePath("/receipts");
    revalidatePath("/stock");
    revalidatePath("/journal");
    revalidatePath("/");
    return { ok: true, message: "Penerimaan " + res.docNo + " diposting." };
  } catch (e: any) {
    return { ok: false, message: "Gagal posting: " + e.message };
  }
  }
);

// ---------------- Penjualan ----------------

export const saveAndPostInvoice = denganPeran(
  ["staf_keuangan"],
  "penjualan.posting",
  async ({ pengguna }, payload: {
  doc_date: string;
  customer_id: string;
  warehouse_id: string;
  lines: LineIn[];
}): Promise<ActionResult> => {
  const lines = payload.lines.filter((l) => l.product_id && Number(l.qty) > 0);
  if (lines.length === 0) return { ok: false, message: "Tambahkan minimal satu baris barang." };

  let invoiceId: string;
  try {
    invoiceId = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO sales_invoice
           (doc_date, customer_id, warehouse_id, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [payload.doc_date, payload.customer_id, payload.warehouse_id, pengguna.id]
      );
      const id = r.rows[0].id;
      let n = 1;
      for (const l of lines) {
        await c.query(
          `INSERT INTO sales_invoice_line (invoice_id,line_no,product_id,qty,unit_price)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, n++, l.product_id, l.qty, l.unit_price || 0]
        );
      }
      return id;
    });
  } catch (e: any) {
    return { ok: false, message: "Gagal menyimpan: " + e.message };
  }

  try {
    const res = await postSalesInvoice(invoiceId);
    await catat({
      aksi: "penjualan.posting", hasil: "BERHASIL", pengguna,
      dokumenJenis: "sales_invoice", dokumenId: invoiceId, dokumenNo: res.docNo,
      detail: { total: res.total, hpp: res.cogs },
    });
    revalidatePath("/sales");
    revalidatePath("/stock");
    revalidatePath("/journal");
    revalidatePath("/");
    return { ok: true, message: "Faktur " + res.docNo + " diposting." };
  } catch (e: any) {
    // Draft dibiarkan ada supaya user bisa perbaiki, tapi beri tahu jelas.
    await query(`DELETE FROM sales_invoice WHERE id=$1 AND status='DRAFT'`, [invoiceId]);
    return { ok: false, message: e.message };
  }
  }
);

// ---------------- Penerimaan pembayaran ----------------

export const saveAndPostPayment = denganPeran(
  ["staf_keuangan"],
  "pembayaran.posting",
  async ({ pengguna }, payload: {
  doc_date: string;
  customer_id: string;
  method: string;
  reference: string;
  amount: string;
  /** invoice_id -> jumlah yang dialokasikan. Baris kosong diabaikan. */
  allocations: { invoice_id: string; amount: string }[];
}): Promise<ActionResult> => {
  if (!payload.customer_id) return { ok: false, message: "Pilih pelanggan dulu." };
  if (!(Number(payload.amount) > 0))
    return { ok: false, message: "Jumlah uang yang diterima harus lebih dari nol." };

  const allocations = payload.allocations.filter(
    (a) => a.invoice_id && Number(a.amount) > 0
  );

  let paymentId: string;
  try {
    paymentId = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO payment_receipt
           (doc_date, customer_id, method, reference, amount, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          payload.doc_date,
          payload.customer_id,
          payload.method || "TRANSFER",
          payload.reference || null,
          payload.amount,
          pengguna.id,
        ]
      );
      const id = r.rows[0].id;
      for (const a of allocations) {
        await c.query(
          `INSERT INTO payment_allocation (payment_id, invoice_id, amount)
           VALUES ($1,$2,$3)`,
          [id, a.invoice_id, a.amount]
        );
      }
      return id;
    });
  } catch (e: any) {
    return { ok: false, message: "Gagal menyimpan: " + e.message };
  }

  try {
    const res = await postPaymentReceipt(paymentId);
    await catat({
      aksi: "pembayaran.posting", hasil: "BERHASIL", pengguna,
      dokumenJenis: "payment_receipt", dokumenId: paymentId, dokumenNo: res.docNo,
      detail: {
        diterima: res.amount, dialokasikan: res.allocated, titipan: res.titipan,
        jumlah_faktur: allocations.length,
      },
    });
    revalidatePath("/payments");
    revalidatePath("/sales");
    revalidatePath("/partners");
    revalidatePath("/journal");
    revalidatePath("/");
    const catatan =
      Number(res.titipan) > 0
        ? ` Kelebihan ${res.titipan} masuk Titipan Pelanggan.`
        : "";
    return { ok: true, message: "Pembayaran " + res.docNo + " diposting." + catatan };
  } catch (e: any) {
    // Draf dihapus supaya tidak ada dokumen menggantung yang membingungkan.
    // Alokasinya ikut terhapus lewat ON DELETE CASCADE.
    await query(`DELETE FROM payment_receipt WHERE id=$1 AND status='DRAFT'`, [paymentId]);
    return { ok: false, message: e.message };
  }
  }
);

/** Faktur yang masih punya sisa tagihan, untuk formulir alokasi. */
export const fakturTerbuka = denganPeran(
  ["staf_keuangan"],
  "data.baca",
  async ({ pengguna }, customerId: string) => {
  if (!customerId) return [];
  return query<{
    invoice_id: string;
    doc_no: string;
    doc_date: string;
    due_date: string | null;
    total: string;
    dibayar: string;
    sisa: string;
    hari_lewat: string;
  }>(
    `SELECT invoice_id, doc_no,
            to_char(doc_date, 'YYYY-MM-DD') AS doc_date,
            to_char(due_date, 'YYYY-MM-DD') AS due_date,
            total, dibayar, sisa, hari_lewat
       FROM v_invoice_outstanding
      WHERE customer_id = $1 AND sisa > 0
      ORDER BY COALESCE(due_date, doc_date), doc_no`,
    [customerId]
  );
  }
);

// ---------------- Faktur pembelian ----------------

/** Baris penerimaan yang masih menggantung, untuk formulir pencocokan. */
export const penerimaanBelumDifakturkan = denganPeran(
  ["staf_keuangan"],
  "data.baca",
  async ({ pengguna }, supplierId: string) => {
  if (!supplierId) return [];
  return query<{
    receipt_line_id: string;
    receipt_no: string;
    receipt_date: string;
    sku: string;
    product: string;
    qty_diterima: string;
    qty_difakturkan: string;
    qty_sisa: string;
    biaya_terima: string;
    grni_sisa: string;
  }>(
    `SELECT m.receipt_line_id, m.receipt_no,
            to_char(m.receipt_date, 'YYYY-MM-DD') AS receipt_date,
            p.sku, p.name AS product,
            m.qty_diterima, m.qty_difakturkan, m.qty_sisa,
            m.biaya_terima, m.grni_sisa
       FROM v_receipt_matching m
       JOIN product p ON p.id = m.product_id
      WHERE m.supplier_id = $1 AND m.qty_sisa > 0
      ORDER BY m.receipt_date, m.receipt_no, p.sku`,
    [supplierId]
  );
  }
);

export const saveAndPostPurchaseInvoice = denganPeran(
  ["staf_keuangan"],
  "faktur_beli.posting",
  async ({ pengguna }, payload: {
  doc_date: string;
  supplier_id: string;
  supplier_ref: string;
  note: string;
  /** Selisih kuantitas disetujui di muka, dengan jejak siapa. */
  approve_qty_variance: boolean;
  approved_by: string;
  lines: { receipt_line_id: string; qty: string; unit_cost: string }[];
}): Promise<ActionResult> => {
  if (!payload.supplier_id) return { ok: false, message: "Pilih pemasok dulu." };

  const lines = payload.lines.filter(
    (l) => l.receipt_line_id && Number(l.qty) > 0
  );
  if (lines.length === 0)
    return { ok: false, message: "Pilih minimal satu baris penerimaan." };

  /*
   * Menyetujui selisih kuantitas berarti menerima tagihan atas barang
   * yang tidak pernah tercatat masuk gudang. Itu pengakuan kerugian,
   * bukan pekerjaan tata usaha — jadi ia milik pengawas, meski faktur
   * pembeliannya sendiri diposting staf keuangan.
   *
   * Diperiksa di sini, bukan lewat denganPeran(), karena wewenangnya
   * bergantung pada ISI payload: faktur yang cocok tetap boleh diposting
   * staf keuangan.
   */
  if (payload.approve_qty_variance && pengguna.peran !== "pengawas") {
    await catat({
      aksi: "faktur_beli.setujui_selisih",
      hasil: "DITOLAK",
      pengguna,
      alasan: `peran ${pengguna.peran} tidak berwenang menyetujui selisih kuantitas`,
    });
    return {
      ok: false,
      message:
        "Hanya pengawas yang boleh menyetujui selisih kuantitas. Faktur ini " +
        "menagih barang yang tidak tercatat masuk gudang — mintalah pengawas " +
        "meninjaunya.",
    };
  }

  if (payload.approve_qty_variance && !payload.approved_by.trim()) {
    return {
      ok: false,
      message:
        "Isi nama penyetuju. Selisih kuantitas hanya boleh lewat kalau ada " +
        "yang bertanggung jawab atasnya.",
    };
  }

  /*
   * Tarif PPN diambil dari status PKP pemasok, di SERVER.
   *
   * Tidak dikirim dari formulir: kalau klien yang menentukan apakah
   * sebuah faktur ber-PPN, satu permintaan yang disusun tangan bisa
   * mengkreditkan pajak masukan atas faktur dari pemasok yang tidak
   * pernah memungutnya.
   *
   * Angkanya disimpan DI DOKUMEN, bukan dibaca ulang saat laporan
   * dibuat — sama seperti vatRate pada postSalesInvoice. Tarif PPN
   * berubah dari waktu ke waktu, dan faktur lama harus tetap
   * menampilkan tarif yang berlaku saat itu.
   */
  const TARIF_PPN = 0.11;
  const [pemasok] = await query<{ is_pkp: boolean }>(
    `SELECT is_pkp FROM partner WHERE id = $1`,
    [payload.supplier_id]
  );
  const tarif = pemasok?.is_pkp ? TARIF_PPN : 0;

  let invoiceId: string;
  try {
    invoiceId = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO purchase_invoice
           (doc_date, supplier_id, supplier_ref, note,
            qty_variance_approved, approved_at, approved_by, created_by,
            tax_rate)
         VALUES ($1,$2,$3,$4,$5,
                 CASE WHEN $5 THEN now() END,
                 CASE WHEN $5 THEN $6 END, $7, $8)
         RETURNING id`,
        [
          payload.doc_date,
          payload.supplier_id,
          payload.supplier_ref.trim() || null,
          payload.note.trim() || null,
          payload.approve_qty_variance,
          payload.approved_by.trim() || null,
          pengguna.id,
          tarif,
        ]
      );
      const id = r.rows[0].id;
      let n = 1;
      for (const l of lines) {
        await c.query(
          `INSERT INTO purchase_invoice_line
             (invoice_id, line_no, receipt_line_id, qty, unit_cost)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, n++, l.receipt_line_id, l.qty, l.unit_cost || 0]
        );
      }
      return id;
    });
  } catch (e: any) {
    if (e.code === "23505") {
      return {
        ok: false,
        message:
          "Nomor faktur pemasok ini sudah pernah dicatat. Utang tercatat " +
          "ganda adalah kesalahan yang paling mahal untuk dibetulkan, jadi " +
          "nomor yang sama ditolak.",
      };
    }
    return { ok: false, message: "Gagal menyimpan: " + e.message };
  }

  try {
    const res = await postPurchaseInvoice(invoiceId);
    await catat({
      aksi: "faktur_beli.posting", hasil: "BERHASIL", pengguna,
      dokumenJenis: "purchase_invoice", dokumenId: invoiceId, dokumenNo: res.docNo,
      detail: {
        nilai: res.subtotal, ppn: res.ppn, total: res.total,
        grni_dilepas: res.grni,
        selisih_harga: res.selisihHarga, selisih_qty: res.selisihQty,
      },
    });
    revalidatePath("/purchases");
    revalidatePath("/receipts");
    revalidatePath("/journal");
    revalidatePath("/");

    const catatan: string[] = [];
    if (Number(res.selisihHarga) !== 0)
      catatan.push(`selisih harga ${res.selisihHarga}`);
    if (Number(res.selisihQty) !== 0)
      catatan.push(`selisih kuantitas ${res.selisihQty}`);

    const pajak =
      Number(res.ppn) > 0
        ? ` PPN Masukan ${res.ppn} dicatat sebagai pajak yang bisa dikreditkan.`
        : "";

    return {
      ok: true,
      message:
        "Faktur pembelian " + res.docNo + " diposting." +
        (catatan.length
          ? " Masuk akun Selisih Harga Pembelian: " + catatan.join(", ") + "."
          : "") +
        pajak,
    };
  } catch (e: any) {
    // Draf dihapus supaya tidak ada dokumen menggantung. Barisnya ikut
    // terhapus lewat ON DELETE CASCADE.
    await query(`DELETE FROM purchase_invoice WHERE id=$1 AND status='DRAFT'`, [
      invoiceId,
    ]);
    return { ok: false, message: e.message };
  }
  }
);

// ---------------- Pembayaran ke pemasok ----------------

/** Faktur pembelian yang masih punya sisa utang, untuk formulir alokasi. */
export const fakturPembelianTerbuka = denganPeran(
  ["staf_keuangan"],
  "data.baca",
  async (_ctx, supplierId: string) => {
    if (!supplierId) return [];
    return query<{
      invoice_id: string;
      doc_no: string;
      supplier_ref: string | null;
      doc_date: string;
      total: string;
      dibayar: string;
      sisa: string;
      hari_sejak_faktur: string;
    }>(
      `SELECT invoice_id, doc_no, supplier_ref,
              to_char(doc_date, 'YYYY-MM-DD') AS doc_date,
              total, dibayar, sisa, hari_sejak_faktur
         FROM v_purchase_outstanding
        WHERE supplier_id = $1 AND sisa > 0
        ORDER BY doc_date, doc_no`,
      [supplierId]
    );
  }
);

export const saveAndPostSupplierPayment = denganPeran(
  ["staf_keuangan"],
  "pembayaran_pemasok.posting",
  async (
    { pengguna },
    payload: {
      doc_date: string;
      supplier_id: string;
      method: string;
      reference: string;
      amount: string;
      allocations: { invoice_id: string; amount: string }[];
    }
  ): Promise<ActionResult> => {
    if (!payload.supplier_id) return { ok: false, message: "Pilih pemasok dulu." };
    if (!(Number(payload.amount) > 0))
      return { ok: false, message: "Jumlah uang yang dibayarkan harus lebih dari nol." };

    const allocations = payload.allocations.filter(
      (a) => a.invoice_id && Number(a.amount) > 0
    );

    let paymentId: string;
    try {
      paymentId = await tx(async (c) => {
        const r = await c.query(
          `INSERT INTO supplier_payment
             (doc_date, supplier_id, method, reference, amount, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            payload.doc_date,
            payload.supplier_id,
            payload.method || "TRANSFER",
            payload.reference || null,
            payload.amount,
            pengguna.id,
          ]
        );
        const id = r.rows[0].id;
        for (const a of allocations) {
          await c.query(
            `INSERT INTO supplier_payment_allocation (payment_id, invoice_id, amount)
             VALUES ($1,$2,$3)`,
            [id, a.invoice_id, a.amount]
          );
        }
        return id;
      });
    } catch (e: any) {
      return { ok: false, message: "Gagal menyimpan: " + e.message };
    }

    try {
      const res = await postSupplierPayment(paymentId);

      await catat({
        aksi: "pembayaran_pemasok.posting",
        hasil: "BERHASIL",
        pengguna,
        dokumenJenis: "supplier_payment",
        dokumenId: paymentId,
        dokumenNo: res.docNo,
        detail: {
          dibayarkan: res.amount,
          dialokasikan: res.allocated,
          uang_muka: res.uangMuka,
          jumlah_faktur: allocations.length,
        },
      });

      revalidatePath("/supplier-payments");
      revalidatePath("/purchases");
      revalidatePath("/partners");
      revalidatePath("/journal");
      revalidatePath("/");

      const catatan =
        Number(res.uangMuka) > 0
          ? ` Sisa ${res.uangMuka} dicatat sebagai Uang Muka Pembelian.`
          : "";
      return {
        ok: true,
        message: "Pembayaran " + res.docNo + " diposting." + catatan,
      };
    } catch (e: any) {
      await query(`DELETE FROM supplier_payment WHERE id=$1 AND status='DRAFT'`, [
        paymentId,
      ]);
      return { ok: false, message: e.message };
    }
  }
);

// ---------------- Pembatalan dokumen ----------------

export const batalkanDokumenAksi = denganPeran(
  [],
  "dokumen.batalkan",
  async (
    { pengguna },
    payload: {
      jenis: JenisDokumen;
      dokumen_id: string;
      tanggal_pembalik: string;
      alasan: string;
    }
  ): Promise<ActionResult> => {
    try {
      const res = await batalkanDokumen({
        jenis: payload.jenis,
        dokumenId: payload.dokumen_id,
        tanggalPembalik: payload.tanggal_pembalik,
        alasan: payload.alasan,
        penggunaId: pengguna.id,
      });

      await catat({
        aksi: "dokumen.batalkan",
        hasil: "BERHASIL",
        pengguna,
        dokumenJenis: payload.jenis,
        dokumenId: payload.dokumen_id,
        dokumenNo: res.docNo,
        detail: {
          jurnal_pembalik: res.jurnalPembalik,
          tanggal_pembalik: res.tanggalPembalik,
          nilai: res.nilai,
          baris_stok: res.barisLedger,
          alasan: payload.alasan,
        },
      });

      revalidatePath("/receipts");
      revalidatePath("/sales");
      revalidatePath("/payments");
      revalidatePath("/purchases");
      revalidatePath("/journal");
      revalidatePath("/stock");
      revalidatePath("/");

      return {
        ok: true,
        message:
          `${res.docNo} dibatalkan lewat jurnal pembalik ${res.jurnalPembalik} ` +
          `bertanggal ${res.tanggalPembalik}. Dokumen aslinya tetap ada.`,
      };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }
);

// ---------------- Tutup buku ----------------

export type HasilPenutupan = ActionResult & { masalah?: Masalah[] };

export const periksaPeriodeAksi = denganPeran(
  [],
  "buku.tutup",
  async (_ctx, tahun: number, bulan: number): Promise<Masalah[]> =>
    periksaPenutupan(tahun, bulan)
);

export const tutupPeriodeAksi = denganPeran(
  [],
  "buku.tutup",
  async ({ pengguna }, tahun: number, bulan: number): Promise<HasilPenutupan> => {
    try {
      const hasil = await tutupPeriode({
        tahun,
        bulan,
        penggunaId: pengguna.id,
        email: pengguna.email,
      });

      if (!hasil.ditutup) {
        /*
         * Penolakan ikut dicatat. Sebuah periode yang berkali-kali gagal
         * ditutup karena rekonsiliasi persediaan tidak seimbang adalah
         * gejala yang perlu terlihat, bukan sekadar pesan di layar yang
         * hilang begitu halaman dimuat ulang.
         */
        await catat({
          aksi: "buku.tutup",
          hasil: "DITOLAK",
          pengguna,
          alasan: "syarat penutupan belum terpenuhi",
          dokumenJenis: "periode",
          dokumenNo: `${tahun}-${String(bulan).padStart(2, "0")}`,
          detail: { masalah: hasil.masalah.map((m) => m.kode) },
        });

        return {
          ok: false,
          message:
            `${labelPeriode(tahun, bulan)} belum bisa ditutup. ` +
            `${hasil.masalah.length} hal harus dibereskan dulu.`,
          masalah: hasil.masalah,
        };
      }

      await catat({
        aksi: "buku.tutup",
        hasil: "BERHASIL",
        pengguna,
        dokumenJenis: "periode",
        dokumenNo: `${tahun}-${String(bulan).padStart(2, "0")}`,
      });

      revalidatePath("/tutup-buku");
      revalidatePath("/journal");

      return {
        ok: true,
        message:
          `${labelPeriode(tahun, bulan)} ditutup. Posting bertanggal di ` +
          `periode itu sekarang ditolak basis data.`,
      };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }
);

export const bukaKembaliPeriodeAksi = denganPeran(
  [],
  "buku.buka_kembali",
  async (
    { pengguna },
    tahun: number,
    bulan: number,
    alasan: string
  ): Promise<ActionResult> => {
    try {
      await bukaKembaliPeriode({
        tahun,
        bulan,
        alasan,
        penggunaId: pengguna.id,
        email: pengguna.email,
      });

      await catat({
        aksi: "buku.buka_kembali",
        hasil: "BERHASIL",
        pengguna,
        dokumenJenis: "periode",
        dokumenNo: `${tahun}-${String(bulan).padStart(2, "0")}`,
        alasan: alasan.trim(),
        detail: { alasan: alasan.trim() },
      });

      revalidatePath("/tutup-buku");
      revalidatePath("/journal");

      return {
        ok: true,
        message:
          `${labelPeriode(tahun, bulan)} dibuka kembali. Periode ini akan ` +
          `tetap bertanda "pernah dibuka kembali" di riwayatnya, selamanya.`,
      };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }
);
