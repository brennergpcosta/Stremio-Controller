/**
 * Stremio Controle (página do celular).
 * Servida pelo próprio programa do PC (Stremio Controller) na rede de casa. Os comandos e o estado
 * vão por um WebSocket direto com o PC, sem nenhum serviço de fora. A chave vem no "#k=" do QR code e
 * fica guardada neste aparelho; o PC confere com um desafio (HMAC-SHA256), então a chave não passa
 * pela rede.
 */

const PAGE_VER = "__VERSION__";
const STORE = "strc-key";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Idioma: o mesmo da interface do Stremio aberto no PC. Os textos que o Stremio tem vêm das
// traduções dele (o PC lê na hora); só os poucos textos deste controle, que o Stremio não tem,
// ficam aqui, em português (Stremio em português) ou inglês (qualquer outro idioma).
// ---------------------------------------------------------------------------------------------
const STREMIO_KEYS = [
  "Board", "Library", "SEARCH", "STREMIO_TV_REMOTE", "BOARD_CONTINUE_WATCHING", "BOARD_CONTINUE_WATCHING_EMPTY",
  "LIBRARY_EMPTY", "SEARCH_NO_RESULTS", "TYPE_movie", "TYPE_series", "WATCHED", "UPCOMING", "SEASON_NUMBER",
  "SEASONS", "EPISODE", "LIBRARY_RESUME", "BACK", "NO_STREAM", "NO_STREAMS_FROM_ADDONS", "ERROR",
  "PLAYER_PLAY", "PLAYER_PAUSE", "BUTTON_SEE_ALL", "ALL_ADDONS", "SUBTITLES", "SUBTITLES_DISABLED", "AUDIO",
  "PLAYER_PLAYBACK_SPEED", "SUBSPICKER_DELAY", "SUBSPICKER_SIZE", "STREAMS", "CATALOG_com_linvo_cinemeta_top",
  "TYPE_movie_PL", "TYPE_series_PL", "OFF", "GAMEPAD_ACTION_FULLSCREEN", "PLAYER_MUTE", "PLAYER_UNMUTE",
  "EXIT_FULLSCREEN", "ENTER_FULLSCREEN", "PLAYER_NEXT_VIDEO", "PLAYER_SCALE_FIT", "PLAYER_SCALE_CROP",
  "PLAYER_SCALE_STRETCH", "PLAYER_SCALE_ORIGINAL", "PLAYER_SUBTITLES_LANGUAGES", "PLAYER_SUBTITLES_VARIANTS",
  "PLAYER_SUBTITLES_SETTINGS", "SETTINGS_ACCOUNT", "LOG_IN", "SEARCH_PLACEHOLDER"
];
const OWN = {
  pt: {
    connecting: "Conectando…", reconnecting: "Reconectando…", connected: "Conectado", disconnected: "Desconectado",
    pcNotFound: "PC não encontrado", pcUpdating: "Atualizando o PC…", qrChanged: "QR code trocado", notPaired: "Sem pareamento",
    stremioClosed: "Stremio fechado", nothingPlaying: "Nada tocando", playingOnPc: "Tocando no PC", paused: "Pausado",
    pickSomething: "Escolha algo para assistir", openingOnPc: "Abrindo no PC…", loadError: "Não deu para carregar",
    noEpisodes: "Sem episódios", extras: "Extras",
    playFailed: "Não deu para tocar: {{error}}", alreadyOpen: "{{name}} já está aberto",
    closeOtherFirst: "Feche {{name}} no PC antes (só um Stremio abre por vez)",
    notConfigured: "Caminho de {{name}} não configurado no PC (config.json)", exeNotFound: "Não achei o {{name}} no PC",
    openFailed: "Não deu para abrir {{name}}", opening: "Abrindo {{name}} no PC…",
    pairTitle: "Parear com o PC",
    pairText: "No PC, clique no ícone do Stremio Controller perto do relógio, escolha \"Mostrar QR code\" e leia o código com a câmera do celular.",
    deniedTitle: "QR code trocado no PC",
    deniedText: "Este celular usa um QR code antigo. No PC, clique no ícone do Stremio Controller perto do relógio, escolha \"Mostrar QR code\" e leia o código de novo.",
    lostTitle: "Não achei o PC.",
    lostText: "Confira se o PC está ligado e o Stremio Controller está aberto (ícone perto do relógio), se o celular está no mesmo Wi-Fi do PC e se o endereço do PC não mudou: se mudou, leia o QR code de novo.",
    closedTitle: "Stremio fechado no PC", closedText: "Abra o Stremio no PC, ou abra daqui:",
    updatedText: "O programa do PC foi atualizado. Ele já está voltando sozinho, espere alguns segundos."
  },
  en: {
    connecting: "Connecting…", reconnecting: "Reconnecting…", connected: "Connected", disconnected: "Disconnected",
    pcNotFound: "PC not found", pcUpdating: "Updating the PC…", qrChanged: "QR code changed", notPaired: "Not paired",
    stremioClosed: "Stremio is closed", nothingPlaying: "Nothing playing", playingOnPc: "Playing on the PC", paused: "Paused",
    pickSomething: "Pick something to watch", openingOnPc: "Opening on the PC…", loadError: "Could not load",
    noEpisodes: "No episodes", extras: "Extras",
    playFailed: "Could not play: {{error}}", alreadyOpen: "{{name}} is already open",
    closeOtherFirst: "Close {{name}} on the PC first (only one Stremio opens at a time)",
    notConfigured: "Path for {{name}} is not set on the PC (config.json)", exeNotFound: "Could not find {{name}} on the PC",
    openFailed: "Could not open {{name}}", opening: "Opening {{name}} on the PC…",
    pairTitle: "Pair with the PC",
    pairText: "On the PC, click the Stremio Controller icon next to the clock, choose \"Mostrar QR code\" and scan the code with the phone camera.",
    deniedTitle: "QR code changed on the PC",
    deniedText: "This phone uses an old QR code. On the PC, click the Stremio Controller icon next to the clock, choose \"Mostrar QR code\" and scan it again.",
    lostTitle: "Can't find the PC.",
    lostText: "Check that the PC is on and Stremio Controller is running (icon next to the clock), that the phone is on the same Wi-Fi as the PC, and that the PC address didn't change: if it did, scan the QR code again.",
    closedTitle: "Stremio is closed on the PC", closedText: "Open Stremio on the PC, or open it from here:",
    updatedText: "The PC program was updated. It is coming back by itself, wait a few seconds."
  }
};
const I18N_STORE = "strc-i18n";
let I18N = (() => { try { return JSON.parse(localStorage.getItem(I18N_STORE)) || null; } catch (err) { return null; } })() ||
  { lang: navigator.language || "en", dict: {} };
