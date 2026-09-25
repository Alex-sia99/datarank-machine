# Guide d'installation — pour l'assistant IA qui installe la machine

> Tu es un assistant de code (Claude Code, Codex, Cursor…) et l'utilisateur t'a demandé d'installer la machine **Data Ranking** dans son Agent OS. Suis ces étapes dans l'ordre, vérifie chaque résultat, et rends compte à l'utilisateur en français, simplement. Ne saute aucune vérification.

## Règles

- **Ne touche à aucun secret.** Les clés API vivent dans le coffre chiffré d'Agent OS (`agent-os/data/`, gitignoré). Ne les lis pas, ne les écris jamais dans un fichier, ne les affiche pas. Si une clé manque, dis à l'utilisateur laquelle ajouter dans Paramètres → Coffre.
- **Ne remplace pas le socle.** Les modules `agent-os/lib/*.js` existants (store, vault, fal, tasks, spend, claude, google, bank…) appartiennent à l'OS de l'utilisateur. Le dépôt ne fournit que `llm.js`, et seulement s'il est absent (`if-missing/`).
- **Ne redémarre jamais Agent OS pendant qu'un run tourne** (une autre machine peut être en train de générer : ça tue la génération en mémoire). Demande avant de redémarrer.
- **Ne commit rien** chez l'utilisateur sans qu'il le demande.

## 1. Repérer l'Agent OS

La racine est le dossier qui contient **`agent-os/`** et **`remotion/`**. Vérifie :

```bash
ls <racine>/agent-os/server.js <racine>/agent-os/public/index.html <racine>/agent-os/public/js/core.js \
   <racine>/agent-os/public/js/pages/machines.js <racine>/remotion/src/Root.tsx
```

Les 5 fichiers doivent exister. Sinon, demande à l'utilisateur où est son Agent OS.

Prérequis à vérifier : `node -v` (≥ 18), `ffmpeg -version` (dans le PATH), `ls <racine>/remotion/node_modules/remotion` (Remotion installé ; sinon `cd remotion && npm install`).

## 2. Récupérer le dépôt et simuler

```bash
git clone https://github.com/Alex-sia99/datarank-machine
cd datarank-machine
node install.js <racine> --dry
```

La simulation liste ce qui serait copié et branché, sans rien écrire. Lis la sortie : `✓` = sera fait, `·` = déjà présent, `⚠` = ancre introuvable (à faire à la main, section 5).

## 3. Installer

```bash
node install.js <racine>
```

Relance-le une seconde fois : il doit n'afficher **aucune** ligne `✓` (installation idempotente). Chaque fichier modifié a une sauvegarde `<fichier>.bak-datarank`.

## 4. Vérifier

```bash
cd <racine>/agent-os
node --check server.js && node --check public/js/core.js && node --check public/js/pages/machines.js \
  && node --check public/js/pages/datarank.js && node --check lib/machines/datarank.js && echo SYNTAXE OK
node -e "const d=require('./lib/machines/datarank'); console.log('module OK', typeof d.createRun, d.estimate({durationSec:300}))"
cd ../remotion && npx remotion compositions      # DataCarousel et DataThumb doivent apparaître
```

Puis, **après accord de l'utilisateur**, redémarre Agent OS (`cd agent-os && npm start`) et teste (remplace le port par celui de son OS, affiché au démarrage, souvent 4200 ou 4100) :

```bash
curl -s localhost:<port>/api/machines/datarank | head -c 200          # la config
curl -s -X POST -H "Content-Type: application/json" -d '{"durationSec":300}' localhost:<port>/api/machines/datarank/estimate
curl -s localhost:<port>/api/machines | grep -o '"datarank"'           # la machine est listée
```

L'estimation doit rendre environ `{"cards":24,"wpm":125,"usd":1.15,…}`. Dans le navigateur : **Machines → 📊 Data Ranking** s'ouvre sur l'onglet ⚙ Générer.

## 5. Installation manuelle (seulement pour les lignes `⚠`)

Fais uniquement les points signalés par l'installateur. Adapte au style du fichier.

**server.js — require** (en haut, avec les autres machines) :
```js
const datarank = require("./lib/machines/datarank");
```

**server.js — table des machines** : ajouter `datarank` à l'objet `const MACHINES = { … }`.

**server.js — hub** : dans la route `GET /api/machines`, ajouter `card(datarank)` à la liste renvoyée.

**server.js — routes génériques** : dans les regex du type `/^\/api\/machines\/(timetravel|linguistique|…)\/stock$/` (stock, publish, order-info, ideas), ajouter `|datarank` dans la liste.

