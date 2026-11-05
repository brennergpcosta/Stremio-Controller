/**
 * Stremio Controle (página do celular).
 * Conversa direto com o programa do PC (Stremio Controller) por WebRTC. A oferta e a resposta passam
 * por um tópico do ntfy.sh, criptografadas com a chave do QR code (AES-GCM); o tópico sai da própria
 * chave (SHA-256). A chave vem no "#k=" do link e fica guardada neste aparelho.
 * Mesmo protocolo de pareamento do controle da YTPowerFeed.
 */

// ?relay=http://127.0.0.1:porta só para testes no próprio PC (relay local); fora disso, o ntfy.sh
const RELAY = (() => {
  const r = new URLSearchParams(location.search).get("relay") || "";
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(r) ? r : "https://ntfy.sh";
})();
const ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const CHUNK = 3000;
const STORE = "strc-remote-key";
const me = `ph-${Math.random().toString(36).slice(2, 10)}`;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Pareamento
// ---------------------------------------------------------------------------------------------
function readKey() {
  const m = /[#&]k=([\w-]{40,})/.exec(location.hash);
  if (m) {
    try { localStorage.setItem(STORE, m[1]); } catch (err) {}
    history.replaceState(null, "", location.pathname + location.search);
    return m[1];
  }
  try { return localStorage.getItem(STORE) || ""; } catch (err) { return ""; }
}

// ---------------------------------------------------------------------------------------------
// Criptografia e sinalização (a mesma do programa do PC)
// ---------------------------------------------------------------------------------------------
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

async function keys(secret) {
  const raw = b64.dec(secret);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const topic = `strc-${Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { topic, key };
}

async function seal(key, obj) {
  const plain = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("deflate-raw"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64.enc(out);
}

async function unseal(key, text) {
  const bytes = b64.dec(text);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(await pipe(new Uint8Array(plain), new DecompressionStream("deflate-raw"))));
}

async function publish(ctx, obj) {
  const data = await seal(ctx.key, obj);
  const id = Math.random().toString(36).slice(2, 10);
  const n = Math.ceil(data.length / CHUNK);
  for (let p = 0; p < n; p++) {
    const r = await fetch(`${RELAY}/${ctx.topic}?cache=no`, {
      method: "POST",
      body: JSON.stringify({ f: me, i: id, p, n, d: data.slice(p * CHUNK, (p + 1) * CHUNK) })
    });
    // O ntfy.sh grátis aceita 250 mensagens por dia por endereço de internet
    if (r.status === 429) throw Object.assign(new Error("limite do ntfy"), { quota: true });
    if (!r.ok) throw new Error(`ntfy: HTTP ${r.status}`);
  }
}

const parts = new Map();
function reassemble(env) {
  if (env.n === 1) return env.d;
  const slot = parts.get(env.i) || { got: [], at: Date.now() };
  slot.got[env.p] = env.d;
  parts.set(env.i, slot);
  if (slot.got.filter((x) => x !== undefined).length < env.n) return null;
  parts.delete(env.i);
  return slot.got.join("");
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (m && !/^K$/.test(m[1])) return m[1].trim();
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Celular Android";
  return "Celular";
};

// ---------------------------------------------------------------------------------------------
// Conexão (igual ao controle da YTPowerFeed)
// ---------------------------------------------------------------------------------------------
let ctx = null;
let es = null;
let esAlive = 0;
let esReady = null;
let esAt = 0;
let pc = null;
let dc = null;
let waiting = null;
let gen = 0;
let attempt = 0;
let attemptAt = 0;
let retryTimer = 0;
let fails = 0;
let quotaUntil = 0;
let pcUpdated = false;

function setConn(state, text) {
  $("conn").dataset.state = state;
  $("connText").textContent = text;
}

function listenRelay() {
  es?.close();
  const mine = new EventSource(`${RELAY}/${ctx.topic}/sse`);
  es = mine;
  esAlive = 0;
  esAt = Date.now();
  const alive = () => { if (es === mine) esAlive = Date.now(); };
  mine.addEventListener("keepalive", alive);
  mine.onmessage = async (e) => {
    alive();
    try {
      const env = JSON.parse(JSON.parse(e.data).message || "null");
      if (!env || env.f === me || typeof env.d !== "string") return;
      const text = reassemble(env);
      if (!text) return;
      const msg = await unseal(ctx.key, text);
      if (msg.type === "answer" && msg.to === me && waiting) waiting(msg);
    } catch (err) {}
  };
  esReady = new Promise((resolve) => {
    mine.addEventListener("open", () => { alive(); resolve(); });
    setTimeout(resolve, 4000);
  });
  return esReady;
}
const relayFresh = () => !!es && es.readyState !== EventSource.CLOSED &&
  (Date.now() - esAlive < 60000 || (!esAlive && Date.now() - esAt < 4000));

function iceDone(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let quiet = 0;
    const t = setTimeout(() => done(), 2500);
    const done = () => { clearTimeout(t); clearTimeout(quiet); resolve(); };
    peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") done(); });
    peer.addEventListener("icecandidate", (e) => {
      if (!e.candidate) { done(); return; }
      if (/ typ srflx /.test(e.candidate.candidate)) { clearTimeout(quiet); quiet = setTimeout(done, 300); }
    });
  });
}

const PING_MS = 1500;
let lastMsgAt = 0;
let pingTimer = 0;
let hiddenAt = 0;
let lastTick = Date.now();

function dropConnection() {
  const old = dc;
  dc = null;
  try { old?.close(); } catch (err) {}
  try { pc?.close(); } catch (err) {}
  pc = null;
}

function abandonAttempt() {
  if (!attempt) return;
  gen++;
  attempt = 0;
  waiting = null;
  if (dc?.readyState !== "open") dropConnection();
}

function reconnectNow() {
  clearTimeout(pingTimer);
  pingTimer = 0;
  setConn("wait", "Reconectando…");
  abandonAttempt();
  dropConnection();
  fails = 0;
  esAlive = 0;
  connect();
}

function check(force) {
  if (!ctx || document.hidden || attempt && Date.now() - attemptAt < 20000) return;
  if (attempt) abandonAttempt();
  if (dc?.readyState !== "open") { if (force) { fails = 0; connect(); } return; }
  if (pc && ["failed", "closed"].includes(pc.connectionState)) { reconnectNow(); return; }
  if (pingTimer || (!force && Date.now() - lastMsgAt < 3000)) return;
  const sentAt = Date.now();
  try { dc.send(JSON.stringify({ c: "ping" })); } catch (err) {}
  pingTimer = setTimeout(() => {
    pingTimer = 0;
    if (lastMsgAt >= sentAt || document.hidden) return;
    reconnectNow();
  }, PING_MS);
}

function wake(e) {
  if (document.hidden) { hiddenAt = hiddenAt || Date.now(); return; }
  const slept = (hiddenAt && Date.now() - hiddenAt > 2000) || ["online", "resume", "frozen-gap"].includes(e?.type);
  hiddenAt = 0;
  if (slept && ctx) {
    abandonAttempt();
    if (!relayFresh() || esAlive) listenRelay();
  }
  check(true);
}

async function connect() {
  if (attempt && Date.now() - attemptAt < 20000) return;
  if (dc?.readyState === "open") return;
  if (Date.now() < quotaUntil) { showQuota(); return; }
  abandonAttempt();
  const my = ++gen;
  const stale = () => my !== gen;
  attempt = my;
  attemptAt = Date.now();
  clearTimeout(retryTimer);
  setConn("wait", "Procurando o PC…");
  try {
    const ready = relayFresh() ? esReady : listenRelay();
    try { pc?.close(); } catch (err) {}
    const peer = new RTCPeerConnection({ iceServers: ICE });
    const chan = peer.createDataChannel("strc");
    pc = peer;
    dc = chan;
    chan.onopen = () => {
      if (dc !== chan) return;
      fails = 0;
      lastMsgAt = Date.now();
      setConn("on", "Conectado");
      setUpdated(false);
      send({ c: "hello", name: deviceName() });
      loaded.clear();
      showTab(tab);
    };
    chan.onclose = () => { if (dc !== chan) return; dc = null; setConn("off", "Desconectado"); scheduleRetry(true); };
    chan.onmessage = (e) => { lastMsgAt = Date.now(); try { onMessage(JSON.parse(e.data)); } catch (err) {} };
    peer.onconnectionstatechange = () => {
      if (pc !== peer) return;
      if (peer.connectionState === "failed") { dropConnection(); setConn("off", "A conexão caiu"); scheduleRetry(true); }
      else if (peer.connectionState === "disconnected") check(true);
    };
    await peer.setLocalDescription(await peer.createOffer());
    await Promise.all([iceDone(peer), ready]);
    if (stale()) return;
    const oid = Math.random().toString(36).slice(2, 10);
    const answer = new Promise((resolve, reject) => {
      waiting = (m) => { if (m.o === undefined || m.o === oid) resolve(m); };
      setTimeout(() => reject(new Error("sem resposta")), 8000);
    });
    await publish(ctx, { type: "offer", o: oid, sdp: peer.localDescription.sdp, name: deviceName() });
    const msg = await answer;
    if (stale()) return;
    waiting = null;
    await peer.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    setTimeout(() => { if (dc === chan && chan.readyState !== "open") { dropConnection(); scheduleRetry(); } }, 8000);
  } catch (err) {
    if (stale()) return;
    waiting = null;
    if (err?.quota) { await onQuota(); return; }
    fails++;
    esAlive = 0;
    setConn("off", fails > 1 ? (pcUpdated ? "Atualizando o PC…" : "PC não encontrado. O Stremio Controller está aberto no PC?") : "Procurando o PC…");
    scheduleRetry();
  } finally {
    if (attempt === my) attempt = 0;
  }
}

const RETRY_S = [2, 5, 10, 20, 40, 60];
function scheduleRetry(soon) {
  clearTimeout(retryTimer);
  if (document.hidden) return;
  if (!soon && fails >= 10) { setConn("off", "PC não encontrado. Toque aqui para procurar"); return; }
  retryTimer = setTimeout(connect, soon ? 300 : RETRY_S[Math.min(fails, RETRY_S.length) - 1] * 1000 || 2000);
}

async function onQuota() {
  let reset = 0;
  try { reset = ((await (await fetch(`${RELAY}/v1/account`)).json())?.stats?.reset_at || 0) * 1000; } catch (err) {}
  quotaUntil = reset > Date.now() ? reset : Date.now() + 30 * 60000;
  showQuota();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (!document.hidden) { fails = 0; connect(); } }, Math.min(quotaUntil - Date.now() + 5000, 2 ** 31 - 1));
}

function showQuota() {
  const at = new Date(quotaUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  setConn("off", `Limite diário do ntfy.sh atingido. Volta às ${at}`);
}

function send(obj) {
  if (dc?.readyState === "open") { dc.send(JSON.stringify(obj)); check(false); return true; }
  wake();
  return false;
}

$("conn").addEventListener("click", () => { if (dc?.readyState !== "open") wake({ type: "tap" }); });
document.addEventListener("visibilitychange", wake);
document.addEventListener("resume", wake);
window.addEventListener("pageshow", wake);
window.addEventListener("online", wake);
window.addEventListener("focus", wake);
setInterval(() => {
  const gap = Date.now() - lastTick;
  lastTick = Date.now();
  if (gap > 10000) wake({ type: "frozen-gap" });
  else check(false);
}, 3000);

function setUpdated(on) {
  pcUpdated = on;
  $("updNotice").hidden = !on;
}

// ---------------------------------------------------------------------------------------------
// Estado do PC
// ---------------------------------------------------------------------------------------------
let st = { stremio: null, player: null };
let stAt = 0;
let seeking = false;
let volDragging = false;
let volHoldUntil = 0;
let tab = "cw";
const loaded = new Set(); // abas já carregadas nesta conexão
let lastQuery = "";

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const setFill = (input) => input.style.setProperty("--p", `${(input.value - input.min) / (input.max - input.min) * 100}%`);
const safeImg = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");

function onMessage(m) {
  switch (m.t) {
    case "pong": return;
    case "state": {
      const hadStremio = !!st.stremio;
      const oldProfile = st.stremio?.profile;
      st = m;
      stAt = performance.now();
      showVersion(m.ver);
      if (!!m.stremio !== hadStremio || m.stremio?.profile !== oldProfile) { loaded.clear(); if (m.stremio) showTab(tab); }
      render();
      return;
    }
    case "list": onList(m); return;
    case "meta": onMeta(m); return;
    case "streams": onStreams(m); return;
    case "toast": toast(m.text); return;
    case "updated": setUpdated(true); return;
  }
}

function showVersion(ver) {
  if (typeof ver !== "string" || !/^[\d.]{1,20}$/.test(ver)) return;
  const el = $("pcVer");
  el.textContent = `v${ver}`;
  el.hidden = false;
}

function render() {
  const s = st.stremio;
  const connected = dc?.readyState === "open";
  $("profile").textContent = !connected ? "" : s ? `Perfil ${s.profile}${s.email ? ` · ${s.email}` : ""}` : "Stremio fechado";
  $("closedView").hidden = !connected || !!s;
  $("mainView").hidden = !connected || !s;
  $("tabs").hidden = !connected || !s;
  renderPlayer();
}

function renderPlayer() {
  const p = st.player;
  const has = !!p;
  $("ctlTitle").textContent = has ? p.title || "…" : "Nada tocando";
  $("ctlSub").textContent = has ? (p.paused ? "Pausado" : "Tocando no PC") : "Escolha algo em Continuar ou Biblioteca";
  const poster = has ? safeImg(p.poster) : "";
  if ($("ctlPoster").getAttribute("src") !== poster) $("ctlPoster").src = poster;
  $("ambient").style.backgroundImage = poster ? `url("${poster}")` : "";
  $("ambient").classList.toggle("on", !!poster);
  $("btnPlay").classList.toggle("playing", has && !p.paused);
  $("btnFs").classList.toggle("on", has && !!p.fs);
  for (const b of document.querySelectorAll(".ctl .ctl-btn")) b.disabled = !has;
  $("seek").disabled = !has;
  $("vol").disabled = !has;
  if (has && !volDragging && performance.now() > volHoldUntil && typeof p.volume === "number") {
    $("vol").value = p.volume;
    $("volNum").textContent = p.volume;
    setFill($("vol"));
  }
  $("tDur").textContent = has ? fmt(p.duration) : "0:00";
  $("mini").hidden = !has || tab === "ctl";
  if (has) {
    $("miniTitle").textContent = p.title || "";
    $("miniIcon").classList.toggle("paused", !!p.paused);
  }
}

function curTime() {
  const p = st.player;
  if (!p) return 0;
  let t = p.time || 0;
  if (!p.paused) t += (performance.now() - stAt) / 1000;
  return Math.min(t, p.duration || t);
}

function frame() {
  tickTime();
  requestAnimationFrame(frame);
}

function tickTime() {
  const p = st.player;
  if (p && !seeking) {
    const t = curTime();
    $("tCur").textContent = fmt(t);
    const seek = $("seek");
    seek.value = p.duration ? Math.round(t / p.duration * 1000) : 0;
    setFill(seek);
    $("miniTime").textContent = `${p.paused ? "Pausado · " : ""}${fmt(t)} / ${fmt(p.duration)}`;
  } else if (!p) {
    $("tCur").textContent = "0:00";
    $("seek").value = 0;
    setFill($("seek"));
  }
}

// ---------------------------------------------------------------------------------------------
// Abas e listas
// ---------------------------------------------------------------------------------------------
function showTab(name) {
  tab = name;
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const k of ["cw", "lib", "search", "ctl"]) $(`pane-${k}`).hidden = k !== name;
  renderPlayer();
  if (!st.stremio || dc?.readyState !== "open") return;
  if ((name === "cw" || name === "lib") && !loaded.has(name)) {
    loaded.add(name);
    if (!$(`grid-${name}`).children.length) $(`grid-${name}`).replaceChildren(spinner());
    send({ c: "list", which: name });
  }
  if (name === "search" && !lastQuery) setTimeout(() => $("searchInput").focus(), 50);
}
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
$("mini").addEventListener("click", () => showTab("ctl"));

function spinner() {
  const d = document.createElement("div");
  d.className = "spinner";
  return d;
}
function emptyEl(text) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}

function cardEl(it, i) {
  const b = document.createElement("button");
  b.className = "card";
  b.style.animationDelay = `${Math.min(i, 18) * 18}ms`;
  const box = document.createElement("div");
  box.className = "poster";
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = safeImg(it.poster);
  box.append(img);
  if (it.progress > 0) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.min(100, it.progress)}%`;
    bar.append(fill);
    box.append(bar);
  }
  if (it.badge) {
    const s = document.createElement("span");
    s.className = "badge";
    s.textContent = it.badge;
    box.append(s);
  }
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = it.name || "";
  b.append(box, name);
  if (it.info) {
    const info = document.createElement("div");
    info.className = "info";
    info.textContent = it.info;
    b.append(info);
  }
  b.addEventListener("click", () => openDetail(it));
  return b;
}

