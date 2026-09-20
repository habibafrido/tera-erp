import { penggunaUntukApi } from "@/lib/auth/penjaga";
import { catat } from "@/lib/auth/jejak";
import { systemPrompt } from "@/lib/ai/prompt";
import { buatCacheGiliran } from "@/lib/ai/cache";
import { runTool, toolSchemas } from "@/lib/ai/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Batas yang menjaga biaya dan waktu tanggap tetap terduga. */
const MAKS_PUTARAN = 5;

/** Percobaan ulang per putaran saat aliran terputus sebelum mengirim apa pun. */
const MAKS_COBA_PUTARAN = 3;
const MAKS_RIWAYAT = 12;
const MAKS_PANJANG_PESAN = 4000;
/**
 * Timeout PER PANGGILAN, bukan untuk seluruh loop.
 *
 * Versi pertama memasang satu timer untuk seluruh putaran, sehingga
 * pertanyaan yang butuh beberapa putaran terpotong di tengah jalan meski
 * tiap panggilannya sendiri sehat. Model penalar seperti deepseek-v4-flash
 * mengalirkan rantai pikir panjang sebelum huruf pertama jawaban muncul,
 * jadi anggaran waktunya memang harus per panggilan.
 */
const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 120_000);

type Peran = "user" | "assistant";
type PesanMasuk = { role: Peran; content: string };

type PesanOR = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * Kejadian yang dialirkan ke klien sebagai NDJSON. Satu baris satu objek.
 *
 * Pemanggilan alat sengaja ikut dikirim, bukan disembunyikan: pengguna
 * keuangan harus bisa melihat angka yang disebut berasal dari alat mana
 * dengan parameter apa.
 */
type Kejadian =
  | { t: "tool_call"; id: string; nama: string; args: unknown }
  | { t: "tool_result"; id: string; nama: string; ok: boolean; cache?: boolean; meta?: unknown; rows?: unknown[]; error?: string }
  | { t: "delta"; teks: string }
  | { t: "galat"; pesan: string }
  | { t: "berpikir"; n: number }
  | { t: "selesai"; putaran: number };

function baris(k: Kejadian) {
  return new TextEncoder().encode(JSON.stringify(k) + "\n");
}

/**
 * Tingkat penalaran yang diminta dari model.
 *
 * deepseek-v4-flash menyalakan penalaran secara bawaan pada tingkat
 * "high" (lihat supported_efforts di katalog OpenRouter: max, high, low).
 * Untuk asisten ERP yang tugasnya memilih satu alat lalu merangkai
 * kalimat, penalaran sedalam itu hanya menambah detik tanpa menambah
 * ketepatan — angkanya toh dihitung database, bukan oleh model.
 *
 * "default" atau "bawaan" berarti parameter ini tidak dikirim sama sekali,
 * sehingga model memakai tingkat bawaannya.
 */
function paramPenalaran(): Record<string, unknown> {
  const e = (process.env.OPENROUTER_REASONING_EFFORT || "low").trim();
  if (e === "default" || e === "bawaan") return {};
  return { reasoning: { effort: e } };
}

