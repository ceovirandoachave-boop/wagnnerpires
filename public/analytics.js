(function () {
  if (window.__vacAnalytics) return;
  window.__vacAnalytics = true;
  var script = document.currentScript;
  var key = script && (new URL(script.src).searchParams.get('key') || script.dataset.key);
  var endpoint = script ? new URL('/api/analytics/collect', script.src).href : '';
  if (!key || !endpoint) return;
  var consent = (script.dataset.consent || 'required') !== 'required' || localStorage.getItem('vac_analytics_consent') === 'granted' || document.cookie.indexOf('vac_analytics_consent=granted') >= 0;
  var queue = [], began = Date.now(), lastMove = 0, maxScroll = 0, snapshotSent = false;
  function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
  var visitor = localStorage.getItem('vac_vid') || id(), session = sessionStorage.getItem('vac_sid') || id();
  try { localStorage.setItem('vac_vid', visitor); sessionStorage.setItem('vac_sid', session); } catch (_) {}
  var pageId = id(), pageBegan = Date.now();
  var device = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : (/Tablet|iPad/i.test(navigator.userAgent) ? 'tablet' : 'desktop');
  var browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'Outro';
  var params = new URLSearchParams(location.search);
  function selector(el) { if (!el || !el.closest) return ''; el = el.closest('a,button,[role=button],input,form') || el; return ((el.id ? '#' + el.id : el.tagName.toLowerCase()) + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')).slice(0, 150); }
  function snapshot() { try { var c = document.documentElement.cloneNode(true); c.querySelectorAll('script,noscript,iframe,object,embed').forEach(function (e) { e.remove(); }); c.querySelectorAll('input,textarea,select,[contenteditable]').forEach(function (e) { e.removeAttribute('value'); e.textContent = '••••'; }); c.querySelectorAll('[data-private],[data-heatmap-mask],.private').forEach(function (e) { e.textContent = '••••'; }); var h = '<!doctype html>' + c.outerHTML; return h.length < 1500000 ? h : null; } catch (_) { return null; } }
  function page() { return { id: pageId, url: location.href, path: location.pathname, title: document.title, referrer: document.referrer, startedAt: pageBegan, duration: Date.now() - pageBegan, viewportW: innerWidth, viewportH: innerHeight, documentH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), maxScroll: maxScroll, snapshot: snapshotSent ? null : snapshot() }; }
  function send(final) { if (!consent || !queue.length) return; var pg = page(); snapshotSent = true; var body = JSON.stringify({ key: key, session: { id: session, visitorId: visitor, startedAt: began, device: device, browser: browser, utmSource: params.get('utm_source') || '', utmMedium: params.get('utm_medium') || '', utmCampaign: params.get('utm_campaign') || '' }, pageview: pg, events: queue.splice(0, 100) }); if (final && navigator.sendBeacon) navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' })); else fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {}); }
  function event(type, extra) { if (!consent) return; queue.push(Object.assign({ id: id(), type: type, at: Date.now() }, extra || {})); if (queue.length >= 20) send(false); }
  addEventListener('click', function (e) { var el=e.target, a=el.closest&&el.closest('a,[href],[onclick]'), href=String(a&&(a.href||a.getAttribute('href'))||''), mark=(selector(el)+' '+href+' '+String((a&&a.getAttribute('aria-label'))||'')+' '+String((a&&a.textContent)||'')).toLowerCase(); event('click', { x: e.pageX / Math.max(1, document.documentElement.scrollWidth), y: e.pageY / Math.max(1, document.documentElement.scrollHeight), target: selector(el) }); if (/wa\.me|whatsapp\.com|api\.whatsapp|whatsapp:|whats ?app/.test(mark)) event('conversion', { name: 'Clique no WhatsApp' }); else if (/^tel:/i.test(href)) event('conversion', { name: 'Clique no telefone' }); else if (/^mailto:/i.test(href)) event('conversion', { name: 'Clique no e-mail' }); send(false); }, true);
  addEventListener('submit', function (e) { event('submit', { name: 'Formulário enviado', target: selector(e.target) }); }, true);
  addEventListener('scroll', function () { var p = Math.min(100, Math.round(100 * (scrollY + innerHeight) / Math.max(innerHeight, document.documentElement.scrollHeight))); if (p > maxScroll) { maxScroll = p; if (p % 10 < 3) event('scroll', { scroll: p }); } }, { passive: true });
  addEventListener('mousemove', function (e) { if (Date.now() - lastMove < 500) return; lastMove = Date.now(); event('mousemove', { x: e.pageX / Math.max(1, document.documentElement.scrollWidth), y: e.pageY / Math.max(1, document.documentElement.scrollHeight) }); }, { passive: true });
  addEventListener('pagehide', function () { send(true); }); addEventListener('visibilitychange', function () { if (document.hidden) send(true); }); setInterval(function () { send(false); }, 5000);
  window.VACAnalytics = { consent: function (v) { consent = !!v; if (v) { localStorage.setItem('vac_analytics_consent', 'granted'); event('route'); } }, track: function (name, value) { event('conversion', { name: String(name || 'Conversão').slice(0, 100), value: Number(value) || 0 }); } };
  event('route');
})();