function onList(m) {
  if (m.which === "search" && m.q !== lastQuery) return;
  const grid = $(`grid-${m.which}`);
  if (!grid) return;
  const items = m.items || [];
  if (m.error && !items.length) { grid.replaceChildren(emptyEl(`Não deu para carregar: ${m.error}`)); return; }
  if (!items.length) {
    grid.replaceChildren(emptyEl(m.which === "search" ? "Nada encontrado" : m.which === "cw" ? "Nada para continuar" : "Biblioteca vazia"));
    return;
  }
  grid.replaceChildren(...items.map(cardEl));
}

$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("searchInput").value.trim();
  if (!q) return;
  lastQuery = q;
  $("searchInput").blur();
  $("grid-search").replaceChildren(spinner());
  send({ c: "search", q });
});

// ---------------------------------------------------------------------------------------------
// Detalhe: temporadas, episódios e fontes
// ---------------------------------------------------------------------------------------------
let detail = null; // { type, id, name, poster, videoId, meta, season }
let streamsFor = ""; // videoId das fontes mostradas

function sheetHead(title, sub, poster) {
  $("sheetTitle").textContent = title || "";
  $("sheetSub").textContent = sub || "";
  $("sheetPoster").src = safeImg(poster);
}

function openDetail(it) {
  detail = { type: it.type, id: it.id, name: it.name, poster: it.poster, videoId: it.videoId || "", meta: null, season: null };
  streamsFor = "";
  sheetHead(it.name, it.type === "movie" ? "Filme" : "Série", it.poster);
  $("sheetBody").replaceChildren(spinner());
  if (!$("sheet").open) $("sheet").showModal();
  if (it.type === "movie") { askStreams(it.id, it.name); return; }
  send({ c: "meta", type: it.type, id: it.id });
}

