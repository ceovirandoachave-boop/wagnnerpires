// Auto-reconectador do WhatsApp Lite (Evolution) — detecta socket morto e reinicia sozinho.
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const EVO = 'http://127.0.0.1:8080';
const API_KEY = (fs.readFileSync('/root/evolution/.env', 'utf8').match(/EVOLUTION_API_KEY=(.*)/) || [, ''])[1].trim();
const INTERVAL = 90 * 1000;
const fails = {};            // instancia -> falhas consecutivas
let containerCooldown = 0;   // evita reiniciar o container em sequencia

function log(...a) { console.log(new Date().toISOString(), ...a); }

function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(EVO + path);
    const headers = { apikey: API_KEY, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', e => resolve({ status: 0, error: e.message, raw: '' }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, error: 'timeout', raw: '' }); });
    if (data) r.write(data); r.end();
  });
}

async function probe(inst, ownerDigits) {
  if (!ownerDigits) return { status: 'unknown' };
  const r = await req('POST', `/chat/fetchProfilePictureUrl/${inst}`, { number: ownerDigits });
  const txt = (r.raw || '') + JSON.stringify(r.json || '');
  if (/connection closed/i.test(txt)) return { status: 'dead', detail: txt.slice(0, 100) };
  if (r.status === 200 || /profilePictureUrl|wuid/i.test(txt)) return { status: 'alive' };
  return { status: 'unknown', detail: txt.slice(0, 100) };
}

function restartContainer() {
  if (Date.now() < containerCooldown) { log('container em cooldown, pulando'); return; }
  containerCooldown = Date.now() + 5 * 60 * 1000;
  log('!!! ESCALANDO: reiniciando o container do Evolution');
  try { execSync('docker restart $(docker ps --filter name=evolution -q | head -1)', { timeout: 60000 }); log('container reiniciado'); }
  catch (e) { log('erro ao reiniciar container:', e.message); }
}

async function tick() {
  const list = await req('GET', '/instance/fetchInstances');
  const instances = Array.isArray(list.json) ? list.json : [];
  for (const it of instances) {
    const inst = it.name || it.instanceName || (it.instance && it.instance.instanceName);
    if (!inst || !/^lite/.test(inst)) continue;
    const state = String(it.connectionStatus || it.state || (it.instance && it.instance.state) || '').toLowerCase();
    const owner = String(it.ownerJid || it.number || '').replace(/\D/g, '');

    if (state !== 'open') {
      // tenta reconectar (usa as credenciais salvas; só pede QR se foi deslogado de verdade)
      await req('GET', `/instance/connect/${inst}`);
      continue;
    }

    const p = await probe(inst, owner);
    if (p.status === 'alive' || p.status === 'unknown') {
      if (fails[inst]) log(`[${inst}] recuperado ✅`);
      fails[inst] = 0;
      continue;
    }
    // p.status === 'dead' -> "open" mentindo, socket fechado
    fails[inst] = (fails[inst] || 0) + 1;
    log(`[${inst}] socket morto (open mentindo) — falhas=${fails[inst]} ${p.detail || ''}`);
    if (fails[inst] <= 2) {
      await req('POST', `/instance/restart/${inst}`);
      log(`[${inst}] restart da instancia`);
    } else {
      restartContainer();
      fails[inst] = 0;
    }
  }
}

log('lite-monitor iniciado — intervalo', INTERVAL / 1000, 's');
tick().catch(e => log('erro tick:', e.message));
setInterval(() => tick().catch(e => log('erro tick:', e.message)), INTERVAL);
