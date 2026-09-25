import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { z } from "zod";

// Carrousel « data ranking » de la machine DATA RANKING — mécanique mesurée par le Labo sur la niche
// (Aesthetic Data, Rank India, List Data, okz, Nerd Cassette…) :
//  - intro plein écran : photo du n°1 en teaser + titre + bouton s'abonner, puis les cartes entrent par la DROITE ;
//  - une rangée de cartes verticales (badge de rang, nom, grande image, pays + drapeau, grosse valeur, libellé)
//    qui défile de droite à gauche À VITESSE CONTINUE, ~3,5 cartes visibles, ordre croissant (compte à rebours) ;
//  - la voix off commente UNE carte par phrase : la caméra est calée sur le DÉBUT de chaque phrase (la carte
//    commentée arrive au point focal quand sa phrase commence et le quitte quand la suivante commence) → le
//    mouvement suit la voix, et la carte commentée est surlignée (liseré + valeur qui « claque ») ;
//  - bandeau titre jaune permanent en bas ; écran de fin « thanks for watching ».
// Tout est en secondes dans les props (timeline calculée côté Node à partir des durées RÉELLES du TTS).
export const FPS = 30;

const cardSchema = z.object({
  rank: z.number(),
  name: z.string(),
  sub: z.string(),            // pays / entreprise / catégorie (bande du milieu)
  flag: z.string().optional(), // fichier drapeau dans public/<dir>/
  image: z.string().optional(),
  fit: z.enum(["cover", "cutout", "logo"]),
  value: z.string(),          // « 828 m »
  unit: z.string(),           // « HEIGHT »
  extra: z.string().optional(), // ligne secondaire (ville, année…)
  start: z.number(),          // début de la phrase de voix off (s)
  end: z.number(),            // fin de la phrase (s)
});
export const dataCarouselSchema = z.object({
  dir: z.string(),
  audio: z.string().optional(),
  music: z.string().optional(),
  musicVolume: z.number(),
  title: z.string(),
  banner: z.string(),
  intro: z.object({ seconds: z.number(), image: z.string().optional(), kicker: z.string(), title: z.string(), subtitle: z.string() }),
  outro: z.object({ seconds: z.number(), text: z.string(), sub: z.string() }),
  cards: z.array(cardSchema),
  theme: z.object({
    bg: z.string(), bg2: z.string(), name: z.string(), nameFg: z.string(), band: z.string(), bandFg: z.string(),
    value: z.string(), valueFg: z.string(), badge: z.string(), badgeFg: z.string(), accent: z.string(), font: z.string(),
  }),
  totalSeconds: z.number(),
  hideRank: z.boolean().optional(), // mode catalogue (« … From Different Countries ») : pas de rang
});
type Props = z.infer<typeof dataCarouselSchema>;
type Card = z.infer<typeof cardSchema>;

export const DEFAULT_THEME = {
  bg: "#0d1b2a", bg2: "#1b3a5c", name: "#8b0000", nameFg: "#ffffff", band: "#0b2a6b", bandFg: "#ffffff",
  value: "#ffffff", valueFg: "#111111", badge: "#ffd400", badgeFg: "#111111", accent: "#ffd400",
  font: "'Arial Black', 'Segoe UI Black', Impact, sans-serif",
};

// Géométrie (1920×1080)
const W = 500;          // largeur d'une carte
const GAP = 18;
const P = W + GAP;      // pas du carrousel
const TOP = 34;
const H = 900;          // hauteur d'une carte
const XS = 1920 * 0.64; // centre de la carte commentée au DÉBUT de sa phrase (puis elle glisse d'un pas vers la gauche)
const ENTER = 1.6;      // secondes d'entrée des cartes par la droite (fin d'intro)

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const src = (dir: string, f?: string) => (f ? (/^https?:/.test(f) ? f : staticFile(dir ? `${dir}/${f}` : f)) : "");

/** Position de la caméra (px) à l'instant t : linéaire entre les débuts de phrases → vitesse continue. */
function camAt(t: number, cards: Card[], introEnd: number): number {
  if (!cards.length) return 0;
  const key = (k: number) => k * P + W / 2 - XS;
  const t0 = cards[0].start;
  if (t <= t0) {
    // entrée : la première carte part du bord droit (x = 1920) et rejoint le point focal avec un ralenti
    const from = -1920;
    return interpolate(t, [Math.min(introEnd, t0) - ENTER, t0], [from, key(0)], { ...clamp, easing: Easing.out(Easing.cubic) });
  }
  for (let k = 0; k < cards.length - 1; k++) {
    if (t < cards[k + 1].start) return interpolate(t, [cards[k].start, cards[k + 1].start], [key(k), key(k + 1)], clamp);
  }
  // dernière carte : elle glisse jusqu'au centre et s'y arrête (le n°1 reste à l'écran)
  const last = cards.length - 1;
  const settle = key(last) + (XS - 960);
  return interpolate(t, [cards[last].start, cards[last].end + 0.6], [key(last), settle], { ...clamp, easing: Easing.inOut(Easing.cubic) });
}