/** Daftar model cadangan, dipisah koma. Boleh kosong. */
function modelCadangan(): string[] {
  return (process.env.OPENROUTER_FALLBACK_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pesan galat yang bisa dibaca pengguna, bukan stack trace.
 *
 * Satu pesan pengguna bisa memakai sampai lima panggilan API karena loop
 * tool calling, jadi batas harian model gratis bisa tercapai jauh lebih
 * cepat daripada yang diduga dari jumlah percakapan.
 */
function pesanGalat(status: number, body: string, model: string): string {
  const gratis = model.endsWith(":free");
  const saran =
    "Ganti OPENROUTER_MODEL di .env.local ke model lain — " +
    "misalnya varian berbayar dari model yang sama, atau model gratis lain " +
    "yang mendukung tool calling.";

  if (status === 401 || status === 403) {
    return "Kunci OpenRouter ditolak. Periksa OPENROUTER_API_KEY di .env.local.";
  }
  if (status === 402) {
    return gratis
      ? "OpenRouter menolak permintaan karena saldo tidak cukup, padahal model " +
        `yang dipilih (${model}) seharusnya gratis. Salah satu model cadangan ` +
        "kemungkinan berbayar. Periksa OPENROUTER_FALLBACK_MODELS."
      : `Saldo OpenRouter tidak cukup untuk model berbayar ${model}. ` +
        "Isi saldo, atau pakai model dengan akhiran :free. " + saran;
  }
  if (status === 429) {
    return gratis
      ? `Batas harian model gratis ${model} sudah tercapai. ` +
        "Satu pertanyaan bisa memakai beberapa panggilan API karena asisten " +
        "memanggil alat berkali-kali, jadi batas ini cepat habis. " +
        "Tunggu sampai kuota harian berganti, atau " + saran.toLowerCase()
      : "Terlalu banyak permintaan ke OpenRouter. Tunggu sebentar lalu coba lagi.";
  }
  if (status === 404) {
    return (
      "Model tidak ditemukan di OpenRouter. Periksa nilai OPENROUTER_MODEL — " +
      "model harus ada dan mendukung tool calling."
    );
  }
  if (status >= 500) {
    return "OpenRouter sedang bermasalah. Coba lagi sebentar lagi.";
  }
  console.error("[api/chat] OpenRouter", status, body.slice(0, 500));
  return `Panggilan ke OpenRouter gagal (HTTP ${status}).`;
}

async function panggilModel(
  messages: PesanOR[],
  model: string,
  key: string,
  signal: AbortSignal
): Promise<Response> {
  // Sinyal gabungan: batal dari klien ATAU timeout panggilan ini sendiri.
  const sinyal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);

  const referer = process.env.OPENROUTER_SITE_URL || "http://localhost:3000";
  const title = process.env.OPENROUTER_SITE_NAME || "Tera ERP";

  const cadangan = modelCadangan();

  return fetch(ENDPOINT, {
    method: "POST",
    signal: sinyal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Dua header ini didokumentasikan OpenRouter untuk atribusi aplikasi.
      "HTTP-Referer": referer,
      "X-Title": title,
    },
    body: JSON.stringify({
      model,
      // Parameter "models" milik OpenRouter: dicoba berurutan kalau model
      // utama sedang tidak tersedia atau kena batas. Endpoint gratis cukup
      // sering tidak tersedia, jadi ini bukan kemewahan.
      ...(cadangan.length ? { models: [model, ...cadangan] } : {}),
      ...paramPenalaran(),
      messages,
      tools: toolSchemas(),
      tool_choice: "auto",
      stream: true,
      temperature: 0,
    }),
  });
}

/**
 * Membaca aliran SSE satu putaran, mengalirkan teks ke klien apa adanya,
 * dan mengumpulkan tool_calls yang datang sepotong-sepotong.
 */
async function bacaPutaran(
  res: Response,
  kirim: (k: Kejadian) => void
): Promise<{ teks: string; toolCalls: ToolCall[]; terputus: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();

  let sisa = "";
  let teks = "";
  let berpikir = 0;
  let terputus = false;
  const calls = new Map<number, ToolCall>();

  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sisa += dec.decode(value, { stream: true });

    const potongan = sisa.split("\n");
    sisa = potongan.pop() ?? "";

    for (const p of potongan) {
      const t = p.trim();
      if (!t.startsWith("data:")) continue;
      const isi = t.slice(5).trim();
      if (isi === "" || isi === "[DONE]") continue;

      let j: {
        choices?: {
          delta?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      try {
        j = JSON.parse(isi);
      } catch {
        continue; // baris komentar keep-alive
      }

      const d = j.choices?.[0]?.delta;
      if (!d) continue;

      /**
       * Model penalar seperti deepseek-v4-flash mengalirkan rantai pikirnya
       * di field terpisah, bukan di content. Diperiksa langsung pada
       * responsnya: OpenRouter menormalkan ke `reasoning` (dan `reasoning_details`),
       * sementara sebagian provider lain memakai `reasoning_content`.
       *
       * Isinya TIDAK PERNAH masuk ke jawaban — itu catatan kerja model,
       * bukan kalimat untuk pengguna, dan sering berbahasa Inggris.
       * Yang dikirim ke klien hanya isyarat bahwa model sedang berpikir,
       * supaya panel tidak terlihat menggantung selama belum ada teks.
       *
       * Perhatikan juga: selama menalar, provider ini mengirim
       * `content: ""` — string kosong, bukan undefined. Pemeriksaan
       * `if (d.content)` di bawah sengaja falsy-check, jadi string kosong
       * tidak ikut tercatat sebagai jawaban.
       */
      const nalar = d.reasoning ?? d.reasoning_content;
      if (nalar) {
        berpikir += nalar.length;
        kirim({ t: "berpikir", n: berpikir });
      }

      if (d.content) {
        teks += d.content;
        kirim({ t: "delta", teks: d.content });
      }

      for (const tc of d.tool_calls ?? []) {
        const ada = calls.get(tc.index) ?? {
          id: "", type: "function" as const, function: { name: "", arguments: "" },
        };
        if (tc.id) ada.id = tc.id;
        if (tc.function?.name) ada.function.name += tc.function.name;
        if (tc.function?.arguments) ada.function.arguments += tc.function.arguments;
        calls.set(tc.index, ada);
      }
    }
  }

  } catch (e) {
    /**
     * Endpoint gratis cukup sering memutus koneksi di tengah aliran
     * (TypeError: terminated / ECONNRESET). Itu bukan galat logika dan
     * bukan penolakan model, jadi tidak dilempar ke atas — pemanggil yang
     * memutuskan apakah putaran ini layak diulang.
     */
    if ((e as { name?: string })?.name === "TimeoutError") throw e;
    terputus = true;
    console.error("[api/chat] aliran terputus:", (e as Error)?.message);
  }

  return { teks, toolCalls: [...calls.values()], terputus };
}

