(() => {
  'use strict';

  // ---------- Config ----------
  const BPM_MIN = 50, BPM_MAX = 250;
  const RENDERERS = 'ytd-video-renderer, yt-lockup-view-model';
  const MAX_PARALLEL = 3;
  const FETCH_TIMEOUT = 10000;
  const CACHE_KEY = 'ytbpm_cache_v2';
  const SETTINGS_KEY = 'ytbpm_settings_v1';
  const CACHE_LIMIT = 5000;

  // Analyse audio
  const HOP = 512;             // échantillons par trame d'analyse
  const FFT_SIZE = 16384;      // pour la tonalité (résolution ≈ 3 Hz : assez pour distinguer les notes du 808)
  const FIRST_PASS = 20;       // secondes de musique avant la 1re estimation
  const SECOND_PASS = 45;      // 2e estimation, plus précise
  const MIN_CONF = 7.5;        // tempo : en dessous, jugé peu fiable (sans rythme ≈ 3–6, beats ≈ 11+)
  const MIN_CONF_FAST = 6.5;   // idem en lecture ×2 (beats ≈ 7+)
  const KEY_MIN_R = 0.6;       // tonalité : corrélation minimale avec le profil
  const KEY_MIN_GAP = 0.04;    // tonalité : écart minimal avec la 2e tonalité (hors relative)

  const settings = {
    sort: 'asc', min: '', max: '', halfDouble: true, onlyBpm: false,
    key: '', relative: true, scanDesc: true, audio: true, skipIntro: true, open: false
  };
  let cache = {};               // id -> { bpm, bpmSrc, key, keySrc, text, t }
  const videos = new Map();     // id -> { id, el, title, channel, order, bpm, bpmSrc, key, keySrc, status }
  const queued = new Set();
  const queue = [];
  let active = 0;
  let orderCounter = 0;
  let currentQuery = null;
  let ui = null;
  const store = chrome.storage.local;

  // ---------- Tonalités ----------
  // KEY-ESTIMATOR-START
  const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const keyName = (pc, minor) => KEY_NAMES[((pc % 12) + 12) % 12] + (minor ? 'm' : '');

  // Profils de Krumhansl-Kessler : poids de chaque degré dans une tonalité majeure / mineure
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  // Ajoute un spectre (dB, comme AnalyserNode.getFloatFrequencyData) au chromagramme (12 classes de hauteur)
  // bass (optionnel) : même chose mais seulement sous 250 Hz — la note que tient la basse / le 808
  function addChroma(db, sampleRate, fftSize, chroma, bass) {
    const binHz = sampleRate / fftSize;
    const lo = Math.max(2, Math.ceil(40 / binHz)), hi = Math.min(db.length - 2, Math.floor(2500 / binHz));
    let maxDb = -Infinity;
    for (let i = lo; i <= hi; i++) if (db[i] > maxDb) maxDb = db[i];
    if (!isFinite(maxDb) || maxDb < -100) return false;            // silence
    const frame = new Float64Array(12), low = new Float64Array(12);
    for (let i = lo; i <= hi; i++) {
      const b = db[i];
      if (b < maxDb - 50 || b <= db[i - 1] || b < db[i + 1]) continue;   // pics seulement
      const a = db[i - 1], c = db[i + 1], den = a - 2 * b + c;
      const p = den !== 0 ? 0.5 * (a - c) / den : 0;                   // position fine du pic
      const f = (i + p) * binHz;
      const pc = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
      const amp = Math.pow(10, (b - maxDb) / 20);
      if (f >= 55) frame[pc] += amp;
      if (f < 250) low[pc] += amp;
    }
    const norm = (src, dst) => {
      let s = 0;
      for (const x of src) s += x;
      if (s > 0 && dst) for (let k = 0; k < 12; k++) dst[k] += src[k] / s;
      return s > 0;
    };
    norm(low, bass);
    return norm(frame, chroma);
  }

  // Compare le chromagramme aux 24 tonalités ; renvoie { key, r, gap }
  function estimateKey(chroma, bass) {
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const mc = mean(chroma);
    const corr = (prof, tonic) => {
      const mp = mean(prof);
      let num = 0, da = 0, db = 0;
      for (let k = 0; k < 12; k++) {
        const x = chroma[k] - mc, y = prof[(k - tonic + 12) % 12] - mp;
        num += x * y; da += x * x; db += y * y;
      }
      return da && db ? num / Math.sqrt(da * db) : 0;
    };
    const all = [];
    for (let pc = 0; pc < 12; pc++) {
      all.push({ pc, minor: false, r: corr(KK_MAJOR, pc) });
      all.push({ pc, minor: true, r: corr(KK_MINOR, pc) });
    }
    all.sort((a, b) => b.r - a.r);
    let best = all[0];
    const relOf = k => all.find(x => x.minor !== k.minor && x.pc === (k.minor ? (k.pc + 3) % 12 : (k.pc + 9) % 12));
    // Mineure ou relative majeure (Am / C : mêmes notes) ? On regarde la note « d'appui » :
    // celle que tient la basse, et le poids tonique + quinte dans tout le morceau.
    const rel = relOf(best);
    if (rel.r > best.r - 0.25) {
      const bs = bass ? bass.reduce((x, y) => x + y, 0) : 0;
      const home = k => (bs > 0 ? 3 * bass[k.pc] / bs : 0) + (chroma[k.pc] + 0.5 * chroma[(k.pc + 7) % 12]) / (12 * mc);
      const sb = best.r + 0.5 * home(best), sr = rel.r + 0.5 * home(rel);
      if (sr > sb) best = rel;
    }
    const pair = relOf(best);
    const rival = all.find(k => k !== best && k !== pair);
    return { key: keyName(best.pc, best.minor), r: best.r, gap: best.r - rival.r };
  }
  // KEY-ESTIMATOR-END

  function parseKey(k) {
    const m = /^([A-G])(#|b)?(m?)$/.exec(k || '');
    if (!m) return null;
    let pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return { pc: (pc + 12) % 12, minor: m[3] === 'm' };
  }
  function relativeOf(k) {
    const p = parseKey(k);
    if (!p) return null;
    return p.minor ? keyName(p.pc + 3, false) : keyName(p.pc + 9, true);
  }

  // ---------- Lecture du BPM et de la tonalité dans du texte ----------
  // TEXT-EXTRACT-START
  const BPM_PATTERNS = [
    /(?<![\d.,])(\d{2,3}(?:[.,]\d{1,2})?)\s*-?\s*b\.?\s?p\.?\s?m(?:s)?(?![a-z])/gi,     // "140 BPM", "140bpm", "92.5 bpm"
    /\bb\.?p\.?m\.?s?(?![a-z])\s*[^\w\n]{0,4}\s*(\d{2,3}(?:[.,]\d{1,2})?)(?!\d)/gi,       // "BPM: 140", "BPM ➜ 140", "bpm140"
    /\btempo\b\s*[^\w\n]{0,4}\s*(\d{2,3})(?!\d)/gi,                                       // "Tempo: 140"
    /♩\s*=\s*(\d{2,3})(?!\d)/g                                                            // "♩ = 140"
  ];

  function extractBpm(text) {
    if (!text) return null;
    for (const re of BPM_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const v = parseFloat(m[1].replace(',', '.'));
        if (v >= BPM_MIN && v <= BPM_MAX) return Math.round(v);
      }
    }
    return null;
  }

  const NOTE_IDX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  function makeKey(letter, acc, mode) {
    let pc = NOTE_IDX[letter.toLowerCase()];
    const a = (acc || '').toLowerCase();
    if (a === '#' || a === '♯' || a === 'sharp') pc += 1;
    else if (a === 'b' || a === '♭' || a === 'flat') pc -= 1;
    const m = (mode || '').trim();
    const minor = m === 'm' || /^(min|minor|mineur|moll)$/i.test(m);
    return keyName(pc, minor);
  }

  const KEY_PATTERNS = [
    // "Key: F#m", "KEY - A Minor", "key Bbmin", "Key : E"
    { re: /\bkey\b\s*[^\w\n#♯♭]{0,4}\s*([A-Ga-g])\s?(#|♯|♭|b|sharp|flat)?\s?(minor|major|mineur|majeur|moll|min|maj|m)?(?![a-z0-9#♯♭])/gi },
    // "F# Minor", "Bb major", "C min"
    { re: /(?<![\w#])([A-G])\s?(#|♯|♭|b)?\s?([Mm]inor|[Mm]ajor|[Mm]ineur|[Mm]ajeur|[Mm]in|[Mm]aj)(?![a-z])/g },
    // "F#m", "Cm", "Bbm" (et "Am" seulement entre séparateurs, pour éviter "I Am")
    { re: /(?<![\w#])([A-G])(#|♯|♭|b)?m(?![a-zA-Z0-9#])/g, guardA: true }
  ];
  const SEP = '|()[]{}-–—:/,•·';

  function extractKey(text) {
    if (!text) return null;
    for (const { re, guardA } of KEY_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (guardA && m[1] === 'A' && !m[2]) {
          const before = text.slice(0, m.index).trimEnd().slice(-1);
          const after = text.slice(m.index + m[0].length).trimStart().charAt(0);
          if (!(before === '' || SEP.includes(before) || after === '' || SEP.includes(after))) continue;
        }
        return makeKey(m[1], m[2], m[3] || (guardA ? 'm' : ''));
      }
    }
    return null;
  }
  // TEXT-EXTRACT-END

  // ---------- Utilitaires ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c);
    return el;
  }

  async function fetchBody(url, opts = {}, as = 'text') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { credentials: 'include', ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return as === 'json' ? await res.json() : await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function walk(o, fn, depth = 0) {             // parcourt un JSON ; fn renvoie true pour arrêter
    if (!o || typeof o !== 'object' || depth > 80) return false;
    if (fn(o)) return true;
    for (const k in o) if (walk(o[k], fn, depth + 1)) return true;
    return false;
  }

  // ---------- Cache partagé entre onglets ----------
  const rank = src => (src === 'audio' ? 1 : src ? 2 : 0);   // le texte prime sur l'audio
  function mergeEntry(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = { t: Math.max(a.t || 0, b.t || 0), text: !!(a.text || b.text) };
    for (const f of ['bpm', 'key']) {
      const sa = a[f] ? rank(a[f + 'Src']) : 0, sb = b[f] ? rank(b[f + 'Src']) : 0;
      const pick = sb > sa || (sb === sa && sb > 0 && (b.t || 0) >= (a.t || 0)) ? b : a;
      out[f] = pick[f] || null;
      out[f + 'Src'] = pick[f] ? pick[f + 'Src'] : null;
    }
    return out;
  }
  function mergeCache(other) {
    for (const [id, e] of Object.entries(other || {})) cache[id] = mergeEntry(cache[id], e);
  }
  function setCache(id, entry) {
    cache[id] = mergeEntry(cache[id], { ...entry, t: Date.now() });
    saveCache();
  }

  let saveTimer;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { const r = await store.get(CACHE_KEY); mergeCache(r[CACHE_KEY]); } catch {}
      const ids = Object.keys(cache);
      if (ids.length > CACHE_LIMIT) {
        ids.sort((a, b) => cache[a].t - cache[b].t)
          .slice(0, ids.length - CACHE_LIMIT)
          .forEach(id => delete cache[id]);
      }
      store.set({ [CACHE_KEY]: cache });
    }, 800);
  }
  const saveSettings = () => store.set({ [SETTINGS_KEY]: settings });

  function applyEntry(v, e) {
    const m = mergeEntry({ bpm: v.bpm, bpmSrc: v.bpmSrc, key: v.key, keySrc: v.keySrc, t: 0 }, e);
    Object.assign(v, { bpm: m.bpm, bpmSrc: m.bpmSrc, key: m.key, keySrc: m.keySrc });
  }
  function syncVideo(id) {
    const v = videos.get(id);
    if (!v || !cache[id]) return;
    applyEntry(v, cache[id]);
    paintBadge(v); applyFilter(v); scheduleRender();
  }

  // ---------- Sources de texte : page vidéo, boutiques de beats, commentaires de l'auteur ----------
  const STORE_HOSTS = [/(^|\.)beatstars\.com$/i, /^bsta\.rs$/i, /(^|\.)airbit\.com$/i, /(^|\.)traktrain\.com$/i, /^bit\.ly$/i];
  const isStoreUrl = u => { try { return STORE_HOSTS.some(r => r.test(new URL(u).hostname)); } catch { return false; } };

  async function fetchWatch(id) {
    const html = await fetchBody(`/watch?v=${encodeURIComponent(id)}`);
    const grab = re => {
      const m = html.match(re);
      if (!m) return '';
      try { return JSON.parse(`"${m[1]}"`); } catch { return ''; }
    };
    const description = grab(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    let tags = '';
    const k = html.match(/"keywords":\[((?:"(?:[^"\\]|\\.)*",?)*)\]/);
    if (k) { try { tags = JSON.parse(`[${k[1]}]`).join(' | '); } catch {} }
    const links = [...new Set((description.match(/https?:\/\/[^\s"'<>)\]]+/g) || []).map(u => u.replace(/[.,;!]+$/, '')))];

    let commentsToken = null;
    const d = html.match(/ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
    if (d) {
      try {
        walk(JSON.parse(d[1]), o => {
          if (o.sectionIdentifier !== 'comment-item-section' && o.targetId !== 'comments-section') return false;
          walk(o, p => { const t = p.continuationCommand?.token; if (t) { commentsToken = t; return true; } return false; });
          return !!commentsToken;
        });
      } catch {}
    }
    return {
      title: grab(/"videoDetails":\{"videoId":"[^"]*","title":"((?:[^"\\]|\\.)*)"/),
      description, tags,
      storeLinks: links.filter(isStoreUrl),
      clientVersion: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1],
      apiKey: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1],
      commentsToken
    };
  }

  // Page BeatStars / Airbit / Traktrain (via le service worker, qui a la permission d'y accéder)
  async function fetchStoreText(url) {
    const r = await chrome.runtime.sendMessage({ type: 'fetchStore', url });
    if (!r?.ok) throw new Error(r?.error || 'store');
    const html = r.text;
    const parts = [];
    const jb = html.match(/"bpm"\s*:\s*"?(\d{2,3}(?:\.\d+)?)/i);
    if (jb) parts.push(`${jb[1]} BPM`);
    const jk = html.match(/"(?:key|keyName|key_name|musicalKey|musical_key|key_signature)"\s*:\s*"([A-G][^"]{0,14})"/i);
    if (jk) parts.push(`Key: ${jk[1]}`);
    for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) parts.push(m[1]);
    parts.push(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').slice(0, 200000));
    return parts.join('\n');
  }

  // Commentaires écrits par l'auteur de la vidéo (souvent le commentaire épinglé)
  async function fetchCreatorComments(page) {
    const clientVersion = page.clientVersion || '2.20260101.00.00';
    const url = '/youtubei/v1/next?prettyPrint=false' + (page.apiKey ? '&key=' + encodeURIComponent(page.apiKey) : '');
    const data = await fetchBody(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': clientVersion },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } }, continuation: page.commentsToken })
    }, 'json');
    const texts = [];
    walk(data, o => {
      const p = o.commentEntityPayload;
      if (p?.author?.isCreator && p.properties?.content?.content) texts.push(p.properties.content.content);
      const c = o.commentRenderer;
      if (c && (c.authorIsChannelOwner || c.pinnedCommentBadge)) texts.push((c.contentText?.runs || []).map(x => x.text).join(''));
      return false;
    });
    return texts.join('\n');
  }

  // Cherche BPM et tonalité, de la source la plus fiable à la plus lointaine
  async function lookupText(id, known = {}) {
    const out = {
      bpm: known.bpm || null, bpmSrc: known.bpm ? known.bpmSrc : null,
      key: known.key || null, keySrc: known.key ? known.keySrc : null
    };
    const need = () => !out.bpm || !out.key;
    const take = (text, src) => {
      if (!out.bpm) { const b = extractBpm(text); if (b) Object.assign(out, { bpm: b, bpmSrc: src }); }
      if (!out.key) { const k = extractKey(text); if (k) Object.assign(out, { key: k, keySrc: src }); }
    };
    const page = await fetchWatch(id);
    take(page.title, 'titre');
    take(page.description + '\n' + page.tags, 'description');
    for (const url of page.storeLinks.slice(0, 2)) {
      if (!need()) break;
      try { take(await fetchStoreText(url), 'boutique'); } catch {}
    }
    if (need() && page.commentsToken) {
      try { take(await fetchCreatorComments(page), 'commentaire'); } catch {}
    }
    return out;
  }

  // ---------- Lecture des résultats YouTube ----------
  function readRenderer(el) {
    const a = el.querySelector('a[href*="/watch?v="]');
    if (!a) return null;
    let id;
    try { id = new URL(a.href, location.origin).searchParams.get('v'); } catch { return null; }
    if (!id) return null;
    const titleEl = el.querySelector('#video-title') || el.querySelector('h3 a');
    const title = (titleEl?.getAttribute('title') || titleEl?.textContent ||
                   a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
    const channel = (el.querySelector('ytd-channel-name #text, #channel-name #text, [class*="metadata-text"]')?.textContent || '').trim();
    const snippet = el.querySelector('.metadata-snippet-container, #description-text, .metadata-snippet-text')?.textContent || '';
    return { id, title, channel, snippet };
  }

  function processResults() {
    if (location.pathname !== '/results') return;
    const q = new URLSearchParams(location.search).get('search_query') || '';
    if (q !== currentQuery) {
      currentQuery = q;
      videos.clear(); queue.length = 0; queued.clear(); orderCounter = 0;
    }
    let changed = false;

    document.querySelectorAll(RENDERERS).forEach(el => {
      const info = readRenderer(el);
      if (!info) return;

      // YouTube recycle parfois les éléments : on détache l'ancienne vidéo
      const prevId = el.dataset.ytbpmId;
      if (prevId && prevId !== info.id && videos.get(prevId)?.el === el) videos.get(prevId).el = null;

      let v = videos.get(info.id);
      if (!v) {
        changed = true;
        v = { id: info.id, el, title: info.title, channel: info.channel, order: orderCounter++,
              bpm: null, bpmSrc: null, key: null, keySrc: null, status: 'queued', tries: 0 };
        videos.set(info.id, v);
        const tb = extractBpm(info.title), tk = extractKey(info.title);
        if (tb) Object.assign(v, { bpm: tb, bpmSrc: 'titre' });
        if (tk) Object.assign(v, { key: tk, keySrc: 'titre' });
        if (!v.bpm) { const b = extractBpm(info.snippet); if (b) Object.assign(v, { bpm: b, bpmSrc: 'description' }); }
        if (!v.key) { const k = extractKey(info.snippet); if (k) Object.assign(v, { key: k, keySrc: 'description' }); }
        const c = cache[info.id];
        if (c) applyEntry(v, c);
        if ((v.bpm && v.key) || c?.text || !settings.scanDesc) v.status = 'done';
        else enqueue(info.id);
      } else if (v.el !== el) {
        v.el = el; changed = true;
      }
      if (el.dataset.ytbpmId !== info.id) el.dataset.ytbpmId = info.id;
      paintBadge(v);
      applyFilter(v);
    });

    if (changed) scheduleRender();
  }

  // ---------- Badges ----------
  const SRC_LABEL = {
    titre: 'le titre', description: 'la description / les tags', boutique: 'la page BeatStars / Airbit',
    commentaire: "un commentaire de l'auteur", audio: "l'audio (estimé à l'écoute)"
  };
  const srcState = src => (src === 'titre' ? 'title' : src === 'audio' ? 'audio' : 'desc');
  const fmtBpm = (bpm, src) => `${src === 'audio' ? '≈' : ''}${bpm} BPM`;
  const fmtKey = (key, src) => `${src === 'audio' ? '≈' : ''}${key}`;

  function setChip(b, state, text, tip) {
    // n'écrire que si ça change (évite de relancer le MutationObserver en boucle)
    if (b.dataset.state !== state) b.dataset.state = state;
    if (b.textContent !== text) b.textContent = text;
    if (b.title !== tip) b.title = tip;
  }

  function paintBadge(v) {
    const el = v.el;
    if (!el) return;
    let box = el.querySelector('.ytbpm-tags');
    if (!box) {
      box = h('span', { class: 'ytbpm-tags' }, h('span', { class: 'ytbpm-badge' }), h('span', { class: 'ytbpm-key' }));
      (el.querySelector('h3') || el).prepend(box);
    }
    const [bChip, kChip] = box.children;
    const pending = v.status === 'queued' || v.status === 'scan';
    if (v.bpm) setChip(bChip, srcState(v.bpmSrc), fmtBpm(v.bpm, v.bpmSrc), `BPM trouvé dans ${SRC_LABEL[v.bpmSrc] || v.bpmSrc}`);
    else if (pending) setChip(bChip, 'scan', '… BPM', 'Recherche du BPM (description, boutique, commentaires)…');
    else setChip(bChip, 'none', '— BPM', "Aucun BPM écrit — ouvre la vidéo pour l'estimer à l'écoute");

    if (v.key) setChip(kChip, srcState(v.keySrc), fmtKey(v.key, v.keySrc), `Tonalité trouvée dans ${SRC_LABEL[v.keySrc] || v.keySrc}` +
      (v.keySrc === 'audio' ? ` — ou sa relative ${relativeOf(v.key)} (mêmes notes)` : ''));
    else if (pending) setChip(kChip, 'scan', '… key', 'Recherche de la tonalité…');
    else setChip(kChip, 'hidden', '', '');
  }

  // ---------- Filtre ----------
  function matchesRange(bpm) {
    const min = parseFloat(settings.min), max = parseFloat(settings.max);
    const lo = isNaN(min) ? -Infinity : min;
    const hi = isNaN(max) ? Infinity : max;
    const candidates = settings.halfDouble ? [bpm, bpm * 2, bpm / 2] : [bpm];
    return candidates.some(b => b >= lo && b <= hi);
  }
  function matchesKey(key) {
    if (!settings.key) return true;
    if (!key) return false;
    return key === settings.key || (settings.relative && key === relativeOf(settings.key));
  }
  const isVisible = v => (v.bpm ? matchesRange(v.bpm) : !settings.onlyBpm) && matchesKey(v.key);

  function applyFilter(v) {
    if (!v.el) return;
    const target = v.el.closest('ytd-rich-item-renderer') || v.el;
    target.classList.toggle('ytbpm-hidden', !isVisible(v));
  }

  // ---------- File d'analyse (page de recherche) ----------
  function enqueue(id) {
    if (queued.has(id)) return;
    queued.add(id); queue.push(id); pump();
  }
  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const id = queue.shift();
      active++;
      scanVideo(id).finally(() => { active--; setTimeout(pump, 150); });
    }
    scheduleRender();
  }
  async function scanVideo(id) {
    const v = videos.get(id);
    if (!v) return;
    if (!settings.scanDesc) { v.status = 'done'; paintBadge(v); return; }
    v.status = 'scan'; paintBadge(v);
    try {
      const r = await lookupText(id, v);
      setCache(id, { ...r, text: true });
      applyEntry(v, cache[id]);
      v.status = 'done';
    } catch {
      // timeout ou refus de YouTube : on réessaie une fois un peu plus tard
      if (++v.tries < 2) {
        v.status = 'queued'; queued.delete(id);
        setTimeout(() => enqueue(id), 2500);
      } else {
        v.status = 'done';
      }
    }
    paintBadge(v); applyFilter(v); scheduleRender();
  }

  // ---------- Détection à l'écoute (page vidéo) ----------
  // Ce qui n'est écrit nulle part est estimé pendant la lecture, puis mémorisé :
  // le résultat réapparaît ensuite dans toutes tes recherches.
  const SR_FALLBACK = 48000;
  const A = {
    ctx: null, nodes: new WeakMap(), connecting: false, waitingGesture: false,
    vid: null, phase: 'idle', result: null, needBpm: false, needKey: false,
    low: [], full: [], high: [], tempoSecs: 0, rate: 1, lastTime: null,
    chroma: new Float64Array(12), bass: new Float64Array(12), keyFrames: 0, musicSecs: 0, frameNo: 0,
    passes: 0, skipped: false, express: null
  };
  const currentWatchId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const mainVideo = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');

  function resetTempo() { A.low = []; A.full = []; A.high = []; A.tempoSecs = 0; }
  function resetAudio(id) {
    endExpress();
    resetTempo();
    Object.assign(A, {
      vid: id, phase: 'idle', result: null, needBpm: false, needKey: false, lastTime: null,
      chroma: new Float64Array(12), bass: new Float64Array(12), keyFrames: 0, musicSecs: 0, frameNo: 0, passes: 0, skipped: false
    });
  }

  async function startForVideo(id) {
    resetAudio(id);
    A.phase = 'checking';
    if (!cache[id]?.text && settings.scanDesc) {
      try { setCache(id, { ...(await lookupText(id, cache[id] || {})), text: true }); } catch {}
    }
    if (A.vid !== id) return;
    const e = cache[id] || {};
    A.result = { bpm: e.bpm || null, bpmSrc: e.bpmSrc || null, key: e.key || null, keySrc: e.keySrc || null };
    syncVideo(id);
    A.needBpm = !A.result.bpm;
    A.needKey = !A.result.key;
    if (!A.needBpm && !A.needKey) { A.phase = 'done'; return; }
    if (!settings.audio) { A.phase = 'off'; return; }
    A.phase = 'listening';
    ensureAudioGraph();
  }

  function waitForGesture() {
    if (A.waitingGesture) return;
    A.waitingGesture = true;
    const go = () => {
      A.waitingGesture = false;
      removeEventListener('pointerdown', go, true);
      removeEventListener('keydown', go, true);
      if (A.phase === 'blocked') { A.phase = 'listening'; ensureAudioGraph(); }
    };
    addEventListener('pointerdown', go, true);
    addEventListener('keydown', go, true);
  }

  async function ensureAudioGraph() {
    const video = mainVideo();
    if (!video || A.nodes.has(video) || A.connecting) return;
    A.connecting = true;
    try {
      if (!A.ctx) {
        A.ctx = new AudioContext();
        A.ctx.onstatechange = () => { if (A.ctx.state === 'suspended') A.ctx.resume().catch(() => {}); };
      }
      if (A.ctx.state !== 'running') { try { await A.ctx.resume(); } catch {} }
      // Sécurité : sans contexte audio actif, brancher la vidéo la rendrait muette.
      if (A.ctx.state !== 'running') { A.phase = 'blocked'; waitForGesture(); return; }

      const ctx = A.ctx;
      const src = ctx.createMediaElementSource(video);
      src.connect(ctx.destination);                       // le son continue de sortir normalement

      const mono = ctx.createGain();
      mono.channelCount = 1; mono.channelCountMode = 'explicit';
      src.connect(mono);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 150;      // kick / 808
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 6000;    // hi-hats
      const merger = ctx.createChannelMerger(3);
      mono.connect(lp).connect(merger, 0, 0);
      mono.connect(merger, 0, 1);
      mono.connect(hp).connect(merger, 0, 2);
      const proc = ctx.createScriptProcessor(HOP, 3, 1);
      merger.connect(proc);
      const analyser = ctx.createAnalyser();              // spectre pour la tonalité
      analyser.fftSize = FFT_SIZE; analyser.smoothingTimeConstant = 0;
      mono.connect(analyser);
      const silent = ctx.createGain(); silent.gain.value = 0;
      proc.connect(silent);
      analyser.connect(silent);
      silent.connect(ctx.destination);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      proc.onaudioprocess = e => onAudioFrame(e, video, analyser, spectrum);

      A.nodes.set(video, { src, proc, analyser });
    } catch (err) {
      console.warn('[YT BPM] analyse audio indisponible :', err);
      A.phase = 'error';
    } finally {
      A.connecting = false;
    }
  }

  function onAudioFrame(e, video, analyser, spectrum) {
    if (A.phase !== 'listening' || !settings.audio) return;
    if (currentWatchId() !== A.vid) return;
    if (video.paused || video.muted || video.volume === 0) return;
    if (document.getElementById('movie_player')?.classList.contains('ad-showing')) return;  // pas les pubs
    const rate = video.playbackRate;
    if (rate < 0.5 || rate > 2) return;

    // Sauter l'intro (souvent sans batterie) une seule fois, si on est au tout début
    if (settings.skipIntro && !A.skipped) {
      A.skipped = true;
      if (video.currentTime < 5 && video.duration > 90) {
        video.currentTime = Math.min(30, video.duration * 0.15);
        return;
      }
    }
    // Saut dans la vidéo ou changement de vitesse : on recommence la mesure du tempo
    const ct = video.currentTime;
    if (A.lastTime != null && Math.abs(ct - A.lastTime) > 1.5) resetTempo();
    A.lastTime = ct;
    if (rate !== A.rate) { A.rate = rate; resetTempo(); }

    const sr = A.ctx?.sampleRate || SR_FALLBACK;
    const dt = (HOP / sr) * rate;            // durée de musique couverte par cette trame
    A.musicSecs += dt;

    if (A.needBpm) {
      const buf = e.inputBuffer;
      const lo = buf.getChannelData(0), fu = buf.getChannelData(1), hi = buf.getChannelData(2);
      let a = 0, b = 0, c = 0;
      for (let i = 0; i < lo.length; i++) { a += lo[i] * lo[i]; b += fu[i] * fu[i]; c += hi[i] * hi[i]; }
      A.low.push(Math.sqrt(a / lo.length));
      A.full.push(Math.sqrt(b / fu.length));
      A.high.push(Math.sqrt(c / hi.length));
      A.tempoSecs += dt;
    }
    if (A.needKey && (++A.frameNo % 4 === 0)) {
      analyser.getFloatFrequencyData(spectrum);
      if (addChroma(spectrum, sr, FFT_SIZE, A.chroma, A.bass)) A.keyFrames++;
    }

    if ((A.passes === 0 && A.musicSecs >= FIRST_PASS) || (A.passes === 1 && A.musicSecs >= SECOND_PASS)) {
      A.passes++;
      setTimeout(runEstimate, 0);
    }
  }

  function runEstimate() {
    const id = A.vid;
    const final = A.passes >= 2;
    const sr = A.ctx?.sampleRate || SR_FALLBACK;
    const found = {};
    if (A.needBpm && A.tempoSecs >= 12) {
      const r = estimateTempo(Float32Array.from(A.low), Float32Array.from(A.full), Float32Array.from(A.high), sr / HOP / A.rate);
      const minConf = A.rate > 1.5 ? MIN_CONF_FAST : MIN_CONF;   // en ×2 il y a deux fois moins de trames
      if (r && r.conf >= minConf) Object.assign(found, { bpm: r.bpm, bpmSrc: 'audio' });
    }
    if (A.needKey && A.keyFrames >= 50) {
      const k = estimateKey(A.chroma, A.bass);
      if (k.r >= KEY_MIN_R && k.gap >= KEY_MIN_GAP) Object.assign(found, { key: k.key, keySrc: 'audio' });
    }
    if (found.bpm || found.key) {
      A.result = mergeEntry({ ...A.result, t: 0 }, { ...found, t: Date.now() });
      setCache(id, found);       // la 2e passe remplace la 1re (même source, plus récente)
      syncVideo(id);
    }
    if (final) { A.phase = 'done'; endExpress(); }
  }

  // Analyse express : ×2 le temps de l'analyse, puis retour à la vitesse d'avant
  function startExpress() {
    const video = mainVideo();
    if (!video || A.express || A.phase !== 'listening') return;
    A.express = { prevRate: video.playbackRate };
    A.skipped = false;                       // permet aussi de sauter l'intro maintenant
    if (video.paused) video.play().catch(() => {});
    video.playbackRate = 2;
  }
  function endExpress() {
    if (!A.express) return;
    const video = mainVideo();
    if (video && video.playbackRate === 2) video.playbackRate = A.express.prevRate;
    A.express = null;
  }

  function renderWatchChip() {
    const host = document.querySelector('ytd-watch-metadata #title h1');
    if (!host) return;
    let box = document.getElementById('ytbpm-watch');
    if (!box) {
      box = h('span', { id: 'ytbpm-watch', class: 'ytbpm-tags' },
        h('span', { class: 'ytbpm-badge' }), h('span', { class: 'ytbpm-key' }),
        h('button', { class: 'ytbpm-express', title: "Accélère la vidéo en ×2 le temps de l'analyse (≈10 s)",
          onclick: ev => { ev.preventDefault(); ev.stopPropagation(); startExpress(); } }, '⚡ ×2'));
    }
    if (box.parentElement !== host) host.prepend(box);
    const [bChip, kChip, btn] = box.children;

    const r = A.result || {};
    const listening = A.phase === 'listening';
    const secs = Math.min(Math.floor(A.musicSecs), FIRST_PASS);
    const refining = listening && A.passes >= 1 ? ' …' : '';

    if (r.bpm) setChip(bChip, srcState(r.bpmSrc), fmtBpm(r.bpm, r.bpmSrc) + (r.bpmSrc === 'audio' ? refining : ''),
      `BPM trouvé dans ${SRC_LABEL[r.bpmSrc] || r.bpmSrc}`);
    else if (A.phase === 'checking') setChip(bChip, 'scan', '… BPM', 'Recherche dans la description, la boutique et les commentaires');
    else if (listening && A.needBpm) setChip(bChip, 'scan', `🎧 ${secs}/${FIRST_PASS} s`, "Analyse à l'écoute (son activé)");
    else if (A.phase === 'blocked') setChip(bChip, 'none', '🎧 clique sur la page', "Chrome demande un clic avant de pouvoir analyser l'audio");
    else setChip(bChip, 'none', '— BPM', settings.audio ? 'Tempo non détecté' : 'Aucun BPM écrit (analyse audio désactivée)');

    if (r.key) setChip(kChip, srcState(r.keySrc), fmtKey(r.key, r.keySrc) + (r.keySrc === 'audio' ? refining : ''),
      `Tonalité trouvée dans ${SRC_LABEL[r.keySrc] || r.keySrc}` + (r.keySrc === 'audio' ? ` — ou sa relative ${relativeOf(r.key)} (mêmes notes)` : ''));
    else if (A.phase === 'checking') setChip(kChip, 'scan', '… key', '');
    else if (listening && A.needKey) setChip(kChip, 'scan', '🎧 key', "Tonalité : analyse à l'écoute");
    else setChip(kChip, 'hidden', '', '');

    const showBtn = listening && !A.express && A.passes < 2;
    if (btn.hidden === showBtn) btn.hidden = !showBtn;
  }

  function watchTick() {
    const id = currentWatchId();
    if (!id) {
      document.getElementById('ytbpm-watch')?.remove();
      if (A.vid) resetAudio(null);
      return;
    }
    if (id !== A.vid) startForVideo(id);
    else if (A.phase === 'listening') ensureAudioGraph();   // YouTube peut changer d'élément <video>
    renderWatchChip();
  }

  // ---------- Estimation du tempo depuis l'audio ----------
  // BPM-ESTIMATOR-START
  // low / full / high : énergie (RMS) par trame dans 3 bandes — basse (kick/808), complète, aiguë (hi-hats).
  // fps = trames par seconde de musique. Renvoie { bpm, conf } — conf = netteté du pic (bas = aucun rythme clair).
  function estimateTempo(low, full, high, fps) {
    const n = Math.min(low.length, full.length, high ? high.length : Infinity);
    if (n < fps * 8) return null;
    const win = Math.max(1, Math.round(fps * 0.4));

    // 1) flux d'énergie : hausses du log-volume = attaques ; on retire la moyenne locale
    const onsetOf = arr => {
      const o = new Float32Array(n);
      let prev = Math.log1p(1000 * arr[0]);
      for (let i = 1; i < n; i++) { const v = Math.log1p(1000 * arr[i]); o[i] = Math.max(0, v - prev); prev = v; }
      const pre = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + o[i];
      const out = new Float32Array(n);
      let tot = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - win), b = Math.min(n, i + win + 1);
        out[i] = Math.max(0, o[i] - (pre[b] - pre[a]) / (b - a));
        tot += out[i];
      }
      if (tot > 0) for (let i = 0; i < n; i++) out[i] *= n / tot;   // moyenne 1
      return out;
    };
    const mix = parts => {
      const o = new Float32Array(n);
      for (const [arr, w] of parts) for (let i = 0; i < n; i++) o[i] += w * arr[i];
      return o;
    };
    const oLow = onsetOf(low), oFull = onsetOf(full), oHigh = high ? onsetOf(high) : oFull;
    const onset = mix([[oLow, 1], [oFull, 0.6]]);       // pour trouver la pulsation
    const groove = mix([[oLow, 1], [oHigh, 1]]);        // kick + hats, pour juger les subdivisions

    // 2) autocorrélation : à quel intervalle les attaques se répètent
    const maxLag = Math.min(n - 2, Math.ceil(fps * 8) + 2);   // 2 mesures à 60 BPM
    const autocorr = o => {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += o[i];
      mean /= n;
      const ac = new Float32Array(maxLag + 2);
      for (let L = 1; L <= maxLag + 1; L++) {
        let s = 0;
        for (let i = 0; i + L < n; i++) s += o[i] * o[i + L];
        ac[L] = Math.max(0, s / (n - L) - mean * mean);        // moins la corrélation « au hasard »
      }
      return x => {
        const i = Math.floor(x), f = x - i;
        return i >= 1 && i + 1 < ac.length ? ac[i] * (1 - f) + ac[i + 1] * f : 0;
      };
    };
    const at = autocorr(onset), atG = autocorr(groove);

    // 3) peigne : un vrai tempo se répète à 1, 2, 3… temps, et surtout à la mesure (4 et 8 temps)
    const W = [0, 1, 0.5, 0.33, 0.8, 0.2, 0.17, 0.14, 0.6];
    const score = bpm => {
      const L = 60 * fps / bpm;
      let sc = 0;
      for (let k = 1; k <= 8; k++) sc += W[k] * at(k * L);
      return sc;
    };
    let best = 0, bestScore = -1, sum = 0, cnt = 0;
    for (let bpm = 55; bpm <= 210; bpm += 0.25) {
      const sc = score(bpm);
      sum += sc; cnt++;
      if (sc > bestScore) { bestScore = sc; best = bpm; }
    }
    if (!best || sum <= 0) return null;

    // 4) demi ou double tempo ? On garde l'octave où la subdivision la plus fine
    //    du groove tombe en croches ou doubles-croches — comme les beatmakers comptent.
    const refine = c => {
      let b = c, bs = score(c);
      for (let d = -2; d <= 2; d += 0.25) { const v = score(c + d); if (v > bs) { bs = v; b = c + d; } }
      return [b, bs];
    };
    const finest = bpm => {
      const L = 60 * fps / bpm, beat = Math.max(atG(L), 1e-12);
      let m = 1;
      for (const k of [2, 4, 8]) if (L / k >= 2 && atG(L / k) >= 0.3 * beat) m = k;
      return m;
    };
    const cands = [best / 2, best, best * 2].filter(b => b >= 55 && b <= 210).map(refine);
    const ok = cands.filter(([b]) => { const m = finest(b); return m === 2 || m === 4; });
    // parmi les octaves plausibles : la plus proche de ~110 BPM, sauf si son pic est bien plus faible
    const pool = ok.length ? ok : cands;
    const top = Math.max(...pool.map(c => c[1]));
    const [bpm, sc] = pool.filter(c => c[1] >= 0.5 * top)
      .reduce((a, c) => (Math.abs(Math.log2(c[0] / 110)) < Math.abs(Math.log2(a[0] / 110)) ? c : a));
    return { bpm: Math.round(bpm), conf: sc / (sum / cnt) };
  }
  // BPM-ESTIMATOR-END

  // ---------- Panneau ----------
  function onFilterChange() { saveSettings(); videos.forEach(applyFilter); scheduleRender(); }
  function onScanToggle() {
    saveSettings();
    videos.forEach(v => {
      if (settings.scanDesc && v.status === 'done' && !cache[v.id]?.text && (!v.bpm || !v.key)) { v.status = 'queued'; enqueue(v.id); }
    });
  }
  function onAudioToggle() {
    saveSettings();
    if (!settings.audio && A.phase === 'listening') { A.phase = 'off'; endExpress(); }
    if (settings.audio && A.phase === 'off') A.vid = null;    // relance au prochain tick
  }
  function setOpen(open) {
    settings.open = open;
    ui.panel.classList.toggle('open', open);
    saveSettings();
    if (open) scheduleRender();
  }
  function loadMore() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  function buildUI() {
    const checkbox = (key, label, after) => h('label', { class: 'ytbpm-check' },
      h('input', { type: 'checkbox', checked: settings[key], onchange: e => { settings[key] = e.target.checked; after(); } }),
      h('span', {}, label));

    const sortSel = h('select', { onchange: e => { settings.sort = e.target.value; saveSettings(); scheduleRender(); } },
      h('option', { value: 'asc' }, 'BPM croissant'),
      h('option', { value: 'desc' }, 'BPM décroissant'),
      h('option', { value: 'yt' }, 'Ordre YouTube'));
    sortSel.value = settings.sort;

    const keySel = h('select', { onchange: e => { settings.key = e.target.value; onFilterChange(); } },
      h('option', { value: '' }, 'Toutes les tonalités'),
      h('optgroup', { label: 'Mineures' }, ...KEY_NAMES.map((_, i) => h('option', { value: keyName(i, true) }, keyName(i, true)))),
      h('optgroup', { label: 'Majeures' }, ...KEY_NAMES.map((_, i) => h('option', { value: keyName(i, false) }, keyName(i, false)))));
    keySel.value = settings.key;

    const numInput = (key, ph) => h('input', {
      type: 'number', min: BPM_MIN, max: BPM_MAX, placeholder: ph, value: settings[key],
      oninput: e => { settings[key] = e.target.value; onFilterChange(); }
    });

    const toggle = h('button', { id: 'ytbpm-toggle', title: 'Trier / filtrer par BPM et tonalité', onclick: () => setOpen(!settings.open) }, 'BPM');
    const stats = h('div', { class: 'ytbpm-stats' });
    const list = h('div', { class: 'ytbpm-list' });

    const panel = h('aside', { id: 'ytbpm-panel' },
      h('div', { class: 'ytbpm-head' },
        h('strong', {}, 'BPM & tonalité'),
        h('button', { class: 'ytbpm-close', title: 'Fermer', onclick: () => setOpen(false) }, '×')),
      h('div', { class: 'ytbpm-controls' },
        h('div', { class: 'ytbpm-row' }, sortSel),
        h('div', { class: 'ytbpm-row' }, numInput('min', 'min'), h('span', {}, '–'), numInput('max', 'max'), h('span', { class: 'ytbpm-unit' }, 'BPM')),
        checkbox('halfDouble', 'Inclure demi/double tempo (70 ↔ 140)', onFilterChange),
        h('div', { class: 'ytbpm-row' }, keySel),
        checkbox('relative', 'Inclure la relative (Am ↔ C)', onFilterChange),
        checkbox('onlyBpm', 'Masquer les vidéos sans BPM', onFilterChange),
        h('details', { class: 'ytbpm-adv' },
          h('summary', {}, 'Sources'),
          checkbox('scanDesc', 'Description, BeatStars/Airbit, commentaires', onScanToggle),
          checkbox('audio', "Estimer à l'écoute si rien n'est écrit", onAudioToggle),
          checkbox('skipIntro', "Sauter l'intro pendant l'analyse", saveSettings))),
      h('div', { class: 'ytbpm-legend' },
        h('span', { 'data-k': 'title' }, 'titre'),
        h('span', { 'data-k': 'desc' }, 'description · boutique · commentaire'),
        h('span', { 'data-k': 'audio' }, '≈ écoute')),
      stats,
      list,
      h('button', { class: 'ytbpm-more', onclick: loadMore }, 'Charger plus de résultats'));

    document.body.append(toggle, panel);
    ui = { toggle, panel, stats, list };
    setOpen(settings.open);
  }

  let renderTimer;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderPanel, 150); }

  function renderPanel() {
    if (!ui) return;
    const all = [...videos.values()];
    const withBpm = all.filter(v => v.bpm).length, withKey = all.filter(v => v.key).length;
    const pending = queue.length + active;
    ui.stats.textContent = `${all.length} vidéos · ${withBpm} avec BPM · ${withKey} avec tonalité` +
      (pending ? ` · analyse de ${pending}…` : '');
    if (!settings.open) return;

    const items = all.filter(isVisible).sort((a, b) => {
      if (settings.sort === 'yt' || (!a.bpm && !b.bpm)) return a.order - b.order;
      if (!a.bpm) return 1;
      if (!b.bpm) return -1;
      return settings.sort === 'asc' ? a.bpm - b.bpm : b.bpm - a.bpm;
    });

    ui.list.replaceChildren(...items.map(v => h('a', { class: 'ytbpm-item', href: `/watch?v=${v.id}` },
      h('img', { src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, loading: 'lazy', alt: '' }),
      h('span', { class: 'ytbpm-vals' },
        h('span', { class: 'ytbpm-bpm', 'data-src': v.bpm ? srcState(v.bpmSrc) : 'none' },
          v.bpm ? `${v.bpmSrc === 'audio' ? '≈' : ''}${v.bpm}` : (v.status === 'done' ? '—' : '…')),
        h('span', { class: 'ytbpm-k', 'data-src': v.key ? srcState(v.keySrc) : 'none' },
          v.key ? fmtKey(v.key, v.keySrc) : '')),
      h('span', { class: 'ytbpm-meta' },
        h('span', { class: 'ytbpm-title' }, v.title),
        h('span', { class: 'ytbpm-channel' }, v.channel)))));
    if (!items.length) ui.list.append(h('p', { class: 'ytbpm-empty' }, 'Aucun résultat pour ce filtre.'));
  }

  // ---------- Démarrage ----------
  function updateVisibility() {
    document.documentElement.classList.toggle('ytbpm-on-results', location.pathname === '/results');
  }

  async function init() {
    try {
      const r = await store.get([CACHE_KEY, SETTINGS_KEY]);
      cache = r[CACHE_KEY] || {};
      Object.assign(settings, r[SETTINGS_KEY] || {});
    } catch {}
    buildUI();
    updateVisibility();
    processResults();
    watchTick();

    let procTimer;
    new MutationObserver(() => { clearTimeout(procTimer); procTimer = setTimeout(processResults, 300); })
      .observe(document.querySelector('ytd-app') || document.body, { childList: true, subtree: true });

    const onNav = () => { updateVisibility(); processResults(); watchTick(); scheduleRender(); };
    window.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('popstate', onNav);
    setInterval(watchTick, 1000);

    // Un BPM / une tonalité trouvés dans un autre onglet apparaissent ici aussi
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[CACHE_KEY]) return;
      mergeCache(changes[CACHE_KEY].newValue);
      videos.forEach(v => {
        const c = cache[v.id];
        if (c && (c.bpm !== v.bpm || c.key !== v.key)) syncVideo(v.id);
      });
    });
  }

  init();
})();
