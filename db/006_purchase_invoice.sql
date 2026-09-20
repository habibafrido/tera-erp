-- ============================================================
-- 006 - Faktur pembelian dan pencocokan tiga arah
--
-- Sampai sekarang akun Barang Diterima Belum Ditagih (GRNI) hanya bisa
-- bertambah. Setiap penerimaan mengkreditnya, dan tidak ada satu pun
-- dokumen yang mendebitnya kembali — sehingga akun perantara yang
-- seharusnya kosong setiap akhir bulan justru menumpuk selamanya dan
-- membuat liabilitas di neraca terlihat dua kali lipat dari utang yang
-- sebenarnya.
--
-- Faktur pembelian adalah dokumen yang mengosongkannya:
--     Dr Barang Diterima Belum Ditagih
--     Cr Utang Usaha
--
-- KEPUTUSAN AKUNTANSI: SELISIH HARGA
-- Kalau harga di faktur berbeda dari harga saat barang diterima,
-- selisihnya TIDAK mengubah nilai persediaan. Ia masuk akun tersendiri,
-- 5-3100 Selisih Harga Pembelian.
--
-- Alasannya bukan kemudahan. Sebagian barang dari penerimaan itu
-- biasanya sudah terjual, dan harga pokoknya sudah masuk laba rugi
-- memakai rata-rata bergerak saat itu. Rata-rata bergerak sengaja tidak
-- menyimpan lapisan, jadi tidak ada cara mengetahui unit mana yang masih
-- di gudang berasal dari penerimaan yang mana — pembagian selisih antara
-- persediaan dan HPP hanya bisa ditaksir. Menaksirnya berarti menggeser
-- rata-rata seluruh barang, termasuk unit dari penerimaan lain, dengan
-- angka yang tidak bisa dipertanggungjawabkan.
--
-- Harga yang dibayar untuk keputusan ini: persediaan dinilai pada harga
-- penerimaan, bukan harga beli sebenarnya, dan laba periode faktur
-- menyerap seluruh selisih. Itu kesalahan yang TERLIHAT — satu akun yang
-- bisa dibaca langsung di Laba Rugi — dan kesalahan yang terlihat lebih
-- berguna daripada angka yang lebih halus tapi tidak bisa ditelusuri.
--
-- SELISIH KUANTITAS
-- Kalau faktur menagih lebih banyak dari yang diterima, posting DITAHAN
-- sampai seseorang menyetujuinya secara eksplisit. Lihat kolom
-- qty_variance_approved.
-- ============================================================

-- ------------------------------------------------------------
-- Akun baru
-- ------------------------------------------------------------
INSERT INTO account (code, name, type) VALUES
    ('5-3100', 'Selisih Harga Pembelian', 'EXPENSE');

INSERT INTO account_mapping (key, account_id)
SELECT m.k, a.id FROM (VALUES
    ('AP',                '2-1100'),
    ('PURCHASE_VARIANCE', '5-3100')
) AS m(k, code)
JOIN account a ON a.code = m.code;

