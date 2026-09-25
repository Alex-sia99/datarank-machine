/**
 * Labo « carrousel » — analyse DÉDIÉE aux niches data/ranking (cartes qui défilent de droite à gauche).
 * S'appuie sur les images déjà extraites par le Labo de niche (output/lab/<chaîne>/<videoId>/frames, 1 image / 2 s)
 * et sur le transcript (json3). Trois passes Qwen par vidéo :
 *   A. MISE EN PAGE (Qwen 3.7 Flash, 6 images) : intro, carte (rangées de haut en bas, couleurs), badge de rang,
 *      nature des images (portrait/photo/logo/illustration/détourage), format des valeurs, fond, cartes visibles…
 *   B. VITESSE (Qwen 3.7 Flash, 1 image / 10 s) : rang/nom de la carte la plus au centre → secondes par carte mesurées.
 *   C. VOIX OFF (Qwen 3.7 Plus, texte) : présence, script d'intro, gabarit de phrase par carte, outro, mots par carte.
 * Résultats : data/lab/carousel/<videoId>.json ; agrégat : --digest.
 *
 *   node scripts/carousel-lab.js --niche "Data Ranking"      → toutes les vidéos décortiquées de la niche (reprenable)
 *   node scripts/carousel-lab.js --digest --niche "Data Ranking"
 */
const fs = require("fs");
const path = require("path");
const lab = require("../lib/lab");
const bank = require("../lib/bank");
const spend = require("../lib/spend");
const { DATA_DIR, ensureDir, readJSON, writeJSON } = require("../lib/store");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(DATA_DIR, "lab", "carousel");
ensureDir(OUT);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const img = (file) => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + fs.readFileSync(file).toString("base64") } });
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;

function framesOf(r) {
  const dir = path.join(ROOT, r.dir, "frames");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^f-\d+\.jpg$/.test(f)).sort().map((f, i) => ({ t: i * 2, file: path.join(dir, f) }));
}
function transcriptText(r) {
  if (r.transcript && r.transcript.text) return r.transcript.text;
  const dir = path.join(ROOT, r.dir);
  const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => /^subs\..*json3$/.test(x));
  if (!f) return "";
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return (j.events || []).filter((e) => e.segs).map((e) => e.segs.map((s) => s.utf8).join("")).join(" ").replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

async function passLayout(r, frames) {
  const dur = frames.length * 2;
  const pick = [2, 8, 16, dur * 0.3, dur * 0.55, dur * 0.8, dur - 8].map((t) => frames.reduce((a, f) => (Math.abs(f.t - t) < Math.abs(a.t - t) ? f : a), frames[0]));
  const uniq = [...new Map(pick.map((f) => [f.file, f])).values()];
  const content = [
    { type: "text", text: [
      `Vidéo YouTube « ${r.meta.title} » (${fmt(dur)}). Format : carrousel de cartes data/ranking qui défilent.`,
      `Voici ${uniq.length} images aux instants ${uniq.map((f) => fmt(f.t)).join(", ")}. Décris PRÉCISÉMENT la mécanique visuelle pour qu'un développeur puisse la recréer à l'identique.`,
      "RÉPONDS UNIQUEMENT EN JSON :",
      JSON.stringify({
        intro: { seconds: "durée estimée de l'intro avant la 1re carte", type: "photo plein écran | titre animé | carte n°1 teaser | carte monde | autre", desc: "", titleBanner: "texte + couleurs + position du bandeau titre", subscribe: "animation s'abonner ? où ?" },
        card: {
          widthPctOfFrame: "largeur d'une carte en % de la largeur de l'image", heightPctOfFrame: "", visibleCards: "nombre de cartes visibles en même temps", gapPx: "espacement entre cartes (0 si collées)",
          rows: [{ order: 1, content: "ex. badge rang / nom / image / pays / drapeau / valeur / libellé unité / logo / année", heightPct: "% de la hauteur de la carte", bg: "#couleur", text: "#couleur, graisse, casse" }],
          rankBadge: "position, couleurs, forme — ou absent", imageKind: "photo | portrait | logo | illustration | objet détouré | drapeau", imageFit: "cover recadré | contain | détouré sur fond",
          valueFormat: "ex. « 2.3 M » gros gras + libellé « TOTAL VISITORS IN 2024/2025 » en dessous", highlight: "effet sur la carte courante (zoom, halo) ou aucun",
        },
        background: "fond derrière les cartes (couleur, dégradé, image floue…)", direction: "sens du défilement", motion: "continu à vitesse constante | par à-coups | autre",
        order: "croissant | décroissant | chronologique | alphabétique — ce que montre la séquence des rangs/valeurs", extras: "compteur, barre de progression, carte, musique visible…", palette: ["#hex"], fonts: "style des polices", outro: "fin de vidéo",
      }),
    ].join("\n") },
    ...uniq.flatMap((f) => [{ type: "text", text: `Image à ${fmt(f.t)} :` }, img(f.file)]),
  ];
  return lab.askVision(content, { model: lab.VISION_MODEL });
}