const CardView: React.FC<{ c: Card; x: number; t: number; dir: string; theme: Props["theme"]; zoomT: number; hideRank?: boolean }> = ({ c, x, t, dir, theme, zoomT, hideRank }) => {
  const active = t >= c.start - 0.15 && t < c.end + 0.25;
  const hl = active ? interpolate(t, [c.start - 0.15, c.start + 0.15], [0, 1], clamp) * interpolate(t, [c.end, c.end + 0.25], [1, 0], clamp) : 0;
  const pop = interpolate(t, [c.start, c.start + 0.18, c.start + 0.42], [1, 1.12, 1], clamp);
  const zoom = interpolate(zoomT, [0, 1], [1.02, 1.12], clamp);
  const n = c.name.length;
  const nameSize = n <= 11 ? 40 : n <= 16 ? 34 : n <= 24 ? 29 : n <= 34 ? 24 : 20;
  return (
    <div style={{ position: "absolute", left: x, top: TOP, width: W, height: H, borderRadius: 10, overflow: "hidden", background: "#ffffff",
      boxShadow: `0 18px 40px rgba(0,0,0,0.45), 0 0 0 ${6 * hl}px ${theme.accent}`, display: "flex", flexDirection: "column" }}>
      {/* nom */}
      <div style={{ height: 96, background: theme.name, color: theme.nameFg, display: "flex", alignItems: "center", justifyContent: "center", padding: hideRank ? "0 14px" : "0 14px 0 86px",
        fontFamily: theme.font, fontSize: nameSize, lineHeight: 1.02, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {c.name}
      </div>
      {/* image */}
      <div style={{ position: "relative", height: 452, overflow: "hidden",
        background: c.fit === "cover" ? "#222" : `radial-gradient(circle at 50% 42%, #ffffff 0%, #e9eef6 45%, #c9d4e6 100%)` }}>
        {c.image ? (
          <Img src={src(dir, c.image)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: c.fit === "cover" ? "cover" : "contain", padding: c.fit === "logo" ? 60 : c.fit === "cutout" ? 14 : 0,
            scale: String(c.fit === "cover" ? zoom : 1), objectPosition: "50% 35%" }} />
        ) : null}
      </div>
      {/* pays / catégorie + drapeau */}
      <div style={{ height: 82, background: theme.band, color: theme.bandFg, display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
        fontFamily: theme.font, fontSize: c.sub.length > 18 ? 26 : 32, textTransform: "uppercase", padding: "0 12px" }}>
        {c.flag ? <Img src={src(dir, c.flag)} style={{ height: 50, width: 75, objectFit: "cover", borderRadius: 5, border: "2px solid rgba(255,255,255,0.85)" }} /> : null}
        <span style={{ textAlign: "center", lineHeight: 1.05 }}>{c.sub}</span>
      </div>
      {/* valeur */}
      <div style={{ flex: 1, background: theme.value, color: theme.valueFg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
        <div style={{ fontFamily: theme.font, fontSize: c.value.length > 14 ? 46 : c.value.length > 9 ? 62 : 88, textAlign: "center", padding: "0 10px", lineHeight: 1, scale: String(pop), letterSpacing: -1 }}>{c.value}</div>
        <div style={{ fontFamily: "Arial, sans-serif", fontWeight: 800, fontSize: 24, letterSpacing: 2, color: "#444", textTransform: "uppercase" }}>{c.unit}</div>
        {c.extra ? <div style={{ fontFamily: "Arial, sans-serif", fontWeight: 700, fontSize: 22, color: "#777", marginTop: 4 }}>{c.extra}</div> : null}
      </div>
      {/* badge de rang */}
      {hideRank ? null : <div style={{ position: "absolute", left: 0, top: 0, width: 78, height: 96, background: theme.badge, color: theme.badgeFg, display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: theme.font, fontSize: c.rank >= 100 ? 34 : 44 }}>
        {c.rank}
      </div>}
    </div>
  );
};

const Thumb = () => (
  <svg width="44" height="44" viewBox="0 0 24 24"><path fill="#111" d="M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L13.2 1 6.6 7.6C6.2 8 6 8.5 6 9v10c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z" /></svg>
);
const Bell = ({ ring }: { ring: number }) => (
  <svg width="44" height="44" viewBox="0 0 24 24" style={{ rotate: `${ring}deg` }}><path fill="#111" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4c0-.8-.7-1.5-1.5-1.5s-1.5.7-1.5 1.5v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1l-2-2z" /></svg>
);
const Hand = () => (
  <svg width="56" height="56" viewBox="0 0 24 24"><path fill="#fff" stroke="#111" strokeWidth="1.2" d="M9 11.2V4.5a1.5 1.5 0 0 1 3 0v5.3l.1-.1a1.5 1.5 0 0 1 2.9.5v.4a1.5 1.5 0 0 1 2.8.7v.6a1.5 1.5 0 0 1 2.7.9V17c0 2.8-2.2 5-5 5h-2.3c-1.6 0-3.1-.8-4-2.1L5.6 15a1.6 1.6 0 0 1 2.5-2l.9 1.1z" /></svg>
);
const Subscribe: React.FC<{ t: number; at: number }> = ({ t, at }) => {
  const inO = interpolate(t, [at, at + 0.35, at + 3.2, at + 3.6], [0, 1, 1, 0], clamp);
  const clicked = t > at + 1.4;
  const press = interpolate(t, [at + 1.25, at + 1.4, at + 1.55], [1, 0.9, 1], clamp);
  const cx = interpolate(t, [at + 0.4, at + 1.3], [260, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <div style={{ position: "absolute", left: "50%", top: 70, translate: "-50% 0", opacity: inO, display: "flex", alignItems: "center", gap: 18,
      background: "#ffffff", borderRadius: 50, padding: "14px 22px", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
      <Thumb />
      <div style={{ background: clicked ? "#8a8a8a" : "#e00000", color: "#fff", fontFamily: "Arial, sans-serif", fontWeight: 900, fontSize: 30, padding: "12px 28px", borderRadius: 40, scale: String(press) }}>
        {clicked ? "SUBSCRIBED" : "SUBSCRIBE"}
      </div>
      <Bell ring={clicked ? Math.sin((t - at) * 30) * 14 * interpolate(t, [at + 1.6, at + 2.6], [1, 0], clamp) : 0} />
      <span style={{ position: "absolute", left: `calc(50% + ${cx}px)`, top: 50, opacity: t < at + 2.2 ? 1 : 0 }}><Hand /></span>
    </div>
  );
};

export const DataCarousel: React.FC<Props> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const introEnd = p.intro.seconds;
  const cam = camAt(t, p.cards, introEnd);
  const outroStart = p.totalSeconds - p.outro.seconds;
  const th = p.theme;

  const introO = interpolate(t, [introEnd - 0.2, introEnd + 1.2], [1, 0], clamp);
  const heroZoom = interpolate(t, [0, introEnd], [1.0, 1.14], clamp);
  const titleIn = interpolate(t, [0.3, 1.1], [0, 1], { ...clamp, easing: Easing.out(Easing.back(1.6)) });
  const bannerIn = interpolate(t, [introEnd - 1.2, introEnd - 0.6], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const outroO = interpolate(t, [outroStart, outroStart + 0.6], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${th.bg2} 0%, ${th.bg} 70%)`, overflow: "hidden" }}>
      {/* motif discret */}
      <AbsoluteFill style={{ opacity: 0.12, backgroundImage: "radial-gradient(rgba(255,255,255,0.9) 1.5px, transparent 1.5px)", backgroundSize: "34px 34px", translate: `${-(cam * 0.15) % 34}px 0` }} />

      {/* intro */}
      {introO > 0 ? (
        <AbsoluteFill style={{ opacity: introO, background: '#000' }}>
          {p.intro.image ? <Img src={src(p.dir, p.intro.image)} style={{ width: "100%", height: "100%", objectFit: "cover", scale: String(heroZoom) }} /> : null}
          <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.25) 45%, rgba(0,0,0,0.85) 100%)" }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 150, display: "flex", flexDirection: "column", alignItems: "center", gap: 18, scale: String(0.8 + 0.2 * titleIn), opacity: titleIn }}>
            <div style={{ background: th.badge, color: th.badgeFg, fontFamily: th.font, fontSize: 40, padding: "6px 26px", borderRadius: 6 }}>{p.intro.kicker}</div>
            <div style={{ color: "#fff", fontFamily: th.font, fontSize: p.intro.title.length > 30 ? 84 : 104, lineHeight: 1.02, textAlign: "center", textTransform: "uppercase", maxWidth: 1700, textShadow: "0 6px 24px rgba(0,0,0,0.8)" }}>{p.intro.title}</div>
            <div style={{ color: "#fff", fontFamily: "Arial, sans-serif", fontWeight: 800, fontSize: 38, opacity: 0.92, textShadow: "0 3px 12px rgba(0,0,0,0.8)" }}>{p.intro.subtitle}</div>
          </div>
          <Subscribe t={t} at={Math.min(4, introEnd * 0.35)} />
        </AbsoluteFill>
      ) : null}

      {/* cartes */}
      {p.cards.map((c, k) => {
        const x = k * P - cam;
        if (x > 1920 + 20 || x < -W - 20) return null;
        const zoomT = interpolate(x, [-W, 1920], [1, 0], clamp);
        return <CardView key={k} c={c} x={x} t={t} dir={p.dir} theme={th} zoomT={zoomT} hideRank={p.hideRank} />;
      })}

      {/* bandeau titre permanent */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 118, background: th.badge, color: th.badgeFg, display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: th.font, fontSize: p.banner.length > 42 ? 44 : 54, textTransform: "uppercase", letterSpacing: 1, translate: `0 ${(1 - bannerIn) * 130}px`, boxShadow: "0 -6px 20px rgba(0,0,0,0.35)" }}>
        {p.banner}
      </div>

      {/* outro : écran de fin opaque façon niche (Rank India…) + 2 emplacements pour les vignettes de fin YouTube (5-20 s) */}
      {outroO > 0 ? (
        <AbsoluteFill style={{ background: `linear-gradient(180deg, #0b1320 0%, #04070d 100%)`, opacity: outroO, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 34 }}>
          <div style={{ color: "#fff", fontFamily: th.font, fontSize: 104, textTransform: "uppercase", letterSpacing: 1 }}>{p.outro.text}</div>
          <div style={{ display: "flex", gap: 90, alignItems: "center" }}>
            {["NEXT VIDEO", "BEST VIDEO"].map((l, i) => (
              <div key={l} style={{ width: 620, height: 349, borderRadius: 18, border: `5px solid ${i ? th.accent : "#7fb2ff"}`, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 18,
                background: "rgba(255,255,255,0.04)", color: i ? th.accent : "#7fb2ff", fontFamily: "Arial, sans-serif", fontWeight: 900, fontSize: 38, letterSpacing: 2 }}>{l}</div>
            ))}
          </div>
          <div style={{ color: th.accent, fontFamily: "Arial, sans-serif", fontWeight: 900, fontSize: 40 }}>{p.outro.sub}</div>
          <Subscribe t={t} at={outroStart + 0.8} />
        </AbsoluteFill>
      ) : null}

      {p.audio ? <Audio src={src(p.dir, p.audio)} /> : null}
      {p.music ? <Audio src={src(p.dir, p.music)} volume={p.musicVolume} loop /> : null}
    </AbsoluteFill>
  );
};

export const dataCarouselFrames = (p: Props) => Math.max(1, Math.round(p.totalSeconds * FPS));

// Miniature (1280×720) : les 4 premières places du classement côte à côte + bandeau titre — le code des miniatures
// de la niche (des cartes du carrousel, drapeaux et valeurs bien lisibles).
export const DataThumb: React.FC<Props> = (p) => {
  const top = p.cards.slice(-4);
  const innerW = 4 * P - GAP + 60;
  const innerH = TOP + H + 136;
  const sc = Math.min(1280 / innerW, 720 / innerH);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.theme.bg2} 0%, ${p.theme.bg} 70%)`, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: (1280 - innerW * sc) / 2, top: 0, width: innerW, height: innerH, scale: String(sc), transformOrigin: "0 0" }}>
        {top.map((c, k) => <CardView key={k} c={c} x={30 + k * P} t={-100} dir={p.dir} theme={p.theme} zoomT={0.4} hideRank={p.hideRank} />)}
        <div style={{ position: "absolute", left: -2000, right: -2000, top: 720 / sc - 118, height: 118, background: p.theme.badge, color: p.theme.badgeFg, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: p.theme.font, fontSize: p.banner.length > 34 ? 56 : 68, textTransform: "uppercase" }}>{p.banner}</div>
      </div>
    </AbsoluteFill>
  );
};
