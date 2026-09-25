/**
 * LABO DE NICHE — scraping COMPLET d'une chaîne YouTube + décorticage image par image de ses vidéos.
 *
 * Pourquoi un module à part du Scrap-o-matic (Apify + vision Gemini) : ici tout est LOCAL et quasi gratuit.
 * - yt-dlp : liste complète des vidéos longues d'une chaîne (zéro quota API), métadonnées riches
 *   (vues, likes, commentaires, tags, description, chapitres), sous-titres auto mot-à-mot, téléchargement 480p.
 * - FFmpeg : détection des plans (coupes) + extraction d'une image toutes les N secondes, horodatée.
 * - Qwen 3.7 Flash (OpenRouter, multimodal, 0,03 $/M tokens) : lit les images par paquets et rend, PLAN PAR
 *   PLAN, la nature du visuel (stock vidéo / photo / image IA / avatar / motion design / graphique), le mouvement
 *   de caméra (zoom, pan…), le texte à l'écran, la requête stock équivalente. Puis une synthèse narrative par vidéo.
 * - Les résultats sont ÉCRITS AUSSI dans les fichiers du Scrap-o-matic (data/scrap/…) : la Banque de Niches,
 *   `bank.inspiration()` et les miniatures concurrentes (`scrap.channelThumbs`) fonctionnent sans rien changer.
 *
 * Données : data/lab/channels/<channelId>.json (scan complet), data/lab/videos/<videoId>.json (analyse),
 *           output/lab/<chaîne>/<videoId>/ (images extraites, contact-sheet). La vidéo 480p est supprimée après extraction.
 */
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { DATA_DIR, ensureDir, readJSON, writeJSON } = require("./store");
const llm = require("./llm");
const spend = require("./spend");
const tasks = require("./tasks");
const scrap = require("./scrap");
const bank = require("./bank");

const LAB_DIR = path.join(DATA_DIR, "lab");
const OUT_LAB = path.join(__dirname, "..", "output", "lab");
const OUT_SCRAPING = path.join(__dirname, "..", "output", "scraping");
ensureDir(path.join(LAB_DIR, "channels"));
ensureDir(path.join(LAB_DIR, "videos"));
ensureDir(OUT_LAB);

const VISION_MODEL = "qwen/qwen3.7-flash"; // images → plans (très bon marché)
const TEXT_MODEL = "qwen/qwen3.7-plus";    // synthèse narrative par vidéo
const FRAME_EVERY = 2;                     // une image toutes les 2 s
const CHUNK_SEC = 60;                      // 60 s de vidéo (= 30 images) par appel Qwen
const SCENE_THRESHOLD = 0.28;

const safe = (s) => String(s || "sans-nom").replace(/[^\wÀ-ſ .-]+/g, "_").slice(0, 60).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- outils locaux
function run(bin, args, { timeoutMs = 10 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 * 1024, cwd }, (e, out, err) => {
      if (e) {
        if (e.code === "ENOENT") return reject(new Error(`${bin} introuvable — installe-le et ajoute-le au PATH`));
        return reject(new Error(`${bin} : ${String(err || e.message).trim().slice(-400)}`));
      }
      resolve({ out: String(out), err: String(err) });
    });
  });
}
/** ffmpeg avec stderr capturé (showinfo écrit sur stderr) ; stdout drainé (pipe non lu = gel). */
function ffmpegCapture(args, { timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg : délai dépassé")); }, timeoutMs);
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error("FFmpeg introuvable : " + e.message)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(err) : reject(new Error("FFmpeg : " + err.slice(-400))); });
  });
}
async function probeDuration(file) {
  const { out } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file]);
  const d = Number(String(out).trim());
  if (!isFinite(d) || d <= 0) throw new Error("durée illisible : " + path.basename(file));
  return d;
}