const ownTable = () => (/^(pt|por)/i.test(I18N.lang || "") ? OWN.pt : OWN.en);
// Texto: do Stremio (chave dele) ou deste controle (chave própria); {{var}} trocado por vars
function T(key, vars) {
  let s = I18N.dict[key] ?? ownTable()[key] ?? OWN.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{{${k}}}`, v);
  return s;
}
// Idioma válido para datas (o Stremio às vezes usa códigos como "eng")
function loc() {
  try { return new Intl.DateTimeFormat(I18N.lang).resolvedOptions().locale; } catch (err) { return undefined; }
}
const cap = (s) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);
function applyI18n() {
  document.documentElement.lang = (I18N.lang || "en").replace(/^eng$/, "en");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = cap(T(el.dataset.i18n));
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = cap(T(el.dataset.i18nPh));
  $("connText").textContent = T(connKey);
}
function onI18n(data) {
  if (!data || typeof data !== "object") return;
  I18N = { lang: String(data.lang || ""), dict: data.dict && typeof data.dict === "object" ? data.dict : {} };
  try { localStorage.setItem(I18N_STORE, JSON.stringify(I18N)); } catch (err) {}
  applyI18n();
  loaded.clear(); // listas com textos novos
  showTab(tab);
  render();
}

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
// SHA-256 e HMAC em JS puro (em http na rede de casa o navegador não libera o crypto.subtle)
// ---------------------------------------------------------------------------------------------
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
function sha256(bytes) {
  const l = bytes.length;
  const n = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n);
  m.set(bytes);
  m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 4, l * 8);
  dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}
function hmacHex(keyStr, msgStr) {
  const enc = new TextEncoder();
  let key = enc.encode(keyStr);
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64);
  k.set(key);
  const msg = enc.encode(msgStr);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return Array.from(sha256(outer), (b) => b.toString(16).padStart(2, "0")).join("");
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
// Conexão com o PC (WebSocket na rede de casa)
// ---------------------------------------------------------------------------------------------
let secret = "";
let ws = null;
let authed = false;
let retryTimer = 0;
let fails = 0;
let denied = false;
let lastMsgAt = 0;
let pingTimer = 0;

// Estado da conexão (chave de texto, para trocar junto com o idioma)
let connKey = "disconnected";
function setConn(state, key) {
  connKey = key;
  $("conn").dataset.state = state;
  $("connText").textContent = T(key);
}

const connected = () => !!ws && ws.readyState === WebSocket.OPEN && authed;

function connect() {
  if (!secret || denied) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  setConn("wait", fails ? "reconnecting" : "connecting");
  const sock = new WebSocket(`ws://${location.host}/ws`);
  ws = sock;
  authed = false;
  const giveUp = setTimeout(() => { if (ws === sock && !authed) sock.close(); }, 8000);
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    lastMsgAt = Date.now();
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.t === "challenge") {
      sock.send(JSON.stringify({ c: "auth", mac: hmacHex(secret, m.nonce), name: deviceName() }));
      return;
    }
    if (m.t === "denied") { denied = true; showDenied(); return; }
    if (m.t === "ok") {
      clearTimeout(giveUp);
      authed = true;
      fails = 0;
      setConn("on", "connected");
      setUpdated(false);
      send({ c: "i18n", keys: STREMIO_KEYS });
      loaded.clear();
      showTab(tab);
      render();
      return;
    }
    onMessage(m);
  };
  sock.onclose = () => {
    clearTimeout(giveUp);
    if (ws !== sock) return;
    ws = null;
    const was = authed;
    authed = false;
    render();
    if (denied) return;
    fails++;
    setConn("off", pcUpdated ? "pcUpdating" : fails > 3 ? "pcNotFound" : "disconnected");
    $("lostView").hidden = !(fails > 3 && !pcUpdated);
    scheduleRetry(was);
  };
}

