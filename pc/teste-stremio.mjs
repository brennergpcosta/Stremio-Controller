// Teste de viabilidade: controla o Stremio 5 (stremio-shell-ng) aberto, pela porta CDP do WebView2.
// Node 22+ (WebSocket nativo), sem dependências.
//
//   node pc/teste-stremio.mjs [porta] info      -> lê perfil, addons, Continuar Assistindo, biblioteca e fontes (não muda a tela)
//   node pc/teste-stremio.mjs [porta] play      -> toca a 1ª fonte do 1º item do Continuar Assistindo no player do Stremio
//   node pc/teste-stremio.mjs [porta] estado    -> estado do player (tempo, pausa, volume)
//   node pc/teste-stremio.mjs [porta] pausa | continua | avanca | volume <0-100> | telacheia
//
// Porta padrão 9222 (perfil A). Perfil B = 9223.
// A chave de login (authKey) nunca é mostrada nem salva.

const args = process.argv.slice(2);
const port = /^\d+$/.test(args[0] || '') ? Number(args.shift()) : 9222;
const cmd = args.shift() || 'info';

// ---------- CDP ----------
async function connect() {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    throw new Error(`Porta ${port} não responde. O Stremio está aberto com a porta ligada (pc/porta-ligar.reg)?`);
  }
  const t = list.find(x => x.type === 'page' && x.url.startsWith('https://web.stremio.com'));
  if (!t) throw new Error('Página web.stremio.com não encontrada na porta ' + port);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = () => err(new Error('Falha no WebSocket')); });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq;
    pend.set(id, m => m.error ? err(new Error(m.error.message)) : ok(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  // Roda uma função dentro da página e devolve o resultado (JSON).
  const run = async (fn, ...a) => {
    const r = await send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(a)})`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, run, close: () => ws.close() };
}

// ---------- código que roda na página ----------
// window.core = ponte para o stremio-core (WASM em Web Worker):
//   core.getState(modelo) -> Promise<estado>   modelos: ctx, continue_watching_preview, library, player, meta_details...
//   core.dispatch(acao, modelo)                 (a ponte adiciona location.hash sozinha)
//   core.encodeStream(stream) -> Promise<string> usado na rota do player

const pageInfo = async () => {
  const core = window.core;
  const ctx = await core.getState('ctx');
  const user = ctx.profile.auth?.user;
  const out = {
    acesso: { core: 'window.core', metodos: Object.keys(core), services: Object.keys(window.services || {}) },
    perfil: user ? { email: user.email, nome: user.fullname || user.name || null } : null,
    addons: ctx.profile.addons.map(a => a.manifest.name),
  };
  const cw = await core.getState('continue_watching_preview');
  out.continuarAssistindo = {
    total: cw.items.length,
    primeiros: cw.items.slice(0, 5).map(i => ({
      nome: i.name, tipo: i.type, video: i.state?.videoId || null, progresso: Math.round(i.progress || 0) + '%',
    })),
  };
  // Biblioteca: o modelo "library" só carrega na tela da biblioteca. Carregamos ele no core (a tela não muda).
  let lib = await core.getState('library');
  if (!lib.selected && !location.hash.startsWith('#/library')) {
    core.dispatch({ action: 'Load', args: { model: 'LibraryWithFilters', args: { request: { type: null, sort: 'lastwatched', page: 1 } } } }, 'library');
    await new Promise(r => setTimeout(r, 1500));
    lib = await core.getState('library');
  }
  out.biblioteca = {
    totalNaPagina1: lib.catalog?.length ?? 0,
    primeiros: (lib.catalog || []).slice(0, 5).map(i => ({ nome: i.name, progresso: Math.round(i.progress || 0) + '%' })),
  };
  return out;
};

const pageStreams = async () => {
  const core = window.core;
  const ctx = await core.getState('ctx');
  const cw = await core.getState('continue_watching_preview');
  const item = cw.items.find(i => i.state?.videoId) || cw.items[0];
  const type = item.type;
  const videoId = item.state?.videoId || item._id;
  const hasStream = a => a.manifest.resources.some(r => (r === 'stream' || r.name === 'stream') &&
    (typeof r === 'string' || !r.types || r.types.includes(type))) &&
    (a.manifest.types || []).includes(type) &&
    (!a.manifest.idPrefixes || a.manifest.idPrefixes.some(p => videoId.startsWith(p)));
  const addons = ctx.profile.addons.filter(hasStream);
  const res = await Promise.all(addons.map(async a => {
    const base = a.transportUrl.replace(/\/manifest\.json$/, '');
    try {
      const j = await (await fetch(`${base}/stream/${type}/${encodeURIComponent(videoId)}.json`)).json();
      return { addon: a.manifest.name, transportUrl: a.transportUrl, streams: j.streams || [] };
    } catch (e) {
      return { addon: a.manifest.name, erro: String(e), streams: [] };
    }
  }));
  return { item: { id: item._id, nome: item.name, tipo: type, videoId }, res };
};

// Monta a rota do player e troca location.hash (o Stremio abre o player dele, com o mpv do shell).
// Rota: #/player/:stream/:streamTransportUrl/:metaTransportUrl/:type/:id/:videoId
//   :stream = encodeURIComponent(await core.encodeStream(stream))
const pagePlay = async () => {
  const core = window.core;
  const ctx = await core.getState('ctx');
  const cw = await core.getState('continue_watching_preview');
  const item = cw.items.find(i => i.state?.videoId) || cw.items[0];
  const type = item.type, videoId = item.state?.videoId || item._id;
  const metaAddon = ctx.profile.addons.find(a => a.manifest.id === 'com.linvo.cinemeta');
  for (const a of ctx.profile.addons) {
    if (!a.manifest.resources.some(r => r === 'stream' || r.name === 'stream')) continue;
    if (!(a.manifest.types || []).includes(type)) continue;
    const base = a.transportUrl.replace(/\/manifest\.json$/, '');
    let j;
    try { j = await (await fetch(`${base}/stream/${type}/${encodeURIComponent(videoId)}.json`)).json(); } catch { continue; }
    const s = j.streams?.[0];
    if (!s) continue;
    const enc = await core.encodeStream(s);
    location.hash = '#/player/' + [enc, a.transportUrl, metaAddon.transportUrl, type, item._id, videoId].map(encodeURIComponent).join('/');
    return { tocando: item.name, video: videoId, fonte: (s.name || '').split('\n')[0], addon: a.manifest.name };
  }
  return { erro: 'nenhuma fonte encontrada' };
};

// Estado do player lido da própria tela do Stremio (o vídeo roda no mpv do shell, não existe <video> na página).
const pageState = async () => {
  const p = await window.core.getState('player');
  const bar = document.querySelector('[class*="seek-bar-container"]');
  const [tempo, duracao] = (bar?.innerText || '').split('\n');
  const btn = t => !!document.querySelector(`[class*="control-bar-button"][title="${t}"]`);
  // Volume: posição do "thumb" do slider (vai de 0 a 200%, com o reforço de áudio; 50% do slider = volume 100).
  const thumb = document.querySelector('[class*="volume-slider"] [class*="thumb"]');
  const pos = thumb ? parseFloat((thumb.style.marginLeft.match(/[\d.]+/) || [])[0]) : NaN;
  return {
    rota: location.hash.split('/').slice(0, 2).join('/'),
    titulo: p.title || null,
    tempo, duracao,
    pausado: btn('Play') ? true : btn('Pause') ? false : null,
    volume: Number.isNaN(pos) ? null : Math.round(pos * 2),
    // A tela cheia é da janela do shell; a página só percebe pelo tamanho.
    telaCheia: window.innerWidth >= screen.width && window.innerHeight >= screen.height,
  };
};

// Tecla de atalho do player do Stremio, mandada como teclado de verdade pelo CDP.
const KEYS = {
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  f: { key: 'f', code: 'KeyF', keyCode: 70 },
};
async function key(c, k) {
  const d = KEYS[k];
  const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(d.key.length === 1 ? { text: d.key } : {}) });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- comandos ----------
const c = await connect();
try {
  if (cmd === 'info') {
    const info = await c.run(pageInfo);
    const s = await c.run(pageStreams);
    info.fontes = {
      item: `${s.item.nome} (${s.item.videoId})`,
      porAddon: s.res.map(r => ({
        addon: r.addon, total: r.streams.length, erro: r.erro,
        primeiras: r.streams.slice(0, 3).map(x => (x.name || '') + ' | ' + (x.title || x.description || '').split('\n')[0]),
      })),
    };
    console.log(JSON.stringify(info, null, 2));
  } else if (cmd === 'play') {
    console.log(await c.run(pagePlay));
  } else if (cmd === 'estado') {
    console.log(await c.run(pageState));
  } else if (['pausa', 'continua', 'avanca', 'volta', 'telacheia', 'volume'].includes(cmd)) {
    const antes = await c.run(pageState);
    if (cmd === 'pausa' && antes.pausado === false) await key(c, ' ');
    if (cmd === 'continua' && antes.pausado === true) await key(c, ' ');
    if (cmd === 'avanca') await key(c, 'ArrowRight');
    if (cmd === 'volta') await key(c, 'ArrowLeft');
    if (cmd === 'telacheia') await key(c, 'f');
    if (cmd === 'volume') await key(c, args[0] === 'menos' ? 'ArrowDown' : 'ArrowUp');
    await wait(1500);
    console.log({ antes, depois: await c.run(pageState) });
  } else {
    console.log('comando desconhecido: ' + cmd);
  }
} finally {
  c.close();
}
