"use server";

import { redirect } from "next/navigation";
import { catat } from "@/lib/auth/jejak";
import {
  buatSesi,
  cariUntukMasuk,
  hapusSesi,
  kataSandiCocok,
  penggunaSaatIni,
} from "@/lib/auth/sesi";
import { adalahPeran } from "@/lib/auth/izin";
import type { ActionResult } from "./actions";

/**
 * Aksi masuk dan keluar.
 *
 * Dipisah dari app/actions.ts karena keduanya adalah satu-satunya server
 * action yang TIDAK dibungkus denganPeran() — memang belum ada sesi yang
 * bisa diperiksa. Memisahkannya membuat pengecualian itu terlihat,
 * alih-alih tersembunyi di tengah berkas berisi aksi yang terlindungi.
 */

/**
 * Jeda tetap sebelum menjawab kegagalan.
 *
 * Tanpa ini, "email tidak ada" (satu kueri) dan "kata sandi salah" (satu
 * kueri + satu verifikasi argon2 yang makan puluhan milidetik) bisa
 * dibedakan dari waktu responsnya saja — dan itu cukup untuk memetakan
 * siapa saja yang punya akun.
 */
const JEDA_GAGAL_MS = 400;

const tunggu = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function masuk(fd: FormData): Promise<ActionResult> {
  const email = String(fd.get("email") ?? "").trim();
  const kataSandi = String(fd.get("kata_sandi") ?? "");

  if (!email || !kataSandi) {
    return { ok: false, message: "Email dan kata sandi wajib diisi." };
  }

  const mulai = Date.now();
  const pengguna = await cariUntukMasuk(email);

  /*
   * Kata sandi tetap diverifikasi meskipun akunnya tidak ada, memakai
   * hash palsu yang bentuknya sah. Kalau tidak, permintaan untuk email
   * yang tidak terdaftar akan kembali jauh lebih cepat.
   *
   * Pesan galatnya juga satu untuk semua sebab: email salah, kata sandi
   * salah, akun nonaktif, dan akun sistem menghasilkan kalimat yang
   * sama persis. Membedakannya berarti memberi tahu penebak bahwa ia
   * sudah menemukan separuh jawabannya.
   */
  const cocok = await kataSandiCocok(pengguna?.password_hash ?? null, kataSandi);
  const boleh = Boolean(pengguna) && cocok && pengguna!.is_active && !pengguna!.is_system;

  if (!boleh) {
    const sebab = !pengguna
      ? "email tidak terdaftar"
      : pengguna.is_system
        ? "akun sistem tidak bisa masuk lewat HTTP"
        : !pengguna.is_active
          ? "akun nonaktif"
          : "kata sandi salah";

    await catat({
      aksi: "sesi.masuk",
      hasil: "DITOLAK",
      alasan: sebab,
      detail: { email },
    });

    const sisa = JEDA_GAGAL_MS - (Date.now() - mulai);
    if (sisa > 0) await tunggu(sisa);

    return { ok: false, message: "Email atau kata sandi salah." };
  }

  if (!adalahPeran(pengguna!.peran)) {
    await catat({
      aksi: "sesi.masuk",
      hasil: "GAGAL",
      alasan: "peran tidak dikenal: " + pengguna!.peran,
      detail: { email },
    });
    return { ok: false, message: "Peran akun ini tidak dikenali. Hubungi pengawas." };
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
  });

  return { ok: true, message: "Selamat datang, " + pengguna!.nama + "." };
}

export async function keluar(): Promise<void> {
  const pengguna = await penggunaSaatIni();
  await hapusSesi();
  await catat({ aksi: "sesi.keluar", hasil: "BERHASIL", pengguna });
  redirect("/masuk");
}
