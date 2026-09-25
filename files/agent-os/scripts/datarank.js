/**
 * Machine Data Ranking en ligne de commande.
 *   node scripts/datarank.js --topic "Tallest Building in Every Country" --duration 300 [--voice Graham] [--image gpt25|qwen21]
 *   node scripts/datarank.js --run <id> [--reset <étape>] [--until <étape>]      → reprise / relance d'une étape
 */
const dr = require("../lib/machines/datarank");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
(async () => {
  let run;
  if (opt("--run")) { run = dr.getRun(opt("--run")); if (!run) throw new Error("run introuvable"); if (opt("--reset")) dr.resetFrom(run, opt("--reset")); }
  else run = dr.createRun({ topic: opt("--topic"), durationSec: Number(opt("--duration", 300)), voice: opt("--voice"), imageModel: opt("--image") });
  console.log("RUN", run.id);
  const r = await dr.advance(run.id, { until: opt("--until") });
  console.log("STATUS", r.status, JSON.stringify(r.cost));
})().catch((e) => { console.error("ÉCHEC :", e.message); process.exit(1); });