$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) $("sheet").close(); });
$("sheet").addEventListener("close", () => { detail = null; streamsFor = ""; });

function rowEl({ title, sub, img, hi, seen, onTap }) {
  const b = document.createElement("button");
  b.className = "row" + (hi ? " hi" : "");
  if (img !== undefined) {
    const im = document.createElement("img");
    im.alt = "";
    im.loading = "lazy";
    im.src = safeImg(img);
    b.append(im);
  }
  const txt = document.createElement("span");
  txt.className = "txt";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = title;
  txt.append(t);
  if (sub) {
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = sub;
    txt.append(c);
  }
  if (seen) {
    const s = document.createElement("div");
    s.className = "seen";
    s.textContent = "Assistido";
    txt.append(s);
  }
  b.append(txt);
  b.addEventListener("click", onTap);
  return b;
}

const epLabel = (v) => `T${v.season} E${v.episode}`;

function onMeta(m) {
  if (!detail || m.id !== detail.id) return;
  if (m.error || !m.meta) { $("sheetBody").replaceChildren(emptyEl(`Não deu para carregar: ${m.error || "sem dados"}`)); return; }
  detail.meta = m.meta;
  const videos = m.meta.videos || [];
  sheetHead(m.meta.name || detail.name, [m.meta.year, (() => { const n = new Set(videos.filter((v) => v.season > 0).map((v) => v.season)).size; return n ? `${n} temporada${n > 1 ? "s" : ""}` : ""; })()].filter(Boolean).join(" · "), m.meta.poster || detail.poster);
  const cur = videos.find((v) => v.id === detail.videoId);
  const seasons = [...new Set(videos.map((v) => v.season))].sort((a, b) => (a === 0) - (b === 0) || a - b);
  detail.season = cur ? cur.season : seasons.find((s) => s > 0) ?? seasons[0];
  renderEpisodes();
}

