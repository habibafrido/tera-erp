import type { NextConfig } from "next";

const config: NextConfig = {
  // pg memakai binding dinamis; biarkan Next memuatnya sebagai modul Node asli
  // alih-alih membundelnya ke dalam server component bundle.
  serverExternalPackages: ["pg"],

  // Ada package-lock.json lain di direktori induk, dan tanpa ini Next menebak
  // root workspace-nya di sana lalu menelusuri berkas jauh di luar project.
  outputFileTracingRoot: import.meta.dirname,

  /*
   * Sertifikat root CA Supabase ikut dibawa ke bundel serverless.
   *
   * DATABASE_URL di produksi memakai sslmode=verify-full dengan
   * sslrootcert menunjuk berkas ini. pg membacanya dari disk saat
   * membuka koneksi, dan Next tidak bisa menebaknya sendiri karena
   * nama berkas itu hanya muncul di dalam sebuah connection string —
   * bukan di import mana pun.
   *
   * Tanpa baris ini aplikasinya tetap ter-build, lalu gagal saat
   * permintaan pertama dengan "ENOENT". Itu kegagalan yang muncul di
   * produksi dan tidak pernah di pengembangan.
   */
  outputFileTracingIncludes: {
    "/**": ["./certs/supabase-root-2021.crt"],
  },
};

export default config;
