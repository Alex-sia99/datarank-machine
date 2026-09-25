/**
 * MACHINE DATA RANKING — onglets : Générer / Runs / Stock / Paramètres.
 * Wizard identique aux autres machines (rail wiz-head / wiz-rail / wiz-scroll).
 *
 * Étapes : Données (Wikipédia + Wikidata + relecture) → Script → Voix (phrase par carte) → Images (contrôlées Qwen)
 *          → Rendu (carrousel Remotion + contrôle) → Fini (titre, description + chapitres, tags, miniature, publication).
 * Mode semi-manuel : validation après Données, Script et Images.
 */
AgentOS.register("datarank", {
  title: "Data Ranking",
  async render(el, params) {
    const { api, esc, ago } = AgentOS;
    let cfg = await api("/api/machines/datarank");
    const TABS = ["gen", "runs", "stock", "settings"];
    let tab = TABS.includes(localStorage.getItem("dr-tab")) ? localStorage.getItem("dr-tab") : "gen";
    if (params && TABS.includes(params.get("tab"))) tab = params.get("tab");
    let wizTimer = null;
    this.onLeave = () => clearTimeout(wizTimer);
    const media = (rel, ts) => `/media/${encodeURIComponent(rel)}${ts ? `?v=${ts}` : ""}`;
    const costOf = (run) => Object.values(run.cost || {}).reduce((a, b) => a + b, 0);
    const dur = (sec) => (sec ? `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, "0")} s` : "");

    function shell() {
      el.innerHTML = `
        <div class="card">
          <h2><a href="#/machines" class="back-btn" style="margin-right:10px" title="Retour aux Machines">←</a>📊 Data Ranking
            <span class="h-actions">
              <span class="mini-seg" id="dr-tabs">
                <button data-t="gen" class="${tab === "gen" ? "active" : ""}">⚙ Générer</button>
                <button data-t="runs" class="${tab === "runs" ? "active" : ""}">🎞 Runs</button>
                <button data-t="stock" class="${tab === "stock" ? "active" : ""}">📦 Stock</button>
                <button data-t="settings" class="${tab === "settings" ? "active" : ""}">🛠 Paramètres</button>
              </span>
            </span>
          </h2>
          <div id="dr-body"></div>
        </div>`;
      el.querySelectorAll("#dr-tabs button").forEach((b) =>
        b.addEventListener("click", () => {
          tab = b.dataset.t;
          try { localStorage.setItem("dr-tab", tab); } catch {}
          shell();
        })
      );
      ({ gen: renderGen, runs: renderRuns, stock: renderStock, settings: renderSettings })[tab]();
    }

    // ═══════════════════════════ Onglet Générer ═══════════════════════════
    async function renderGen() {
      const body = el.querySelector("#dr-body");
      let chans = [];
      try { chans = await api("/api/channels"); } catch {}
      const s = cfg.settings;
      const defMin = s.durationMin || 5;
      body.innerHTML = `
        <label class="field"><span>Sujet de la vidéo <span class="muted">(en anglais — classement chiffré ou « … From Different Countries » ; 💡 pour 6 idées tirées de la banque de niche)</span></span>
          <span class="row" style="gap:6px">
            <input id="g-topic" class="grow" placeholder="ex : Tallest Building in Every Country · Martial Arts From Different Countries · Most Visited Cities">
            <button class="btn btn-sm" id="g-idea" title="Proposer des sujets d'après la banque de niche">💡</button>
          </span></label>
        <div id="g-ideas"></div>
        <div class="grid grid-4 mb" style="align-items:end">
          <label class="field" style="margin:0"><span>Durée : <b id="g-dlbl">${defMin}</b> min <span class="muted">(~<b id="g-clbl">?</b> cartes)</span></span>
            <input type="range" id="g-dur" min="1" max="20" step="0.5" value="${defMin}" style="width:100%"></label>
          <label class="field" style="margin:0"><span>Voix Inworld <span class="muted">(débit mesuré)</span></span>
            <select id="g-voice">${cfg.voices.map((v) => `<option value="${esc(v.name)}"${v.name === s.voice ? " selected" : ""}>${esc(v.name)} — ${v.wpm} mots/min</option>`).join("")}</select></label>
          <label class="field" style="margin:0"><span>🖼 Modèle d'image</span>
            <select id="g-img">${cfg.imageModels.map((m) => `<option value="${m.id}"${m.id === s.imageModel ? " selected" : ""}>${esc(m.name)} — ${m.price.toFixed(2)} $</option>`).join("")}</select></label>
          <label class="field" style="margin:0"><span>🎵 Volume musique : <b id="g-mvlbl">${Math.round((s.musicVolume || 0.07) * 100)}</b> %</span>
            <input type="range" id="g-mvol" min="2" max="30" step="1" value="${Math.round((s.musicVolume || 0.07) * 100)}" style="width:100%"></label>
        </div>
        <div class="fbar mb" style="padding:10px 12px;flex-wrap:wrap;gap:12px">
          <span class="fbar-item"><span>Musique de fond</span>
            <span class="mini-seg" id="g-music"><button data-v="0"${s.music ? "" : ' class="active"'}>Non</button><button data-v="1"${s.music ? ' class="active"' : ""}>Oui</button></span></span>
          <span class="fbar-item"><span>Mode</span>
            <span class="mini-seg" id="g-mode"><button class="active" data-v="semi">Semi-manuel</button><button data-v="auto">100 % auto</button></span></span>
        </div>
        <div class="fbar mb" style="padding:10px 12px">
          <span class="fbar-item"><span>Publication automatique</span>
            <span class="mini-seg" id="g-pub"><button class="active" data-v="0">Non</button><button data-v="1">Oui</button></span></span>
          <span class="fbar-item" id="g-pubchan-wrap" style="display:none"><span>Chaîne</span>
            <select id="g-pubchan" style="min-width:170px"><option value="">— choisis la chaîne —</option></select> <select id="g-pubpriv" style="width:150px"><option value="private" selected>🔒 Privée</option><option value="unlisted">🔗 Non répertoriée</option><option value="public">🌍 Publique</option></select></span>
          <span id="g-cost" style="margin-left:auto;font-weight:800;font-size:17px;color:#4ade80;background:rgba(74,222,128,.09);border:1px solid rgba(74,222,128,.35);border-radius:10px;padding:9px 16px;white-space:nowrap"></span>
          <button class="btn btn-accent" id="g-go" style="font-size:14px;padding:10px 22px">⚙ Générer</button>
        </div>
        <div class="small muted" style="text-align:right">Données (Wikipédia · Wikidata · relecture) → Script → Voix Inworld (1 phrase / carte) → Images (drapeaux · portraits · logos · détourages IA contrôlés) → Carrousel Remotion → Packaging SEO</div>`;

      const $ = (q) => body.querySelector(q);
      const seg = (id, cb) => body.querySelectorAll(`#${id} button`).forEach((b) =>
        b.addEventListener("click", () => { body.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("active", x === b)); cb && cb(b.dataset.v); }));
      const activeVal = (id) => body.querySelector(`#${id} button.active`).dataset.v;

      const costLine = async () => {
        $("#g-dlbl").textContent = $("#g-dur").value;
        try {
          const e = await api("/api/machines/datarank/estimate", { method: "POST", body: { durationSec: Number($("#g-dur").value) * 60, voice: $("#g-voice").value, imageModel: $("#g-img").value } });
          $("#g-clbl").textContent = e.cards;
          const musicOff = activeVal("g-music") === "0";
          const total = e.usd - (musicOff ? e.detail.music : 0);
          const c = $("#g-cost");
          c.textContent = `≈ ${total.toFixed(2)} $`;
          c.title = `~${e.cards} cartes · voix ${e.wpm} mots/min · images ${e.detail.images}$ · voix ${e.detail.voice}$ · musique ${musicOff ? 0 : e.detail.music}$ · texte ${e.detail.llm}$ · contrôles ${e.detail.check}$`;
        } catch {}
      };
      $("#g-dur").addEventListener("input", costLine);
      $("#g-voice").addEventListener("change", costLine);
      $("#g-img").addEventListener("change", costLine);
      $("#g-mvol").addEventListener("input", (e) => ($("#g-mvlbl").textContent = e.target.value));
      seg("g-mode"); seg("g-music", costLine);
      costLine();

      const pubChan = $("#g-pubchan");
      const goBtn = $("#g-go");
      const pubOn = () => activeVal("g-pub") === "1";
      const gateGo = () => (goBtn.disabled = pubOn() && !pubChan.value);
      pubChan.innerHTML = `<option value="">— choisis la chaîne —</option>` + chans.filter((c) => !c.error).map((c) => `<option value="${esc(c.channelId)}">${esc(c.title)}</option>`).join("");
      pubChan.addEventListener("change", gateGo);
      seg("g-pub", () => { $("#g-pubchan-wrap").style.display = pubOn() ? "" : "none"; gateGo(); });

      $("#g-idea").addEventListener("click", async () => {
        const input = $("#g-topic"), btn = $("#g-idea");
        input.classList.add("ai-thinking"); input.disabled = true; input.placeholder = "💡 Je fouille la niche…";
        btn.disabled = true; btn.textContent = "⏳";
        try {
          const { ideas } = await api("/api/machines/datarank/idea", { method: "POST" });
          if (ideas[0] && !input.value) input.value = ideas[0].topic;
          $("#g-ideas").innerHTML = `<div class="row mb" style="gap:6px;flex-wrap:wrap">${ideas.map((i) => `<button class="btn btn-sm btn-ghost" data-topic="${esc(i.topic)}" title="${esc(i.why)} — valeur : ${esc(i.criterion || "")}">${esc(i.topic)}</button>`).join("")}</div>`;
          $("#g-ideas").querySelectorAll("[data-topic]").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.topic; }));
        } catch (e) { AgentOS.toast(e.message, "err"); }
        input.classList.remove("ai-thinking"); input.disabled = false;
        input.placeholder = "ex : Tallest Building in Every Country";
        btn.disabled = false; btn.textContent = "💡";
      });

      goBtn.addEventListener("click", async () => {
        const topic = $("#g-topic").value.trim();
        if (!topic) return AgentOS.toast("Donne un sujet, ou clique 💡", "err");
        goBtn.disabled = true; goBtn.textContent = "⏳ Lancement…";
        try {
          const run = await api("/api/machines/datarank/runs", { method: "POST", body: {
            topic, durationSec: Number($("#g-dur").value) * 60, voice: $("#g-voice").value, imageModel: $("#g-img").value,
            music: activeVal("g-music") === "1", musicVolume: Number($("#g-mvol").value) / 100, mode: activeVal("g-mode"),
            publishChannelId: pubOn() ? pubChan.value : null, publishPrivacy: $("#g-pubpriv").value,
          }});
          AgentOS.toast("🚀 Run lancé", "ok");
          openWizard(run.id);
        } catch (e) { AgentOS.toast(e.message, "err"); }
        goBtn.disabled = false; goBtn.textContent = "⚙ Générer";
        gateGo();
      });
    }

    // ═══════════════════════════ Wizard ═══════════════════════════
    const STEPS = [
      { key: "data", icon: "📊", label: "Données" },
      { key: "script", icon: "📝", label: "Script" },
      { key: "voice", icon: "🎙", label: "Voix" },
      { key: "assets", icon: "🖼", label: "Images" },
      { key: "render", icon: "🎞", label: "Rendu" },
    ];
    const FINI = STEPS.length;
    const ORDER = ["data", "script", "voice", "assets", "render", "qa", "package"];
    function stepIndex(status) {
      const k = String(status || "").replace(/_(running|done|ready)$/, "");
      if (k === "qa" || k === "package") return 4;
      const i = STEPS.findIndex((s) => s.key === k);
      return i < 0 ? (status === "done" ? FINI : 0) : i;
    }
    function stepDone(run, i) {
      if (i === 0) return !!(run.items && run.items.length);
      if (i === 1) return !!(run.script && run.script.lines);
      if (i === 2) return !!run.timeline;
      if (i === 3) return !!(run.items && run.items.length && run.items.every((x) => x.asset && (x.asset.image || x.asset.error)));
      return !!run.finalRel;
    }
    function globalPct(run) {
      if (run.status === "done") return 100;
      const k = String(run.status || "").replace(/_(running|done|ready)$/, "");
      const base = { data: 4, script: 16, voice: 26, assets: 36, render: 74, qa: 92, package: 96 }[k] ?? 2;
      if (k === "assets" && run.items) return base + Math.round((36 * run.items.filter((x) => x.asset && x.asset.image).length) / run.items.length);
      if (k === "render") { const m = (run.log || []).slice().reverse().find((l) => /rendu (\d+) %/.test(l.msg)); return base + (m ? Math.round((18 * Number(/rendu (\d+) %/.exec(m.msg)[1])) / 100) : 0); }
      return /_(done|ready)$/.test(run.status) ? base + 8 : base;
    }
    function countHTML(run) {
      const it = run.items || [];
      if (!it.length) return "";
      const k = String(run.status || "").replace(/_(running|done|ready)$/, "");
      if (k === "assets") {
        const done = it.filter((x) => x.asset && x.asset.image).length;
        const fail = it.filter((x) => x.asset && x.asset.error).length;
        return `🖼 ${done}/${it.length} images${fail ? ` · <span style="color:var(--err)">${fail} échec</span>` : ""}`;
      }
      const src = it.filter((x) => x.fromSource).length;
      return `📊 ${it.length} cartes · ${run.meta?.mode === "catalog" ? "catalogue (un par pays)" : "classement croissant"} · ${src} tirées de Wikipédia${run.timeline ? ` · ${dur(run.timeline.total)}` : ""}`;
    }

    function openWizard(runId) {
      const overlay = document.createElement("div");
      overlay.className = "picker-overlay";
      overlay.innerHTML = `<div class="scrap-modal lg" id="wiz"><span class="spin"></span></div>`;
      document.body.appendChild(overlay);
      const tick = async () => {
        let run;
        try { run = await api("/api/machines/datarank/runs/" + runId); }
        catch (e) { overlay.querySelector("#wiz").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
        const box = overlay.querySelector("#wiz");
        const it = run.items || [];
        const shellKey = [run.status, box.dataset.view || "", it.length, run.error ? 1 : 0, it.filter((x) => x.asset && x.asset.image).length, it.filter((x) => x.pending).length,
          it.map((x) => (x.asset && x.asset.ts) || 0).reduce((a, b) => a + b, 0), run.script ? 1 : 0, run.timeline ? 1 : 0, run.finalRel ? 1 : 0,
          run.pack ? run.pack.thumbTs || 1 : 0, run.published ? 1 : 0, run.needsRender ? 1 : 0, (run.log || []).length > 0 && /rendu \d+ %/.test(run.log[run.log.length - 1].msg) ? run.log.length : 0].join("|");
        if (box.dataset.shellKey !== shellKey || !box.querySelector(".wiz-scroll")) {
          box.dataset.shellKey = shellKey;
          renderWizard(box, run, overlay);
        }
        if ((run.running || /_running$/.test(run.status)) && document.body.contains(overlay)) {
          clearTimeout(wizTimer);
          wizTimer = setTimeout(tick, 4000);
        }
      };
      tick();
    }

    function renderWizard(box, run, overlay) {
      const idx = stepIndex(run.status);
      const running = !!run.running;
      const viewIdx = box.dataset.view !== undefined && box.dataset.view !== "" ? Number(box.dataset.view) : Math.min(idx, FINI);
      const prevScroll = box.querySelector(".wiz-scroll")?.scrollTop || 0;
      const gpct = globalPct(run);
      const validateLabel = { data_ready: "✓ Valider les données → Script", script_ready: "✓ Valider le script → Voix + Images", assets_ready: "✓ Valider les images → Rendu" }[run.status];
      const k = String(run.status || "").replace(/_(running|done|ready)$/, "");
      const runMsg = running ? {
        data: "Recherche : tableaux Wikipédia, recoupement Wikidata, relecture critique…",
        script: "Écriture de la voix off (une phrase par carte) + script doctor…",
        voice: "Voix Inworld phrase par phrase, timeline calée sur le carrousel, ajustement de durée…",
        assets: "Drapeaux, portraits, logos, détourages IA contrôlés par Qwen — 5 en parallèle…",
        render: "Rendu Remotion du carrousel (intro, cartes, voix, musique, écran de fin)…",
        qa: "Contrôle final du rendu par Qwen…",
        package: "Titre, description avec chapitres, tags, miniature…",
      }[k] || "" : "";
      box.classList.add("wiz-modal");
      box.innerHTML = `
        <div class="wiz-head">
          <div class="wiz-gbar" title="Progression : ${gpct}%"><div style="width:${gpct}%"></div></div>
          <div class="row between" style="margin:10px 0 4px">
            <h2 style="margin:0;font-size:15px">📊 ${esc(run.pack?.title || run.meta?.title || run.params.topic)}
              <span class="small muted mono" style="margin-left:8px">${run.id} · ${run.params.mode || "auto"} · ${esc(run.params.voice)} · ${Math.round(run.params.durationSec / 6) / 10} min · ${costOf(run).toFixed(2)}$ · ${gpct}%</span></h2>
            <span class="row" style="gap:6px">
              ${run.status !== "done" && !running ? `<button class="btn btn-sm" data-zap-run title="⚡ Décharge : relance le run là où il s'est arrêté">⚡</button>` : ""}
              ${running ? `<button class="btn btn-sm" data-cancel-run title="Annuler ce run">🛑 Annuler</button>` : ""}
              <button class="btn btn-sm btn-ghost" data-close>✕</button>
            </span>
          </div>
          <div class="wiz-rail">
            ${STEPS.map((s, i) => `
              <div class="wiz-step ${stepDone(run, i) ? "done" : i === idx ? "active" : ""}" data-view="${i}" style="cursor:pointer" title="${s.label}">
                <div class="wiz-dot" ${i === viewIdx ? 'style="outline:2px solid var(--accent);outline-offset:3px"' : ""}>${stepDone(run, i) ? "✓" : i < idx ? "⚠" : s.icon}</div><span>${s.label}</span>
              </div>
              ${i < STEPS.length - 1 ? `<div class="wiz-link ${stepDone(run, i) ? "done" : i === idx && running ? "active" : ""}"></div>` : ""}`).join("")}
            <div class="wiz-link ${run.status === "done" ? "done" : k === "package" ? "active" : ""}"></div>
            <div class="wiz-step ${run.status === "done" ? "done" : ""}" data-view="${FINI}" style="cursor:pointer" title="Titre, description, tags, miniature, publication">
              <div class="wiz-dot" ${viewIdx === FINI ? 'style="outline:2px solid var(--accent);outline-offset:3px"' : ""}>🏁</div><span>Fini</span>
            </div>
          </div>
          ${run.error ? `<div class="empty small" style="color:var(--err);margin:0"><b>Échec</b>${esc(run.error)} <button class="btn btn-sm" data-retry>↻ Reprendre où on s'est arrêté</button></div>` : ""}
          ${running ? `<div class="small muted"><span class="spin" style="width:12px;height:12px"></span> ${esc(runMsg)}</div>` : ""}
          ${run.needsRender && !running ? `<div class="empty small" style="margin:0;color:var(--warn)">Une image a été régénérée après le rendu. <button class="btn btn-sm btn-accent" data-rerender>🎞 Re-rendre la vidéo</button></div>` : ""}
          <div class="small" style="font-weight:600;color:var(--accent)">${countHTML(run)}</div>
        </div>
        <div class="wiz-scroll">${viewHTML(run, viewIdx)}</div>
        ${validateLabel && !running ? `<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn btn-accent" data-validate>${validateLabel}</button></div>` : ""}`;

      box.querySelector("[data-close]").addEventListener("click", () => { clearTimeout(wizTimer); overlay.remove(); });
      box.querySelectorAll(".wiz-step[data-view]").forEach((s) => s.addEventListener("click", () => { box.dataset.view = s.dataset.view; renderWizard(box, run, overlay); }));
      const on = (sel, fn) => { const b = box.querySelector(sel); if (b) b.addEventListener("click", () => fn(b)); };
      const reopen = (view) => { clearTimeout(wizTimer); overlay.remove(); openWizard(run.id); if (view !== undefined) setTimeout(() => { const w = document.querySelector("#wiz"); if (w) w.dataset.view = String(view); }, 0); };
      const post = async (b, action, bodyObj, okMsg, label) => {
        b.disabled = true; const old = b.textContent; b.textContent = "⏳";
        try { await api(`/api/machines/datarank/runs/${run.id}/${action}`, { method: "POST", body: bodyObj || {} }); if (okMsg) AgentOS.toast(okMsg, "ok"); reopen(); }
        catch (e) { AgentOS.toast(e.message, "err"); b.disabled = false; b.textContent = label || old; }
      };
      on("[data-validate]", (b) => post(b, "validate", {}, null));
      on("[data-cancel-run]", (b) => post(b, "cancel", {}, "Run annulé 🛑"));
      on("[data-zap-run]", (b) => post(b, "resume", {}, "⚡ Décharge envoyée", "⚡"));
      on("[data-retry]", (b) => post(b, "resume", {}, "⚡ Reprise"));
      on("[data-rerender]", (b) => post(b, "resume", { from: "render" }, "🎞 Rendu relancé"));
      wireView(box, run, viewIdx, reopen);
      const sc = box.querySelector(".wiz-scroll");
      if (sc) sc.scrollTop = prevScroll;
    }

    // ── Contenu d'une étape ──
    function viewHTML(run, viewIdx) {
      const key = STEPS[viewIdx]?.key || "fini";
      const it = run.items || [];
      const idle = !run.running;
      const redo = (step, label) => idle && run.status !== "created" ? `<button class="mini-btn" data-from="${step}" title="Refaire cette étape (et les suivantes)">↻ ${label}</button>` : "";

      if (key === "data") {
        if (!it.length) return `<div class="empty small"><span class="spin"></span> Recherche des données (tableaux Wikipédia, Wikidata, relecture)…</div>`;
        return `<div class="row between mb"><span class="small muted">${esc(run.meta?.title || "")} · ${run.meta?.mode === "catalog" ? "catalogue" : "classement croissant"} · images ${run.meta?.style === "illustration" ? "illustrations" : "photos / détourages"} · sources : ${(run.sources || []).map((x) => `<a href="${esc(x.url)}" target="_blank">${esc(x.title)}</a>`).join(", ") || "modèle + Wikidata"}</span>${redo("data", "Refaire les données")}</div>
          ${it.map((x) => `<div class="scrap-row" style="gap:10px">
            <span class="badge" style="flex:none;width:44px;text-align:center">${run.meta?.mode === "catalog" ? x.rank : "#" + x.rank}</span>
            <b class="small" style="flex:none;width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.wiki || "")}">${esc(x.name)}</b>
            <span class="small" style="flex:none;width:150px">${x.iso2 ? `<img src="https://flagcdn.com/w40/${esc(x.iso2)}.png" style="height:12px;margin-right:5px;vertical-align:-1px">` : ""}${esc(x.country || "")}</span>
            <b class="small mono" style="flex:none;width:110px">${esc(x.display || "")}</b>
            <span class="small muted grow" style="min-width:0">${esc(x.fact || "")}</span>
            <span class="small muted" style="flex:none;width:170px;text-align:right" title="${esc(x.review || "")}">${esc(x.check || (x.fromSource ? "source Wikipédia" : "mémoire du modèle"))}</span>
          </div>`).join("")}
          ${(run.rejected || []).length ? `<div class="small muted" style="margin-top:8px">Écartées : ${run.rejected.map((r) => `${esc(r.name)} <span class="muted">(${esc(r.why)})</span>`).join(" · ")}</div>` : ""}`;
      }

      if (key === "script") {
        if (!run.script) return `<div class="empty small"><span class="spin"></span> Écriture de la voix off…</div>`;
        const editable = run.status === "script_ready";
        const area = (attr, v, rows = 2) => editable ? `<textarea ${attr} rows="${rows}" style="width:100%;font-size:12px;line-height:1.5">${esc(v)}</textarea>` : `<div class="small" style="line-height:1.55">${esc(v)}</div>`;
        const n = [run.script.intro, ...run.script.lines, run.script.outro].join(" ").split(/\s+/).length;
        return `<div class="row between mb"><span class="small muted">${n} mots · une phrase par carte, lue au moment où la carte arrive${editable ? " · chaque phrase est éditable" : ""}</span>${redo("script", "Réécrire le script")}</div>
          <div class="scrap-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:8px 12px"><b class="small">🎬 Intro</b>${area('data-part="intro"', run.script.intro, 3)}</div>
          ${it.map((x) => `<div class="scrap-row" style="gap:10px;align-items:flex-start;padding:8px 12px">
            <span class="badge" style="flex:none;width:44px;text-align:center">${x.rank}</span>
            <span class="small" style="flex:none;width:170px"><b>${esc(x.name)}</b><br><span class="muted">${esc(x.display || "")}</span></span>
            <span class="grow" style="min-width:0">${area(`data-rank="${x.rank}"`, x.line || "")}</span>
          </div>`).join("")}
          <div class="scrap-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:8px 12px"><b class="small">🏁 Outro</b>${area('data-part="outro"', run.script.outro, 2)}</div>`;
      }

      if (key === "voice") {
        if (!run.timeline) return `<div class="empty small"><span class="spin"></span> Synthèse de la voix, phrase par phrase…</div>`;
        const tl = run.timeline;
        return `<audio controls src="${media(`agent-os/output/machines/${run.id}/vo.wav`)}" style="width:100%;margin-bottom:10px"></audio>
          <div class="row mb" style="gap:18px;flex-wrap:wrap">
            <span class="small">durée <b>${dur(tl.total)}</b></span><span class="small">intro <b>${tl.introSec.toFixed(1)} s</b></span>
            <span class="small"><b>${((tl.outroStart - it[0].start) / it.length).toFixed(1)} s</b> par carte</span>
            <span class="small">débit <b>${run.voiceWpm || "?"}</b> mots/min</span>
            ${run.trimmed ? `<span class="small" style="color:var(--warn)">✂ retirées : ${esc(run.trimmed.join(", "))}</span>` : ""}
            ${run.extended ? `<span class="small" style="color:var(--accent)">➕ ajoutées : ${esc(run.extended.join(", "))}</span>` : ""}
            ${redo("voice", "Refaire la voix")}
          </div>
          ${it.map((x) => `<div class="scrap-row" style="gap:10px">
            <span class="small mono" style="flex:none;width:110px">${x.start.toFixed(1)}s → ${x.end.toFixed(1)}s</span>
            <span class="badge" style="flex:none;width:44px;text-align:center">${x.rank}</span>
            <span class="small grow" style="min-width:0">${esc(x.line || "")}</span>
          </div>`).join("")}`;
      }

      if (key === "assets") {
        if (!it.some((x) => x.asset && (x.asset.image || x.asset.flag))) return `<div class="empty small">${run.running && /assets/.test(run.status) ? '<span class="spin"></span> ' : ""}Les images arrivent après la voix.</div>`;
        const canRegen = idle;
        return `<div class="row between mb"><span class="small muted">${it.filter((x) => x.asset && x.asset.image).length}/${it.length} images · note Qwen de fidélité · ↻ régénère une image (consigne optionnelle)${run.finalRel ? " — la vidéo devra être re-rendue" : ""}</span>${redo("assets", "Refaire toutes les images")}</div>
          <div class="row" style="gap:8px;flex-wrap:wrap">${it.map((x) => {
            const a = x.asset || {};
            return `<div class="scrap-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px;width:160px;${a.error && !a.image ? "border-color:var(--err)" : ""}" title="${esc(x.name)} — ${esc(x.look || "")}">
              ${a.image ? `<img src="${media(`agent-os/output/machines/${run.id}/assets/${a.image}`, a.ts)}" style="width:100%;height:150px;object-fit:${a.fit === "cover" ? "cover" : "contain"};border-radius:6px;background:linear-gradient(#fff,#c9d4e6)">`
                : `<div class="empty small" style="height:150px;margin:0;display:flex;align-items:center;justify-content:center">${x.pending ? '<span class="spin"></span>' : a.error ? "❌" : "⏳"}</div>`}
              <span class="row between" style="align-items:center">
                <span class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.flag ? `<img src="${media(`agent-os/output/machines/${run.id}/assets/${a.flag}`)}" style="height:11px;margin-right:4px;vertical-align:-1px">` : ""}<b>${x.rank}</b> ${esc(x.name)}</span>
                ${canRegen ? `<button class="mini-btn" data-regen-card="${x.rank}" title="Régénérer cette image" ${x.pending ? "disabled" : ""}>↻</button>` : ""}
              </span>
              <span class="small muted" style="font-size:10px">${esc(a.src || "")}${a.score != null ? ` · ✔ ${a.score}/10` : ""}${(a.checks || []).length > 1 ? ` (${a.checks.length} essais)` : ""}${a.fallback ? " · repli photo" : ""}${a.weak ? ' · <span style="color:var(--warn)">faible</span>' : ""}</span>
            </div>`;
          }).join("")}</div>`;
      }

      if (key === "render") {
        if (!run.finalRel && !(run.output && run.output.rel)) return run.running && /render|qa/.test(run.status)
          ? `<div class="empty small"><span class="spin"></span> Rendu du carrousel en cours…</div>`
          : `<div class="empty small">La vidéo n'est pas encore rendue.</div>`;
        const rel = run.finalRel || run.output.rel;
        const qa = run.qa;
        return `<video src="${media(rel, new Date(run.updatedAt).getTime())}" controls style="width:100%;max-height:430px;border-radius:12px;background:#000"></video>
          <div class="row between mt"><span class="small muted">${it.length} cartes · ${dur(run.output?.seconds)} · rendu en ${run.output?.renderMin || "?"} min${qa ? ` · 🧪 contrôle final <b>${qa.overall ?? "—"}/10</b> — ${esc(qa.summary || "")}` : ""}</span>
            <span class="row" style="gap:6px">${redo("render", "Re-rendre")}<a class="btn btn-sm btn-accent" href="${media(rel)}" download>⬇ Télécharger</a></span></div>`;
      }

      // ── Fini : packaging SEO prêt à poster ──
      const pk = run.pack;
      if (!pk) return run.running && /package/.test(run.status)
        ? `<div class="empty small"><span class="spin"></span> Titre, description avec chapitres, tags, miniature…</div>`
        : `<div class="empty small">La vidéo n'est pas encore rendue.</div>`;
      return `
        ${run.published?.url
          ? `<div class="empty small" style="margin:0 0 10px;color:#4ade80;border-color:rgba(74,222,128,.4)"><b>📤 Publiée (${esc(run.published.privacyStatus)})</b><a href="${esc(run.published.url)}" target="_blank">▶ Voir sur YouTube</a></div>`
          : `<div class="small muted" style="margin-bottom:8px">📦 La vidéo attend dans le <b>Stock</b> — tout est prêt à poster : publie-la ci-dessous ou copie les textes.</div>`}
        <div class="row" style="gap:16px;align-items:flex-start">
          <div style="flex:none;width:290px">
            ${pk.thumbRel ? `<img src="${media(pk.thumbRel, pk.thumbTs)}" style="width:290px;border-radius:10px;border:1px solid var(--border-soft)">` : `<div class="empty small">Pas de miniature</div>`}
            <div class="small muted" style="text-align:center;margin-top:4px">Miniature au code de la niche : les 4 premières cartes + bandeau</div>
            <div class="row" style="gap:5px;margin-top:6px">
              <input type="text" id="pk-banner" value="${esc(pk.banner || run.meta?.banner || "")}" placeholder="TEXTE DU BANDEAU" style="flex:1;font-size:11px;text-transform:uppercase">
              <button class="mini-btn" data-thumb-text title="Recomposer la miniature (gratuit)">↻</button>
            </div>
            ${run.finalRel ? `<a class="btn btn-sm btn-ghost" style="width:100%;margin-top:8px;text-align:center" href="${media(run.finalRel)}" download>⬇ Télécharger la vidéo</a>` : ""}
            ${pk.thumbRel ? `<a class="btn btn-sm btn-ghost" style="width:100%;margin-top:6px;text-align:center" href="${media(pk.thumbRel)}" download>⬇ Télécharger la miniature</a>` : ""}
          </div>
          <div class="grow" style="min-width:0">
            <input type="text" id="pk-text-instr" placeholder="Observation pour régénérer un texte (optionnel)…" style="width:100%;font-size:11px;margin-bottom:8px">
            <label class="field"><span class="row between">Titre <span class="row" style="gap:5px"><span class="small muted mono">${(pk.title || "").length}/100</span><button class="mini-btn" data-copy="pk-title">📋</button><button class="mini-btn" data-regen-text="title">↻💡</button></span></span><input type="text" id="pk-title" value="${esc(pk.title || "")}"></label>
            ${(pk.titleAlt || []).length ? `<div class="small muted" style="margin:-4px 0 8px">Variantes : ${pk.titleAlt.map((t) => `<a href="#" data-alt="${esc(t)}">${esc(t)}</a>`).join(" · ")}</div>` : ""}
            <label class="field"><span class="row between">Description <span class="muted small">(chapitres inclus : un par carte)</span><span class="row" style="gap:5px"><button class="mini-btn" data-copy="pk-desc">📋</button><button class="mini-btn" data-regen-text="description">↻💡</button></span></span><textarea id="pk-desc" rows="9">${esc(pk.description || "")}</textarea></label>
            <label class="field"><span class="row between">Tags <span class="row" style="gap:5px"><span class="small muted mono">${(pk.tags || []).join(", ").length}/500</span><button class="mini-btn" data-copy="pk-tags">📋</button><button class="mini-btn" data-regen-text="tags">↻💡</button></span></span><textarea id="pk-tags" rows="2">${esc((pk.tags || []).join(", "))}</textarea></label>
            <div class="row" style="gap:8px">
              <button class="btn btn-sm btn-ghost" data-save-texts title="Enregistrer les textes modifiés à la main">💾 Enregistrer</button>
              <select id="pk-chan" style="flex:1"><option value="">— chaîne YouTube —</option></select>
              <select id="pk-priv" style="width:170px" title="Mode de publication">
                <option value="private" selected>🔒 Privée</option><option value="unlisted">🔗 Non répertoriée</option><option value="public">🌍 Publique</option>
              </select>
              <button class="btn btn-sm btn-accent" data-publish disabled>📤 Publier</button>
            </div>
          </div>
        </div>`;
    }

    // ── Interactions d'une étape ──
    function wireView(box, run, viewIdx, reopen) {
      const texts = () => ({ title: box.querySelector("#pk-title").value, description: box.querySelector("#pk-desc").value, tags: box.querySelector("#pk-tags").value.split(",").map((x) => x.trim()).filter(Boolean) });
      box.querySelectorAll("[data-from]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm(`${b.textContent.trim()} ? Les étapes suivantes seront refaites.`)) return;
        b.disabled = true;
        try { await api(`/api/machines/datarank/runs/${run.id}/resume`, { method: "POST", body: { from: b.dataset.from } }); AgentOS.toast("Étape relancée", "ok"); reopen(); }
        catch (e) { AgentOS.toast(e.message, "err"); b.disabled = false; }
      }));
      box.querySelectorAll("textarea[data-rank], textarea[data-part]").forEach((ta) => ta.addEventListener("change", async () => {
        try {
          await api(`/api/machines/datarank/runs/${run.id}/line`, { method: "POST", body: ta.dataset.part ? { part: ta.dataset.part, text: ta.value } : { rank: Number(ta.dataset.rank), text: ta.value } });
          AgentOS.toast("Phrase enregistrée", "ok");
        } catch (e) { AgentOS.toast(e.message, "err"); }
      }));
      box.querySelectorAll("[data-regen-card]").forEach((b) => b.addEventListener("click", async () => {
        const ins = prompt("Consigne pour cette image (laisse vide pour simplement en refaire une) :", "");
        if (ins === null) return;
        b.disabled = true; b.textContent = "⏳";
        api(`/api/machines/datarank/runs/${run.id}/regen`, { method: "POST", body: { rank: Number(b.dataset.regenCard), instructions: ins } })
          .then(() => { AgentOS.toast("Image régénérée 🎨", "ok"); box.dataset.view = "3"; reopen(3); })
          .catch((e) => { AgentOS.toast(e.message, "err"); b.disabled = false; b.textContent = "↻"; });
      }));
      box.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", (e) => {
        e.preventDefault();
        const src = box.querySelector("#" + b.dataset.copy);
        if (src) { navigator.clipboard.writeText(src.value); AgentOS.toast("Copié 📋", "ok"); }
      }));
      box.querySelectorAll("[data-alt]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); box.querySelector("#pk-title").value = a.dataset.alt; }));
      box.querySelectorAll("[data-regen-text]").forEach((b) => b.addEventListener("click", async () => {
        const instructions = box.querySelector("#pk-text-instr")?.value || "";
        b.disabled = true; b.textContent = "⏳";
        try { await api(`/api/machines/datarank/runs/${run.id}/texts`, { method: "POST", body: { instructions, field: b.dataset.regenText } }); AgentOS.toast("Régénéré 🔄", "ok"); reopen(FINI); }
        catch (e) { AgentOS.toast(e.message, "err"); b.disabled = false; b.textContent = "↻💡"; }
      }));
      const sv = box.querySelector("[data-save-texts]");
      if (sv) sv.addEventListener("click", async () => {
        try { await api(`/api/machines/datarank/runs/${run.id}/save-texts`, { method: "POST", body: texts() }); AgentOS.toast("Textes enregistrés 💾", "ok"); }
        catch (e) { AgentOS.toast(e.message, "err"); }
      });
      const tt = box.querySelector("[data-thumb-text]");
      if (tt) tt.addEventListener("click", async () => {
        tt.disabled = true; tt.textContent = "⏳";
        try { await api(`/api/machines/datarank/runs/${run.id}/thumb-text`, { method: "POST", body: { banner: box.querySelector("#pk-banner").value } }); AgentOS.toast("Miniature recomposée ↻", "ok"); reopen(FINI); }
        catch (e) { AgentOS.toast(e.message, "err"); tt.disabled = false; tt.textContent = "↻"; }
      });
      const pub = box.querySelector("[data-publish]");
      if (pub) {
        const sel = box.querySelector("#pk-chan");
        api("/api/channels").then((chs) => {
          sel.innerHTML = `<option value="">— chaîne YouTube —</option>` + chs.filter((c) => !c.error).map((c) => `<option value="${esc(c.channelId)}">${esc(c.title)}</option>`).join("");
        }).catch(() => {});
        sel.addEventListener("change", () => (pub.disabled = !sel.value));
        pub.addEventListener("click", async () => {
          pub.disabled = true; pub.textContent = "⏳ Envoi…";
          try {
            const r = await api(`/api/machines/datarank/runs/${run.id}/publish`, { method: "POST", body: { channelId: sel.value, privacyStatus: box.querySelector("#pk-priv").value, ...texts() } });
            AgentOS.toast("📤 Publiée : " + r.url, "ok");
            reopen(FINI);
          } catch (e) { AgentOS.toast(e.message, "err"); pub.disabled = false; pub.textContent = "📤 Publier"; }
        });
      }
    }

    // ═══════════════════════════ Onglet Runs ═══════════════════════════
    async function renderRuns() {
      const body = el.querySelector("#dr-body");
      const runs = await api("/api/machines/datarank/runs");
      const BADGE = { done: ["✓ terminé", "ok"], failed: ["✗ échec", "err"] };
      body.innerHTML = runs.length
        ? runs.map((r) => {
            const [lb, bd] = BADGE[r.status] || (/_ready$/.test(r.status) ? ["⏸ à valider", "warn"] : ["⏳ en cours", "warn"]);
            return `<div class="scrap-row ${r.status === "done" ? "done" : r.status === "failed" ? "failed" : ""}" style="cursor:pointer" data-run="${r.id}">
              <b class="small grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</b>
              <span class="small muted">${r.cards || 0} cartes${r.seconds ? " · " + dur(r.seconds) : ` · ${Math.round(r.durationSec / 6) / 10} min visées`} · ${r.mode}${r.qa != null ? ` · 🧪 ${r.qa}/10` : ""}${r.published ? " · 📤" : ""}</span>
              <span class="small mono row-stat">${r.cost ? r.cost.toFixed(2) + "$" : ""}</span>
              <span class="small muted">${ago(r.createdAt)}</span>
              <span class="badge ${bd}">${lb}</span>
              ${r.status !== "done" && !r.running ? `<button class="mini-btn" data-zap="${r.id}" title="⚡ Décharge : relance le run">⚡</button>` : ""}
              ${r.running ? `<button class="mini-btn" data-cancel="${r.id}" title="Annuler">🛑</button>` : ""}
            </div>`;
          }).join("")
        : `<div class="empty">Aucun run — lance ta première vidéo dans ⚙ Générer.</div>`;
      body.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => openWizard(b.dataset.run)));
      body.querySelectorAll("[data-zap]").forEach((b) => b.addEventListener("click", async (e) => {
        e.stopPropagation(); b.disabled = true; b.textContent = "⏳";
        try { await api(`/api/machines/datarank/runs/${b.dataset.zap}/resume`, { method: "POST", body: {} }); AgentOS.toast("⚡ Décharge envoyée", "ok"); openWizard(b.dataset.zap); }
        catch (err) { AgentOS.toast(err.message, "err"); }
        renderRuns();
      }));
      body.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async (e) => {
        e.stopPropagation(); b.disabled = true;
        try { await api(`/api/machines/datarank/runs/${b.dataset.cancel}/cancel`, { method: "POST" }); AgentOS.toast("Run annulé 🛑", "ok"); } catch (err) { AgentOS.toast(err.message, "err"); }
        renderRuns();
      }));
    }

    // ═══════════════════════════ Onglet Stock ═══════════════════════════
    async function renderStock() {
      const body = el.querySelector("#dr-body");
      let stock = [];
      try { stock = await api("/api/machines/datarank/stock"); } catch {}
      const live = stock.filter((v) => !v.archived);
      body.innerHTML = live.length
        ? live.map((v) => `
            <div class="scrap-row ${v.posted ? "done" : ""}" style="cursor:pointer;border-left:3px solid ${v.posted ? "var(--ok,#4ade80)" : "var(--accent)"}" data-run="${esc(v.id)}">
              ${v.thumbRel ? `<img src="${media(v.thumbRel)}" style="width:74px;height:42px;object-fit:cover;border-radius:6px;flex:none">` : `<span style="width:74px;text-align:center">📊</span>`}
              <b class="small grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.title)}</b>
              <span class="small muted">${v.cards || 0} cartes · ${dur(v.durationSec)}</span>
              <span class="small muted">${AgentOS.dateFr(v.createdAt)}</span>
              <span class="badge ${v.posted ? "ok" : "warn"}">${v.posted ? "📤 postée" : "en stock"}</span>
              <button class="mini-btn" data-archive="${esc(v.id)}" title="Archiver">🗄</button>
            </div>`).join("")
        : `<div class="empty">Stock vide — les vidéos terminées arrivent ici, prêtes à poster.</div>`;
      body.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => { openWizard(b.dataset.run); setTimeout(() => { const w = document.querySelector("#wiz"); if (w) w.dataset.view = String(FINI); }, 0); }));
      body.querySelectorAll("[data-archive]").forEach((b) => b.addEventListener("click", async (e) => {
        e.stopPropagation();
        try { await api(`/api/machines/datarank/stock/${b.dataset.archive}`, { method: "PATCH", body: { archived: true } }); renderStock(); } catch (err) { AgentOS.toast(err.message, "err"); }
      }));
    }

    // ═══════════════════════════ Onglet Paramètres ═══════════════════════════
    async function renderSettings() {
      const body = el.querySelector("#dr-body");
      let niches = [];
      try { niches = await api("/api/bank/niches"); } catch {}
      const s = cfg.settings;
      const th = s.theme || {};
      body.innerHTML = `
        <div class="small" style="font-weight:700;color:var(--ink-2);margin-bottom:6px">📐 CHIFFRES DE LA NICHE <span class="muted" style="font-weight:400">(mesurés par le Labo — docs/RECETTE-NICHE-DATARANK.md : ~6-12 s par carte, 3-4 cartes visibles, intro 10-20 s)</span></div>
        <div class="grid grid-4" style="align-items:end">
          <label class="field"><span>⏱ Durée par défaut : <b id="s-durlbl">${s.durationMin || 5}</b> min</span><input type="range" id="s-dur" min="1" max="20" step="0.5" value="${s.durationMin || 5}"></label>
          <label class="field"><span>🃏 Durée mini d'une carte : <b id="s-minlbl">${s.minCardSec}</b> s</span><input type="range" id="s-min" min="4" max="12" step="0.5" value="${s.minCardSec}"></label>
          <label class="field"><span>🤫 Silence après chaque phrase : <b id="s-padlbl">${s.cardPad}</b> s</span><input type="range" id="s-pad" min="0" max="2" step="0.1" value="${s.cardPad}"></label>
          <label class="field"><span>🎬 Intro minimum : <b id="s-introlbl">${s.introMinSec}</b> s</span><input type="range" id="s-intro" min="5" max="25" step="1" value="${s.introMinSec}"></label>
        </div>
        <div class="small" style="font-weight:700;color:var(--ink-2);margin:10px 0 6px">🎨 IMAGES & STYLE</div>
        <div class="grid grid-4" style="align-items:end">
          <label class="field"><span>🖼 Modèle d'image par défaut</span><select id="s-model">${cfg.imageModels.map((m) => `<option value="${m.id}"${s.imageModel === m.id ? " selected" : ""}>${esc(m.name)} — ${m.price.toFixed(2)} $</option>`).join("")}</select></label>
          <div class="field"><span>Objets et lieux</span><span class="row" style="gap:10px"><label class="small" title="Recréation détourée par l'IA à partir de la photo Wikipédia, contrôlée par Qwen ; sinon la photo brute"><input type="checkbox" id="s-cut" ${s.cutout ? "checked" : ""}> détourage IA (sinon photo Wikipédia)</label></span></div>
          <label class="field"><span>🎨 Carte : fond / fond 2 / nom / bande pays</span><span class="row" style="gap:6px"><input type="color" data-th="bg" value="${esc(th.bg)}"><input type="color" data-th="bg2" value="${esc(th.bg2)}"><input type="color" data-th="name" value="${esc(th.name)}"><input type="color" data-th="band" value="${esc(th.band)}"></span></label>
          <label class="field"><span>🎨 Badge / bandeau / surlignage / valeur</span><span class="row" style="gap:6px"><input type="color" data-th="badge" value="${esc(th.badge)}"><input type="color" data-th="accent" value="${esc(th.accent)}"><input type="color" data-th="value" value="${esc(th.value)}"><input type="color" data-th="valueFg" value="${esc(th.valueFg)}"></span></label>
        </div>
        <div class="small" style="font-weight:700;color:var(--ink-2);margin:10px 0 6px">🎙 VOIX & MUSIQUE</div>
        <div class="grid grid-4" style="align-items:end">
          <label class="field"><span>🎙 Voix Inworld par défaut</span><select id="s-voice">${cfg.voices.map((v) => `<option value="${esc(v.name)}"${v.name === s.voice ? " selected" : ""}>${esc(v.name)} — ${v.wpm} mots/min</option>`).join("")}</select></label>
          <label class="field"><span>🎵 Musique par défaut · volume <b id="s-mvlbl">${Math.round((s.musicVolume || 0.07) * 100)}</b> %</span><span class="row" style="gap:6px"><label class="small"><input type="checkbox" id="s-music" ${s.music ? "checked" : ""}> oui</label><input type="range" id="s-mvol" min="2" max="30" step="1" value="${Math.round((s.musicVolume || 0.07) * 100)}" style="flex:1"></span></label>
          <label class="field"><span>✍ Moteur de texte</span><input value="Qwen 3.7 Plus — OpenRouter (repli Claude)" disabled></label>
          <label class="field"><span>🏦 Banque de niche liée</span><select id="s-niche"><option value="">— aucune —</option>${niches.map((n) => `<option value="${n.id}"${cfg.nicheId === n.id ? " selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>
        </div>
        <label class="field"><span>🎵 Style Suno de la musique de fond</span><textarea id="s-mstyle" rows="2">${esc(s.musicStyle || "")}</textarea></label>
        <div class="small" style="font-weight:700;color:var(--ink-2);margin:10px 0 6px">📤 PUBLICATION</div>
        <div class="grid grid-3" style="align-items:end">
          <label class="field"><span>🌍 Langue de la chaîne <span class="muted">(titre, description, tags)</span></span><select id="s-chain">${["English", "Français", "Español", "Deutsch", "Italiano"].map((l) => `<option${(s.chainLanguage || "English") === l ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="field"><span>🔒 Confidentialité à la publication</span><select id="s-priv">${[["private", "🔒 Privée"], ["unlisted", "🔗 Non répertoriée"], ["public", "🌍 Publique"]].map(([v, l]) => `<option value="${v}"${(s.publishPrivacy || "private") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <div></div>
        </div>
        <button class="btn btn-accent" id="s-save">Enregistrer</button>`;
      const $ = (x) => body.querySelector(x);
      const bind = (id, lbl) => $(id).addEventListener("input", (e) => ($(lbl).textContent = e.target.value));
      bind("#s-dur", "#s-durlbl"); bind("#s-min", "#s-minlbl"); bind("#s-pad", "#s-padlbl"); bind("#s-intro", "#s-introlbl"); bind("#s-mvol", "#s-mvlbl");
      $("#s-save").addEventListener("click", async () => {
        const theme = { ...th };
        body.querySelectorAll("[data-th]").forEach((i) => (theme[i.dataset.th] = i.value));
        try {
          await api("/api/machines/datarank", { method: "PATCH", body: {
            nicheId: $("#s-niche").value || null,
            settings: {
              durationMin: Number($("#s-dur").value), minCardSec: Number($("#s-min").value), cardPad: Number($("#s-pad").value), introMinSec: Number($("#s-intro").value),
              imageModel: $("#s-model").value, cutout: $("#s-cut").checked, theme, voice: $("#s-voice").value,
              music: $("#s-music").checked, musicVolume: Number($("#s-mvol").value) / 100, musicStyle: $("#s-mstyle").value.trim(),
              chainLanguage: $("#s-chain").value, publishPrivacy: $("#s-priv").value,
            },
          }});
          cfg = await api("/api/machines/datarank");
          AgentOS.toast("Paramètres enregistrés", "ok");
        } catch (e) { AgentOS.toast(e.message, "err"); }
      });
    }

    shell();
    // lien direct : #/datarank?run=<id>
    if (params && params.get("run")) openWizard(params.get("run"));
  },
});