/**
 * Route handler diperiksa TERPISAH dari middleware.
 *
 * Middleware hanya tahu ada-tidaknya cookie; ia tidak bisa menyentuh
 * database dari runtime Edge. Cookie palsu berisi teks apa pun lolos
 * dari sana dan berhenti di sini.
 */
export async function POST(req: Request) {
  const pengguna = await penggunaUntukApi("asisten.tanya");
  if (!pengguna) {
    return Response.json(
      { error: "Sesi tidak ditemukan atau peran tidak berwenang." },
      { status: 401 }
    );
  }

  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;

  if (!key) {
    return Response.json(
      { error: "OPENROUTER_API_KEY belum diatur di server. Chat belum aktif." },
      { status: 503 }
    );
  }
  if (!model) {
    return Response.json(
      { error: "OPENROUTER_MODEL belum diatur di server." },
      { status: 503 }
    );
  }

  let body: { messages?: PesanMasuk[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Isi permintaan tidak sah." }, { status: 400 });
  }

  const masuk = Array.isArray(body.messages) ? body.messages : [];
  if (masuk.length === 0) {
    return Response.json({ error: "Tidak ada pesan." }, { status: 400 });
  }

  // Riwayat dipangkas dari belakang dan tiap pesan dipotong panjangnya.
  const riwayat: PesanOR[] = masuk
    .slice(-MAKS_RIWAYAT)
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAKS_PANJANG_PESAN) }));

  const messages: PesanOR[] = [{ role: "system", content: systemPrompt() }, ...riwayat];

  /*
   * Pertanyaan terakhir ikut dicatat, dipotong pendek.
   *
   * Asisten membaca database lewat role baca-saja, jadi ia tidak bisa
   * mengubah apa pun — tetapi ia BISA merangkum data yang tidak akan
   * pernah dibuka orang itu satu per satu lewat halaman. Jejaknya karena
   * itu tetap diperlukan, dan yang dicatat pertanyaannya, bukan
   * jawabannya: jawaban bisa panjang sekali dan isinya sudah ada di
   * database.
   */
  await catat({
    aksi: "asisten.tanya",
    hasil: "BERHASIL",
    pengguna,
    detail: { pertanyaan: (riwayat[riwayat.length - 1]?.content ?? "").slice(0, 500) },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const kirim = (k: Kejadian) => {
        try {
          controller.enqueue(baris(k));
        } catch {
          // Klien menutup koneksi; putaran berikutnya akan berhenti sendiri.
        }
      };

      // Batal dari klien menghentikan panggilan yang sedang berjalan.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      req.signal.addEventListener("abort", onAbort);

      // Dihitung untuk dilaporkan ke klien: satu pesan pengguna bisa
      // memakai beberapa panggilan API karena loop tool calling.
      let dipakai = 0;

      /**
       * Cache alat, hidup HANYA selama satu giliran ini.
       *
       * Model kadang memanggil alat yang sama dengan parameter identik dua
       * kali dalam satu giliran — sekali untuk memeriksa, sekali untuk
       * menyusun jawaban. Kueri kedua tidak menambah informasi apa pun.
       *
       * Sengaja tidak dipertahankan antar giliran: data ERP berubah saat
       * dokumen diposting, dan jawaban basi di sini lebih berbahaya
       * daripada satu kueri tambahan.
       */
      const cache = buatCacheGiliran<Awaited<ReturnType<typeof runTool>>>();

      try {
        for (let putaran = 1; putaran <= MAKS_PUTARAN; putaran++) {
          let teks = "";
          let toolCalls: ToolCall[] = [];

          /**
           * Percobaan ulang HANYA aman selama putaran ini belum
           * mengirimkan apa pun ke klien: teks yang sudah mengalir tidak
           * bisa ditarik kembali, dan mengulang akan menggandakannya.
           * Alat semuanya baca-saja, jadi menjalankannya lagi tidak
           * menimbulkan efek samping.
           */
          for (let coba = 1; ; coba++) {
            dipakai++;
            const res = await panggilModel(messages, model, key, ac.signal);

            if (!res.ok || !res.body) {
              const body = await res.text().catch(() => "");
              kirim({ t: "galat", pesan: pesanGalat(res.status, body, model) });
              return;
            }

            const hasil = await bacaPutaran(res, kirim);
            teks = hasil.teks;
            toolCalls = hasil.toolCalls;

            if (!hasil.terputus) break;

            const belumMengirim = teks === "" && toolCalls.length === 0;
            if (belumMengirim && coba < MAKS_COBA_PUTARAN) continue;

            kirim({
              t: "galat",
              pesan:
                "Koneksi ke OpenRouter terputus di tengah jawaban. " +
                (model.endsWith(":free")
                  ? "Endpoint gratis memang sering memutus sambungan saat sedang ramai. "
                  : "") +
                "Coba tanyakan lagi.",
            });
            return;
          }

          // Tidak ada alat yang diminta: jawaban akhir sudah mengalir keluar.
          if (toolCalls.length === 0) return;

          messages.push({ role: "assistant", content: teks || null, tool_calls: toolCalls });

          for (const tc of toolCalls) {
            let args: Record<string, unknown> = {};
            let argsRusak = false;
            try {
              args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
              argsRusak = true;
            }

            kirim({ t: "tool_call", id: tc.id, nama: tc.function.name, args });

            const kunci = argsRusak ? null : cache.kunci(tc.function.name, args);
            const tersimpan = kunci ? cache.ambil(kunci) : undefined;
            const dariCache = tersimpan !== undefined;

            const hasil = argsRusak
              ? { ok: false as const, error: "Parameter tidak bisa dibaca sebagai JSON." }
              : (tersimpan ?? (await runTool(tc.function.name, args)));

            // Hasil yang gagal tidak disimpan: parameternya mungkin diperbaiki
            // model pada percobaan berikutnya, dan galat tidak layak diulang.
            if (kunci && !dariCache && hasil.ok) cache.simpan(kunci, hasil);

            // Panggilan yang kena cache TETAP muncul di jejak, ditandai,
            // supaya audit "angka ini dari mana" tidak berlubang.
            kirim(
              hasil.ok
                ? { t: "tool_result", id: tc.id, nama: tc.function.name, ok: true, cache: dariCache, meta: hasil.meta, rows: hasil.rows }
                : { t: "tool_result", id: tc.id, nama: tc.function.name, ok: false, cache: false, error: hasil.error }
            );

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(hasil),
            });
          }

          if (putaran === MAKS_PUTARAN) {
            kirim({
              t: "galat",
              pesan:
                `Pertanyaan ini butuh lebih dari ${MAKS_PUTARAN} putaran pemanggilan alat. ` +
                "Coba pecah menjadi pertanyaan yang lebih spesifik, misalnya dengan " +
                "menyebut satu barang, satu gudang, atau satu periode.",
            });
            return;
          }
        }
      } catch (e) {
        const nama = (e as { name?: string })?.name;
        const olehPengguna = req.signal.aborted;
        const kehabisanWaktu = nama === "TimeoutError" || (nama === "AbortError" && !olehPengguna);
        if (!olehPengguna && !kehabisanWaktu) console.error("[api/chat]", e);
        kirim({
          t: "galat",
          pesan: olehPengguna
            ? "Permintaan dihentikan."
            : kehabisanWaktu
              ? `Model tidak selesai menjawab dalam ${Math.round(TIMEOUT_MS / 1000)} detik. ` +
                "Model penalar bisa lama kalau pertanyaannya luas — coba persempit, " +
                "atau naikkan OPENROUTER_TIMEOUT_MS."
              : "Tidak bisa menghubungi OpenRouter. Periksa koneksi jaringan.",
        });
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        kirim({ t: "selesai", putaran: dipakai });
        try {
          controller.close();
        } catch {
          // sudah tertutup
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