**server.js — routes de la machine** : coller tout le contenu de `server-routes.snippet.js` dans le routeur, à côté des blocs des autres machines (même niveau d'indentation, là où `p`, `req`, `res`, `m`, `json()` et `readBody()` existent).

**server.js — boot (facultatif)** : si une ligne `const stale = a.sweepRuns() + …;` existe, y ajouter `+ (datarank.sweepRuns() || 0)` ; si un tableau `[...x.strandedRuns(), …]` existe (cron de sauvetage), y ajouter `...datarank.strandedRuns()`.

**public/index.html** : avant la ligne `<script src="js/pages/machines.js"></script>` :
```html
<script src="js/pages/datarank.js"></script>
```

**public/js/core.js** : dans le tableau `["timetravel", …].includes(name) ? "machines" : name`, ajouter `"datarank"`.

**public/js/pages/machines.js** : ajouter une carte dans la grille du hub :
```html
<a class="bank-folder" href="#/datarank" style="text-decoration:none;color:inherit">
  <div style="font-size:34px">📊</div>
  <b>Data Ranking</b>
  <div class="small muted" style="margin-top:4px">Carrousels data en ordre croissant — Wikipédia/Wikidata → Qwen → Inworld → GPT Image 2.5 → Remotion</div>
</a>
```

**remotion/src/Root.tsx** : ajouter l'import puis les deux compositions dans le fragment `<>…</>` :
```tsx
import { DataCarousel, DataThumb, dataCarouselSchema, dataCarouselFrames, DEFAULT_THEME as DC_THEME, FPS as DC_FPS } from "./DataCarousel";

const DC_DEMO = {
  dir: "", musicVolume: 0.07, title: "Demo", banner: "Tallest building in every country",
  intro: { seconds: 6, kicker: "TOP 3", title: "Tallest Buildings", subtitle: "Ranked by height" },
  outro: { seconds: 4, text: "Thanks for watching", sub: "Which one surprised you?" },
  cards: [["Shanghai Tower", "China", "632 m"], ["Merdeka 118", "Malaysia", "679 m"], ["Burj Khalifa", "UAE", "828 m"]]
    .map(([name, sub, value], k) => ({ rank: 3 - k, name, sub, fit: "cover" as const, value, unit: "Height", extra: "", start: 6 + k * 3.5, end: 9 + k * 3.5 })),
  theme: DC_THEME, totalSeconds: 6 + 3 * 3.5 + 4,
};
// dans le fragment :
<Composition id="DataCarousel" component={DataCarousel} durationInFrames={DC_FPS * 30} fps={DC_FPS} width={1920} height={1080}
  schema={dataCarouselSchema} defaultProps={DC_DEMO} calculateMetadata={({ props }) => ({ durationInFrames: dataCarouselFrames(props) })} />
<Composition id="DataThumb" component={DataThumb} durationInFrames={1} fps={DC_FPS} width={1280} height={720}
  schema={dataCarouselSchema} defaultProps={DC_DEMO} />
```
Une composition cassée casse tout le bundle Remotion (et donc le rendu des autres machines) : revérifie `npx remotion compositions` après toute modification de `Root.tsx`.

## 6. Clés à demander à l'utilisateur

| Clé du coffre | Service | Sert à | Obligatoire |
|---|---|---|---|
| `openrouter` | OpenRouter (Qwen 3.7) | données, script, SEO, contrôle des images | oui |
| `kie` | Kie.ai | images (GPT Image 2.5 / Qwen Image 2.1), musique Suno | oui |
| `fal` | FAL.ai | voix Inworld | oui |
| OAuth Google + chaîne YouTube | YouTube | bouton 📤 Publier / publication auto | non |
| clé YouTube Data | YouTube Data API | Labo de niche uniquement | non |

Wikipédia, Wikidata et flagcdn sont des API publiques sans clé. Variable d'environnement facultative : `WIKI_CONTACT` (e-mail ou URL de contact mis dans le User-Agent envoyé à Wikipédia).

## 7. Premier essai conseillé

Proposer à l'utilisateur un run court pour valider la chaîne complète (~0,40 $, 10-15 min) :

```bash
cd <racine>/agent-os
node scripts/datarank.js --topic "Tallest Building in Every Country" --duration 90
```

La vidéo sort dans `agent-os/output/machines/<runId>/final.mp4` et apparaît dans l'onglet Stock. Ou depuis l'interface : ⚙ Générer → mode **Semi-manuel** pour tout relire étape par étape.

## Dépannage

| Symptôme | Cause | Remède |
|---|---|---|
| `OpenRouter : Provider returned error — … data_inspection_failed` | Le fournisseur de Qwen (Alibaba) refuse certaines images (ex. drapeau de Taïwan) | Normal : le contrôle marque l'image « non contrôlable » et continue. Rien à faire. |
| `… temporarily rate-limited upstream` | Limitation passagère de Qwen | La machine réessaie ; sinon ⚡ Reprendre plus tard. |
| `Clé Kie absente du coffre` / erreurs FAL | Clé manquante | Ajouter `kie` / `fal` dans Paramètres → Coffre. |
| La vidéo est plus longue/courte que demandé | Débit de la voix pas encore mesuré | Le débit réel est mémorisé dès le 1er run ; la garde de durée retire/ajoute des cartes. |
| `Remotion n'a produit aucun fichier` | Composition absente ou bundle cassé | `cd remotion && npx remotion compositions` ; corriger `Root.tsx`. |
| La page Data Ranking reste blanche | Script non chargé | Vérifier la ligne `js/pages/datarank.js` dans `index.html`, vider le cache (Ctrl+F5). |
| `Cannot find module './llm'` | Socle sans `llm.js` et installateur non relancé | `node install.js <racine>` (copie `if-missing/agent-os/lib/llm.js`). |
| Le Labo échoue en 403/429 sur YouTube | Limitation YouTube | Client `android` déjà forcé ; attendre, ne pas lancer de rafales. `yt-dlp` doit être à jour. |

## Désinstaller

Restaurer les sauvegardes : pour chaque `<fichier>.bak-datarank`, remettre le `.bak` à la place du fichier ; supprimer `agent-os/lib/machines/datarank*`, `agent-os/public/js/pages/datarank.js`, `agent-os/scripts/datarank.js`, `remotion/src/DataCarousel.tsx`. Les runs sont dans `agent-os/data/machines/runs/datarank/`, les vidéos dans `agent-os/output/machines/dr*/`.