async function passSpeed(r, frames) {
  const sample = frames.filter((f) => f.t % 10 === 0 && f.t > 0);
  const out = [];
  let cost = 0;
  for (let i = 0; i < sample.length; i += 16) {
    const part = sample.slice(i, i + 16);
    const content = [
      { type: "text", text: [
        `Vidéo « ${r.meta.title} » : carrousel de cartes qui défilent. Pour CHAQUE image, lis la carte la plus proche du CENTRE horizontal de l'image :`,
        "son numéro de rang s'il est affiché (badge), sinon null ; son nom (texte principal) ; et le nombre de cartes visibles (même partiellement).",
        'Si c\'est l\'intro/l\'outro sans carte, mets "phase":"intro" ou "outro".',
        'RÉPONDS UNIQUEMENT EN JSON : {"frames":[{"t":"mm:ss","phase":"cards|intro|outro","rank":null,"name":"","visible":0}]}',
      ].join("\n") },
      ...part.flatMap((f) => [{ type: "text", text: `Image ${fmt(f.t)} :` }, img(f.file)]),
    ];
    try {
      let res;
      for (let a = 1; ; a++) { try { res = await lab.askVision(content, { model: lab.VISION_MODEL }); break; } catch (e) { if (a >= 3) throw e; await new Promise((ok) => setTimeout(ok, 5000 * a)); } }
      const { json, cost: c } = res;
      cost += c;
      (json.frames || []).forEach((x, k) => out.push({ ...x, t: part[k] ? part[k].t : null }));
    } catch (e) { out.push({ error: e.message }); }
  }
  // secondes par carte : on compte les changements de nom au centre sur la phase « cards »
  const cards = out.filter((x) => x.phase === "cards" && x.name);
  let changes = 0;
  for (let k = 1; k < cards.length; k++) if (String(cards[k].name).toLowerCase() !== String(cards[k - 1].name).toLowerCase()) changes++;
  const span = cards.length > 1 ? cards[cards.length - 1].t - cards[0].t : 0;
  const ranks = cards.filter((x) => Number.isFinite(Number(x.rank)) && x.rank !== null).map((x) => ({ t: x.t, rank: Number(x.rank) }));
  let secPerCardRank = null;
  if (ranks.length > 3) {
    const a = ranks[0], b = ranks[ranks.length - 1];
    if (a.rank !== b.rank) secPerCardRank = +((b.t - a.t) / Math.abs(b.rank - a.rank)).toFixed(2);
  }
  const firstCard = cards[0] ? cards[0].t : null;
  return {
    frames: out, cost,
    secPerCard: secPerCardRank || (changes ? +(span / changes).toFixed(2) : null),
    secPerCardByNames: changes ? +(span / changes).toFixed(2) : null, secPerCardByRank: secPerCardRank,
    firstCardAt: firstCard, rankDirection: ranks.length > 1 ? (ranks[ranks.length - 1].rank < ranks[0].rank ? "countdown" : "countup") : null,
    visibleMedian: cards.map((x) => Number(x.visible) || 0).sort((p, q) => p - q)[Math.floor(cards.length / 2)] || null,
  };
}

async function passVoice(r, text) {
  if (!text || text.split(/\s+/).length < 40) return { json: { hasVoice: false }, cost: 0 };
  const words = text.split(/\s+/).length;
  const prompt = [
    `Transcript automatique (sous-titres YouTube) de la vidéo « ${r.meta.title} » (${fmt(r.meta.duration || 0)}, ${words} mots). Format : carrousel de cartes data/ranking, une carte après l'autre.`,
    "Analyse la VOIX OFF pour qu'on puisse l'imiter. RÉPONDS UNIQUEMENT EN JSON :",
    JSON.stringify({
      hasVoice: true, voiceStyle: "TTS neutre / humain, ton, débit", intro: { text: "le script d'intro exact (nettoyé)", words: 0, structure: "ex. salut + sujet + critère + appel à s'abonner" },
      perItem: { template: "gabarit de la phrase type par carte, ex. « [Nom] in [lieu], [verbe] [valeur] [unité], is [fait marquant] »", avgWords: 0, examples: ["3 phrases réelles nettoyées"], verbsVariety: ["liste des verbes/tournures qui varient d'une carte à l'autre"], factType: "nature du fait marquant ajouté" },
      transitions: "phrases de relance/rétention entre cartes (ex. « now we enter the top 10 ») — citer", outro: "script de fin", itemsCount: "nombre de cartes commentées", notes: "ce qui rend la voix efficace",
    }),
    "TRANSCRIPT :", text.slice(0, 24000),
  ].join("\n");
  return lab.askVision([{ type: "text", text: prompt }], { model: lab.TEXT_MODEL, timeoutMs: 8 * 60 * 1000 });
}

