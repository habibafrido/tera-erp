-- ============================================================
-- 012 - Pembayaran ke pemasok
--
-- Sisi yang hilang. Utang Usaha sampai sekarang hanya bisa bertambah:
-- faktur pembelian mengkreditnya dan tidak ada satu pun dokumen yang
-- mendebitnya kembali — persis masalah yang sudah dibereskan di sisi
-- piutang lewat migrasi 005.
--
-- Akibatnya untuk arus kas lebih besar lagi: tanpa dokumen ini,
-- laporan arus kas hanya akan berisi kas MASUK. Perusahaan yang
-- laporannya hanya menampilkan penerimaan selalu terlihat sehat.
--
-- Rancangannya mengikuti payment_receipt yang sudah terbukti, termasuk
-- keputusan yang paling menentukan di sana: TIDAK ADA kolom sisa utang.
-- Sisa dihitung dari nilai faktur dikurangi alokasi terposting, setiap
-- kali, di dalam transaksi dan di bawah kunci per faktur.
-- ============================================================

CREATE TABLE supplier_payment (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_no        text UNIQUE,
    doc_date      date NOT NULL,
    supplier_id   uuid NOT NULL REFERENCES partner(id),
    method        text NOT NULL DEFAULT 'TRANSFER',
    reference     text,
    note          text,
    status        doc_status NOT NULL DEFAULT 'DRAFT',

    amount        numeric(18,2) NOT NULL CHECK (amount > 0),
    allocated     numeric(18,2) NOT NULL DEFAULT 0,
    /*
     * Uang muka ke pemasok. Cerminan dari Titipan Pelanggan di sisi
     * piutang, tetapi arahnya kebalikan: ini ASET, bukan kewajiban.
     * Uang yang sudah keluar tapi belum punya faktur adalah hak tagih
     * kepada pemasok, bukan beban.
     */
    unallocated   numeric(18,2) NOT NULL DEFAULT 0,

    posted_at     timestamptz,
    cancelled_at  timestamptz,
    cancelled_by  uuid REFERENCES app_user(id),
    created_by    uuid NOT NULL REFERENCES app_user(id),
    created_at    timestamptz NOT NULL DEFAULT now(),

    CHECK (allocated >= 0 AND unallocated >= 0)
);

CREATE TABLE supplier_payment_allocation (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id   uuid NOT NULL REFERENCES supplier_payment(id) ON DELETE CASCADE,
    invoice_id   uuid NOT NULL REFERENCES purchase_invoice(id),
    amount       numeric(18,2) NOT NULL CHECK (amount > 0),
    UNIQUE (payment_id, invoice_id)
);

CREATE INDEX idx_sp_alloc_invoice ON supplier_payment_allocation(invoice_id);
CREATE INDEX idx_sp_date          ON supplier_payment(doc_date DESC);
CREATE INDEX idx_sp_supplier      ON supplier_payment(supplier_id);

-- Uang muka ke pemasok butuh akunnya sendiri.
INSERT INTO account (code, name, type, kategori_arus_kas) VALUES
    ('1-1500', 'Uang Muka Pembelian', 'ASSET', 'OPERASI');

INSERT INTO account_mapping (key, account_id)
SELECT 'SUPPLIER_ADVANCE', id FROM account WHERE code = '1-1500';

CREATE TRIGGER trg_created_by_sp BEFORE INSERT ON supplier_payment
    FOR EACH ROW EXECUTE FUNCTION isi_created_by();

CREATE TRIGGER trg_no_double_cancel_sp BEFORE UPDATE OF status ON supplier_payment
    FOR EACH ROW EXECUTE FUNCTION block_double_cancel();

-- ------------------------------------------------------------
-- Sisa utang: DIHITUNG, tidak pernah disimpan
-- ------------------------------------------------------------
CREATE VIEW v_purchase_outstanding AS
SELECT i.id          AS invoice_id,
       i.doc_no,
       i.supplier_ref,
       i.doc_date,
       i.supplier_id,
       i.total,
       COALESCE(a.dibayar, 0)           AS dibayar,
       i.total - COALESCE(a.dibayar, 0) AS sisa,
       GREATEST(CURRENT_DATE - i.doc_date, 0) AS hari_sejak_faktur
  FROM purchase_invoice i
  LEFT JOIN (
      SELECT pa.invoice_id, SUM(pa.amount) AS dibayar
        FROM supplier_payment_allocation pa
        JOIN supplier_payment p ON p.id = pa.payment_id
       WHERE p.status = 'POSTED'
       GROUP BY pa.invoice_id
  ) a ON a.invoice_id = i.id
 WHERE i.status = 'POSTED';

-- ------------------------------------------------------------
-- Alokasi tidak boleh melebihi nilai faktur
-- ------------------------------------------------------------
--
-- Lapisan kedua di bawah lib/posting.ts, alasannya sama dengan
-- trigger alokasi pembayaran pelanggan: kalau suatu saat ada jalur kode
-- lain yang menulis alokasi tanpa lewat posting, ia berhenti di sini
-- alih-alih diam-diam membuat utang bersaldo negatif.
CREATE OR REPLACE FUNCTION assert_purchase_not_overpaid(p_invoice uuid)
RETURNS void AS $$
DECLARE
    v_total numeric(18,2);
    v_alloc numeric(18,2);
    v_doc   text;
BEGIN
    SELECT i.total, i.doc_no INTO v_total, v_doc
      FROM purchase_invoice i WHERE i.id = p_invoice;

    SELECT COALESCE(SUM(pa.amount), 0) INTO v_alloc
      FROM supplier_payment_allocation pa
      JOIN supplier_payment p ON p.id = pa.payment_id
     WHERE pa.invoice_id = p_invoice AND p.status = 'POSTED';

    IF v_alloc > v_total THEN
        RAISE EXCEPTION
            'Pembayaran ke faktur pembelian % melebihi nilainya: % dari %',
            COALESCE(v_doc, p_invoice::text), v_alloc, v_total;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_sp_alloc_within_invoice()
RETURNS trigger AS $$
BEGIN
    PERFORM assert_purchase_not_overpaid(COALESCE(NEW.invoice_id, OLD.invoice_id));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_sp_allocation_within_invoice
    AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_allocation
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_sp_alloc_within_invoice();

CREATE OR REPLACE FUNCTION trg_sp_within_invoice()
RETURNS trigger AS $$
DECLARE
    v_invoice uuid;
BEGIN
    FOR v_invoice IN
        SELECT DISTINCT invoice_id FROM supplier_payment_allocation
         WHERE payment_id = COALESCE(NEW.id, OLD.id)
    LOOP
        PERFORM assert_purchase_not_overpaid(v_invoice);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_sp_status_within_invoice
    AFTER UPDATE OF status ON supplier_payment
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_sp_within_invoice();

CREATE OR REPLACE FUNCTION block_posted_supplier_payment()
RETURNS trigger AS $$
BEGIN
    IF (SELECT status FROM supplier_payment
         WHERE id = COALESCE(NEW.payment_id, OLD.payment_id)) = 'POSTED' THEN
        RAISE EXCEPTION 'Pembayaran ke pemasok sudah diposting dan tidak dapat diubah.';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_posted_sp
    BEFORE INSERT OR UPDATE OR DELETE ON supplier_payment_allocation
    FOR EACH ROW EXECUTE FUNCTION block_posted_supplier_payment();

-- Nomor dokumen ikut terindeks palet pencarian.
CREATE INDEX IF NOT EXISTS idx_trgm_sp_doc_no
    ON supplier_payment USING gin (doc_no gin_trgm_ops);
