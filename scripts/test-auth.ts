/**
 * Tes autentikasi, hak akses, dan jejak audit.
 *
 * Yang diuji di sini bukan "apakah halaman dialihkan ke /masuk" — itu
 * bagian yang paling mudah dan paling tidak penting. Yang diuji adalah
 * jalur yang benar-benar dipakai penyerang:
 *
 *   SERVER ACTION DIPANGGIL LANGSUNG.
 *
 * Server action adalah endpoint HTTP tersendiri. Klien memanggilnya
 * dengan POST ke URL halaman mana pun, membawa header Next-Action berisi
 * id action-nya, tanpa pernah menavigasi ke halaman itu. Middleware yang
 * memeriksa "halaman apa yang dibuka" karena itu bisa dilewati
 * sepenuhnya. Skrip ini memanggilnya persis begitu.
 *
 * Jalankan: npm run test:auth  (butuh `npm run dev` berjalan)
 */
import { Client } from "pg";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./env";
import { AKUN, KATA_SANDI, masukSebagai, type Sesi } from "./masuk";

const env = loadEnv();
const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

let gagal = 0;

function ok(label: string, benar: boolean, detail = "") {
  console.log(`${benar ? "✓" : "✗"} ${label}${detail ? "\n    " + detail : ""}`);
  if (!benar) gagal++;
}

function eq(label: string, a: unknown, b: unknown) {
  ok(label, String(a) === String(b), `dapat ${a}, harap ${b}`);
}

// ------------------------------------------------------------
// Memanggil server action langsung
// ------------------------------------------------------------

/**
 * Peta nama server action -> id-nya.
 *
 * Id dibangkitkan saat build dan tidak ada di kode sumber. Ia dibaca
 * dari server-reference-manifest.json milik Next, bukan dikorek dari
 * bundel klien: yang diuji skrip ini adalah JALUR PEMANGGILANNYA, bukan
 * seberapa sulit id-nya ditemukan.
 *
 * Dan id itu memang tidak rahasia. Ia dikirim ke browser setiap
 * pengguna, jadi siapa pun yang pernah membuka halamannya sekali
 * memilikinya selamanya — termasuk setelah aksesnya dicabut. Itulah
 * alasan pemeriksaan wewenang harus ada di dalam action-nya, bukan pada
 * siapa yang tahu id-nya.
 */
function petaAction(): Map<string, string> {
  const berkas = ".next/server/server-reference-manifest.json";
  let teks: string;
  try {
    teks = readFileSync(berkas, "utf8");
  } catch {
    throw new Error(
      `${berkas} tidak ada. Jalankan \`npm run dev\` dan buka satu halaman dulu.`
    );
  }

  /*
   * moduleId di manifest adalah query string yang ter-URL-encode, dan di
   * dalamnya JSON dengan tanda kutip ber-escape. Keduanya dibuka dulu;
   * %XX diterjemahkan satu per satu supaya satu byte ganjil tidak
   * menggagalkan seluruh berkas seperti decodeURIComponent().
   */
  const dibuka = teks.replace(/%[0-9A-Fa-f]{2}/g, (m) =>
    String.fromCharCode(parseInt(m.slice(1), 16))
  );

  const peta = new Map<string, string>();
  for (const m of dibuka.matchAll(
    /"id":"([0-9a-f]{20,})","exportedName":"(\w+)"/g
  )) {
    peta.set(m[2], m[1]);
  }
  return peta;
}

