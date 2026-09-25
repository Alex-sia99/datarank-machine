#!/usr/bin/env node
/**
 * Installe la machine « Data Ranking » dans un Agent OS existant.
 *
 *   node install.js [chemin/vers/le/projet]      # défaut : le dossier parent de ce dépôt
 *   node install.js ../mon-os --dry              # simulation : dit ce qu'il ferait, n'écrit rien
 *
 * Le script copie les fichiers de la machine puis pose lui-même les points de branchement dans
 * `agent-os/server.js`, `agent-os/public/index.html`, `agent-os/public/js/core.js`,
 * `agent-os/public/js/pages/machines.js` et `remotion/src/Root.tsx`.
 *
 * IDEMPOTENT : relancé, il ne duplique rien (chaque insertion est détectée avant d'être faite).
 * Une sauvegarde `.bak-datarank` est écrite à côté de chaque fichier modifié, la première fois seulement.
 * Si une ancre est introuvable (Agent OS très différent), le script ne devine pas : il affiche
 * l'instruction manuelle correspondante (voir INSTALL-LLM.md) et continue.
 */
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const target = path.resolve(argv.find((a) => !a.startsWith("--")) || path.join(HERE, ".."));

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const skip = (m) => console.log(`${C.d}·${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}⚠${C.x} ${m}`);
const die = (m) => { console.error(`${C.r}✗${C.x} ${m}`); process.exit(1); };
const manual = [];

// ---------------------------------------------------------------- vérifications
console.log(`\n${C.b}Machine Data Ranking → ${target}${C.x}${DRY ? `  ${C.y}(simulation)${C.x}` : ""}\n`);
const must = ["agent-os/server.js", "agent-os/public/index.html", "agent-os/public/js/core.js", "agent-os/public/js/pages/machines.js", "remotion/src/Root.tsx"];
for (const rel of must) if (!fs.existsSync(path.join(target, rel))) die(`« ${rel} » introuvable : ${target} n'a pas l'air d'être une racine d'Agent OS (le dossier qui contient agent-os/ et remotion/).`);
// Modules du socle utilisés par la machine et le Labo (ils ne sont PAS fournis par ce dépôt, sauf llm.js si absent).
const SOCLE = ["store", "vault", "fal", "spend", "tasks", "claude", "google", "bank", "scrap", "youtube", "apify"];
const socleManquant = SOCLE.filter((m) => !fs.existsSync(path.join(target, "agent-os/lib", m + ".js")));
if (socleManquant.length) {
  warn(`socle incomplet : ${socleManquant.map((m) => "lib/" + m + ".js").join(", ")}`);
  warn("indispensables : store, vault, fal, spend, tasks, claude — les autres ne servent qu'à la publication YouTube (google) et au Labo de niche (bank, scrap, youtube, apify)");
}

function read(rel) { return fs.readFileSync(path.join(target, rel), "utf8"); }
function write(rel, content) {
  if (DRY) return;
  const abs = path.join(target, rel);
  const bak = abs + ".bak-datarank";
  if (!fs.existsSync(bak)) fs.copyFileSync(abs, bak);
  fs.writeFileSync(abs, content, "utf8");
}

// ---------------------------------------------------------------- 1) fichiers
function copyTree(dir, { onlyIfMissing = false } = {}, rel = "") {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) { copyTree(abs, { onlyIfMissing }, r); continue; }
    const dest = path.join(target, r);
    const exists = fs.existsSync(dest);
    if (exists && onlyIfMissing) { skip(`${r} (déjà présent dans ton socle, conservé)`); continue; }
    if (exists && fs.readFileSync(dest).equals(fs.readFileSync(abs))) { skip(`${r} (identique)`); continue; }
    if (!DRY) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (exists && !fs.existsSync(dest + ".bak-datarank")) fs.copyFileSync(dest, dest + ".bak-datarank");
      fs.copyFileSync(abs, dest);
    }
    ok(`${r}${exists ? " (remplacé, ancienne version en .bak-datarank)" : ""}`);
  }
}
console.log(`${C.b}Fichiers${C.x}`);
copyTree(path.join(HERE, "files"));
copyTree(path.join(HERE, "if-missing"), { onlyIfMissing: true });

