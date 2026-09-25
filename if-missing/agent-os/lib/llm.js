/**
 * LLM texte économique — OpenRouter (Qwen par défaut), avec repli sur Claude CLI.
 *
 * Pourquoi : le pipeline TikTok (analyse, extraction de patterns, adaptation, casting,
 * packaging) consommait des tokens Claude en masse. Qwen 3.7 Plus fait le même travail
 * d'écriture structurée pour ~1/100e du prix. Claude ne sert plus que de filet de sécurité
 * quand OpenRouter est indisponible ou renvoie du JSON illisible.
 *
 * ask(prompt, {json, model, timeoutMs})  → texte brut (ou objet si json:true)
 * askJson(prompt, {tries})               → objet JSON validé, avec relances
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const vault = require("./vault");
const claude = require("./claude");

const TEXT_MODEL = "qwen/qwen3.7-plus";   // écriture structurée (patterns, prompts, casting)
const FAST_MODEL = "qwen/qwen3.7-flash";  // tâches courtes/mécaniques

function key() {
  const k = vault.get("openrouter");
  if (k) return k;
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    const m = /^OPENROUTER=(.+)$/m.exec(txt);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

/**
 * POST JSON en node:https — et surtout PAS en fetch(). Le fetch de Node (undici) abandonne au
 * bout de 300 s sans en-tête de réponse (« terminated » / « fetch failed »), or nos appels
 * (raisonnement long, analyse vidéo multimodale) mettent 4 à 10 minutes à répondre : ils
 * tombaient systématiquement dès qu'on en lançait plusieurs en parallèle. Ici c'est nous qui
 * fixons le délai, et toujours zéro dépendance npm.
 */
function postJson(url, headers, payload, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "Content-Length": body.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`réponse illisible (HTTP ${res.statusCode}) : ${text.slice(0, 200)}`));
          }
        });
      }
    );
    // Délai d'INACTIVITÉ du socket : un modèle qui « réfléchit » ne renvoie rien pendant
    // plusieurs minutes, c'est normal — on ne coupe que si la connexion est vraiment morte.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`délai dépassé (${Math.round(timeoutMs / 60000)} min sans réponse)`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** Extrait un objet JSON d'une réponse (fences ``` tolérées) — même contrat que claude.parseJson. */
function parseJson(text) {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Réponse sans JSON : " + cleaned.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callOpenRouter(prompt, { model = TEXT_MODEL, timeoutMs = 6 * 60 * 1000, json = false } = {}) {
  const k = key();
  if (!k) throw new Error("Clé OpenRouter absente (coffre ou .env)");
  const resp = await postJson(
    "https://openrouter.ai/api/v1/chat/completions",
    { Authorization: `Bearer ${k}` },
    {
      model,
      messages: [{ role: "user", content: prompt }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    },
    { timeoutMs }
  );
  if (resp.error) throw new Error(`OpenRouter : ${resp.error.message || JSON.stringify(resp.error).slice(0, 200)}`);
  const text = String(resp.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("Réponse vide");
  return text;
}

/**
 * Texte libre. Bascule sur Claude CLI si OpenRouter échoue (réseau, quota).
 * @param opts.fast  true → modèle flash (tâches simples)
 */
/**
 * Relances avant tout repli : ECONNRESET, socket coupé, « Provider returned error » sont des
 * incidents de transport, pas des pannes. Tomber sur Claude CLI au premier hoquet réseau, c'est
 * repayer 100× le même travail — la règle du projet est justement de ne plus le faire.
 */
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket|terminated|fetch failed|délai dépassé|Provider returned error|rate limit|429|50\d/i;
async function withRetry(fn, { tries = 3, label = "" } = {}) {
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (a === tries || !TRANSIENT.test(e.message)) break;
      console.log(`[llm] ${label} essai ${a}/${tries} : ${e.message.slice(0, 70)} — relance`);
      await new Promise((r) => setTimeout(r, a * 15000));
    }
  }
  throw last;
}

async function ask(prompt, { timeoutMs = 6 * 60 * 1000, fast = false, model } = {}) {
  try {
    return await withRetry(() => callOpenRouter(prompt, { model: model || (fast ? FAST_MODEL : TEXT_MODEL), timeoutMs }), { label: "ask" });
  } catch (e) {
    console.log("[llm] OpenRouter indisponible (" + e.message.slice(0, 80) + ") — repli Claude CLI");
    return claude.ask(prompt, { timeoutMs });
  }
}

/**
 * JSON structuré avec relances. Deux tentatives Qwen (mode json_object), puis Claude en
 * dernier recours : un JSON tronqué ne doit jamais tuer une étape de pipeline.
 */
async function askJson(prompt, { timeoutMs = 6 * 60 * 1000, tries = 2, label = "" } = {}) {
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      return parseJson(await withRetry(() => callOpenRouter(prompt, { timeoutMs, json: true }), { label: label || "askJson" }));
    } catch (e) {
      last = e;
    }
  }
  try {
    return claude.parseJson(await claude.ask(prompt, { timeoutMs }));
  } catch (e) {
    throw new Error(`${label ? label + " : " : ""}${last ? last.message : e.message} (Qwen ×${tries} puis Claude)`);
  }
}

module.exports = { ask, askJson, parseJson, key, postJson, TEXT_MODEL, FAST_MODEL };
