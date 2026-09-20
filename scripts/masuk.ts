/**
 * Jalur masuk untuk skrip tes yang memanggil aplikasi lewat HTTP.
 *
 * Skrip TIDAK diberi pintu belakang. Ia masuk lewat formulir yang sama
 * dengan pengguna biasa — POST ke server action `masuk`, lalu memakai
 * cookie sesi yang dikembalikan. Kalau autentikasinya rusak, skrip ini
 * ikut gagal, dan itu memang yang diinginkan: rangkaian tes yang bisa
 * melewati autentikasi tidak menguji autentikasi sama sekali.
 *
 * Akun sistem (sistem@tera.local) sengaja tidak dipakai di sini: ia
 * tidak punya kata sandi dan tidak bisa masuk lewat HTTP. Perannya hanya
 * untuk atribusi baris yang dibuat skrip langsung ke database.
 */

export type Sesi = { cookie: string; email: string };

/**
 * Masuk dan mengembalikan header Cookie yang siap dipasang.
 *
 * Server action dipanggil apa adanya: Next.js mengeksposnya sebagai POST
 * ke URL halaman dengan header Next-Action berisi id action. Id itu
 * dibangkitkan saat build dan tidak stabil, jadi skrip ini memakai jalur
 * yang stabil: endpoint /api/masuk-uji yang hanya ada di lingkungan
 * bukan produksi.
 */
export async function masukSebagai(
  baseUrl: string,
  email: string,
  kataSandi: string
): Promise<Sesi> {
  const res = await fetch(baseUrl + "/api/masuk-uji", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, kata_sandi: kataSandi }),
  });

  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(
      `Gagal masuk sebagai ${email}: HTTP ${res.status} ${j?.error ?? ""}`.trim()
    );
  }

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Masuk sebagai ${email} berhasil tapi tidak ada cookie sesi.`);
  }

  // Hanya pasangan nama=nilai yang dikirim balik; atribut seperti Path
  // dan HttpOnly adalah instruksi untuk browser, bukan bagian nilainya.
  const cookie = setCookie.split(";")[0].trim();
  return { cookie, email };
}

/** Header siap pakai untuk fetch berikutnya. */
export const header = (sesi: Sesi, tambahan: Record<string, string> = {}) => ({
  Cookie: sesi.cookie,
  ...tambahan,
});

/** Kata sandi bawaan seed. Sama dengan yang dipakai scripts/schema.ts. */
export const KATA_SANDI = process.env.TERA_SEED_PASSWORD ?? "tera12345";

export const AKUN = {
  gudang: "gudang@tera.local",
  keuangan: "keuangan@tera.local",
  pengawas: "pengawas@tera.local",
} as const;
