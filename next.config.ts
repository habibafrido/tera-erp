import type { NextConfig } from "next";

const config: NextConfig = {
  // pg memakai binding dinamis; biarkan Next memuatnya sebagai modul Node asli
  // alih-alih membundelnya ke dalam server component bundle.
  serverExternalPackages: ["pg"],

  // Ada package-lock.json lain di direktori induk, dan tanpa ini Next menebak
  // root workspace-nya di sana lalu menelusuri berkas jauh di luar project.
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