// Sem o PC: tenta de novo em 1, 2, 4… até 15 s, enquanto a página estiver à vista
function scheduleRetry(soon) {
  clearTimeout(retryTimer);
  if (document.hidden) return;
  const s = soon ? 0.5 : Math.min(15, 2 ** Math.min(fails - 1, 4));
  retryTimer = setTimeout(connect, s * 1000);
}

// A página ficou parada (celular trancado): confere a conexão com um ping; sem resposta, refaz
function check() {
  if (document.hidden) return;
  if (!connected()) { if (!ws) connect(); return; }
  if (Date.now() - lastMsgAt < 4000 || pingTimer) return;
  const sentAt = Date.now();
  send({ c: "ping" });
  pingTimer = setTimeout(() => {
    pingTimer = 0;
    if (lastMsgAt < sentAt && ws) ws.close();
  }, 2500);
}

function showDenied() {
  setConn("off", "qrChanged");
  $("deniedView").hidden = false;
  $("mainView").hidden = true;
  $("tabs").hidden = true;
  $("closedView").hidden = true;
}

function send(obj) {
  if (connected()) { ws.send(JSON.stringify(obj)); return true; }
  connect();
  return false;
}

$("conn").addEventListener("click", () => { if (!connected()) { fails = 0; connect(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
window.addEventListener("pageshow", check);
window.addEventListener("online", () => { fails = 0; check(); });
window.addEventListener("focus", check);
setInterval(check, 3000);

let pcUpdated = false;
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
let tab = "home";
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
      // O programa do PC foi atualizado: a página também (vem dele), então recarrega
      if (/^\d/.test(PAGE_VER) && m.ver && m.ver !== PAGE_VER) { location.reload(); return; }
      if (!!m.stremio !== hadStremio || m.stremio?.profile !== oldProfile) { loaded.clear(); if (m.stremio) showTab(tab); }
      render();
      return;
    }
    case "list": onList(m); return;
    case "board": onBoard(m); return;
    case "popts": onPopts(m.data); return;
    case "catalog": onCatalog(m); return;
    case "meta": onMeta(m); return;
    case "streams": onStreams(m); return;
    case "toast": toast(m.key ? T(m.key, m.vars) : m.text); return;
    case "i18n": onI18n(m.data); return;
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
  const on = connected();
  $("profile").textContent = !on ? "" : s ? s.email || "Stremio" : T("stremioClosed");
  renderAccounts();
  $("closedView").hidden = !on || !!s || denied;
  $("mainView").hidden = !on || !s || denied;
  $("tabs").hidden = !on || !s || denied;
  if (on) $("lostView").hidden = true;
  renderPlayer();
}

// Stremio fechado: um botão por conta (perfil) que dá para abrir no PC, com o e-mail dela
let accountsKey = "";
function renderAccounts() {
  const list = Array.isArray(st.accounts) ? st.accounts : [];
  const key = JSON.stringify(list);
  if (key === accountsKey) return;
  accountsKey = key;
  $("closedBtns").replaceChildren(...list.map((acc) => {
    const b = document.createElement("button");
    b.className = "btn";
    b.dataset.open = acc.p;
    b.textContent = acc.email || "Stremio";
    return b;
  }));
}

function renderPlayer() {
  const p = st.player;
  const has = !!p;
  $("ctlTitle").textContent = has ? p.title || "…" : T("nothingPlaying");
  $("ctlSub").textContent = has ? T(p.paused ? "paused" : "playingOnPc") : T("pickSomething");
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
  $("popts").hidden = !has || !popts;
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
    $("miniTime").textContent = `${p.paused ? T("paused") + " · " : ""}${fmt(t)} / ${fmt(p.duration)}`;
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
  for (const k of ["home", "all", "lib", "search", "ctl"]) $(`pane-${k}`).hidden = k !== name;
  renderPlayer();
  if (!st.stremio || !connected()) return;
  if (name === "home" && !loaded.has("home")) {
    loaded.add("home");
    if (!$("homeRows").children.length) $("homeRows").replaceChildren(spinner());
    send({ c: "list", which: "cw" });
    send({ c: "board" });
  }
  if (name === "lib" && !loaded.has(name)) {
    loaded.add(name);
    if (!$("grid-lib").children.length) $("grid-lib").replaceChildren(spinner());
    send({ c: "list", which: name });
  }
  if (name === "search" && !lastQuery) setTimeout(() => $("searchInput").focus(), 50);
  if (name === "ctl") send({ c: "popts" });
}
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
$("allBack").addEventListener("click", () => showTab("home"));
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
  if (m.which === "cw") { cwItems = m.items || []; cwLoaded = true; renderHome(); if (allView?.kind === "cw") renderAllCw(); return; }
  if (m.which === "search" && m.q !== lastQuery) return;
  const grid = $(`grid-${m.which}`);
  if (!grid) return;
  const items = m.items || [];
  if (m.error && !items.length) { grid.replaceChildren(emptyEl(`${T("loadError")}: ${m.error}`)); return; }
  if (!items.length) {
    grid.replaceChildren(emptyEl(T(m.which === "search" ? "SEARCH_NO_RESULTS" : m.which === "cw" ? "BOARD_CONTINUE_WATCHING_EMPTY" : "LIBRARY_EMPTY")));
    return;
  }
  grid.replaceChildren(...items.map(cardEl));
}

// ---------------------------------------------------------------------------------------------
// Home como o Board do Stremio: Continuar assistindo e as seções do board, na mesma ordem, em
// carrosséis; "Ver tudo" abre a grade completa (com mais páginas ao rolar)
// ---------------------------------------------------------------------------------------------
let cwItems = [];
let cwLoaded = false;
let boardSections = null; // null: carregando
let allView = null;       // { kind: "cw" } ou { kind: "catalog", key, skip, done, loading }

function rowSection(title, items, onSeeAll, emptyText) {
  const sec = document.createElement("section");
  sec.className = "home-sec";
  const head = document.createElement("div");
  head.className = "home-head";
  const h = document.createElement("h3");
  h.textContent = title;
  head.append(h);
  if (onSeeAll && items.length) {
    const b = document.createElement("button");
    b.className = "see-all";
    b.textContent = cap(T("BUTTON_SEE_ALL")) + " ›";
    b.addEventListener("click", onSeeAll);
    head.append(b);
  }
  const row = document.createElement("div");
  row.className = "carousel";
  if (items.length) row.append(...items.slice(0, 20).map(cardEl));
  else row.append(emptyText ? emptyEl(emptyText) : spinner());
  sec.append(head, row);
  return sec;
}

function renderHome() {
  const rows = [];
  rows.push(rowSection(cap(T("BOARD_CONTINUE_WATCHING")), cwItems, () => openAll({ kind: "cw", title: cap(T("BOARD_CONTINUE_WATCHING")) }),
    cwLoaded ? T("BOARD_CONTINUE_WATCHING_EMPTY") : ""));
  if (boardSections === null) rows.push(spinner());
  else for (const s of boardSections) {
    rows.push(rowSection(s.title, s.items || [], () => openAll({ kind: "catalog", key: s.key, title: s.title, first: s.items || [] }), T("SEARCH_NO_RESULTS")));
  }
  // Guarda a posição de rolagem de cada carrossel
  const old = [...$("homeRows").querySelectorAll(".carousel")].map((c) => c.scrollLeft);
  $("homeRows").replaceChildren(...rows);
  [...$("homeRows").querySelectorAll(".carousel")].forEach((c, i) => { if (old[i]) c.scrollLeft = old[i]; });
}

function onBoard(m) {
  boardSections = Array.isArray(m.sections) ? m.sections : [];
  renderHome();
}

function openAll(v) {
  allView = { ...v, skip: 0, done: false, loading: false };
  $("allTitle").textContent = v.title;
  $("grid-all").replaceChildren();
  showTab("all");
  window.scrollTo({ top: 0 });
  if (v.kind === "cw") { renderAllCw(); return; }
  loadMore();
}

function renderAllCw() {
  $("grid-all").replaceChildren(...(cwItems.length ? cwItems.map(cardEl) : [emptyEl(T("BOARD_CONTINUE_WATCHING_EMPTY"))]));
  $("allMore").replaceChildren();
}

function loadMore() {
  const v = allView;
  if (!v || v.kind !== "catalog" || v.done || v.loading) return;
  v.loading = true;
  $("allMore").replaceChildren(spinner());
  send({ c: "catalog", key: v.key, skip: v.skip });
}

function onCatalog(m) {
  const v = allView;
  if (!v || v.kind !== "catalog" || m.key !== v.key || m.skip !== v.skip) return;
  v.loading = false;
  const items = m.data?.items || [];
  if (m.error && !items.length) { v.done = true; $("allMore").replaceChildren(v.skip ? "" : emptyEl(`${T("loadError")}: ${m.error}`)); return; }
  // Alguns addons devolvem a mesma página de novo: para quando nada novo chega
  const seen = new Set([...$("grid-all").querySelectorAll(".card")].map((c) => c.dataset.id));
  const fresh = items.filter((it) => !seen.has(it.id));
  $("grid-all").append(...fresh.map((it, i) => { const c = cardEl(it, i); c.dataset.id = it.id; return c; }));
  v.skip += items.length;
  if (!fresh.length || !m.data?.more) v.done = true;
  $("allMore").replaceChildren();
  if (!$("grid-all").children.length) $("grid-all").replaceChildren(emptyEl(T("SEARCH_NO_RESULTS")));
}

// Mais páginas ao chegar perto do fim da grade
const moreObs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "600px" });
moreObs.observe($("allMore"));
window.addEventListener("scroll", () => {
  if (tab === "all" && window.innerHeight + window.scrollY > document.body.scrollHeight - 800) loadMore();
}, { passive: true });