/** Memanggil server action lewat POST, tanpa menavigasi ke halaman mana pun. */
async function panggilAction(
  halaman: string,
  actionId: string,
  args: unknown[],
  cookie?: string
) {
  const res = await fetch(BASE + halaman, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Next-Action": actionId,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  return { status: res.status, teks: await res.text() };
}

// ------------------------------------------------------------

async function main() {
  try {
    const cek = await fetch(BASE + "/masuk", { signal: AbortSignal.timeout(5000) });
    if (!cek.ok) throw new Error("tidak sehat");
  } catch {
    console.log(`\n⚠ Server tidak berjalan di ${BASE}. Jalankan \`npm run dev\` dulu.`);
    process.exit(0);
  }

  const db = new Client({ connectionString: env.url });
  await db.connect();

  const satu = async (sql: string, p: unknown[] = []) =>
    (await db.query(sql, p as never[])).rows[0];

  try {
    // ================================================================
    console.log("\n--- 1. Tidak ada server action yang lupa dibungkus ---");
    // ================================================================

    /*
     * Pemeriksaan statis, bukan runtime. Satu aksi yang lupa dibungkus
     * tidak akan pernah muncul sebagai tes yang gagal — ia hanya akan
     * bekerja, untuk siapa saja. Jadi berkasnya yang dibaca.
     */
    const src = readFileSync("app/actions.ts", "utf8");
    const diekspor = [...src.matchAll(/^export (?:const|async function) (\w+)/gm)].map(
      (m) => m[1]
    );
    const dibungkus = [...src.matchAll(/^export const (\w+) = denganPeran\(/gm)].map(
      (m) => m[1]
    );
    const telanjang = diekspor.filter((n) => !dibungkus.includes(n));
    ok(
      "setiap aksi di app/actions.ts dibungkus denganPeran()",
      telanjang.length === 0,
      telanjang.length ? "belum dibungkus: " + telanjang.join(", ") : `${dibungkus.length} aksi`
    );

    // Berkas lain yang memuat "use server" juga diperiksa.
    const berkasServer: string[] = [];
    const telusuri = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) telusuri(p);
        else if (/\.tsx?$/.test(n) && readFileSync(p, "utf8").startsWith('"use server"')) {
          berkasServer.push(p.replace(/\\/g, "/"));
        }
      }
    };
    telusuri("app");
    ok(
      "berkas 'use server' hanya app/actions.ts dan app/auth-actions.ts",
      berkasServer.every((f) => f === "app/actions.ts" || f === "app/auth-actions.ts"),
      berkasServer.join(", ")
    );

    // ================================================================
    console.log("\n--- 2. Server action ditolak tanpa sesi ---");
    // ================================================================

    // Sesi dibuat lebih dulu: id action hanya bisa dipanen dari halaman
    // yang benar-benar dirender, dan itu butuh sesi.
    const sesiGudang = await masukSebagai(BASE, AKUN.gudang, KATA_SANDI);
    const sesiKeuangan = await masukSebagai(BASE, AKUN.keuangan, KATA_SANDI);
    const sesiPengawas = await masukSebagai(BASE, AKUN.pengawas, KATA_SANDI);

    const sebelum = await satu(`SELECT COUNT(*)::int AS n FROM audit_log`);

    const AKSI: [string, string, unknown[]][] = [
      ["/products", "createProduct", [{}]],
      ["/warehouses", "createWarehouse", [{}]],
      ["/payments/new", "fakturTerbuka", ["00000000-0000-0000-0000-000000000000"]],
      ["/purchases/new", "penerimaanBelumDifakturkan", ["00000000-0000-0000-0000-000000000000"]],
    ];

    /*
     * Server dev mengompilasi halaman saat pertama diminta, dan
     * server-reference-manifest.json baru memuat action milik halaman
     * yang SUDAH dikompilasi. Halamannya karena itu dibuka dulu —
     * kalau tidak, manifest yang dibaca masih kosong dan tes ini akan
     * melaporkan "id tidak ketemu" untuk sebab yang tidak ada
     * hubungannya dengan autentikasi.
     */
    for (const halaman of new Set(AKSI.map(([h]) => h))) {
      await fetch(BASE + halaman, { headers: { Cookie: sesiPengawas.cookie } });
    }

    const ID = petaAction();
    console.log(`    ${ID.size} server action terdaftar di manifest`);

    let terpanggil = 0;
    for (const [halaman, nama, args] of AKSI) {
      const id = ID.get(nama);
      if (!id) {
        ok(`id action ${nama} ada di manifest`, false, "tidak ketemu");
        continue;
      }
      terpanggil++;

      /*
       * DUA kasus yang berbeda, dan bedanya penting.
       *
       * (a) tanpa cookie sama sekali: middleware menahannya lebih dulu
       *     dengan pengalihan, sehingga action tidak pernah dijalankan.
       *
       * (b) cookie PALSU: middleware meloloskannya — ia hanya bisa
       *     melihat ada-tidaknya cookie, bukan sahnya — dan yang
       *     menghentikannya adalah denganPeran() di dalam action itu
       *     sendiri. Inilah kasus yang membuktikan pemeriksaan di
       *     server action benar-benar diperlukan.
       */
      const tanpaCookie = await panggilAction(halaman, id, args);
      ok(
        `${nama}: tanpa cookie ditahan sebelum action dijalankan`,
        tanpaCookie.status === 307 &&
          /\/masuk/.test(tanpaCookie.teks + String(tanpaCookie.status)),
        `status ${tanpaCookie.status}`
      );

      const cookiePalsu = await panggilAction(
        halaman, id, args, "tera_sesi=token-palsu-yang-tidak-pernah-ada"
      );
      ok(
        `${nama}: cookie palsu ditolak OLEH ACTION-nya sendiri`,
        /Sesi Anda sudah berakhir/.test(cookiePalsu.teks),
        `status ${cookiePalsu.status}, cuplikan: ${cookiePalsu.teks
          .replace(/\s+/g, " ")
          .slice(0, 110)}`
      );
    }
    ok("setidaknya satu action berhasil dipanggil langsung", terpanggil > 0);

    const sesudah = await satu(`SELECT COUNT(*)::int AS n FROM audit_log`);
    ok(
      "upaya tanpa sesi tercatat di audit_log",
      sesudah.n > sebelum.n,
      `${sebelum.n} -> ${sesudah.n}`
    );

    const tanpaSesi = await satu(
      `SELECT action, outcome, reason, user_id
         FROM audit_log WHERE outcome='DITOLAK' AND reason='tanpa sesi'
        ORDER BY at DESC LIMIT 1`
    );
    ok("baris penolakan menyebut sebabnya", tanpaSesi?.reason === "tanpa sesi");
    ok("penolakan tanpa sesi tidak menunjuk pengguna mana pun", tanpaSesi?.user_id === null);
    ok(
      "aksi yang dicatat adalah aksi yang dicoba, bukan nama generik",
      typeof tanpaSesi?.action === "string" && tanpaSesi.action.includes("."),
      String(tanpaSesi?.action)
    );

    // ================================================================
    console.log("\n--- 3. Peran ditolak di luar kewenangannya ---");
    // ================================================================

    /** [halaman, nama action, argumen, sesi, boleh?] */
    const MATRIKS: [string, string, unknown[], Sesi, boolean, string][] = [
      ["/products", "createProduct", [{}], sesiGudang, false, "operator gudang membuat barang"],
      ["/products", "createProduct", [{}], sesiKeuangan, true, "staf keuangan membuat barang"],
      ["/products", "createProduct", [{}], sesiPengawas, true, "pengawas membuat barang"],
      ["/warehouses", "createWarehouse", [{}], sesiKeuangan, false, "staf keuangan membuat gudang"],
      ["/warehouses", "createWarehouse", [{}], sesiGudang, true, "operator gudang membuat gudang"],
      [
        "/payments/new", "fakturTerbuka",
        ["00000000-0000-0000-0000-000000000000"], sesiGudang, false,
        "operator gudang membaca faktur terbuka",
      ],
      [
        "/payments/new", "fakturTerbuka",
        ["00000000-0000-0000-0000-000000000000"], sesiKeuangan, true,
        "staf keuangan membaca faktur terbuka",
      ],
    ];

    for (const [halaman, nama, args, sesi, boleh, label] of MATRIKS) {
      const id = ID.get(nama);
      if (!id) {
        ok(label, false, "id action tidak ada di manifest");
        continue;
      }
      const r = await panggilAction(halaman, id, args, sesi.cookie);
      const ditolak = /tidak berwenang/.test(r.teks);
      ok(
        boleh ? `${label}: DIIZINKAN` : `${label}: DITOLAK`,
        boleh ? !ditolak : ditolak,
        r.teks.replace(/\s+/g, " ").slice(0, 110)
      );
    }

    const penolakanPeran = await satu(
      `SELECT action, email, role, reason FROM audit_log
        WHERE outcome='DITOLAK' AND reason LIKE 'peran %'
        ORDER BY at DESC LIMIT 1`
    );
    ok(
      "penolakan karena peran tercatat lengkap dengan email dan perannya",
      Boolean(penolakanPeran?.email && penolakanPeran?.role),
      `${penolakanPeran?.email} / ${penolakanPeran?.role} / ${penolakanPeran?.reason}`
    );

    // ================================================================
    console.log("\n--- 4. API ditolak tanpa sesi dan tanpa wewenang ---");
    // ================================================================

    const apiTanpa = async (u: string) =>
      (await fetch(BASE + u, { redirect: "manual" })).status;
    eq("GET /api/search tanpa sesi", await apiTanpa("/api/search?q=SKU"), 401);
    eq("GET /api/export tanpa sesi", await apiTanpa("/api/export/saldo_stok"), 401);
    eq(
      "POST /api/chat tanpa sesi",
      (
        await fetch(BASE + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hai" }] }),
          redirect: "manual",
        })
      ).status,
      401
    );

    const dgn = async (u: string, sesi: Sesi) =>
      (await fetch(BASE + u, { headers: { Cookie: sesi.cookie } })).status;
    eq("GET /api/search dengan sesi", await dgn("/api/search?q=SKU", sesiGudang), 200);
    eq("GET /api/export dengan sesi", await dgn("/api/export/saldo_stok", sesiGudang), 200);

    // ================================================================
    console.log("\n--- 5. Halaman di balik autentikasi ---");
    // ================================================================

    for (const u of ["/", "/stock", "/asisten", "/journal", "/laporan/neraca"]) {
      const r = await fetch(BASE + u, { redirect: "manual" });
      ok(
        `${u} dialihkan ke /masuk tanpa sesi`,
        r.status === 307 && (r.headers.get("location") ?? "").endsWith("/masuk"),
        `status ${r.status} -> ${r.headers.get("location")}`
      );
    }
    eq(
      "/asisten terbuka dengan sesi",
      (await fetch(BASE + "/asisten", { headers: { Cookie: sesiGudang.cookie } })).status,
      200
    );
    eq("/masuk terbuka tanpa sesi", (await fetch(BASE + "/masuk")).status, 200);

    // ================================================================
    console.log("\n--- 6. Kredensial dan sesi ---");
    // ================================================================

    const masukGagal = await fetch(BASE + "/api/masuk-uji", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: AKUN.pengawas, kata_sandi: "salah" }),
    });
    eq("kata sandi salah ditolak", masukGagal.status, 401);

    const masukSistem = await fetch(BASE + "/api/masuk-uji", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sistem@tera.local", kata_sandi: KATA_SANDI }),
    });
    eq("akun sistem tidak bisa masuk lewat HTTP", masukSistem.status, 401);

    const hash = await satu(
      `SELECT password_hash FROM app_user WHERE email=$1`, [AKUN.pengawas]
    );
    ok(
      "kata sandi disimpan sebagai argon2id, bukan SHA",
      String(hash.password_hash).startsWith("$argon2id$"),
      String(hash.password_hash).slice(0, 30)
    );

    const sistemHash = await satu(
      `SELECT password_hash FROM app_user WHERE email='sistem@tera.local'`
    );
    ok("akun sistem tidak punya hash sama sekali", sistemHash.password_hash === null);

    const tokenDb = await satu(
      `SELECT token_hash, expires_at > now() AS hidup,
              hard_expires_at > expires_at AS ada_batas_mutlak
         FROM user_session ORDER BY created_at DESC LIMIT 1`
    );
    ok(
      "token sesi disimpan sebagai sidik SHA-256, bukan tokennya",
      /^[0-9a-f]{64}$/.test(tokenDb.token_hash) &&
        !sesiPengawas.cookie.includes(tokenDb.token_hash),
      tokenDb.token_hash.slice(0, 20) + "..."
    );
    ok("sesi punya masa berlaku", tokenDb.hidup === true);
    ok("sesi punya batas mutlak terpisah", tokenDb.ada_batas_mutlak === true);

    const setCookie = masukGagal.headers.get("set-cookie");
    ok("permintaan yang ditolak tidak memasang cookie", !setCookie);

    const sesiBaru = await fetch(BASE + "/api/masuk-uji", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: AKUN.gudang, kata_sandi: KATA_SANDI }),
    });
    const ck = sesiBaru.headers.get("set-cookie") ?? "";
    ok("cookie sesi httpOnly", /httponly/i.test(ck), ck.slice(0, 120));
    ok("cookie sesi SameSite=Lax", /samesite=lax/i.test(ck), ck.slice(0, 120));
    ok(
      "cookie sesi punya Path dan Max-Age",
      /path=\//i.test(ck) && /max-age=\d+/i.test(ck),
      ck.slice(0, 120)
    );

    // Cookie palsu: lolos middleware, berhenti di pemeriksaan sesi.
    const palsu = await fetch(BASE + "/stock", {
      headers: { Cookie: "tera_sesi=bukan-token-sungguhan" },
      redirect: "manual",
    });
    ok(
      "cookie palsu tetap dialihkan ke /masuk",
      palsu.status === 307 && (palsu.headers.get("location") ?? "").endsWith("/masuk"),
      `status ${palsu.status} -> ${palsu.headers.get("location")}`
    );

    // ================================================================
    console.log("\n--- 7. audit_log append-only ---");
    // ================================================================

    const baris = await satu(`SELECT id FROM audit_log ORDER BY id DESC LIMIT 1`);

    const tolakSql = async (label: string, sql: string, cocok: RegExp) => {
      try {
        await db.query(sql);
        ok(label, false, "berhasil, seharusnya ditolak");
      } catch (e) {
        const pesan = e instanceof Error ? e.message : String(e);
        ok(label, cocok.test(pesan), pesan.slice(0, 120));
        // Transaksi implisit sudah dibatalkan; koneksi tetap bisa dipakai.
      }
    };

    await tolakSql(
      "UPDATE audit_log ditolak",
      `UPDATE audit_log SET action='dipalsukan' WHERE id=${Number(baris.id)}`,
      /append-only/
    );
    await tolakSql(
      "DELETE audit_log ditolak",
      `DELETE FROM audit_log WHERE id=${Number(baris.id)}`,
      /append-only/
    );
    await tolakSql(
      "TRUNCATE audit_log ditolak",
      `TRUNCATE audit_log`,
      /append-only/
    );

    const utuh = await satu(`SELECT action FROM audit_log WHERE id=$1`, [baris.id]);
    ok("baris jejak tetap utuh setelah ketiga upaya", utuh?.action !== "dipalsukan");

    // ================================================================
    console.log("\n--- 8. Isi jejak audit ---");
    // ================================================================

    const wajib = await satu(`
      SELECT COUNT(*) FILTER (WHERE action IS NULL)  AS tanpa_aksi,
             COUNT(*) FILTER (WHERE outcome IS NULL) AS tanpa_hasil,
             COUNT(*) FILTER (WHERE at IS NULL)      AS tanpa_waktu,
             COUNT(*) FILTER (WHERE outcome NOT IN ('BERHASIL','DITOLAK','GAGAL'))
                                                     AS hasil_asing
        FROM audit_log
    `);
    eq("setiap baris punya aksi", wajib.tanpa_aksi, 0);
    eq("setiap baris punya hasil", wajib.tanpa_hasil, 0);
    eq("setiap baris punya waktu", wajib.tanpa_waktu, 0);
    eq("tidak ada hasil di luar tiga nilai yang sah", wajib.hasil_asing, 0);

    const ragam = await db.query(
      `SELECT outcome, COUNT(*)::int AS n FROM audit_log GROUP BY outcome ORDER BY outcome`
    );
    console.log(
      "    ragam hasil: " +
        ragam.rows.map((r) => `${r.outcome}=${r.n}`).join(", ")
    );
    ok(
      "jejak memuat keberhasilan DAN penolakan",
      ragam.rows.some((r) => r.outcome === "BERHASIL") &&
        ragam.rows.some((r) => r.outcome === "DITOLAK")
    );

    const masukTercatat = await satu(
      `SELECT COUNT(*)::int AS n FROM audit_log
        WHERE action='sesi.masuk' AND outcome='DITOLAK'`
    );
    ok("upaya masuk yang gagal tercatat", masukTercatat.n > 0, `${masukTercatat.n} baris`);

    // ================================================================
    console.log("\n--- 9. created_by pada setiap dokumen ---");
    // ================================================================

    const kolom = await db.query(`
      SELECT table_name, is_nullable FROM information_schema.columns
       WHERE column_name='created_by' AND table_schema='public'
       ORDER BY table_name
    `);
    const tabel = kolom.rows.map((r) => r.table_name);
    for (const t of [
      "goods_receipt", "sales_invoice", "payment_receipt",
      "purchase_invoice", "journal_entry",
    ]) {
      ok(`${t} punya created_by NOT NULL`,
         kolom.rows.some((r) => r.table_name === t && r.is_nullable === "NO"),
         tabel.join(", "));
    }

    const kosong = await satu(`
      SELECT (SELECT COUNT(*) FROM goods_receipt    WHERE created_by IS NULL)
           + (SELECT COUNT(*) FROM sales_invoice    WHERE created_by IS NULL)
           + (SELECT COUNT(*) FROM payment_receipt  WHERE created_by IS NULL)
           + (SELECT COUNT(*) FROM purchase_invoice WHERE created_by IS NULL)
           + (SELECT COUNT(*) FROM journal_entry    WHERE created_by IS NULL) AS n
    `);
    eq("tidak ada dokumen tanpa pembuat", kosong.n, 0);

    // ================================================================
    console.log("\n--- 10. Jalur pengguna sistem untuk skrip ---");
    // ================================================================

    /*
     * Jalur ini ada supaya skrip bisa memanggil server action tanpa
     * melonggarkan apa pun untuk HTTP. Dua sifatnya dikunci di sini.
     */
    const { penggunaSistem, lupakanPenggunaSistem } = await import(
      "../lib/auth/sistem"
    );

    delete process.env.TERA_SKRIP;
    lupakanPenggunaSistem();
    ok(
      "tanpa penanda TERA_SKRIP, jalur sistem tidak memberi siapa pun",
      (await penggunaSistem()) === null
    );

    process.env.TERA_SKRIP = "1";
    lupakanPenggunaSistem();
    const sistem = await penggunaSistem();
    ok(
      "dengan penanda dan tanpa konteks permintaan, jalur sistem aktif",
      sistem?.email === "sistem@tera.local",
      String(sistem?.email)
    );
    eq("pengguna sistem berperan pengawas", sistem?.peran, "pengawas");
    delete process.env.TERA_SKRIP;
    lupakanPenggunaSistem();

    /*
     * Sifat yang paling penting sudah diuji di bagian 2 dan 3: server
     * yang sedang berjalan TIDAK punya penanda itu, dan cookie palsu
     * tetap ditolak. Kalau jalur sistem bisa dicapai dari HTTP, kedua
     * bagian itu yang akan gagal lebih dulu.
     */
    const dokumenSistem = await satu(`
      SELECT COUNT(*)::int AS n FROM goods_receipt g
      JOIN app_user u ON u.id = g.created_by WHERE u.is_system
    `);
    console.log(
      `    ${dokumenSistem.n} penerimaan diatribusikan ke akun sistem (dibuat skrip)`
    );

    // ================================================================
    console.log("\n--- 11. Role asisten tidak bisa membaca kredensial ---");
    // ================================================================

    const roUrl = process.env.READONLY_DATABASE_URL;
    if (!roUrl) {
      ok("READONLY_DATABASE_URL tersedia", false, "belum diatur");
    } else {
      const ro = new Client({ connectionString: roUrl });
      await ro.connect();
      try {
        const cobaBaca = async (label: string, sql: string) => {
          try {
            await ro.query(sql);
            ok(label, false, "berhasil dibaca, seharusnya ditolak");
          } catch (e) {
            const pesan = e instanceof Error ? e.message : String(e);
            ok(label, /permission denied|ditolak/i.test(pesan), pesan.slice(0, 90));
          }
        };
        await cobaBaca("tera_readonly tidak bisa membaca app_user", "SELECT * FROM app_user");
        await cobaBaca(
          "tera_readonly tidak bisa membaca user_session",
          "SELECT * FROM user_session"
        );

        const stok = await ro.query(`SELECT COUNT(*) AS n FROM v_stock_balance`);
        ok("tera_readonly masih bisa membaca data operasional", Number(stok.rows[0].n) >= 0);

        try {
          await ro.query(`INSERT INTO audit_log (action, outcome) VALUES ('palsu','BERHASIL')`);
          ok("tera_readonly tidak bisa menulis audit_log", false, "berhasil menulis");
        } catch (e) {
          ok(
            "tera_readonly tidak bisa menulis audit_log",
            /permission denied|read-only/i.test(e instanceof Error ? e.message : String(e))
          );
        }
      } finally {
        await ro.end();
      }
    }
  } finally {
    await db.end();
  }

  console.log(gagal === 0 ? "\n✓ Semua tes lolos." : `\n✗ ${gagal} tes gagal.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
