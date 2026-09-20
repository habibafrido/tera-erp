import { NextResponse } from "next/server";
import { catat } from "@/lib/auth/jejak";
import { adalahPeran } from "@/lib/auth/izin";
import { buatSesi, cariUntukMasuk, kataSandiCocok } from "@/lib/auth/sesi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Endpoint masuk untuk rangkaian tes.
 *
 * KENAPA ADA: server action Next.js dipanggil lewat POST dengan header
 * Next-Action berisi id yang dibangkitkan saat build. Id itu tidak stabil
 * antar build, sehingga skrip tidak bisa memanggil aksi `masuk` secara
 * langsung tanpa menebak-nebak.
 *
 * KENAPA INI BUKAN PINTU BELAKANG:
 *   1. Ia memakai pemeriksaan kata sandi yang SAMA PERSIS dengan jalur
 *      biasa — argon2, akun aktif, bukan akun sistem. Tidak ada satu pun
 *      pemeriksaan yang dilonggarkan.
 *   2. Ia MENOLAK berjalan di produksi, di baris pertama, sebelum
 *      menyentuh apa pun.
 *   3. Upayanya tetap masuk jejak audit.
 *
 * Yang dihemat hanyalah cara memanggilnya, bukan siapa yang boleh masuk.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Tidak tersedia." }, { status: 404 });
  }

  let body: { email?: string; kata_sandi?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Isi permintaan tidak sah." }, { status: 400 });
  }

  const email = String(body.email ?? "").trim();
  const kataSandi = String(body.kata_sandi ?? "");

  const pengguna = await cariUntukMasuk(email);
  const cocok = await kataSandiCocok(pengguna?.password_hash ?? null, kataSandi);
  const boleh =
    Boolean(pengguna) && cocok && pengguna!.is_active && !pengguna!.is_system;

  if (!boleh || !adalahPeran(pengguna!.peran)) {
    await catat({
      aksi: "sesi.masuk",
      hasil: "DITOLAK",
      alasan: "lewat endpoint uji",
      detail: { email },
    });
    return NextResponse.json({ error: "Email atau kata sandi salah." }, { status: 401 });
  }

  await buatSesi(pengguna!.id);
  await catat({
    aksi: "sesi.masuk",
    hasil: "BERHASIL",
    pengguna: {
      id: pengguna!.id,
      email: pengguna!.email,
      nama: pengguna!.nama,
      peran: pengguna!.peran,
    },
    detail: { lewat: "endpoint uji" },
  });

  return NextResponse.json({ ok: true, peran: pengguna!.peran });
}