function renderEpisodes() {
  const meta = detail.meta;
  const videos = meta.videos || [];
  const body = [];
  const cur = videos.find((v) => v.id === detail.videoId);
  if (cur) {
    body.push(rowEl({ title: `Continuar: ${epLabel(cur)}`, sub: cur.title || "", img: cur.thumbnail, hi: true, onTap: () => askStreams(cur.id, `${meta.name} ${epLabel(cur)}`) }));
  }
  const seasons = [...new Set(videos.map((v) => v.season))].sort((a, b) => (a === 0) - (b === 0) || a - b);
  if (seasons.length > 1) {
    const bar = document.createElement("div");
    bar.className = "seasons";
    for (const s of seasons) {
      const b = document.createElement("button");
      b.textContent = s === 0 ? "Extras" : `Temporada ${s}`;
      b.classList.toggle("on", s === detail.season);
      b.addEventListener("click", () => { detail.season = s; renderEpisodes(); });
      bar.append(b);
    }
    body.push(bar);
  }
  const eps = videos.filter((v) => v.season === detail.season).sort((a, b) => a.episode - b.episode);
  if (!eps.length) body.push(emptyEl("Sem episódios"));
  for (const v of eps) {
    const date = v.released ? new Date(v.released) : null;
    const future = date && date > new Date();
    body.push(rowEl({
      title: `${v.episode}. ${v.title || `Episódio ${v.episode}`}`,
      sub: future ? `Estreia em ${date.toLocaleDateString("pt-BR")}` : "",
      img: v.thumbnail, hi: v.id === detail.videoId, seen: v.watched,
      onTap: () => askStreams(v.id, `${meta.name} ${epLabel(v)}`)
    }));
  }
  $("sheetBody").replaceChildren(...body);
  $("sheetBody").querySelector(".seasons .on")?.scrollIntoView({ inline: "center", block: "nearest" });
}

