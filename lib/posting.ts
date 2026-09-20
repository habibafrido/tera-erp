import { PoolClient } from "pg";
import { tx } from "./db";

/**
 * ============================================================
 * POSTING ENGINE
 * ============================================================
 * Ini jantung ERP. Aturannya:
 *
 *  1. Stok dan jurnal ditulis dalam SATU transaksi.
 *  2. Semua aritmetika dikerjakan Postgres (tipe numeric),
 *     bukan JavaScript, supaya tidak ada galat pembulatan.
 *  3. stock_ledger append-only. Pembatalan = entri pembalik.
 *  4. Costing: moving average per (product, warehouse).
 */

// Kunci per kombinasi barang+gudang supaya dua posting bersamaan
// tidak menghitung moving average dari saldo yang sama.
async function lockStock(c: PoolClient, productId: string, warehouseId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    productId + ":" + warehouseId,
  ]);
}

async function accountId(c: PoolClient, key: string): Promise<string> {
  const r = await c.query("SELECT account_id FROM account_mapping WHERE key=$1", [key]);
  if (!r.rows[0]) throw new Error("Pemetaan akun belum diatur: " + key);
  return r.rows[0].account_id;
}

type JournalLine = {
  key: string;
  debit?: string | number;
  credit?: string | number;
  partnerId?: string | null;
};

/**
 * Header jurnal dibuat LEBIH DULU, sebelum baris buku besar ditulis,
 * supaya setiap baris stok bisa langsung membawa journal_entry_id.
 * Tanpa ini kita harus meng-UPDATE stock_ledger belakangan, dan itu
 * dilarang oleh aturan append-only.
 */
