// Código que roda dentro da página do Stremio (web.stremio.com no WebView2), injetado pelo programa
// do PC pela porta CDP. Fica em window.__strc. Só lê o estado do core (window.core) e busca dados
// nos addons instalados; a tela só muda no play (rota do player) e nos comandos do player.
// As fontes (com os links e as chaves dos addons) ficam aqui dentro: o celular só recebe nome e id.
(() => {
  const V = "__VERSION__";
  // A página ainda carregando: sem o core, não instala (senão ficaria um __strc quebrado)
  if (!window.core) throw new Error("o Stremio ainda está carregando");
  if (window.__strc && window.__strc.v === V && window.__strc.core === window.core) return;
  const core = window.core;
  const S = { v: V, core, streams: new Map(), seq: 0 };
  const base = (u) => u.replace(/\/manifest\.json$/, "");
  const res = (a, name, type, id) => a.manifest.resources.some((r) =>
    (r === name || r.name === name) &&
    (typeof r === "string" || !r.types || r.types.includes(type)) &&
    (typeof r === "string" || !r.idPrefixes || r.idPrefixes.some((p) => id.startsWith(p)))) &&
    (a.manifest.types || []).includes(type) &&
    (!a.manifest.idPrefixes || !id || a.manifest.idPrefixes.some((p) => id.startsWith(p)));
  const getJson = async (url, ms = 15000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  const addons = async () => (await core.getState("ctx")).profile.addons;
  const cinemeta = (list) => list.find((a) => a.manifest.id === "com.linvo.cinemeta");
  const epInfo = (vid) => {
    const m = /:(\d+):(\d+)$/.exec(vid || "");
    return m ? `${m[1]}x${m[2]}` : ""; // como no título do player do Stremio
  };

  // Traduções do próprio Stremio: o i18next que a interface dele usa (getI18n do react-i18next), no
  // idioma escolhido nele. Acha o módulo pelo código (o react-i18next já está carregado pela página).
  let i18nObj = null;
  const i18n = () => {
    if (i18nObj) return i18nObj;
    let req = null;
    try { window.webpackChunkstremio.push([[Symbol("strc")], {}, (r) => { req = r; }]); } catch (e) {}
    if (!req) return null;
    for (const id of Object.keys(req.m)) {
      let src = "";
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (!src.includes("initReactI18next") || !src.includes("getI18n")) continue;
      try {
        const v = req(id).getI18n();
        if (v && typeof v.t === "function") { i18nObj = v; return v; }
      } catch (e) {}
    }
    return null;
  };
  S.lang = async () => {
    const v = i18n();
    return (v && (v.resolvedLanguage || v.language)) || (await core.getState("ctx")).profile.settings.interfaceLanguage || "";
  };
  S.i18n = async (keys) => {
    const lang = await S.lang();
    const v = i18n();
    const dict = {};
    if (v) for (const k of keys || []) {
      const s = v.t(k);
      if (typeof s === "string" && s && (s !== k || (v.exists && v.exists(k)))) dict[k] = s;
    }
    return { lang, dict };
  };

  S.profile = async () => {
    const c = await core.getState("ctx");
    return { email: c.profile.auth?.user?.email || "" };
  };

  const item = (i) => ({
    type: i.type, id: i._id, name: i.name, poster: i.poster || "",
    progress: Math.round(Math.min(100, i.progress || 0) * 10) / 10,
    videoId: i.state?.videoId || "",
    info: i.type === "series" ? epInfo(i.state?.videoId) : "",
    badge: i.notifications || 0
  });

  S.list = async (which) => {
    if (which === "cw") return (await core.getState("continue_watching_preview")).items.map(item);
    let lib = await core.getState("library");
    if (!lib.selected && !location.hash.startsWith("#/library")) {
      core.dispatch({ action: "Load", args: { model: "LibraryWithFilters", args: { request: { type: null, sort: "lastwatched", page: 1 } } } }, "library");
      for (let k = 0; k < 30 && !(lib = await core.getState("library")).selected; k++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      lib = await core.getState("library");
    }
    return (lib.catalog || []).map(item);
  };

  // Board do Stremio (as mesmas seções, na mesma ordem): o modelo "board" do core. Se a interface
  // ainda não carregou (o PC está em outra tela), carrega no core, sem mudar a tela.
  const metaItem = (m) => ({ type: m.type, id: m.id, name: m.name, poster: m.poster || "", info: m.releaseInfo || "" });
  const onBoard = () => location.hash === "#/" || location.hash === "" || location.hash.startsWith("#/?");
  S.board = async () => {
    let b = await core.getState("board");
    if (!b.selected && !onBoard()) {
      core.dispatch({ action: "Load", args: { model: "CatalogsWithExtra", args: { type: null, extra: [] } } }, "board");
    }
    // Espera as seções carregarem (até ~8 s); as que não vierem vão vazias
    for (let i = 0; i < 40; i++) {
      b = await core.getState("board");
      const cats = b.catalogs || [];
      if (b.selected && cats.length && !cats.some((c) => (Array.isArray(c) ? c[0] : c)?.content?.type === "Loading")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const list = await addons();
    const v = i18n();
    const tr = (k, fb) => (v && v.exists && v.exists(k) ? v.t(k) : fb);
    return (b.catalogs || []).map((c0) => {
      const c = Array.isArray(c0) ? c0[0] : c0;
      if (!c || !c.addon) return null;
      // O board só traz id e nome do addon: acha o instalado pelo id e pelo catálogo (pode haver dois iguais)
      const mid = c.addon.manifest && c.addon.manifest.id;
      let idx = list.findIndex((a) => a.manifest.id === mid && (a.manifest.catalogs || []).some((k) => k.id === c.id && k.type === c.type));
      if (idx < 0) idx = list.findIndex((a) => a.manifest.id === mid);
      const catKey = `CATALOG_${String(c.addon.manifest.id).replace(/[^\w]/g, "_")}_${String(c.id).replace(/[^\w]/g, "_")}`;
      const title = `${tr(catKey, c.name || c.id)} - ${tr(`TYPE_${c.type}`, c.type)}`;
      const content = c.content || {};
      return {
        key: `${idx}|${c.type}|${c.id}`, title,
        items: content.type === "Ready" ? (content.content || []).map(metaItem) : [],
        error: content.type === "Err"
      };
    }).filter((x) => x && (x.items.length || !x.error));
  };

  // "Ver tudo" de uma seção: busca a página do catálogo direto no addon (skip = quantos já vieram)
  S.catalog = async (key, skip) => {
    const [idxS, type, ...rest] = String(key).split("|");
    const id = rest.join("|");
    const a = (await addons())[Number(idxS)];
    if (!a) throw new Error("addon não encontrado");
    const url = `${base(a.transportUrl)}/catalog/${type}/${encodeURIComponent(id)}${skip > 0 ? `/skip=${skip}` : ""}.json`;
    const metas = ((await getJson(url)).metas || []).map(metaItem);
    return { items: metas, more: metas.length > 0 };
  };

  S.search = async (q) => {
    const list = await addons();
    const cm = cinemeta(list);
    if (!cm) throw new Error("Cinemeta não está instalado");
    const enc = encodeURIComponent(q);
    const [mv, sr] = await Promise.all(["movie", "series"].map((t) =>
      getJson(`${base(cm.transportUrl)}/catalog/${t}/top/search=${enc}.json`).then((j) => j.metas || []).catch(() => [])));
    const out = [];
    for (let i = 0; i < Math.max(mv.length, sr.length); i++) {
      for (const m of [mv[i], sr[i]]) if (m) out.push({ type: m.type, id: m.id, name: m.name, poster: m.poster || "", info: [m.type === "movie" ? "Filme" : "Série", m.releaseInfo].filter(Boolean).join(" · ") });
    }
    return out.slice(0, 60);
  };

  // Dados do título com o que o próprio Stremio calcula por episódio (assistido, progresso, lançamento):
  // carrega o modelo meta_details no core. Só quando o PC não está numa tela de detalhes (ela usa esse
  // modelo e mudaria); aí busca direto no addon, sem essas marcas.
  const metaFromCore = async (type, id) => {
    if (location.hash.startsWith("#/detail")) return null;
    core.dispatch({ action: "Load", args: { model: "MetaDetails", args: { metaPath: { resource: "meta", type, id, extra: [] }, streamPath: null, guessStream: false } } }, "meta_details");
    for (let i = 0; i < 60; i++) {
      const md = await core.getState("meta_details");
      const sel = md.selected && md.selected.metaPath;
      const c = md.metaItem && md.metaItem.content;
      if (sel && sel.id === id && c && c.type === "Ready") return c.content;
      if (sel && sel.id === id && c && c.type === "Err") return null;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  const shapeMeta = (m) => ({
    name: m.name, poster: m.poster || "", background: m.background || "", year: m.releaseInfo || m.year || "",
    videos: (m.videos || []).filter((v) => v.season != null).map((v) => ({
      id: v.id, season: Number(v.season) || 0, episode: Number(v.episode ?? v.number) || 0,
      title: v.title || v.name || "", thumbnail: v.thumbnail || "", released: v.released || "",
      watched: !!v.watched, progress: typeof v.progress === "number" ? Math.round(v.progress * 10) / 10 : 0,
      upcoming: !!v.upcoming
    }))
  });

  S.meta = async (type, id) => {
    try {
      const m = await metaFromCore(type, id);
      if (m) return shapeMeta(m);
    } catch (e) {}
    const list = await addons();
    const cands = list.filter((a) => res(a, "meta", type, id));
    cands.sort((a, b) => (b.manifest.id === "com.linvo.cinemeta") - (a.manifest.id === "com.linvo.cinemeta"));
    let err = "nenhum addon de dados para esse título";
    for (const a of cands) {
      try {
        const m = (await getJson(`${base(a.transportUrl)}/meta/${type}/${encodeURIComponent(id)}.json`)).meta;
        if (!m) continue;
        const out = shapeMeta(m);
        const now = Date.now();
        for (const v of out.videos) v.upcoming = !!v.released && new Date(v.released).getTime() > now;
        return out;
      } catch (e) { err = String(e.message || e); }
    }
    throw new Error(err);
  };

  // Addons com fontes para esse vídeo: [{ idx, name }]
  S.streamAddons = async (type, videoId) => {
    const list = await addons();
    return list.map((a, idx) => ({ a, idx })).filter(({ a }) => res(a, "stream", type, videoId)).map(({ a, idx }) => ({ idx, name: a.manifest.name }));
  };

  // Fontes de um addon. Guarda cada uma aqui (S.streams) e devolve só o que o celular mostra
  S.addonStreams = async (idx, type, id, videoId) => {
    const list = await addons();
    const a = list[idx];
    if (!a) return [];
    const j = await getJson(`${base(a.transportUrl)}/stream/${type}/${encodeURIComponent(videoId)}.json`, 25000);
    const metaAddon = cinemeta(list) && /^tt\d/.test(id) ? cinemeta(list) : (list.find((x) => res(x, "meta", type, id)) || cinemeta(list));
    if (S.streams.size > 3000) S.streams.clear();
    return (j.streams || []).slice(0, 150).map((s) => {
      const sid = `s${++S.seq}`;
      S.streams.set(sid, { s, addonUrl: a.transportUrl, metaUrl: metaAddon?.transportUrl || "", type, id, videoId });
      return { sid, name: (s.name || "").replace(/\s*\n\s*/g, " "), title: s.title || s.description || "" };
    });
  };

  // Toca no player do Stremio: #/player/:stream/:streamTransportUrl/:metaTransportUrl/:type/:id/:videoId
  S.play = async (sid) => {
    const x = S.streams.get(sid);
    if (!x) throw new Error("fonte expirada, abra as fontes de novo");
    const enc = await core.encodeStream(x.s);
    location.hash = "#/player/" + [enc, x.addonUrl, x.metaUrl, x.type, x.id, x.videoId].map(encodeURIComponent).join("/");
    return true;
  };

  // Estado do player, lido da tela do Stremio (o vídeo roda no mpv do shell, não há <video> na página)
  const secs = (t) => (t || "").split(":").reduce((acc, n) => acc * 60 + (Number(n) || 0), 0);
  S.player = async () => {
    if (!location.hash.startsWith("#/player")) return null;
    const p = await core.getState("player");
    const bar = document.querySelector('[class*="seek-bar-container"]');
    const [tempo, duracao] = (bar?.innerText || "").split("\n");
    const btn = (t) => !!document.querySelector(`[class*="control-bar-button"][title="${t}"]`);
    const thumb = document.querySelector('[class*="volume-slider"] [class*="thumb"]');
    const pos = thumb ? parseFloat((thumb.style.marginLeft.match(/[\d.]+/) || [])[0]) : NaN;
    const meta = p.metaItem?.content || p.metaItem || {};
    return {
      title: p.title || meta.name || "",
      poster: meta.poster || "",
      time: secs(tempo), duration: secs(duracao),
      paused: btn("Play") ? true : btn("Pause") ? false : null,
      volume: Number.isNaN(pos) ? null : Math.round(pos * 2),
      fs: window.innerWidth >= screen.width && window.innerHeight >= screen.height
    };
  };

  // Ponto (x, y) da página para clicar numa barra (seek ou volume) na fração f
  S.sliderPoint = (which, f) => {
    const el = which === "seek"
      ? document.querySelector('[class*="seek-bar-container"] [class*="slider-container"]')
      : document.querySelector('[class*="volume-slider"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + Math.max(0, Math.min(1, f)) * r.width, y: r.top + r.height / 2 };
  };

  window.__strc = S;
})();
