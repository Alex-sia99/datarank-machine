    // ===== MACHINE DATA RANKING ===== (carrousels data : sujet + durée → vidéo + packaging SEO)
    if (p === "/api/machines/datarank" && req.method === "GET") {
      const c = datarank.config();
      return json(res, 200, { ...c, voices: Object.keys(datarank.REF_WPM).map((v) => ({ name: v, wpm: datarank.voiceWpm(v) })).sort((a, b) => b.wpm - a.wpm), imageModels: Object.entries(datarank.IMG_MODELS).map(([id, m]) => ({ id, name: m.name, price: m.price })) });
    }
    if (p === "/api/machines/datarank" && req.method === "PATCH") { const b = await readBody(req); return json(res, 200, datarank.patchConfig(b)); }
    if (p === "/api/machines/datarank/estimate" && req.method === "POST") { const b = await readBody(req); return json(res, 200, datarank.estimate(b)); }
    if (p === "/api/machines/datarank/idea" && req.method === "POST") {
      try { return json(res, 200, { ideas: await datarank.suggestTopics(6) }); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === "/api/machines/datarank/runs" && req.method === "GET") return json(res, 200, datarank.listRuns().map(datarank.summary));
    if (p === "/api/machines/datarank/runs" && req.method === "POST") {
      const b = await readBody(req);
      try { const r = datarank.createRun(b); return json(res, 200, datarank.start(r.id)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    m = /^\/api\/machines\/datarank\/runs\/([\w-]+)$/.exec(p);
    if (m && req.method === "GET") { const r = datarank.getRun(m[1]); return r ? json(res, 200, { ...r, running: datarank.isLive(r.id) }) : json(res, 404, { error: "run introuvable" }); }
    m = /^\/api\/machines\/datarank\/runs\/([\w-]+)\/(resume|validate|cancel|publish|texts|save-texts|thumb-text|regen|line)$/.exec(p);
    if (m && req.method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      try {
        const id = m[1];
        switch (m[2]) {
          case "resume": return json(res, 200, datarank.start(id, b.from || null));
          case "validate": return json(res, 200, datarank.validate(id));
          case "cancel": return json(res, 200, datarank.cancelRun(id));
          case "publish": return json(res, 200, await datarank.publishRun(id, b));
          case "texts": return json(res, 200, await datarank.regenTexts(id, b));
          case "save-texts": return json(res, 200, datarank.saveTexts(id, b));
          case "thumb-text": return json(res, 200, await datarank.restyleThumbnail(id, b));
          case "regen": return json(res, 200, await datarank.regenImage(id, b.rank, b.instructions || ""));
          case "line": return json(res, 200, datarank.editLine(id, b));
        }
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    // ===== FIN MACHINE DATA RANKING =====