// ---------------------------------------------------------------- yt-dlp
// YouTube limite par IP (HTTP 429 « Too Many Requests », « Sign in to confirm you're not a bot ») dès qu'on
// enchaîne trop vite : appels SÉQUENTIELS (un seul yt-dlp à la fois), pause entre requêtes, et relance avec
// attente croissante (2, 4, 8 min) plutôt qu'un échec sec — un scan de chaîne dure des minutes, pas des secondes.
// Téléchargement : client « android » (le client web renvoie 403 sur les flux média depuis 2026-09).
// Les MÉTADONNÉES (liste des vidéos, vues, tags, description) passent par l'API Data YouTube (1 unité / 50 vidéos,
// jamais limitée par IP) ; yt-dlp ne sert qu'aux sous-titres et au téléchargement 480p.
let ytChain = Promise.resolve();
const YT_COMMON = ["--sleep-requests", "1", "--retries", "3", "--no-warnings"];
function ytdlp(args, { timeoutMs = 10 * 60 * 1000, tries = 4 } = {}) {
  const job = async () => {
    let last;
    for (let a = 1; a <= tries; a++) {
      try { return await run("yt-dlp", [...YT_COMMON, ...args], { timeoutMs }); }
      catch (e) {
        last = e;
        const throttled = /429|Too Many Requests|not a bot|Sign in to confirm/i.test(e.message);
        if (a === tries || !throttled) break;
        const wait = 120000 * Math.pow(2, a - 1);
        console.log(`[lab] YouTube limite les requêtes — pause ${Math.round(wait / 60000)} min avant relance (${a}/${tries})`);
        await sleep(wait);
      }
    }
    throw last;
  };
  const p = ytChain.then(job, job);
  ytChain = p.catch(() => {});
  return p;
}
const isoDur = (iso) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ""); return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : 0; };
const ytApi = () => require("./youtube");
/** URL / @handle / UC… → { channelId, title, subscribers, videoCount, uploads, avatar } (API Data, 1 unité). */
async function resolveChannel(input) {
  const q = String(input || "").trim();
  let id = null, handle = null;
  const m = /youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.\-]+))/i.exec(q);
  if (m) { if (m[1]) id = m[1]; else handle = m[2]; }
  else if (/^UC[\w-]{22}$/.test(q)) id = q;
  else if (/^@[\w.\-]+$/.test(q)) handle = q;
  else handle = "@" + q;
  const params = { part: "snippet,statistics,contentDetails" };
  if (id) params.id = id; else params.forHandle = handle;
  const d = await ytApi().dataApi("channels", params, 1, "Labo de niche", "Résolution chaîne");
  const it = d.items && d.items[0];
  if (!it) throw new Error(`Chaîne introuvable : ${q}`);
  return {
    channelId: it.id, title: it.snippet.title, handle: it.snippet.customUrl || handle || "", subscribers: Number(it.statistics.subscriberCount) || 0,
    videoCount: Number(it.statistics.videoCount) || 0, totalViews: Number(it.statistics.viewCount) || 0,
    uploads: it.contentDetails?.relatedPlaylists?.uploads || "UU" + it.id.slice(2), avatar: it.snippet.thumbnails?.default?.url || null,
    description: it.snippet.description || "", createdAt: it.snippet.publishedAt || "",
  };
}
/** Toutes les vidéos d'une chaîne via l'API Data (playlist uploads → videos.list) : vues, durée, tags, description. */
async function channelVideosApi(channelId, { max = 500 } = {}) {
  const uploads = "UU" + channelId.slice(2);
  const ids = [];
  let pageToken = "";
  while (ids.length < max) {
    const params = { part: "contentDetails", playlistId: uploads, maxResults: "50" };
    if (pageToken) params.pageToken = pageToken;
    const d = await ytApi().dataApi("playlistItems", params, 1, "Labo de niche", "Liste des vidéos");
    for (const it of d.items || []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    pageToken = d.nextPageToken;
    if (!pageToken) break;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await ytApi().dataApi("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(","), maxResults: "50" }, 1, "Labo de niche", "Stats vidéos");
    for (const v of d.items || []) {
      const dur = isoDur(v.contentDetails?.duration);
      out.push({
        videoId: v.id, title: v.snippet?.title || "", views: Number(v.statistics?.viewCount) || 0, duration: dur,
        date: (v.snippet?.publishedAt || "").slice(0, 10).replace(/-/g, ""),
        meta: {
          videoId: v.id, title: v.snippet?.title || "", description: v.snippet?.description || "", tags: v.snippet?.tags || [], categories: [v.snippet?.categoryId || ""],
          views: Number(v.statistics?.viewCount) || 0, likes: Number(v.statistics?.likeCount) || 0, comments: Number(v.statistics?.commentCount) || 0,
          duration: dur, date: (v.snippet?.publishedAt || "").slice(0, 10).replace(/-/g, ""), thumbnailUrl: (v.snippet?.thumbnails?.maxres || v.snippet?.thumbnails?.high || v.snippet?.thumbnails?.medium || {}).url || "",
          channelId: v.snippet?.channelId, channel: v.snippet?.channelTitle, subscribers: 0, chapters: [],
        },
      });
    }
  }
  // Vidéos longues seulement (pas de Shorts), du plus récent au plus ancien (ordre de la playlist uploads)
  return out.filter((v) => v.duration >= 61);
}
function parseFlat(out) {
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [id, views, duration, date, ...t] = l.split("\t");
    return { videoId: id, views: Number(views) || 0, duration: Number(duration) || 0, date: date && date !== "NA" ? date : "", title: t.join("\t") };
  }).filter((v) => v.videoId && v.videoId.length === 11);
}
/** Liste COMPLÈTE des vidéos longues d'une chaîne (onglet /videos, sans Shorts), du plus récent au plus ancien. */
async function channelVideos(channelId, { max = 400 } = {}) {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  const { out } = await ytdlp([url, "--flat-playlist", "--playlist-end", String(max), "--print", "%(id)s\t%(view_count)s\t%(duration)s\t%(upload_date)s\t%(title)s"]);
  return parseFlat(out).filter((v) => v.duration >= 61);
}
/** Métadonnées riches d'une vidéo (1 appel yt-dlp, ~2 s). */
async function videoMeta(videoId) {
  const { out } = await ytdlp(["--dump-json", "--no-playlist", `https://www.youtube.com/watch?v=${videoId}`]);
  const j = JSON.parse(out);
  return {
    videoId, title: j.title, description: j.description || "", tags: j.tags || [], categories: j.categories || [],
    views: Number(j.view_count) || 0, likes: Number(j.like_count) || 0, comments: Number(j.comment_count) || 0,
    duration: Number(j.duration) || 0, date: j.upload_date || "", thumbnailUrl: j.thumbnail || "",
    channelId: j.channel_id, channel: j.channel, subscribers: Number(j.channel_follower_count) || 0,
    chapters: (j.chapters || []).map((c) => ({ start: c.start_time, end: c.end_time, title: c.title })),
  };
}
/** Sous-titres automatiques (json3 = mots horodatés) → { text, words:[{t,end,w}], lang }. null si absents. */
async function transcript(videoId, dir, lang = "en") {
  ensureDir(dir);
  const base = path.join(dir, "subs");
  try {
    await ytdlp(["--skip-download", "--write-auto-subs", "--write-subs", "--sub-lang", `${lang},${lang}-orig,en`, "--sub-format", "json3", "-o", base + ".%(ext)s", "--no-playlist", "-q", `https://www.youtube.com/watch?v=${videoId}`], { tries: 1 }); // 1 seul essai : l'endpoint timedtext est le premier à renvoyer 429, le repli Apify prend le relais
  } catch (e) { /* limité ou sans sous-titres : repli Apify ci-dessous */ }
  const f = fs.readdirSync(dir).find((x) => x.startsWith("subs.") && x.endsWith(".json3"));
  if (!f) return transcriptApify(videoId);
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const words = [];
  for (const ev of j.events || []) {
    if (!ev.segs) continue;
    const t0 = Number(ev.tStartMs) || 0;
    const dur = Number(ev.dDurationMs) || 0;
    for (let k = 0; k < ev.segs.length; k++) {
      const s = ev.segs[k];
      const w = String(s.utf8 || "").replace(/\s+/g, " ").trim();
      if (!w || w === "\n") continue;
      const t = (t0 + (Number(s.tOffsetMs) || 0)) / 1000;
      const next = ev.segs[k + 1];
      const end = next && next.tOffsetMs != null ? (t0 + Number(next.tOffsetMs)) / 1000 : (t0 + dur) / 1000;
      words.push({ t: +t.toFixed(2), end: +Math.max(t, end).toFixed(2), w });
    }
  }
  // dédoublonnage (le json3 répète parfois une ligne en « rolling »)
  const dedup = [];
  for (const w of words) {
    const last = dedup[dedup.length - 1];
    if (last && last.w === w.w && Math.abs(last.t - w.t) < 0.05) continue;
    dedup.push(w);
  }
  return { lang: f.split(".")[1] || lang, words: dedup, text: dedup.map((w) => w.w).join(" ") };
}
/** Repli transcript : acteur Apify du Scrap-o-matic (0,005 $) — texte sans horodatage fin (mots répartis uniformément). */
async function transcriptApify(videoId) {
  try {
    const apify = require("./apify");
    const { items } = await apify.runActor("Uwpce1RSXlrzF6WBA", { youtube_url: `https://www.youtube.com/watch?v=${videoId}`, include_transcript_text: true }, { machine: "Labo de niche", note: "Transcript vidéo", flatCost: 0.005 });
    const it = items[0] || {};
    const text = it.transcript_text || (typeof it.transcript === "string" ? it.transcript : null);
    const segs = Array.isArray(it.transcript) ? it.transcript : Array.isArray(it.segments) ? it.segments : null;
    const words = [];
    if (segs && segs.length && segs[0].start != null) {
      for (const sg of segs) {
        const ws = String(sg.text || "").split(/\s+/).filter(Boolean);
        const st = Number(sg.start) || 0, du = Number(sg.duration || sg.dur) || 0;
        ws.forEach((w, k) => words.push({ t: +(st + (du * k) / ws.length).toFixed(2), end: +(st + (du * (k + 1)) / ws.length).toFixed(2), w }));
      }
    }
    const full = text || words.map((w) => w.w).join(" ");
    if (!full) return null;
    return { lang: it.language || "en", words, text: String(full), source: "apify" };
  } catch { return null; }
}
/** Téléchargement 480p mp4 (assez pour lire les plans, ~30-60 Mo pour 10 min). */
async function download(videoId, dir, { height = 480 } = {}) {
  ensureDir(dir);
  const existing = fs.readdirSync(dir).find((f) => /^video\.(mp4|mkv|webm)$/.test(f));
  if (existing) return path.join(dir, existing);
  await ytdlp(["--extractor-args", "youtube:player_client=android", "-f", `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`, "--merge-output-format", "mp4", "-o", path.join(dir, "video.%(ext)s"), "--no-playlist", "-q", `https://www.youtube.com/watch?v=${videoId}`], { timeoutMs: 20 * 60 * 1000 });
  const f = fs.readdirSync(dir).find((x) => /^video\.(mp4|mkv|webm)$/.test(x));
  if (!f) throw new Error("yt-dlp a terminé sans produire de fichier");
  return path.join(dir, f);
}

