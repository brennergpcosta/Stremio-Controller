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

  // Episódios assistidos guardados pelo próprio Stremio no item da biblioteca (state.watched):
  // "id do último vídeo:quantidade:bits comprimidos (zlib, base64)", um bit por vídeo na ordem dos
  // vídeos do título, alinhado pelo último vídeo (como a biblioteca watched-bitfield do Stremio).
  // Serve quando o core não pode calcular (PC numa tela de detalhes) e para completar o do core.
  const libRecord = (id) => {
    for (const k of ["library_recent", "library"]) {
      try {
        const j = JSON.parse(localStorage.getItem(k) || "null");
        const it = j && j.items && j.items[id];
        if (it) return it;
      } catch (e) {}
    }
    return null;
  };
  const watchedIds = async (watched, ids) => {
    const out = new Set();
    if (typeof watched !== "string" || !watched) return out;
    const a = watched.lastIndexOf(":");
    const b = watched.lastIndexOf(":", a - 1);
    if (a < 0 || b < 0) return out;
    const anchor = watched.slice(0, b);
    const anchorLen = Number(watched.slice(b + 1, a));
    const bin = Uint8Array.from(atob(watched.slice(a + 1)), (c) => c.charCodeAt(0));
    const bytes = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    const idx = ids.indexOf(anchor);
    const offset = idx < 0 || !anchorLen ? 0 : anchorLen - 1 - idx;
    ids.forEach((vid, i) => {
      const j = i + offset;
      if (j >= 0 && j < bytes.length * 8 && (bytes[j >> 3] >> (j & 7)) & 1) out.add(vid);
    });
    return out;
  };
  const addLibraryWatched = async (out, id, rawVideos) => {
    const rec = libRecord(id);
    const st = rec && rec.state;
    if (!st) return out;
    try {
      const set = await watchedIds(st.watched, (rawVideos || []).map((v) => v.id));
      for (const v of out.videos) if (set.has(v.id)) v.watched = true;
    } catch (e) {}
    // Episódio em andamento: progresso como no Stremio
    if (st.video_id && st.duration > 0 && st.timeOffset > 0) {
      const v = out.videos.find((x) => x.id === st.video_id);
      if (v && !v.progress) v.progress = Math.round(Math.min(100, (st.timeOffset / st.duration) * 100) * 10) / 10;
    }
    return out;
  };

  S.meta = async (type, id) => {
    try {
      const m = await metaFromCore(type, id);
      if (m) return await addLibraryWatched(shapeMeta(m), id, m.videos);
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
        return await addLibraryWatched(out, id, m.videos);
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
    const fs = window.innerWidth >= screen.width && window.innerHeight >= screen.height;
    const B = controlBar();
    if (B && typeof B.time === "number") {
      return {
        title: p.title || meta.name || "", poster: meta.poster || "",
        time: B.time / 1000, duration: (B.duration || 0) / 1000,
        paused: !!B.paused, volume: B.muted ? 0 : Math.round(B.volume ?? 100), fs
      };
    }
    return {
      title: p.title || meta.name || "",
      poster: meta.poster || "",
      time: secs(tempo), duration: secs(duracao),
      paused: btn("Play") ? true : btn("Pause") ? false : null,
      volume: Number.isNaN(pos) ? null : Math.round(pos * 2),
      fs
    };
  };

  // Barra de controle do player (React): as mesmas funções que os botões dela chamam. Sem eventos de
  // mouse: um clique simulado deixava o "mouse" do Stremio parado em cima dos controles, e aí o
  // cursor e os controles não sumiam mais.
  const controlBar = () => {
    const el = document.querySelector('[class*="control-bar-buttons-container"]');
    if (!el) return null;
    const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    let f = fk && el[fk];
    for (let i = 0; f && i < 40; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && "onSeekRequested" in p && "onVolumeChangeRequested" in p) return p;
    }
    return null;
  };
  // Comandos do player: tocar/pausar, ±segundos, ir para um tempo, volume (0 a 200)
  S.ctl = (what, value) => {
    const B = controlBar();
    if (!B) throw new Error("nada tocando");
    const n = Number(value) || 0;
    const dur = B.duration || 0;
    const clampMs = (ms) => Math.max(0, dur ? Math.min(dur - 1000, ms) : ms);
    switch (what) {
      case "toggle": (B.paused ? B.onPlayRequested : B.onPauseRequested)(); return true;
      case "skip": B.onSeekRequested(clampMs((B.time || 0) + n * 1000)); return true;
      case "seek": B.onSeekRequested(clampMs(n * 1000)); return true;
      case "volume": {
        const v = Math.max(0, Math.min(200, Math.round(n)));
        if (B.muted && v > 0) B.onUnmuteRequested();
        B.onVolumeChangeRequested(v);
        return true;
      }
    }
    throw new Error("comando desconhecido");
  };

  // ---------------------------------------------------------------------------------------------
  // Opções do player (legendas, áudio, velocidade, atraso/tamanho/posição da legenda, escala,
  // próximo episódio): as mesmas funções que os menus do player do Stremio chamam. Acha pelo React
  // da tela do player: o estado do vídeo e os callbacks do componente Player (pelo código deles).
  // ---------------------------------------------------------------------------------------------
  const playerParts = () => {
    const el = document.querySelector('[class*="control-bar-buttons-container"]');
    if (!el) return null;
    const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    let f = fk && el[fk];
    let bar = null;
    for (let i = 0; f && i < 40; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!bar && p && typeof p === "object" && "onSeekRequested" in p) bar = p;
      if (bar && typeof f.type === "function") {
        let h = f.memoizedState, video = null;
        const cbs = [];
        for (let n = 0; h && n < 400; n++, h = h.next) {
          const s = h.memoizedState;
          for (const x of [s, s && s.current]) if (!video && x && typeof x === "object" && !Array.isArray(x) && "selectedSubtitlesTrackId" in x && "audioTracks" in x) video = x;
          if (Array.isArray(s) && typeof s[0] === "function" && Array.isArray(s[1])) cbs.push(s[0]);
        }
        if (video) {
          const find = (re) => cbs.find((fn) => re.test(String(fn)));
          return {
            bar, video,
            audio: find(/audioTracks\.find[\s\S]*setAudioTrack/),
            subEmbedded: find(/source:"embedded"/),
            subExternal: find(/source:"external"/),
            delay: find(/subtitleDelay:e\}/),
            size: find(/subtitleSize:e\}/),
            offset: find(/subtitleOffset:e\}/),
            speed: cbs.find((fn) => /^function\(e\)\{\w+\("playbackSpeed",e\)\}$/.test(String(fn)))
          };
        }
      }
    }
    return null;
  };
  S.tracks = [];
  S.playerOptions = async () => {
    if (!location.hash.startsWith("#/player")) return null;
    const P = playerParts();
    if (!P) return null;
    const v = P.video;
    // Legendas: as do arquivo (embutidas) e as dos addons; o celular só vê índice, idioma e nome
    S.tracks = [
      ...(v.subtitlesTracks || []).map((t) => ({ kind: "embedded", t })),
      ...(v.extraSubtitlesTracks || []).map((t) => ({ kind: "external", t }))
    ];
    const subSel = S.tracks.findIndex((x) => (x.kind === "embedded" ? x.t.id === v.selectedSubtitlesTrackId : x.t.id === v.selectedExtraSubtitlesTrackId));
    const external = subSel >= 0 && S.tracks[subSel].kind === "external";
    return {
      subs: S.tracks.map((x, i) => ({ i, lang: x.t.lang || "", label: x.t.label || "", origin: x.kind === "embedded" ? "" : (x.t.origin || "") })),
      subSel,
      audio: (v.audioTracks || []).map((t, i) => ({ i, lang: t.lang || "", label: t.label || "" })),
      audioSel: (v.audioTracks || []).findIndex((t) => t.id === v.selectedAudioTrackId),
      speed: v.playbackSpeed || 1,
      delay: (external ? v.extraSubtitlesDelay : v.subtitlesDelay) || 0,
      size: v.subtitlesSize || v.extraSubtitlesSize || 100,
      offset: v.subtitlesOffset ?? v.extraSubtitlesOffset ?? 0,
      scale: P.bar.videoScaleLabel || "",
      next: P.bar.nextVideo ? { title: P.bar.nextVideo.title || P.bar.nextVideo.name || "", season: P.bar.nextVideo.season, episode: P.bar.nextVideo.episode } : null,
      can: { audio: !!P.audio, sub: !!(P.subEmbedded && P.subExternal), delay: !!P.delay, size: !!P.size, offset: !!P.offset, speed: !!P.speed }
    };
  };
  S.playerSet = async (what, value) => {
    const P = playerParts();
    if (!P) throw new Error("nada tocando");
    const v = P.video;
    const n = Number(value);
    switch (what) {
      case "sub": {
        if (n < 0) { (P.subEmbedded || P.subExternal)(null); return true; }
        const x = S.tracks[n];
        if (!x) throw new Error("legenda não encontrada");
        (x.kind === "embedded" ? P.subEmbedded : P.subExternal)(x.t);
        return true;
      }
      case "audio": {
        const t = (v.audioTracks || [])[n];
        if (!t) throw new Error("áudio não encontrado");
        P.audio(t.id);
        return true;
      }
      case "speed": P.speed(Math.round(Math.max(0.1, Math.min(4, n)) * 20) / 20); return true;
      case "delay": P.delay(Math.round(n)); return true;
      case "size": P.size(Math.max(25, Math.min(400, Math.round(n)))); return true;
      case "offset": P.offset(Math.max(0, Math.min(100, Math.round(n)))); return true;
      case "scale": P.bar.onVideoScaleChanged(); return true;
      case "next": P.bar.onNextVideoRequested(); return true;
    }
    throw new Error("opção desconhecida");
  };

  // ---------------------------------------------------------------------------------------------
  // Contas: a sessão do Stremio fica no localStorage da página (profile, com a chave de login, e os
  // dados da conta: biblioteca, notificações...). O PC guarda uma cópia criptografada (DPAPI) para
  // trocar de conta. Nada disso vai para o celular.
  // ---------------------------------------------------------------------------------------------
  const DEVICE_KEYS = ["installation_id", "schema_version", "streaming_server_urls"];
  const accountKeys = () => Object.keys(localStorage).filter((k) => !DEVICE_KEYS.includes(k));
  S.session = () => {
    let p = null;
    try { p = JSON.parse(localStorage.getItem("profile") || "null"); } catch (e) {}
    const u = p && p.auth && p.auth.user;
    if (!u || !p.auth.key) return null;
    const data = {};
    for (const k of accountKeys()) data[k] = localStorage.getItem(k);
    return { id: String(u._id || ""), email: u.email || "", avatar: u.avatar || "", data };
  };
  // Troca de conta: põe os dados salvos no lugar dos atuais e recarrega a página do Stremio
  S.restore = (data) => {
    for (const k of accountKeys()) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(data || {})) if (!DEVICE_KEYS.includes(k) && typeof v === "string") localStorage.setItem(k, v);
    setTimeout(() => { location.hash = "#/"; location.reload(); }, 50);
    return true;
  };
  // Adicionar conta: tira a conta atual só deste aparelho (sem sair no servidor, para a sessão salva
  // continuar valendo) e abre a tela de entrar do Stremio
  S.logoutLocal = () => {
    for (const k of accountKeys()) localStorage.removeItem(k);
    setTimeout(() => { location.hash = "#/intro"; location.reload(); }, 50);
    return true;
  };

  // ---------------------------------------------------------------------------------------------
  // Botão do QR code na barra de cima do Stremio: abre o QR de pareamento por cima da tela. Só
  // existe enquanto o programa do PC roda: ele renova o "sinal de vida" a cada poucos segundos; sem
  // sinal por 20 s, o botão some. Volta sozinho quando o Stremio redesenha a barra.
  // ---------------------------------------------------------------------------------------------
  const QR_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="display:block"><path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v2h-3v-2zm-5 0h3v3h-3v-3zm3 3h2v2h-2v-2zm-3 3h3v2h-3v-2zm5 0h3v2h-3v-2zm0-3h3v2h-3v-2z"/></svg>';
  // Estado na window (não no S): uma versão nova do page.js continua de onde a velha parou
  const qrAlive = () => Date.now() - (window.__strcQrAlive || 0) < 20000;
  const removeQr = () => {
    document.querySelectorAll(".strc-qr-btn, #strc-qr-overlay").forEach((e) => e.remove());
  };
  const showQrOverlay = () => {
    const qr = window.__strcQr;
    if (!qr || document.getElementById("strc-qr-overlay")) return;
    const o = document.createElement("div");
    o.id = "strc-qr-overlay";
    o.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.72);cursor:pointer;font-family:inherit";
    const card = document.createElement("div");
    card.style.cssText = "background:#fff;color:#111;border-radius:18px;padding:22px 26px;text-align:center;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.5)";
    const h = document.createElement("div");
    h.style.cssText = "font-size:18px;font-weight:600;margin-bottom:12px";
    h.textContent = qr.title;
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + qr.png;
    img.style.cssText = "width:300px;height:300px;display:block;margin:0 auto;image-rendering:pixelated";
    const p = document.createElement("div");
    p.style.cssText = "font-size:13px;color:#555;margin-top:12px;line-height:1.4";
    p.textContent = qr.text;
    card.append(h, img, p);
    o.append(card);
    const close = () => { o.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    o.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    document.body.append(o);
  };
  const placeQr = () => {
    const qr = window.__strcQr;
    if (!qr || !qrAlive()) { removeQr(); return; }
    const bars = document.querySelectorAll('[class*="horizontal-nav-bar"] [class*="buttons-container"]');
    for (const bc of bars) {
      if (bc.querySelector(".strc-qr-btn")) continue;
      const sib = bc.querySelector('[class*="button-container"]');
      const b = document.createElement("div");
      b.className = (sib ? sib.className + " " : "") + "strc-qr-btn";
      b.tabIndex = -1;
      b.title = qr.title;
      b.style.cssText = "display:flex;align-items:center;justify-content:center;cursor:pointer;color:inherit";
      b.innerHTML = QR_ICON;
      // Mesmo estilo do ícone do botão vizinho (cor e tamanho do tema do Stremio)
      const sibSvg = sib && sib.querySelector("svg");
      if (sibSvg && sibSvg.getAttribute("class")) {
        const svg = b.querySelector("svg");
        svg.setAttribute("class", sibSvg.getAttribute("class"));
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.display = "";
      }
      b.addEventListener("click", (e) => { e.stopPropagation(); showQrOverlay(); });
      bc.insertBefore(b, bc.firstChild);
    }
  };
  S.qrButton = (png, title, text) => {
    window.__strcQrAlive = Date.now();
    const old = window.__strcQr;
    window.__strcQr = { png, title, text };
    if (!old || old.png !== png || old.title !== title) {
      document.getElementById("strc-qr-overlay")?.remove();
      document.querySelectorAll(".strc-qr-btn").forEach((e) => e.remove());
    }
    if (!window.__strcQrWatch) {
      let pending = false;
      window.__strcQrWatch = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; placeQr(); });
      });
      window.__strcQrWatch.observe(document.body, { childList: true, subtree: true });
      setInterval(() => { if (!qrAlive()) removeQr(); }, 5000);
    }
    placeQr();
    return true;
  };

  // Ponto (x, y) da página para clicar numa barra (seek ou volume) na fração f
  window.__strc = S;
})();
