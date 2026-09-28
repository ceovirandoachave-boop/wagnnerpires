const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const https = require('https');
const execAsync = util.promisify(exec);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public-admin')));

const CORE_DIR = __dirname;
const CLIENTS_BASE = '/root/clients';
const REGISTRY_FILE = path.join(CORE_DIR, 'clients-registry.json');
const ECOSYSTEM_FILE = path.join(CORE_DIR, 'ecosystem.config.js');
const NGINX_SITES = '/etc/nginx/sites-enabled';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'gestorwagnnerpires.com.br';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ceovirandoachave@gmail.com';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_FILE = path.join(CORE_DIR, 'provisioner-admin.json');
const META_ACCOUNTS_FILE = path.join(CORE_DIR, 'meta-accounts.json');
const META_CONFIG_FILE   = path.join(CORE_DIR, 'meta-config.json');

// JWT_SECRET persiste entre reinicializações para não invalidar sessões
const JWT_SECRET_FILE = path.join(CORE_DIR, '.provisioner-secret');
function getJwtSecret() {
  try { return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(JWT_SECRET_FILE, s);
  return s;
}
const JWT_SECRET = getJwtSecret();

// ─── Admin auth ────────────────────────────────────────────

function loadAdmin() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); }
  catch { return { username: 'admin', password: 'admin123' }; }
}

function createToken() {
  const b64 = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('hex');
  return `${b64}.${sig}`;
}
function verifyToken(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  return crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('hex') === sig;
}
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!verifyToken(token)) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

// ─── Registry ──────────────────────────────────────────────

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
  catch { return []; }
}
function saveRegistry(clients) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(clients, null, 2));
}
function getNextPort(clients) {
  if (!clients.length) return 3001;
  return Math.max(...clients.map(c => c.port)) + 1;
}

// ─── Meta Ads ──────────────────────────────────────────────

function loadMetaAccounts() {
  try { return JSON.parse(fs.readFileSync(META_ACCOUNTS_FILE, 'utf8')); }
  catch { return []; }
}
function saveMetaAccounts(accounts) {
  fs.writeFileSync(META_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function loadMetaConfig() {
  try { return JSON.parse(fs.readFileSync(META_CONFIG_FILE, 'utf8')); }
  catch { return { accessToken: '' }; }
}
function saveMetaConfig(cfg) {
  fs.writeFileSync(META_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Resposta inválida da Meta API')); }
      });
    }).on('error', reject);
  });
}

function calcIndicator(ctr, frequency, impressions) {
  if (impressions === 0) return 'sem_dados';
  if (ctr < 0.3 || frequency >= 5) return 'critico';
  if (ctr < 1   || frequency >= 3) return 'ruim';
  if (ctr < 2   || frequency >= 2) return 'medio';
  return 'bom';
}

async function fetchMetaInsights(account, accessToken, datePreset = 'today') {
  const { id } = account;
  const tok = encodeURIComponent(accessToken);

  const [accountData, insightsData] = await Promise.all([
    httpsGet(`https://graph.facebook.com/v19.0/act_${id}?fields=name,account_status,currency&access_token=${tok}`),
    httpsGet(`https://graph.facebook.com/v19.0/act_${id}/insights?fields=impressions,clicks,actions,frequency,spend&date_preset=${datePreset}&access_token=${tok}`),
  ]);

  if (accountData.error) throw new Error(accountData.error.message);
  if (insightsData.error) throw new Error(insightsData.error.message);

  const accountName = accountData.name || account.name || id;
  const accountStatus = accountData.account_status === 1 ? 'ativa' : 'pausada';
  const currency = accountData.currency || 'BRL';
  const d = insightsData.data?.[0] || {};

  const impressions = parseInt(d.impressions || 0);
  const clicks     = parseInt(d.clicks || 0);
  const frequency  = parseFloat(d.frequency || 0);
  const spend      = parseFloat(d.spend || 0);
  const actions    = d.actions || [];

  const leads = parseInt(
    actions.find(a => a.action_type === 'lead')?.value || 0
  );
  const messages = parseInt(
    actions.find(a =>
      a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
      a.action_type === 'onsite_conversion.messaging_first_reply'
    )?.value || 0
  );
  const purchases = parseInt(
    actions.find(a =>
      a.action_type === 'purchase' ||
      a.action_type === 'offsite_conversion.fb_pixel_purchase'
    )?.value || 0
  );
  const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;

  return {
    accountName,
    accountStatus,
    currency,
    impressions,
    clicks,
    leads,
    messages,
    purchases,
    showPurchases: account.showPurchases || false,
    frequency: parseFloat(frequency.toFixed(2)),
    spend: parseFloat(spend.toFixed(2)),
    ctr,
    indicator: calcIndicator(ctr, frequency, impressions),
  };
}