// Busca enquanto digita: espera uma pausa curta na digitação; Enter busca na hora
let searchTimer = 0;
function runSearch() {
  clearTimeout(searchTimer);
  const q = $("searchInput").value.trim();
  if (q === lastQuery) return;
  lastQuery = q;
  if (q.length < 2) { $("grid-search").replaceChildren(); return; }
  $("grid-search").replaceChildren(spinner());
  send({ c: "search", q });
}
$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 450);
});
$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("searchInput").blur();
  runSearch();
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
  sheetHead(it.name, T(it.type === "movie" ? "TYPE_movie" : "TYPE_series"), it.poster);
  $("sheetBody").replaceChildren(spinner());
  if (!$("sheet").open) $("sheet").showModal();
  if (it.type === "movie") { askStreams(it.id, it.name); return; }
  send({ c: "meta", type: it.type, id: it.id });
}

$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) $("sheet").close(); });
$("sheet").addEventListener("close", () => { detail = null; streamsFor = ""; });

function rowEl({ title, sub, img, hi, onTap }) {
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
  b.append(txt);
  b.addEventListener("click", onTap);
  return b;
}

// Episódio como no Stremio: miniatura com a barra de progresso, título, data de lançamento e as
// marcas ASSISTIDO (amarela) e EM BREVE (verde), com os textos do próprio Stremio
function epRowEl(v, onTap) {
  const b = document.createElement("button");
  b.className = "row ep" + (v.id === detail.videoId ? " hi" : "");
  const th = document.createElement("span");
  th.className = "ep-thumb";
  const im = document.createElement("img");
  im.alt = "";
  im.loading = "lazy";
  im.src = safeImg(v.thumbnail);
  th.append(im);
  if (v.progress > 0 && !v.upcoming) {
    const bar = document.createElement("span");
    bar.className = "ep-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.min(100, v.progress)}%`;
    bar.append(fill);
    th.append(bar);
  }
  const txt = document.createElement("span");
  txt.className = "txt";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = `${v.episode}. ${v.title || `${T("EPISODE")} ${v.episode}`}`;
  txt.append(t);
  const meta = document.createElement("div");
  meta.className = "ep-meta";
  if (v.released) {
    const d = new Date(v.released);
    if (!isNaN(d)) {
      const s = document.createElement("span");
      s.className = "ep-date";
      s.textContent = d.toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric" });
      meta.append(s);
    }
  }
  if (v.watched) {
    const s = document.createElement("span");
    s.className = "tag watched";
    s.textContent = T("WATCHED");
    meta.append(s);
  }
  if (v.upcoming) {
    const s = document.createElement("span");
    s.className = "tag upcoming";
    s.textContent = T("UPCOMING");
    meta.append(s);
  }
  txt.append(meta);
  b.append(th, txt);
  b.addEventListener("click", onTap);
  return b;
}