// ---------------------------------------------------------------- FFmpeg : plans + images
/** Instants de coupe (détection de changement de plan). */
async function sceneCuts(file, threshold = SCENE_THRESHOLD) {
  const err = await ffmpegCapture(["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]);
  const cuts = [];
  for (const m of err.matchAll(/pts_time:\s*([\d.]+)/g)) cuts.push(+Number(m[1]).toFixed(2));
  return cuts;
}
/** Une image toutes les `every` s, 480 px de large, horodatage incrusté. Renvoie [{t, file}]. */
async function extractFrames(file, dir, { every = FRAME_EVERY, width = 480 } = {}) {
  const fdir = path.join(dir, "frames");
  ensureDir(fdir);
  const existing = fs.readdirSync(fdir).filter((f) => f.endsWith(".jpg"));
  if (!existing.length) {
    const font = "C\\:/Windows/Fonts/arialbd.ttf";
    const base = `fps=1/${every},scale=${width}:-2`;
    try {
      await ffmpegCapture(["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `${base},drawtext=fontfile='${font}':text='%{pts\\:hms}':fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4:x=6:y=6`, "-q:v", "4", path.join(fdir, "f-%04d.jpg")]);
    } catch {
      await ffmpegCapture(["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", base, "-q:v", "4", path.join(fdir, "f-%04d.jpg")]);
    }
  }
  return fs.readdirSync(fdir).filter((f) => f.endsWith(".jpg")).sort().map((f, i) => ({ t: i * every, file: path.join(fdir, f) }));
}
/** Planche-contact (6 colonnes) pour un coup d'œil humain. */
function contactSheet(frames, out, cols = 6) {
  if (!frames.length) return Promise.resolve(null);
  const dir = path.dirname(out);
  const list = path.join(dir, "sheet-list.txt");
  fs.writeFileSync(list, frames.map((f) => "file '" + path.relative(dir, f.file).split(path.sep).join("/") + "'").join("\n"));
  const rows = Math.ceil(frames.length / cols);
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "sheet-list.txt", "-vf", `scale=240:-2,tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "5", path.basename(out)], { cwd: dir, windowsHide: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", () => resolve(null));
    child.on("close", () => { try { fs.unlinkSync(list); } catch {} resolve(fs.existsSync(out) ? out : null); });
  });
}

// ---------------------------------------------------------------- Qwen (OpenRouter)
async function askVision(content, { model = VISION_MODEL, timeoutMs = 6 * 60 * 1000 } = {}) {
  const k = llm.key();
  if (!k) throw new Error("Clé OpenRouter absente (coffre ou .env)");
  const resp = await llm.postJson("https://openrouter.ai/api/v1/chat/completions", { Authorization: `Bearer ${k}` },
    { model, messages: [{ role: "user", content }], response_format: { type: "json_object" } }, { timeoutMs });
  if (resp.error) throw new Error(`OpenRouter : ${resp.error.message || JSON.stringify(resp.error).slice(0, 200)}${resp.error.metadata && resp.error.metadata.raw ? " — " + String(resp.error.metadata.raw).slice(0, 220) : ""}`); // raw = vraie cause (filtre de contenu, 429 amont…)
  const text = String(resp.choices?.[0]?.message?.content || "");
  const usage = resp.usage || {};
  const cost = model === VISION_MODEL
    ? ((usage.prompt_tokens || 0) * 0.03 + (usage.completion_tokens || 0) * 0.13) / 1e6
    : ((usage.prompt_tokens || 0) * 0.32 + (usage.completion_tokens || 0) * 1.28) / 1e6;
  return { json: llm.parseJson(text), cost: +cost.toFixed(5), usage };
}
async function withRetry(fn, tries = 3, label = "") {
  let last;
  for (let a = 1; a <= tries; a++) {
    try { return await fn(); } catch (e) { last = e; if (a < tries) await sleep(8000 * a); }
  }
  throw new Error(`${label ? label + " : " : ""}${last.message}`);
}
const fmtT = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const KINDS = "stock_video | stock_photo | ai_image | ai_video | avatar | motion_text | chart | screen | logo_or_card | other";
/** Un paquet d'images (≈60 s) → plans décrits. Les coupes détectées par FFmpeg sont fournies pour caler les bornes. */
async function analyzeChunk(video, frames, cuts, t0, t1, { transcriptSlice = "" } = {}) {
  const content = [{
    type: "text",
    text: [
      `Tu analyses une vidéo YouTube (chaîne « ${video.channel} », titre « ${video.title} »). Voici ${frames.length} images extraites TOUTES LES ${FRAME_EVERY} SECONDES entre ${fmtT(t0)} et ${fmtT(t1)} (l'horodatage est incrusté en haut à gauche de chaque image et rappelé avant chaque image).`,
      cuts.length ? `Changements de plan détectés par FFmpeg dans cet intervalle : ${cuts.map(fmtT).join(", ")}. Utilise-les pour poser les bornes des plans (tu peux en fusionner ou en ajouter si les images le montrent).` : "Aucune coupe franche détectée dans cet intervalle (peut-être un long plan ou des fondus).",
      transcriptSlice ? `Ce qui est DIT pendant cet intervalle (sous-titres auto) : « ${transcriptSlice.slice(0, 1200)} »` : "",
      "",
      "Décris CHAQUE PLAN (un plan = un visuel continu entre deux coupes) : ",
      `- kind ∈ ${KINDS}. stock_video = vraie vidéo de banque (Pexels/Storyblocks : gens, villes, argent, bureaux…) ; stock_photo = photo fixe (souvent avec zoom lent) ; ai_image = image générée par IA (rendu trop lisse, détails incohérents, style peinture/3D) ; ai_video = vidéo générée par IA ; avatar = personne qui parle face caméra (avatar IA ou vrai présentateur) ; motion_text = titre/texte/liste animé plein écran ou carte de section ; chart = graphique/diagramme/chiffres animés ; screen = capture d'écran/site/appli ; logo_or_card = carte de titre, logo, écran d'intro/outro.`,
      "- camera ∈ static | zoom_in | zoom_out | pan_left | pan_right | tilt | handheld | dolly | unknown (compare la 1ʳᵉ et la dernière image du plan : cadrage plus serré = zoom_in, plus large = zoom_out, décalage horizontal = pan).",
      "- desc : EN, 8-15 mots, concret (sujet, action, décor, lumière).",
      "- text : le texte lisible à l'écran (titres, mots-clés, chiffres, sous-titres exclus), sinon \"\".",
      "- overlay : true si un texte/graphisme est INCRUSTÉ par-dessus le plan (lower-third, mot-clé, chiffre), false sinon.",
      "- pexels : la requête de banque d'images EN de 2-4 mots qui rapporterait ce plan (ex. « businessman walking city night »), \"\" si non applicable.",
      "- palette : 3-6 mots EN (ex. « dark navy, gold accents, warm skin tones »).",
      "- avatarNote : si kind = avatar : cadrage, fond, tenue, s'il s'agit d'un avatar IA (peau trop lisse, mouvements limités) ou d'une vraie personne.",
      "",
      'RÉPONDS UNIQUEMENT EN JSON : {"shots":[{"start":"mm:ss","end":"mm:ss","kind":"","camera":"","desc":"","text":"","overlay":false,"pexels":"","palette":"","avatarNote":""}]} — plans dans l\'ordre, jointifs, couvrant tout l\'intervalle.',
    ].filter(Boolean).join("\n"),
  }];
  for (const f of frames) {
    content.push({ type: "text", text: `Image à ${fmtT(f.t)} :` });
    content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + fs.readFileSync(f.file).toString("base64") } });
  }
  const { json, cost } = await withRetry(() => askVision(content), 3, `Analyse ${fmtT(t0)}-${fmtT(t1)}`);
  const toSec = (s) => { const m = /^(\d+):(\d+)(?::(\d+))?/.exec(String(s)); if (!m) return Number(s) || 0; return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]); };
  const shots = (json.shots || []).map((s) => ({
    start: +Math.max(t0, toSec(s.start)).toFixed(1), end: +Math.min(t1, toSec(s.end)).toFixed(1),
    kind: String(s.kind || "other"), camera: String(s.camera || "unknown"), desc: String(s.desc || ""),
    text: String(s.text || ""), overlay: !!s.overlay, pexels: String(s.pexels || ""), palette: String(s.palette || ""),
    avatarNote: String(s.avatarNote || ""),
  })).filter((s) => s.end > s.start);
  return { shots, cost };
}