-- ------------------------------------------------------------
-- Dokumen
-- ------------------------------------------------------------
CREATE TABLE purchase_invoice (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_no        text UNIQUE,
    doc_date      date NOT NULL,
    supplier_id   uuid NOT NULL REFERENCES partner(id),
    -- Nomor faktur milik pemasok. Dipakai untuk mencegah faktur yang
    -- sama masuk dua kali, penyebab paling umum utang tercatat ganda.
    supplier_ref  text,
    note          text,
    status        doc_status NOT NULL DEFAULT 'DRAFT',

    -- Hasil pencocokan, diisi saat posting.
    subtotal       numeric(18,2) NOT NULL DEFAULT 0,  -- nilai yang ditagih
    grni_amount    numeric(18,2) NOT NULL DEFAULT 0,  -- GRNI yang dilepas
    price_variance numeric(18,2) NOT NULL DEFAULT 0,
    qty_variance   numeric(18,2) NOT NULL DEFAULT 0,

    /*
     * Selisih kuantitas MENAHAN posting.
     *
     * Selisih harga bisa lewat sendiri karena ongkos angkut, pembulatan,
     * dan negosiasi ulang membuatnya normal. Selisih kuantitas tidak:
     * ditagih untuk barang yang tidak pernah diterima adalah sengketa,
     * bukan pembulatan. Karena itu ia butuh persetujuan yang tercatat
     * siapa dan kapan, bukan sekadar peringatan yang bisa diabaikan.
     */
    qty_variance_approved boolean NOT NULL DEFAULT false,
    approved_at   timestamptz,
    approved_by   text,

    posted_at     timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- Persetujuan harus membawa jejak. Kolom kosong berarti belum
    -- disetujui, bukan disetujui oleh entah siapa.
    CHECK (NOT qty_variance_approved
           OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

-- Satu pemasok tidak boleh mengirim nomor faktur yang sama dua kali.
CREATE UNIQUE INDEX idx_pi_supplier_ref
    ON purchase_invoice (supplier_id, supplier_ref)
 WHERE supplier_ref IS NOT NULL AND status <> 'CANCELLED';

CREATE TABLE purchase_invoice_line (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      uuid NOT NULL REFERENCES purchase_invoice(id) ON DELETE CASCADE,
    line_no         int  NOT NULL,
    -- Pencocokan terjadi di tingkat BARIS penerimaan, bukan di tingkat
    -- dokumen: satu penerimaan bisa berisi sepuluh barang dengan sepuluh
    -- harga, dan selisih yang perlu dilihat orang adalah per barang.
    receipt_line_id uuid NOT NULL REFERENCES goods_receipt_line(id),
    qty             numeric(18,6) NOT NULL CHECK (qty > 0),
    unit_cost       numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
    UNIQUE (invoice_id, line_no),
    UNIQUE (invoice_id, receipt_line_id)
);

CREATE INDEX idx_pil_receipt_line ON purchase_invoice_line(receipt_line_id);
CREATE INDEX idx_pi_date          ON purchase_invoice(doc_date DESC);
CREATE INDEX idx_pi_supplier      ON purchase_invoice(supplier_id);

-- ------------------------------------------------------------
-- Pencocokan tiga arah: DIHITUNG, tidak pernah disimpan
-- ------------------------------------------------------------
--
-- Sama seperti sisa tagihan piutang, "berapa yang belum difakturkan"
-- tidak punya kolom sendiri. Satu baris penerimaan boleh difakturkan
-- bertahap oleh beberapa faktur, dan kolom sisa akan menyimpang persis
-- seperti kolom saldo stok akan menyimpang.
CREATE VIEW v_receipt_matching AS
SELECT rl.id                       AS receipt_line_id,
       gr.id                       AS receipt_id,
       gr.doc_no                   AS receipt_no,
       gr.doc_date                 AS receipt_date,
       gr.supplier_id,
       rl.product_id,
       rl.qty                      AS qty_diterima,
       rl.unit_cost                AS biaya_terima,
       ROUND(rl.qty * rl.unit_cost, 2)          AS nilai_terima,
       COALESCE(f.qty_faktur, 0)                AS qty_difakturkan,
       ROUND(COALESCE(f.nilai_faktur, 0), 2)    AS nilai_difakturkan,
       -- Boleh NEGATIF: artinya ditagih melebihi yang diterima, dan
       -- selisihnya sudah disetujui. Itu informasi yang perlu terlihat.
       rl.qty - COALESCE(f.qty_faktur, 0)       AS qty_sisa,
       /*
        * GRNI yang masih menggantung, dinilai pada harga PENERIMAAN —
        * karena begitulah ia dikreditkan waktu barang masuk.
        *
        * Dibatasi tidak boleh negatif. GRNI hanya pernah dikreditkan
        * sebesar barang yang benar-benar diterima, jadi kelebihan tagih
        * tidak membuat GRNI berutang balik; kelebihan itu masuk akun
        * selisih pembelian, bukan ke sini. Tanpa GREATEST, menjumlahkan
        * kolom ini akan memberi angka yang tidak cocok dengan saldo GRNI
        * di buku besar — dan yang salah adalah kolomnya.
        */
       ROUND(GREATEST(rl.qty - COALESCE(f.qty_faktur, 0), 0)
             * rl.unit_cost, 2)                 AS grni_sisa
  FROM goods_receipt_line rl
  JOIN goods_receipt gr ON gr.id = rl.receipt_id AND gr.status = 'POSTED'
  LEFT JOIN (
      SELECT pil.receipt_line_id,
             SUM(pil.qty)                  AS qty_faktur,
             SUM(pil.qty * pil.unit_cost)  AS nilai_faktur
        FROM purchase_invoice_line pil
        JOIN purchase_invoice pi ON pi.id = pil.invoice_id
       WHERE pi.status = 'POSTED'
       GROUP BY pil.receipt_line_id
  ) f ON f.receipt_line_id = rl.id;

-- ------------------------------------------------------------
-- Faktur terposting tidak bisa diubah
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_posted_purchase_invoice()
RETURNS trigger AS $$
BEGIN
    IF (SELECT status FROM purchase_invoice
         WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id)) = 'POSTED' THEN
        RAISE EXCEPTION 'Faktur pembelian sudah diposting dan tidak dapat diubah.';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_posted_purchase_invoice
    BEFORE INSERT OR UPDATE OR DELETE ON purchase_invoice_line
    FOR EACH ROW EXECUTE FUNCTION block_posted_purchase_invoice();

-- ------------------------------------------------------------
-- Faktur tidak boleh menagih melebihi yang diterima, tanpa persetujuan
-- ------------------------------------------------------------
--
-- Lapisan kedua di bawah lib/posting.ts, dengan alasan yang sama seperti
-- trigger alokasi pembayaran: kalau suatu saat ada jalur kode lain yang
-- menulis baris faktur tanpa lewat posting, ia berhenti di sini alih-alih
-- diam-diam mengosongkan GRNI melebihi isinya.
-- Pemeriksa bersama, dipanggil dua trigger dengan bentuk baris berbeda.
CREATE OR REPLACE FUNCTION assert_receipt_not_overinvoiced(p_invoice uuid)
RETURNS void AS $$
DECLARE
    v_line   uuid;
    v_terima numeric(18,6);
    v_faktur numeric(18,6);
    v_setuju boolean;
BEGIN
    FOR v_line IN
        SELECT DISTINCT receipt_line_id FROM purchase_invoice_line
         WHERE invoice_id = p_invoice
    LOOP
        SELECT rl.qty INTO v_terima
          FROM goods_receipt_line rl WHERE rl.id = v_line;

        SELECT COALESCE(SUM(pil.qty), 0), bool_and(pi.qty_variance_approved)
          INTO v_faktur, v_setuju
          FROM purchase_invoice_line pil
          JOIN purchase_invoice pi ON pi.id = pil.invoice_id
         WHERE pil.receipt_line_id = v_line AND pi.status = 'POSTED';

        IF v_faktur > v_terima AND NOT COALESCE(v_setuju, false) THEN
            RAISE EXCEPTION
                'Faktur menagih % untuk baris penerimaan yang hanya berisi %, '
                'dan selisih kuantitasnya belum disetujui.',
                v_faktur, v_terima;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_pil_overinvoiced()
RETURNS trigger AS $$
BEGIN
    PERFORM assert_receipt_not_overinvoiced(
        COALESCE(NEW.invoice_id, OLD.invoice_id));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_receipt_not_overinvoiced
    AFTER INSERT OR UPDATE OR DELETE ON purchase_invoice_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_pil_overinvoiced();

-- Perubahan status itu sendiri yang membuat barisnya "terhitung", jadi
-- ia harus ikut diperiksa.
CREATE OR REPLACE FUNCTION trg_pi_overinvoiced()
RETURNS trigger AS $$
BEGIN
    PERFORM assert_receipt_not_overinvoiced(COALESCE(NEW.id, OLD.id));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_purchase_status_overinvoiced
    AFTER UPDATE OF status ON purchase_invoice
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_pi_overinvoiced();
