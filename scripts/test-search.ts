/**
 * Tes palet pencarian. Tidak butuh browser dan tidak menulis apa pun ke
 * database.
 *
 * Dua bagian:
 *   1. Penjaga hasil basi (lib/latest.ts) — modul yang sama persis yang
 *      dipakai CommandPalette, bukan salinannya.
 *   2. Kontrak route handler lewat HTTP, kalau server dev sedang jalan.
 *
 * Jalankan: npm run test:search
 */
import { createLatest } from "../lib/latest";
import { AKUN, KATA_SANDI, masukSebagai } from "./masuk";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

let gagal = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) {
    console.log(`    dapat ${JSON.stringify(actual)}, harap ${JSON.stringify(expected)}`);
    gagal++;
  }
}

/**
 * Meniru satu permintaan jaringan: mengambil nomor urut saat dikirim,
 * selesai setelah `ms`, lalu menulis hasil HANYA kalau nomornya masih
 * yang terbaru. Persis alur di CommandPalette.
 */
function kirim(
  latest: ReturnType<typeof createLatest>,
  nilai: string,
  ms: number,
  tulis: (v: string) => void
) {
  const urut = latest.next();
  return new Promise<void>((res) =>
    setTimeout(() => {
      if (latest.isCurrent(urut)) tulis(nilai);
      res();
    }, ms)
  );
}

async function tesPenjagaBasi() {
  console.log("\n--- Penjaga hasil basi ---");

  // Skenario 1: mengetik cepat "m" → "mi" → "min".
  // Balasan "m" sengaja paling lambat, sehingga tiba paling akhir.
  {
    let layar = "(kosong)";
    const latest = createLatest();
    await Promise.all([
      kirim(latest, "hasil-m", 60, (v) => (layar = v)),
      kirim(latest, "hasil-mi", 30, (v) => (layar = v)),
      kirim(latest, "hasil-min", 10, (v) => (layar = v)),
    ]);
    check("balasan lambat dari kueri lama tidak menimpa", layar, "hasil-min");
  }

  // Skenario 2: mengetik lalu MENGHAPUS sampai di bawah panjang minimum.
  // invalidate() dipanggil, dan balasan yang masih di jalan harus dibuang.
  {
    let layar = "(kosong)";
    const latest = createLatest();
    const berjalan = kirim(latest, "hasil-min", 40, (v) => (layar = v));
    latest.invalidate(); // pengguna menghapus sampai tersisa "m"
    await berjalan;
    check("hasil tiba setelah input dikosongkan tetap dibuang", layar, "(kosong)");
  }

  // Skenario 3: urutan normal tidak ikut terbuang.
  {
    let layar = "(kosong)";
    const latest = createLatest();
    await kirim(latest, "hasil-tunggal", 5, (v) => (layar = v));
    check("permintaan tunggal tetap ditampilkan", layar, "hasil-tunggal");
  }

  // Skenario 4: ketik cepat 8 langkah, semua balasan tiba acak.
  {
    let layar = "(kosong)";
    const latest = createLatest();
    const langkah = ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh"];
    await Promise.all(
      langkah.map((v, i) =>
        // Yang dikirim lebih dulu justru dibalas lebih lambat.
        kirim(latest, v, (langkah.length - i) * 12, (x) => (layar = x))
      )
    );
    check("hanya kueri terakhir yang menang dari 8 permintaan", layar, "abcdefgh");
  }
}

async function tesRoute() {
  console.log("\n--- Route handler ---");

  let hidup = true;
  try {
    await fetch(BASE + "/api/search?q=mi", { signal: AbortSignal.timeout(5000) });
  } catch {
    hidup = false;
  }
  if (!hidup) {
    console.log("· server dev tidak jalan di " + BASE + ", bagian ini dilewati");
    return;
  }

/*
 * Skrip ini masuk lewat jalur yang sama dengan pengguna biasa dan
 * membawa cookie sesinya pada setiap permintaan. Tidak ada pemeriksaan
 * yang dilonggarkan supaya tes lewat — kalau autentikasinya rusak, tes
 * ini ikut gagal, dan itu memang yang diinginkan.
 */
  const sesi = await masukSebagai(BASE, AKUN.pengawas, KATA_SANDI);

  const ambil = async (q: string) => {
    const r = await fetch(BASE + "/api/search?q=" + encodeURIComponent(q), {
      headers: { Cookie: sesi.cookie },
    });
    return (await r.json()) as { groups: { title: string; items: unknown[] }[] };
  };

  check("kueri 1 huruf tidak mengembalikan kelompok", (await ambil("m")).groups.length, 0);
  check("kueri kosong tidak mengembalikan kelompok", (await ambil("")).groups.length, 0);

  const dua = await ambil("mi");
  check("kueri 2 huruf mengembalikan kelompok", dua.groups.length > 0, true);
  check(
    "maksimum 5 hasil per kelompok",
    dua.groups.every((g) => g.items.length <= 5),
    true
  );

  // Wildcard LIKE harus diperlakukan sebagai huruf biasa, bukan pola.
  const bintang = await ambil("%%");
  check("karakter % tidak menjadi wildcard", bintang.groups.length, 0);

  // String raksasa dipotong, bukan diteruskan apa adanya ke trigram.
  const panjang = await ambil("x".repeat(5000));
  check("input raksasa tidak menggagalkan permintaan", Array.isArray(panjang.groups), true);

  // Hanya SELECT: memanggil berkali-kali tidak mengubah apa pun.
  const a = await ambil("sku");
  const b = await ambil("sku");
  check("hasil stabil antar pemanggilan", JSON.stringify(a), JSON.stringify(b));
}

async function main() {
  await tesPenjagaBasi();
  await tesRoute();
  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
