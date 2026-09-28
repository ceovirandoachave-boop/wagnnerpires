// Desliga o webhookBase64 das instâncias Lite.
// Com base64 ligado a Evolution embute o arquivo no corpo do webhook: um vídeo de
// 25 MB vira ~33 MB de JSON, estoura o express.json (30 MB) e a mensagem inteira se
// perde. Desligado, o webhook carrega só metadados e o saveLiteMedia busca a mídia
// depois via getBase64FromMediaMessage (caminho que já existia como fallback).
const fs = require('fs');

const EVO = 'http://127.0.0.1:8080';
const KEY = (fs.readFileSync('/root/clients/virandoachave/.env', 'utf8').match(/^EVOLUTION_API_KEY=(.*)$/m) || [])[1].trim();
const DRY = process.argv.includes('--dry');

// só instâncias de tenants que realmente existem no PM2 (evita as órfãs)
const TENANTS = process.argv.slice(2).filter(a => !a.startsWith('-'));

async function req(method, path, body) {
  const r = await fetch(EVO + path, {
    method,
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = txt; }
  return { ok: r.ok, status: r.status, json };
}

(async () => {
  const list = await req('GET', '/instance/fetchInstances');
  if (!list.ok) { console.error('falha ao listar instancias:', list.status, list.json); process.exit(1); }
  const instancias = (Array.isArray(list.json) ? list.json : [list.json])
    .map(i => (i.instance || i))
    .map(x => String(x.instanceName || x.name || ''))
    .filter(Boolean);

  const alvo = instancias.filter(n => {
    const tenant = n.replace(/^lite2?-/, '');
    return TENANTS.includes(tenant);
  });

  console.log(`instancias encontradas: ${instancias.length} | alvo: ${alvo.length}\n`);

  for (const inst of alvo) {
    const cur = await req('GET', `/webhook/find/${inst}`);
    const w = cur.json || {};
    if (!cur.ok || !w.url) { console.log(`${inst.padEnd(26)} sem webhook configurado — pulado`); continue; }
    if (w.webhookBase64 === false) { console.log(`${inst.padEnd(26)} ja estava false — ok`); continue; }
    if (DRY) { console.log(`${inst.padEnd(26)} [dry] mudaria base64 ${w.webhookBase64} -> false`); continue; }

    const set = await req('POST', `/webhook/set/${inst}`, {
      webhook: {
        enabled: w.enabled !== false,
        url: w.url,
        byEvents: !!w.webhookByEvents,
        base64: false,
        events: Array.isArray(w.events) ? w.events : ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
      },
    });
    const novo = set.json && set.json.webhookBase64;
    console.log(`${inst.padEnd(26)} base64 ${w.webhookBase64} -> ${novo}${novo === false ? '  OK' : '  <<< FALHOU'}`);
  }
})();
