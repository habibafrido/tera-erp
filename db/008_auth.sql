-- ============================================================
-- 008 - Autentikasi, hak akses, dan jejak audit
--
-- Sampai sekarang buku besar bisa memberi tahu APA yang terjadi, tapi
-- tidak SIAPA yang melakukannya. Untuk sistem yang buku besar stoknya
-- append-only dan jurnalnya tidak bisa diubah, itu lubang yang aneh:
-- seluruh rancangan berdiri di atas gagasan bahwa catatan tidak boleh
-- dibantah, sementara catatan tanpa pelaku selalu bisa dibantah.
--
-- Tiga tabel, dan satu kolom di setiap dokumen.
-- ============================================================

CREATE TYPE app_role AS ENUM ('operator_gudang', 'staf_keuangan', 'pengawas');

CREATE TABLE app_user (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    /*
     * Hash argon2id, dihitung di lapisan aplikasi.
     *
     * BUKAN SHA. SHA dirancang untuk cepat, dan cepat adalah sifat yang
     * salah untuk kata sandi: GPU modern menghitung miliaran SHA-256 per
     * detik, sehingga seluruh daftar kata sandi umum bisa dicoba dalam
     * hitungan menit terhadap dump yang bocor. argon2id sengaja lambat
     * DAN boros memori, sehingga tidak bisa dipercepat dengan perangkat
     * keras khusus.
     *
     * Kolom ini tidak pernah berisi kata sandi, dan tidak boleh ikut
     * di-SELECT ke mana pun selain pemeriksa kata sandi.
     */
    password_hash text,
    name          text NOT NULL,
    role          app_role NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    /*
     * Akun sistem: dipakai skrip dan proses latar untuk atribusi
     * dokumen. password_hash-nya NULL sehingga tidak ada kata sandi yang
     * bisa cocok — akun ini tidak bisa dipakai masuk lewat HTTP, dan
     * itu disengaja. Jalur skrip tidak boleh menjadi pintu belakang.
     */
    is_system     boolean NOT NULL DEFAULT false,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- Akun yang bisa masuk WAJIB punya hash. Akun sistem wajib tidak punya.
    CHECK ( (is_system AND password_hash IS NULL)
         OR (NOT is_system AND password_hash IS NOT NULL) )
);

-- ------------------------------------------------------------
-- Sesi
-- ------------------------------------------------------------
CREATE TABLE user_session (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    /*
     * SHA-256 dari token, BUKAN tokennya.
     *
     * Di sini SHA justru pilihan yang benar, dan alasannya kebalikan
     * dari kata sandi: token sesi adalah 256 bit acak dari CSPRNG, jadi
     * tidak ada "daftar token umum" untuk dicoba. Yang dibutuhkan hanya
     * fungsi satu arah yang cepat, karena ia dijalankan pada SETIAP
     * permintaan. Memakai argon2 di sini akan membuat setiap klik
     * halaman membayar ongkos yang dirancang untuk memperlambat
     * penebak — padahal tidak ada yang bisa ditebak.
     *
     * Yang dilindungi: dump database yang bocor tidak berisi satu pun
     * token yang bisa langsung dipakai masuk.
     */
    token_hash   text NOT NULL UNIQUE,
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    -- Masa berlaku menganggur; diperbarui selama sesi dipakai.
    expires_at   timestamptz NOT NULL,
    -- Batas mutlak. Sesi yang terus dipakai pun akhirnya harus masuk lagi.
    hard_expires_at timestamptz NOT NULL,
    revoked_at   timestamptz,
    ip           inet,
    user_agent   text
);

CREATE INDEX idx_session_user ON user_session(user_id);
CREATE INDEX idx_session_exp  ON user_session(expires_at);

-- ------------------------------------------------------------
-- Jejak audit
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),

    -- NULL berarti belum masuk sama sekali. Upaya tanpa sesi tetap
    -- dicatat — justru itu yang paling ingin dilihat orang nanti.
    user_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
    /*
     * Email dan peran DISALIN, tidak hanya ditunjuk lewat user_id.
     *
     * Jejak audit harus tetap terbaca setelah akunnya dihapus atau
     * perannya diubah. Kalau hanya ada foreign key, catatan enam bulan
     * lalu akan menampilkan peran yang dimiliki orang itu HARI INI,
     * bukan peran yang ia pakai saat melakukannya.
     */
    email      text,
    role       app_role,

    action     text NOT NULL,
    outcome    text NOT NULL CHECK (outcome IN ('BERHASIL', 'DITOLAK', 'GAGAL')),
    reason     text,

    doc_type   text,
    doc_id     uuid,
    doc_no     text,

    ip         inet,
    user_agent text,
    detail     jsonb
);

CREATE INDEX idx_audit_at      ON audit_log(at DESC);
CREATE INDEX idx_audit_user    ON audit_log(user_id, at DESC);
CREATE INDEX idx_audit_outcome ON audit_log(outcome, at DESC);
CREATE INDEX idx_audit_doc     ON audit_log(doc_type, doc_id);

/*
 * audit_log append-only, dengan alasan yang sama seperti stock_ledger:
 * catatan yang bisa disunting bukan catatan. Yang paling ingin dihapus
 * seseorang justru baris yang merekam perbuatannya sendiri.
 */
CREATE OR REPLACE FUNCTION block_audit_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_log bersifat append-only. Baris jejak audit tidak dapat diubah maupun dihapus.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_audit_mutation
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- TRUNCATE melewati trigger baris, jadi ia diblokir terpisah.
CREATE TRIGGER trg_block_audit_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION block_audit_mutation();