// ─── Routes ────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = loadAdmin();
  if (username !== admin.username || password !== admin.password)
    return res.status(401).json({ error: 'Credenciais inválidas' });
  res.json({ token: createToken() });
});

app.get('/api/clients', requireAuth, async (req, res) => {
  const registry = loadRegistry();
  let pm2List = [];
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null');
    pm2List = JSON.parse(stdout || '[]');
  } catch {}

  const clients = registry.map(c => {
    const p = pm2List.find(x => x.name === c.id);
    return {
      id: c.id,
      port: c.port,
      url: `https://${c.id}.${BASE_DOMAIN}`,
      status: p?.pm2_env?.status || 'unknown',
      memory: p?.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) + 'mb' : '-',
      restarts: p?.pm2_env?.restart_time ?? '-',
      uptime: p?.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
    };
  });
  res.json(clients);
});

app.post('/api/clients', requireAuth, async (req, res) => {
  const { id, username, password } = req.body || {};

  if (!id || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id) || id.length < 2 || id.length > 30)
    return res.status(400).json({ error: 'ID inválido: apenas letras minúsculas, números e hífen (2-30 chars)' });
  if (!username || !password)
    return res.status(400).json({ error: 'Usuário e senha obrigatórios' });

  const registry = loadRegistry();
  if (registry.find(c => c.id === id))
    return res.status(400).json({ error: `Cliente "${id}" já existe` });

  const clientDir = path.join(CLIENTS_BASE, id);
  const port = getNextPort(registry);
  let addedToRegistry = false;

  try {
    // 1. Diretórios
    ['data', 'baileys_auth', 'uploads'].forEach(d =>
      fs.mkdirSync(path.join(clientDir, d), { recursive: true })
    );

    // 2. .env
    const envLines = [
      `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`,
      `WA_VERIFY_TOKEN=${crypto.randomBytes(16).toString('hex')}`,
    ];
    if (process.env.META_APP_ID)          envLines.push(`META_APP_ID=${process.env.META_APP_ID}`);
    if (process.env.META_APP_SECRET)      envLines.push(`META_APP_SECRET=${process.env.META_APP_SECRET}`);
    if (process.env.WA_EMBEDDED_CONFIG_ID) envLines.push(`WA_EMBEDDED_CONFIG_ID=${process.env.WA_EMBEDDED_CONFIG_ID}`);
    // Sem isso o WhatsApp Lite (Evolution API) nunca liga pro cliente novo — liteEnabled()
    // no server.js exige EVOLUTION_API_KEY. Faltava aqui (bug achado 25/09, cliente phdtatuape).
    if (process.env.EVOLUTION_API_KEY)    envLines.push(`EVOLUTION_API_KEY=${process.env.EVOLUTION_API_KEY}`);
    if (process.env.EVOLUTION_API_URL)    envLines.push(`EVOLUTION_API_URL=${process.env.EVOLUTION_API_URL}`);
    fs.writeFileSync(path.join(clientDir, '.env'), envLines.join('\n') + '\n');

    // 3. clients.json
    fs.writeFileSync(path.join(clientDir, 'clients.json'), JSON.stringify([
      { id, username, password, admin: true, name: id }
    ], null, 2));

    // 4. Registry + PM2
    registry.push({ id, port, dataDir: clientDir });
    saveRegistry(registry);
    addedToRegistry = true;

    await execAsync(`pm2 startOrRestart ${ECOSYSTEM_FILE} --only ${id}`);
    await execAsync('pm2 save');

    // 5. Nginx
    const nginxConf = `server {
    server_name ${id}.${BASE_DOMAIN};

    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    listen 80;
}`;
    fs.writeFileSync(path.join(NGINX_SITES, id), nginxConf);
    await execAsync('nginx -t && systemctl reload nginx');

    // 6. SSL em background
    const certCmd = `certbot --nginx -d ${id}.${BASE_DOMAIN} --non-interactive --agree-tos -m ${ADMIN_EMAIL} --redirect 2>&1`;
    execAsync(certCmd)
      .then(() => console.log(`[${id}] SSL ativo`))
      .catch(e => console.error(`[${id}] Certbot erro: ${e.message}`));

    res.json({
      ok: true, id, port,
      url: `https://${id}.${BASE_DOMAIN}`,
      note: 'SSL sendo configurado em background (~30s). Enquanto isso use HTTP.',
    });
  } catch (e) {
    if (addedToRegistry) saveRegistry(loadRegistry().filter(c => c.id !== id));
    try { await execAsync(`pm2 delete ${id}`).catch(() => {}); } catch {}
    try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(path.join(NGINX_SITES, id)); } catch {}
    await execAsync('nginx -t && systemctl reload nginx').catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients/:id/ssl', requireAuth, async (req, res) => {
  const { id } = req.params;
  const registry = loadRegistry();
  if (!registry.find(c => c.id === id))
    return res.status(404).json({ error: 'Cliente não encontrado' });
  try {
    const certCmd = `certbot --nginx -d ${id}.${BASE_DOMAIN} --non-interactive --agree-tos -m ${ADMIN_EMAIL} --redirect 2>&1`;
    const { stdout } = await execAsync(certCmd);
    res.json({ ok: true, output: stdout.slice(-300) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const registry = loadRegistry();
  if (!registry.find(c => c.id === id))
    return res.status(404).json({ error: 'Cliente não encontrado' });

  try {
    await execAsync(`pm2 delete ${id}`).catch(() => {});
    saveRegistry(registry.filter(c => c.id !== id));
    await execAsync('pm2 save');
    try { fs.unlinkSync(path.join(NGINX_SITES, id)); } catch {}
    await execAsync('nginx -t && systemctl reload nginx').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Meta Ads routes ───────────────────────────────────────

app.get('/api/meta-config', requireAuth, (req, res) => {
  const cfg = loadMetaConfig();
  res.json({ hasToken: !!cfg.accessToken });
});

app.post('/api/meta-config', requireAuth, (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'accessToken obrigatório' });
  saveMetaConfig({ accessToken });
  res.json({ ok: true });
});

app.get('/api/meta-accounts', requireAuth, async (req, res) => {
  const cfg = loadMetaConfig();
  if (!cfg.accessToken) return res.json({ needsToken: true, accounts: [] });

  const VALID_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month'];
  const datePreset = VALID_PRESETS.includes(req.query.preset) ? req.query.preset : 'today';

  const accounts = loadMetaAccounts();
  const results = await Promise.all(accounts.map(async a => {
    try {
      const metrics = await fetchMetaInsights(a, cfg.accessToken, datePreset);
      return { id: a.id, name: a.name, ...metrics };
    } catch (e) {
      return {
        id: a.id, name: a.name, accountName: a.name, accountStatus: 'erro',
        currency: 'BRL', error: e.message, indicator: 'critico',
        impressions: 0, clicks: 0, leads: 0, messages: 0, purchases: 0,
        showPurchases: a.showPurchases || false, frequency: 0, spend: 0, ctr: 0,
      };
    }
  }));
  res.json({ needsToken: false, accounts: results });
});

app.post('/api/meta-accounts', requireAuth, (req, res) => {
  const { id, name, showPurchases } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  const accounts = loadMetaAccounts();
  if (accounts.find(a => a.id === id)) return res.status(400).json({ error: `Conta "${id}" já existe` });
  accounts.push({ id, name: name || id, showPurchases: !!showPurchases });
  saveMetaAccounts(accounts);
  res.json({ ok: true });
});

app.delete('/api/meta-accounts/:id', requireAuth, (req, res) => {
  const accounts = loadMetaAccounts().filter(a => a.id !== req.params.id);
  saveMetaAccounts(accounts);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nProvisionador em http://localhost:${PORT}`);
  console.log(`Painel admin: https://admin.${BASE_DOMAIN}`);
});