const epLabel = (v) => `${v.season}x${v.episode}`; // como no título do player do Stremio

function onMeta(m) {
  if (!detail || m.id !== detail.id) return;
  if (m.error || !m.meta) { $("sheetBody").replaceChildren(emptyEl(`${T("loadError")}${m.error ? ": " + m.error : ""}`)); return; }
  detail.meta = m.meta;
  const videos = m.meta.videos || [];
  sheetHead(m.meta.name || detail.name, [m.meta.year, (() => { const n = new Set(videos.filter((v) => v.season > 0).map((v) => v.season)).size; return n > 1 ? `${n} ${T("SEASONS").toLocaleLowerCase()}` : n ? T("SEASON_NUMBER", { season: [...new Set(videos.filter((v) => v.season > 0).map((v) => v.season))][0] }) : ""; })()].filter(Boolean).join(" · "), m.meta.poster || detail.poster);
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
    body.push(rowEl({ title: `${T("LIBRARY_RESUME")}: ${epLabel(cur)}`, sub: cur.title || "", img: cur.thumbnail, hi: true, onTap: () => askStreams(cur.id, `${meta.name} ${epLabel(cur)}`) }));
  }
  const seasons = [...new Set(videos.map((v) => v.season))].sort((a, b) => (a === 0) - (b === 0) || a - b);
  if (seasons.length > 1) {
    const bar = document.createElement("div");
    bar.className = "seasons";
    for (const s of seasons) {
      const b = document.createElement("button");
      b.textContent = s === 0 ? T("extras") : T("SEASON_NUMBER", { season: s });
      b.classList.toggle("on", s === detail.season);
      b.addEventListener("click", () => { detail.season = s; renderEpisodes(); });
      bar.append(b);
    }
    body.push(bar);
  }
  const eps = videos.filter((v) => v.season === detail.season).sort((a, b) => a.episode - b.episode);
  if (!eps.length) body.push(emptyEl(T("noEpisodes")));
  for (const v of eps) body.push(epRowEl(v, () => askStreams(v.id, `${meta.name} ${epLabel(v)}`)));
  $("sheetBody").replaceChildren(...body);
  $("sheetBody").querySelector(".seasons .on")?.scrollIntoView({ inline: "center", block: "nearest" });
}

