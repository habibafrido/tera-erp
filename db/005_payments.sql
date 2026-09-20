-- ============================================================
-- 005 - Penerimaan pembayaran pelanggan
--
-- Sebelum ini piutang hanya bisa bertambah. Faktur menambah Piutang
-- Usaha dan tidak ada satu pun dokumen yang menguranginya, sehingga
-- laporan umur piutang menampilkan tagihan yang mungkin sudah lunas
-- berbulan-bulan lalu.
--
-- KEPUTUSAN RANCANGAN YANG PALING PENTING DI BERKAS INI
-- Tidak ada kolom "sisa tagihan" di sales_invoice.
--
-- Godaannya besar: satu kolom numeric yang dikurangi setiap kali ada
-- pembayaran akan membuat setiap kueri lebih pendek. Tapi kolom itu
-- adalah salinan dari sesuatu yang sudah punya sumber kebenaran, dan
-- salinan akan menyimpang — karena posting yang gagal di tengah, karena
-- koreksi manual, karena jalur kode kedua yang lupa memperbaruinya.
-- Ini alasan yang sama persis dengan tidak adanya kolom saldo stok di
-- tabel product: saldo dihitung dari buku besar, titik.
--
-- Sisa tagihan karena itu SELALU dihitung, lewat v_invoice_outstanding.
-- ============================================================

-- ------------------------------------------------------------
-- Akun baru
-- ------------------------------------------------------------

-- Kelebihan bayar tidak boleh dipaksa menjadi pendapatan. Uang yang
-- belum punya tagihan adalah kewajiban: sewaktu-waktu pelanggan bisa
-- memintanya kembali atau memakainya untuk faktur berikutnya.
INSERT INTO account (code, name, type) VALUES
    ('2-1400', 'Titipan Pelanggan', 'LIABILITY');

INSERT INTO account_mapping (key, account_id)
SELECT m.k, a.id FROM (VALUES
    ('CASH',             '1-1100'),
    ('CUSTOMER_DEPOSIT', '2-1400')
) AS m(k, code)
JOIN account a ON a.code = m.code;

-- ------------------------------------------------------------
-- Dokumen
-- ------------------------------------------------------------

CREATE TABLE payment_receipt (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_no        text UNIQUE,
    doc_date      date NOT NULL,
    customer_id   uuid NOT NULL REFERENCES partner(id),
    method        text NOT NULL DEFAULT 'TRANSFER',
    -- Nomor rekening koran, nomor giro, atau apa pun yang memungkinkan
    -- pembayaran ini ditelusuri kembali ke mutasi bank.
    reference     text,
    note          text,
    status        doc_status NOT NULL DEFAULT 'DRAFT',
    -- Uang yang benar-benar diterima.
    amount        numeric(18,2) NOT NULL CHECK (amount > 0),
    -- Pembagiannya, diisi saat posting. Ini BUKAN saldo berjalan yang
    -- akan menyimpang: keduanya sifat tetap dari dokumen yang sudah
    -- terposting, sama seperti sales_invoice.total.
    allocated     numeric(18,2) NOT NULL DEFAULT 0,
    unallocated   numeric(18,2) NOT NULL DEFAULT 0,
    posted_at     timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (allocated >= 0 AND unallocated >= 0)
);

CREATE TABLE payment_allocation (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id   uuid NOT NULL REFERENCES payment_receipt(id) ON DELETE CASCADE,
    invoice_id   uuid NOT NULL REFERENCES sales_invoice(id),
    amount       numeric(18,2) NOT NULL CHECK (amount > 0),
    -- Satu pembayaran boleh menyentuh banyak faktur, dan satu faktur
    -- boleh dilunasi beberapa kali oleh pembayaran BERBEDA. Yang tidak
    -- masuk akal hanyalah dua baris alokasi dari pembayaran yang sama
    -- ke faktur yang sama.
    UNIQUE (payment_id, invoice_id)
);

CREATE INDEX idx_alloc_invoice ON payment_allocation(invoice_id);
CREATE INDEX idx_payment_date  ON payment_receipt(doc_date DESC);
CREATE INDEX idx_payment_cust  ON payment_receipt(customer_id);

