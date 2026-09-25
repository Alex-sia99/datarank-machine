/**
 * MACHINE « Data Ranking » — vidéos carrousel de la niche data/ranking (List Data, Nerd Cassette, Aesthetic Data,
 * okz data point, Rank India, Country Cassette…) : une rangée de cartes (rang, nom, image, pays + drapeau, grosse
 * valeur) qui défile de droite à gauche en ordre CROISSANT, une petite intro, et une voix off qui commente UNE
 * carte par phrase, calée sur le mouvement du carrousel.
 *
 * Recette mesurée par le Labo (docs/RECETTE-NICHE-DATARANK.md) : ~9 s par carte, ~3,5 cartes visibles, intro
 * 8-15 s (photo du n°1 en teaser + titre + s'abonner), phrase type « [Nom] in [lieu], [verbe varié] [valeur],
 * [fait marquant] » (~20 mots), écran de fin.
 *
 * Entrées : SUJET + DURÉE (+ voix, modèle d'image). Tout le reste se déduit.
 *
 * Étapes (reprenables, chacune avec son contrôle) :
 *   1. data    — Qwen construit le jeu de données (N cartes + réserves) → vérification Wikipédia/Wikidata
 *                (page réelle, valeur recoupée par la propriété Wikidata) → relecture critique Qwen → tri croissant
 *   2. script  — intro + une phrase par carte + outro (contraintes de mots, nom et valeur obligatoires, relances)
 *   3. voice   — Inworld TTS phrase par phrase (durées RÉELLES) → timeline → piste unique vo.wav ; Suno en parallèle
 *   4. assets  — drapeaux (flagcdn), portraits (Wikipédia), logos (Wikidata P154), objets/lieux recréés en
 *                détourage par GPT Image 2.5 (ou Qwen Image 2.1) à partir de la photo Wikipédia → contrôle Qwen
 *                (même objet ? texte parasite ?) → régénération ou repli photo
 *   5. render  — Remotion DataCarousel (une passe, images seules : aucun gel) + miniature DataThumb
 *   6. qa      — images du rendu relues par Qwen (lisibilité, débordements, carte commentée au point focal)
 *   7. package — titre, description avec chapitres (un par carte), tags
 */
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { DATA_DIR, ensureDir, readJSON, writeJSON } = require("../store");
const vault = require("../vault");
const fal = require("../fal");
const spend = require("../spend");
const tasks = require("../tasks");
const llm = require("../llm");
// chargé au premier usage (contrôles Qwen) : la machine démarre même si le Labo et ses dépendances manquent
const lab = new Proxy({}, { get: (_, k) => require("../lab")[k] });

const MACHINE_ID = "datarank";
const MACHINE_NAME = "Data Ranking";
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT_ROOT = path.join(__dirname, "..", "..", "output", "machines");
const REMOTION_DIR = path.join(ROOT, "remotion");
const RUNS_DIR = path.join(DATA_DIR, "machines", "runs", MACHINE_ID);
ensureDir(OUT_ROOT);
ensureDir(RUNS_DIR);
// Wikipédia/Wikidata demandent un User-Agent identifiable avec un contact : réglable par WIKI_CONTACT (e-mail ou URL)
const UA = `AgentOS-DataRanking/1.0 (${process.env.WIKI_CONTACT || "https://github.com/Alex-sia99/datarank-machine"})`;
const FPS = 30;

// ---------------------------------------------------------------- réglages (mesurés sur la niche)
const DEFAULTS = {
  language: "English",
  voice: "Craig",           // débit mesuré : Craig 147 mots/min, Oliver 158, Grant 146… Graham 109 (trop lent pour la niche)
  imageModel: "gpt25",     // gpt25 (GPT Image 2.5 flare) | qwen21 (Qwen Image 2.1)
  cutout: true,            // objets/lieux recréés en détourage (sinon photo Wikipédia brute)
  secPerCard: 9,           // niche : 8,4-11,9 s par carte (médiane ~9)
  minCardSec: 6.5,
  cardPad: 0.6,            // silence après chaque phrase
  introMinSec: 9,
  music: true,
  musicVolume: 0.07,
  musicStyle: "Light upbeat corporate documentary background music, soft piano and plucked strings, gentle modern beat, curious and positive, 100 bpm, discreet bed under narration",
  durationMin: 5,
  chainLanguage: "English",   // titre, description, tags
  publishPrivacy: "private",  // défaut PARTOUT : privée (une publique accidentelle est vécue)
  theme: {
    bg: "#0d1b2a", bg2: "#1b3a5c", name: "#8b0000", nameFg: "#ffffff", band: "#0b2a6b", bandFg: "#ffffff",
    value: "#ffffff", valueFg: "#111111", badge: "#ffd400", badgeFg: "#111111", accent: "#ffd400",
    font: "'Arial Black', 'Segoe UI Black', Impact, sans-serif",
  },
};
const IMG_MODELS = {
  gpt25: { name: "GPT Image 2.5", t2i: "gpt-image-2-5-flare-text-to-image", i2i: "gpt-image-2-5-flare-image-to-image", field: "input_urls", price: 0.03, extra: { resolution: "1K" } },
  qwen21: { name: "Qwen Image 2.1", t2i: "qwen2-1/text-to-image", i2i: "qwen2-1/image-to-image", field: "image_urls", price: 0.03, extra: { resolution: "1K", output_format: "png" } },
};
const PRICES = { ttsPer1kChars: 0.015, music: 0.06 };
const VOICE_SUFFIX = { English: "(en)", "Français": "(fr)", "Español": "(es)", Deutsch: "(de)", Italiano: "(it)" };

// ---------------------------------------------------------------- persistance
const runPath = (id) => path.join(RUNS_DIR, `${id}.json`);
function getRun(id) {
  const r = readJSON(`machines/runs/${MACHINE_ID}/${id}.json`, null);
  if (r && r.package && !r.pack) r.pack = { ...r.package, thumbRel: r.output && r.output.thumb ? `agent-os/output/machines/${r.id}/thumb.png` : null };
  if (r && r.output && r.output.rel && !r.finalRel) r.finalRel = r.output.rel;
  return r;
}
function saveRun(run) { run.updatedAt = new Date().toISOString(); writeJSON(`machines/runs/${MACHINE_ID}/${run.id}.json`, run); }
function listRuns() {
  return fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).map((f) => readJSON(`machines/runs/${MACHINE_ID}/${f}`, null)).filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function config() {
  const c = readJSON(`machines/${MACHINE_ID}.json`, {});
  return { id: MACHINE_ID, name: MACHINE_NAME, ...c, settings: { ...DEFAULTS, ...(c.settings || {}), theme: { ...DEFAULTS.theme, ...((c.settings || {}).theme || {}) } } };
}
function patchConfig(patch) {
  const c = readJSON(`machines/${MACHINE_ID}.json`, {});
  c.settings = { ...(c.settings || {}), ...(patch.settings || {}) };
  if (patch.nicheId !== undefined) c.nicheId = patch.nicheId || null;
  writeJSON(`machines/${MACHINE_ID}.json`, c);
  return config();
}
// chaque ligne est écrite sur disque tout de suite : l'interface suit la progression EN COURS d'étape
function log(run, msg) { run.log = run.log || []; run.log.push({ ts: new Date().toISOString(), msg }); console.log(`[datarank ${run.id}] ${msg}`); try { if (run.id && run.params) saveRun(run); } catch {} }
function runDir(run) { const d = path.join(OUT_ROOT, run.id); ensureDir(d); return d; }
function addCost(run, key, usd, api, note) { run.cost = run.cost || {}; run.cost[key] = +((run.cost[key] || 0) + usd).toFixed(4); if (usd > 0) spend.record(api, MACHINE_NAME, +usd.toFixed(4), "USD", note); }

// ---------------------------------------------------------------- utilitaires
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, worker, n = 6) {
  const q = items.map((it, i) => ({ it, i }));
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (q.length) { const { it, i } = q.shift(); out[i] = await worker(it, i); } }));
  return out;
}
function runBin(bin, args, { cwd, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let err = "", out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${bin} : délai dépassé`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString())); // pipe lu : jamais de gel
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${bin} : ${err.slice(-400)}`)); });
  });
}
const ffmpeg = (args, cwd) => runBin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
async function probe(file) {
  const out = await runBin("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file]);
  const d = Number(String(out).trim());
  if (!isFinite(d) || d <= 0) throw new Error("durée illisible : " + path.basename(file));
  return d;
}
async function fetchJson(url, opts = {}) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { if (a >= 3) throw e; await sleep(1500 * a); }
  }
}
async function download(url, file) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`téléchargement ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      if (fs.statSync(file).size < 200) throw new Error("fichier vide");
      return file;
    } catch (e) { if (a >= 3) throw e; await sleep(2000 * a); }
  }
}
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
async function askJson(prompt, label) { return llm.askJson(prompt, { label, timeoutMs: 10 * 60 * 1000, tries: 3 }); }

// ---------------------------------------------------------------- Kie
function kieKey() { const k = vault.get("kie"); if (!k) throw new Error("Clé Kie absente du coffre"); return k; }
async function kieCreate(model, input) {
  const r = await fetch("https://api.kie.ai/api/v1/jobs/createTask", { method: "POST", headers: { Authorization: `Bearer ${kieKey()}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input }) }).then((x) => x.json());
  if (!r.data?.taskId) throw new Error(`Kie : ${r.msg || JSON.stringify(r).slice(0, 160)}`);
  return r.data.taskId;
}
async function kiePoll(taskId, timeoutMs = 10 * 60 * 1000) {
  const t0 = Date.now();
  while (true) {
    await sleep(7000);
    if (Date.now() - t0 > timeoutMs) throw new Error("Kie : délai dépassé");
    const r = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers: { Authorization: `Bearer ${kieKey()}` } }).then((x) => x.json()).catch(() => ({}));
    if (r.data?.state === "success") return JSON.parse(r.data.resultJson).resultUrls[0];
    if (r.data?.state === "fail") throw new Error(`Kie : ${r.data?.failMsg || "génération échouée"}`);
  }
}