// ---------------------------------------------------------------- 2) server.js
console.log(`\n${C.b}agent-os/server.js${C.x}`);
{
  let s = read("agent-os/server.js");
  const before = s;

  // require : après le dernier require d'une machine, sinon après tasks
  if (s.includes('require("./lib/machines/datarank")')) skip("require datarank (déjà présent)");
  else {
    const all = [...s.matchAll(/const \w+ = require\("\.\/lib\/machines\/[\w-]+"\);\n/g)];
    const anchor = all.length ? all[all.length - 1][0] : (s.match(/const tasks = require\("\.\/lib\/tasks"\);\n/) || [null])[0];
    if (anchor) { s = s.replace(anchor, anchor + 'const datarank = require("./lib/machines/datarank");\n'); ok("require datarank"); }
    else { warn("require : ancre introuvable"); manual.push('ajouter `const datarank = require("./lib/machines/datarank");` en haut de server.js'); }
  }

  // table des machines
  if (/const MACHINES = \{[^}]*\bdatarank\b/.test(s)) skip("MACHINES (déjà présent)");
  else if (/const MACHINES = \{([^}]*)\}/.test(s)) {
    s = s.replace(/const MACHINES = \{([^}]*)\}/, (m, inner) => `const MACHINES = {${inner.trimEnd().replace(/,\s*$/, "")}, datarank }`);
    ok("MACHINES += datarank");
  } else { warn("MACHINES : introuvable"); manual.push("ajouter `datarank` à la table MACHINES de server.js"); }

  // carte du hub (/api/machines)
  if (/card\(datarank\)/.test(s)) skip("GET /api/machines (déjà présent)");
  else if (/return json\(res, 200, \[(card\([^\]]*)\]\);/.test(s)) {
    s = s.replace(/return json\(res, 200, \[(card\([^\]]*)\]\);/, (m, inner) => `return json(res, 200, [${inner}, card(datarank)]);`);
    ok("GET /api/machines += card(datarank)");
  } else { warn("GET /api/machines : introuvable"); manual.push("ajouter `card(datarank)` à la liste de GET /api/machines"); }

  // routes génériques (stock / order-info / ideas) : on étend toutes les alternatives de machines qui commencent par timetravel|
  let rx = 0;
  s = s.replace(/\(timetravel\|[a-z|]+\)/g, (m) => { if (m.includes("datarank")) return m; rx++; return m.slice(0, -1) + "|datarank)"; });
  if (rx) ok(`routes génériques (stock / restock / idées) : ${rx} liste(s) de machines étendue(s)`);
  else skip("routes génériques (déjà étendues ou absentes)");

  // bloc de routes de la machine
  if (s.includes("// ===== MACHINE DATA RANKING =====")) skip("bloc de routes (déjà présent)");
  else {
    const snippet = fs.readFileSync(path.join(HERE, "server-routes.snippet.js"), "utf8").replace(/\s*$/, "\n");
    const anchors = ["    // ===== MACHINE WEALTH =====", "    // ===== MACHINE Musique =====", "    // ===== MACHINES ====="];
    const anchor = anchors.find((a) => s.includes(a));
    if (anchor) { s = s.replace(anchor, snippet + anchor); ok("bloc de routes Data Ranking"); }
    else { warn("bloc de routes : aucune ancre trouvée"); manual.push("coller server-routes.snippet.js dans le routeur de server.js (à côté des routes des autres machines)"); }
  }

  // boot : sweepRuns + cron de sauvetage
  if (s.includes("datarank.sweepRuns()")) skip("sweepRuns au boot (déjà présent)");
  else if (/const stale = ([^;]*);/.test(s)) { s = s.replace(/const stale = ([^;]*);/, (m, inner) => `const stale = ${inner} + (datarank.sweepRuns() || 0);`); ok("sweepRuns au boot"); }
  else skip("sweepRuns : pas de ligne `const stale = …` (facultatif)");
  if (s.includes("datarank.strandedRuns()")) skip("strandedRuns (déjà présent)");
  else if (/strandedRuns\(\)\]/.test(s)) {
    const all = [...s.matchAll(/strandedRuns\(\)\]/g)];
    const last = all[all.length - 1];
    s = s.slice(0, last.index) + "strandedRuns(), ...datarank.strandedRuns()]" + s.slice(last.index + last[0].length);
    ok("strandedRuns (cron de sauvetage)");
  } else skip("strandedRuns : pas de cron de sauvetage (facultatif)");

  // manifeste des agents
  if (s.includes('{ id: "datarank", name: "Data Ranking"')) skip("manifeste agents (déjà présent)");
  else if (/machines: \[\n(\s*\{ id: "[\w-]+", name: "[^"]+", api: "[^"]+" \},\n)+/.test(s)) {
    s = s.replace(/(machines: \[\n(?:\s*\{ id: "[\w-]+", name: "[^"]+", api: "[^"]+" \},\n)+)/, `$1          { id: "datarank", name: "Data Ranking", api: "/api/machines/datarank" },\n`);
    ok("manifeste agents");
  }

  if (s !== before) write("agent-os/server.js", s);
}

// ---------------------------------------------------------------- 3) frontend
console.log(`\n${C.b}Frontend${C.x}`);
{
  let s = read("agent-os/public/index.html");
  if (s.includes("js/pages/datarank.js")) skip("index.html (déjà présent)");
  else if (/(\s*<script src="js\/pages\/machines\.js"><\/script>)/.test(s)) {
    s = s.replace(/(\s*<script src="js\/pages\/machines\.js"><\/script>)/, `\n  <script src="js/pages/datarank.js"></script>$1`);
    write("agent-os/public/index.html", s);
    ok("index.html : <script> de la page");
  } else { warn("index.html : ancre introuvable"); manual.push('ajouter <script src="js/pages/datarank.js"></script> dans agent-os/public/index.html'); }
}
{
  let s = read("agent-os/public/js/core.js");
  if (/\[[^\]]*"datarank"[^\]]*\]\.includes\(name\)/.test(s)) skip("core.js (déjà présent)");
  else if (/\[([^\]]*"timetravel"[^\]]*)\]\.includes\(name\)/.test(s)) {
    s = s.replace(/\[([^\]]*"timetravel"[^\]]*)\]\.includes\(name\)/, (m, inner) => `[${inner}, "datarank"].includes(name)`);
    write("agent-os/public/js/core.js", s);
    ok("core.js : surlignage de la nav « Machines »");
  } else { warn("core.js : ancre introuvable"); manual.push('ajouter "datarank" au tableau de core.js qui renvoie le surlignage vers « machines »'); }
}
{
  let s = read("agent-os/public/js/pages/machines.js");
  if (s.includes('href="#/datarank"')) skip("machines.js (déjà présent)");
  else {
    const card = `        <a class="bank-folder" href="#/datarank" style="text-decoration:none;color:inherit">
          <div style="font-size:34px">📊</div>
          <b>Data Ranking</b>
          <div class="small muted" style="margin-top:4px">Carrousels data en ordre croissant — Wikipédia/Wikidata (données vérifiées) → Qwen (script) → Inworld TTS → GPT Image 2.5 / Qwen Image 2.1 (détourages contrôlés) → Remotion</div>
        </a>
`;
    const placeholder = /(\s*<div class="bank-folder" style="opacity:\.55;cursor:default">)/;
    const lastCard = /(\n\s*<\/a>\n)(?![\s\S]*<a class="bank-folder")/;
    if (placeholder.test(s)) s = s.replace(placeholder, "\n" + card + "$1");
    else if (lastCard.test(s)) s = s.replace(lastCard, "$1" + card);
    if (s.includes('href="#/datarank"')) {
      if (/const TAB_KEYS = \{([^}]*)\}/.test(s) && !s.includes('"#/datarank"')) s = s.replace(/const TAB_KEYS = \{([^}]*)\}/, (m, inner) => `const TAB_KEYS = {${inner.trimEnd().replace(/,\s*$/, "")}, "#/datarank": "dr-tab" }`);
      write("agent-os/public/js/pages/machines.js", s);
      ok("machines.js : carte du hub");
    } else { warn("machines.js : ancre introuvable"); manual.push("ajouter une carte Data Ranking (href #/datarank) au hub des machines"); }
  }
}

