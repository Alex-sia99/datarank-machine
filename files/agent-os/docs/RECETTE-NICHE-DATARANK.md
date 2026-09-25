# Recette de niche — Data Ranking (carrousels data)

Machine : `lib/machines/datarank.js` · page : `public/js/pages/datarank.js` · rendu : `remotion/src/DataCarousel.tsx` (`DataCarousel`, `DataThumb`) · CLI : `scripts/datarank.js`.
Banque : niche **« Data Ranking »** du Labo (10 chaînes de référence), + `data/lab/carousel/*.json` (analyse dédiée carrousel, `scripts/carousel-lab.js`).

## 1. Ce que la banque a mesuré (25 septembre 2026)

**Périmètre** : 10 chaînes (Rank India, Aesthetic Data, Datum Frames, Kami Data Comparison, World Info, List Data, okz data point, Nerd Cassette, Nerd Data, Country Cassette), **2 451 vidéos listées** par l'API Data, **95 décortiquées image par image** (1 image / 2 s, Qwen 3.7 Flash) en 2 h 36, puis **85 passées à l'analyse carrousel** (mise en page, vitesse, voix). Coût total du Labo ≈ 1,3 $.

| Mesure | Valeur | Commentaire |
|---|---|---|
| Durée médiane d'une vidéo | **5 min** (301 s) | Rank India 9-13 min, List Data 4-6 min, okz 7-14 min |
| Vues médianes | 11 400 | très concentré : les « From Different Countries » de List Data font des millions |
| Ordre | **compte à rebours croissant** 33 fois, montée 10 fois | le n°1 (la plus grande valeur) arrive à la fin |
| Cartes visibles | **3 à 4** | Aesthetic Data et Rank India : 3 ; List Data, World Info : 4 |
| Vitesse | **~6 à 12 s par carte** | mesurée par lecture des rangs : Aesthetic Data 5,8 s · Rank India 11,9 s. (La mesure par noms sature à 10 s : échantillon toutes les 10 s.) |
| Défilement | continu de droite à gauche (≈ moitié des vidéos), sinon par à-coups carte par carte | |
| Intro | **photo plein écran** 39 fois (souvent le n°1 en teaser), carte teaser 9, titre animé 6 | première carte vers 10-20 s |
| Voix off | **27 vidéos sur 85** | systématique chez Aesthetic Data et Rank India ; List Data / World Info / Kami : musique seule |
| Mots par carte (voix) | médiane 14-21 | Aesthetic Data ~21, Rank India ~14 |

**Grammaire d'une carte** (identique d'une chaîne à l'autre, seules les couleurs changent) : badge de rang (coin haut-gauche, jaune/vert) → nom en bandeau (rouge foncé / blanc) → **grande image** (photo recadrée, portrait, objet détouré, illustration) → bande pays + drapeau (bleu marine) → **grosse valeur** en gras (« 2.3 M », « $1B », « 828 m ») + libellé d'unité → ligne secondaire (ville · année). Bandeau titre permanent (jaune, texte noir) en bas ou en haut. Écran de fin « Thanks for watching » avec deux emplacements de vignettes de fin.

**Gabarit de voix off** (Aesthetic Data, 1,7 M vues) : intro « Hello everyone. Today video is about [sujet] by [critère]. Let's subscribe… » puis UNE phrase par carte : « [Nom] in [lieu], [participe varié : drawing / receiving / attracting / welcoming] [valeur] [unité], [verbe principal + fait marquant] », ~21 mots, verbes qui tournent, aucune transition explicite, outro « Thanks for joining ».

## 2. Les sujets (familles de titres, 2 435 vidéos longues)

| Famille | Vidéos | Vues médianes | Exemples top |
|---|---|---|---|
| **« X From Different Countries »** | **640** | **23 000** | Martial Arts (11 M), Shoes Brands (7,2 M), Car Company Founders (7,1 M), Landmarks (6,3 M), Dog Breeds (5,9 M) |
| Fondateurs / entreprises / marques | 297 | 22 100 | Founders of Smartphone Companies (3,9 M), Soft Drinks Brands |
| Timelines (années) | 87 | 11 700 | UK Prime Ministers (1721-2025), US Election Results |
| « vs » / Country Comparison | 266 | 11 400 | Qatar vs UAE (3,6 M), Turkey vs India |
| « Every country / 195 countries » | 247 | 10 000 | Most Powerful Passports (7,3 M), Roblox allowed or banned (3,8 M) |
| Most / Biggest / Tallest / Oldest | 517 | 7 100 | Most Visited Religious Places (1,7 M), Richest Supermarkets |
| Richest / net worth | 107 | 7 700 | 50 Richest Women in India (150 k) |

