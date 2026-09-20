/**
 * Pengelola PostgreSQL bawaan project.
 *
 * Binary asli PostgreSQL ikut terpasang lewat paket @embedded-postgres.
 * Server dijalankan pakai pg_ctl, bukan spawn langsung, supaya prosesnya
 * tetap hidup setelah skrip ini selesai — kalau tidak, server ikut mati
 * begitu `npm run db:migrate` kelar dan `next dev` tidak menemukan apa pun.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { loadEnv } from "./env";

const env = loadEnv();

export const USER = "postgres";
export const PASSWORD = "postgres";
export const DBNAME = new URL(env.url).pathname.replace(/^\//, "") || "smartflow";

/** Role baca-saja untuk chat AI. Lihat db/004_ai_role.sql. */
export const RO_USER = "tera_readonly";
export const RO_PASSWORD = "tera_readonly";

const EXE = process.platform === "win32" ? ".exe" : "";
const LOG = resolve(env.dataDir, "server.log");
const PW_FILE = resolve(env.root, ".pgpass.tmp");

/** Paket binary dinamai @embedded-postgres/<platform>-<arch>. */
function binDir(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const plat =
    process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";
  const dir = resolve(env.root, `node_modules/@embedded-postgres/${plat}-${arch}/native/bin`);
  if (!existsSync(dir)) {
    throw new Error(
      `Binary PostgreSQL tidak ditemukan di ${dir}.\n` +
        "Jalankan `npm install` dulu agar paket @embedded-postgres terunduh."
    );
  }
  return dir;
}

function bin(name: string) {
  return resolve(binDir(), name + EXE);
}

/**
 * `detach: true` menjalankan perintah tanpa pipe sama sekali.
 *
 * Wajib untuk `pg_ctl start`: server yang dinyalakan mewarisi handle stdout
 * dari pg_ctl, dan spawnSync menunggu pipe itu tertutup — padahal server
 * memang sengaja terus hidup. Tanpa ini perintahnya menggantung selamanya
 * meski Postgres sudah menyala dengan benar.
 */
function run(
  name: string,
  args: string[],
  opts: { quiet?: boolean; detach?: boolean } = {}
) {
  const r = spawnSync(bin(name), args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: opts.detach ? "ignore" : "pipe",
    env: { ...process.env, PGPASSWORD: PASSWORD },
  });
  if (r.status !== 0 && !opts.quiet) {
    const detail = opts.detach ? tailLog() : `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    throw new Error(`${name} gagal (kode ${r.status}):\n${detail}`);
  }
  return r;
}

/** Kalau stdio diabaikan, keterangan galat hanya tersisa di log server. */
function tailLog(): string {
  try {
    return readFileSync(LOG, "utf8").split(/\r?\n/).slice(-20).join("\n");
  } catch {
    return "(tidak ada .pgdata/server.log)";
  }
}

/** pg_ctl status: 0 = jalan, 3 = berhenti, 4 = data dir tidak sah. */
function isRunning(): boolean {
  if (!existsSync(resolve(env.dataDir, "PG_VERSION"))) return false;
  return run("pg_ctl", ["status", "-D", env.dataDir], { quiet: true }).status === 0;
}

function initCluster() {
  if (existsSync(resolve(env.dataDir, "PG_VERSION"))) return;
  console.log("→ Menyiapkan cluster PostgreSQL di .pgdata (sekali saja)…");
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(PW_FILE, PASSWORD, "utf8");
  try {
    run("initdb", [
      "-D", env.dataDir,
      "-U", USER,
      `--pwfile=${PW_FILE}`,
      "--encoding=UTF8",
      "--locale=C",
      "-A", "scram-sha-256",
    ]);
  } finally {
    rmSync(PW_FILE, { force: true });
  }
}

function client(database: string) {
  return new Client({
    host: "127.0.0.1",
    port: env.port,
    user: USER,
    password: PASSWORD,
    database,
  });
}

async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const c = client("postgres");
    try {
      await c.connect();
      await c.end();
      return;
    } catch (e) {
      last = e;
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`Postgres tidak siap dalam ${timeoutMs / 1000}s. Terakhir: ${last}`);
}

/**
 * Role baca-saja untuk chat AI. Migrasi 004 juga membuatnya, tapi role
 * di PostgreSQL adalah objek se-cluster, bukan per database — dibuat di
 * sini supaya sudah ada bahkan sebelum migrasi pertama dijalankan, dan
 * supaya kata sandinya konsisten dengan READONLY_DATABASE_URL bawaan.
 */
async function ensureReadonlyRole() {
  const c = client("postgres");
  await c.connect();
  try {
    const r = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RO_USER]);
    if (r.rowCount === 0) {
      await c.query(`CREATE ROLE ${RO_USER} LOGIN PASSWORD '${RO_PASSWORD}'`);
      console.log(`→ Role ${RO_USER} dibuat.`);
    }
    // Hak SELECT-nya diberikan migrasi 004 per database; di sini cukup
    // memastikan role dan kata sandinya ada.
  } finally {
    await c.end();
  }
}

async function ensureDatabase() {
  const c = client("postgres");
  await c.connect();
  try {
    const r = await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [DBNAME]);
    if (r.rowCount === 0) {
      // CREATE DATABASE tidak menerima parameter terikat, jadi nama dari
      // DATABASE_URL dikutip sebagai identifier.
      await c.query(`CREATE DATABASE "${DBNAME.replace(/"/g, '""')}"`);
      console.log(`→ Database ${DBNAME} dibuat.`);
    }
  } finally {
    await c.end();
  }
}

/** Idempoten: aman dipanggil berkali-kali, termasuk saat server sudah hidup. */
export async function start() {
  if (!env.embedded) {
    console.log("PG_EMBEDDED=0 — memakai PostgreSQL milik sendiri, tidak ada yang dijalankan.");
    return;
  }
  if (isRunning()) {
    await ensureDatabase();
    await ensureReadonlyRole();
    console.log(`✓ PostgreSQL sudah berjalan di port ${env.port}.`);
    return;
  }
  initCluster();
  console.log(`→ Menjalankan PostgreSQL di port ${env.port}…`);
  run(
    "pg_ctl",
    ["start", "-D", env.dataDir, "-l", LOG, "-w", "-o", `-p ${env.port} -h 127.0.0.1`],
    { detach: true }
  );
  await waitReady();
  await ensureDatabase();
  await ensureReadonlyRole();
  console.log(`✓ PostgreSQL siap di port ${env.port}. Log: .pgdata/server.log`);
}

export function stop() {
  if (!env.embedded) return;
  if (!isRunning()) {
    console.log("PostgreSQL tidak sedang berjalan.");
    return;
  }
  run("pg_ctl", ["stop", "-D", env.dataDir, "-m", "fast", "-w"]);
  console.log("✓ PostgreSQL dihentikan.");
}

export function reset() {
  stop();
  rmSync(env.dataDir, { recursive: true, force: true });
  console.log("✓ .pgdata dihapus. Jalankan `npm run db:migrate` untuk mulai dari nol.");
}