// ---------------------------------------------------------------- Wikipédia / Wikidata
/** Lot de titres → { title: {title, missing, desc, qid, image, disambig} } (50 par requête, redirections suivies). */
async function wikiPages(titles, size = 1000) {
  const out = {};
  for (let i = 0; i < titles.length; i += 45) {
    const part = titles.slice(i, i + 45);
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|pageprops|description&piprop=thumbnail&pithumbsize=${size}&redirects=1&format=json&titles=${encodeURIComponent(part.join("|"))}`;
    const j = await fetchJson(url);
    const alias = {};
    for (const n of j.query?.normalized || []) alias[n.to] = n.from;
    for (const r of j.query?.redirects || []) alias[r.to] = alias[r.from] || r.from;
    for (const p of Object.values(j.query?.pages || {})) {
      const orig = alias[p.title] || p.title;
      out[orig] = { title: p.title, missing: p.missing !== undefined, desc: p.description || "", qid: p.pageprops?.wikibase_item || null, image: p.thumbnail?.source || null, disambig: p.pageprops && "disambiguation" in p.pageprops };
    }
  }
  return out;
}
async function wikiSearch(q) {
  const j = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json`);
  return j.query?.search?.[0]?.title || null;
}
async function wikidataEntities(qids, props = "claims") {
  const out = {};
  for (let i = 0; i < qids.length; i += 45) {
    const j = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qids.slice(i, i + 45).join("|")}&props=${props}&format=json`);
    Object.assign(out, j.entities || {});
  }
  return out;
}
/** Valeur numérique d'une propriété Wikidata (rang préféré d'abord). */
function claimAmount(entity, prop) {
  const cl = entity?.claims?.[prop];
  if (!cl || !cl.length) return null;
  const sorted = cl.slice().sort((a, b) => (b.rank === "preferred") - (a.rank === "preferred"));
  for (const c of sorted) {
    const v = c.mainsnak?.datavalue?.value;
    if (v && v.amount != null) return { amount: Number(v.amount), unit: String(v.unit || "").split("/").pop() };
  }
  return null;
}
function claimFile(entity, prop) {
  const v = entity?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
  return typeof v === "string" ? v : null;
}
const commonsFile = (name, w = 800) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${w}`;

// ---------------------------------------------------------------- recherche ancrée : tableaux des articles « List of… »
function tablesText(html, maxChars = 60000) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const clean = (c) => c.replace(/<sup[\s\S]*?<\/sup>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const txt = tables.map((t) => [...t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => clean(c[1])).join(" | ")).filter((l) => l.replace(/[|\s]/g, "")).join("\n")).filter(Boolean).join("\n\n");
  return txt.slice(0, maxChars);
}
/** Articles de référence pour le sujet : recherche Wikipédia + titres proposés par le LLM → texte des tableaux. */
async function gatherSources(run) {
  const topic = run.params.topic;
  let guesses = [];
  try {
    const g = await llm.askJson(`For a YouTube data ranking video on "${topic}", list up to 3 EXACT English Wikipedia article titles (preferably "List of …" articles) whose tables contain the data needed. JSON ONLY: {"titles":[""]}`, { label: "Sources", tries: 2 });
    guesses = (g.titles || []).filter(Boolean).slice(0, 3);
  } catch {}
  const found = new Set();
  const pages = await wikiPages(guesses).catch(() => ({}));
  for (const g of guesses) { const p = pages[g]; if (p && !p.missing && !p.disambig) found.add(p.title); }
  if (found.size < 2) for (const q of [`List of ${topic}`, topic]) { const t = await wikiSearch(q).catch(() => null); if (t) found.add(t); }
  const out = [];
  let budget = 90000;
  for (const title of [...found].slice(0, 4)) {
    if (budget < 3000) break;
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title.replace(/ /g, "_"))}`, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const txt = tablesText(await r.text(), Math.min(60000, budget));
      if (txt.length < 500) continue;
      out.push({ title, chars: txt.length, text: txt });
      budget -= txt.length;
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- 1. données
/** Débit réel d'une voix (mots/min), auto-mesuré à chaque run ; repli sur les mesures de référence. */
const REF_WPM = { Oliver: 158, Craig: 147, Grant: 146, Dennis: 138, Derek: 136, Jason: 132, Nate: 132, Timothy: 128, Edward: 124, Evan: 123, Theodore: 121, James: 120, Alex: 119, Ethan: 118, Carter: 111, Graham: 109, Tyler: 108, Mark: 106, Brian: 105, Blake: 102 };
// REF_WPM est mesuré sur UNE phrase courte ; sur un script réel (virgules, chiffres) le débit tombe de ~15 % (Craig : 147 → 125).
function voiceWpm(voice, s = config().settings) { return (s.pace && s.pace[voice]) || Math.round((REF_WPM[voice] || 130) * 0.85); }
/** Nombre de cartes pour tenir la durée demandée, d'après le débit RÉEL de la voix (phrases ~21 mots, intro ~40, outro ~20). */
function cardCount(durationSec, s = config().settings, voice = s.voice) {
  const wpm = voiceWpm(voice, s);
  const perCard = Math.max(s.minCardSec, (21 / wpm) * 60 + s.cardPad);
  const intro = Math.max(s.introMinSec, 0.8 + (40 / wpm) * 60 + 0.7);
  const outro = 0.4 + (20 / wpm) * 60 + 1.6 + 1.6;
  return Math.max(6, Math.floor((durationSec - intro - outro) / perCard));
}
function fmtNumberLike(display, value) {
  // remplace le nombre d'un affichage simple (« 508 m », « 1,234 km ») par la valeur recoupée
  const m = /^([^\d]*)([\d][\d.,]*)(\s*[^\d]*)$/.exec(String(display || "").trim());
  if (!m) return null;
  const hasComma = m[2].includes(",");
  const dec = (m[2].split(".")[1] || "").length;
  const n = hasComma ? Math.round(value).toLocaleString("en-US") : value.toFixed(dec);
  return m[1] + n + m[3];
}

async function stepData(run) {
  const s = config().settings;
  const n = run.params.count || cardCount(run.params.durationSec, s, run.params.voice);
  run.params.count = n;
  const spares = Math.max(6, Math.round(n * 0.3));
  const sources = await gatherSources(run);
  run.sources = sources.map((x) => ({ title: x.title, chars: x.chars, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}` }));
  if (sources.length) log(run, `📚 Sources Wikipédia : ${sources.map((x) => `« ${x.title} »`).join(", ")}`);
  const srcBlock = sources.length ? ["", "SOURCE DATA (tables extracted today from Wikipedia — this is the SOURCE OF TRUTH):", ...sources.map((x) => `### ${x.title}\n${x.text}`), "",
    "RULES FOR SOURCES: build the entries FROM these tables whenever they cover the topic; copy names and values from the tables (never from memory); set fromSource=true for such entries. Only use your own knowledge for entries the tables do not cover (fromSource=false). A row marked 'topped out' still counts if the table lists it as the current record."] : [];
  const prompt = [
    `You are the data researcher of a YouTube "data ranking" channel (like List Data, Nerd Cassette, Aesthetic Data). The video is a horizontal carousel of cards, one card per entry, sorted in ASCENDING order of value, ranks counting DOWN (the first card has rank ${n}, the last card is #1, the biggest value).`,
    `TOPIC: "${run.params.topic}"`,
    'MODE: decide "mode". "ranking" when the topic has a numeric criterion (height, net worth, visitors, speed…) → values sorted ascending. "catalog" when it does not (e.g. "Martial Arts From Different Countries", "Traditional Food From Different Countries" — the most viewed format of the niche): one entry per country, value=0, display = a short descriptor shown big on the card (max 18 characters, e.g. the local name, the type, the year of origin), and the entries are ordered as a pleasant world tour grouped by continent (the most iconic entry LAST).',
    'STYLE: decide "style" for the card images — "photo" (real things: buildings, landmarks, food, animals, vehicles, products, people) or "illustration" (things the niche shows as colorful cartoon illustrations: martial arts, sports poses, cartoon characters, mythical creatures, costumes, dances).',
    `Build EXACTLY ${n + spares} entries (${n} for the video + ${spares} spares). Only REAL, well-documented, verifiable facts (as of 2026, use the latest reliable figures you know). Prefer famous, visually recognizable entries that a worldwide audience cares about.`,
    "If the topic is 'in every country' / 'from different countries', use ONE entry per country (never two entries from the same country). Keep a single unit for all values. Entries must be distinct.",
    "The ranking must progress naturally: the list sorted ascending must end on the most impressive entry.",
    "Only entries that EXIST and are in service/completed as of 2026 (a building that has topped out counts). Exclude planned, proposed or future entries (a train entering service in 2027 is excluded).",
    "For each entry:",
    '- name: display name, max 26 characters, as commonly known in English',
    '- wiki: the EXACT title of the English Wikipedia article about THIS entry (not the country, not the city — the entry itself)',
    '- country: English country name; iso2: lowercase ISO 3166-1 alpha-2 code of the flag to display ("" if not applicable)',
    '- value: number in the common unit; display: short formatted value for the card (e.g. "828 m", "$2.3B", "1.4M", "74%")',
    '- extra: short secondary line max 28 characters (e.g. city · year completed)',
    '- visual: what the card image should show — "place" (building/landmark/city/nature), "object" (product/vehicle/dish/animal/thing), "person" (a real person: photo from Wikipedia), "logo" (a company/brand/club/org logo), "flag" (the country flag itself is the subject)',
    '- look: 1 English sentence describing what the entry physically looks like (for an illustrator), never about text',
    '- shape: overall silhouette of the subject — "tall" (skyscraper, tower, standing person, bottle), "wide" (train, car, plane, ship, bridge, animal side view), "square" (dish, logo, building complex, face)',
    '- fact: ONE striking TRUE fact about the entry, max 16 words, English, no number repeated from value',
    "Global fields:",
    '- title: YouTube title in the niche style, max 70 characters (e.g. "Tallest Building in Every Country 2026", "50 Richest Supermarkets Around The World 2026")',
    '- banner: uppercase banner shown during the whole video, max 38 characters',
    `- kicker: e.g. "TOP ${n}"; subtitle: the criterion, max 40 characters (e.g. "Ranked by height · 2026")`,
    '- unitLabel: uppercase label under the value (e.g. "HEIGHT", "NET WORTH", "VISITORS / YEAR"); in catalog mode it names what the descriptor IS (e.g. "STYLE", "TYPE", "LOCAL NAME"), max 18 characters',
    '- subKind: what the middle band shows — "country" (default) or "company"/"team"/"category"; if not country, fill `sub` in each entry',
    '- wikidataProp: the Wikidata property id holding exactly this value on the entry item (P2048 height, P1082 population, P2046 area, P2067 mass, P2120 radius, P1128 employees, P2139 revenue, P2226 market cap, P2044 elevation...) or null if none fits',
    ...srcBlock,
    "Reply with JSON ONLY:",
    JSON.stringify({ mode: "ranking", style: "photo", title: "", banner: "", kicker: "", subtitle: "", unitLabel: "", subKind: "country", wikidataProp: null, items: [{ name: "", wiki: "", country: "", iso2: "", sub: "", value: 0, display: "", extra: "", visual: "place", shape: "tall", look: "", fact: "", fromSource: true }] }),
  ].join("\n");
  log(run, `📊 Recherche des données (${n} cartes + ${spares} réserves)…`);
  const d = await askJson(prompt, "Données");
  if (!Array.isArray(d.items) || d.items.length < n) throw new Error(`jeu de données trop court (${(d.items || []).length}/${n})`);
  const mode = d.mode === "catalog" ? "catalog" : "ranking";
  run.meta = { mode, style: d.style === "illustration" ? "illustration" : "photo", title: d.title, banner: d.banner, kicker: mode === "catalog" ? `${n} COUNTRIES` : (d.kicker || `TOP ${n}`), subtitle: d.subtitle || "", unitLabel: d.unitLabel || "", subKind: d.subKind || "country", wikidataProp: mode === "ranking" ? d.wikidataProp || null : null };
  let items = d.items.map((x, i) => ({ ...x, id: i, order: i, value: mode === "catalog" ? 0 : Number(x.value), iso2: String(x.iso2 || "").toLowerCase().slice(0, 2) })).filter((x) => x.name && isFinite(x.value));
  log(run, `🧭 Format : ${mode === "catalog" ? "catalogue (un élément par pays, sans valeur chiffrée — tour du monde)" : "classement croissant"} · images ${run.meta.style === "illustration" ? "illustrations" : "photos/détourages"}`);

  // --- vérification Wikipédia : l'article existe et parle bien de l'entrée
  const pages = await wikiPages(items.map((x) => x.wiki || x.name));
  for (const it of items) {
    let p = pages[it.wiki || it.name];
    if (!p || p.missing || p.disambig) {
      const alt = await wikiSearch(`${it.name} ${it.country || ""}`.trim()).catch(() => null);
      if (alt) { const pp = await wikiPages([alt]); p = pp[alt]; if (p && !p.missing) it.wiki = p.title; }
    }
    if (!p || p.missing || p.disambig) { if (it.fromSource) { it.noWiki = true; continue; } it.reject = "article Wikipédia introuvable"; continue; }
    it.wiki = p.title; it.qid = p.qid; it.wikiDesc = p.desc; it.wikiImage = p.image;
  }
  // --- recoupement de la valeur par Wikidata (source de vérité quand la propriété existe)
  const prop = run.meta.wikidataProp;
  if (prop && /^P\d+$/.test(prop)) {
    const ents = await wikidataEntities(items.filter((x) => x.qid && !x.reject).map((x) => x.qid));
    let fixed = 0, confirmed = 0;
    for (const it of items) {
      if (!it.qid || it.reject) continue;
      const v = claimAmount(ents[it.qid], prop);
      if (!v || !isFinite(v.amount) || v.amount <= 0) { it.check = "absent de Wikidata"; continue; }
      const ratio = v.amount / it.value;
      if (ratio > 0.97 && ratio < 1.03) { it.check = "confirmé Wikidata"; confirmed++; continue; }
      if (it.fromSource) { it.check = `source Wikipédia (Wikidata : ${v.amount})`; continue; }
      if (ratio > 0.75 && ratio < 1.33) {
        const disp = fmtNumberLike(it.display, v.amount);
        if (disp) { it.check = `corrigé Wikidata (${it.display} → ${disp})`; it.value = v.amount; it.display = disp; fixed++; continue; }
      }
      it.check = `désaccord Wikidata (${it.value} vs ${v.amount} ${v.unit})`;
    }
    log(run, `🔎 Wikidata ${prop} : ${confirmed} valeurs confirmées, ${fixed} corrigées`);
  }
  // --- relecture critique (auto-évaluation) : erreurs factuelles, doublons, cohérence avec le titre
  const critic = await askJson([
    run.meta.mode === "catalog" ? "This is a CATALOG video (one entry per country, no numeric value: ignore value/display correctness except the descriptor)." : "",
    `You are a strict fact-checker for a data ranking video titled "${run.meta.title}" (topic: "${run.params.topic}", unit label: ${run.meta.unitLabel}).`,
    "Each entry shows the Wikipedia article it was matched to (wikiArticle + wikiDesc): if that article is NOT about this entry (homonym: e.g. a dance hall in Toronto for a Mumbai skyscraper), give the correct English article title in fix.wiki.",
    "Drop (drop=true) any entry that does not exist yet in 2026 (planned, proposed, enters service later).",
    "Review each entry. Flag ONLY clear problems: wrong value (give the correct one if you are sure), wrong country/flag, entry that does not match the topic, duplicate country when the topic is per-country, fact that is false.",
    "If an entry is wrong but should be REPLACED by another (e.g. not the record holder of its country), give the full replacement in `replace`.",
    `Also list in \`missing\` the entries that clearly belong among the ${n} biggest values but are absent (full fields).`,
    ...(sources.length ? ["Use the SOURCE DATA below as ground truth.", ...sources.map((x) => `### ${x.title}\n${x.text.slice(0, 40000)}`)] : []),
    'Reply JSON ONLY: {"issues":[{"id":0,"problem":"","fix":{"value":null,"display":null,"country":null,"iso2":null,"fact":null,"wiki":null},"drop":false,"replace":null}],"missing":[{"name":"","wiki":"","country":"","iso2":"","value":0,"display":"","extra":"","visual":"place","look":"","fact":""}]} — empty lists if all good.',
    "ENTRIES:",
    JSON.stringify(items.filter((x) => !x.reject).map((x) => ({ id: x.id, name: x.name, country: x.country, iso2: x.iso2, value: x.value, display: x.display, fact: x.fact, fromSource: !!x.fromSource, wikidata: x.check || null, wikiArticle: x.wiki, wikiDesc: x.wikiDesc || null }))),
  ].join("\n"), "Relecture");
  let drops = 0, fixes = 0;
  const newOnes = [];
  for (const is of critic.issues || []) {
    const it = items.find((x) => x.id === Number(is.id));
    if (!it) continue;
    if (is.replace && is.replace.name && isFinite(Number(is.replace.value))) { it.reject = "remplacé : " + is.problem; newOnes.push({ ...is.replace, reviewNote: is.problem }); drops++; continue; }
    if (is.drop) { it.reject = "relecture : " + is.problem; drops++; continue; }
    const f = is.fix || {};
    // une valeur confirmée par Wikidata n'est jamais écrasée par le relecteur
    if (f.value != null && isFinite(Number(f.value)) && !/confirmé|corrigé/.test(it.check || "")) { it.value = Number(f.value); if (f.display) it.display = f.display; fixes++; }
    if (f.country) it.country = f.country;
    if (f.iso2) it.iso2 = String(f.iso2).toLowerCase();
    if (f.fact) it.fact = f.fact;
    if (f.wiki && f.wiki !== it.wiki) {
      const pp = await wikiPages([f.wiki]).catch(() => ({}));
      const pg = pp[f.wiki];
      if (pg && !pg.missing && !pg.disambig) { it.wiki = pg.title; it.qid = pg.qid; it.wikiDesc = pg.desc; it.wikiImage = pg.image; }
      else { it.wikiImage = null; it.noWiki = true; } // article douteux : on n'utilise pas sa photo
    }
    it.review = is.problem;
  }
  for (const m of critic.missing || []) if (m && m.name && isFinite(Number(m.value)) && !items.some((x) => !x.reject && x.name.toLowerCase() === String(m.name).toLowerCase())) newOnes.push(m);
  if (newOnes.length) {
    let id = items.length;
    const fresh = newOnes.map((x) => ({ ...x, id: id, order: items.length - 1.5 + (id++) / 1000, value: run.meta.mode === "catalog" ? 0 : Number(x.value), iso2: String(x.iso2 || "").toLowerCase().slice(0, 2), added: true }));
    const pp = await wikiPages(fresh.map((x) => x.wiki || x.name));
    for (const it of fresh) { const p = pp[it.wiki || it.name]; if (!p || p.missing || p.disambig) { if (sources.length) { it.noWiki = true; it.check = "ajouté par la relecture (source)"; continue; } it.reject = "ajout sans article Wikipédia"; continue; } it.wiki = p.title; it.qid = p.qid; it.wikiDesc = p.desc; it.wikiImage = p.image; it.check = "ajouté par la relecture"; }
    items.push(...fresh);
    // un ajout pour un pays déjà présent remplace l'ancienne entrée (sujets « un par pays »)
    if (/every country|each country|different countries|by country|per country/i.test(run.params.topic + " " + run.meta.title))
      for (const f of fresh.filter((x) => !x.reject)) for (const o of items) if (o !== f && !o.reject && !o.added && f.iso2 && o.iso2 === f.iso2) o.reject = `remplacé par ${f.name}`;
  }
  if (drops || fixes || newOnes.length) log(run, `🧐 Relecture : ${fixes} corrections, ${drops} écartées/remplacées, ${newOnes.length} ajouts`);
  // désaccord Wikidata non corrigé → on préfère une réserve
  let ok = items.filter((x) => !x.reject);
  const doubtful = ok.filter((x) => /désaccord/.test(x.check || ""));
  if (ok.length - doubtful.length >= n) ok = ok.filter((x) => !/désaccord/.test(x.check || ""));
  // un pays par carte si le sujet l'exige
  if (/every country|each country|different countries|by country|per country/i.test(run.params.topic + " " + run.meta.title)) {
    const seen = new Set();
    ok = ok.filter((x) => { const k = x.iso2 || x.country; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (ok.length < n) { log(run, `⚠ seulement ${ok.length} entrées valides sur ${n} — la vidéo aura ${ok.length} cartes`); }
  let chosen;
  if (run.meta.mode === "catalog") {
    // catalogue : l'ordre du tour du monde proposé est conservé ; les ajouts de la relecture s'insèrent avant l'entrée finale
    chosen = ok.sort((a, b) => a.order - b.order).slice(0, n);
    chosen.forEach((x, k) => { x.rank = k + 1; });
    run.meta.kicker = `${chosen.length} COUNTRIES`;
  } else {
    // classement : on garde les N PLUS GRANDES valeurs (le haut du classement), puis ordre croissant
    ok.sort((a, b) => b.value - a.value);
    chosen = ok.slice(0, n).sort((a, b) => a.value - b.value);
    chosen.forEach((x, k) => { x.rank = chosen.length - k; });
  }
  run.items = chosen;
  run.spares = run.meta.mode === "catalog" ? ok.filter((x) => !chosen.includes(x)) : ok.slice(n).sort((a, b) => b.value - a.value); // classement : les plus grandes valeurs sous le seuil d'abord
  run.rejected = items.filter((x) => x.reject).map((x) => ({ name: x.name, why: x.reject }));
  run.params.count = chosen.length;
  log(run, `✅ ${chosen.length} cartes retenues : de « ${chosen[0].name} » (${chosen[0].display}) à « ${chosen[chosen.length - 1].name} » (${chosen[chosen.length - 1].display})`);
}

// ---------------------------------------------------------------- 2. script
async function stepScript(run) {
  const it = run.items;
  const lang = run.params.language || "English";
  const catalog = run.meta.mode === "catalog";
  const prompt = catalog ? [
    `You write the voice-over of a YouTube "from different countries" video: "${run.meta.title}". The viewer watches a carousel of cards (one country per card) scrolling right to left; the narrator comments ONE card per sentence, exactly when that card arrives.`,
    `Language: ${lang}. Tone: clear, warm, curious, documentary; never hype.`,
    `INTRO (35-55 words): greet briefly ("Hello everyone"), announce the world tour and what we discover in each country, tease the last one ("and the last one is legendary"), then ONE short call to subscribe.`,
    `ONE LINE PER CARD (${it.length} lines, same order): 16-24 words each, ONE COMPLETE GRAMMATICAL SENTENCE with a main verb. Formula: "[Country] gives us / is home to [name], [striking fact]." Vary the openings ("In Japan,", "Next, Brazil…", "Heading to Africa,"), mention the continent change when it happens, weave the given fact, and make the last line a climax.`,
    "OUTRO (12-22 words): thank, ask which country's entry they prefer in the comments, subscribe.",
    `Reply JSON ONLY: {"intro":"","lines":[{"rank":${it[0].rank},"line":""}],"outro":""} — EXACTLY ${it.length} lines, one per card, keyed by rank.`,
    "CARDS:",
    JSON.stringify(it.map((x) => ({ rank: x.rank, name: x.name, country: x.country, descriptor: x.display, fact: x.fact }))),
  ].join("\n") : [
    `You write the voice-over of a YouTube data ranking video: "${run.meta.title}". The viewer watches a carousel of cards scrolling right to left in ascending order; the narrator comments ONE card per sentence, exactly when that card arrives.`,
    `Language: ${lang}. Tone: clear, warm, documentary, confident; never hype, never "Let's go".`,
    `INTRO (35-55 words): greet briefly, announce the topic and the criterion in natural spoken words (the on-screen subtitle is "${run.meta.subtitle}" — never read it literally, no symbols), tease the finale without naming #1 (e.g. "and number one is truly staggering"), then ONE short call to subscribe. Must feel like the niche: "Hello everyone. Today we rank…".`,
    `ONE LINE PER CARD (${it.length} lines, same order): 16-24 words each. Each line is ONE COMPLETE, GRAMMATICAL SENTENCE with a main verb (never a fragment of participles). Niche formula: "[Name] in [place] [main verb + value], [and/where/making it + striking fact]." Good examples:
  "Taipei 101 in Taiwan rises to 508 meters, and for six years it proudly held the title of the world's tallest building."
  "In Russia, the Lakhta Center twists up to 462 meters above Saint Petersburg, making it the tallest building in Europe."
  "Next comes The Shard in London, which pierces the sky at 310 meters with its iconic shattered-glass spire."
Bad (fragment, forbidden): "JW Marriott Panama in Panama City, rising 284 meters, having been completed in 2011."
Rules: the NAME and the VALUE (same number as the card) must appear in the line; vary the verbs and the opening (name first / "In [country]," / "Next," / "At number N,") and never start two consecutive lines the same way; weave the given fact (keep it — it is true); every 8-10 cards add a short retention hook inside the line, ONLY at exact milestones (rank 20 = "entering the top twenty", rank 10 = "entering the top ten", rank 3 = "the podium"); never vague phrases like "the top tier". Never state a superlative ("tallest in Latin America", "biggest in Europe") that another card of the list contradicts. The last line (#1) is a climax.`,
    "OUTRO (12-22 words): thank, ask which one surprised them in the comments, subscribe.",
    "Write numbers as digits with the unit spelled out (\"828 meters\", \"2.3 billion dollars\").",
    `Reply JSON ONLY: {"intro":"","lines":[{"rank":${it[0].rank},"line":""}],"outro":""} — EXACTLY ${it.length} lines, one per card, keyed by rank.`,
    "CARDS:",
    JSON.stringify(it.map((x) => ({ rank: x.rank, name: x.name, country: x.country, sub: x.sub || "", value: x.display, extra: x.extra, fact: x.fact }))),
  ].join("\n");
  log(run, "✍️ Écriture de la voix off…");
  let raw = await askJson(prompt, "Script");
  const byRank = {};
  for (const l of raw.lines || []) { if (l && typeof l === "object" && l.line) byRank[Number(l.rank)] = String(l.line); }
  if (Array.isArray(raw.lines) && typeof raw.lines[0] === "string" && raw.lines.length === it.length) raw.lines.forEach((l, k) => (byRank[it[k].rank] = l));
  const sc = { intro: raw.intro, outro: raw.outro, lines: it.map((x) => byRank[x.rank] || "") };
  if (!sc.intro || !sc.outro) throw new Error("script : intro ou outro manquant");
  // contrôle ligne par ligne + réécriture ciblée (boucle d'auto-évaluation, 2 tours max)
  const numOf = (d) => (String(d).match(/[\d][\d.,]*/) || [""])[0].replace(/,/g, "");
  const bad = () => sc.lines.map((l, k) => {
    const w = words(l), x = it[k];
    if (!l) return { k, probs: ["line missing — write it"] };
    const nameTok = x.name.split(/\s+/).find((t) => t.length > 2) || x.name;
    const probs = [];
    if (w < 13 || w > 28) probs.push(`${w} words (need 16-24)`);
    if (!l.toLowerCase().includes(nameTok.toLowerCase().replace(/[^\w]/g, "").slice(0, 5)) && !l.toLowerCase().includes(nameTok.toLowerCase())) probs.push(`name "${x.name}" missing`);
    const nv = catalog ? "" : numOf(x.display);
    if (nv && !l.replace(/,/g, "").includes(nv.split(".")[0])) probs.push(`value ${x.display} missing`);
    return probs.length ? { k, probs } : null;
  }).filter(Boolean);
  for (let round = 1; round <= 2; round++) {
    const b = bad();
    if (!b.length) break;
    log(run, `✍️ Contrôle du script : ${b.length} ligne(s) à reprendre (tour ${round})`);
    const fix = await askJson([
      `Rewrite these voice-over lines for the data ranking video "${run.meta.title}" (${lang}). Each line: 16-24 words, must contain the name and the value (digits + unit spelled out), niche formula "[Name] in [place], [verb] [value], [fact]".`,
      'Reply JSON ONLY: {"lines":[{"k":0,"line":""}]}',
      JSON.stringify(b.map(({ k, probs }) => ({ k, problems: probs, current: sc.lines[k], card: { name: it[k].name, country: it[k].country, value: it[k].display, fact: it[k].fact } }))),
    ].join("\n"), "Script (reprise)");
    for (const f of fix.lines || []) if (Number.isInteger(Number(f.k)) && f.line) sc.lines[Number(f.k)] = f.line;
  }
  // script doctor : contradictions entre cartes, superlatifs faux, métadonnées lues telles quelles, tournures bancales
  try {
    const doc = await askJson([
      `You are the script doctor of the data ranking video "${run.meta.title}". Below: the cards (ascending order, ranks counting down) and the voice-over.`,
      "Find ONLY real problems: (1) a superlative contradicted by ANOTHER CARD of this list (e.g. 'tallest in Latin America' while a taller Latin American card exists); (2) a line that is a grammatical fragment without a main verb; (3) on-screen metadata read literally (symbols like ·); (4) a milestone hook at the wrong rank; (5) a value spoken differently from the card.",
      "NEVER remove or change a fact unless it is contradicted by the card list itself — the facts were researched; do not nitpick verbs or style. Most lines should need no change.",
      "Return corrected text for the problematic parts only (lines 16-24 words, complete sentences, keep name + value + fact). JSON ONLY: {\"intro\":null,\"outro\":null,\"lines\":[{\"rank\":0,\"line\":\"\",\"why\":\"\"}]}",
      "CARDS: " + JSON.stringify(it.map((x) => ({ rank: x.rank, name: x.name, country: x.country, value: x.display }))),
      "INTRO: " + sc.intro,
      "LINES: " + JSON.stringify(it.map((x, k) => ({ rank: x.rank, line: sc.lines[k] }))),
      "OUTRO: " + sc.outro,
    ].join("\n"), "Script doctor");
    let n = 0;
    if (doc.intro && words(doc.intro) >= 25) { sc.intro = doc.intro; n++; }
    if (doc.outro && words(doc.outro) >= 8) { sc.outro = doc.outro; n++; }
    for (const l of doc.lines || []) { const k = it.findIndex((x) => x.rank === Number(l.rank)); if (k >= 0 && l.line && words(l.line) >= 13 && words(l.line) <= 28) { sc.lines[k] = l.line; n++; } }
    run.scriptDoctor = (doc.lines || []).map((l) => ({ rank: l.rank, why: l.why }));
    if (n) log(run, `🩺 Script doctor : ${n} passage(s) réécrit(s)`);
  } catch (e) { log(run, "🩺 Script doctor indisponible : " + e.message.slice(0, 80)); }
  run.script = { intro: sc.intro, lines: sc.lines, outro: sc.outro };
  run.items.forEach((x, k) => { x.line = sc.lines[k]; });
  log(run, `✅ Script : intro ${words(sc.intro)} mots, ${sc.lines.length} phrases (moy. ${Math.round(sc.lines.reduce((a, l) => a + words(l), 0) / sc.lines.length)} mots), outro ${words(sc.outro)} mots`);
}

// ---------------------------------------------------------------- 3. voix + timeline (+ musique en parallèle)
async function tts(run, text, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 2000) return probe(file);
  const lang = run.params.language || "English";
  const voice = `${run.params.voice || config().settings.voice} ${VOICE_SUFFIX[lang] || "(en)"}`;
  let last;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fal.run("fal-ai/inworld-tts", { text, voice, sample_rate_hertz: 48000 });
      if (!r.audio?.url) throw new Error("Inworld : aucun audio");
      const raw = file.replace(/\.wav$/, ".raw");
      await fal.download(r.audio.url, raw);
      // Inworld livre du WAV sous extension .mp3 : on RÉ-ENCODE systématiquement (codec uniquement, aucun filtre)
      await ffmpeg(["-i", raw, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", file]);
      fs.unlinkSync(raw);
      addCost(run, "voice", (text.length / 1000) * PRICES.ttsPer1kChars, "FAL", "Voix Inworld");
      return probe(file);
    } catch (e) { last = e; await sleep(3000 * a); }
  }
  throw last;
}
async function startMusic(run) {
  if (!(run.params.music ?? config().settings.music) || (run.music && (run.music.taskId || run.music.file))) return;
  try {
    const r = await fetch("https://api.kie.ai/api/v1/generate", {
      method: "POST", headers: { Authorization: `Bearer ${kieKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "V5_5", customMode: true, instrumental: true, style: `${config().settings.musicStyle}. Purely instrumental, NO vocals.`, title: `Data Ranking BGM ${run.id}`, prompt: "", styleWeight: 0.65, weirdnessConstraint: 0.65, audioWeight: 0.65, callBackUrl: "https://your-domain.com/api/callback" }),
    }).then((x) => x.json());
    if (!r.data?.taskId) throw new Error(r.msg || "refus");
    run.music = { taskId: r.data.taskId };
    addCost(run, "music", PRICES.music, "Kie.ai", "Musique de fond (Suno)");
    log(run, "🎵 Musique de fond lancée (Suno)");
  } catch (e) { run.music = { error: e.message }; log(run, "🎵 Suno indisponible : " + e.message); }
}
async function collectMusic(run, timeoutMs = 10 * 60 * 1000) {
  if (!run.music || !run.music.taskId || run.music.file || run.music.error) return;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await fetch(`https://api.kie.ai/api/v1/generate/record-info?taskId=${run.music.taskId}`, { headers: { Authorization: `Bearer ${kieKey()}` } }).then((x) => x.json()).catch(() => ({}));
    const st = String(d.data?.status || "");
    if (/FAILED|SENSITIVE|ERROR/i.test(st)) { run.music.error = st; return; }
    const tr = (d.data?.response?.sunoData || []).filter((t) => t.audioUrl);
    if (st === "SUCCESS" && tr.length) {
      const f = path.join(runDir(run), "bgm.mp3");
      await download(tr[0].audioUrl, f);
      run.music.file = "bgm.mp3";
      log(run, "🎵 Musique prête");
      return;
    }
    await sleep(15000);
  }
  log(run, "🎵 Musique pas prête à temps — sans musique");
}
// clé STABLE (identifiant de l'entrée, pas son rang : l'extension de durée renumérote les rangs du catalogue)
const vkey = (x) => `e${String(x.id).padStart(3, "0")}`;
/** Timeline : la carte arrive au point focal quand SA phrase commence. */
function buildTimeline(run) {
  const s = config().settings;
  const d = run.voiceDur;
  const introLead = 0.8;
  const introSec = Math.max(s.introMinSec, introLead + d.intro + 0.7);
  let t = introSec;
  for (const x of run.items) {
    const dd = d[vkey(x)];
    x.start = +t.toFixed(3);
    x.end = +(t + dd).toFixed(3);
    t += Math.max(s.minCardSec, dd + s.cardPad);
  }
  const lastEnd = run.items[run.items.length - 1].end;
  const outroStart = +Math.max(t, lastEnd + 1.6).toFixed(3);
  const total = +(outroStart + 0.4 + d.outro + 1.6).toFixed(3);
  run.timeline = { introLead, introSec: +introSec.toFixed(3), outroStart, outroVoiceAt: +(outroStart + 0.4).toFixed(3), total };
  return run.timeline;
}
async function stepVoice(run) {
  const s = config().settings;
  const dir = path.join(runDir(run), "voice");
  ensureDir(dir);
  await startMusic(run);
  saveRun(run);
  const voice = run.params.voice || s.voice;
  const segs = [{ key: "intro", text: run.script.intro }, ...run.items.map((x) => ({ key: vkey(x), text: x.line })), { key: "outro", text: run.script.outro }];
  log(run, `🎙️ Voix Inworld (${voice}) : ${segs.length} phrases…`);
  const durs = await pool(segs, (g) => tts(run, g.text, path.join(dir, `${g.key}.wav`)), 6);
  run.voiceDur = Object.fromEntries(segs.map((g, i) => [g.key, +durs[i].toFixed(3)]));
  // débit réel de la voix → mémorisé (le prochain run se dimensionne dessus)
  const totW = segs.reduce((a, g) => a + words(g.text), 0), totS = durs.reduce((a, b) => a + b, 0);
  const wpm = Math.round((totW / totS) * 60);
  const pace = { ...(s.pace || {}) };
  pace[voice] = pace[voice] ? Math.round(pace[voice] * 0.4 + wpm * 0.6) : wpm;
  patchConfig({ settings: { pace } });
  run.voiceWpm = wpm;
  let tl = buildTimeline(run);
  // garde de durée (auto-correction) : trop long → on retire les cartes les plus BASSES du classement, sans refaire la voix
  const target = run.params.durationSec;
  const dropped = [];
  while (tl.total > target * 1.05 && run.items.length > 6) {
    dropped.push(run.items.shift());
    tl = buildTimeline(run);
  }
  if (dropped.length) {
    run.params.count = run.items.length;
    run.meta.kicker = `TOP ${run.items.length}`;
    run.trimmed = dropped.map((x) => x.name);
    log(run, `✂️ Durée : ${dropped.length} carte(s) du bas retirée(s) (${dropped.map((x) => x.name).join(", ")}) pour tenir ${Math.round(target / 60)} min`);
  }
  // trop court → on ajoute des cartes de réserve (déjà vérifiées) au DÉBUT du carrousel : phrase + voix, puis nouvelle timeline
  if (tl.total < target * 0.95 && (run.spares || []).length) {
    const perCard = (tl.outroStart - run.items[0].start) / run.items.length;
    const need = Math.min(run.spares.length, Math.round((target - tl.total) / perCard));
    if (need > 0) {
      const add = run.spares.splice(0, need);
      if (run.meta.mode === "catalog") { const cut = Math.max(0, run.items.length - 3); run.items = [...run.items.slice(0, cut), ...add, ...run.items.slice(cut)]; run.items.forEach((x, k) => { x.rank = k + 1; }); run.meta.kicker = `${run.items.length} COUNTRIES`; } // les plus iconiques restent en fin
      else { add.sort((a2, b2) => a2.value - b2.value); const base = run.items.length; add.forEach((x, k) => { x.rank = base + add.length - k; }); run.items = [...add, ...run.items]; run.meta.kicker = `TOP ${run.items.length}`; }
      const lines = await askJson([
        `Write ${add.length} extra voice-over lines for the data video "${run.meta.title}" (${run.params.language || "English"}), same style as these existing lines: ${JSON.stringify(run.items.filter((x) => !add.includes(x)).slice(0, 3).map((x) => x.line))}.`,
        "Each line: 16-24 words, ONE complete grammatical sentence with a main verb, must contain the name" + (run.meta.mode === "catalog" ? "" : " and the value (digits + unit spelled out)") + ", weave the fact.",
        'JSON ONLY: {"lines":[{"rank":0,"line":""}]}',
        JSON.stringify(add.map((x) => ({ rank: x.rank, name: x.name, country: x.country, value: x.display, fact: x.fact }))),
      ].join("\n"), "Lignes supplémentaires");
      for (const l of lines.lines || []) { const x = add.find((y) => y.rank === Number(l.rank)); if (x && l.line) x.line = l.line; }
      for (const x of add) if (!x.line) x.line = `${x.name}${x.country ? ` in ${x.country}` : ""}${run.meta.mode === "catalog" ? "" : ` reaches ${x.display}`}, and ${x.fact || "it deserves its place in this list"}.`;
      run.script.lines = run.items.map((x) => x.line);
      const extra = await pool(add, (x) => tts(run, x.line, path.join(dir, `${vkey(x)}.wav`)), 6);
      add.forEach((x, k) => { run.voiceDur[vkey(x)] = +extra[k].toFixed(3); });
      tl = buildTimeline(run);
      run.extended = add.map((x) => x.name);
      log(run, `➕ Durée : ${add.length} carte(s) de réserve ajoutée(s) (${add.map((x) => x.name).join(", ")}) pour tenir ${Math.round(target / 60 * 10) / 10} min`);
    }
  }
  if (tl.total < target * 0.88) log(run, `⚠ Vidéo plus courte que prévu (${Math.round(tl.total)} s pour ${target} s) — le prochain run prendra plus de cartes (débit ${wpm} mots/min mémorisé)`);
  // piste unique : silences + phrases aux instants exacts (concat de WAV identiques, aucun filtre sur la voix)
  const pieces = [];
  let cursor = 0;
  const silence = async (sec, name) => { const f = path.join(dir, name); await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", sec.toFixed(3), "-c:a", "pcm_s16le", f]); return f; };
  const place = async (at, key) => { if (at - cursor > 0.005) pieces.push(await silence(at - cursor, `sil-${key}.wav`)); pieces.push(path.join(dir, `${key}.wav`)); cursor = at + run.voiceDur[key]; };
  await place(tl.introLead, "intro");
  for (const x of run.items) await place(x.start, vkey(x));
  await place(tl.outroVoiceAt, "outro");
  if (tl.total - cursor > 0.01) pieces.push(await silence(tl.total - cursor, "sil-end.wav"));
  fs.writeFileSync(path.join(dir, "list.txt"), pieces.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  const vo = path.join(runDir(run), "vo.wav");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"), "-c:a", "pcm_s16le", vo]);
  const real = await probe(vo);
  if (Math.abs(real - tl.total) > 0.5) throw new Error(`piste voix incohérente : ${real.toFixed(2)} s au lieu de ${tl.total.toFixed(2)} s`);
  const spc = (tl.outroStart - run.items[0].start) / run.items.length;
  log(run, `✅ Voix : ${segs.length - dropped.length} phrases (${wpm} mots/min), vidéo de ${Math.floor(tl.total / 60)} min ${Math.round(tl.total % 60)} s (intro ${tl.introSec.toFixed(1)} s, ${spc.toFixed(1)} s/carte)`);
}

// ---------------------------------------------------------------- 4. assets (+ contrôle visuel)
function imgModel(run) { return IMG_MODELS[run.params.imageModel] || IMG_MODELS[config().settings.imageModel] || IMG_MODELS.gpt25; }
const ASPECT = { tall: "2:3", wide: "3:2", square: "1:1" };
async function genImage(run, { prompt, ref, transparent, aspect = "1:1", file }) {
  const m = imgModel(run);
  const input = { prompt, aspect_ratio: aspect, ...m.extra };
  if (transparent) input.background = "transparent";
  if (ref) input[m.field] = [ref];
  const url = await kiePoll(await kieCreate(ref ? m.i2i : m.t2i, input));
  await download(url, file);
  addCost(run, "images", m.price, "Kie.ai", `${m.name} — ${path.basename(file)}`);
  return file;
}
/** Contrôle Qwen : l'image générée représente-t-elle bien l'entrée (vs la photo de référence) et est-elle propre ? */
async function checkImage(run, item, file, refUrl) {
  const expect = `${item.name} (${item.country}) — ${item.wikiDesc || ""}${item.look ? " — looks like: " + item.look : ""} — card value: ${item.display} ${run.meta ? run.meta.unitLabel : ""}`;
  // miniature JPEG 512 px sur fond gris (les PNG 1024×1536 pleine taille font échouer le fournisseur par intermittence)
  const small = file.replace(/\.png$/, "-chk.jpg");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0xd9dee6:s=512x768", "-i", file, "-filter_complex", "[1:v]scale=512:768:force_original_aspect_ratio=decrease[f];[0:v][f]overlay=(W-w)/2:(H-h)/2:format=auto", "-frames:v", "1", "-q:v", "4", small]).catch(() => null);
  const b64 = fs.existsSync(small) ? "data:image/jpeg;base64," + fs.readFileSync(small).toString("base64") : "data:image/png;base64," + fs.readFileSync(file).toString("base64");
  const content = [
    { type: "text", text: [
      `Quality control for a data-ranking video card. The card is about: ${expect}.`,
      refUrl ? "Image 1 = reference photo from Wikipedia (it may itself be misleading: wrong building, a detail, a construction stage). Image 2 = generated illustration to check." : "Image = generated illustration to check.",
      "1) plausible: does the generated image plausibly show THIS entry given its description and value (e.g. a 320 m skyscraper must be a very tall tower, not a small house)? 2) score 0-10: how faithfully it shows this exact entry (shape, distinctive features). 3) clean: NO text, letters, watermark, logo or frame; subject complete and isolated.",
      "4) refOk: does the REFERENCE photo itself clearly show the entry as described?",
      'Reply JSON ONLY: {"plausible":true,"score":0,"clean":true,"refOk":true,"issues":""}',
    ].join("\n") },
    ...(refUrl ? [{ type: "image_url", image_url: { url: refUrl } }] : []),
    { type: "image_url", image_url: { url: b64 } },
  ];
  try {
    const { json, cost } = await lab.askVision(content, { model: lab.VISION_MODEL });
    addCost(run, "check", cost, "OpenRouter", "Qwen — contrôle image");
    const plausible = json.plausible !== false;
    return { score: plausible ? Number(json.score) || 0 : Math.min(2, Number(json.score) || 0), clean: json.clean !== false, plausible, refOk: json.refOk !== false, issues: String(json.issues || "") };
  } catch (e) {
    // contrôle indisponible (OpenRouter) : une relance, puis note neutre
    if (!checkImage._retry) { checkImage._retry = true; try { return await checkImage(run, item, file, refUrl); } finally { checkImage._retry = false; } }
    return { score: 6, clean: true, plausible: true, refOk: true, issues: "contrôle indisponible : " + e.message.slice(0, 60) };
  }
}
function cutoutPrompt(item, issues) {
  return [
    item.userHint ? `USER REQUEST (priority): ${item.userHint}.` : "",
    `Recreate faithfully the exact ${item.visual === "place" ? "landmark" : "subject"} shown in the reference image: ${item.name}${item.country ? ` (${item.country})` : ""}. ${item.look || ""}`,
    "Keep its real silhouette, proportions, colors, materials and distinctive details EXACTLY as in the reference — it must be instantly recognizable.",
    item.visual === "place" ? `Show the WHOLE structure from base to top, centered, ${item.shape === "wide" ? "horizontal" : "vertical"} framing, crisp daylight with soft golden light, premium architectural photography.` : `Show the whole subject centered and LARGE (filling ~85% of the ${item.shape === "wide" ? "width, three-quarter side view" : "frame"}), studio lighting, premium product photography, ultra detailed.`,
    "Isolated on a fully transparent background: no ground, no sky, no surrounding buildings, no people.",
    "Absolutely NO text, NO letters, NO logo, NO watermark, NO frame.",
    issues ? `Fix these problems from the previous attempt: ${issues}.` : "",
    "Faithful to the reference, isolated, no text.",
  ].filter(Boolean).join(" ");
}
const ILLU_BG = ["vivid orange", "bright sky blue", "lime green", "hot pink", "sunny yellow", "turquoise", "violet purple", "coral red"];
function illustrationPrompt(item, k, issues) {
  return [
    item.userHint ? `USER REQUEST (priority): ${item.userHint}.` : "",
    `Colorful flat vector cartoon illustration of ${item.name}${item.country ? ` from ${item.country}` : ""}: ${item.look || item.wikiDesc || ""}.`,
    "The subject shown whole and centered, dynamic characteristic pose or angle, bold clean outlines, soft cel shading, like a premium infographic sticker.",
    `Plain solid ${ILLU_BG[k % ILLU_BG.length]} background filling the frame. Vertical composition.`,
    "Absolutely NO text, NO letters, NO logo, NO watermark, NO flag.",
    issues ? `Fix: ${issues}.` : "",
  ].filter(Boolean).join(" ");
}
function t2iPrompt(item, issues) {
  return [
    item.userHint ? `USER REQUEST (priority): ${item.userHint}.` : "",
    `${item.name}${item.country ? `, ${item.country}` : ""}: ${item.look || item.wikiDesc || item.name}.`,
    "Photorealistic, the whole subject centered and complete, premium studio/architectural photography, crisp details, soft light.",
    "Isolated on a fully transparent background. Absolutely NO text, NO letters, NO logo, NO watermark.",
    issues ? `Avoid: ${issues}.` : "",
  ].filter(Boolean).join(" ");
}
async function assetFor(run, item, k) {
  if (cancelled.has(run.id)) throw new Error("Annulée par l'utilisateur");
  const dir = path.join(runDir(run), "assets");
  ensureDir(dir);
  const base = `r${String(item.rank).padStart(3, "0")}-${String(item.iso2 || "xx")}-${String(item.name).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16)}`;
  item.asset = item.asset || {};
  // drapeau (flagcdn, 2 tailles en repli) — un échec est SIGNALÉ, jamais avalé
  if (item.iso2 && !(item.asset.flag && fs.existsSync(path.join(dir, item.asset.flag)))) {
    delete item.asset.flag;
    for (const url of [`https://flagcdn.com/w320/${item.iso2}.png`, `https://flagcdn.com/w640/${item.iso2}.png`, `https://flagcdn.com/256x192/${item.iso2}.png`]) {
      try { await download(url, path.join(dir, `${base}-flag.png`)); item.asset.flag = `${base}-flag.png`; break; } catch (e) { item.asset.flagError = e.message; await sleep(1500); }
    }
    if (item.asset.flag) delete item.asset.flagError;
  }
  if (item.asset.image && fs.existsSync(path.join(dir, item.asset.image))) return;
  delete item.asset.image;
  let ref = item.wikiImage || null;
  const photo = async () => {
    if (!ref) return false;
    const f = path.join(dir, `${base}-photo.jpg`);
    await download(ref, f);
    item.asset.image = path.basename(f); item.asset.fit = "cover"; item.asset.src = "wikipedia";
    return true;
  };
  // style illustration (catalogues « martial arts / cartoons… ») : t2i coloré plein cadre, contrôlé par Qwen
  if (run.meta && run.meta.style === "illustration" && item.visual !== "logo" && item.visual !== "flag") {
    let issues = "", best = null;
    for (let a = 1; a <= 3; a++) {
      const f = path.join(dir, `${base}-illu${a}.png`);
      try {
        await genImage(run, { prompt: illustrationPrompt(item, k, issues), aspect: "1:1", file: f });
        const q = await checkImage(run, item, f, null);
        item.asset.checks = [...(item.asset.checks || []), { attempt: a, ...q }];
        if (!best || q.score > best.score) best = { f, ...q };
        if (q.score >= 7 && q.clean && q.plausible) break;
        issues = q.issues || "not representative enough";
      } catch (e) { item.asset.checks = [...(item.asset.checks || []), { attempt: a, error: e.message.slice(0, 120) }]; }
    }
    if (best) { item.asset.image = path.basename(best.f); item.asset.fit = "cover"; item.asset.src = imgModel(run).name; item.asset.score = best.score; return; }
  }
  if (item.visual === "person") { if (await photo()) return; }
  if (item.visual === "logo" && item.qid) {
    try {
      const ent = (await wikidataEntities([item.qid]))[item.qid];
      const lf = claimFile(ent, "P154");
      if (lf) { const f = path.join(dir, `${base}-logo.png`); await download(commonsFile(lf, 600), f); item.asset.image = path.basename(f); item.asset.fit = "logo"; item.asset.src = "wikidata"; return; }
    } catch {}
    if (await photo()) return;
  }
  if (item.visual === "flag") { if (item.asset.flag) { const f = path.join(dir, `${base}-bigflag.png`); await download(`https://flagcdn.com/w1280/${item.iso2}.png`, f); item.asset.image = path.basename(f); item.asset.fit = "logo"; item.asset.src = "flagcdn"; return; } }
  // lieu / objet : recréation détourée ancrée sur la photo réelle, contrôlée par Qwen
  if (config().settings.cutout) {
    let issues = "";
    let best = null;
    for (let a = 1; a <= 3; a++) {
      const f = path.join(dir, `${base}-ai${a}.png`);
      try {
        await genImage(run, { prompt: ref ? cutoutPrompt(item, issues) : t2iPrompt(item, issues), ref, transparent: true, aspect: ASPECT[item.shape] || "1:1", file: f });
        const q = await checkImage(run, item, f, ref);
        item.asset.checks = [...(item.asset.checks || []), { attempt: a, ref: !!ref, ...q }];
        if (!best || q.score > best.score) best = { f, ...q };
        if (q.score >= 7 && q.clean && q.plausible) break;
        issues = q.issues || "not faithful enough to the reference";
        // référence trompeuse (mauvais bâtiment, détail, chantier) → on génère d'après la description seule
        if (ref && !q.refOk) { ref = null; item.asset.refRejected = true; if (!q.plausible) best = null; }
      } catch (e) { item.asset.checks = [...(item.asset.checks || []), { attempt: a, error: e.message.slice(0, 120) }]; issues = ""; }
    }
    if (best && best.score >= 6 && best.clean && best.plausible !== false) { item.asset.image = path.basename(best.f); item.asset.fit = "cutout"; item.asset.src = imgModel(run).name; item.asset.score = best.score; return; }
    if (best && best.score >= 5 && (item.asset.refRejected || !item.wikiImage)) { item.asset.image = path.basename(best.f); item.asset.fit = "cutout"; item.asset.src = imgModel(run).name; item.asset.score = best.score; return; }
  }
  if (!item.asset.refRejected && (await photo())) { item.asset.fallback = "photo Wikipédia (générations < 6/10)"; return; }
  // dernier recours : la meilleure génération, même faible (signalée)
  const gens = (item.asset.checks || []).filter((c) => c.score != null);
  if (gens.length) {
    const bestA = gens.sort((a, b) => b.score - a.score)[0];
    const f = fs.readdirSync(dir).find((x) => x.startsWith(base) && new RegExp(`-(ai|illu)${bestA.attempt}\\.png$`).test(x));
    if (f) { item.asset.image = f; item.asset.fit = "cutout"; item.asset.score = bestA.score; item.asset.weak = true; return; }
  }
  item.asset.error = "aucune image";
}
async function stepAssets(run) {
  log(run, `🖼️ Images : drapeaux, portraits, logos, détourages ${imgModel(run).name} contrôlés par Qwen…`);
  let done = 0;
  await pool(run.items, async (it, k) => {
    try { await assetFor(run, it, k); } catch (e) { it.asset = { ...(it.asset || {}), error: e.message }; }
    done++;
    if (done % 5 === 0) { log(run, `🖼️ ${done}/${run.items.length} cartes illustrées`); saveRun(run); }
  }, 5);
  // image d'intro : la photo du n°1 en grand (teaser, comme la niche)
  const top = run.items[run.items.length - 1];
  const hero = path.join(runDir(run), "assets", "hero.jpg");
  if (!fs.existsSync(hero)) {
    try {
      const big = top.wikiImage ? top.wikiImage.replace(/\/(\d+)px-/, "/1920px-") : null;
      if (big) await download(big, hero).catch(() => download(top.wikiImage, hero));
      else await genImage(run, { prompt: `Cinematic wide shot of ${top.name} (${top.country}), ${top.look || ""}, epic golden hour light, photorealistic, no text`, aspect: "16:9", file: hero.replace(".jpg", ".png") });
    } catch (e) { log(run, "hero : " + e.message); }
  }
  const missing = run.items.filter((x) => !x.asset || !x.asset.image);
  const scores = run.items.map((x) => x.asset && x.asset.score).filter((x) => x != null);
  log(run, `✅ Images : ${run.items.length - missing.length}/${run.items.length} (${run.items.filter((x) => x.asset?.fit === "cutout").length} détourages IA, note Qwen moyenne ${scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "—"}/10, ${run.items.filter((x) => x.asset?.src === "wikipedia").length} photos Wikipédia)`);
  if (missing.length) log(run, `⚠ Sans image : ${missing.map((x) => x.name).join(", ")}`);
  const noFlag = run.items.filter((x) => x.iso2 && !(x.asset && x.asset.flag));
  if (noFlag.length) log(run, `⚠ Drapeaux manquants : ${noFlag.map((x) => x.country).join(", ")}`);
}

// ---------------------------------------------------------------- 5. rendu Remotion
function spawnRemotion(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["remotion", ...args], { cwd: REMOTION_DIR, shell: true, windowsHide: true });
    let err = "";
    child.stdout.on("data", (d) => { if (onLine) onLine(d.toString()); }); // OBLIGATOIRE : un pipe non lu fige le rendu
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-600) || "code " + code))));
  });
}
function carouselProps(run, rel) {
  const s = config().settings;
  const tl = run.timeline;
  const heroExists = fs.existsSync(path.join(runDir(run), "assets", "hero.jpg"));
  return {
    dir: rel, audio: "vo.wav", music: run.music && run.music.file ? "bgm.mp3" : undefined, musicVolume: run.params.musicVolume ?? s.musicVolume,
    title: run.meta.title, banner: run.meta.banner,
    intro: { seconds: tl.introSec, image: heroExists ? "hero.jpg" : undefined, kicker: run.meta.kicker, title: run.meta.title.replace(/\s*\d{4}\s*$/, ""), subtitle: run.meta.subtitle },
    outro: { seconds: +(tl.total - tl.outroStart).toFixed(3), text: "Thanks for watching", sub: "Which one surprised you? Tell us in the comments" },
    cards: run.items.map((x) => ({
      rank: x.rank, name: x.name, sub: run.meta.subKind === "country" ? x.country : (x.sub || x.country), flag: x.asset?.flag, image: x.asset?.image, fit: x.asset?.fit || "cover",
      value: x.display, unit: run.meta.unitLabel, extra: x.extra || "", start: x.start, end: x.end,
    })),
    theme: s.theme, totalSeconds: tl.total, hideRank: run.meta.mode === "catalog",
  };
}
function stagePublic(run) {
  const rel = `dr-${run.id}`;
  const pub = path.join(REMOTION_DIR, "public", rel);
  ensureDir(pub);
  const a = path.join(runDir(run), "assets");
  for (const f of fs.readdirSync(a)) fs.copyFileSync(path.join(a, f), path.join(pub, f));
  fs.copyFileSync(path.join(runDir(run), "vo.wav"), path.join(pub, "vo.wav"));
  if (run.music && run.music.file) fs.copyFileSync(path.join(runDir(run), run.music.file), path.join(pub, "bgm.mp3"));
  return rel;
}
async function stepRender(run, onProgress) {
  await collectMusic(run);
  saveRun(run);
  const rel = stagePublic(run);
  const props = carouselProps(run, rel);
  const propsFile = path.join(REMOTION_DIR, `${rel}.json`);
  fs.writeFileSync(propsFile, JSON.stringify(props));
  const out = path.join(runDir(run), "final.mp4");
  log(run, `🎬 Rendu Remotion (${Math.round(run.timeline.total)} s, ${Math.round(run.timeline.total * FPS)} images)…`);
  let last = 0;
  const t0 = Date.now();
  await spawnRemotion(["render", "DataCarousel", `"${out}"`, `--props=${path.basename(propsFile)}`, "--codec=h264", "--crf=20", "--log=info"], (line) => {
    const m = /Rendered\s+(\d+)\/(\d+)/.exec(line);
    if (m) { const pct = Math.round((100 * Number(m[1])) / Number(m[2])); if (pct - last >= 10) { last = pct; log(run, `🎬 rendu ${pct} %`); if (onProgress) onProgress(pct); } }
  });
  if (!fs.existsSync(out) || fs.statSync(out).size < 100000) throw new Error("Remotion n'a produit aucun fichier");
  run.output = { file: out, rel: `agent-os/output/machines/${run.id}/final.mp4`, seconds: await probe(out), renderMin: +((Date.now() - t0) / 60000).toFixed(1) };
  // miniature (4 cartes du haut du classement)
  try {
    const thumb = path.join(runDir(run), "thumb.png");
    await spawnRemotion(["still", "DataThumb", `"${thumb}"`, `--props=${path.basename(propsFile)}`]);
    run.output.thumb = thumb;
  } catch (e) { log(run, "miniature : " + e.message.slice(0, 160)); }
  try { fs.unlinkSync(propsFile); } catch {}
  log(run, `✅ Rendu : ${run.output.seconds.toFixed(1)} s en ${run.output.renderMin} min`);
}

