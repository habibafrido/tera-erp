import { reset, start, stop } from "./pgctl";

const cmd = process.argv[2] ?? "start";

(async () => {
  if (cmd === "start") await start();
  else if (cmd === "stop") stop();
  else if (cmd === "reset") reset();
  else throw new Error(`Perintah tidak dikenal: ${cmd}. Pakai start | stop | reset.`);
})().catch((e) => {
  console.error("\n✗ " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