-- ------------------------------------------------------------
-- Akun sistem
-- ------------------------------------------------------------
--
-- Dibuat di migrasi, bukan di seed, karena trigger created_by di bawah
-- membutuhkannya sejak baris dokumen pertama.
INSERT INTO app_user (email, name, role, is_system, password_hash) VALUES
    ('sistem@tera.local', 'Sistem (skrip dan proses latar)', 'pengawas', true, NULL);

-- ------------------------------------------------------------
-- created_by pada setiap dokumen
-- ------------------------------------------------------------
ALTER TABLE goods_receipt    ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE sales_invoice    ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE payment_receipt  ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE purchase_invoice ADD COLUMN created_by uuid REFERENCES app_user(id);
ALTER TABLE journal_entry    ADD COLUMN created_by uuid REFERENCES app_user(id);

/*
 * Kolom diisi trigger kalau pemanggil tidak mengisinya.
 *
 * Aplikasi SELALU mengisinya dengan pengguna yang sedang masuk. Yang
 * jatuh ke akun sistem hanyalah baris yang dibuat skrip — migrasi, data
 * contoh, dan rangkaian tes. Itu bukan kelonggaran: "dibuat oleh skrip"
 * adalah jawaban yang benar untuk baris-baris itu, dan jauh lebih jujur
 * daripada membiarkan kolomnya kosong lalu menebak belakangan.
 */
CREATE OR REPLACE FUNCTION isi_created_by()
RETURNS trigger AS $$
BEGIN
    IF NEW.created_by IS NULL THEN
        NEW.created_by := (SELECT id FROM app_user WHERE email = 'sistem@tera.local');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_created_by_gr  BEFORE INSERT ON goods_receipt
    FOR EACH ROW EXECUTE FUNCTION isi_created_by();
CREATE TRIGGER trg_created_by_si  BEFORE INSERT ON sales_invoice
    FOR EACH ROW EXECUTE FUNCTION isi_created_by();
CREATE TRIGGER trg_created_by_pay BEFORE INSERT ON payment_receipt
    FOR EACH ROW EXECUTE FUNCTION isi_created_by();
CREATE TRIGGER trg_created_by_pi  BEFORE INSERT ON purchase_invoice
    FOR EACH ROW EXECUTE FUNCTION isi_created_by();

/*
 * Jurnal mewarisi atribusi dari dokumen sumbernya.
 *
 * Jurnal tidak pernah diketik orang — ia lahir dari dokumen. Menanyakan
 * "siapa yang membuat jurnal ini" karena itu sama dengan menanyakan
 * siapa yang memposting dokumennya, dan menjawabnya lewat pencarian
 * balik membuat lib/posting.ts tidak perlu tahu apa pun soal pengguna.
 */
CREATE OR REPLACE FUNCTION isi_created_by_jurnal()
RETURNS trigger AS $$
BEGIN
    IF NEW.created_by IS NULL AND NEW.source_id IS NOT NULL THEN
        NEW.created_by := CASE NEW.source_type
            WHEN 'GOODS_RECEIPT'    THEN (SELECT created_by FROM goods_receipt    WHERE id = NEW.source_id)
            WHEN 'SALES_INVOICE'    THEN (SELECT created_by FROM sales_invoice    WHERE id = NEW.source_id)
            WHEN 'PAYMENT_RECEIPT'  THEN (SELECT created_by FROM payment_receipt  WHERE id = NEW.source_id)
            WHEN 'PURCHASE_INVOICE' THEN (SELECT created_by FROM purchase_invoice WHERE id = NEW.source_id)
        END;
    END IF;
    IF NEW.created_by IS NULL THEN
        NEW.created_by := (SELECT id FROM app_user WHERE email = 'sistem@tera.local');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_created_by_je BEFORE INSERT ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION isi_created_by_jurnal();

-- Baris yang sudah ada sebelum migrasi ini tidak bisa diatribusikan
-- surut. Menebaknya akan memalsukan jejak, jadi ia diisi akun sistem
-- dan barulah kolomnya diwajibkan.
UPDATE goods_receipt    SET created_by = (SELECT id FROM app_user WHERE email='sistem@tera.local') WHERE created_by IS NULL;
UPDATE sales_invoice    SET created_by = (SELECT id FROM app_user WHERE email='sistem@tera.local') WHERE created_by IS NULL;
UPDATE payment_receipt  SET created_by = (SELECT id FROM app_user WHERE email='sistem@tera.local') WHERE created_by IS NULL;
UPDATE purchase_invoice SET created_by = (SELECT id FROM app_user WHERE email='sistem@tera.local') WHERE created_by IS NULL;
UPDATE journal_entry    SET created_by = (SELECT id FROM app_user WHERE email='sistem@tera.local') WHERE created_by IS NULL;

ALTER TABLE goods_receipt    ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE sales_invoice    ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE payment_receipt  ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE purchase_invoice ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE journal_entry    ALTER COLUMN created_by SET NOT NULL;

-- ------------------------------------------------------------
-- Role baca-saja asisten TIDAK boleh melihat kredensial
-- ------------------------------------------------------------
--
-- Migrasi 004 memberi SELECT pada semua tabel, termasuk tabel yang
-- dibuat kemudian. Dua tabel di bawah harus dikecualikan: hash kata
-- sandi dan token sesi tidak punya alasan apa pun untuk bisa dibaca
-- alat yang menjawab pertanyaan tentang stok.
--
-- audit_log dibiarkan bisa dibaca: pertanyaan "siapa yang memposting
-- faktur itu" adalah pertanyaan pelaporan yang sah.
REVOKE ALL ON app_user     FROM tera_readonly;
REVOKE ALL ON user_session FROM tera_readonly;