// ---------------------------------------------------------------- 6. contrôle qualité du rendu
async function stepQa(run) {
  const out = run.output.file;
  const dir = path.join(runDir(run), "qa");
  ensureDir(dir);
  const n = run.items.length;
  const picks = [{ t: 3, what: "intro" }, ...[0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].map((k) => ({ t: run.items[k].start + 1.2, what: `carte #${run.items[k].rank} « ${run.items[k].name} » (${run.items[k].display}) commentée`, k })), { t: run.timeline.total - 1.5, what: "écran de fin" }];
  for (const p of picks) { p.file = path.join(dir, `qa-${Math.round(p.t)}.jpg`); await ffmpeg(["-ss", p.t.toFixed(2), "-i", out, "-frames:v", "1", "-q:v", "4", "-vf", "scale=768:-1", p.file]); } // > ~1000 px × plusieurs images : Qwen Flash renvoie « Provider returned error »
  const intro = [
    `Quality control of a rendered data-ranking carousel video "${run.meta.title}". For each frame, the expected content is given.`,
    "Check: everything readable, no text overflowing or cut INSIDE a fully visible card, no missing/broken image or flag, card being narrated fully visible and highlighted (yellow outline), cards look professional and consistent. Cards partially visible at the left/right screen edges are NORMAL (the carousel is scrolling) — never count their cut text as a problem.",
  ].join("\n");
  const img = (f) => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + fs.readFileSync(f).toString("base64") } });
  // Le fournisseur de Qwen (Alibaba) filtre certaines images (« data_inspection_failed » — ex. drapeau de Taïwan) :
  // lot complet d'abord, puis image par image ; une image bloquée est SIGNALÉE « non contrôlable », jamais bloquante.
  const ask = async (content, tries = 3) => {
    for (let a = 1; ; a++) {
      try { return await lab.askVision(content, { model: lab.VISION_MODEL }); }
      catch (e) { if (/inappropriate|data_inspection/i.test(e.message) || a >= tries) throw e; await sleep(8000 * a); }
    }
  };
  let json, cost = 0;
  try {
    const r = await ask([{ type: "text", text: intro + '\nReply JSON ONLY: {"frames":[{"i":0,"ok":true,"problems":""}],"overall":0,"summary":""} — overall = 0-10 quality score.' },
      ...picks.flatMap((p, i) => [{ type: "text", text: `Frame ${i} (t=${p.t.toFixed(1)} s) — expected: ${p.what}` }, img(p.file)])], 2);
    json = r.json; cost = r.cost;
  } catch (e) {
    const frames = [];
    for (const [i, p] of picks.entries()) {
      try {
        const r = await ask([{ type: "text", text: intro + `\nExpected: ${p.what}.\nReply JSON ONLY: {"ok":true,"problems":"","score":0}` }, img(p.file)]);
        cost += r.cost;
        const sc0 = Number(r.json.score) || null;
        frames.push({ i, ok: r.json.ok !== false, problems: r.json.problems || "", score: sc0 != null && sc0 > 10 ? +(sc0 / 10).toFixed(1) : sc0 }); // Qwen note parfois sur 100
      } catch (e2) { frames.push({ i, ok: null, problems: /inappropriate|data_inspection/i.test(e2.message) ? "non contrôlable (filtre de contenu du fournisseur Qwen)" : "contrôle indisponible : " + e2.message.slice(0, 60) }); }
    }
    const sc = frames.map((f) => f.score).filter((x) => x != null);
    json = { frames, overall: sc.length ? +(sc.reduce((a2, b2) => a2 + b2, 0) / sc.length).toFixed(1) : null, summary: `${frames.filter((f) => f.ok).length}/${frames.length} images validées, ${frames.filter((f) => f.ok === false).length} avec défaut, ${frames.filter((f) => f.ok === null).length} non contrôlables` };
  }
  if (json.overall > 10) json.overall = +(json.overall / 10).toFixed(1);
  addCost(run, "check", cost, "OpenRouter", "Qwen — contrôle du rendu");
  run.qa = { ...json, frames: (json.frames || []).map((f, i) => ({ ...f, t: picks[i] && picks[i].t })), duration: run.output.seconds, target: run.params.durationSec };
  log(run, `🧪 Contrôle du rendu : ${json.overall}/10 — ${json.summary || ""}`);
}