/** Synthèse narrative + composition d'UNE vidéo (texte seul : transcript + liste des plans). */
async function synthesizeVideo(video, shots, tr, stats) {
  const words = tr ? tr.words : [];
  const secText = (a, b) => words.filter((w) => w.t >= a && w.t < b).map((w) => w.w).join(" ");
  const shotLines = shots.map((s) => `${fmtT(s.start)}-${fmtT(s.end)} ${s.kind}${s.camera !== "static" && s.camera !== "unknown" ? "/" + s.camera : ""}${s.text ? ` [texte: ${s.text.slice(0, 60)}]` : ""} — ${s.desc}`).join("\n");
  const prompt = [
    `Tu es un expert en recréation de vidéos YouTube « faceless » (b-roll + motion design + voix off + avatar IA). Tu décortiques la vidéo « ${video.title} » (chaîne ${video.channel}, ${video.views} vues, ${Math.round(video.duration / 60)} min).`,
    "",
    "LISTE DES PLANS (analyse image par image) :",
    shotLines.slice(0, 14000),
    "",
    "STATISTIQUES MESURÉES : " + JSON.stringify(stats),
    "",
    tr ? "TRANSCRIPT (sous-titres auto, ponctuation absente) :\n" + tr.text.slice(0, 22000) : "TRANSCRIPT INDISPONIBLE.",
    "",
    "Rends une analyse EXPERTE et CHIFFRÉE, en français, en JSON :",
    '{"hook":{"verbatim":"les 2-3 premières phrases exactes","technique":"FR : comment le hook accroche (promesse, contraste, chiffre, question…)","seconds":0},',
    ' "structure":[{"start":"mm:ss","end":"mm:ss","title":"FR","role":"hook|intro|point|story|contrast|proof|cta|conclusion|other","summary":"FR 1 phrase"}],',
    ' "narrative":{"pov":"you|we|I|third","tone":"FR","sentenceLength":"courte|moyenne|longue","devices":["FR : liste des procédés (listes numérotées, rich vs poor, anecdote, chiffre choc, question rhétorique…)"],"pointsCount":0,"keyPhrases":["EN : 5-8 phrases fortes réutilisables comme patrons"]},',
    ' "cta":[{"start":"mm:ss","text":"verbatim","how":"FR : ce qu\'il demande et comment"}],',
    ' "avatar":{"used":true,"appearances":[{"start":"mm:ss","end":"mm:ss","role":"intro|transition|point|cta|outro","says":"résumé FR"}],"look":"FR : description de l\'avatar (fond, tenue, cadrage, IA ou réel)"},',
    ' "motionDesign":{"usage":"FR : quand et pourquoi le texte animé apparaît (titres de section, points numérotés, mots-clés, chiffres)","examples":["textes exacts vus"],"style":"FR : police, couleurs, animation"},',
    ' "broll":{"style":"FR : type de plans dominants, ambiance, lumière","cameraMoves":"FR : fréquence et type des zooms/pans","queries":["EN : 15 requêtes de banque d\'images représentatives"]},',
    ' "retention":["FR : 3-5 mécanismes de rétention observés (open loops, promesse différée, rythme des coupes…)"],',
    ' "titleFormula":"EN : patron du titre","thumbnailGuess":"FR : ce que la miniature met probablement en avant",',
    ' "wpm":0,"shotSeconds":0,"verdict":"FR : 3 phrases — ce qu\'il faut copier de cette vidéo pour la recréer"}',
  ].join("\n");
  const { json, cost } = await withRetry(() => askVision([{ type: "text", text: prompt }], { model: TEXT_MODEL, timeoutMs: 8 * 60 * 1000 }), 2, "Synthèse");
  return { synthesis: json, cost };
}

