-- ============================================================
-- Tera ERP - Role baca-saja untuk chat AI (Fase 4)
--
-- Lapisan pertahanan terakhir. Prompt sistem dan registry alat sudah
-- membatasi apa yang bisa dilakukan chat, tapi keduanya adalah kode
-- aplikasi: satu bug atau satu prompt injection yang berhasil bisa
-- melewatinya. Hak akses database tidak bisa dibujuk oleh kalimat.
--
-- Role ini HANYA punya SELECT. Tidak ada INSERT, UPDATE, DELETE,
-- maupun TRUNCATE, sekarang maupun untuk tabel yang dibuat kemudian.
--
-- CATATAN KEAMANAN
-- Kata sandi di bawah adalah nilai bawaan untuk pengembangan di komputer
-- sendiri, sama seperti kata sandi cluster embedded. Untuk pemasangan
-- yang bisa dijangkau jaringan, ganti dengan:
--     ALTER ROLE tera_readonly PASSWORD '<kata sandi lain>';
-- lalu sesuaikan READONLY_DATABASE_URL.
-- ============================================================

-- PostgreSQL tidak punya CREATE ROLE IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tera_readonly') THEN
        CREATE ROLE tera_readonly LOGIN PASSWORD 'tera_readonly';
    END IF;
END
$$;

-- Nama database tidak bisa ditulis tetap di sini: berkas ini juga
-- dijalankan pada database sementara milik db:verify.
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO tera_readonly', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO tera_readonly;

-- Tabel dan view yang sudah ada.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tera_readonly;

-- Sequence sengaja TIDAK diberikan. Membaca nilai sequence tidak
-- diperlukan untuk melaporkan apa pun, dan USAGE pada sequence
-- memungkinkan nextval() yang menggeser penomoran.

-- Tabel yang dibuat migrasi berikutnya ikut terkena SELECT saja.
-- DEFAULT PRIVILEGES hanya berlaku untuk objek yang dibuat oleh role
-- yang disebut di FOR ROLE, jadi pemilik skema saat ini yang dipakai.
DO $$
BEGIN
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'GRANT SELECT ON TABLES TO tera_readonly',
        current_user
    );
END
$$;