let streamGroups = new Map(); // addon → itens
let streamsPending = 0;
let streamHead = [];     // voltar + título, fixos no topo das fontes
let streamFilter = "all"; // addon escolhido no filtro (como o seletor de addons do Stremio)
function askStreams(videoId, label) {
  streamsFor = videoId;
  streamGroups = new Map();
  streamsPending = 1;
  streamFilter = "all";
  streamHead = [];
  if (detail.meta && detail.type !== "movie") {
    streamHead.push(rowEl({ title: "‹ " + cap(T("BACK")), onTap: () => { streamsFor = ""; renderEpisodes(); } }));
  }
  const h = document.createElement("div");
  h.className = "group-title";
  h.textContent = label;
  streamHead.push(h);
  $("sheetBody").replaceChildren(...streamHead, spinner());
  send({ c: "streams", type: detail.type, id: detail.id, videoId });
}

function onStreams(m) {
  if (!detail || m.videoId !== streamsFor) return;
  if (m.addon) streamGroups.set(String(m.key ?? m.addon), { name: m.addon, items: m.items || [] });
  streamsPending = m.pending || 0;
  renderStreams();
}

function renderStreams() {
  const groups = [...streamGroups.entries()].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0)).filter((e) => e[1].items.length);
  const body = [...streamHead];
  const total = groups.reduce((n, e) => n + e[1].items.length, 0);
  if (groups.length > 1) {
    // Filtro por addon: Todos ou um addon
    const sel = document.createElement("select");
    sel.className = "addon-filter";
    const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };
    sel.append(opt("all", `${cap(T("ALL_ADDONS"))} (${total})`), ...groups.map(([k, g]) => opt(k, `${g.name} (${g.items.length})`)));
    if (streamFilter !== "all" && !streamGroups.has(streamFilter)) streamFilter = "all";
    sel.value = streamFilter;
    sel.addEventListener("change", () => { streamFilter = sel.value; renderStreams(); });
    body.push(sel);
  }
  for (const [k, { name: addon, items }] of groups) {
    if (streamFilter !== "all" && k !== streamFilter) continue;
    const h = document.createElement("div");
    h.className = "group-title";
    h.textContent = `${addon} · ${items.length}`;
    body.push(h);
    for (const s of items) {
      body.push(rowEl({
        title: s.name || addon,
        sub: s.title || "",
        onTap: () => {
          if (send({ c: "play", sid: s.sid })) { toast(T("openingOnPc")); $("sheet").close(); showTab("ctl"); }
        }
      }));
    }
  }
  if (streamsPending) body.push(spinner());
  else if (!total) body.push(emptyEl(T("NO_STREAMS_FROM_ADDONS")));
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
  if (b) send({ c: "open", p: b.dataset.open }); // o PC responde com o aviso
});