-- ------------------------------------------------------------
-- Sisa tagihan: DIHITUNG, tidak pernah disimpan
-- ------------------------------------------------------------
CREATE VIEW v_invoice_outstanding AS
SELECT i.id            AS invoice_id,
       i.doc_no,
       i.doc_date,
       i.due_date,
       i.customer_id,
       i.total,
       COALESCE(a.dibayar, 0)             AS dibayar,
       i.total - COALESCE(a.dibayar, 0)   AS sisa,
       GREATEST(CURRENT_DATE - COALESCE(i.due_date, i.doc_date), 0) AS hari_lewat
  FROM sales_invoice i
  LEFT JOIN (
      SELECT pa.invoice_id, SUM(pa.amount) AS dibayar
        FROM payment_allocation pa
        JOIN payment_receipt p ON p.id = pa.payment_id
       -- Hanya pembayaran TERPOSTING yang mengurangi tagihan. Draf
       -- belum menyentuh buku besar, jadi ia juga tidak boleh
       -- menyentuh angka yang dilihat orang.
       WHERE p.status = 'POSTED'
       GROUP BY pa.invoice_id
  ) a ON a.invoice_id = i.id
 WHERE i.status = 'POSTED';

-- ------------------------------------------------------------
-- Alokasi tidak boleh melebihi nilai faktur
-- ------------------------------------------------------------
--
-- Penolakan yang sebenarnya terjadi di lib/posting.ts, tempat pesan
-- galatnya bisa menyebut faktur mana dan sisanya berapa. Trigger ini
-- lapisan kedua: kalau suatu saat ada jalur kode lain yang menulis
-- alokasi tanpa lewat posting, ia akan berhenti di sini alih-alih
-- diam-diam membuat piutang bersaldo negatif.
--
-- DEFERRED, karena saat posting berlangsung alokasi disisipkan satu per
-- satu dan status pembayaran baru berubah di akhir; keadaan di tengah
-- transaksi memang belum utuh.
-- Pemeriksa bersama. Dipanggil dua trigger dengan bentuk baris berbeda,
-- jadi logikanya ditulis sekali di sini.
CREATE OR REPLACE FUNCTION assert_invoice_not_overallocated(p_invoice uuid)
RETURNS void AS $$
DECLARE
    v_total numeric(18,2);
    v_alloc numeric(18,2);
    v_doc   text;
BEGIN
    SELECT i.total, i.doc_no INTO v_total, v_doc
      FROM sales_invoice i WHERE i.id = p_invoice;

    SELECT COALESCE(SUM(pa.amount), 0) INTO v_alloc
      FROM payment_allocation pa
      JOIN payment_receipt p ON p.id = pa.payment_id
     WHERE pa.invoice_id = p_invoice AND p.status = 'POSTED';

    IF v_alloc > v_total THEN
        RAISE EXCEPTION
            'Alokasi pembayaran ke faktur % melebihi nilainya: % dari %',
            COALESCE(v_doc, p_invoice::text), v_alloc, v_total;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_alloc_within_invoice()
RETURNS trigger AS $$
BEGIN
    PERFORM assert_invoice_not_overallocated(
        COALESCE(NEW.invoice_id, OLD.invoice_id));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_allocation_within_invoice
    AFTER INSERT OR UPDATE OR DELETE ON payment_allocation
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_alloc_within_invoice();

-- Status pembayaran ikut memicu: alokasi bisa saja sudah tersimpan
-- sebagai draf jauh sebelum dokumennya diposting, sehingga perubahan
-- status itu sendiri yang membuat totalnya melewati batas.
CREATE OR REPLACE FUNCTION trg_payment_within_invoice()
RETURNS trigger AS $$
DECLARE
    v_invoice uuid;
BEGIN
    FOR v_invoice IN
        SELECT DISTINCT invoice_id FROM payment_allocation
         WHERE payment_id = COALESCE(NEW.id, OLD.id)
    LOOP
        PERFORM assert_invoice_not_overallocated(v_invoice);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_payment_status_within_invoice
    AFTER UPDATE OF status ON payment_receipt
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_payment_within_invoice();

-- Pembayaran yang sudah diposting tidak bisa diubah, sama seperti
-- jurnal. Koreksi dilakukan dengan dokumen pembalik, bukan dengan
-- menyunting yang lama.
CREATE OR REPLACE FUNCTION block_posted_payment()
RETURNS trigger AS $$
BEGIN
    IF (SELECT status FROM payment_receipt
         WHERE id = COALESCE(NEW.payment_id, OLD.payment_id)) = 'POSTED' THEN
        RAISE EXCEPTION 'Pembayaran sudah diposting dan tidak dapat diubah.';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_posted_payment
    BEFORE INSERT OR UPDATE OR DELETE ON payment_allocation
    FOR EACH ROW EXECUTE FUNCTION block_posted_payment();