async function createJournalEntry(
  c: PoolClient,
  opts: { date: string; description: string; sourceType: string; sourceId: string }
): Promise<string> {
  const no = await c.query("SELECT next_doc_no('JV', $1::date) AS n", [opts.date]);
  const r = await c.query(
    `INSERT INTO journal_entry (entry_no, entry_date, description, source_type, source_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [no.rows[0].n, opts.date, opts.description, opts.sourceType, opts.sourceId]
  );
  return r.rows[0].id as string;
}

async function postJournalLines(c: PoolClient, entryId: string, lines: JournalLine[]) {
  for (const l of lines) {
    // Baris bernilai nol dilewati. CHECK di journal_line menolak baris
    // yang debit dan kreditnya sama-sama nol, dan baris semacam itu
    // memang tidak membawa informasi apa pun.
    if (Number(l.debit ?? 0) === 0 && Number(l.credit ?? 0) === 0) continue;

    const acc = await accountId(c, l.key);
    await c.query(
      `INSERT INTO journal_line (entry_id, account_id, partner_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`,
      [entryId, acc, l.partnerId ?? null, l.debit ?? 0, l.credit ?? 0]
    );
  }

  // Trigger DEFERRED memvalidasi debit = kredit saat COMMIT.
  await c.query("UPDATE journal_entry SET is_posted = true WHERE id = $1", [entryId]);
}

/**
 * ------------------------------------------------------------
 * PENERIMAAN BARANG
 * ------------------------------------------------------------
 * Stok  : bertambah sebesar qty, nilai bertambah qty x harga beli
 * Jurnal: Dr Persediaan
 *         Cr Barang Diterima Belum Ditagih (GRNI)
 *
 * Kenapa GRNI dan bukan langsung Utang Usaha? Karena saat barang
 * masuk gudang, faktur supplier sering belum datang. Utang baru
 * diakui setelah faktur diterima dan cocok (3-way match).
 */
export async function postGoodsReceipt(receiptId: string) {
  return tx(async (c) => {
    const hdr = await c.query(
      `SELECT * FROM goods_receipt WHERE id=$1 FOR UPDATE`, [receiptId]
    );
    const gr = hdr.rows[0];
    if (!gr) throw new Error("Penerimaan barang tidak ditemukan.");
    if (gr.status !== "DRAFT") throw new Error("Dokumen ini sudah di-posting.");

    const lines = await c.query(
      `SELECT l.*, p.is_batch_tracked, p.name AS product_name
         FROM goods_receipt_line l
         JOIN product p ON p.id = l.product_id
        WHERE l.receipt_id=$1 ORDER BY l.line_no`,
      [receiptId]
    );
    if (lines.rows.length === 0) throw new Error("Dokumen belum punya baris barang.");

    const docNo = gr.doc_no ??
      (await c.query("SELECT next_doc_no('GR',$1::date) AS n", [gr.doc_date])).rows[0].n;

    const journalId = await createJournalEntry(c, {
      date: gr.doc_date,
      description: "Penerimaan barang " + docNo,
      sourceType: "GOODS_RECEIPT",
      sourceId: receiptId,
    });

    let total = "0";

    for (const l of lines.rows) {
      await lockStock(c, l.product_id, gr.warehouse_id);

      // Batch dibuat kalau produk dilacak per batch
      let batchId: string | null = null;
      if (l.is_batch_tracked && l.batch_no) {
        const b = await c.query(
          `INSERT INTO batch (product_id, batch_no, expiry_date)
           VALUES ($1,$2,$3)
           ON CONFLICT (product_id, batch_no)
           DO UPDATE SET expiry_date = COALESCE(EXCLUDED.expiry_date, batch.expiry_date)
           RETURNING id`,
          [l.product_id, l.batch_no, l.expiry_date]
        );
        batchId = b.rows[0].id;
      }

      // Saldo berjalan dibaca dan ditulis dalam satu pernyataan.
      const ins = await c.query(
        `WITH base AS (
           SELECT COALESCE(running_qty,0) AS q, COALESCE(running_value,0) AS v
             FROM stock_ledger
            WHERE product_id=$1 AND warehouse_id=$2
            ORDER BY id DESC LIMIT 1
         ), seed AS (
           SELECT q, v FROM base
           UNION ALL
           SELECT 0::numeric, 0::numeric WHERE NOT EXISTS (SELECT 1 FROM base)
         )
         INSERT INTO stock_ledger
           (product_id, warehouse_id, batch_id, movement_type, qty, unit_cost,
            running_qty, running_value, posted_at, source_type, source_id,
            journal_entry_id)
         SELECT $1, $2, $3, 'PURCHASE_RECEIPT', $4, $5,
                seed.q + $4,
                seed.v + ($4::numeric * $5::numeric),
                now(), 'GOODS_RECEIPT', $6, $7
           FROM seed
         RETURNING (qty * unit_cost) AS line_value`,
        [l.product_id, gr.warehouse_id, batchId, l.qty, l.unit_cost, receiptId, journalId]
      );

      const lv = await c.query("SELECT ($1::numeric + $2::numeric) AS t", [
        total, ins.rows[0].line_value,
      ]);
      total = lv.rows[0].t;
    }

    await postJournalLines(c, journalId, [
      { key: "INVENTORY", debit: total },
      { key: "GRNI", credit: total, partnerId: gr.supplier_id },
    ]);

    await c.query(
      `UPDATE goods_receipt
          SET status='POSTED', doc_no=$2, total_value=$3, posted_at=now()
        WHERE id=$1`,
      [receiptId, docNo, total]
    );

    return { docNo, total };
  });
}

/**
 * ------------------------------------------------------------
 * FAKTUR PENJUALAN
 * ------------------------------------------------------------
 * Satu dokumen menghasilkan DUA peristiwa akuntansi sekaligus:
 *
 *   Pengakuan pendapatan   Dr Piutang Usaha
 *                          Cr Penjualan
 *                          Cr PPN Keluaran
 *
 *   Pengakuan beban pokok  Dr Harga Pokok Penjualan
 *                          Cr Persediaan
 *
 * HPP memakai moving average SAAT ITU, bukan harga beli terakhir.
 */
export async function postSalesInvoice(invoiceId: string, vatRate = 0.11) {
  return tx(async (c) => {
    const hdr = await c.query(`SELECT * FROM sales_invoice WHERE id=$1 FOR UPDATE`, [invoiceId]);
    const inv = hdr.rows[0];
    if (!inv) throw new Error("Faktur tidak ditemukan.");
    if (inv.status !== "DRAFT") throw new Error("Faktur ini sudah di-posting.");

    const lines = await c.query(
      `SELECT l.*, p.sku, p.name AS product_name
         FROM sales_invoice_line l
         JOIN product p ON p.id=l.product_id
        WHERE l.invoice_id=$1 ORDER BY l.line_no`,
      [invoiceId]
    );
    if (lines.rows.length === 0) throw new Error("Faktur belum punya baris barang.");

    const docNo = inv.doc_no ??
      (await c.query("SELECT next_doc_no('INV',$1::date) AS n", [inv.doc_date])).rows[0].n;

    const journalId = await createJournalEntry(c, {
      date: inv.doc_date,
      description: "Penjualan " + docNo,
      sourceType: "SALES_INVOICE",
      sourceId: invoiceId,
    });

    let subtotal = "0";
    let cogs = "0";

    for (const l of lines.rows) {
      await lockStock(c, l.product_id, inv.warehouse_id);

      // --- Alokasi FEFO -------------------------------------------------
      // Barang keluar diambil dari batch yang paling dekat kedaluwarsa.
      // Satu baris faktur bisa memakan beberapa batch, sehingga menghasilkan
      // beberapa baris buku besar. Barang tanpa batch memakai satu alokasi
      // dengan batch_id NULL.
      const avail = await c.query(
        `SELECT b.batch_id, b.qty_on_hand, bt.expiry_date
           FROM v_stock_batch b
           LEFT JOIN batch bt ON bt.id = b.batch_id
          WHERE b.product_id=$1 AND b.warehouse_id=$2 AND b.qty_on_hand > 0
          ORDER BY bt.expiry_date ASC NULLS LAST, b.batch_id NULLS FIRST`,
        [l.product_id, inv.warehouse_id]
      );

      const need = Number(l.qty);
      const onHand = avail.rows.reduce((s: number, r: any) => s + Number(r.qty_on_hand), 0);
      if (onHand < need) {
        throw new Error(
          "Stok tidak cukup untuk " + l.sku + " (" + l.product_name + "). " +
          "Tersedia " + onHand + ", diminta " + need + "."
        );
      }

      let remaining = need;
      const allocations: { batchId: string | null; qty: number }[] = [];
      for (const r of avail.rows) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(r.qty_on_hand));
        allocations.push({ batchId: r.batch_id, qty: take });
        remaining -= take;
      }

      // Biaya memakai rata-rata bergerak per barang+gudang, bukan per batch.
      // Batch dilacak untuk kebutuhan fisik dan kedaluwarsa, sementara
      // penilaian tetap satu angka per gudang. Mencampur keduanya adalah
      // sumber selisih nilai persediaan yang paling sering terjadi.
      for (const a of allocations) {
        const ins = await c.query(
          `WITH base AS (
             SELECT COALESCE(running_qty,0) AS q, COALESCE(running_value,0) AS v
               FROM stock_ledger
              WHERE product_id=$1 AND warehouse_id=$2
              ORDER BY id DESC LIMIT 1
           ), seed AS (
             SELECT q, v FROM base
             UNION ALL
             SELECT 0::numeric, 0::numeric WHERE NOT EXISTS (SELECT 1 FROM base)
           ), calc AS (
             SELECT q, v, CASE WHEN q > 0 THEN v / q ELSE 0 END AS avg_cost FROM seed
           )
           INSERT INTO stock_ledger
             (product_id, warehouse_id, batch_id, movement_type, qty, unit_cost,
              running_qty, running_value, posted_at, source_type, source_id,
              journal_entry_id)
           SELECT $1, $2, $5, 'SALES_ISSUE', -$3::numeric, calc.avg_cost,
                  calc.q - $3::numeric,
                  CASE WHEN calc.q - $3::numeric = 0
                       THEN 0
                       ELSE calc.v - ($3::numeric * calc.avg_cost) END,
                  now(), 'SALES_INVOICE', $4, $6
             FROM calc
            WHERE calc.q >= $3::numeric
           RETURNING ($3::numeric * unit_cost) AS line_cogs`,
          [l.product_id, inv.warehouse_id, a.qty, invoiceId, a.batchId, journalId]
        );

        if (ins.rows.length === 0) {
          throw new Error(
            "Saldo gudang berubah saat posting berjalan untuk " + l.sku + ". Coba lagi."
          );
        }

        const agg = await c.query(`SELECT ($1::numeric + $2::numeric) AS cogs`, [
          cogs, ins.rows[0].line_cogs,
        ]);
        cogs = agg.rows[0].cogs;
      }

      const sub = await c.query(
        `SELECT ($1::numeric + ($2::numeric * $3::numeric)) AS sub`,
        [subtotal, l.qty, l.unit_price]
      );
      subtotal = sub.rows[0].sub;
    }

    const t = await c.query(
      `SELECT round($1::numeric * $2::numeric, 2) AS tax,
              round($1::numeric * (1 + $2::numeric), 2) AS total`,
      [subtotal, vatRate]
    );
    const tax = t.rows[0].tax;
    const total = t.rows[0].total;

    await postJournalLines(c, journalId, [
      { key: "AR", debit: total, partnerId: inv.customer_id },
      { key: "SALES", credit: subtotal },
      { key: "VAT_OUT", credit: tax },
      { key: "COGS", debit: cogs },
      { key: "INVENTORY", credit: cogs },
    ]);

    await c.query(
      `UPDATE sales_invoice
          SET status='POSTED', doc_no=$2, subtotal=$3, tax_amount=$4,
              total=$5, cogs_amount=$6, posted_at=now(),
              due_date = COALESCE(due_date, $7::date +
                (SELECT payment_term_days FROM partner WHERE id=$8))
        WHERE id=$1`,
      [invoiceId, docNo, subtotal, tax, total, cogs, inv.doc_date, inv.customer_id]
    );

    return { docNo, subtotal, tax, total, cogs };
  });
}

/**
 * ------------------------------------------------------------
 * PENERIMAAN PEMBAYARAN PELANGGAN
 * ------------------------------------------------------------
 * Jurnal: Dr Kas/Bank              sebesar uang yang diterima
 *         Cr Piutang Usaha         sebesar yang dialokasikan ke faktur
 *         Cr Titipan Pelanggan     sisanya, kalau bayarnya lebih
 *
 * Kelebihan bayar TIDAK dipaksa menjadi pendapatan. Uang yang belum
 * punya tagihan adalah kewajiban: pelanggan bisa memintanya kembali
 * atau memakainya untuk faktur berikutnya. Mengakuinya sebagai
 * pendapatan menaikkan laba dengan uang yang belum tentu jadi milik
 * perusahaan.
 *
 * Kenapa fungsi ini panjang untuk sesuatu yang "cuma mengurangi
 * piutang": karena sisa tagihan tidak disimpan di mana pun, dan
 * menghitungnya dengan benar di tengah dua pembayaran yang berjalan
 * bersamaan adalah seluruh isi masalahnya. Lihat komentar di lockInvoice.
 */

/**
 * Kunci per faktur.
 *
 * Tanpa ini, dua pembayaran yang menyentuh faktur yang sama akan
 * MEMBACA sisa tagihan yang sama lalu sama-sama menganggap alokasinya
 * muat. Keduanya berhasil, dan faktur senilai 1.000.000 berakhir
 * terbayar 1.800.000 tanpa satu pun pesan galat — persis pola balapan
 * yang sama dengan moving average di lockStock.
 *
 * Awalannya "AR:" supaya tidak bertabrakan dengan ruang kunci stok yang
 * memakai "produk:gudang".
 */
async function lockInvoice(c: PoolClient, invoiceId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["AR:" + invoiceId]);
}

export async function postPaymentReceipt(paymentId: string) {
  return tx(async (c) => {
    const hdr = await c.query(`SELECT * FROM payment_receipt WHERE id=$1 FOR UPDATE`, [
      paymentId,
    ]);
    const pay = hdr.rows[0];
    if (!pay) throw new Error("Penerimaan pembayaran tidak ditemukan.");
    if (pay.status !== "DRAFT") throw new Error("Pembayaran ini sudah diposting.");

    const allocs = await c.query(
      `SELECT a.id, a.invoice_id, a.amount,
              i.doc_no, i.customer_id, i.status
         FROM payment_allocation a
         JOIN sales_invoice i ON i.id = a.invoice_id
        WHERE a.payment_id = $1
        -- Urutan kunci DITENTUKAN, bukan kebetulan. Dua pembayaran yang
        -- menyentuh faktur A dan B dalam urutan berlawanan akan saling
        -- menunggu selamanya; mengunci menurut id yang terurut membuat
        -- keduanya selalu mengambil kunci dengan urutan sama.
        ORDER BY a.invoice_id`,
      [paymentId]
    );

    for (const a of allocs.rows) {
      if (a.status !== "POSTED") {
        throw new Error(
          "Faktur " + (a.doc_no ?? a.invoice_id) + " belum diposting, " +
          "jadi belum punya tagihan yang bisa dilunasi."
        );
      }
      if (a.customer_id !== pay.customer_id) {
        throw new Error(
          "Faktur " + a.doc_no + " milik pelanggan lain. " +
          "Pembayaran hanya boleh dialokasikan ke faktur pelanggan yang sama."
        );
      }
    }

    // Kunci dulu SEMUA faktur, baru hitung sisanya. Menghitung lebih dulu
    // lalu mengunci akan memakai angka yang sudah basi.
    for (const a of allocs.rows) await lockInvoice(c, a.invoice_id);

    let allocated = "0";

    for (const a of allocs.rows) {
      /*
       * Sisa tagihan dihitung dari nilai faktur dikurangi alokasi yang
       * SUDAH terposting — bukan dibaca dari kolom saldo. Kolom semacam
       * itu akan menyimpang, alasannya sama dengan tidak adanya kolom
       * saldo stok di tabel product.
       *
       * Alokasi milik pembayaran ini sendiri dikecualikan: dokumennya
       * masih DRAFT sehingga belum terhitung, dan mengecualikannya
       * secara eksplisit membuat kueri ini tetap benar seandainya suatu
       * saat ada jalur yang memposting ulang.
       */
      const sisa = await c.query(
        `SELECT i.total - COALESCE((
                  SELECT SUM(pa.amount)
                    FROM payment_allocation pa
                    JOIN payment_receipt p ON p.id = pa.payment_id
                   WHERE pa.invoice_id = i.id
                     AND p.status = 'POSTED'
                     AND pa.payment_id <> $2
                ), 0) AS sisa
           FROM sales_invoice i WHERE i.id = $1`,
        [a.invoice_id, paymentId]
      );

      const cek = await c.query(`SELECT ($1::numeric > $2::numeric) AS lebih`, [
        a.amount, sisa.rows[0].sisa,
      ]);
      if (cek.rows[0].lebih) {
        throw new Error(
          "Alokasi ke faktur " + a.doc_no + " melebihi sisa tagihannya. " +
          "Sisa " + sisa.rows[0].sisa + ", dialokasikan " + a.amount + "."
        );
      }

      const t = await c.query(`SELECT ($1::numeric + $2::numeric) AS t`, [
        allocated, a.amount,
      ]);
      allocated = t.rows[0].t;
    }

    const sisaUang = await c.query(
      `SELECT ($1::numeric - $2::numeric) AS titipan`,
      [pay.amount, allocated]
    );
    const titipan = sisaUang.rows[0].titipan;

    if (Number(titipan) < 0) {
      throw new Error(
        "Total alokasi " + allocated + " melebihi uang yang diterima " +
        pay.amount + "."
      );
    }

    const docNo =
      pay.doc_no ??
      (await c.query("SELECT next_doc_no('PAY',$1::date) AS n", [pay.doc_date])).rows[0].n;

    const journalId = await createJournalEntry(c, {
      date: pay.doc_date,
      description: "Penerimaan pembayaran " + docNo,
      sourceType: "PAYMENT_RECEIPT",
      sourceId: paymentId,
    });

    await postJournalLines(c, journalId, [
      { key: "CASH", debit: pay.amount },
      { key: "AR", credit: allocated, partnerId: pay.customer_id },
      { key: "CUSTOMER_DEPOSIT", credit: titipan, partnerId: pay.customer_id },
    ]);

    await c.query(
      `UPDATE payment_receipt
          SET status='POSTED', doc_no=$2, allocated=$3, unallocated=$4,
              posted_at=now()
        WHERE id=$1`,
      [paymentId, docNo, allocated, titipan]
    );

    return { docNo, amount: pay.amount, allocated, titipan };
  });
}

/**
 * ------------------------------------------------------------
 * FAKTUR PEMBELIAN — PENCOCOKAN TIGA ARAH
 * ------------------------------------------------------------
 * Jurnal: Dr Barang Diterima Belum Ditagih   senilai PENERIMAAN
 *         Dr/Cr Selisih Harga Pembelian      selisihnya
 *         Cr Utang Usaha                     senilai FAKTUR
 *
 * Inilah dokumen yang mengosongkan GRNI. Tanpa dokumen ini akun
 * perantara itu hanya bisa bertambah, dan liabilitas di neraca terlihat
 * jauh lebih besar dari utang yang sebenarnya.
 *
 * TIGA ARAH YANG DICOCOKKAN
 *   1. apa yang diterima  (goods_receipt_line)
 *   2. apa yang ditagih   (purchase_invoice_line)
 *   3. berapa yang sudah pernah difakturkan sebelumnya
 *
 * Arah ketiga yang paling sering dilupakan: satu penerimaan boleh
 * difakturkan bertahap, dan tanpa memperhitungkan faktur sebelumnya GRNI
 * akan dilepas lebih dari sekali untuk barang yang sama.
 *
 * SELISIH HARGA tidak mengubah nilai persediaan. Alasan lengkapnya ada
 * di kepala db/006_purchase_invoice.sql — ringkasnya, sebagian barang
 * biasanya sudah terjual dan rata-rata bergerak tidak menyimpan lapisan,
 * jadi pembagian selisih antara persediaan dan HPP hanya bisa ditaksir.
 *
 * SELISIH KUANTITAS menahan posting sampai disetujui secara eksplisit.
 */

/**
 * Kunci per baris penerimaan.
 *
 * Dua faktur yang menagih baris penerimaan yang sama akan sama-sama
 * membaca "sisa yang belum difakturkan" lalu sama-sama menganggap
 * muat — dan GRNI dilepas dua kali untuk barang yang hanya masuk sekali.
 * Pola balapan yang sama dengan lockStock dan lockInvoice.
 */
async function lockReceiptLine(c: PoolClient, receiptLineId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["GRNI:" + receiptLineId]);
}

export type HasilPencocokan = {
  receiptLineId: string;
  receiptNo: string;
  sku: string;
  qtyDiterima: string;
  qtySisa: string;
  qtyFaktur: string;
  biayaTerima: string;
  biayaFaktur: string;
  /** Bagian kuantitas yang benar-benar punya GRNI di belakangnya. */
  qtyCocok: string;
  grni: string;
  selisihHarga: string;
  selisihQty: string;
};

export async function postPurchaseInvoice(invoiceId: string) {
  return tx(async (c) => {
    const hdr = await c.query(`SELECT * FROM purchase_invoice WHERE id=$1 FOR UPDATE`, [
      invoiceId,
    ]);
    const pi = hdr.rows[0];
    if (!pi) throw new Error("Faktur pembelian tidak ditemukan.");
    if (pi.status !== "DRAFT") throw new Error("Faktur pembelian ini sudah diposting.");

    const lines = await c.query(
      `SELECT l.id, l.receipt_line_id, l.qty, l.unit_cost,
              rl.qty AS qty_diterima, rl.unit_cost AS biaya_terima,
              gr.doc_no AS receipt_no, gr.supplier_id, gr.status AS receipt_status,
              p.sku, p.name AS product_name
         FROM purchase_invoice_line l
         JOIN goods_receipt_line rl ON rl.id = l.receipt_line_id
         JOIN goods_receipt gr      ON gr.id = rl.receipt_id
         JOIN product p             ON p.id = rl.product_id
        WHERE l.invoice_id = $1
        -- Urutan kunci ditentukan, bukan kebetulan: dua faktur yang
        -- menyentuh baris penerimaan yang sama dalam urutan berlawanan
        -- akan saling menunggu selamanya.
        ORDER BY l.receipt_line_id`,
      [invoiceId]
    );
    if (lines.rows.length === 0) throw new Error("Faktur belum punya baris.");

    for (const l of lines.rows) {
      if (l.receipt_status !== "POSTED") {
        throw new Error(
          "Penerimaan " + l.receipt_no + " belum diposting, jadi belum ada " +
            "barang yang bisa difakturkan."
        );
      }
      if (l.supplier_id !== pi.supplier_id) {
        throw new Error(
          "Penerimaan " + l.receipt_no + " berasal dari pemasok lain. " +
            "Faktur hanya boleh mencocokkan penerimaan dari pemasok yang sama."
        );
      }
    }

    for (const l of lines.rows) await lockReceiptLine(c, l.receipt_line_id);

    const cocok: HasilPencocokan[] = [];
    let nilaiFaktur = "0";
    let nilaiGrni = "0";
    let selisihHarga = "0";
    let selisihQty = "0";

    for (const l of lines.rows) {
      /*
       * Sisa yang belum difakturkan dihitung SETELAH kunci diambil, dan
       * dari faktur terposting lain — bukan dari kolom sisa yang
       * disimpan. Faktur ini sendiri dikecualikan karena masih DRAFT.
       */
      const s = await c.query(
        `SELECT rl.qty - COALESCE((
                  SELECT SUM(pil.qty)
                    FROM purchase_invoice_line pil
                    JOIN purchase_invoice p2 ON p2.id = pil.invoice_id
                   WHERE pil.receipt_line_id = rl.id
                     AND p2.status = 'POSTED'
                     AND pil.invoice_id <> $2
                ), 0) AS sisa
           FROM goods_receipt_line rl WHERE rl.id = $1`,
        [l.receipt_line_id, invoiceId]
      );
      const sisa = s.rows[0].sisa as string;

      /*
       * Pembagian kuantitas, seluruhnya dihitung Postgres:
       *
       *   qty_cocok = bagian yang punya GRNI di belakangnya
       *   qty_lebih = ditagih melebihi yang pernah diterima
       *
       * GRNI hanya boleh dilepas sebesar qty_cocok x biaya PENERIMAAN,
       * karena hanya sebesar itulah ia pernah dikreditkan. Kelebihannya
       * tidak punya penyeimbang di GRNI dan seluruhnya jadi selisih.
       */
      const h = await c.query(
        `SELECT LEAST($1::numeric, GREATEST($2::numeric, 0))        AS qty_cocok,
                GREATEST($1::numeric - GREATEST($2::numeric, 0), 0) AS qty_lebih,
                ROUND(LEAST($1::numeric, GREATEST($2::numeric, 0))
                      * $3::numeric, 2)                             AS grni,
                ROUND(LEAST($1::numeric, GREATEST($2::numeric, 0))
                      * ($4::numeric - $3::numeric), 2)             AS selisih_harga,
                ROUND(GREATEST($1::numeric - GREATEST($2::numeric, 0), 0)
                      * $4::numeric, 2)                             AS selisih_qty,
                ROUND($1::numeric * $4::numeric, 2)                 AS nilai_baris`,
        [l.qty, sisa, l.biaya_terima, l.unit_cost]
      );
      const r = h.rows[0];

      cocok.push({
        receiptLineId: l.receipt_line_id,
        receiptNo: l.receipt_no,
        sku: l.sku,
        qtyDiterima: l.qty_diterima,
        qtySisa: sisa,
        qtyFaktur: l.qty,
        biayaTerima: l.biaya_terima,
        biayaFaktur: l.unit_cost,
        qtyCocok: r.qty_cocok,
        grni: r.grni,
        selisihHarga: r.selisih_harga,
        selisihQty: r.selisih_qty,
      });

      const j = await c.query(
        `SELECT ($1::numeric + $2::numeric) AS faktur,
                ($3::numeric + $4::numeric) AS grni,
                ($5::numeric + $6::numeric) AS harga,
                ($7::numeric + $8::numeric) AS qty`,
        [
          nilaiFaktur, r.nilai_baris,
          nilaiGrni, r.grni,
          selisihHarga, r.selisih_harga,
          selisihQty, r.selisih_qty,
        ]
      );
      nilaiFaktur = j.rows[0].faktur;
      nilaiGrni = j.rows[0].grni;
      selisihHarga = j.rows[0].harga;
      selisihQty = j.rows[0].qty;
    }

    /*
     * Selisih kuantitas MENAHAN posting.
     *
     * Diperiksa setelah semua angka dihitung, supaya pesan galatnya bisa
     * menyebut baris mana dan selisihnya berapa. Orang yang harus
     * meninjaunya butuh angka itu, bukan sekadar penolakan.
     */
    const bermasalah = cocok.filter((x) => Number(x.selisihQty) !== 0);
    if (bermasalah.length > 0 && !pi.qty_variance_approved) {
      const rincian = bermasalah
        .map(
          (x) =>
            x.sku + " pada " + x.receiptNo + ": ditagih " + x.qtyFaktur +
            ", yang belum difakturkan " + x.qtySisa
        )
        .join("; ");
      throw new Error(
        "Posting ditahan karena selisih kuantitas. " + rincian + ". " +
          "Tinjau dan setujui selisihnya dulu, atau perbaiki fakturnya."
      );
    }

    /*
     * PPN Masukan.
     *
     * Tarifnya diambil dari DOKUMEN, bukan dari konfigurasi terpusat:
     * tarif PPN berubah dari waktu ke waktu, dan mencetak ulang faktur
     * lama harus menghasilkan angka yang sama dengan yang pernah
     * dikirim ke pemasok.
     *
     * Dasar pengenaannya adalah nilai faktur, BUKAN nilai GRNI yang
     * dilepas. Pemasok menagih PPN atas apa yang ia tagihkan, bukan
     * atas apa yang tercatat masuk gudang — dan selisih di antara
     * keduanya sudah punya tempatnya sendiri di akun selisih pembelian.
     */
    const pjk = await c.query(
      `SELECT ROUND($1::numeric * $2::numeric, 2) AS ppn,
              ROUND($1::numeric * (1 + $2::numeric), 2) AS total`,
      [nilaiFaktur, pi.tax_rate]
    );
    const ppn = pjk.rows[0].ppn as string;
    const totalFaktur = pjk.rows[0].total as string;

    const docNo =
      pi.doc_no ??
      (await c.query("SELECT next_doc_no('PI',$1::date) AS n", [pi.doc_date])).rows[0].n;

    const journalId = await createJournalEntry(c, {
      date: pi.doc_date,
      description: "Faktur pembelian " + docNo,
      sourceType: "PURCHASE_INVOICE",
      sourceId: invoiceId,
    });

    /*
     * Selisih total bisa positif (harga faktur lebih mahal: beban) atau
     * negatif (lebih murah: pengurang beban). Satu akun menampung
     * keduanya, arahnya yang berbeda. postJournalLines melewati baris
     * bernilai nol, jadi faktur yang cocok sempurna tidak menghasilkan
     * baris selisih sama sekali.
     */
    const t = await c.query(`SELECT ($1::numeric + $2::numeric) AS selisih`, [
      selisihHarga,
      selisihQty,
    ]);
    const selisih = Number(t.rows[0].selisih);

    /*
     * Debit dan kredit tetap seimbang dengan sendirinya:
     *
     *   GRNI          qty_cocok x biaya terima
     *   selisih       nilai faktur - GRNI
     *   PPN Masukan   nilai faktur x tarif
     *   ------------------------------------- +
     *   = nilai faktur x (1 + tarif) = Utang Usaha
     *
     * postJournalLines melewati baris bernilai nol, jadi faktur dari
     * pemasok non-PKP tidak menghasilkan baris PPN sama sekali.
     */
    await postJournalLines(c, journalId, [
      { key: "GRNI", debit: nilaiGrni, partnerId: pi.supplier_id },
      selisih >= 0
        ? { key: "PURCHASE_VARIANCE", debit: t.rows[0].selisih }
        : { key: "PURCHASE_VARIANCE", credit: -selisih },
      { key: "VAT_IN", debit: ppn },
      { key: "AP", credit: totalFaktur, partnerId: pi.supplier_id },
    ]);

    await c.query(
      `UPDATE purchase_invoice
          SET status='POSTED', doc_no=$2, subtotal=$3, grni_amount=$4,
              price_variance=$5, qty_variance=$6, tax_amount=$7, total=$8,
              posted_at=now()
        WHERE id=$1`,
      [invoiceId, docNo, nilaiFaktur, nilaiGrni, selisihHarga, selisihQty,
       ppn, totalFaktur]
    );

    return {
      docNo,
      subtotal: nilaiFaktur,
      ppn,
      total: totalFaktur,
      grni: nilaiGrni,
      selisihHarga,
      selisihQty,
      baris: cocok,
    };
  });
}

/**
 * ------------------------------------------------------------
 * PEMBAYARAN KE PEMASOK
 * ------------------------------------------------------------
 * Jurnal: Dr Utang Usaha           sebesar yang dialokasikan ke faktur
 *         Dr Uang Muka Pembelian   sisanya, kalau bayarnya lebih dulu
 *         Cr Kas/Bank              sebesar uang yang keluar
 *
 * Cerminan dari postPaymentReceipt, dengan satu perbedaan yang penting:
 * kelebihan bayar di sisi ini adalah ASET, bukan kewajiban. Uang yang
 * sudah keluar tapi belum punya faktur adalah hak tagih kepada pemasok.
 * Mencatatnya sebagai beban akan menurunkan laba dengan uang yang belum
 * tentu hilang.
 *
 * Tanpa dokumen ini Utang Usaha hanya bisa bertambah — dan laporan arus
 * kas hanya akan berisi kas MASUK, yang membuat perusahaan mana pun
 * terlihat sehat.
 */

/**
 * Kunci per faktur pembelian.
 *
 * Awalannya "AP:" — ruang kunci sendiri, terpisah dari "AR:" milik
 * piutang, "GRNI:" milik pencocokan pembelian, dan "produk:gudang"
 * milik stok. Tanpa awalan yang berbeda, dua faktur berbeda yang
 * id-nya kebetulan berbenturan di hashtext akan saling menunggu tanpa
 * alasan.
 */
async function lockPurchaseInvoice(c: PoolClient, invoiceId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["AP:" + invoiceId]);
}

export async function postSupplierPayment(paymentId: string) {
  return tx(async (c) => {
    const hdr = await c.query(
      `SELECT * FROM supplier_payment WHERE id=$1 FOR UPDATE`,
      [paymentId]
    );
    const pay = hdr.rows[0];
    if (!pay) throw new Error("Pembayaran ke pemasok tidak ditemukan.");
    if (pay.status !== "DRAFT") throw new Error("Pembayaran ini sudah diposting.");

    const allocs = await c.query(
      `SELECT a.id, a.invoice_id, a.amount,
              i.doc_no, i.supplier_id, i.status
         FROM supplier_payment_allocation a
         JOIN purchase_invoice i ON i.id = a.invoice_id
        WHERE a.payment_id = $1
        -- Urutan kunci ditentukan, bukan kebetulan: dua pembayaran yang
        -- menyentuh faktur A dan B dalam urutan berlawanan akan saling
        -- menunggu selamanya.
        ORDER BY a.invoice_id`,
      [paymentId]
    );

    for (const a of allocs.rows) {
      if (a.status !== "POSTED") {
        throw new Error(
          "Faktur pembelian " + (a.doc_no ?? a.invoice_id) + " belum diposting, " +
            "jadi belum menimbulkan utang yang bisa dibayar."
        );
      }
      if (a.supplier_id !== pay.supplier_id) {
        throw new Error(
          "Faktur " + a.doc_no + " milik pemasok lain. Pembayaran hanya boleh " +
            "dialokasikan ke faktur pemasok yang sama."
        );
      }
    }

    // Kunci dulu SEMUA faktur, baru hitung sisanya. Menghitung lebih
    // dulu lalu mengunci akan memakai angka yang sudah basi.
    for (const a of allocs.rows) await lockPurchaseInvoice(c, a.invoice_id);

    let allocated = "0";

    for (const a of allocs.rows) {
      /*
       * Sisa utang dihitung dari nilai faktur dikurangi pembayaran yang
       * SUDAH terposting — bukan dibaca dari kolom saldo. Alasannya sama
       * dengan tidak adanya kolom saldo stok maupun kolom sisa tagihan
       * piutang: salinan akan menyimpang.
       *
       * Nilai faktur yang dipakai adalah TOTAL, sudah termasuk PPN:
       * yang ditagih pemasok memang segitu.
       */
      const sisa = await c.query(
        `SELECT i.total - COALESCE((
                  SELECT SUM(pa.amount)
                    FROM supplier_payment_allocation pa
                    JOIN supplier_payment p ON p.id = pa.payment_id
                   WHERE pa.invoice_id = i.id
                     AND p.status = 'POSTED'
                     AND pa.payment_id <> $2
                ), 0) AS sisa
           FROM purchase_invoice i WHERE i.id = $1`,
        [a.invoice_id, paymentId]
      );

      const cek = await c.query(`SELECT ($1::numeric > $2::numeric) AS lebih`, [
        a.amount,
        sisa.rows[0].sisa,
      ]);
      if (cek.rows[0].lebih) {
        throw new Error(
          "Alokasi ke faktur " + a.doc_no + " melebihi sisa utangnya. Sisa " +
            sisa.rows[0].sisa + ", dialokasikan " + a.amount + "."
        );
      }

      const t = await c.query(`SELECT ($1::numeric + $2::numeric) AS t`, [
        allocated,
        a.amount,
      ]);
      allocated = t.rows[0].t;
    }

    const sisaUang = await c.query(`SELECT ($1::numeric - $2::numeric) AS muka`, [
      pay.amount,
      allocated,
    ]);
    const uangMuka = sisaUang.rows[0].muka;

    if (Number(uangMuka) < 0) {
      throw new Error(
        "Total alokasi " + allocated + " melebihi uang yang dibayarkan " +
          pay.amount + "."
      );
    }

    const docNo =
      pay.doc_no ??
      (await c.query("SELECT next_doc_no('PAYS',$1::date) AS n", [pay.doc_date]))
        .rows[0].n;

    const journalId = await createJournalEntry(c, {
      date: pay.doc_date,
      description: "Pembayaran ke pemasok " + docNo,
      sourceType: "SUPPLIER_PAYMENT",
      sourceId: paymentId,
    });

    await postJournalLines(c, journalId, [
      { key: "AP", debit: allocated, partnerId: pay.supplier_id },
      { key: "SUPPLIER_ADVANCE", debit: uangMuka, partnerId: pay.supplier_id },
      { key: "CASH", credit: pay.amount },
    ]);

    await c.query(
      `UPDATE supplier_payment
          SET status='POSTED', doc_no=$2, allocated=$3, unallocated=$4,
              posted_at=now()
        WHERE id=$1`,
      [paymentId, docNo, allocated, uangMuka]
    );

    return { docNo, amount: pay.amount, allocated, uangMuka };
  });
}

/**
 * ------------------------------------------------------------
 * PEMBATALAN DOKUMEN LEWAT JURNAL PEMBALIK
 * ------------------------------------------------------------
 * Tidak ada yang dihapus. stock_ledger append-only dan jurnal terposting
 * tidak bisa disunting, jadi pembatalan adalah PENAMBAHAN:
 *
 *   - satu jurnal baru dengan debit dan kredit ditukar;
 *   - satu set baris ledger dengan kuantitas dinegasikan;
 *   - status dokumen menjadi CANCELLED.
 *
 * TANGGAL PEMBALIK ADALAH PARAMETER, BUKAN TANGGAL DOKUMEN ASLINYA.
 *
 * Itu bukan kelonggaran, melainkan inti dari seluruh mekanisme ini.
 * Koreksi atas dokumen di periode yang sudah ditutup dicatat di periode
 * yang masih TERBUKA — sehingga laporan yang sudah dicetak, dikirim ke
 * bank, atau dilaporkan ke pajak TIDAK berubah, dan koreksinya muncul
 * di periode tempat ia benar-benar diketahui.
 *
 * BIAYA PEMBALIK MEMAKAI BIAYA BARIS ASLINYA, bukan rata-rata bergerak
 * saat ini. Untuk pembalikan penjualan itu memulihkan nilai persediaan
 * persis seperti semula. Untuk pembalikan penerimaan, rata-rata bergerak
 * TIDAK kembali ke angka sebelum penerimaan itu bila sudah ada penjualan
 * di antaranya — rata-rata bergerak tidak menyimpan lapisan, jadi
 * "mengembalikan" nilai yang sudah tercampur tidak mungkin dilakukan
 * tanpa menebak. Yang dipilih di sini adalah yang bisa dipertanggung-
 * jawabkan: setiap baris pembalik menunjuk baris aslinya dan memakai
 * angka yang tertulis di sana.
 */

/** Jenis dokumen yang bisa dibatalkan. */
export type JenisDokumen =
  | "GOODS_RECEIPT"
  | "SALES_INVOICE"
  | "PAYMENT_RECEIPT"
  | "PURCHASE_INVOICE"
  | "SUPPLIER_PAYMENT";

const TABEL: Record<JenisDokumen, string> = {
  GOODS_RECEIPT: "goods_receipt",
  SALES_INVOICE: "sales_invoice",
  PAYMENT_RECEIPT: "payment_receipt",
  PURCHASE_INVOICE: "purchase_invoice",
  SUPPLIER_PAYMENT: "supplier_payment",
};

const SEBUTAN: Record<JenisDokumen, string> = {
  GOODS_RECEIPT: "Penerimaan barang",
  SALES_INVOICE: "Faktur penjualan",
  PAYMENT_RECEIPT: "Penerimaan pembayaran",
  PURCHASE_INVOICE: "Faktur pembelian",
  SUPPLIER_PAYMENT: "Pembayaran ke pemasok",
};

export type HasilPembatalan = {
  docNo: string;
  jurnalPembalik: string;
  tanggalPembalik: string;
  barisLedger: number;
  nilai: string;
};

export async function batalkanDokumen(opts: {
  jenis: JenisDokumen;
  dokumenId: string;
  /** Tanggal jurnal pembalik. Harus di periode yang masih TERBUKA. */
  tanggalPembalik: string;
  alasan: string;
  penggunaId: string;
}): Promise<HasilPembatalan> {
  const { jenis, dokumenId, tanggalPembalik, alasan, penggunaId } = opts;

  if (!alasan || alasan.trim().length < 5) {
    throw new Error(
      "Alasan pembatalan wajib diisi, minimal lima huruf. Pembatalan tanpa " +
        "keterangan tidak bisa dijelaskan kepada siapa pun enam bulan kemudian."
    );
  }

  const tabel = TABEL[jenis];
  if (!tabel) throw new Error("Jenis dokumen tidak dikenal: " + jenis);

  return tx(async (c) => {
    const hdr = await c.query(
      `SELECT id, doc_no, doc_date, status FROM ${tabel} WHERE id = $1 FOR UPDATE`,
      [dokumenId]
    );
    const dok = hdr.rows[0];
    if (!dok) throw new Error(SEBUTAN[jenis] + " tidak ditemukan.");
    if (dok.status === "CANCELLED") {
      throw new Error(
        SEBUTAN[jenis] + " " + dok.doc_no + " sudah dibatalkan sebelumnya."
      );
    }
    if (dok.status !== "POSTED") {
      throw new Error(
        SEBUTAN[jenis] + " " + (dok.doc_no ?? "") + " masih draf. " +
          "Draf dihapus, bukan dibalik — tidak ada yang pernah masuk buku besar."
      );
    }

    // --- Jurnal aslinya ---
    const asal = await c.query(
      `SELECT id, entry_no, entry_date FROM journal_entry
        WHERE source_type = $1 AND source_id = $2 AND is_posted
          AND reverses_entry_id IS NULL
        ORDER BY created_at LIMIT 1`,
      [jenis, dokumenId]
    );
    const jurnalAsal = asal.rows[0];
    if (!jurnalAsal) {
      throw new Error(
        "Jurnal untuk " + SEBUTAN[jenis].toLowerCase() + " " + dok.doc_no +
          " tidak ditemukan. Dokumen ini tidak bisa dibalik tanpa jurnal asal."
      );
    }

    const sudah = await c.query(
      `SELECT entry_no FROM journal_entry WHERE reverses_entry_id = $1`,
      [jurnalAsal.id]
    );
    if (sudah.rows[0]) {
      throw new Error(
        "Jurnal " + jurnalAsal.entry_no + " sudah pernah dibalik oleh " +
          sudah.rows[0].entry_no + "."
      );
    }

    /*
     * Tanggal pembalik tidak boleh MENDAHULUI dokumen aslinya.
     *
     * Koreksi yang tercatat sebelum kejadian yang dikoreksi menghasilkan
     * neraca yang ganjil di antara kedua tanggal itu, dan tidak ada
     * pembacaan yang masuk akal untuknya.
     */
    const urut = await c.query(
      `SELECT ($1::date < $2::date) AS mundur`,
      [tanggalPembalik, jurnalAsal.entry_date]
    );
    if (urut.rows[0].mundur) {
      throw new Error(
        "Tanggal pembalik lebih awal dari dokumen aslinya. Koreksi dicatat " +
          "pada saat ia diketahui, bukan sebelum kejadiannya."
      );
    }

    // --- Nomor dan header jurnal pembalik ---
    const docNoBalik = (
      await c.query("SELECT next_doc_no('JVR', $1::date) AS n", [tanggalPembalik])
    ).rows[0].n;

    const jb = await c.query(
      `INSERT INTO journal_entry
         (entry_no, entry_date, description, source_type, source_id,
          reverses_entry_id, reversal_reason, created_by)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        docNoBalik,
        tanggalPembalik,
        "Pembalikan " + jurnalAsal.entry_no + " — " + alasan.trim(),
        jenis,
        dokumenId,
        jurnalAsal.id,
        alasan.trim(),
        penggunaId,
      ]
    );
    const journalId = jb.rows[0].id as string;

    /*
     * Debit dan kredit DITUKAR, bukan dinegasikan.
     *
     * journal_line punya CHECK yang menolak nilai negatif dan menolak
     * baris yang debit dan kreditnya sama-sama terisi. Menukar kolomnya
     * menghasilkan efek yang sama pada saldo tanpa melanggar keduanya —
     * dan membuat jurnal pembaliknya terbaca wajar oleh manusia.
     */
    const salin = await c.query(
      `INSERT INTO journal_line (entry_id, account_id, partner_id, debit, credit)
       SELECT $1, l.account_id, l.partner_id, l.credit, l.debit
         FROM journal_line l WHERE l.entry_id = $2
       RETURNING (debit + credit) AS nilai`,
      [journalId, jurnalAsal.id]
    );
    if (salin.rows.length === 0) {
      throw new Error("Jurnal " + jurnalAsal.entry_no + " tidak punya baris.");
    }

    await c.query(`UPDATE journal_entry SET is_posted = true WHERE id = $1`, [
      journalId,
    ]);

    // --- Pergerakan stok pembalik ---
    const ledgerAsal = await c.query(
      `SELECT id, product_id, warehouse_id, batch_id, qty, unit_cost
         FROM stock_ledger
        WHERE source_type = $1 AND source_id = $2
        ORDER BY product_id, warehouse_id, id`,
      [jenis, dokumenId]
    );

    for (const l of ledgerAsal.rows) {
      await lockStock(c, l.product_id, l.warehouse_id);

      /*
       * Saldo berjalan dibaca dan ditulis dalam satu pernyataan, sama
       * seperti postGoodsReceipt. WHERE di akhir menolak pembalikan yang
       * akan membuat stok menjadi negatif: membatalkan penerimaan atas
       * barang yang sudah terjual habis tidak mungkin dilakukan tanpa
       * mengarang stok yang tidak ada.
       */
      const ins = await c.query(
        `WITH base AS (
           SELECT COALESCE(running_qty,0) AS q, COALESCE(running_value,0) AS v
             FROM stock_ledger
            WHERE product_id=$1 AND warehouse_id=$2
            ORDER BY id DESC LIMIT 1
         ), seed AS (
           SELECT q, v FROM base
           UNION ALL
           SELECT 0::numeric, 0::numeric WHERE NOT EXISTS (SELECT 1 FROM base)
         )
         INSERT INTO stock_ledger
           (product_id, warehouse_id, batch_id, movement_type, qty, unit_cost,
            running_qty, running_value, posted_at, source_type, source_id,
            journal_entry_id)
         SELECT $1, $2, $3,
                CASE WHEN -$4::numeric > 0 THEN 'REVERSAL_IN'::movement_type
                     ELSE 'REVERSAL_OUT'::movement_type END,
                -$4::numeric, $5,
                seed.q - $4::numeric,
                seed.v - ($4::numeric * $5::numeric),
                now(), $6, $7, $8
           FROM seed
          WHERE seed.q - $4::numeric >= 0
         RETURNING id`,
        [
          l.product_id, l.warehouse_id, l.batch_id, l.qty, l.unit_cost,
          jenis, dokumenId, journalId,
        ]
      );

      if (ins.rows.length === 0) {
        throw new Error(
          "Pembatalan akan membuat stok menjadi negatif. Barang dari " +
            SEBUTAN[jenis].toLowerCase() + " " + dok.doc_no + " sudah keluar " +
            "gudang; terima kembali barangnya dulu sebelum membatalkan dokumen ini."
        );
      }
    }

    await c.query(
      `UPDATE ${tabel}
          SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2
        WHERE id = $1`,
      [dokumenId, penggunaId]
    );

    const total = await c.query(
      `SELECT COALESCE(SUM(debit), 0)::text AS nilai
         FROM journal_line WHERE entry_id = $1`,
      [journalId]
    );

    return {
      docNo: dok.doc_no as string,
      jurnalPembalik: docNoBalik as string,
      tanggalPembalik,
      barisLedger: ledgerAsal.rows.length,
      nilai: total.rows[0].nilai as string,
    };
  });
}