function shotStats(shots, duration) {
  const durs = shots.map((s) => s.end - s.start).filter((d) => d > 0).sort((a, b) => a - b);
  const byKind = {};
  const byCam = {};
  let overlays = 0;
  for (const s of shots) {
    byKind[s.kind] = (byKind[s.kind] || 0) + (s.end - s.start);
    byCam[s.camera] = (byCam[s.camera] || 0) + 1;
    if (s.overlay || s.text) overlays++;
  }
  const total = Object.values(byKind).reduce((a, b) => a + b, 0) || 1;
  const pct = {};
  for (const k of Object.keys(byKind)) pct[k] = +((100 * byKind[k]) / total).toFixed(1);
  const avatar = shots.filter((s) => s.kind === "avatar");
  return {
    shots: shots.length, duration: +duration.toFixed(1), perMin: +((shots.length * 60) / Math.max(duration, 1)).toFixed(1),
    median: durs.length ? +durs[Math.floor(durs.length / 2)].toFixed(1) : 0, p25: durs.length ? +durs[Math.floor(durs.length / 4)].toFixed(1) : 0, p75: durs.length ? +durs[Math.floor((3 * durs.length) / 4)].toFixed(1) : 0,
    kindPct: pct, camera: byCam, overlayPct: +((100 * overlays) / Math.max(shots.length, 1)).toFixed(1),
    avatarPct: +((100 * avatar.reduce((a, s) => a + (s.end - s.start), 0)) / Math.max(duration, 1)).toFixed(1),
    avatarAppearances: avatar.length, avatarTimes: avatar.map((s) => fmtT(s.start)),
  };
}

// ---------------------------------------------------------------- pipeline d'une vidéo
function videoResult(videoId) { return readJSON(`lab/videos/${videoId}.json`, null); }
function channelResult(channelId) { return readJSON(`lab/channels/${channelId}.json`, null); }

/**
 * Décorticage complet d'une vidéo : métadonnées, transcript, vidéo 480p, coupes, images, Qwen par paquets,
 * stats, synthèse. Reprenable (chaque étape persiste). onStep(msg) pour la progression.
 */