let streamGroups = new Map(); // addon → itens
let streamsPending = 0;
function askStreams(videoId, label) {
  streamsFor = videoId;
  streamGroups = new Map();
  streamsPending = 1;
  const body = [];
  if (detail.meta && detail.type !== "movie") {
    const back = rowEl({ title: "‹ Episódios", onTap: () => { streamsFor = ""; renderEpisodes(); } });
    body.push(back);
  }
  const h = document.createElement("div");
  h.className = "group-title";
  h.textContent = label;
  body.push(h, spinner());
  $("sheetBody").replaceChildren(...body);
  send({ c: "streams", type: detail.type, id: detail.id, videoId });
}

function onStreams(m) {
  if (!detail || m.videoId !== streamsFor) return;
  if (m.addon) streamGroups.set(m.key ?? m.addon, { name: m.addon, items: m.items || [] });
  streamsPending = m.pending || 0;
  const body = [...$("sheetBody").children].slice(0, detail.meta && detail.type !== "movie" ? 2 : 1);
  let total = 0;
  const groups = [...streamGroups.entries()].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0)).map((e) => e[1]);
  for (const { name: addon, items } of groups) {
    if (!items.length) continue;
    total += items.length;
    const h = document.createElement("div");
    h.className = "group-title";
    h.textContent = `${addon} · ${items.length}`;
    body.push(h);
    for (const s of items) {
      body.push(rowEl({
        title: s.name || addon,
        sub: s.title || "",
        onTap: () => {
          if (send({ c: "play", sid: s.sid })) { toast("Abrindo no PC…"); $("sheet").close(); showTab("ctl"); }
        }
      }));
    }
  }
  if (streamsPending) body.push(spinner());
  else if (!total) body.push(emptyEl("Nenhuma fonte encontrada nos seus addons"));
  $("sheetBody").replaceChildren(...body);
}