async function analyze(videoId, { force = false } = {}) {
  const file = path.join(OUT, `${videoId}.json`);
  const prev = readJSON(`lab/carousel/${videoId}.json`, null);
  if (prev && prev.done && !force) return prev;
  const r = lab.videoResult(videoId);
  if (!r || !r.dir) throw new Error("vidéo pas encore décortiquée par le Labo");
  const frames = framesOf(r);
  if (frames.length < 10) throw new Error("images absentes");
  const res = prev || { videoId, title: r.meta.title, channel: r.meta.channel, views: r.meta.views, duration: r.meta.duration || frames.length * 2, cost: 0 };
  if (!res.layout) { const { json, cost } = await passLayout(r, frames); res.layout = json; res.cost += cost; writeJSON(`lab/carousel/${videoId}.json`, res); }
  if (!res.speed) { const s = await passSpeed(r, frames); res.cost += s.cost; delete s.cost; res.speed = s; writeJSON(`lab/carousel/${videoId}.json`, res); }
  if (!res.voice) { const { json, cost } = await passVoice(r, transcriptText(r)); res.voice = json; res.cost += cost; }
  res.done = true;
  res.cost = +res.cost.toFixed(4);
  writeJSON(`lab/carousel/${videoId}.json`, res);
  spend.record("OpenRouter", "Labo de niche", res.cost, "USD", `Qwen — analyse carrousel (${videoId})`);
  return res;
}

function nicheVideoIds(nicheName) {
  const n = bank.niches().find((x) => x.name.toLowerCase() === nicheName.toLowerCase());
  if (!n) throw new Error("Niche introuvable : " + nicheName);
  const d = lab.nicheDigest(n.id);
  return d.channels.flatMap((c) => c.deep || []).map((v) => (typeof v === "string" ? v : v.videoId));
}

(async () => {
  const niche = opt("--niche", "Data Ranking");
  if (has("--digest")) {
    const all = fs.readdirSync(OUT).map((f) => readJSON(`lab/carousel/${f}`, null)).filter((x) => x && x.done);
    const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };
    console.log(JSON.stringify({
      videos: all.length,
      secPerCardMedian: med(all.map((x) => x.speed && x.speed.secPerCard)),
      firstCardAtMedian: med(all.map((x) => x.speed && x.speed.firstCardAt)),
      visibleMedian: med(all.map((x) => x.speed && x.speed.visibleMedian)),
      withVoice: all.filter((x) => x.voice && x.voice.hasVoice).length,
      perItemWordsMedian: med(all.map((x) => x.voice && x.voice.perItem && Number(x.voice.perItem.avgWords))),
      directions: all.map((x) => x.speed && x.speed.rankDirection).filter(Boolean).reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {}),
      list: all.map((x) => ({ id: x.videoId, ch: x.channel, views: x.views, title: x.title, spc: x.speed && x.speed.secPerCard, vis: x.speed && x.speed.visibleMedian, voice: !!(x.voice && x.voice.hasVoice), tpl: x.voice && x.voice.perItem && x.voice.perItem.template })),
    }, null, 1));
    return;
  }
  const ids = has("--video") ? [opt("--video")] : nicheVideoIds(niche);
  console.log(`${ids.length} vidéos à analyser`);
  const queue = ids.slice();
  let done = 0, total = 0;
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { const r = await analyze(id, { force: has("--force") }); total += r.cost || 0; done++; console.log(`✓ ${id} ${r.title.slice(0, 60)} — ${r.speed.secPerCard} s/carte, voix ${r.voice.hasVoice ? "oui" : "non"} (${r.cost} $)`); }
      catch (e) { console.log(`✗ ${id} : ${e.message}`); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  console.log(`Terminé : ${done}/${ids.length}, ${total.toFixed(3)} $`);
})().catch((e) => { console.error("ÉCHEC :", e.message); process.exit(1); });
