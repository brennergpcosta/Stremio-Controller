// Stremio Remote: página do celular.
// Busca no catálogo do Stremio (Cinemeta), pega as fontes nos addons do usuário (AIOStreams etc.)
// e manda o link escolhido para o PC, criptografado, pelo ntfy.sh. O PC abre no mpv.

const params = new URLSearchParams(location.search);
const RELAY = params.get("relay") || "https://ntfy.sh";
const CINEMETA = params.get("cinemeta") || "https://v3-cinemeta.strem.io";
const CHUNK = 3000;
const me = `cel-${Math.random().toString(36).slice(2, 10)}`;
const $ = (s) => document.querySelector(s);

const store = {
  get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// ---------------------------------------------------------------------------------------------
// Pareamento: a chave vem no link do QR (#k=...) e fica guardada
// ---------------------------------------------------------------------------------------------
const fromHash = new URLSearchParams(location.hash.slice(1)).get("k");
if (fromHash) {
  store.set("secret", fromHash);
  history.replaceState(null, "", location.pathname + location.search);
}
const secret = store.get("secret");

// ---------------------------------------------------------------------------------------------
// Criptografia (igual à do PC)
// ---------------------------------------------------------------------------------------------
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

async function makeKeys(sec) {
  const raw = b64.dec(sec);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const topic = `strm-${Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { topic, key };
}
async function seal(key, obj) {
  const plain = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("deflate-raw"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64.enc(out);
}
async function unseal(key, text) {
  const bytes = b64.dec(text);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(await pipe(new Uint8Array(plain), new DecompressionStream("deflate-raw"))));
}

// ---------------------------------------------------------------------------------------------
// Falar com o PC
// ---------------------------------------------------------------------------------------------
let ctx = null;
let lastReply = 0;

async function send(obj) {
  if (!ctx) { toast("Leia o QR code do PC primeiro"); return; }
  const data = await seal(ctx.key, { ...obj, at: Date.now() });
  const id = Math.random().toString(36).slice(2, 10);
  const n = Math.ceil(data.length / CHUNK);
  for (let p = 0; p < n; p++) {
    const body = JSON.stringify({ f: me, i: id, p, n, d: data.slice(p * CHUNK, (p + 1) * CHUNK) });
    const r = await fetch(`${RELAY}/${ctx.topic}?cache=no`, { method: "POST", body, credentials: "omit" });
    if (!r.ok) { toast(r.status === 429 ? "Muitos comandos seguidos, espere uns segundos" : "Falha ao enviar"); return; }
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

function listen() {
  const es = new EventSource(`${RELAY}/${ctx.topic}/sse`);
  es.onopen = () => setDot();
  es.onerror = () => setDot();
  es.onmessage = async (e) => {
    let ev, env, msg;
    try { ev = JSON.parse(e.data); env = JSON.parse(ev.message); } catch { return; }
    if (!env || env.f === me) return;
    const data = reassemble(env);
    if (!data) return;
    try { msg = await unseal(ctx.key, data); } catch { return; }
    if (msg.to && msg.to !== me) return;
    lastReply = Date.now();
    setDot();
    if (msg.type === "state") showState(msg.state);
    if (msg.type === "error") toast(`PC: ${msg.text}`);
  };
}

function setDot() {
  const ok = Date.now() - lastReply < 10 * 60000;
  $("#dot").classList.toggle("ok", ok);
  $("#dot").title = ok ? "PC respondeu" : "PC ainda não respondeu";
}

// ---------------------------------------------------------------------------------------------
// Catálogo e fontes
// ---------------------------------------------------------------------------------------------
const getJSON = async (url) => {
  const r = await fetch(url, { credentials: "omit" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

function addonBases() {
  return (store.get("addons", "") || "").split(/\s+/).filter(Boolean).map((u) =>
    u.replace(/^stremio:\/\//, "https://").replace(/\/manifest\.json.*$/, "").replace(/\/$/, ""));
}

function card(m) {
  const el = document.createElement("button");
  el.className = "card";
  el.innerHTML = `<img loading="lazy" alt=""><span></span>`;
  el.querySelector("img").src = m.poster || "";
  el.querySelector("span").textContent = `${m.name}${m.releaseInfo ? ` (${m.releaseInfo})` : ""}`;
  el.onclick = () => openDetail(m.type, m.id, m.name);
  return el;
}

async function loadResults(q) {
  const box = $("#results");
  box.innerHTML = `<p class="muted">Carregando...</p>`;
  const extra = q ? `/search=${encodeURIComponent(q)}` : "";
  const lists = await Promise.all(["movie", "series"].map((t) =>
    getJSON(`${CINEMETA}/catalog/${t}/top${extra}.json`).then((d) => d.metas || []).catch(() => [])));
  box.innerHTML = "";
  [["Filmes", lists[0]], ["Séries", lists[1]]].forEach(([label, metas]) => {
    if (!metas.length) return;
    const h = document.createElement("h2"); h.textContent = label; box.append(h);
    const row = document.createElement("div"); row.className = "cards";
    metas.slice(0, 30).forEach((m) => row.append(card(m)));
    box.append(row);
  });
  if (!box.children.length) box.innerHTML = `<p class="muted">Nada encontrado.</p>`;
}

async function openDetail(type, id, name) {
  show("v-detail", name, true);
  const box = $("#detail");
  box.innerHTML = `<p class="muted">Carregando...</p>`;
  if (type === "movie") return loadStreams(type, id, name, box);
  const meta = (await getJSON(`${CINEMETA}/meta/series/${id}.json`).catch(() => ({}))).meta || {};
  const videos = (meta.videos || []).filter((v) => v.season > 0);
  const seasons = [...new Set(videos.map((v) => v.season))].sort((a, b) => a - b);
  box.innerHTML = "";
  const sel = document.createElement("select");
  seasons.forEach((s) => sel.append(new Option(`Temporada ${s}`, s)));
  const list = document.createElement("div");
  const render = () => {
    list.innerHTML = "";
    videos.filter((v) => v.season == sel.value).sort((a, b) => a.episode - b.episode).forEach((v) => {
      const b = document.createElement("button");
      b.className = "item";
      b.textContent = `${v.episode}. ${v.name || v.title || "Episódio"}`;
      b.onclick = () => {
        const label = `${name} T${v.season}E${v.episode}`;
        show("v-detail", label, true);
        loadStreams("series", v.id || `${id}:${v.season}:${v.episode}`, label, box);
      };
      list.append(b);
    });
  };
  sel.onchange = render;
  const last = store.get(`season:${id}`);
  if (last && seasons.includes(last)) sel.value = last;
  sel.addEventListener("change", () => store.set(`season:${id}`, Number(sel.value)));
  render();
  box.append(sel, list);
}

async function loadStreams(type, id, title, box) {
  const bases = addonBases();
  if (!bases.length) { box.innerHTML = `<p class="muted">Cole o link do AIOStreams em Ajustes.</p>`; return; }
  box.innerHTML = `<p class="muted">Buscando fontes...</p>`;
  const all = (await Promise.all(bases.map((b) =>
    getJSON(`${b}/stream/${type}/${encodeURIComponent(id)}.json`).then((d) => d.streams || []).catch(() => [])))).flat();
  const playable = all.filter((s) => /^https?:\/\//.test(s.url || ""));
  box.innerHTML = "";
  if (!playable.length) { box.innerHTML = `<p class="muted">Nenhuma fonte com link direto (${all.length} no total).</p>`; return; }
  playable.forEach((s) => {
    const b = document.createElement("button");
    b.className = "item stream";
    const name = document.createElement("b"); name.textContent = (s.name || "").replace(/\n/g, " ");
    const desc = document.createElement("small"); desc.textContent = s.description || s.title || "";
    b.append(name, desc);
    b.onclick = async () => {
      await send({ type: "play", url: s.url, title });
      toast("Enviado para o PC");
      $("#np-title").textContent = title;
    };
    box.append(b);
  });
}

// ---------------------------------------------------------------------------------------------
// Controle
// ---------------------------------------------------------------------------------------------
const fmt = (t) => {
  if (t == null) return "--:--";
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function showState(s) {
  if (!s?.running) { $("#np-title").textContent = "mpv fechado"; $("#np-time").textContent = ""; return; }
  $("#np-title").textContent = s.idle ? "Nada tocando" : (s.title || "Tocando");
  $("#np-time").textContent = s.idle ? "" :
    `${fmt(s.time)} / ${fmt(s.duration)} · vol ${Math.round(s.volume ?? 0)} · ${s.speed ?? 1}x${s.pause ? " · pausado" : ""}`;
  if (s.duration) { $("#np-seek").max = Math.floor(s.duration); $("#np-seek").value = Math.floor(s.time || 0); }
}

document.querySelectorAll("[data-cmd]").forEach((b) => {
  b.onclick = () => b.dataset.cmd === "state" ? send({ type: "state" }) : send({ type: "cmd", cmd: b.dataset.cmd, value: b.dataset.v });
});
$("#np-seek").onchange = (e) => send({ type: "cmd", cmd: "seekTo", value: e.target.value });
[0.75, 1, 1.25, 1.5, 2].forEach((v) => {
  const b = document.createElement("button");
  b.textContent = `${v}x`;
  b.onclick = () => send({ type: "cmd", cmd: "speed", value: v });
  $("#speeds").append(b);
});

// ---------------------------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------------------------
let current = "v-search";
function show(view, title = "Stremio Remote", back = false) {
  current = view;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== view));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view || (view === "v-detail" && b.dataset.view === "v-search")));
  $("#title").textContent = title;
  $("#back").hidden = !back;
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.view)));
$("#back").onclick = () => show("v-search");

let timer;
$("#q").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => loadResults(e.target.value.trim()), 400); };
$("#search-form").onsubmit = (e) => { e.preventDefault(); loadResults($("#q").value.trim()); $("#q").blur(); };

$("#addons").value = store.get("addons", "");
$("#save-addons").onclick = () => { store.set("addons", $("#addons").value.trim()); toast("Salvo"); };
$("#forget").onclick = () => { localStorage.removeItem("secret"); location.reload(); };

function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2500);
}

// ---------------------------------------------------------------------------------------------
(async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (secret) {
    ctx = await makeKeys(secret);
    $("#pair-status").textContent = "Pareado com o PC.";
    listen();
    send({ type: "hello", name: navigator.userAgent.includes("iPhone") ? "iPhone" : "Celular" });
  } else {
    $("#pair-status").textContent = "Ainda não pareado. No PC, rode o programa e leia o QR code.";
    toast("Leia o QR code do PC para parear");
  }
  if (!addonBases().length && secret) show("v-settings");
  setDot();
  loadResults("");
})();
