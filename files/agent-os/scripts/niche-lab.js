/**
 * Labo de niche en ligne de commande — scan complet de chaînes + décorticage image par image (Qwen 3.7 Flash).
 *
 *   node scripts/niche-lab.js --niche "Wealth" --deep 4 https://www.youtube.com/@Chaine1 @Chaine2 UCxxxxxxxx…
 *   node scripts/niche-lab.js --niche "Wealth" --digest          → affiche l'agrégat des mesures de la niche
 *   node scripts/niche-lab.js --video <videoId> [--channel "Nom"] → décortique UNE vidéo
 *
 * Reprenable : les chaînes/vidéos déjà analysées sont sautées. Le serveur Agent OS peut tourner en parallèle
 * (les fichiers écrits sont ceux de la Banque de Niches : data/scrap/*, data/lab/*, data/bank/niches.json).
 */
const lab = require("../lib/lab");
const bank = require("../lib/bank");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(name);
const inputs = args.filter((a, i) => !a.startsWith("--") && !["--niche", "--deep", "--video", "--channel", "--recent", "--min"].includes(args[i - 1]));

(async () => {
  const nicheName = opt("--niche", "Wealth");
  if (has("--digest")) {
    const n = bank.niches().find((x) => x.name.toLowerCase() === nicheName.toLowerCase());
    if (!n) throw new Error("Niche introuvable : " + nicheName);
    const d = lab.nicheDigest(n.id);
    console.log(JSON.stringify({ niche: d.niche, measures: d.measures, channels: d.channels.map((c) => ({ title: c.title, subs: c.subscribers, videos: c.stats?.count, avg: c.stats?.avgViews, deep: c.deep.length })) }, null, 1));
    return;
  }
  if (has("--video")) {
    const r = await lab.analyzeVideo(opt("--video"), { channelName: opt("--channel", "divers"), onStep: (s) => console.log(new Date().toISOString().slice(11, 19), s) });
    console.log(JSON.stringify({ stats: r.stats, cost: r.cost, verdict: r.synthesis?.verdict }, null, 1));
    return;
  }
  if (!inputs.length) { console.error("Donne au moins une chaîne (URL, @handle ou UC…)"); process.exit(1); }
  const ids = [];
  for (const inp of inputs) {
    try {
      const c = await lab.resolveChannel(inp);
      if (!ids.includes(c.channelId)) ids.push(c.channelId);
      console.log(`✓ ${inp} → ${c.channelId} ${c.title} (${c.subscribers} abonnés, ${c.videoCount} vidéos)`);
    } catch (e) { console.error(`✗ ${inp} : ${e.message}`); }
  }
  const deep = Number(opt("--deep", 4));
  const recent = Number(opt("--recent", 0));
  const minDuration = Number(opt("--min", 240));
  console.log(`\nScan de ${ids.length} chaînes → niche « ${nicheName} », ${deep} vidéos décortiquées par chaîne (les ${deep - 1} plus vues + la plus récente)\n`);
  const t0 = Date.now();
  const res = await lab.scanNiche(nicheName, ids, { deep, recent, minDuration, onStep: () => {} });
  for (const c of res.channels) {
    if (c.error) console.log(`✗ ${c.channelId} : ${c.error}`);
    else console.log(`✓ ${c.title} — ${c.videos.length} vidéos listées, ${(c.deep || []).length} décortiquées${c.deepErrors ? " (" + Object.keys(c.deepErrors).length + " échecs)" : ""}`);
  }
  console.log(`\nTerminé en ${Math.round((Date.now() - t0) / 60000)} min. Agrégat : node scripts/niche-lab.js --niche "${nicheName}" --digest`);
})().catch((e) => { console.error("ÉCHEC :", e.message); process.exit(1); });