// ---------------------------------------------------------------------------------------------
// Opções do player (as dos menus do player do Stremio): legendas, áudio, velocidade, atraso,
// tamanho e posição da legenda, escala da imagem e próximo episódio
// ---------------------------------------------------------------------------------------------
let popts = null;
let subLang = null; // idioma aberto na lista de legendas
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// Nome do idioma no idioma do Stremio (os addons usam códigos de 3 letras, como "eng" e "pob")
const LANG3 = { pob: "pt-BR", pb: "pt-BR", por: "pt", eng: "en", spa: "es", spn: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", jpn: "ja", kor: "ko", chi: "zh", zho: "zh", rus: "ru", ara: "ar", dut: "nl", nld: "nl", pol: "pl", tur: "tr", swe: "sv", nor: "no", dan: "da", fin: "fi", gre: "el", ell: "el", heb: "he", hin: "hi", hun: "hu", cze: "cs", ces: "cs", rum: "ro", ron: "ro", ukr: "uk", vie: "vi", tha: "th", ind: "id", may: "ms", msa: "ms", bul: "bg", hrv: "hr", srp: "sr", slv: "sl", slo: "sk", slk: "sk", per: "fa", fas: "fa", cat: "ca", est: "et", lav: "lv", lit: "lt", ice: "is", isl: "is" };
const normLang = (code) => LANG3[String(code || "").toLowerCase()] || String(code || "").toLowerCase();
const langName = (code) => {
  if (!code) return "?";
  const c = LANG3[String(code).toLowerCase()] || code;
  try { return cap(new Intl.DisplayNames([loc() || "en"], { type: "language" }).of(c)); } catch (err) { return code; }
};
const numFmt = (n) => n.toLocaleString(loc());

function onPopts(o) {
  popts = o && typeof o === "object" ? o : null;
  renderPopts();
  if ($("optSheet").open) renderOptSheet();
}

function renderPopts() {
  const o = popts;
  $("popts").hidden = !o || !st.player;
  if (!o) return;
  const sel = o.subs[o.subSel];
  $("subsVal").textContent = sel ? langName(sel.lang) : T("SUBTITLES_DISABLED");
  const au = o.audio[o.audioSel];
  $("audioVal").textContent = au ? langName(au.lang) + (au.label ? " · " + au.label : "") : "";
  $("btnAudio").disabled = !o.can.audio || o.audio.length < 2;
  $("btnSubs").disabled = !o.can.sub;
  $("scaleVal").textContent = o.scale || "";
  $("btnNext").hidden = !o.next;
  if (o.next) $("nextVal").textContent = o.next.season != null ? o.next.season + "x" + o.next.episode : o.next.title || "";
  $("speeds").replaceChildren(...SPEEDS.map((s) => {
    const b = document.createElement("button");
    b.textContent = numFmt(s) + "x";
    b.classList.toggle("on", Math.abs(s - o.speed) < 0.01);
    b.disabled = !o.can.speed;
    b.addEventListener("click", () => pset("speed", s));
    return b;
  }));
}

function pset(what, value) {
  if (popts && what === "speed") { popts.speed = value; renderPopts(); }
  send({ c: "pset", what, value });
}

function openOpt(kind) {
  if (!popts) return;
  $("optSheet").dataset.kind = kind;
  const sel = popts.subs[popts.subSel];
  subLang = kind === "subs" ? (sel ? normLang(sel.lang) : null) : null;
  renderOptSheet();
  if (!$("optSheet").open) $("optSheet").showModal();
}

function optRow(text, sub, on, onTap) {
  const b = rowEl({ title: text, sub, hi: on, onTap });
  b.classList.add("opt-row");
  return b;
}

function stepper(label, value, onMinus, onPlus) {
  const d = document.createElement("div");
  d.className = "stepper";
  const l = document.createElement("span");
  l.className = "stepper-l";
  l.textContent = label;
  const minus = document.createElement("button");
  minus.textContent = "−";
  minus.addEventListener("click", onMinus);
  const v = document.createElement("span");
  v.className = "stepper-v";
  v.textContent = value;
  const plus = document.createElement("button");
  plus.textContent = "+";
  plus.addEventListener("click", onPlus);
  d.append(l, minus, v, plus);
  return d;
}

function renderOptSheet() {
  const o = popts;
  const kind = $("optSheet").dataset.kind;
  if (!o) { $("optSheet").close(); return; }
  const body = [];
  if (kind === "audio") {
    $("optTitle").textContent = cap(T("AUDIO"));
    for (const t of o.audio) body.push(optRow(langName(t.lang), t.label, t.i === o.audioSel, () => pset("audio", t.i)));
  } else {
    $("optTitle").textContent = cap(T("SUBTITLES"));
    // Como no menu do Stremio: idiomas, depois as variantes do idioma escolhido
    const langs = [...new Set(o.subs.map((s) => normLang(s.lang)))];
    const chips = document.createElement("div");
    chips.className = "seasons";
    const chip = (text, on, onTap) => { const b = document.createElement("button"); b.textContent = text; b.classList.toggle("on", on); b.addEventListener("click", onTap); return b; };
    chips.append(chip(T("SUBTITLES_DISABLED"), o.subSel < 0, () => pset("sub", -1)));
    for (const l of langs) chips.append(chip(langName(l), subLang === l, () => { subLang = l; renderOptSheet(); }));
    body.push(chips);
    if (subLang !== null) {
      for (const s of o.subs.filter((x) => normLang(x.lang) === subLang)) body.push(optRow(s.label || langName(s.lang), s.origin, s.i === o.subSel, () => pset("sub", s.i)));
    }
    if (o.subSel >= 0) {
      const set = document.createElement("div");
      set.className = "steppers";
      if (o.can.delay) set.append(stepper(cap(T("SUBSPICKER_DELAY")), numFmt(Math.round(o.delay / 10) / 100) + "s", () => pset("delay", o.delay - 250), () => pset("delay", o.delay + 250)));
      if (o.can.size) set.append(stepper(cap(T("SUBSPICKER_SIZE")), o.size + "%", () => pset("size", o.size - 25), () => pset("size", o.size + 25)));
      if (o.can.offset) set.append(stepper("↕", o.offset + "%", () => pset("offset", o.offset - 1), () => pset("offset", o.offset + 1)));
      body.unshift(set);
    }
  }
  const scroll = $("optBody").scrollTop;
  $("optBody").replaceChildren(...body);
  $("optBody").scrollTop = scroll;
}

$("btnSubs").addEventListener("click", () => openOpt("subs"));
$("btnAudio").addEventListener("click", () => openOpt("audio"));
$("btnScale").addEventListener("click", () => pset("scale", 0));
$("btnNext").addEventListener("click", () => pset("next", 0));
$("optSheet").addEventListener("click", (e) => { if (e.target === $("optSheet")) $("optSheet").close(); });
// Com a aba Controle aberta, as opções acompanham o que muda no PC
setInterval(() => { if (tab === "ctl" && st.player && connected()) send({ c: "popts" }); }, 4000);

// ---------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = String(text || "");
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}

function start() {
  applyI18n();
  secret = readKey();
  if (!secret) { $("pairView").hidden = false; setConn("off", "notPaired"); return; }
  setFill(vol);
  showTab("home");
  render();
  requestAnimationFrame(frame);
  connect();
  setInterval(() => { render(); tickTime(); }, 1000);
}
start();