// ---------------------------------------------------------------- 7. packaging (SEO prêt à poster)
function mmss(t) { const s = Math.max(0, Math.floor(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
/** Tags : YouTube compte +2 car. par tag contenant un espace ; ≤ 500 pondérés. */
function capTags(tags, max = 480) {
  const out = [];
  let len = 0;
  for (const t of Array.isArray(tags) ? tags : String(tags || "").split(",")) {
    const x = String(t).replace(/[<>#]/g, "").trim();
    if (!x || out.some((o) => o.toLowerCase() === x.toLowerCase())) continue;
    const add = x.length + (x.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (len + add > max) break;
    out.push(x); len += add;
  }
  return out;
}
function chaptersOf(run) {
  // YouTube : 1er chapitre à 0:00, chapitres ≥ 10 s — sinon la liste n'est pas reconnue
  const list = [{ t: 0, label: "Intro" }];
  for (const x of run.items) {
    const t = Math.max(0, Math.floor(x.start - 0.5));
    if (t - list[list.length - 1].t < 10) continue;
    list.push({ t, label: run.meta.mode === "catalog" ? `${x.country} — ${x.name}` : `#${x.rank} ${x.name}${x.country ? ` (${x.country})` : ""} — ${x.display}` });
  }
  return list.map((c) => `${mmss(c.t)} ${c.label}`);
}
function nicheInspiration() {
  const c = config();
  if (!c.nicheId) return "";
  try { return require("../bank").inspiration(c.nicheId, { maxTitles: 15, maxVisions: 0 }); } catch { return ""; }
}
const SEO_RULES = [
  "- title: the niche formula, 45-90 characters, the year when relevant, NO emoji, no clickbait caps (\"Tallest Building in Every Country 2026\", \"Martial Arts From Different Countries\", \"50 Richest Supermarkets Around The World 2026\", \"Ranking Countries by Number of Billionaires 2026\").",
  "- description: §1 hook (2 sentences, with the most striking number/entry), §2 what the video compares and the criterion, §3 \"Data: Wikipedia / Wikidata (2026). Images: illustrations and photos for information.\", then the exact line CHAPTERS_HERE, then \"Subscribe for more data comparisons!\" and 3-5 hashtags (#datacomparison #ranking …).",
  "- tags: 18-28 SEO tags from precise to broad, in the niche vocabulary (topic + 2026, 'country data', 'comparison', 'data comparison', 'real data', 'ranking', 'countries compared', 'comparison video', 'from different countries' when catalog…).",
].join("\n");
async function stepPackage(run) {
  const lang = config().settings.chainLanguage || "English";
  const chapters = chaptersOf(run);
  const p = await askJson([
    `Write the YouTube packaging (${lang}) for a data carousel video. Working title: "${run.meta.title}". Topic: "${run.params.topic}". Format: ${run.meta.mode === "catalog" ? "one entry per country (catalog)" : "ascending ranking"}.`,
    `Entries (in video order): ${run.items.map((x) => `${x.name}${x.country ? " (" + x.country + ")" : ""}${run.meta.mode === "catalog" ? "" : " " + x.display}`).join(", ")}.`,
    SEO_RULES,
    nicheInspiration() ? "WHAT PERFORMS IN THE NICHE (title and tag codes to reuse, never copy):\n" + nicheInspiration() : "",
    '- titleAlt: 2 alternative titles in the same style.',
    'Reply JSON ONLY: {"title":"","description":"","tags":[""],"titleAlt":["",""]}',
  ].filter(Boolean).join("\n"), "Packaging");
  const title = String(p.title || run.meta.title).replace(/["«»]/g, "").slice(0, 100);
  const desc = String(p.description || "").replace(/^\s*title\s*:.*\n+/i, "");
  run.pack = {
    title, titleAlt: p.titleAlt || [], chapters,
    description: desc.includes("CHAPTERS_HERE") ? desc.replace(/\s*CHAPTERS_HERE\s*/, "\n\n" + chapters.join("\n") + "\n\n") : `${desc}\n\n${chapters.join("\n")}`,
    tags: capTags(p.tags || []),
    banner: run.meta.banner,
    thumbRel: run.output && run.output.thumb ? `agent-os/output/machines/${run.id}/thumb.png` : null, thumbTs: Date.now(),
  };
  delete run.package;
  run.finalRel = run.output.rel;
  fs.writeFileSync(path.join(runDir(run), "youtube.txt"), `${run.pack.title}\n\n${run.pack.description}\n\nTAGS: ${run.pack.tags.join(", ")}\n`);
  addToStock(run);
  log(run, "📦 Packaging prêt (titre, description + chapitres, tags) — vidéo ajoutée au stock");
  if (run.params.publishChannelId) {
    try { const pub = await publishRun(run.id, {}, run); log(run, `📤 Publiée : ${pub.url} (${pub.privacyStatus})`); }
    catch (e) { log(run, "⚠ Publication échouée : " + e.message); }
  }
}
/** Réécrit titre / description / tags (consigne optionnelle). */
async function regenTexts(runId, { field = "all", instructions = "" } = {}) {
  const run = getRun(runId);
  if (!run || !run.pack) throw new Error("Pas encore de packaging");
  const want = field === "all" ? ["title", "description", "tags"] : [field];
  const j = await askJson([
    `Rewrite ${want.join(", ")} of this YouTube data carousel video (${config().settings.chainLanguage || "English"}). Current title: "${run.pack.title}". Topic: "${run.params.topic}".`,
    `Entries shown in the video (mention ONLY these, never invent others): ${run.items.map((x) => `${x.name}${x.country ? " (" + x.country + ")" : ""}${run.meta.mode === "catalog" ? "" : " " + x.display}`).join(", ")}.`,
    instructions ? `User instruction (priority): ${instructions}` : "",
    SEO_RULES,
    "Never repeat the title inside the description, no 'Title:' line.",
    want.includes("description") ? "Keep the line CHAPTERS_HERE where the chapters go." : "",
    `Reply JSON ONLY with only these keys: ${want.map((f) => `"${f}"`).join(", ")}`,
  ].filter(Boolean).join("\n"), "Textes");
  // seuls les champs DEMANDÉS sont appliqués (le modèle renvoie parfois un titre non sollicité)
  if (j.title && want.includes("title")) run.pack.title = String(j.title).replace(/["«»]/g, "").slice(0, 100);
  if (j.description && want.includes("description")) { const d = String(j.description).replace(/^\s*title\s*:.*\n+/i, ""); run.pack.description = d.includes("CHAPTERS_HERE") ? d.replace(/\s*CHAPTERS_HERE\s*/, "\n\n" + run.pack.chapters.join("\n") + "\n\n") : `${d}\n\n${run.pack.chapters.join("\n")}`; }
  if (j.tags && want.includes("tags")) run.pack.tags = capTags(j.tags);
  saveRun(run);
  syncStock(run);
  return getRun(runId);
}
/** Enregistre les textes édités à la main dans l'écran Fini. */
function saveTexts(runId, { title, description, tags } = {}) {
  const run = getRun(runId);
  if (!run || !run.pack) throw new Error("Pas encore de packaging");
  if (title !== undefined) run.pack.title = String(title).slice(0, 100);
  if (description !== undefined) run.pack.description = String(description);
  if (tags !== undefined) run.pack.tags = capTags(tags);
  saveRun(run);
  syncStock(run);
  return run.pack;
}
/** Recompose la miniature (bandeau) sans rien repayer : Remotion still DataThumb. */
async function restyleThumbnail(runId, { banner } = {}) {
  const run = getRun(runId);
  if (!run || !run.output) throw new Error("Pas encore de rendu");
  const rel = stagePublic(run);
  const props = carouselProps(run, rel);
  if (banner) props.banner = String(banner).slice(0, 60);
  const propsFile = path.join(REMOTION_DIR, `${rel}-thumb.json`);
  fs.writeFileSync(propsFile, JSON.stringify(props));
  const thumb = path.join(runDir(run), "thumb.png");
  try { await spawnRemotion(["still", "DataThumb", `"${thumb}"`, `--props=${path.basename(propsFile)}`]); }
  finally { try { fs.unlinkSync(propsFile); } catch {} }
  run.output.thumb = thumb;
  run.pack = run.pack || {};
  run.pack.thumbRel = `agent-os/output/machines/${run.id}/thumb.png`;
  run.pack.thumbTs = Date.now();
  if (banner) run.pack.banner = props.banner;
  saveRun(run);
  syncStock(run);
  return run.pack;
}

// ---------------------------------------------------------------- stock + publication YouTube
const STOCK_FILE = `machines/${MACHINE_ID}-stock.json`;
function stock() { return readJSON(STOCK_FILE, []); }
function patchStock(entryId, patch = {}) {
  const st = stock();
  const e = st.find((x) => x.id === entryId || x.runId === entryId);
  if (!e) throw new Error("Entrée de stock introuvable");
  for (const k of ["archived", "posted"]) if (patch[k] !== undefined) e[k] = !!patch[k];
  writeJSON(STOCK_FILE, st);
  return e;
}
function stockEntry(run) {
  return { id: run.id, runId: run.id, title: run.pack.title, description: run.pack.description, tags: run.pack.tags, finalRel: run.finalRel, thumbRel: run.pack.thumbRel,
    durationSec: run.output ? run.output.seconds : null, cards: (run.items || []).length, cost: run.cost };
}
function addToStock(run) {
  const st = stock();
  if (st.some((x) => x.id === run.id)) return syncStock(run);
  st.unshift({ ...stockEntry(run), createdAt: new Date().toISOString(), posted: false, archived: false });
  writeJSON(STOCK_FILE, st);
}
function syncStock(run) {
  const st = stock();
  const e = st.find((x) => x.id === run.id);
  if (!e || !run.pack) return;
  Object.assign(e, stockEntry(run));
  writeJSON(STOCK_FILE, st);
}
async function publishRun(runId, { channelId, title, description, tags, privacyStatus } = {}, liveRun = null) {
  const google = require("../google");
  const run = liveRun || getRun(runId);
  if (!run.finalRel) throw new Error("Pas de vidéo à publier");
  const chan = channelId || run.params.publishChannelId;
  if (!chan) throw new Error("Choisis une chaîne");
  if (title !== undefined || description !== undefined || tags !== undefined) saveTexts(runId, { title, description, tags });
  const pk = (liveRun ? run.pack : getRun(runId).pack) || {};
  const priv = privacyStatus || run.params.publishPrivacy || config().settings.publishPrivacy || "private";
  const vid = await google.youtubeUpload(chan, path.join(ROOT, run.finalRel), {
    title: (pk.title || run.meta.title).slice(0, 100), description: pk.description || "", tags: (pk.tags || []).slice(0, 60), privacyStatus: priv, categoryId: "27",
  });
  if (pk.thumbRel) {
    try { await google.youtubeSetThumbnail(chan, vid.id, path.join(ROOT, pk.thumbRel)); }
    catch (e) { log(run, "⚠ " + e.message + " — la vidéo est en ligne, pose la miniature à la main."); }
  }
  run.published = { videoId: vid.id, url: `https://youtu.be/${vid.id}`, at: new Date().toISOString(), privacyStatus: priv, channelId: chan };
  if (!liveRun) { const fresh = getRun(runId); fresh.published = run.published; saveRun(fresh); } else saveRun(run);
  try { patchStock(run.id, { posted: true }); } catch {}
  return run.published;
}

// ---------------------------------------------------------------- régénérations ciblées (hors génération)
/** ↻ une image : non destructif (l'ancienne reste si la nouvelle échoue) ; la vidéo devra être re-rendue. */
async function regenImage(runId, rank, instructions = "") {
  if (live.has(runId)) throw new Error("Le run génère — attends la fin de l'étape en cours.");
  const run = getRun(runId);
  const k = run.items.findIndex((x) => x.rank === Number(rank));
  if (k < 0) throw new Error("Carte introuvable");
  const it = run.items[k];
  const old = it.asset;
  it.asset = { flag: old && old.flag };
  it.userHint = instructions || "";
  it.pending = true; saveRun(run);
  try { await assetFor(run, it, k); if (!it.asset.image) throw new Error(it.asset.error || "aucune image"); }
  catch (e) { it.asset = old; delete it.pending; delete it.userHint; saveRun(run); throw e; }
  it.asset.ts = Date.now();
  delete it.pending; delete it.userHint;
  if (run.output) run.needsRender = true;
  log(run, `↻ Image de « ${it.name} » régénérée${instructions ? ` (consigne : ${instructions})` : ""}${run.output ? " — relance le rendu pour l'intégrer" : ""}`);
  saveRun(run);
  return getRun(runId);
}
/** Édition d'une phrase (ou de l'intro/outro) tant que la voix n'est pas faite (mode semi, étape Script). */
function editLine(runId, { rank, text, part } = {}) {
  const run = getRun(runId);
  if (!run.script) throw new Error("Pas encore de script");
  if (run.timeline) throw new Error("La voix est déjà générée — relance à partir de « Script » pour modifier le texte.");
  if (part === "intro" || part === "outro") run.script[part] = String(text || "");
  else { const it = run.items.find((x) => x.rank === Number(rank)); if (!it) throw new Error("Carte introuvable"); it.line = String(text || ""); run.script.lines = run.items.map((x) => x.line); }
  saveRun(run);
  return run.script;
}

// ---------------------------------------------------------------- orchestration
const STEPS = [
  ["data", stepData, (r) => r.items && r.items.length],
  ["script", stepScript, (r) => r.script && r.script.lines],
  ["voice", stepVoice, (r) => r.timeline && fs.existsSync(path.join(OUT_ROOT, r.id, "vo.wav"))],
  ["assets", stepAssets, (r) => r.items.every((x) => x.asset && (x.asset.image || x.asset.error))],
  ["render", stepRender, (r) => r.output && fs.existsSync(r.output.file)],
  ["qa", stepQa, (r) => !!r.qa],
  ["package", stepPackage, (r) => !!r.pack],
];
// mode semi-manuel : la machine s'arrête après ces étapes et attend « ✓ Valider » (écran wizard)
const SEMI_STOPS = ["data", "script", "assets"];
function createRun({ topic, durationSec, durationMin, voice, imageModel, language, count, mode, music, musicVolume, publishChannelId, publishPrivacy } = {}) {
  if (!topic || !String(topic).trim()) throw new Error("sujet manquant");
  const s = config().settings;
  const id = "dr" + Date.now().toString(36);
  const dur = Number(durationSec) || (Number(durationMin) ? Number(durationMin) * 60 : 0) || (s.durationMin || 5) * 60;
  const run = { id, machineId: MACHINE_ID, createdAt: new Date().toISOString(), status: "created", title: String(topic).trim(),
    params: { topic: String(topic).trim(), durationSec: dur, voice: voice || s.voice, imageModel: imageModel || s.imageModel, language: language || s.language, count: count || null,
      mode: mode === "semi" ? "semi" : "auto", music: music ?? s.music, musicVolume: musicVolume ?? s.musicVolume,
      publishChannelId: publishChannelId || null, publishPrivacy: publishPrivacy || s.publishPrivacy || "private" },
    cost: {}, log: [], validated: {} };
  saveRun(run);
  return run;
}
const live = new Set();
const cancelled = new Set();
async function advance(runId, { until } = {}) {
  if (live.has(runId)) throw new Error("run déjà en cours");
  live.add(runId);
  const run = getRun(runId);
  let task = null;
  try { task = tasks.createTask({ title: `Data Ranking — ${run.params.topic}`, desc: `${Math.round(run.params.durationSec / 60)} min`, machine: MACHINE_NAME, machineId: MACHINE_ID, runId, kind: "machine", step: "Démarrage…", progress: 2, status: "running" }); } catch {}
  try {
    for (let i = 0; i < STEPS.length; i++) {
      const [name, fn, done] = STEPS[i];
      if (cancelled.has(runId)) throw new Error("Annulée par l'utilisateur");
      if (done(run)) {
        // semi : une étape faite mais pas encore validée → on s'arrête dessus
        if (run.params.mode === "semi" && SEMI_STOPS.includes(name) && !(run.validated || {})[name]) { run.status = `${name}_ready`; break; }
        continue;
      }
      run.status = `${name}_running`; saveRun(run);
      try { if (task) tasks.updateTask(task.id, { step: name, progress: Math.round((100 * i) / STEPS.length) }); } catch {}
      await fn(run, (pct) => { try { if (task) tasks.updateTask(task.id, { step: `rendu ${pct} %` }); } catch {} });
      run.status = `${name}_done`; saveRun(run);
      if (until === name) break;
      if (run.params.mode === "semi" && SEMI_STOPS.includes(name) && !(run.validated || {})[name]) { run.status = `${name}_ready`; break; }
    }
    if (run.pack && !/_ready$/.test(run.status)) { run.status = "done"; delete run.needsRender; delete run.error; delete run.cancelled; }
    saveRun(run);
    try {
      if (task) {
        if (run.status === "done") tasks.updateTask(task.id, { status: "done", progress: 100, step: `Terminée — ${run.items.length} cartes, ${Math.floor(run.output.seconds / 60)} min ${Math.round(run.output.seconds % 60)} s` });
        else if (/_ready$/.test(run.status)) tasks.updateTask(task.id, { status: "running", step: `En attente de validation (${run.status.replace("_ready", "")})` });
      }
    } catch {}
    return run;
  } catch (e) {
    run.status = "failed"; run.error = e.message; if (cancelled.has(runId)) run.cancelled = true; log(run, "❌ " + e.message); saveRun(run);
    try { if (task) tasks.updateTask(task.id, { status: "failed", step: e.message.slice(0, 120) }); } catch {}
    throw e;
  } finally { live.delete(runId); cancelled.delete(runId); }
}
/** ✓ Valider (mode semi) : marque l'étape affichée comme validée et relance la suite. */
function validate(runId) {
  const run = getRun(runId);
  if (!/_ready$/.test(run.status || "")) throw new Error("Rien à valider à cette étape.");
  const step = run.status.replace("_ready", "");
  if (step === "assets" && run.items.some((x) => x.pending)) throw new Error("Une image est en cours de régénération — attends la fin.");
  run.validated = { ...(run.validated || {}), [step]: true };
  saveRun(run);
  return start(runId);
}
function cancelRun(runId) {
  const run = getRun(runId);
  if (live.has(runId)) { cancelled.add(runId); log(run, "🛑 Annulation demandée — arrêt à la fin de l'opération en cours"); return summary(run); }
  if (run.status !== "done") { run.status = "failed"; run.error = "Annulée par l'utilisateur"; run.cancelled = true; saveRun(run); }
  return summary(getRun(runId));
}
/** Réinitialise une étape (et les suivantes) pour la relancer — non destructif pour les médias déjà produits hors étape. */
function resetFrom(run, step) {
  const order = STEPS.map((s) => s[0]);
  const i = order.indexOf(step);
  if (i < 0) throw new Error("étape inconnue");
  if (i <= 0) { delete run.items; delete run.meta; }
  if (i <= 1) delete run.script;
  if (i <= 2) { delete run.timeline; delete run.voiceDur; try { fs.rmSync(path.join(OUT_ROOT, run.id, "voice"), { recursive: true, force: true }); fs.rmSync(path.join(OUT_ROOT, run.id, "vo.wav"), { force: true }); } catch {} } // la voix est en cache par rang : un script refait doit repartir de zéro
  if (i === 0 || step === "assets") for (const x of run.items || []) delete x.asset; // les images ne dépendent ni du script ni de la voix
  if (i <= 4) delete run.output;
  if (i <= 5) delete run.qa;
  delete run.package; delete run.pack; delete run.finalRel;
  // en semi, relancer une étape redemande sa validation (et celle des suivantes)
  if (run.validated) for (const k of order.slice(i)) delete run.validated[k];
  saveRun(run);
  return run;
}
// Au boot on ne marque rien : un run peut tourner dans un process CLI (scripts/datarank.js). Le cron « Sauvetage »
// du serveur propose la reprise par Telegram (✅/❌) des runs restés « en cours » sans moteur en mémoire.
function sweepRuns() { return 0; }
function strandedRuns() {
  return listRuns().filter((r) => /_running$/.test(r.status || "") && !live.has(r.id) && Date.now() - new Date(r.updatedAt || r.createdAt).getTime() > 20 * 60 * 1000)
    .map((r) => ({ id: r.id, machine: MACHINE_NAME, machineId: MACHINE_ID, theme: r.params.topic, status: r.status }));
}
function resumeRun(runId) { return start(runId); }

// ---------------------------------------------------------------- idées, estimation, livraison
/** Titres les plus vus de la banque de niche (Labo) → inspiration des idées. */
function nicheTitles(limit = 60) {
  const dir = path.join(DATA_DIR, "lab", "channels");
  const ids = ["UCAFsE4Myo2a-muzsvpxWDAw", "UC_OnwGk1utEysbEx-N9eDJA", "UCYsjSWV3S6YjfU0nEF36BDg", "UCT_Q2P3TpSwmcYmNEEHXwAQ", "UCZIuN-UrmKiZ8mgS8hYDsjg", "UCNxcM0w1Yx4WEIgm0dDh09A", "UCK0A8GVZDtSp9M9pTXgWwAQ", "UCsD2ZAnMwn8Q0ON1n1vwwRQ", "UCwL2hVAahI0BgM617iUPt0Q", "UC4OF8RtPTk9Wvdg-mH1pchw"];
  const vids = [];
  for (const id of config().channels || ids) {
    const c = readJSON(`lab/channels/${id}.json`, null);
    if (c) for (const v of c.videos || []) vids.push({ title: v.title, views: v.views, channel: c.title });
  }
  // pas encore de Labo sur cette installation → banque embarquée (titres publics les plus vus des 10 chaînes de référence)
  if (!vids.length) { try { vids.push(...require("./datarank-niche.json").titles); } catch {} }
  return vids.sort((a, b) => b.views - a.views).slice(0, limit);
}
function producedTopics() { return listRuns().map((r) => (r.meta && r.meta.title) || r.params.topic).filter(Boolean); }
async function suggestTopics(n = 6) {
  const top = nicheTitles(70);
  const j = await askJson([
    `Propose EXACTLY ${n} topics for a YouTube "data ranking" carousel video (cards sorted ascending, one numeric value per card, real verifiable data available on Wikipedia).`,
    "Inspire yourself from what works best in the niche (most viewed titles below) but NEVER copy a title; mix families: rankings of countries by a number, 'X in every country', richest/biggest/oldest/fastest things, records, famous people by a metric.",
    "Each topic must have one clear numeric criterion and at least 40 well-documented entries.",
    `Never propose one of these already produced topics nor a close variant: ${JSON.stringify(producedTopics())}.`,
    'JSON ONLY: {"ideas":[{"topic":"English topic as it would appear in the title","why":"pourquoi ça marche (français, 1 phrase)","criterion":"the numeric value shown on each card"}]}',
    "TOP NICHE TITLES: " + JSON.stringify(top.map((v) => `${v.title} (${v.views} views, ${v.channel})`)),
  ].join("\n"), "Idées");
  return j.ideas || [];
}
function estimate({ durationSec = 300, voice, imageModel } = {}) {
  const s = config().settings;
  const n = cardCount(Number(durationSec) || 300, s, voice || s.voice);
  const m = IMG_MODELS[imageModel || s.imageModel] || IMG_MODELS.gpt25;
  const images = n * 1.35 * m.price; // ~35 % de régénérations après contrôle
  const voiceUsd = ((n * 130 + 400) / 1000) * PRICES.ttsPer1kChars;
  const llmUsd = 0.03, check = n * 0.0015;
  const total = images + voiceUsd + PRICES.music + llmUsd + check;
  return { cards: n, wpm: voiceWpm(voice || s.voice, s), usd: +total.toFixed(2), detail: { images: +images.toFixed(2), voice: +voiceUsd.toFixed(3), music: PRICES.music, llm: llmUsd, check: +check.toFixed(3) } };
}
async function suggestThemes(count = 1) {
  const ideas = await suggestTopics(Math.min(Math.max(Number(count) || 1, 1), 8));
  return ideas.map((i) => ({ title: i.topic, text: i.topic, pitch: i.why }));
}
async function orderRun({ publishChannelId, publishPrivacy, publish, overrides, theme } = {}) {
  const last = listRuns()[0];
  const base = { ...((last && last.params) || {}), ...(overrides || {}) };
  const topic = theme ? (typeof theme === "string" ? theme : theme.text || theme.title) : (await suggestThemes(1))[0].text;
  const r = createRun({ ...base, topic, count: null, mode: "auto", publishChannelId: publish ? publishChannelId : null, publishPrivacy: publishPrivacy || "private" });
  start(r.id);
  return r;
}
function summary(r) {
  if (r && r.package && !r.pack) r = getRun(r.id);
  return { id: r.id, createdAt: r.createdAt, status: r.status, error: r.error, topic: r.params.topic, title: (r.pack && r.pack.title) || (r.meta && r.meta.title) || r.params.topic, durationSec: r.params.durationSec,
    mode: r.params.mode || "auto", cards: (r.items || []).length, seconds: r.output && r.output.seconds, cost: +Object.values(r.cost || {}).reduce((a, b) => a + b, 0).toFixed(2), qa: r.qa && r.qa.overall, running: live.has(r.id),
    published: r.published || null, thumb: r.output && r.output.thumb ? `agent-os/output/machines/${r.id}/thumb.png` : null, last: (r.log || []).slice(-1)[0] };
}
function start(runId, from) {
  const run = getRun(runId);
  if (!run) throw new Error("run introuvable");
  if (live.has(runId)) throw new Error("run déjà en cours");
  if (from) resetFrom(run, from);
  else if (run.error || run.status === "failed") { delete run.error; delete run.cancelled; saveRun(run); }
  advance(runId).catch(() => {});
  return summary(getRun(runId));
}

module.exports = {
  MACHINE_ID, MACHINE_NAME, DEFAULTS, IMG_MODELS, config, patchConfig, listRuns, getRun, saveRun, createRun, advance, resetFrom,
  sweepRuns, strandedRuns, cardCount, carouselProps, stagePublic, wikiPages, wikidataEntities,
  suggestTopics, suggestThemes, orderRun, estimate, summary, start, resumeRun, validate, cancelRun, voiceWpm, REF_WPM, isLive: (id) => live.has(id),
  stock, patchStock, publishRun, regenTexts, saveTexts, restyleThumbnail, regenImage, editLine,
};