→ La machine a **deux formats** que le LLM choisit selon le sujet : **`ranking`** (valeur chiffrée, ordre croissant — le format demandé au départ) et **`catalog`** (un élément par pays, sans valeur, tour du monde par continent — la famille la plus vue).

**Mots SEO dominants** (tags) : `country data`, `comparison 3d`, `comparison`, `real data`, `animation`, `data`, `comparison video`, `data comparison`, `country comparison`, `countries comparison`, `from different countries`, `195 countries compared` + l'année + le nom de la chaîne. Titres : « … From Different Countries », « Top 50 … 2026 », « … Ranked by … », « 195 Countries … », « … | Their Net Worth and … ».

**Miniatures** : ce sont des **morceaux du carrousel** — 3 à 5 cartes côte à côte (drapeaux + valeurs très lisibles), rarement du texte ajouté ; pour les « vs » : deux dirigeants en illustration + drapeaux + « VS ». → `DataThumb` rend les 4 premières places du classement + bandeau titre.

## 3. La recette encodée dans la machine

1. **Données vérifiées** : articles Wikipédia « List of… » proposés par le LLM → texte des tableaux → le jeu de données est construit DEPUIS la source → Wikidata confirme la valeur (propriété choisie par le LLM) → relecture critique (corrige, remplace, ajoute les manquants, repère les homonymes via la description Wikipédia, exclut ce qui n'existe pas encore en 2026). Réserves gardées pour l'ajustement de durée.
2. **Script** : intro 35-55 mots (salut, sujet, critère en mots naturels, teaser du n°1, un appel à s'abonner) ; une phrase complète de 16-24 mots par carte (nom + valeur obligatoires, ouvertures variées, jalons « top 20 / top 10 / podium » au bon rang) ; outro 12-22 mots ; script doctor limité aux vrais défauts.
3. **Voix** Inworld phrase par phrase, débit réel mémorisé par voix ; timeline = début de chaque phrase ; garde de durée (retrait des cartes du bas / ajout de réserves).
4. **Images** : drapeaux flagcdn ; portraits = photo Wikipédia (jamais d'IA pour une vraie personne) ; logos = Wikidata P154 ; lieux/objets = **recréation détourée GPT Image 2.5** (ou Qwen Image 2.1) depuis la photo Wikipédia, au format de la silhouette ; catalogues « illustration » = cartoon plein cadre sur fond vif ; contrôle Qwen (fidélité, plausibilité, référence) + régénération ; image d'intro = photo du n°1.
5. **Rendu** `DataCarousel` : intro photo du n°1 + titre + s'abonner, cartes qui entrent par la droite, caméra linéaire entre les débuts de phrases (~3,7 cartes visibles), carte commentée surlignée, bandeau jaune permanent, n°1 qui se pose au centre, écran de fin avec 2 emplacements de vignettes ; musique Suno discrète (0,07).
6. **Contrôle final** Qwen sur 6 images du rendu + packaging (titre, description avec un chapitre par carte, tags).

## 4. Modèles d'image testés (Kie)

| Modèle | t2i / i2i | Délai | Coût | Verdict |
|---|---|---|---|---|
| `gpt-image-2-5-flare-text-to-image` / `-image-to-image` | `input_urls`, `aspect_ratio`, `resolution` 1K/2K/4K, **`background: transparent`** | 70-110 s | 6 crédits (~0,03 $) | **défaut** : détourage réel (canal alpha), fidèle à la référence (Merdeka 118, Burj Khalifa…), 8,6/10 de moyenne au contrôle |
| `qwen2-1/text-to-image` / `qwen2-1/image-to-image` | `image_urls`, `aspect_ratio`, `resolution` 1K/2K, `background`, `output_format` | 130-150 s | ~4 crédits en i2i | bon (8,4/10 sur les trains), plus lent, 832×1248 en 1K ; a raté le maglev L0 au 1er essai (objet minuscule) |

## 5. Premiers runs

| Run | Sujet | Durée | Cartes | Coût | Notes |
|---|---|---|---|---|---|
| `drmufqidr7` | Tallest Building in Every Country 2026 | 5:07 | 24 | 1,35 $ | GPT Image 2.5, voix Craig ; 3 boucles d'auto-correction (données, durée, images) |
| `drmuftflqr` | Fastest Trains in the World | 2:54 | 14 | ~1,7 $ (images régénérées 2×) | Qwen Image 2.1, voix Oliver ; format 3:2 pour les trains |
| `drmuftjbxh` | Martial Arts From Different Countries | 3:00 visé | 15 → 20 | — | mode catalogue + illustrations ; extension de durée par réserves |

Voix : débits réels mesurés (mots/min sur un vrai script) — Craig 125, Oliver 153-155. Débits de référence (phrase courte) dans `REF_WPM`.