// ---------------------------------------------------------------- 4) Remotion
console.log(`\n${C.b}remotion/src/Root.tsx${C.x}`);
{
  let s = read("remotion/src/Root.tsx");
  const before = s;
  if (!s.includes('from "./DataCarousel"')) {
    const imp = `import { DataCarousel, DataThumb, dataCarouselSchema, dataCarouselFrames, DEFAULT_THEME as DC_THEME, FPS as DC_FPS } from "./DataCarousel";\n`;
    const lastImport = s.lastIndexOf("\nimport ");
    const eol = s.indexOf("\n", lastImport + 1);
    s = s.slice(0, eol + 1) + imp + s.slice(eol + 1);
    ok("import DataCarousel");
  } else skip("import (déjà présent)");

  if (!s.includes('id="DataCarousel"')) {
    const demo = `{
          dir: "", musicVolume: 0.07, title: "Tallest Buildings", banner: "Tallest building in every country",
          intro: { seconds: 6, kicker: "TOP 5", title: "Tallest Building in Every Country", subtitle: "Ranked by height · 2026" },
          outro: { seconds: 4, text: "Thanks for watching", sub: "Which one surprised you?" },
          cards: [["Lotte World Tower", "South Korea", "555 m"], ["Abraj Al Bait", "Saudi Arabia", "601 m"], ["Shanghai Tower", "China", "632 m"], ["Merdeka 118", "Malaysia", "679 m"], ["Burj Khalifa", "United Arab Emirates", "828 m"]]
            .map(([name, sub, value], k) => ({ rank: 5 - k, name, sub, fit: "cover" as const, value, unit: "Height", extra: "", start: 6 + k * 3.5, end: 6 + k * 3.5 + 3 })),
          theme: DC_THEME, totalSeconds: 6 + 5 * 3.5 + 4,
        }}`;
    const comps = `      <Composition
        id="DataCarousel"
        component={DataCarousel}
        durationInFrames={DC_FPS * 30}
        fps={DC_FPS}
        width={1920}
        height={1080}
        schema={dataCarouselSchema}
        defaultProps={${demo}
        calculateMetadata={({ props }) => ({ durationInFrames: dataCarouselFrames(props) })}
      />
      <Composition
        id="DataThumb"
        component={DataThumb}
        durationInFrames={1}
        fps={DC_FPS}
        width={1280}
        height={720}
        schema={dataCarouselSchema}
        defaultProps={${demo}
      />
`;
    const anchor = s.indexOf("      <Composition");
    if (anchor > 0) { s = s.slice(0, anchor) + comps + s.slice(anchor); ok("compositions DataCarousel + DataThumb"); }
    else { warn("Root.tsx : aucune <Composition> trouvée"); manual.push("déclarer les compositions DataCarousel et DataThumb dans remotion/src/Root.tsx (voir INSTALL-LLM.md)"); }
  } else skip("compositions (déjà présentes)");

  if (s !== before) write("remotion/src/Root.tsx", s);
}