// ---------------------------------------------------------------------------------------------
// Controle
// ---------------------------------------------------------------------------------------------
document.querySelector(".controls").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cmd]");
  if (!b || !st.player) return;
  const cmd = b.dataset.cmd;
  if (cmd === "toggle") {
    send({ c: "toggle" });
    st.player.time = curTime();
    stAt = performance.now();
    st.player.paused = !st.player.paused;
    renderPlayer();
  } else {
    const by = cmd === "fwd" ? 10 : -10;
    send({ c: "skip", by });
    st.player.time = Math.max(0, curTime() + by);
    stAt = performance.now();
  }
});

const seek = $("seek");
seek.addEventListener("input", () => {
  seeking = true;
  setFill(seek);
  if (st.player) $("tCur").textContent = fmt(seek.value / 1000 * st.player.duration);
});
seek.addEventListener("change", () => {
  if (st.player?.duration) {
    const time = seek.value / 1000 * st.player.duration;
    send({ c: "seek", time });
    st.player.time = time;
    stAt = performance.now();
  }
  seeking = false;
});

const vol = $("vol");
let volTimer = 0;
vol.addEventListener("input", () => {
  volDragging = true;
  setFill(vol);
  $("volNum").textContent = vol.value;
  clearTimeout(volTimer);
  volTimer = setTimeout(() => send({ c: "volume", level: Number(vol.value) }), 120);
});
vol.addEventListener("change", () => {
  clearTimeout(volTimer);
  send({ c: "volume", level: Number(vol.value) });
  volDragging = false;
  volHoldUntil = performance.now() + 2500;
});

$("btnFs").addEventListener("click", () => {
  if (!st.player) return;
  send({ c: "fs", on: !st.player.fs });
  st.player.fs = !st.player.fs;
  renderPlayer();
});

$("closedView").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-open]");
  if (b && send({ c: "open", p: b.dataset.open })) toast(`Abrindo o perfil ${b.dataset.open} no PC…`);
});

// ---------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = String(text || "");
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}

async function start() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // Versão nova da página: recarrega sozinha (uma vez)
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded || !hadController) return;
      reloaded = true;
      location.reload();
    });
  }
  const secret = readKey();
  if (!secret) { $("pairView").hidden = false; setConn("off", "Sem pareamento"); return; }
  ctx = await keys(secret);
  setFill(vol);
  showTab("cw");
  render();
  requestAnimationFrame(frame);
  connect();
  // A conexão mudou: mostra ou esconde as telas
  setInterval(() => { render(); tickTime(); }, 1000);
}
start();
