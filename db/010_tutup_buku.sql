-- ============================================================
-- 010 - Tutup buku periode
--
-- MASALAH YANG DIPECAHKAN
-- Sampai sekarang tidak ada yang mencegah seseorang memposting dokumen
-- bertanggal tiga bulan lalu. Begitu itu terjadi, laporan yang sudah
-- dicetak, dikirim ke bank, atau dilaporkan ke pajak berubah diam-diam:
-- angka yang sama, dicetak dua kali, memberi dua jawaban berbeda tanpa
-- satu pun pesan galat.
--
-- DITEGAKKAN BASIS DATA, BUKAN APLIKASI
-- Aplikasi boleh memeriksa lebih awal demi pesan yang ramah, tetapi
-- penegakan sesungguhnya ada di trigger — konsisten dengan lima aturan
-- lain yang sudah dijaga di sini: debit = kredit, jurnal terposting
-- tidak bisa diubah, ledger append-only, alokasi tidak melebihi faktur,
-- dan audit_log tidak bisa disunting.
--
-- Pemeriksaan di aplikasi bisa dilewati oleh skrip, oleh psql, dan oleh
-- jalur kode kedua yang lupa memanggilnya. Trigger tidak.
-- ============================================================

CREATE TYPE period_status AS ENUM ('TERBUKA', 'DITUTUP');

CREATE TABLE accounting_period (
    tahun  int NOT NULL CHECK (tahun BETWEEN 2000 AND 2100),
    bulan  int NOT NULL CHECK (bulan BETWEEN 1 AND 12),
    status period_status NOT NULL DEFAULT 'TERBUKA',

    ditutup_oleh uuid REFERENCES app_user(id),
    ditutup_pada timestamptz,

    dibuka_kembali_oleh uuid REFERENCES app_user(id),
    dibuka_kembali_pada timestamptz,
    alasan text,

    /*
     * PENANDA PERMANEN.
     *
     * Kolom dibuka_kembali_* akan tertimpa kalau periodenya ditutup lagi
     * lalu dibuka lagi. Penghitung ini tidak pernah turun, sehingga
     * "periode ini pernah dibuka kembali" tetap terbaca selamanya —
     * dan itu justru informasi yang paling dicari auditor.
     */
    jumlah_dibuka_kembali int NOT NULL DEFAULT 0,

    dibuat_pada timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tahun, bulan),

    -- Status DITUTUP wajib membawa jejak siapa dan kapan.
    CHECK (status = 'TERBUKA'
           OR (ditutup_oleh IS NOT NULL AND ditutup_pada IS NOT NULL))
);

CREATE INDEX idx_period_status ON accounting_period(status);

-- ------------------------------------------------------------
-- Riwayat: append-only
-- ------------------------------------------------------------
--
-- Tabel periode menyimpan KEADAAN SEKARANG; tabel ini menyimpan seluruh
-- perjalanannya. Sebuah periode yang ditutup, dibuka, dikoreksi, lalu
-- ditutup lagi hanya punya satu baris di accounting_period — tetapi
-- empat baris di sini, dan urutan itulah ceritanya.
CREATE TABLE accounting_period_log (
    id       bigserial PRIMARY KEY,
    tahun    int NOT NULL,
    bulan    int NOT NULL,
    aksi     text NOT NULL CHECK (aksi IN ('DITUTUP', 'DIBUKA_KEMBALI')),
    oleh     uuid REFERENCES app_user(id),
    email    text,
    alasan   text,
    pada     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tahun, bulan) REFERENCES accounting_period(tahun, bulan)
);

CREATE INDEX idx_period_log ON accounting_period_log(tahun, bulan, pada DESC);

CREATE OR REPLACE FUNCTION block_period_log_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'Riwayat periode bersifat append-only dan tidak dapat diubah maupun dihapus.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_period_log
    BEFORE UPDATE OR DELETE ON accounting_period_log
    FOR EACH ROW EXECUTE FUNCTION block_period_log_mutation();

CREATE TRIGGER trg_block_period_log_truncate
    BEFORE TRUNCATE ON accounting_period_log
    FOR EACH STATEMENT EXECUTE FUNCTION block_period_log_mutation();

-- ------------------------------------------------------------
-- Penegakan
-- ------------------------------------------------------------

/**
 * Apakah sebuah tanggal jatuh di periode yang DITUTUP?
 *
 * Periode yang belum pernah dicatat dianggap TERBUKA. Bawaannya sengaja
 * permisif: sistem yang baru dipasang tidak boleh menolak seluruh
 * postingan hanya karena tabel periodenya masih kosong.
 */