// ---------------------------------------------------------------- récapitulatif
console.log(`\n${C.b}Terminé.${C.x}${DRY ? ` ${C.y}Rien n'a été écrit (--dry).${C.x}` : ""}`);
if (manual.length) {
  console.log(`\n${C.y}À faire à la main (ancres non trouvées) — voir INSTALL-LLM.md, section « Installation manuelle » :${C.x}`);
  manual.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
}
console.log(`\n${C.b}Avant le premier run${C.x}
  1. Coffre d'Agent OS : ${C.b}openrouter${C.x} (Qwen), ${C.b}kie${C.x} (images + musique), ${C.b}fal${C.x} (voix Inworld). YouTube connecté si tu veux publier.
  2. Vérifier Remotion : ${C.b}cd remotion && npx remotion compositions${C.x} (DataCarousel et DataThumb doivent apparaître).
  3. Redémarrer Agent OS, ouvrir ${C.b}Machines → Data Ranking${C.x} : un sujet (ou 💡), la durée → ⚙ Générer.
  4. Facultatif — ta propre banque de niche :
     ${C.b}cd agent-os && node scripts/niche-lab.js --niche "Data Ranking" --deep 10 --min 90 <URLs de chaînes>${C.x}
     puis ${C.b}node scripts/carousel-lab.js --niche "Data Ranking"${C.x}

Recette de la niche : ${C.b}agent-os/docs/RECETTE-NICHE-DATARANK.md${C.x}
En ligne de commande : ${C.b}cd agent-os && node scripts/datarank.js --topic "Tallest Building in Every Country" --duration 300${C.x}
`);