async function analyzeVideo(videoId, { channelName, onStep = () => {}, keepVideo = false, lang = "en", meta = null } = {}) {
  let r = videoResult(videoId) || { videoId, startedAt: new Date().toISOString(), cost: 0 };
  const save = () => writeJSON(`lab/videos/${videoId}.json`, r);
  if (!r.meta) { onStep("métadonnées"); r.meta = meta || (await videoMeta(videoId)); save(); }
  const dir = path.join(OUT_LAB, safe(channelName || r.meta.channel), videoId);
  ensureDir(dir);
  r.dir = `agent-os/output/lab/${safe(channelName || r.meta.channel)}/${videoId}`;
  if (r.transcript === undefined) { onStep("transcript"); r.transcript = await transcript(videoId, dir, lang); save(); }
  if (!r.shots || !r.shots.length) {
    onStep("téléchargement 480p");
    const file = await download(videoId, dir);
    const duration = await probeDuration(file);
    r.meta.duration = r.meta.duration || Math.round(duration);
    onStep("détection des plans");
    const cuts = await sceneCuts(file);
    onStep("extraction des images");
    const frames = await extractFrames(file, dir);
    r.cuts = cuts;
    r.frameCount = frames.length;
    save();
    // Analyse par paquets de CHUNK_SEC, 3 paquets en parallèle
    const chunks = [];
    for (let t = 0; t < duration; t += CHUNK_SEC) chunks.push([t, Math.min(duration, t + CHUNK_SEC)]);
    const results = new Array(chunks.length);
    let done = 0;
    const q = chunks.map((c, i) => ({ c, i }));
    const worker = async () => {
      while (q.length) {
        const { c, i } = q.shift();
        const fr = frames.filter((f) => f.t >= c[0] && f.t < c[1]);
        if (!fr.length) { results[i] = { shots: [], cost: 0 }; continue; }
        const cc = cuts.filter((x) => x >= c[0] && x < c[1]);
        const sl = r.transcript ? r.transcript.words.filter((w) => w.t >= c[0] && w.t < c[1]).map((w) => w.w).join(" ") : "";
        try { results[i] = await analyzeChunk(r.meta, fr, cc, c[0], c[1], { transcriptSlice: sl }); }
        catch (e) { results[i] = { shots: [], cost: 0, error: e.message }; }
        done++;
        onStep(`analyse Qwen ${done}/${chunks.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, chunks.length) }, worker));
    const shots = [];
    let cost = 0;
    for (const res of results) { shots.push(...(res.shots || [])); cost += res.cost || 0; }
    shots.sort((a, b) => a.start - b.start);
    // jointifs : chaque plan finit où le suivant commence
    for (let i = 0; i < shots.length - 1; i++) if (shots[i + 1].start > shots[i].end && shots[i + 1].start - shots[i].end < 4) shots[i].end = shots[i + 1].start;
    r.shots = shots;
    r.chunkErrors = results.filter((x) => x.error).length;
    r.stats = shotStats(shots, duration);
    r.cost += cost;
    spend.record("OpenRouter", "Labo de niche", +cost.toFixed(4), "USD", `Qwen 3.7 Flash — ${shots.length} plans (${videoId})`);
    save();
    await contactSheet(frames.filter((_, i) => i % 3 === 0), path.join(dir, "sheet.jpg")).catch(() => null);
    if (!keepVideo) { try { fs.unlinkSync(file); } catch {} }
  }
  if (!r.synthesis) {
    onStep("synthèse narrative");
    const { synthesis, cost } = await synthesizeVideo(r.meta, r.shots, r.transcript, r.stats);
    r.synthesis = synthesis;
    r.cost += cost;
    spend.record("OpenRouter", "Labo de niche", +cost.toFixed(4), "USD", `Qwen 3.7 Plus — synthèse (${videoId})`);
    save();
  }
  r.finishedAt = new Date().toISOString();
  save();
  mirrorVideoToScrap(r);
  return r;
}

// ---------------------------------------------------------------- miroir vers le Scrap-o-matic (Banque de Niches)
function visionText(r) {
  const s = r.synthesis || {};
  const st = r.stats || {};
  const lines = [
    `[Labo de niche — analyse image par image, ${st.shots || 0} plans, ${st.perMin || 0} plans/min, médiane ${st.median || 0} s]`,
    `Répartition des visuels (% du temps) : ${Object.entries(st.kindPct || {}).map(([k, v]) => `${k} ${v}%`).join(", ")}. Mouvements de caméra : ${Object.entries(st.camera || {}).map(([k, v]) => `${k} ×${v}`).join(", ")}. Avatar : ${st.avatarPct || 0}% du temps (${st.avatarAppearances || 0} apparitions${(st.avatarTimes || []).length ? " à " + st.avatarTimes.join(", ") : ""}).`,
    s.hook ? `HOOK (${s.hook.seconds || 0} s) : « ${s.hook.verbatim} » — ${s.hook.technique}` : "",
    s.structure ? "STRUCTURE : " + s.structure.map((x) => `${x.start} ${x.role} — ${x.title}`).join(" ; ") : "",
    s.narrative ? `NARRATION : ${s.narrative.pov}, ${s.narrative.tone}, phrases ${s.narrative.sentenceLength}, ${(s.narrative.devices || []).join(", ")}. Points : ${s.narrative.pointsCount}. Phrases fortes : ${(s.narrative.keyPhrases || []).join(" | ")}` : "",
    s.cta ? "CTA : " + s.cta.map((c) => `${c.start} « ${c.text} » (${c.how})`).join(" ; ") : "",
    s.avatar ? `AVATAR : ${s.avatar.used ? "oui" : "non"} — ${s.avatar.look || ""} — ${(s.avatar.appearances || []).map((a) => `${a.start}-${a.end} ${a.role} : ${a.says}`).join(" ; ")}` : "",
    s.motionDesign ? `MOTION DESIGN : ${s.motionDesign.usage} — style : ${s.motionDesign.style} — ex. : ${(s.motionDesign.examples || []).join(" / ")}` : "",
    s.broll ? `B-ROLL : ${s.broll.style} — caméra : ${s.broll.cameraMoves} — requêtes : ${(s.broll.queries || []).join(", ")}` : "",
    s.retention ? "RÉTENTION : " + s.retention.join(" ; ") : "",
    s.titleFormula ? `TITRE : ${s.titleFormula} — MINIATURE : ${s.thumbnailGuess || ""}` : "",
    s.verdict ? "VERDICT : " + s.verdict : "",
  ];
  return lines.filter(Boolean).join("\n");
}
function mirrorVideoToScrap(r) {
  const m = r.meta || {};
  writeJSON(`scrap/videos/${r.videoId}.json`, {
    videoId: r.videoId, title: m.title, url: `https://www.youtube.com/watch?v=${r.videoId}`, scrapedAt: r.finishedAt || new Date().toISOString(),
    source: "lab", transcript: r.transcript ? r.transcript.text : null, transcriptLang: r.transcript ? r.transcript.lang : null,
    transcriptError: r.transcript ? null : "Aucun sous-titre automatique", vision: visionText(r), visionError: null,
    lab: { stats: r.stats, synthesis: r.synthesis, dir: r.dir, shots: r.shots },
  });
  // watchlist vidéo (statut done) — via l'API interne du scrap (sérialisée)
  try {
    const w = scrap.watchlist();
    if (!w.videos.some((v) => v.videoId === r.videoId)) {
      scrap.add("video", { videoId: r.videoId, title: m.title, channelId: m.channelId, channelTitle: m.channel, views: m.views, subscribers: m.subscribers, duration: m.duration, publishedAt: m.date, thumbnail: m.thumbnailUrl });
    }
    const w2 = scrap.watchlist();
    const v = w2.videos.find((x) => x.videoId === r.videoId);
    if (v) { v.status = "done"; v.lastScrapedAt = new Date().toISOString(); writeJSON("scrap/watchlist.json", w2); }
  } catch {}
}
function mmss(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
/** Le scan de chaîne écrit AUSSI scrap/channels/<id>.json au format Apify (vidéos triées, miniatures locales). */
async function mirrorChannelToScrap(c) {
  const dir = path.join(OUT_SCRAPING, safe(c.title));
  ensureDir(dir);
  let thumbs = 0;
  const items = [];
  for (const v of c.videos) {
    const m = v.meta || {};
    const thumbUrl = m.thumbnailUrl || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
    const tf = path.join(dir, `${safe(v.title).slice(0, 40)}-${v.videoId}.jpg`);
    if (!fs.existsSync(tf) && (v.meta || v.top)) {
      try { const resp = await fetch(thumbUrl); if (resp.ok) { fs.writeFileSync(tf, Buffer.from(await resp.arrayBuffer())); thumbs++; } } catch {}
    } else if (fs.existsSync(tf)) thumbs++;
    items.push({
      videoId: v.videoId, id: v.videoId, title: v.title, viewCount: v.views, likes: m.likes || 0, commentsCount: m.comments || 0,
      duration: mmss(v.duration), durationSec: v.duration, date: v.date ? `${v.date.slice(0, 4)}-${v.date.slice(4, 6)}-${v.date.slice(6, 8)}` : "",
      thumbnailUrl: thumbUrl, description: m.description || "", tags: m.tags || [], hashtags: [], url: `https://www.youtube.com/watch?v=${v.videoId}`,
      channelAvatarUrl: c.avatar || null, channelTotalVideos: c.videos.length, analyzed: !!videoResult(v.videoId)?.synthesis,
    });
  }
  writeJSON(`scrap/channels/${c.channelId}.json`, {
    channelId: c.channelId, title: c.title, scrapedAt: new Date().toISOString(), source: "lab", maxResults: c.videos.length, videoType: "long",
    count: items.length, thumbsSaved: thumbs, thumbsDir: `agent-os/output/scraping/${safe(c.title)}`, videos: items,
  });
  // watchlist chaîne
  const w = scrap.watchlist();
  if (!w.channels.some((x) => x.channelId === c.channelId)) {
    scrap.add("channel", { channelId: c.channelId, channelTitle: c.title, subscribers: c.subscribers, totalVideos: c.videos.length, avatar: c.avatar || null });
  }
  const w2 = scrap.watchlist();
  const ch = w2.channels.find((x) => x.channelId === c.channelId);
  if (ch) {
    Object.assign(ch, { status: "done", lastScrapedAt: new Date().toISOString(), videoCount: items.length, subscribers: c.subscribers || ch.subscribers, totalVideos: c.videos.length, avatar: c.avatar || ch.avatar });
    writeJSON("scrap/watchlist.json", w2);
  }
}

// ---------------------------------------------------------------- pipeline d'une chaîne
/**
 * Scan COMPLET d'une chaîne (toutes ses vidéos longues) + décorticage des `deep` vidéos les plus vues.
 * opts : { deep = 3, minDuration = 240, recent = 0 (ne considérer que les N plus récentes pour le choix), nicheId, onStep }
 */
async function scanChannel(channelId, { deep = 3, minDuration = 240, maxDuration = 1800, recent = 0, nicheId = null, onStep = () => {}, force = false } = {}) {
  let c = channelResult(channelId);
  if (!c || force) {
    onStep("liste des vidéos (API Data)");
    let info = null;
    try { info = await resolveChannel(channelId); } catch {}
    let vids = [];
    try { vids = await channelVideosApi(channelId); } catch (e) { onStep("API Data indisponible (" + e.message.slice(0, 60) + ") — yt-dlp"); }
    if (!vids.length) vids = (await channelVideos(channelId)).map((v) => ({ ...v, meta: null }));
    if (!vids.length) throw new Error("Aucune vidéo longue trouvée sur cette chaîne");
    for (const v of vids) if (v.meta && info) v.meta.subscribers = info.subscribers;
    c = {
      channelId, title: info ? info.title : (c && c.title) || channelId, handle: info ? info.handle : "", subscribers: info ? info.subscribers : 0,
      avatar: info ? info.avatar : null, description: info ? info.description : "", createdAt: info ? info.createdAt : "",
      scannedAt: new Date().toISOString(), videos: vids, deep: [],
    };
    writeJSON(`lab/channels/${channelId}.json`, c);
  }
  const total = c.videos.reduce((a, v) => a + v.views, 0);
  c.stats = {
    count: c.videos.length, totalViews: total, avgViews: Math.round(total / Math.max(1, c.videos.length)),
    medianDuration: c.videos.map((v) => v.duration).sort((a, b) => a - b)[Math.floor(c.videos.length / 2)] || 0,
    firstDate: c.videos[c.videos.length - 1]?.date || "", lastDate: c.videos[0]?.date || "",
  };
  // Choix des vidéos à décortiquer : les plus vues parmi celles du bon gabarit (récentes si demandé)
  const pool = (recent ? c.videos.slice(0, recent) : c.videos).filter((v) => v.duration >= minDuration && v.duration <= maxDuration);
  const chosen = pool.slice().sort((a, b) => b.views - a.views).slice(0, Math.max(1, deep - 1));
  if (deep > 1 && pool.length && !chosen.some((v) => v.videoId === pool[0].videoId)) chosen.push(pool[0]); // + la plus récente : le format ACTUEL de la chaîne
  for (const v of chosen) v.top = true;
  // Métadonnées riches pour les 25 premières + les choisies (description/tags → banque)
  const needMeta = [...new Set([...c.videos.slice(0, 25), ...chosen])].filter((v) => !v.meta);
  let k = 0;
  for (const v of needMeta) {
    try { v.meta = await videoMeta(v.videoId); } catch {}
    k++;
    if (k % 5 === 0) { onStep(`métadonnées ${k}/${needMeta.length}`); writeJSON(`lab/channels/${channelId}.json`, c); }
  }
  writeJSON(`lab/channels/${channelId}.json`, c);
  await mirrorChannelToScrap(c);
  if (nicheId) { try { bank.addChannel(nicheId, channelId); } catch {} }
  // Décorticage
  let i = 0;
  for (const v of chosen) {
    i++;
    if (videoResult(v.videoId)?.synthesis) { if (!c.deep.includes(v.videoId)) c.deep.push(v.videoId); continue; }
    try {
      await analyzeVideo(v.videoId, { channelName: c.title, meta: v.meta || null, onStep: (s) => onStep(`vidéo ${i}/${chosen.length} « ${v.title.slice(0, 40)} » : ${s}`) });
      if (!c.deep.includes(v.videoId)) c.deep.push(v.videoId);
    } catch (e) {
      c.deepErrors = c.deepErrors || {};
      c.deepErrors[v.videoId] = e.message;
    }
    writeJSON(`lab/channels/${channelId}.json`, c);
  }
  await mirrorChannelToScrap(c);
  return c;
}

/** Agrégat des mesures d'une niche (toutes les vidéos décortiquées de ses chaînes) — sert à écrire la recette. */
function nicheDigest(nicheId) {
  const n = bank.niches().find((x) => x.id === nicheId);
  if (!n) throw new Error("Niche introuvable");
  const videos = [];
  const channels = [];
  for (const cid of n.channels) {
    const c = channelResult(cid);
    if (!c) continue;
    channels.push({ channelId: cid, title: c.title, subscribers: c.subscribers, stats: c.stats, deep: c.deep || [], topTitles: c.videos.slice().sort((a, b) => b.views - a.views).slice(0, 12).map((v) => `${v.title} (${v.views})`) });
    for (const vid of c.deep || []) {
      const r = videoResult(vid);
      if (r && r.synthesis) videos.push({ videoId: vid, channel: c.title, title: r.meta.title, views: r.meta.views, duration: r.meta.duration, stats: r.stats, synthesis: r.synthesis, transcriptWords: r.transcript ? r.transcript.words.length : 0 });
    }
  }
  const med = (arr) => { const a = arr.filter((x) => isFinite(x) && x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const kindAgg = {};
  for (const v of videos) for (const [k, p] of Object.entries(v.stats?.kindPct || {})) kindAgg[k] = (kindAgg[k] || 0) + p / videos.length;
  const camAgg = {};
  for (const v of videos) for (const [k, p] of Object.entries(v.stats?.camera || {})) camAgg[k] = (camAgg[k] || 0) + p;
  return {
    niche: n.name, channels, videos,
    measures: {
      videos: videos.length,
      medianDurationMin: +(med(videos.map((v) => v.duration)) / 60).toFixed(1),
      medianShotSec: med(videos.map((v) => v.stats?.median)),
      shotsPerMin: med(videos.map((v) => v.stats?.perMin)),
      wpm: med(videos.map((v) => (v.transcriptWords && v.duration ? (v.transcriptWords * 60) / v.duration : 0))),
      kindPct: Object.fromEntries(Object.entries(kindAgg).map(([k, v]) => [k, +v.toFixed(1)])),
      camera: camAgg,
      avatarPct: med(videos.map((v) => v.stats?.avatarPct)),
      avatarAppearances: med(videos.map((v) => v.stats?.avatarAppearances)),
      overlayPct: med(videos.map((v) => v.stats?.overlayPct)),
    },
  };
}

// ---------------------------------------------------------------- tâche visible (Tâches & Cron) pour un lot de chaînes
let running = false;
async function scanNiche(nicheName, channelIds, opts = {}) {
  if (running) throw new Error("Un scan du Labo est déjà en cours");
  running = true;
  const niche = bank.create(nicheName);
  const task = tasks.createTask({ title: `Labo de niche — ${niche.name}`, desc: `${channelIds.length} chaînes · scan complet + ${opts.deep || 3} vidéos décortiquées par chaîne`, machine: "Labo de niche", kind: "scrap", step: "Démarrage…", progress: 2, status: "running" });
  const out = [];
  try {
    // 2 chaînes en parallèle (yt-dlp reste sérialisé globalement ; Qwen encaisse ~10 appels simultanés)
    let done = 0;
    const q = channelIds.map((cid, k) => ({ cid, k }));
    const worker = async () => {
      while (q.length) {
        const { cid, k } = q.shift();
        const step = (s) => tasks.updateTask(task.id, { step: `Chaîne ${k + 1}/${channelIds.length} : ${s}`, progress: Math.min(98, 2 + Math.round((96 * done) / channelIds.length)), status: "running" }).catch(() => {});
        try { out.push(await scanChannel(cid, { ...opts, nicheId: niche.id, onStep: step })); }
        catch (e) { out.push({ channelId: cid, error: e.message }); }
        done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, channelIds.length) }, worker));
    await tasks.updateTask(task.id, { step: `${out.filter((c) => !c.error).length}/${channelIds.length} chaînes scannées`, progress: 100, status: "done" });
  } catch (e) {
    await tasks.updateTask(task.id, { step: e.message, status: "failed" }).catch(() => {});
    throw e;
  } finally { running = false; }
  return { niche, channels: out };
}
function isRunning() { return running; }

module.exports = {
  resolveChannel, channelVideosApi, channelVideos, videoMeta, transcript, download, sceneCuts, extractFrames, analyzeVideo, scanChannel, scanNiche, isRunning,
  videoResult, channelResult, nicheDigest, mirrorChannelToScrap, askVision, VISION_MODEL, TEXT_MODEL,
};