CREATE OR REPLACE FUNCTION periode_ditutup(p_tanggal date)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1 FROM accounting_period
         WHERE tahun = EXTRACT(YEAR FROM p_tanggal)::int
           AND bulan = EXTRACT(MONTH FROM p_tanggal)::int
           AND status = 'DITUTUP'
    );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION assert_periode_terbuka()
RETURNS trigger AS $$
BEGIN
    IF periode_ditutup(NEW.entry_date) THEN
        RAISE EXCEPTION
            'Periode % sudah ditutup. Jurnal bertanggal % tidak bisa diposting. '
            'Koreksi dicatat dengan jurnal pembalik bertanggal di periode yang masih terbuka.',
            to_char(NEW.entry_date, 'Month YYYY'), to_char(NEW.entry_date, 'DD-MM-YYYY');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INSERT maupun perubahan tanggal: memindahkan jurnal yang sudah ada ke
-- dalam periode tertutup sama saja dengan memposting ke sana.
CREATE TRIGGER trg_periode_terbuka_je
    BEFORE INSERT OR UPDATE OF entry_date ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION assert_periode_terbuka();

/**
 * Buku besar stok memakai TANGGAL JURNALNYA, bukan posted_at.
 *
 * posted_at adalah waktu nyata saat baris ditulis; sebuah dokumen
 * bertanggal mundur punya posted_at hari ini. Kalau periode dinilai dari
 * posted_at, stok dan jurnal dari dokumen yang sama bisa jatuh di dua
 * periode berbeda — dan rekonsiliasi persediaan tidak akan pernah
 * seimbang lagi. Yang menentukan adalah tanggal akuntansinya.
 */
CREATE OR REPLACE FUNCTION assert_periode_terbuka_ledger()
RETURNS trigger AS $$
DECLARE
    v_tanggal date;
BEGIN
    SELECT entry_date INTO v_tanggal
      FROM journal_entry WHERE id = NEW.journal_entry_id;

    -- Baris tanpa jurnal (saldo awal, penyesuaian teknis) dinilai dari
    -- waktu postingnya sendiri.
    v_tanggal := COALESCE(v_tanggal, NEW.posted_at::date);

    IF periode_ditutup(v_tanggal) THEN
        RAISE EXCEPTION
            'Periode % sudah ditutup. Pergerakan stok bertanggal % tidak bisa dicatat.',
            to_char(v_tanggal, 'Month YYYY'), to_char(v_tanggal, 'DD-MM-YYYY');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_periode_terbuka_ledger
    BEFORE INSERT ON stock_ledger
    FOR EACH ROW EXECUTE FUNCTION assert_periode_terbuka_ledger();

-- ------------------------------------------------------------
-- Periode tertutup tidak bisa ditutup ulang diam-diam
-- ------------------------------------------------------------
--
-- Menutup periode yang sudah tertutup akan menimpa ditutup_oleh dan
-- ditutup_pada dengan nilai baru, menghapus jejak penutupan aslinya.
CREATE OR REPLACE FUNCTION block_tutup_ganda()
RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'DITUTUP' AND NEW.status = 'DITUTUP'
       AND OLD.ditutup_pada IS DISTINCT FROM NEW.ditutup_pada THEN
        RAISE EXCEPTION
            'Periode %-% sudah ditutup. Buka kembali dulu sebelum menutupnya lagi.',
            OLD.tahun, OLD.bulan;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_tutup_ganda
    BEFORE UPDATE ON accounting_period
    FOR EACH ROW EXECUTE FUNCTION block_tutup_ganda();

-- ------------------------------------------------------------
-- Pandangan ringkas
-- ------------------------------------------------------------
CREATE VIEW v_periode AS
SELECT p.tahun, p.bulan, p.status,
       make_date(p.tahun, p.bulan, 1)                              AS awal,
       (make_date(p.tahun, p.bulan, 1) + INTERVAL '1 month - 1 day')::date AS akhir,
       p.ditutup_pada, p.dibuka_kembali_pada, p.alasan,
       p.jumlah_dibuka_kembali,
       (p.jumlah_dibuka_kembali > 0)                               AS pernah_dibuka,
       u.name  AS ditutup_oleh_nama,
       u.email AS ditutup_oleh_email,
       r.name  AS dibuka_oleh_nama,
       r.email AS dibuka_oleh_email
  FROM accounting_period p
  LEFT JOIN app_user u ON u.id = p.ditutup_oleh
  LEFT JOIN app_user r ON r.id = p.dibuka_kembali_oleh;

-- Role baca-saja asisten boleh membaca keduanya: "periode apa saja yang
-- sudah ditutup" adalah pertanyaan pelaporan yang sah.
GRANT SELECT ON accounting_period, accounting_period_log, v_periode
    TO tera_readonly;
