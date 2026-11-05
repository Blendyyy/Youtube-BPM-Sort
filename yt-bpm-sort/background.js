// Service worker : lit les pages de vente de beats (BeatStars, Airbit, Traktrain) liées dans les descriptions.
// Le script de la page YouTube ne peut pas y accéder directement (autre site), d'où ce relais.
// Seuls ces sites sont autorisés, et la requête part sans cookies.

const ALLOWED = [/(^|\.)beatstars\.com$/i, /^bsta\.rs$/i, /(^|\.)airbit\.com$/i, /(^|\.)traktrain\.com$/i, /^bit\.ly$/i];
const allowed = url => {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED.some(r => r.test(u.hostname));
  } catch { return false; }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'fetchStore' || sender.id !== chrome.runtime.id) return;
  (async () => {
    try {
      if (!allowed(msg.url)) throw new Error('site non autorisé');
      const url = msg.url.replace(/^http:/i, 'https:');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
      } finally {
        clearTimeout(timer);
      }
      if (!allowed(res.url)) throw new Error('redirection vers un site non autorisé');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = (await res.text()).slice(0, 3000000);
      sendResponse({ ok: true, text, url: res.url });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;   // réponse asynchrone
});
