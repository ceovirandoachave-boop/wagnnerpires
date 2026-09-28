const express = require('express');
let makeWASocket, useMultiFileAuthState, DisconnectReason,
    downloadMediaMessage, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers;

async function loadBaileys() {
  const mod = await import('@whiskeysockets/baileys');
  makeWASocket              = mod.makeWASocket || mod.default?.makeWASocket || mod.default;
  useMultiFileAuthState     = mod.useMultiFileAuthState;
  DisconnectReason          = mod.DisconnectReason;
  downloadMediaMessage      = mod.downloadMediaMessage;
  fetchLatestBaileysVersion = mod.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = mod.makeCacheableSignalKeyStore;
  Browsers                  = mod.Browsers;
}
const P = require('pino');
const cron = require('node-cron');
const qrcode = require('qrcode');
const Busboy = require('busboy');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { forClient: createDb } = require('./db');
let puppeteerCore = null;

const DATA_DIR = process.env.DATA_DIR || __dirname;
loadEnvFile(DATA_DIR);

const app = express();
app.set('trust proxy', 1);
// CORS pro plugin do WhatsApp Web (extensão Chrome) — só libera a origem do WhatsApp Web
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin === 'https://web.whatsapp.com') {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '30mb' }));
// Corpo maior que o limite morria silencioso: o body-parser estourava, a mensagem
// se perdia e nada era logado. Agora fica registrado com rota e tamanho.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    const tam = Number(req.headers['content-length']) || 0;
    console.warn(`[body-too-large] ${req.method} ${req.originalUrl} — ${(tam / 1048576).toFixed(1)} MB (limite 30 MB)`);
    return res.status(413).json({ error: 'Conteúdo grande demais para o servidor processar.' });
  }
  return next(err);
});
// app.js/style.css ganham cache longo (1 ano) — o index.html abaixo referencia eles
// com ?v=<mtime>, então trocar o arquivo já força o navegador a baixar de novo.
// index.html fica de fora do static (index:false) pra ser servido pela rota dinâmica
// logo abaixo, que injeta essa versão sem precisar lembrar de atualizar nada na mão.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'analytics.js') res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (/\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
function serveVersionedIndex(req, res) {
  try {
    let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const vAppJs = fs.statSync(path.join(__dirname, 'public', 'app.js')).mtimeMs.toString(36);
    const vStyle = fs.statSync(path.join(__dirname, 'public', 'style.css')).mtimeMs.toString(36);
    html = html.replace(/app\.js\?v=[^"']*/g, 'app.js?v=' + vAppJs);
    html = html.replace(/style\.css\?v=[^"']*/g, 'style.css?v=' + vStyle);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    res.sendFile(INDEX_HTML_PATH);
  }
}
app.get(['/', '/index.html'], serveVersionedIndex);

const UPLOADS_BASE = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_BASE)) fs.mkdirSync(UPLOADS_BASE, { recursive: true });
app.use('/uploads', express.static(UPLOADS_BASE));

// Link publico usado em emails de nota fiscal. /uploads continua inline para nao
// quebrar imagens, audios e videos do chat; esta rota força o navegador a baixar.
app.get('/download/:clientId/:filename', (req, res) => {
  const clientId = String(req.params.clientId || '');
  const filename = String(req.params.filename || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(clientId) || !filename || path.basename(filename) !== filename) {
    return res.status(400).send('Arquivo inválido');
  }
  const clientDir = path.resolve(UPLOADS_BASE, clientId);
  const filePath = path.resolve(clientDir, filename);
  if (!filePath.startsWith(clientDir + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).send('Arquivo não encontrado');
  }
  const requestedName = path.basename(String(req.query.name || filename));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.download(filePath, requestedName);
});

const BAILEYS_AUTH_BASE = process.env.BAILEYS_AUTH_BASE || path.join(DATA_DIR, 'baileys_auth');
const LEGACY_BAILEYS_AUTH_BASE = path.join(__dirname, 'baileys_auth');
if (!fs.existsSync(BAILEYS_AUTH_BASE)) fs.mkdirSync(BAILEYS_AUTH_BASE, { recursive: true });
const GRAPH_API_VERSION = process.env.WA_CLOUD_API_VERSION || 'v22.0';
const DISPATCH_INTERVAL_MS = 40 * 1000;
const CLOUD_DISPATCH_INTERVAL_MS = 500; // API Oficial aguenta ritmo alto (Meta faz o controle); 40s era herança do Lite/Baileys
const DEAF_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const DEAF_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const QUEUE_SCAN_INTERVAL_MS = 10 * 1000;
const TRANSIENT_RETRY_DELAY_MS = 2 * 60 * 1000;
const BULK_BATCH_SIZE = 5;
const BULK_REST_MS = 5 * 60 * 1000;
const TRANSIENT_RETRY_DELAY_WITH_DOCUMENT_MS = 5 * 60 * 1000;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MEDIA_RETENTION_MS = 72 * 60 * 60 * 1000;
const MEDIA_CLEANUP_SCHEDULE = '17 * * * *';
const MESSAGE_RETENTION_DAYS = 180; // mensagens mais velhas viram messages_archive (nunca são descartadas)
const MESSAGE_ARCHIVE_SCHEDULE = '23 3 * * *'; // 1x por dia, de madrugada
const VACUUM_SCHEDULE = '30 4 * * 0'; // 1x por semana (domingo de madrugada) — VACUUM reescreve o arquivo inteiro, não precisa rodar toda hora
const MAX_TRANSIENT_RETRIES = 3;
const SESSION_RESTORE_GRACE_MS = 60 * 1000;
const POST_READY_GRACE_MS = 20 * 1000;
const GROUP_CANARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JWT_SECRET = process.env.JWT_SECRET || 'wa-multi-secret-2026';

function isMediaTooLarge(size) {
  return Number(size) > MAX_MEDIA_BYTES;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { windowsHide: true, maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve());
  });
}

// WhatsApp só reproduz áudio de voz (sendWhatsAppAudio) em OGG/Opus — o navegador
// grava webm ou mp4, então sem essa conversão o envio falha silenciosamente na Evolution API.
async function convertToWhatsAppOgg(inputPath) {
  const parsed = path.parse(inputPath);
  const outPath = path.join(parsed.dir, `${parsed.name}.wa.ogg`);
  await runFfmpeg(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', outPath]);
  return outPath;
}

// Processamento assíncrono: a mídia original continua disponível mesmo se o
// FFmpeg não estiver instalado ou se um arquivo específico estiver corrompido.
function createVideoDerivatives(filePath, mimeType = '') {
  if (!String(mimeType).startsWith('video/')) return;
  const parsed = path.parse(filePath);
  const thumbnailPath = path.join(parsed.dir, `${parsed.name}.thumb.jpg`);
  const compressedPath = path.join(parsed.dir, `${parsed.name}.compressed.mp4`);
  void (async () => {
    try {
      await runFfmpeg(['-y', '-ss', '00:00:01', '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-2', thumbnailPath]);
      await runFfmpeg(['-y', '-i', filePath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', compressedPath]);
      console.log(`[media] derivados de vídeo criados: ${path.basename(filePath)}`);
    } catch (error) {
      console.warn(`[media] não foi possível processar ${path.basename(filePath)}: ${error.message}`);
      for (const derivedPath of [thumbnailPath, compressedPath]) {
        try { fs.unlinkSync(derivedPath); } catch {}
      }
    }
  })();
}

function cleanupExpiredMedia() {
  const cutoff = Date.now() - MEDIA_RETENTION_MS;
  let removed = 0;
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(target); continue; }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('brand-logo-')) continue; // identidade do relatório é permanente
      try {
        if (fs.statSync(target).mtimeMs < cutoff) {
          fs.unlinkSync(target);
          removed++;
        }
      } catch {}
    }
  }
  walk(UPLOADS_BASE);
  if (removed) console.log(`[media] limpeza de retenção removeu ${removed} arquivo(s)`);
}

// ─── Auth ──────────────────────────────────────────────────

// loadClients() roda dentro do requireAuth — ou seja, em toda requisição autenticada
// (potencialmente mais de uma vez por requisição). Sem cache, isso é um
// fs.readFileSync síncrono (bloqueia o event loop) repetido dezenas de vezes por
// minuto só pra reler um arquivo que só muda quando saveClients() escreve.
let _clientsCache = null;
function loadClients() {
  if (!_clientsCache) {
    const p = path.join(DATA_DIR, 'clients.json');
    try { _clientsCache = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { _clientsCache = []; }
  }
  return _clientsCache.slice(); // cópia rasa: cada chamador mexe no próprio array sem afetar o cache
}

function saveClients(clients) {
  const p = path.join(DATA_DIR, 'clients.json');
  fs.writeFileSync(p, JSON.stringify(clients, null, 2));
  _clientsCache = clients;
}

// Qual cliente É este processo (mesmo padrão já usado em outros pontos do arquivo pra
// garantir que o tenant "dono" deste DATA_DIR esteja carregado). Usado pra travas do tipo
// "essa rotina só deve rodar de fato no processo do cliente X", já que server.js é o mesmo
// código rodando em 15 processos diferentes — sem essa checagem, qualquer getTenant('x')
// chamado de um cron global planta um TenantState completo de outro cliente dentro deste
// processo, e loops de fundo (watchdog do Lite, filas etc.) passam a mexer nele também.
function ownClientId() {
  try {
    const cs = loadClients();
    const own = cs.find(c => c.admin && !c.ownerClientId) || cs[0];
    return own ? own.id : null;
  } catch (e) { return null; }
}

const ALL_FEATURES = ['schedule','broadcast','templates','pending','logs','reports','chat','crm','prospects','queue','workspace','clientarea','financeiro','config','debug'];

function createToken(user) {
  const b64 = Buffer.from(JSON.stringify({ loginId: user.id, clientId: user.ownerClientId || user.id, iat: Date.now() })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('hex');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(b64, 'base64').toString()); } catch { return null; }
}

function getUserFeatures(user) {
  if (!user) return [];
  if (!user.ownerClientId || user.admin) return ALL_FEATURES;
  return Array.isArray(user.permissions?.features) ? user.permissions.features : [];
}

function hasFeature(user, feature) {
  return getUserFeatures(user).includes(feature);
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  // req.query.t é fallback para EventSource (não suporta headers customizados)
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.t || null);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Não autenticado' });
  const clients = loadClients();
  const loginId = payload.loginId || payload.clientId;
  const user = clients.find(c => c.id === loginId);
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
  req.user = user;
  req.loginClientId = user.id;
  req.clientId = user.ownerClientId || user.id;
  req.userFeatures = getUserFeatures(user);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.admin) return res.status(403).json({ error: 'Acesso restrito a administradores' });
  next();
}

function requireFeature(feature) {
  return requireAnyFeature([feature]);
}

function requireAnyFeature(features) {
  return (req, res, next) => {
    if (req.user && !req.user.ownerClientId) return next();
    if (!features.some(feature => hasFeature(req.user, feature))) return res.status(403).json({ error: 'Sem permissão para esta funcionalidade' });
    next();
  };
}

// ─── Persistent MsgStore (anti-phantom-message fix) ────────
// getMessage must return undefined (not {}) when msg not found.
// We persist the store to disk so retries after crash can find the original message.
class PersistentMsgStore {
  constructor(filePath, maxEntries = 2000) {
    this._file = filePath;
    this._max = maxEntries;
    this._map = new Map();
    this._dirty = false;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [k, v] of raw) this._map.set(k, v);
    } catch {}
    this._flushTimer = setInterval(() => { if (this._dirty) this._flush(); }, 10000);
  }
  get(id) { return this._map.get(id); }
  set(id, msg) {
    this._map.set(id, msg);
    this._dirty = true;
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
  clear() { this._map.clear(); this._dirty = true; }
  _flush() {
    try { fs.writeFileSync(this._file, JSON.stringify([...this._map.entries()])); } catch {}
    this._dirty = false;
  }
  destroy() { clearInterval(this._flushTimer); this._flush(); }
}

// ─── Tenant State ──────────────────────────────────────────

class TenantState {
  constructor(clientId) {
    this.clientId = clientId;
    this.db = createDb(clientId);
    this.uploadsDir = path.join(UPLOADS_BASE, clientId);
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });

    // Chat em tempo real (SSE): quem está com a aba aberta recebe um "avisa agora" assim
    // que uma mensagem é gravada, em vez de esperar o próximo poll. Não manda o conteúdo
    // da mensagem pelo SSE — só um sinal — o cliente busca os dados de verdade pela mesma
    // rota autenticada/filtrada de sempre (evita duplicar a lógica de permissão aqui).
    this.chatSseClients = new Set();
    {
      const _origRecordMessage = this.db.recordMessage.bind(this.db);
      this.db.recordMessage = (msg) => {
        const result = _origRecordMessage(msg);
        broadcastChatEvent(this, { direction: msg && msg.direction, contactId: msg && msg.contactId });
        return result;
      };
    }

    // WhatsApp state
    this.waClient = null;
    this.isReady = false;
    this.groups = [];
    this.contacts = [];
    this.qrCodeData = null;
    this.pendingQrCodeData = null;
    this.sessionRestoreState = 'idle';
    this.sessionRestoreStartedAt = 0;
    this.revealQrTimer = null;
    this.lastReadyAt = 0;
    this.lastInboundAt = 0;
    this.isReconnectingClient = false;
    this.pairPhoneNumber = null;
    this.latestPairingCode = null;
    const dataDir = path.join(DATA_DIR, 'data', clientId);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.msgStore = new PersistentMsgStore(path.join(dataDir, 'msg_store.json'));
    this.msgRetryCounterCache = new Map(); // external — survives socket reconnects
    this.syncFullHistoryOnce = false;
    this.baileysConnectionHealth = {};

    // Group dispatch safety
    const cfg = this.db.getConfig();
    this.groupDispatchPaused = !!cfg.groupDispatchPaused;
    this.groupDispatchPauseReason = cfg.groupDispatchPauseReason || '';
    this.groupCanaryGroupId = cfg.groupCanaryGroupId || process.env[`WA_GROUP_CANARY_ID_${clientId.toUpperCase()}`] || process.env.WA_GROUP_CANARY_ID || '';
    this.groupCanaryGroupName = cfg.groupCanaryGroupName || '';
    this.groupCanaryLastAt = Number(cfg.groupCanaryLastAt || 0);
    this.groupCanaryLastOk = !!cfg.groupCanaryLastOk;

    // Dispatch queue
    this.pendingQueue = [];
    this.queuedIds = new Set();
    this.isDispatching = false;
    this.lastDispatchAt = 0;

    // Provider — credenciais por tenant vêm apenas do banco (Embedded Signup ou config manual)
    this.provider = (cfg.provider || 'web').toLowerCase();
    this.WA_PHONE_NUMBER_ID = cfg.WA_PHONE_NUMBER_ID || '';
    this.WA_ACCESS_TOKEN = cfg.WA_ACCESS_TOKEN || '';
    this.WA_VERIFY_TOKEN = cfg.WA_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN || `vac-${clientId}-${crypto.randomBytes(6).toString('hex')}`;
    this.WA_WABA_ID = cfg.WA_WABA_ID || '';
    this.WA_BUSINESS_ID = cfg.WA_BUSINESS_ID || '';
    this.WA_DISPLAY_PHONE_NUMBER = cfg.WA_DISPLAY_PHONE_NUMBER || '';

    // Cloud connection 2
    this.WA_PHONE_NUMBER_ID_2 = cfg.WA_PHONE_NUMBER_ID_2 || '';
    this.WA_ACCESS_TOKEN_2 = cfg.WA_ACCESS_TOKEN_2 || '';
    this.WA_DISPLAY_PHONE_NUMBER_2 = cfg.WA_DISPLAY_PHONE_NUMBER_2 || '';
    this.WA_WABA_ID_2 = cfg.WA_WABA_ID_2 || '';

    // Cloud connection 3 (token manual)
    this.WA_PHONE_NUMBER_ID_3 = cfg.WA_PHONE_NUMBER_ID_3 || '';
    this.WA_ACCESS_TOKEN_3 = cfg.WA_ACCESS_TOKEN_3 || '';
    this.WA_DISPLAY_PHONE_NUMBER_3 = cfg.WA_DISPLAY_PHONE_NUMBER_3 || '';
    this.WA_WABA_ID_3 = cfg.WA_WABA_ID_3 || '';
    this.WA_PHONE_NUMBER_ID_4 = cfg.WA_PHONE_NUMBER_ID_4 || '';
    this.WA_ACCESS_TOKEN_4 = cfg.WA_ACCESS_TOKEN_4 || '';
    this.WA_DISPLAY_PHONE_NUMBER_4 = cfg.WA_DISPLAY_PHONE_NUMBER_4 || '';
    this.WA_WABA_ID_4 = cfg.WA_WABA_ID_4 || '';
    this.WA_PHONE_NUMBER_ID_5 = cfg.WA_PHONE_NUMBER_ID_5 || '';
    this.WA_ACCESS_TOKEN_5 = cfg.WA_ACCESS_TOKEN_5 || '';
    this.WA_DISPLAY_PHONE_NUMBER_5 = cfg.WA_DISPLAY_PHONE_NUMBER_5 || '';
    this.WA_WABA_ID_5 = cfg.WA_WABA_ID_5 || '';

    // Baileys dedicado a grupos
    this.waGroupClient = null;
    this.isGroupReady = false;
    this.groupQrCode = null;
    this.groupPairingCode = null;
    this.groupSessionState = 'idle';
    this.groupPairPhone = null;

    // Baileys slot 2 (follow-up)
    this.waClient2 = null;
    this.isReady2 = false;
    this.qrCode2 = null;
    this.pairingCode2 = null;
    this.sessionState2 = 'idle';
    this.pairPhone2 = null;

    // Baileys slot 3 (commercial)
    this.waClient3 = null;
    this.isReady3 = false;
    this.qrCode3 = null;
    this.pairingCode3 = null;
    this.sessionState3 = 'idle';
    this.pairPhone3 = null;
  }
}

const tenants = new Map();

function getTenant(clientId) {
  if (!tenants.has(clientId)) tenants.set(clientId, new TenantState(clientId));
  return tenants.get(clientId);
}

// Avisa quem está com o app aberto (aba em foco ou não) que algo mudou — o cliente
// reage buscando os dados de novo pela rota autenticada, não pelo conteúdo do evento.
// Mesma conexão SSE serve tanto o chat quanto o email (eventos com nomes diferentes).
function broadcastSseEvent(t, eventName, payload) {
  if (!t.chatSseClients || !t.chatSseClients.size) return;
  const line = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload || {}) + '\n\n';
  for (const res of t.chatSseClients) {
    try { res.write(line); } catch (e) { t.chatSseClients.delete(res); }
  }
}
function broadcastChatEvent(t, payload) { broadcastSseEvent(t, 'chat', payload); }
function broadcastEmailEvent(t, payload) { broadcastSseEvent(t, 'email', payload); }

// ─── WhatsApp per-tenant (Baileys) ─────────────────────────

// Extrai o texto de mensagens INTERATIVAS (botoes/CTA, templates, listas, enquetes) que
// nao tem .conversation/.extendedTextMessage — sem isso caiam como '[mensagem]' no chat.
function interactiveMessageText(m) {
  if (!m) return '';
  try {
    const b = m.buttonsMessage;
    if (b) return [b.contentText, b.text, b.footerText].filter(Boolean).join('\n');
    const tpl = m.templateMessage;
    if (tpl) {
      const h = tpl.hydratedTemplate || tpl.hydratedFourRowTemplate || tpl.fourRowTemplate || {};
      const btns = (h.hydratedButtons || []).map(x => (x.urlButton && (x.urlButton.displayText || x.urlButton.url)) || (x.quickReplyButton && x.quickReplyButton.displayText) || (x.callButton && x.callButton.displayText) || '').filter(Boolean);
      return [h.hydratedContentText, h.hydratedTitleText, h.hydratedFooterText, btns.length ? ('\uD83D\uDD18 ' + btns.join(' \u00b7 ')) : ''].filter(Boolean).join('\n');
    }
    const im = m.interactiveMessage;
    if (im) return [im.header && (im.header.title || im.header.subtitle), im.body && im.body.text, im.footer && im.footer.text].filter(Boolean).join('\n');
    const ir = m.interactiveResponseMessage;
    if (ir) return (ir.body && ir.body.text) || '';
    const lm = m.listMessage;
    if (lm) return [lm.title, lm.description, lm.footerText].filter(Boolean).join('\n');
    const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
    if (poll) return '\uD83D\uDCCA ' + (poll.name || 'Enquete');
    const br = m.buttonsResponseMessage;
    if (br) return br.selectedDisplayText || br.selectedButtonId || '';
    const tb = m.templateButtonReplyMessage;
    if (tb) return tb.selectedDisplayText || '';
    const lr = m.listResponseMessage;
    if (lr) return lr.title || (lr.singleSelectReply && lr.singleSelectReply.selectedRowId) || '';
  } catch (e) {}
  return '';
}
function extractBaileysText(msg) {
  const m = msg.message;
  if (!m) return '';
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.singleSelectReply?.selectedRowId || interactiveMessageText(m) || '';
}

function getBaileysMediaType(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage || m.stickerMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage || m.pttMessage) return 'audio';
  if (m.documentMessage) return 'document';
  return null;
}

function normalizeJid(jid) {
  if (typeof jid !== 'string') return jid;
  return jid.replace('@c.us', '@s.whatsapp.net');
}

function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

function normalizeBrazilianMobileDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // WhatsApp BR costuma receber móvel como 55 + DDD + 9 + 8 dígitos.
  // Alguns eventos chegam sem esse 9; para envio, corrigimos automaticamente.
  if (/^55\d{10}$/.test(digits)) return `${digits.slice(0, 4)}9${digits.slice(4)}`;
  return digits;
}

function phoneToWebJid(phone) {
  const digits = normalizeBrazilianMobileDigits(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function phoneDigitVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const normalized = normalizeBrazilianMobileDigits(digits);
  return [...new Set([digits, normalized].filter(Boolean))];
}

function findCrmPhoneDigitsForContact(t, contactId) {
  const raw = String(contactId || '');
  const normalized = normalizeJid(raw);
  const incomingDigits = phoneDigitVariants(normalized);
  const cards = t.db.getCrmCards();
  const byWhatsappId = cards.find(card => {
    if (!card.whatsappId) return false;
    const cardJid = normalizeJid(card.whatsappId);
    return card.whatsappId === raw || cardJid === normalized || cardJid === raw;
  });
  if (byWhatsappId?.phone) return String(byWhatsappId.phone).replace(/\D/g, '');

  const byPhone = cards.find(card => phoneDigitVariants(card.phone).some(d => incomingDigits.includes(d)));
  return byPhone?.phone ? String(byPhone.phone).replace(/\D/g, '') : '';
}

function outboundJidCandidates(t, recipientId) {
  const raw = String(recipientId || '').trim();
  const normalized = normalizeJid(raw);
  const digits = findCrmPhoneDigitsForContact(t, raw) || digitsFromJid(normalized) || (!raw.includes('@') ? raw : '');
  const candidates = [];
  if (digits) {
    for (const variant of phoneDigitVariants(digits).reverse()) candidates.push(`${variant}@s.whatsapp.net`);
  }
  if (normalized && !isLidJid(normalized)) candidates.push(normalized);
  return [...new Set(candidates.filter(Boolean))];
}

async function resolveOutboundWebJid(t, recipientId) {
  const raw = String(recipientId || '').trim();
  if (!raw) throw new Error('Destino invalido.');
  const normalized = normalizeJid(raw);
  if (normalized.endsWith('@g.us')) return normalized;

  // @lid: resolve via cache persistente no DB primeiro, depois store do Baileys, depois CRM
  if (isLidJid(normalized)) {
    const cached = t.db.resolveLid(normalized);
    if (cached) return normalizeJid(cached);
    try {
      const store = t.waClient?.store || t.store;
      const contact = store?.contacts?.[normalized];
      if (contact?.lid) return normalizeJid(contact.lid);
      if (contact?.id && !isLidJid(contact.id)) return normalizeJid(contact.id);
    } catch {}
    // Tenta via telefone do card CRM que tem este @lid como whatsappId
    const crmCandidates = outboundJidCandidates(t, raw);
    if (crmCandidates.length) return crmCandidates[0];
    // Sem alternativa: envia pro @lid e deixa o WA resolver no servidor
    return normalized;
  }

  const candidates = outboundJidCandidates(t, raw);
  if (!candidates.length && isLidJid(normalized)) {
    throw new Error('Esse contato esta salvo como @lid. Abra o card no CRM e preencha o telefone real com DDI antes de enviar.');
  }

  // onWhatsApp() com cache de 24h por JID — evita query repetida para o mesmo número
  // sem abrir mão da validação anti-spam.
  const ONWA_CACHE_TTL = 24 * 60 * 60 * 1000;
  if (!t._onWhatsAppCache) t._onWhatsAppCache = new Map();
  const freshConnection = t.lastReadyAt && (Date.now() - t.lastReadyAt) < 30000;
  if (!freshConnection && t.waClient?.onWhatsApp) {
    let checkedAny = false;
    for (const jid of candidates) {
      const cached = t._onWhatsAppCache.get(jid);
      if (cached && (Date.now() - cached.ts) < ONWA_CACHE_TTL) {
        if (cached.resolved) return cached.resolved;
        continue;
      }
      try {
        const result = await t.waClient.onWhatsApp(jid);
        checkedAny = true;
        const match = Array.isArray(result) ? result.find(r => r?.exists) : null;
        if (match?.jid) {
          const resolved = normalizeJid(match.jid);
          t._onWhatsAppCache.set(jid, { resolved, ts: Date.now() });
          return resolved;
        }
        if (match) {
          t._onWhatsAppCache.set(jid, { resolved: jid, ts: Date.now() });
          return jid;
        }
        t._onWhatsAppCache.set(jid, { resolved: null, ts: Date.now() });
      } catch (e) {
        if (isTransientWebSessionError(e)) throw e;
        console.warn(`[${t.clientId}] Falha ao validar destino ${jid}: ${e.message}`);
      }
    }
    if (checkedAny) throw new Error(`Nenhuma variante deste numero existe no WhatsApp: ${candidates.join(', ')}`);
  }

  if (candidates[0]) {
    return candidates[0];
  }
  return normalized;
}

function digitsFromJid(jid) {
  const raw = String(jid || '');
  if (raw.endsWith('@g.us') || raw.endsWith('@lid')) return '';
  return raw.replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');
}

// Lógica pura de match telefone/whatsappId↔card, operando numa lista já carregada
// (usada quando o chamador precisa casar VÁRIAS conversas sem reconsultar o banco
// a cada uma — ver getCrmCardsForMatching).
// Índice O(1) por telefone/whatsappId — usado só onde a busca roda em cima da LISTA
// inteira de conversas (enrichChatConversations). Contas com muitos contatos (Cloud,
// sem limpeza de conversas antigas) tinham aqui um O(conversas x cards) que passava de
// milhões de operações por chamada de /api/chat — cada poll/evento SSE reprocessava tudo.
function buildCrmCardPhoneIndex(cards) {
  const byDigit = new Map();
  const byWhatsappJid = new Map();
  for (const card of cards) {
    for (const v of phoneDigitVariants(card.phone)) if (!byDigit.has(v)) byDigit.set(v, card);
    for (const v of phoneDigitVariants(card.whatsapp)) if (!byDigit.has(v)) byDigit.set(v, card);
    if (card.whatsappId) { const j = normalizeJid(card.whatsappId); if (!byWhatsappJid.has(j)) byWhatsappJid.set(j, card); }
  }
  return { byDigit, byWhatsappJid };
}
function findCrmCardInIndex(index, contactId) {
  const normalized = normalizeJid(contactId);
  const hit = index.byWhatsappJid.get(normalized);
  if (hit) return hit;
  for (const d of phoneDigitVariants(digitsFromJid(contactId))) { const c = index.byDigit.get(d); if (c) return c; }
  return null;
}
function findCrmCardInList(cards, contactId) {
  const normalized = normalizeJid(contactId);
  const digits = phoneDigitVariants(digitsFromJid(contactId));
  return cards.find(card => {
    const cardPhoneVariants = phoneDigitVariants(card.phone);
    const cardWaVariants = phoneDigitVariants(card.whatsapp);
    const cardWhatsapp = card.whatsappId ? normalizeJid(card.whatsappId) : '';
    return (digits.length && (cardPhoneVariants.some(d => digits.includes(d)) || cardWaVariants.some(d => digits.includes(d)))) || (cardWhatsapp && cardWhatsapp === normalized);
  }) || null;
}
function findCrmCardForChat(t, contactId) {
  return findCrmCardInList(t.db.getCrmCards(), contactId);
}

// Gatilho automático do chatbot de IA: além do toggle manual por contato, também
// dispara sozinho quando o card do lead está na coluna configurada em
// Configurações → IA (aiChatbotColumnId). Sem nada configurado ainda, cai num
// padrão razoável: qualquer coluna chamada "Novo lead" (ou variação próxima).
function crmColumnMatchesNovoLead(t, columnId) {
  if (!columnId) return false;
  const cfg = t.db.getConfig();
  if (cfg.aiChatbotColumnId) return columnId === cfg.aiChatbotColumnId;
  const col = t.db.getCrmColumns().find(c => c.id === columnId);
  return !!(col && /novo\s*lead/i.test(col.name || ''));
}

// Decide se a IA deve responder essa mensagem: usa o mesmo "botPaused" do Auto
// Atendimento — se um atendente já respondeu manualmente (pelo painel ou direto
// no celular), a IA para de responder até alguém clicar em "Resolver / reativar
// bot". Sem isso, a IA continuaria falando por cima de quem já assumiu a conversa.
function aiChatbotShouldTrigger(t, contactId, columnId) {
  if (t.db.getContactBotState(contactId).botPaused) return false;
  if (getAiChatbotExcludedSet(t).has(contactId)) return false;
  // Gate por etiqueta: se aiChatbotRequireLabels estiver setado, a IA só atende leads
  // que tenham uma dessas etiquetas (ex.: só quem veio do Google/tráfego pago).
  const _req = (t.db.getConfig() || {}).aiChatbotRequireLabels;
  if (Array.isArray(_req) && _req.length) {
    const _card = findCrmCardForChat(t, contactId);
    const _labels = _card ? (Array.isArray(_card.labels) ? _card.labels : (_card.label ? [_card.label] : [])) : [];
    const _reqLower = _req.map(x => String(x).toLowerCase());
    return _labels.some(l => _reqLower.some(req => String(l).toLowerCase().includes(req)));
  }
  return getAiChatbotSet(t).has(contactId) || crmColumnMatchesNovoLead(t, columnId);
}

function enrichCrmCardsWithAvatars(t, cards) {
  const contacts = t.db.getKnownContactsWithPics();
  if (!contacts.length) return cards;
  return cards.map(card => {
    if (String(card.whatsappId || '').endsWith('@g.us')) return card;
    const cardWhatsapp = card.whatsappId ? normalizeJid(card.whatsappId) : '';
    const cardDigits = phoneDigitVariants(card.phone);
    if (!cardWhatsapp && !cardDigits.length) return card;
    const match = contacts.find(c => {
      const cNorm = normalizeJid(c.id);
      if (cardWhatsapp && cNorm === cardWhatsapp) return true;
      const cDigits = phoneDigitVariants(c.phone || digitsFromJid(c.id));
      return cDigits.some(d => cardDigits.some(cd => cd === d || cd.endsWith(d) || d.endsWith(cd)));
    });
    return match ? { ...card, profilePicUrl: match.profile_pic_url } : card;
  });
}

// cardsForMatching opcional: se o chamador já carregou a lista leve (getCrmCardsForMatching),
// reaproveita em vez de reconsultar o banco pra cada conversa (era um SELECT * completo
// por conversa — em 50 conversas, 50 varreduras da tabela inteira a cada poll).
function enrichChatConversations(t, conversations, cardsForMatching) {
  const cards = cardsForMatching || t.db.getCrmCardsForMatching();
  const index = buildCrmCardPhoneIndex(cards);
  return conversations.map(conversation => {
    const card = findCrmCardInIndex(index, conversation.contactId);
    if (card?.contactName) return { ...conversation, contactName: card.contactName, crmCardId: card.id };
    return conversation;
  });
}

function getChatContactAliases(t, contactId) {
  const aliases = new Set();
  const add = value => {
    if (!value) return;
    aliases.add(value);
    aliases.add(normalizeJid(value));
  };
  const raw = String(contactId || '').trim();
  const normalized = normalizeJid(raw);
  add(raw);

  for (const card of t.db.getCrmCards()) {
    const phoneJid = phoneToWebJid(card.phone);
    const legacyPhoneJid = card.phone ? `${String(card.phone).replace(/\D/g, '')}@c.us` : null;
    const cardWhatsappJid = card.whatsappId ? normalizeJid(card.whatsappId) : null;
    if (phoneJid === normalized || legacyPhoneJid === raw || card.whatsappId === raw || cardWhatsappJid === normalized) {
      add(phoneJid);
      add(legacyPhoneJid);
      for (const variant of phoneDigitVariants(card.phone)) add(`${variant}@s.whatsapp.net`);
      add(card.whatsappId);
    }
  }

  return [...aliases].filter(Boolean);
}

function mergeTenantContacts(t, contacts) {
  for (const c of contacts) {
    if (!c.id) continue;
    const name = c.notify || c.name || '';
    if (!name && !c.lid) continue;
    const existing = t.contacts.find(x => x.id === c.id);
    if (existing) {
      if (name) existing.name = name;
      if (c.lid) existing.lid = c.lid;
    } else {
      const entry = { id: c.id };
      if (name) entry.name = name;
      if (c.lid) entry.lid = c.lid;
      t.contacts.push(entry);
    }
    // Persiste lid→phone no banco para sobreviver reinicializações
    if (c.lid && !isLidJid(c.id)) {
      t.db.saveLidMapping(normalizeJid(c.lid), normalizeJid(c.id));
    }
  }
  resolveCrmLidPhones(t);
}

function resolveCrmLidPhones(t) {
  const cards = t.db.getCrmCards().filter(c => c.whatsappId && isLidJid(c.whatsappId) && !c.phone);
  for (const card of cards) {
    const contact = t.contacts.find(c => c.lid === card.whatsappId);
    if (!contact?.id || isLidJid(contact.id)) continue;
    const phone = digitsFromJid(contact.id);
    if (!phone) continue;
    t.db.updateCrmCard(card.id, { phone, whatsappId: contact.id });
  }
}

async function initBaileysClient(t) {
  if (t.waClient || t._initWebInProgress) return;
  t._initWebInProgress = true;
  const authDir = path.join(BAILEYS_AUTH_BASE, t.clientId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  let state, saveCreds, version;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(authDir));
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    t._initWebInProgress = false;
    throw err;
  }
  const logger = P({ level: 'silent' });

  // Sessão nova (QR fresh) → pede histórico completo uma vez
  if (!state.creds.me) t.syncFullHistoryOnce = true;

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: !!t.syncFullHistoryOnce,
    markOnlineOnConnect: false,
    msgRetryCounterCache: t.msgRetryCounterCache,
    getMessage: async (key) => t.msgStore.get(key.id),
    keepAliveIntervalMs: 30000,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 30000,
  });

  t.waClient = sock;
  t._initWebInProgress = false;
  t.sessionRestoreState = 'starting';
  if (!t._pendingMsgAcks) t._pendingMsgAcks = new Map();

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, reachoutTimeLock } = update;

    if (reachoutTimeLock !== undefined) {
      if (reachoutTimeLock?.isActive) {
        t.reachoutLocked = true;
        t.reachoutLockedUntil = reachoutTimeLock.timeEnforcementEnds || null;
        t.reachoutLockType = reachoutTimeLock.enforcementType || 'DEFAULT';
        console.warn(`[${t.clientId}] WA bloqueou envios 1:1 (${t.reachoutLockType}) até ${t.reachoutLockedUntil?.toLocaleString('pt-BR') || 'tempo indeterminado'}`);
      } else {
        t.reachoutLocked = false;
        t.reachoutLockedUntil = null;
        t.reachoutLockType = null;
        console.log(`[${t.clientId}] WA liberou restrição de envio 1:1`);
      }
    }

    if (qr) {
      if (t.pairPhoneNumber && !sock.authState.creds.registered) {
        // Pairing code mode: intercept QR and request code instead
        try {
          const code = await sock.requestPairingCode(t.pairPhoneNumber);
          t.latestPairingCode = code;
          t.sessionRestoreState = 'awaiting_pair_code';
          console.log(`[${t.clientId}] Pairing code:`, code);
        } catch (e) { console.error(`[${t.clientId}] Pairing code error:`, e.message); }
      } else {
        t.qrCodeData = await qrcode.toDataURL(qr);
        t.sessionRestoreState = 'awaiting_qr';
        t.isReady = false;
      }
    }

    if (connection === 'open') {
      console.log(`[${t.clientId}] WhatsApp conectado (Baileys)!`);
      t.isReady = true;
      t._reconnectAttempts = 0;
      t.connectedPhone = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
      clearBaileysConnectionHealth(t, 'web');
      t.pairPhoneNumber = null;
      t.latestPairingCode = null;
      t.lastReadyAt = Date.now();
      t.lastInboundAt_web = Date.now();
      t.qrCodeData = null;
      t.sessionRestoreState = 'ready';
      t.syncFullHistoryOnce = false;
      await new Promise(r => setTimeout(r, 4000));
      await refreshGroups(t);
      if (!t.groups.length) setTimeout(() => refreshGroups(t).catch(() => {}), 8000);
    }

    if (connection === 'close') {
      t.isReady = false;
      t.groups = [];
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${t.clientId}] Conexão fechada, código:`, statusCode);
      t.waClient = null;
      const sessionDead = statusCode === DisconnectReason.loggedOut || statusCode === 440;
      if (sessionDead) {
        t.sessionRestoreState = 'idle';
        t._reconnectAttempts = 0;
        if (statusCode === 440) console.warn(`[${t.clientId}] Sessão substituída (440) — aguardando novo QR`);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
      } else {
        t.sessionRestoreState = 'restoring_session';
        t._reconnectAttempts = (t._reconnectAttempts || 0) + 1;
        const delay = Math.min(3000 * Math.pow(2, t._reconnectAttempts - 1), 300000);
        console.log(`[${t.clientId}] Reconectando em ${Math.round(delay/1000)}s (tentativa ${t._reconnectAttempts})`);
        setTimeout(() => initBaileysClient(t), delay);
      }
    }
  });

  sock.ev.on('contacts.set', ({ contacts }) => mergeTenantContacts(t, contacts));
  sock.ev.on('contacts.upsert', (contacts) => mergeTenantContacts(t, contacts));

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      // Store every message (sent + received) so getMessage can serve retries without phantom sends
      if (msg.key?.id) t.msgStore.set(msg.key.id, msg.message);
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      const isGroup = jid.endsWith('@g.us');
      const fromMe = msg.key.fromMe;
      const text = extractBaileysText(msg);
      const media = await saveBaileysMedia(t, msg);

      if (fromMe) {
        pauseBotFromEcho(t, msg.key);
        const chatName = isGroup
          ? (t.groups.find(g => g.id === jid)?.name || jid)
          : (t.contacts.find(c => c.id === jid)?.name || jid.replace('@s.whatsapp.net', ''));
        if (text || media) t.db.recordMessage({ direction: 'out', contactId: jid, contactName: chatName, text: text || (media ? '' : '[midia]'), mediaUrl: media?.url || null, mediaType: media?.type || null, mediaName: media?.name || null, connectionId: 'web' });
        continue;
      }

      const senderId = isGroup ? (msg.key.participant || jid) : jid;
      t.lastInboundAt = Date.now();
      t.lastInboundAt_web = Date.now();
      const senderContact = t.contacts.find(c => c.id === senderId) ||
        (isLidJid(senderId) ? t.contacts.find(c => c.lid === senderId) : null);
      let resolvedSenderId = (isLidJid(senderId) && senderContact?.id) ? senderContact.id : senderId;
      // Se ainda é @lid, tenta resolver pelo pushName — mesmo contato com número real
      if (isLidJid(resolvedSenderId) && msg.pushName) {
        const byName = t.contacts.find(c =>
          !isLidJid(c.id) && (c.name === msg.pushName || c.notify === msg.pushName)
        );
        if (byName?.id) resolvedSenderId = byName.id;
      }
      if (isLidJid(senderId) && !isLidJid(resolvedSenderId) && resolvedSenderId !== senderId) {
        t.db.saveLidMapping(senderId, resolvedSenderId);
      }
      const senderName = senderContact?.name || msg.pushName ||
        resolvedSenderId.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', '');
      const storageJid = isLidJid(jid) ? resolvedSenderId : jid;
      const displayText = text ? text.trim() : (media ? '' : '[midia]');
      const cleanDisplayText = stripTrackingTags(displayText);

      if (isGroup) {
        const groupName = t.groups.find(g => g.id === jid)?.name || jid;
        t.db.recordMessage({ direction: 'in', contactId: storageJid, contactName: groupName, text: cleanDisplayText ? `${senderName}: ${cleanDisplayText}` : senderName, mediaUrl: media?.url || null, mediaType: media?.type || null, mediaName: media?.name || null, connectionId: 'web' });
      } else {
        t.db.recordMessage({ direction: 'in', contactId: storageJid, contactName: senderName, text: cleanDisplayText, mediaUrl: media?.url || null, mediaType: media?.type || null, mediaName: media?.name || null, connectionId: 'web' });
        fetchAndSaveProfilePic(t, jid).catch(() => {});
        const _bestPhone = digitsFromJid(storageJid) || digitsFromJid(jid);
        const _existCard = findCrmCardForChat(t, storageJid) || findCrmCardForChat(t, jid)
          || (senderName ? t.db.getCrmCards().find(c => !c.whatsappId && !c.phone && c.contactName === senderName) : null);
        if (!_existCard) {
          const inbox = getFirstCrmColumn(t);
          if (inbox && !crmIsNoFunnel(t, _bestPhone || storageJid)) {
            const newCard = t.db.createCrmCard({ columnId: inbox.columnId, funnelId: inbox.funnelId, contactName: senderName, whatsapp: _bestPhone || '', whatsappId: storageJid });
            if (newCard) { t.db.markCrmCardNewMessage(newCard.id); applyLeadSourceTag(t, newCard, displayText); captureSiteRef(t, newCard, displayText); captureFbCookies(t, newCard, displayText); captureGoogleAdsRef(t, newCard, displayText); }
          }
        } else {
          const upd = {};
          if (!_existCard.whatsappId)                upd.whatsappId = storageJid;
          if (!_existCard.contactName && senderName) upd.contactName = senderName;
          if (!_existCard.phone && _bestPhone)       upd.phone = _bestPhone;
          if (Object.keys(upd).length) t.db.updateCrmCard(_existCard.id, upd);
          t.db.markCrmCardNewMessage(_existCard.id);
        }
      }

      if (text) await recordIncomingReply(t, { recipientId: storageJid, senderId, senderName, replyText: text.trim(), isGroup });
      if (!isGroup && text) {
        const _aiCard = findCrmCardForChat(t, storageJid);
        if (aiChatbotShouldTrigger(t, storageJid, _aiCard?.columnId)) {
          scheduleAiChatbotReply(t, storageJid, _bestPhone, 'web');
        }
      }
      testChatHandleMsg(t, msg, 'web');
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || !key?.id || update?.status === undefined) continue;
      const statusNames = ['error', 'pending', 'server_ack', 'delivery_ack', 'read', 'played'];
      const statusName = statusNames[update.status] || String(update.status);
      const pending = t._pendingMsgAcks?.get(key.id);
      if (pending) {
        clearTimeout(pending.timer);
        t._pendingMsgAcks.delete(key.id);
        if (update.status === 0) {
          pending.reject(new Error(`WhatsApp rejeitou a mensagem (status: error) para ${key.remoteJid}`));
        } else {
          pending.resolve(update.status);
        }
      }
      if (update.status === 0) {
        console.error(`[${t.clientId}][web] ERRO entrega mensagem ${key.id} → ${key.remoteJid}`);
      } else if (update.status <= 2) {
        console.log(`[${t.clientId}][web] msg ${key.id} → ${key.remoteJid}: ${statusName}`);
      }
    }
  });
}

const EXTRA_BAILEYS_SLOTS = {
  web2: { clientKey: 'waClient2', readyKey: 'isReady2', qrKey: 'qrCode2', codeKey: 'pairingCode2', stateKey: 'sessionState2', phoneKey: 'pairPhone2', authSuffix: '_web2', connectionId: 'web2' },
  web3: { clientKey: 'waClient3', readyKey: 'isReady3', qrKey: 'qrCode3', codeKey: 'pairingCode3', stateKey: 'sessionState3', phoneKey: 'pairPhone3', authSuffix: '_web3', connectionId: 'web3' },
};

async function initExtraBaileysClient(t, slotKey) {
  const slot = EXTRA_BAILEYS_SLOTS[slotKey];
  if (!slot) throw new Error(`Slot invalido: ${slotKey}`);
  const initKey = `_initSlotInProgress_${slotKey}`;
  if (t[slot.clientKey] || t[initKey]) return;
  t[initKey] = true;

  const authDir = path.join(BAILEYS_AUTH_BASE, t.clientId + slot.authSuffix);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  let state, saveCreds, version;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(authDir));
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    t[initKey] = false;
    throw err;
  }
  const logger = P({ level: 'silent' });

  const slotSyncKey = `syncFullHistoryOnce_${slotKey}`;
  if (!state.creds.me) t[slotSyncKey] = true;

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: !!t[slotSyncKey],
    markOnlineOnConnect: false,
    msgRetryCounterCache: t.msgRetryCounterCache,
    getMessage: async (key) => t.msgStore.get(key.id),
    keepAliveIntervalMs: 30000,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 30000,
  });

  t[slot.clientKey] = sock;
  t[`_initSlotInProgress_${slotKey}`] = false;
  t[slot.stateKey] = 'starting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, reachoutTimeLock } = update;

    if (reachoutTimeLock !== undefined) {
      const lockKey = `reachoutLocked_${slot.connectionId}`;
      const lockUntilKey = `reachoutLockedUntil_${slot.connectionId}`;
      if (reachoutTimeLock?.isActive) {
        t[lockKey] = true;
        t[lockUntilKey] = reachoutTimeLock.timeEnforcementEnds || null;
        console.warn(`[${t.clientId}][${slot.connectionId}] WA bloqueou envios 1:1 até ${t[lockUntilKey]?.toLocaleString('pt-BR') || 'tempo indeterminado'}`);
      } else {
        t[lockKey] = false;
        t[lockUntilKey] = null;
      }
    }

    if (qr) {
      if (t[slot.phoneKey] && !sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(t[slot.phoneKey]);
          t[slot.codeKey] = code;
          t[slot.stateKey] = 'awaiting_pair_code';
          console.log(`[${t.clientId}][${slotKey}] Pairing code:`, code);
        } catch (e) { console.error(`[${t.clientId}][${slotKey}] Pairing code error:`, e.message); }
      } else {
        t[slot.qrKey] = await qrcode.toDataURL(qr);
        t[slot.stateKey] = 'awaiting_qr';
        t[slot.readyKey] = false;
      }
    }

    if (connection === 'open') {
      console.log(`[${t.clientId}][${slotKey}] WhatsApp conectado!`);
      t[slot.readyKey] = true;
      t[`_reconnectAttempts_${slotKey}`] = 0;
      t['connectedPhone_' + slotKey] = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
      clearBaileysConnectionHealth(t, slot.connectionId);
      t[slot.phoneKey] = null;
      t[slot.codeKey] = null;
      t[slot.qrKey] = null;
      t[slot.stateKey] = 'ready';
      t[`syncFullHistoryOnce_${slotKey}`] = false;
      t[`lastReadyAt_${slotKey}`] = Date.now();
      t[`lastInboundAt_${slot.connectionId}`] = Date.now();
    }

    if (connection === 'close') {
      t[slot.readyKey] = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${t.clientId}][${slotKey}] Conexao fechada, codigo:`, statusCode);
      t[slot.clientKey] = null;
      const slotDead = statusCode === DisconnectReason.loggedOut || statusCode === 440;
      if (slotDead) {
        t[slot.stateKey] = 'idle';
        t[`_reconnectAttempts_${slotKey}`] = 0;
        if (statusCode === 440) console.warn(`[${t.clientId}][${slotKey}] Sessão substituída (440) — aguardando novo QR`);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
      } else {
        t[`_reconnectAttempts_${slotKey}`] = (t[`_reconnectAttempts_${slotKey}`] || 0) + 1;
        if (statusCode === DisconnectReason.timedOut && t[`_reconnectAttempts_${slotKey}`] >= 10) {
          console.warn(`[${t.clientId}][${slotKey}] Sessão expirada após ${t[`_reconnectAttempts_${slotKey}`]} tentativas com 408. Limpando sessão — escaneie um novo QR.`);
          t[slot.stateKey] = 'idle';
          t[`_reconnectAttempts_${slotKey}`] = 0;
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        } else {
          t[slot.stateKey] = 'restoring_session';
          const delay = Math.min(3000 * Math.pow(2, t[`_reconnectAttempts_${slotKey}`] - 1), 300000);
          console.log(`[${t.clientId}][${slotKey}] Reconectando em ${Math.round(delay/1000)}s (tentativa ${t[`_reconnectAttempts_${slotKey}`]})`);
          setTimeout(() => initExtraBaileysClient(t, slotKey).catch(() => {}), delay);
        }
      }
    }
  });

  sock.ev.on('contacts.set', ({ contacts }) => mergeTenantContacts(t, contacts));
  sock.ev.on('contacts.upsert', (contacts) => mergeTenantContacts(t, contacts));

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key?.id) t.msgStore.set(msg.key.id, msg.message);
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      const isGroup = jid.endsWith('@g.us');
      const fromMe = msg.key.fromMe;
      const text = extractBaileysText(msg);
      const media = await saveBaileysMedia(t, msg);

      if (fromMe) {
        pauseBotFromEcho(t, msg.key);
        const chatName = isGroup
          ? (t.groups.find(g => g.id === jid)?.name || jid)
          : (t.contacts.find(c => c.id === jid)?.name || jid.replace('@s.whatsapp.net', ''));
        if (text || media) t.db.recordMessage({ direction: 'out', contactId: jid, contactName: chatName, text: text || (media ? '' : '[midia]'), mediaUrl: media?.url || null, mediaType: media?.type || null, mediaName: media?.name || null, connectionId: slot.connectionId });
        continue;
      }

      t.lastInboundAt = Date.now();
      t[`lastInboundAt_${slot.connectionId}`] = Date.now();
      const senderId = isGroup ? (msg.key.participant || jid) : jid;
      const senderContact2 = t.contacts.find(c => c.id === senderId) ||
        (isLidJid(senderId) ? t.contacts.find(c => c.lid === senderId) : null);
      let resolvedSenderId2 = (isLidJid(senderId) && senderContact2?.id) ? senderContact2.id : senderId;
      if (isLidJid(resolvedSenderId2) && msg.pushName) {
        const byName2 = t.contacts.find(c =>
          !isLidJid(c.id) && (c.name === msg.pushName || c.notify === msg.pushName)
        );
        if (byName2?.id) resolvedSenderId2 = byName2.id;
      }
      if (isLidJid(senderId) && !isLidJid(resolvedSenderId2) && resolvedSenderId2 !== senderId) {
        t.db.saveLidMapping(senderId, resolvedSenderId2);
      }
      const senderName = senderContact2?.name || msg.pushName ||
        resolvedSenderId2.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', '');
      const storageJid2 = isLidJid(jid) ? resolvedSenderId2 : jid;
      const displayText = text ? text.trim() : (media ? '' : '[midia]');
      const cleanDisplayText = stripTrackingTags(displayText);

      if (isGroup) {
        const groupName = t.groups.find(g => g.id === jid)?.name || jid;
        t.db.recordMessage({ direction: 'in', contactId: storageJid2, contactName: groupName, text: cleanDisplayText ? `${senderName}: ${cleanDisplayText}` : senderName, mediaUrl: media?.url || null, mediaType: media?.type || null, mediaName: media?.name || null, connectionId: slot.connectionId });
      } else {
        t.db.recordMessage({ direction: 'in', contactId: storageJid2, contactName: senderName, text: cleanDisplayText, mediaUrl: media?.url || null, mediaType: media?.type || null, mediaName: media?.name || null, connectionId: slot.connectionId });
        fetchAndSaveProfilePic(t, jid).catch(() => {});
        const _bestPhone2 = digitsFromJid(storageJid2) || digitsFromJid(jid);
        const _existCard2 = findCrmCardForChat(t, storageJid2) || findCrmCardForChat(t, jid)
          || (senderName ? t.db.getCrmCards().find(c => !c.whatsappId && !c.phone && c.contactName === senderName) : null);
        if (!_existCard2) {
          const inbox = getFirstCrmColumn(t);
          if (inbox && !crmIsNoFunnel(t, _bestPhone2 || storageJid2)) {
            const newCard2 = t.db.createCrmCard({ columnId: inbox.columnId, funnelId: inbox.funnelId, contactName: senderName, whatsapp: _bestPhone2 || '', whatsappId: storageJid2 });
            if (newCard2) { t.db.markCrmCardNewMessage(newCard2.id); applyLeadSourceTag(t, newCard2, displayText); captureSiteRef(t, newCard2, displayText); captureFbCookies(t, newCard2, displayText); captureGoogleAdsRef(t, newCard2, displayText); }
          }
        } else {
          const upd2 = {};
          if (!_existCard2.whatsappId)                 upd2.whatsappId = storageJid2;
          if (!_existCard2.contactName && senderName)  upd2.contactName = senderName;
          if (!_existCard2.phone && _bestPhone2)       upd2.phone = _bestPhone2;
          if (Object.keys(upd2).length) t.db.updateCrmCard(_existCard2.id, upd2);
          t.db.markCrmCardNewMessage(_existCard2.id);
        }
      }

      if (text) await recordIncomingReply(t, { recipientId: storageJid2, senderId, senderName, replyText: text.trim(), isGroup });
      if (!isGroup && text) {
        const _aiCard2 = findCrmCardForChat(t, storageJid2);
        if (aiChatbotShouldTrigger(t, storageJid2, _aiCard2?.columnId)) {
          scheduleAiChatbotReply(t, storageJid2, _bestPhone2, slot.connectionId);
        }
      }
      testChatHandleMsg(t, msg, slot.connectionId);
    }
  });
}

async function initGroupBaileysClient(t) {
  if (t.waGroupClient || t._initGroupInProgress) return;
  t._initGroupInProgress = true;
  const authDir = getGroupAuthDir(t);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  let state, saveCreds, version;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(authDir));
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    t._initGroupInProgress = false;
    throw err;
  }
  const logger = P({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    msgRetryCounterCache: t.msgRetryCounterCache,
    getMessage: async (key) => t.msgStore.get(key.id),
    keepAliveIntervalMs: 30000,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 30000,
  });

  t.waGroupClient = sock;
  t._initGroupInProgress = false;
  t.groupSessionState = 'starting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (t.groupPairPhone && !sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(t.groupPairPhone);
          t.groupPairingCode = code;
          t.groupSessionState = 'awaiting_pair_code';
          console.log(`[${t.clientId}][grupos] Pairing code:`, code);
        } catch (e) { console.error(`[${t.clientId}][grupos] Pairing code error:`, e.message); }
      } else {
        t.groupQrCode = await qrcode.toDataURL(qr);
        t.groupSessionState = 'awaiting_qr';
        t.isGroupReady = false;
      }
    }

    if (connection === 'open') {
      console.log(`[${t.clientId}] WhatsApp Grupos conectado (Baileys)!`);
      t.isGroupReady = true;
      t._reconnectAttemptsGroups = 0;
      t.connectedPhoneGroups = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
      clearBaileysConnectionHealth(t, 'groups');
      t.groupPairPhone = null;
      t.groupPairingCode = null;
      t.groupQrCode = null;
      t.groupSessionState = 'ready';
      await new Promise(r => setTimeout(r, 4000));
      await refreshGroups(t);
      if (!t.groups.length) setTimeout(() => refreshGroups(t).catch(() => {}), 8000);
    }

    if (connection === 'close') {
      t.isGroupReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${t.clientId}][grupos] Conexão fechada, código:`, statusCode);
      t.waGroupClient = null;
      const groupDead = statusCode === DisconnectReason.loggedOut || statusCode === 440;
      if (groupDead) {
        t.groupSessionState = 'idle';
        t._reconnectAttemptsGroups = 0;
        if (statusCode === 440) console.warn(`[${t.clientId}][grupos] Sessão substituída (440) — aguardando novo QR`);
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
      } else {
        t._reconnectAttemptsGroups = (t._reconnectAttemptsGroups || 0) + 1;
        // Após 10 falhas consecutivas com 408, a sessão está morta — exige novo QR
        if (statusCode === DisconnectReason.timedOut && t._reconnectAttemptsGroups >= 10) {
          console.warn(`[${t.clientId}][grupos] Sessão expirada após ${t._reconnectAttemptsGroups} tentativas com 408. Limpando sessão — escaneie um novo QR para grupos.`);
          t.groupSessionState = 'idle';
          t._reconnectAttemptsGroups = 0;
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        } else {
          t.groupSessionState = 'restoring_session';
          const delay = Math.min(3000 * Math.pow(2, t._reconnectAttemptsGroups - 1), 300000);
          console.log(`[${t.clientId}][grupos] Reconectando em ${Math.round(delay/1000)}s (tentativa ${t._reconnectAttemptsGroups})`);
          setTimeout(() => initGroupBaileysClient(t).catch(() => {}), delay);
        }
      }
    }
  });
}

function ensureWebClient(t) {
  if (!t.waClient) initBaileysClient(t).catch(err => console.error(`[${t.clientId}] initBaileysClient error:`, err.message));
}

// Alias mantido para compatibilidade interna
function initWebClient(t) { ensureWebClient(t); }

async function resetWebClient(t) {
  if (t.isReconnectingClient) return;
  t.isReady = false;
  t.qrCodeData = null;
  t.latestPairingCode = null;
  t.sessionRestoreState = 'starting';
  if (t.waClient) {
    try { t.waClient.end(new Error('reset')); } catch {}
    t.waClient = null;
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  initBaileysClient(t).catch(err => console.error(`[${t.clientId}] resetWebClient error:`, err.message));
}

async function forceKillAndReset(t) {
  // Baileys não usa Chromium — apenas fecha o socket e reinicia
  t.pairPhoneNumber = null;
  await resetWebClient(t);
}

// ─── Helper functions (tenant-scoped) ──────────────────────

async function fetchAndSaveProfilePic(t, jid) {
  if (!t.waClient || !t.isReady) return;
  try {
    const url = await t.waClient.profilePictureUrl(jid, 'image');
    if (!url) return;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = `avatar-${jid.replace(/[^a-z0-9]/gi, '_')}.jpg`;
    fs.writeFileSync(path.join(t.uploadsDir, filename), buffer);
    t.db.updateContactPic(jid, `/uploads/${t.clientId}/${filename}`);
  } catch {}
}

async function saveBaileysMedia(t, msg) {
  const mediaType = getBaileysMediaType(msg);
  if (!mediaType) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer || !buffer.length) return null;
    if (isMediaTooLarge(buffer.length)) {
      console.warn(`[${t.clientId}] mídia Baileys ignorada: ${buffer.length} bytes excede 200 MB`);
      return null;
    }
    const m = msg.message;
    const mediaMsg = m.imageMessage || m.videoMessage || m.audioMessage || m.pttMessage || m.documentMessage || m.stickerMessage;
    const mimeType = mediaMsg?.mimetype || `${mediaType}/octet-stream`;
    const ext = mimeType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'bin';
    const filename = `media-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filePath = path.join(t.uploadsDir, filename);
    fs.writeFileSync(filePath, buffer);
    createVideoDerivatives(filePath, mimeType);
    return { url: `/uploads/${t.clientId}/${filename}`, mimetype: mimeType, type: mediaType, name: mediaMsg?.fileName || null };
  } catch { return null; }
}

// Mantido como alias para compatibilidade com código que ainda chama saveIncomingMedia
async function saveIncomingMedia(t, msg) { return saveBaileysMedia(t, msg); }

async function saveCloudMedia(t, message, accessToken) {
  try {
    const mtype = message.type;
    const node = message[mtype] || {};
    const mediaId = node.id;
    if (!mediaId || !accessToken) return null;
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta || !meta.url) return null;
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'WhatsApp/2' } });
    if (!binRes.ok) return null;
    if (isMediaTooLarge(binRes.headers.get('content-length'))) {
      console.warn(`[${t.clientId}] mídia Cloud ignorada: excede 200 MB`);
      return null;
    }
    const buffer = Buffer.from(await binRes.arrayBuffer());
    if (!buffer.length) return null;
    if (isMediaTooLarge(buffer.length)) return null;
    const mimeType = meta.mime_type || node.mime_type || `${mtype}/octet-stream`;
    let ext = (mimeType.split('/')[1] || '').split(';')[0].replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'bin';
    if (mtype === 'audio' && ext === 'mpeg') ext = 'mp3';
    const filename = `media-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filePath = path.join(t.uploadsDir, filename);
    fs.writeFileSync(filePath, buffer);
    createVideoDerivatives(filePath, mimeType);
    return { url: `/uploads/${t.clientId}/${filename}`, mimetype: mimeType, type: mtype, name: node.filename || null };
  } catch (e) { console.log('[saveCloudMedia] erro:', e.message); return null; }
}

async function resolveWebSenderName(t, senderId) {
  const jid = normalizeJid(senderId);
  return t.contacts.find(c => c.id === jid)?.name || jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function resolveWebChatName(t, chatId, fallback = '') {
  const jid = normalizeJid(chatId);
  const group = t.groups.find(g => g.id === jid);
  if (group?.name) return group.name;
  const contact = t.contacts.find(c => c.id === jid);
  if (contact?.name) return contact.name;
  return fallback || jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function refreshGroups(t, { force = false } = {}) {
  // Prioridade: groups → web2 → web3 → web (1:1 como último recurso)
  const sock = (t.isGroupReady && t.waGroupClient)
    || (t.isReady2 && t.waClient2)
    || (t.isReady3 && t.waClient3)
    || (t.isReady && t.waClient);
  if (!sock) return t.groups.length ? t.groups : [];
  // Throttle: evita rate-overlimit em reconexões rápidas (3 min mínimo entre fetches)
  const now = Date.now();
  const THREE_MIN = 3 * 60 * 1000;
  if (!force && t._lastGroupRefresh && (now - t._lastGroupRefresh) < THREE_MIN) {
    return t.groups.length ? t.groups : [];
  }
  t._lastGroupRefresh = now;
  try {
    const allGroups = [];
    try {
      const groups = await sock.groupFetchAllParticipating();
      allGroups.push(...Object.values(groups));
    } catch (e) {
      console.error(`[${t.clientId}] Erro ao carregar grupos:`, e.message);
    }
    const byId = new Map();
    allGroups.forEach(g => { if (g?.id) byId.set(g.id, g); });
    const groupList = [...byId.values()];
    // Extrai mapeamentos LID→telefone dos participantes para resolver @lid em mensagens futuras
    groupList.forEach(g => {
      (g.participants || []).forEach(p => {
        if (!p.id || !p.lid) return;
        const phoneJid = isLidJid(p.id) ? p.lid : p.id;
        const lidJid   = isLidJid(p.id) ? p.id  : p.lid;
        if (isLidJid(phoneJid) || !isLidJid(lidJid)) return;
        const existing = t.contacts.find(c => c.id === phoneJid);
        if (existing) { existing.lid = lidJid; }
        else { t.contacts.push({ id: phoneJid, lid: lidJid, name: p.name || p.notify || '' }); }
      });
    });
    t.groups = groupList.map(g => ({ id: g.id, name: g.subject || g.id })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { console.error(`[${t.clientId}] Erro ao carregar grupos:`, e.message); }
  return t.groups;
}

async function syncGroupsIntoChat(t) {
  const groups = await refreshGroups(t);
  groups.forEach(group => t.db.upsertChatConversation({ contactId: group.id, contactName: group.name, text: 'Grupo sincronizado' }));
  return groups.length;
}

async function refreshContacts(t) {
  // Baileys popula contacts via evento contacts.upsert — retorna cache atual
  return t.contacts;
}

// ─── Session helpers ────────────────────────────────────────

function startSessionRestoreWindow(t, state = 'starting') {
  t.sessionRestoreState = state;
  t.sessionRestoreStartedAt = Date.now();
  t.qrCodeData = null;
}

function cleanupBrowserLocks(t) {
  // Não necessário com Baileys — sem Chromium
}

async function reconnectWebClient(t, reason) {
  if (t.isReconnectingClient) return;
  // Circuit breaker: apenas reconexões por erro contam (não 'System wake up')
  const isErrorReconnect = reason !== 'System wake up';
  if (isErrorReconnect) {
    const now = Date.now();
    if (!t._reconnectHistory) t._reconnectHistory = [];
    t._reconnectHistory = t._reconnectHistory.filter(ts => now - ts < 10 * 60 * 1000);
    t._reconnectHistory.push(now);
    if (t._reconnectHistory.length >= 2) {
      console.error(`[${t.clientId}] CIRCUIT BREAKER: ${t._reconnectHistory.length} reconexões por erro em <10min (${reason}). Encerrando processo — PM2 reinicia limpo.`);
      setTimeout(() => process.exit(1), 500);
      return;
    }
  }
  t.isReconnectingClient = true;
  t.isReady = false;
  t.sessionRestoreState = 'restoring_session';
  t.groups = [];
  console.warn(`[${t.clientId}] Reconectando: ${reason}`);
  if (t.waClient) {
    try { t.waClient.end(new Error('reconnect')); } catch {}
    t.waClient = null;
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  try {
    await initBaileysClient(t);
  } catch (error) {
    setTimeout(() => { if (!t.isReady && !t.waClient && !t._initWebInProgress) initBaileysClient(t).catch(() => {}); }, 10000);
  } finally {
    t.isReconnectingClient = false;
  }
}

async function reconnectExtraSlot(t, slotKey) {
  const slot = EXTRA_BAILEYS_SLOTS[slotKey];
  if (!slot) return;
  const lockKey = `_reconnecting_${slotKey}`;
  if (t[lockKey]) return;
  t[lockKey] = true;
  t[slot.readyKey] = false;
  console.warn(`[${t.clientId}][${slotKey}] Reconectando sessão surda...`);
  if (t[slot.clientKey]) {
    try { t[slot.clientKey].end(new Error('deaf-reconnect')); } catch {}
    t[slot.clientKey] = null;
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  try {
    await initExtraBaileysClient(t, slotKey);
  } catch {
    setTimeout(() => initExtraBaileysClient(t, slotKey).catch(() => {}), 10000);
  } finally {
    t[lockKey] = false;
  }
}

function checkDeafSessions(t) {
  const now = Date.now();
  // Slot 'web' (1:1) excluído: keepalive de 30s já garante a saúde dessa conexão.
  // Reconexão forçada por "surdez" estava matando a sessão sem necessidade.
  const slots = [
    ...Object.entries(EXTRA_BAILEYS_SLOTS).map(([key, slot]) => ({
      name: key, readyKey: slot.readyKey, clientKey: slot.clientKey,
      lastReadyAt: t[`lastReadyAt_${key}`],
    })),
  ];
  for (const slot of slots) {
    if (!t[slot.readyKey] || !t[slot.clientKey]) continue;
    if (!slot.lastReadyAt || (now - slot.lastReadyAt) < DEAF_SESSION_TIMEOUT_MS) continue;
    const lastInbound = t[`lastInboundAt_${slot.name}`];
    if (!lastInbound || (now - lastInbound) > DEAF_SESSION_TIMEOUT_MS) {
      const stale = lastInbound ? `${Math.round((now - lastInbound) / 60000)}min` : 'nunca';
      console.warn(`[${t.clientId}][${slot.name}] Sessão surda detectada (${stale} sem inbound). Reconectando...`);
      // Reseta timestamp agora para evitar re-trigger no próximo ciclo (2min)
      t[`lastInboundAt_${slot.name}`] = now;
      if (slot.name === 'web') {
        reconnectWebClient(t, 'sessão surda detectada').catch(() => {});
      } else {
        reconnectExtraSlot(t, slot.name).catch(() => {});
      }
    }
  }
}

function startDeafSessionMonitor(t) {
  if (t._deafSessionInterval) clearInterval(t._deafSessionInterval);
  t._deafSessionInterval = setInterval(() => checkDeafSessions(t), DEAF_CHECK_INTERVAL_MS);
}

function waitForWebClientReady(t, timeoutMs = 45000) {
  if (t.isReady) return Promise.resolve(true);
  return new Promise(resolve => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (t.isReady) { clearInterval(id); resolve(true); return; }
      if (Date.now() - startedAt >= timeoutMs) { clearInterval(id); resolve(false); }
    }, 1000);
  });
}

// ─── Test Chat (in-memory, sem DB) ──────────────────────────

const _testChatState = new Map(); // clientId → { convs: Map<jid, entry[]>, sseClients: Set }

function getTestChatTenantState(clientId) {
  if (!_testChatState.has(clientId)) _testChatState.set(clientId, { convs: new Map(), sseClients: new Set() });
  return _testChatState.get(clientId);
}

function pushTestChatEntry(clientId, entry) {
  const state = getTestChatTenantState(clientId);
  if (!state.convs.has(entry.jid)) state.convs.set(entry.jid, []);
  const buf = state.convs.get(entry.jid);
  buf.push(entry);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  for (const res of state.sseClients) { try { res.write(payload); } catch {} }
}

// Chamado de dentro dos handlers messages.upsert de cada socket
function testChatHandleMsg(t, msg, connId) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const fromMe = msg.key.fromMe;
  const text = extractBaileysText(msg);
  const senderName = fromMe ? 'Eu'
    : (msg.pushName || jid.replace('@s.whatsapp.net', '').replace('@g.us', ''));
  pushTestChatEntry(t.clientId, {
    id: msg.key.id || String(Date.now()),
    jid,
    fromMe,
    senderName,
    text: text || (msg.message.imageMessage ? '[imagem]' : msg.message.videoMessage ? '[vídeo]' : msg.message.audioMessage ? '[áudio]' : msg.message.documentMessage ? '[arquivo]' : '[mídia]'),
    ts: (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
    connId,
  });
}

// ─── Status payload ─────────────────────────────────────────

function isCloudConfigured(t) {
  return Boolean(t.WA_PHONE_NUMBER_ID && t.WA_ACCESS_TOKEN && t.WA_VERIFY_TOKEN);
}

function hasBaileysAuthSession(authDir) {
  return fs.existsSync(path.join(authDir, 'creds.json'));
}

function clearBadMacSessions(authDir, clientId) {
  try {
    const files = fs.readdirSync(authDir);
    let n = 0;
    for (const f of files) {
      if (f.startsWith('session-') || f.startsWith('sender-key-')) {
        try { fs.unlinkSync(path.join(authDir, f)); n++; } catch {}
      }
    }
    console.log(`[${clientId}] Bad MAC auto-recovery: ${n} session files removidos, creds preservadas`);
  } catch (e) {
    console.error(`[${clientId}] Erro ao limpar sessions: ${e.message}`);
  }
}

// Detector de Bad MAC: intercepta console.error do libsignal e, após 10 ocorrências
// em 2 minutos, limpa as sessions e reconecta sem apagar creds (sem novo QR).
let _badMacCount = 0;
let _badMacTimer = null;
const _origConsoleError = console.error.bind(console);
console.error = function (...args) {
  const msg = args.map(a => String(a ?? '')).join(' ');
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt message with any known session')) {
    _badMacCount++;
    clearTimeout(_badMacTimer);
    _badMacTimer = setTimeout(() => { _badMacCount = 0; }, 300_000);
    if (_badMacCount >= 50) {
      _badMacCount = 0;
      clearTimeout(_badMacTimer);
      for (const t of tenants.values()) {
        if (t.waClient || t._initWebInProgress || t.isReady) {
          const authDir = path.join(BAILEYS_AUTH_BASE, t.clientId);
          clearBadMacSessions(authDir, t.clientId);
          reconnectWebClient(t, 'bad-mac-auto-recovery').catch(() => {});
          break;
        }
      }
    }
  }
  _origConsoleError(...args);
};

function getGroupAuthDir(t) {
  const currentDir = path.join(BAILEYS_AUTH_BASE, t.clientId + '_groups');
  const legacyDir = path.join(LEGACY_BAILEYS_AUTH_BASE, t.clientId + '_groups');
  if (!hasBaileysAuthSession(currentDir) && hasBaileysAuthSession(legacyDir)) return legacyDir;
  return currentDir;
}

function ensureGroupClient(t, reason = 'ensureGroupClient') {
  if (t.waGroupClient || t.isGroupReady) return;
  const authDir = getGroupAuthDir(t);
  if (!hasBaileysAuthSession(authDir)) return;
  console.log(`[${t.clientId}][grupos] Sessao encontrada — reconectando (${reason})...`);
  initGroupBaileysClient(t).catch(err => console.error(`[${t.clientId}][grupos] Erro ao iniciar:`, err.message));
}

function missingCloudFields(t) {
  const m = [];
  if (!t.WA_PHONE_NUMBER_ID) m.push('WA_PHONE_NUMBER_ID');
  if (!t.WA_ACCESS_TOKEN) m.push('WA_ACCESS_TOKEN');
  if (!t.WA_VERIFY_TOKEN) m.push('WA_VERIFY_TOKEN');
  return m;
}

function cloudSlotKeys(slot = '1') {
  const n = Math.max(1, Math.min(5, Number(slot) || 1));
  const suffix = n === 1 ? '' : `_${n}`;
  return { slot: String(n), connectionId: `cloud${n}`, token: `WA_ACCESS_TOKEN${suffix}`, phone: `WA_PHONE_NUMBER_ID${suffix}`, display: `WA_DISPLAY_PHONE_NUMBER${suffix}`, waba: `WA_WABA_ID${suffix}` };
}
function getCloudSlot(t, slot = '1') {
  const k = cloudSlotKeys(slot);
  return { ...k, accessToken: t[k.token] || '', phoneNumberId: t[k.phone] || '', displayPhone: t[k.display] || '', wabaId: t[k.waba] || '' };
}
function getCloudSlotByConnection(t, connectionId = 'cloud1') {
  const match = String(connectionId || '').match(/^cloud([1-5])$/);
  return getCloudSlot(t, match ? match[1] : '1');
}
// Formata contato(s) compartilhado(s) da Cloud API (type=contacts) em texto legível.
function cloudContactsToText(contacts) {
  const arr = Array.isArray(contacts) ? contacts : [];
  const parts = arr.map(c => {
    const nm = (c && c.name && (c.name.formatted_name || [c.name.first_name, c.name.last_name].filter(Boolean).join(' '))) || 'Contato';
    const phones = (c && Array.isArray(c.phones) ? c.phones : []).map(pp => pp && (pp.phone || pp.wa_id)).filter(Boolean);
    return '\uD83D\uDC64 ' + nm + (phones.length ? '\n\uD83D\uDCDE ' + phones.join('\n\uD83D\uDCDE ') : '');
  }).filter(Boolean);
  return parts.join('\n\n') || '\uD83D\uDC64 Contato compartilhado';
}
// Rede de seguranca: varre o payload de um tipo desconhecido atras de qualquer
// texto/titulo/legenda, pra nenhuma mensagem virar um '[mensagem]' vazio no chat.
function deepFindMessageText(node, depth) {
  depth = depth || 0;
  if (node == null || depth > 4) return '';
  if (typeof node === 'string') { const v = node.trim(); return (v && v.length <= 900) ? v : ''; }
  if (typeof node !== 'object') return '';
  const KEYS = ['text', 'body', 'caption', 'title', 'name', 'formatted_name', 'description', 'payload', 'emoji'];
  for (const k of KEYS) {
    const v = node[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 900);
    if (v && typeof v === 'object') { const inner = deepFindMessageText(v, depth + 1); if (inner) return inner; }
  }
  for (const k of Object.keys(node)) {
    if (KEYS.indexOf(k) !== -1) continue;
    const v = node[k];
    if (v && typeof v === 'object') { const inner = deepFindMessageText(v, depth + 1); if (inner) return inner; }
  }
  return '';
}
function findCloudConnectionByPhoneId(t, phoneNumberId) {
  for (let n = 1; n <= 5; n++) { const c = getCloudSlot(t, n); if (c.phoneNumberId && c.phoneNumberId === phoneNumberId) return c; }
  return null;
}
function saveCloudSlot(t, slot, values) {
  const k = cloudSlotKeys(slot);
  const fields = { [k.token]: values.accessToken || '', [k.phone]: values.phoneNumberId || '', [k.waba]: values.wabaId || '', [k.display]: values.displayPhone || '' };
  t.db.updateConfig(fields); Object.assign(t, fields); return getCloudSlot(t, slot);
}

function getConnectionsPayload(t) {
  return {
    web: { type: 'baileys', connected: t.isReady, bootState: t.sessionRestoreState, qr: t.qrCodeData, pairingCode: t.latestPairingCode, phone: t.connectedPhone || '' },
    cloud1: { type: 'cloud', connected: !!(t.WA_PHONE_NUMBER_ID && t.WA_ACCESS_TOKEN), phoneNumberId: t.WA_PHONE_NUMBER_ID || '', displayPhone: t.WA_DISPLAY_PHONE_NUMBER || '', wabaId: t.WA_WABA_ID || '' },
    cloud2: { type: 'cloud', connected: !!(t.WA_PHONE_NUMBER_ID_2 && t.WA_ACCESS_TOKEN_2), phoneNumberId: t.WA_PHONE_NUMBER_ID_2 || '', displayPhone: t.WA_DISPLAY_PHONE_NUMBER_2 || '', wabaId: t.WA_WABA_ID_2 || '' },
    cloud3: { type: 'cloud', connected: !!(t.WA_PHONE_NUMBER_ID_3 && t.WA_ACCESS_TOKEN_3), phoneNumberId: t.WA_PHONE_NUMBER_ID_3 || '', displayPhone: t.WA_DISPLAY_PHONE_NUMBER_3 || '', wabaId: t.WA_WABA_ID_3 || '' },
    cloud4: { type: 'cloud', connected: !!(t.WA_PHONE_NUMBER_ID_4 && t.WA_ACCESS_TOKEN_4), phoneNumberId: t.WA_PHONE_NUMBER_ID_4 || '', displayPhone: t.WA_DISPLAY_PHONE_NUMBER_4 || '', wabaId: t.WA_WABA_ID_4 || '' },
    cloud5: { type: 'cloud', connected: !!(t.WA_PHONE_NUMBER_ID_5 && t.WA_ACCESS_TOKEN_5), phoneNumberId: t.WA_PHONE_NUMBER_ID_5 || '', displayPhone: t.WA_DISPLAY_PHONE_NUMBER_5 || '', wabaId: t.WA_WABA_ID_5 || '' },
    groups: { type: 'baileys', connected: t.isGroupReady, bootState: t.groupSessionState, qr: t.groupQrCode, pairingCode: t.groupPairingCode, phone: t.connectedPhoneGroups || '' },
    web2: { type: 'baileys', connected: t.isReady2, bootState: t.sessionState2, qr: t.qrCode2, pairingCode: t.pairingCode2, phone: t['connectedPhone_web2'] || '' },
    web3: { type: 'baileys', connected: t.isReady3, bootState: t.sessionState3, qr: t.qrCode3, pairingCode: t.pairingCode3, phone: t['connectedPhone_web3'] || '' },
    // Lite (Evolution): 'down' = watchdog/webhook detectou queda → mostra aviso de reconexão
    lite: liteEnabled(t)
      ? { type: 'lite', enabled: true, connected: t._liteConnected !== false, down: (t._liteConnected === false) || (t._lite2Connected === false) }
      : { type: 'lite', enabled: false },
  };
}

function getStatusPayload(t) {
  const connections = getConnectionsPayload(t);
  const anyQrConnected = !!(t.isReady || t.isReady2 || t.isReady3 || t.isGroupReady);
  const anyCloudConfigured = [1, 2, 3, 4, 5].some(n => connections[`cloud${n}`]?.connected);
  const anyConnected = anyQrConnected || anyCloudConfigured;
  if (t.provider === 'cloud') {
    const configured = isCloudConfigured(t);
    return { provider: 'cloud', providerOptions: ['web', 'cloud'], connected: anyConnected, qr: t.qrCodeData, pairingCode: t.latestPairingCode, bootState: configured ? 'ready' : (anyQrConnected ? 'ready' : 'config_missing'), bootMessage: configured ? 'Cloud API configurada.' : (anyQrConnected ? 'QR Code conectado.' : 'Cloud API aguardando configuracao.'), supportsInteractiveButtons: true, requiresWebhook: true, recipientMode: 'chat-search', configMissing: configured ? [] : missingCloudFields(t), cloudPhoneNumberId: t.WA_PHONE_NUMBER_ID || '', cloudDisplayPhoneNumber: t.WA_DISPLAY_PHONE_NUMBER || '', connectedPhone: t.connectedPhone || '', queueLength: t.pendingQueue.length, dispatchIntervalSeconds: DISPATCH_INTERVAL_MS / 1000, connections };
  }
  if (!t.waClient) {
    return { provider: 'web', providerOptions: ['web', 'cloud'], connected: anyConnected, qr: null, bootState: anyConnected ? 'ready' : 'idle', bootMessage: anyConnected ? 'WhatsApp conectado.' : 'Clique em "Conectar" para iniciar o WhatsApp.', supportsInteractiveButtons: false, requiresWebhook: false, recipientMode: 'chat-search', configMissing: [], queueLength: t.pendingQueue.length, dispatchIntervalSeconds: DISPATCH_INTERVAL_MS / 1000, connections };
  }
  const bootState = t.isReady ? 'ready' : (t.latestPairingCode ? 'awaiting_pair_code' : (t.qrCodeData ? 'awaiting_qr' : t.sessionRestoreState));
  const bootMessage = t.isReady ? 'WhatsApp Web conectado.' : (t.latestPairingCode ? 'Digite o código no WhatsApp.' : (t.qrCodeData ? 'QR Code pronto para leitura.' : (t.sessionRestoreState === 'restoring_session' ? 'Tentando restaurar sessao salva...' : 'Conectando...')));
  return { provider: 'web', providerOptions: ['web', 'cloud'], connected: anyConnected, connectedPhone: t.connectedPhone || '', qr: t.qrCodeData, pairingCode: t.latestPairingCode, bootState: anyConnected ? 'ready' : bootState, bootMessage: anyConnected ? 'WhatsApp conectado.' : bootMessage, supportsInteractiveButtons: false, requiresWebhook: false, recipientMode: 'chat-search', configMissing: [], queueLength: t.pendingQueue.length, dispatchIntervalSeconds: DISPATCH_INTERVAL_MS / 1000, connections };
}

// ─── Message sending ────────────────────────────────────────

function buildFallbackMessage(message, quickReplies) {
  if (!quickReplies || quickReplies.length === 0) return message;
  const emojis = ['1️⃣', '2️⃣', '3️⃣'];
  return `${message}\n\nResponda com:\n${quickReplies.map((r, i) => `${emojis[i] || '▶️'} ${r}`).join('\n')}`;
}

function normalizeQuickReplies(qr) {
  if (!Array.isArray(qr)) return [];
  return qr.map(i => String(i || '').trim()).filter(Boolean).slice(0, 3);
}

function normalizePhoneNumber(v) { return String(v || '').replace(/[^\d]/g, ''); }

function guessMimeType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function graphRequestWithToken(accessToken, endpoint, { method = 'GET', json, formData } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${accessToken}` } };
  if (json) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
  else if (formData) { init.body = formData; }
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}${endpoint}`, init);
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    // A Meta manda o motivo de verdade em error_user_msg/error_data.details — o campo
    // "message" sozinho costuma ser só o nome genérico do erro (ex: "Invalid parameter"),
    // sem dizer QUAL parâmetro nem por quê.
    const err = body?.error || {};
    const detail = err.error_user_msg || err.error_data?.details || '';
    const parts = [err.error_user_title, err.message, detail].filter(Boolean);
    throw new Error(parts.length ? parts.join(' — ') : (body?.raw || `Erro HTTP ${response.status}`));
  }
  return body;
}

async function graphRequest(t, endpoint, opts = {}) {
  return graphRequestWithToken(t.WA_ACCESS_TOKEN, endpoint, opts);
}

function getTemplateCloudCreds(t, slot = '1') {
  const c = getCloudSlot(t, slot);
  return { slot: c.slot, accessToken: c.accessToken, wabaId: c.wabaId, displayPhone: c.displayPhone };
}

function buildMetaTemplatePayload(body = {}) {
  const name = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const category = String(body.category || 'UTILITY').trim().toUpperCase();
  const language = String(body.language || 'pt_BR').trim() || 'pt_BR';
  const bodyText = String(body.body || '').trim();
  const headerText = String(body.header || '').trim();
  const footerText = String(body.footer || '').trim();
  const buttons = String(body.buttons || '').split('\n').map(v => v.trim()).filter(Boolean).slice(0, 3);
  const samples = String(body.samples || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!name) throw new Error('Nome do modelo obrigatório. Use letras minúsculas, números e _.');
  if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(category)) throw new Error('Categoria inválida.');
  if (!bodyText) throw new Error('Texto da mensagem obrigatório.');
  const components = [];
  if (headerText) components.push({ type: 'HEADER', format: 'TEXT', text: headerText });
  const bodyComponent = { type: 'BODY', text: bodyText };
  if (/\{\{\d+\}\}/.test(bodyText)) bodyComponent.example = { body_text: [samples.length ? samples : ['exemplo']] };
  components.push(bodyComponent);
  if (footerText) components.push({ type: 'FOOTER', text: footerText });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map(text => ({ type: 'QUICK_REPLY', text })) });
  return { name, language, category, components };
}

// Formata a resposta de um WhatsApp Flow (nfm_reply) como texto legível.
// response_json vem achatado, ex: {"Nome":"Fulano","Cidade":"Bento Gonçalves"}.
function formatFlowReply(nfm) {
  if (!nfm) return '';
  let data = {};
  try { data = JSON.parse(nfm.response_json || '{}'); } catch (e) {}
  const lines = Object.entries(data)
    .filter(([k]) => k && k !== 'flow_token')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  const title = (nfm.name && nfm.name !== 'flow') ? nfm.name : '';
  return [title, ...lines].filter(Boolean).join('\n');
}

// Traduz o erro de entrega da Cloud API (webhook de status) para um texto claro em PT-BR.
function describeCloudSendError(err) {
  if (!err) return 'Falha no envio';
  const code = err.code;
  const detail = err.error_data?.details || '';
  const MAP = {
    131031: 'Conta/conversa restrita pela Meta. Costuma ser bloqueio temporário por muitas mensagens iguais em pouco tempo, ou por política. Aguarde e evite reenviar em sequência.',
    131030: 'Número do destinatário não está na lista permitida (app em modo de teste na Meta) ou número inválido.',
    131047: 'Fora da janela de 24h. Só é possível enviar mensagem livre se o cliente te respondeu nas últimas 24h; senão, precisa de um modelo (template) aprovado.',
    131026: 'Mensagem não pôde ser entregue. O destinatário pode não ter WhatsApp, ter bloqueado seu número, ou não aceitar mensagens de empresas.',
    131049: 'A Meta limitou o envio deste tipo de mensagem de marketing para manter a saúde do ecossistema.',
    130472: 'Não entregue: o número do destinatário faz parte de um experimento da Meta.',
    131051: 'Tipo de mensagem não suportado.',
    132000: 'Modelo (template) com número de parâmetros incorreto.',
    100:    'Parâmetro inválido no envio.',
  };
  const friendly = MAP[code];
  if (friendly) return `[${code}] ${friendly}`;
  const base = err.title || err.message || 'Falha no envio';
  return code ? `[${code}] ${base}${detail ? ' — ' + detail : ''}` : base;
}

async function sendCloudText(t, to, message, connectionId = 'cloud1') {
  const cloud = getCloudSlotByConnection(t, connectionId);
  if (!cloud.phoneNumberId || !cloud.accessToken) throw new Error(`${connectionId} não está configurada.`);
  return graphRequestWithToken(cloud.accessToken, `/${cloud.phoneNumberId}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: message } } });
}

// ============ Auto Atendimento (funil de conversa por passos) ============
function getAutoAtendimento(t) {
  const a = (t.db.getConfig() || {}).autoAtendimento || {};
  let funnels = Array.isArray(a.funnels) ? a.funnels : [];
  const rules = Array.isArray(a.rules) ? a.rules : [];
  // Compat: config antiga só com "rules" vira funis de 1 passo acionados por palavra-chave
  if (!funnels.length && rules.length) {
    funnels = rules.map((r, i) => ({ id: r.id || ('lf' + i), name: r.name || ('Regra ' + (i + 1)), enabled: r.enabled !== false, trigger: { keywords: r.keywords || [], onFirstMessage: false }, steps: [{ id: 's0', text: r.response || '', status: r.status || '', handoff: !!r.handoff }] }));
  }
  return { enabled: !!a.enabled, typingDelaySec: Math.max(0, Math.min(30, Number(a.typingDelaySec) != null ? Number(a.typingDelaySec) : 3)), funnels };
}
function _normTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function _kwMatch(keywords, text) {
  const n = _normTxt(text); if (!n) return false;
  const kws = (Array.isArray(keywords) ? keywords : String(keywords || '').split(',')).map(_normTxt).filter(Boolean);
  return kws.length ? kws.some(k => n.includes(k)) : false;
}
const AUTO_STATUS_LABEL = { quente: 'Quente', morno: 'Morno', frio: 'Frio' };
const LBL_BOT = 'Atendimento Bot';
const LBL_HUMAN = 'Atender';
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Um funil só pode ser INICIADO se a mensagem do lead casar com alguma palavra-chave do gatilho.
// Não existe mais disparo "por ser a primeira mensagem" — isso causava falsos positivos em
// contatos antigos (ex: um contato já conhecido manda "bom dia" e o funil de boas-vindas disparava).
function pickFunnelToStart(funnels, text, isFirstMessage) {
  for (const f of funnels) { if (f && f.enabled !== false && Array.isArray(f.steps) && f.steps.length && _kwMatch(f.trigger && f.trigger.keywords, text)) return f; }
  if (isFirstMessage) { for (const f of funnels) { if (f && f.enabled !== false && f.trigger && f.trigger.onFirstMessage && Array.isArray(f.steps) && f.steps.length) return f; } }
  return null;
}

// Resolve o próximo passo a partir do passo atual + a resposta do lead.
// Passo com opções: casa a resposta com o texto-gatilho de cada opção (a opção sem gatilho é o "senão").
// Passo sem opções: segue linearmente para o próximo item do array (compatibilidade com funil simples).
function resolveNextStep(steps, currentStep, replyText) {
  const opts = Array.isArray(currentStep.options) ? currentStep.options.filter(o => o && o.nextStepId) : [];
  if (opts.length) {
    const byId = (id) => steps.find(s => s.id === id) || null;
    const nr = _normTxt(replyText);
    // 1) Botão numerado (Lite/QR): "1", "2"... → N-ésima opção com rótulo
    const labeled = opts.filter(o => o.label);
    const numMatch = String(replyText || '').trim().match(/^\(?\s*([1-9])\b/);
    if (numMatch && labeled[Number(numMatch[1]) - 1]) return byId(labeled[Number(numMatch[1]) - 1].nextStepId);
    // 2) Clique de botão (Cloud) ou texto = rótulo exato
    for (const o of opts) { if (o.label && nr && nr === _normTxt(o.label)) return byId(o.nextStepId); }
    // 3) Palavras-chave
    for (const o of opts) { if (o.keywords && o.keywords.length && _kwMatch(o.keywords, replyText)) return byId(o.nextStepId); }
    const wildcard = opts.find(o => !o.keywords || !o.keywords.length);
    if (wildcard) return byId(wildcard.nextStepId);
    return { retry: true, step: currentStep }; // nada casou e não há "senão" — repete a pergunta
  }
  const idx = steps.findIndex(s => s.id === currentStep.id);
  return steps[idx + 1] || null;
}

// Randomizador: se o passo for do tipo "randomizer", sorteia um caminho por peso e
// continua até chegar num passo de mensagem (com limite anti-loop).
function resolvePlayableStep(steps, step, guard) {
  guard = guard || 0;
  if (!step || guard > 12) return step || null;
  if (step.type === 'randomizer') {
    const opts = (step.options || []).filter(o => o && o.nextStepId);
    if (!opts.length) return null;
    const total = opts.reduce((s, o) => s + (Number(o.weight) > 0 ? Number(o.weight) : 1), 0);
    let r = Math.random() * total; let chosen = opts[opts.length - 1];
    for (const o of opts) { r -= (Number(o.weight) > 0 ? Number(o.weight) : 1); if (r <= 0) { chosen = o; break; } }
    return resolvePlayableStep(steps, steps.find(s => s.id === chosen.nextStepId), guard + 1);
  }
  return step;
}
function followupMs(fu) {
  const v = Math.max(1, Number(fu.afterValue) || 1);
  const u = fu.afterUnit === 'day' ? 86400000 : fu.afterUnit === 'hour' ? 3600000 : 60000;
  return v * u;
}

async function sendAutoReplyText(t, storageJid, digits, text, connectionId, senderName) {
  const conn = connectionId || 'web';
  // Guardamos o id da mensagem pra que o recibo de entrega/leitura consiga achá-la
  // depois. Antes a resposta do Graph era descartada e a mensagem do Bot ficava
  // sem status pra sempre. Só o cloud precisava disso: lite e Baileys já pegavam o
  // id pro botMarkSent (que evita o bot se pausar com o próprio eco — no cloud não
  // existe esse eco no socket, por isso ali não se chama botMarkSent).
  let _wamid = null;
  if (conn.startsWith('cloud')) {
    const cloud = getCloudSlotByConnection(t, conn);
    const pnid = cloud.phoneNumberId;
    const tok = cloud.accessToken;
    if (!pnid || !tok) throw new Error('Cloud API nao configurada');
    const _resp = await graphRequestWithToken(tok, `/${pnid}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, type: 'text', text: { preview_url: false, body: text } } });
    _wamid = _resp?.messages?.[0]?.id || null;
  } else if (conn === 'lite' || conn === 'lite2') {
    const r = await evoReq('POST', `/message/sendText/${liteInstanceName(t, conn === 'lite2' ? '2' : '1')}`, { number: digits, text });
    if (!r || !r.ok) throw new Error('WhatsApp Lite falhou');
    _wamid = liteWamid(r.json);
    botMarkSent(t, _wamid);
  } else {
    const { sock, ready } = resolveBaileysConnection(t, conn);
    if (!ready || !sock) throw new Error('WhatsApp ' + conn + ' nao conectado');
    const _env = await sock.sendMessage(storageJid, { text });
    _wamid = (_env && _env.key && _env.key.id) || null;
    botMarkSent(t, _wamid);
  }
  t.db.recordMessage({ direction: 'out', contactId: storageJid, contactName: senderName || 'Bot', text, connectionId: conn, wamid: _wamid, deliveryStatus: _wamid ? 'sent' : null });
}

// Mostra "digitando..." para o lead (melhor esforço por canal)
async function sendTypingPresence(t, storageJid, digits, connectionId, inboundMsgId, holdMs) {
  try {
    const conn = connectionId || 'web';
    if (conn === 'lite' || conn === 'lite2') {
      await evoReq('POST', `/chat/sendPresence/${liteInstanceName(t, conn === 'lite2' ? '2' : '1')}`, { number: digits, presence: 'composing', delay: Math.max(1000, Math.min(15000, holdMs || 2000)) });
    } else if (conn.startsWith('cloud')) {
      if (inboundMsgId) {
        const cloud = getCloudSlotByConnection(t, conn);
        const pnid = cloud.phoneNumberId;
        const tok = cloud.accessToken;
        if (pnid && tok) await graphRequestWithToken(tok, `/${pnid}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', status: 'read', message_id: inboundMsgId, typing_indicator: { type: 'text' } } });
      }
    } else {
      const { sock, ready } = resolveBaileysConnection(t, conn);
      if (ready && sock) { try { await sock.sendPresenceUpdate('composing', storageJid); } catch (e) {} }
    }
  } catch (e) { /* melhor esforço */ }
}
async function stopTypingPresence(t, storageJid, connectionId) {
  try {
    const conn = connectionId || 'web';
    if (!conn.startsWith('cloud') && conn !== 'lite' && conn !== 'lite2') {
      const { sock, ready } = resolveBaileysConnection(t, conn);
      if (ready && sock) { try { await sock.sendPresenceUpdate('paused', storageJid); } catch (e) {} }
    }
  } catch (e) {}
}
async function sendWithTyping(t, storageJid, digits, text, connectionId, delaySec, inboundMsgId, senderName) {
  const ms = Math.max(0, Math.min(30, Number(delaySec) || 0)) * 1000;
  if (ms > 0) { await sendTypingPresence(t, storageJid, digits, connectionId, inboundMsgId, ms); await _sleep(ms); }
  await sendAutoReplyText(t, storageJid, digits, text, connectionId, senderName);
  await stopTypingPresence(t, storageJid, connectionId);
}

// Avalia a mensagem do lead e avança o funil de conversa (com ramificação por opções)
async function maybeAutoRespond(t, { storageJid, digits, text, connectionId, inboundMsgId, firstMessage }) {
  try {
    if (!text || !storageJid || String(storageJid).endsWith('@g.us')) return;
    const cfg = getAutoAtendimento(t);
    if (!cfg.enabled || !cfg.funnels.length) return;
    const st = t.db.getContactBotState(storageJid);
    if (st.botPaused) return;

    let funnel = null, steps = [], step = null;
    if (st.botFunnel && st.botStepId) {
      funnel = cfg.funnels.find(f => f.id === st.botFunnel && f.enabled !== false);
      steps = funnel ? (Array.isArray(funnel.steps) ? funnel.steps : []) : [];
      const currentStep = steps.find(s => s.id === st.botStepId);
      if (funnel && currentStep) {
        const resolved = resolveNextStep(steps, currentStep, text);
        if (resolved && resolved.retry) { step = resolved.step; }
        else if (resolved) { step = resolved; }
        else { step = null; }
      } else { funnel = null; }
    }
    if (!funnel) {
      funnel = pickFunnelToStart(cfg.funnels, text, firstMessage);
      if (!funnel) return;
      steps = Array.isArray(funnel.steps) ? funnel.steps : [];
      step = steps[0] || null;
    }
    step = resolvePlayableStep(steps, step); // resolve randomizadores até um passo de mensagem
    await playStep(t, { storageJid, digits, connectionId, inboundMsgId }, cfg, funnel, steps, step);
  } catch (e) { console.log(`[${t.clientId}][auto-atendimento] erro:`, e.message); }
}

// Envia botões clicáveis via Cloud API (interactive). Retorna true se enviou.
async function sendCloudButtons(t, storageJid, digits, text, labels, connectionId) {
  const conn = connectionId || '';
  if (!conn.startsWith('cloud')) return false;
  const cloud = getCloudSlotByConnection(t, conn);
  const pnid = cloud.phoneNumberId;
  const tok = cloud.accessToken;
  if (!pnid || !tok) return false;
  const buttons = labels.slice(0, 3).map((l, i) => ({ type: 'reply', reply: { id: 'b' + i, title: String(l).slice(0, 20) } }));
  const _resp = await graphRequestWithToken(tok, `/${pnid}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, type: 'interactive', interactive: { type: 'button', body: { text: text || ' ' }, action: { buttons } } } });
  const _wamid = _resp?.messages?.[0]?.id || null;
  t.db.recordMessage({ direction: 'out', contactId: storageJid, contactName: 'Bot', text, connectionId: conn, wamid: _wamid, deliveryStatus: _wamid ? 'sent' : null });
  return true;
}

// Envia um passo, aplica status, arma follow-up (se configurado) ou faz handoff
function isBusinessHours(t) {
  try {
    const bh = (t.db.getConfig() || {}).businessHours;
    if (!bh || !bh.enabled) return true;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: bh.tz || 'America/Sao_Paulo' }));
    const days = Array.isArray(bh.days) && bh.days.length ? bh.days.map(Number) : [1, 2, 3, 4, 5];
    if (!days.includes(now.getDay())) return false;
    const mins = now.getHours() * 60 + now.getMinutes();
    const sp = String(bh.start || '08:00').split(':').map(Number);
    const ep = String(bh.end || '19:00').split(':').map(Number);
    return mins >= (sp[0] * 60 + (sp[1] || 0)) && mins < (ep[0] * 60 + (ep[1] || 0));
  } catch (e) { return true; }
}
async function playStep(t, ctx, cfg, funnel, steps, step) {
  const { storageJid, digits, connectionId, inboundMsgId } = ctx;
  if (!step) { doHandoff(t, storageJid, digits, funnel, 'Fim do funil: ' + (funnel.name || '')); return; }
  const baseText = String(step.text || '').trim();
  const btnOpts = (step.showButtons && Array.isArray(step.options)) ? step.options.filter(o => o && o.label && o.nextStepId) : [];
  if (btnOpts.length) {
    if ((connectionId || '').startsWith('cloud') && btnOpts.length <= 3) {
      // API Oficial: botões clicáveis de verdade
      const ms = Math.max(0, Math.min(30, Number(cfg.typingDelaySec) || 0)) * 1000;
      if (ms > 0) { await sendTypingPresence(t, storageJid, digits, connectionId, inboundMsgId, ms); await _sleep(ms); }
      const ok = await sendCloudButtons(t, storageJid, digits, baseText, btnOpts.map(o => o.label), connectionId).catch(() => false);
      if (!ok && baseText) await sendWithTyping(t, storageJid, digits, baseText + '\n\n' + btnOpts.map((o, i) => `*${i + 1}* - ${o.label}`).join('\n'), connectionId, 0, inboundMsgId);
    } else {
      // Lite/QR (ou +3 botões): menu numerado no texto
      const menu = btnOpts.map((o, i) => `*${i + 1}* - ${o.label}`).join('\n');
      await sendWithTyping(t, storageJid, digits, (baseText ? baseText + '\n\n' : '') + menu, connectionId, cfg.typingDelaySec, inboundMsgId);
    }
  } else if (baseText) {
    await sendWithTyping(t, storageJid, digits, baseText, connectionId, cfg.typingDelaySec, inboundMsgId);
  }
  if (step.text2 || step.text2Off) {
    await _sleep(Math.max(0, Math.min(20, Number(step.gapSec) || 3)) * 1000);
    const _t2 = isBusinessHours(t) ? String(step.text2 || '').trim() : String(step.text2Off || step.text2 || '').trim();
    if (_t2) await sendWithTyping(t, storageJid, digits, _t2, connectionId, cfg.typingDelaySec, null);
  }
  t.db.setBotFunnelStep(storageJid, funnel.id, step.id);
  const c = findCrmCardForChat(t, digits) || findCrmCardForChat(t, storageJid);
  const tempLbl = AUTO_STATUS_LABEL[String(step.status || '').toLowerCase()];
  if (c) t.db.updateCrmCard(c.id, { label: tempLbl || LBL_BOT });

  const hasOptions = Array.isArray(step.options) && step.options.some(o => o && o.nextStepId);
  const isLast = steps.findIndex(s => s.id === step.id) >= steps.length - 1;
  if (step.handoff || (!hasOptions && isLast)) {
    doHandoff(t, storageJid, digits, funnel, step.handoffReason || ('Funil concluído: ' + (funnel.name || '')));
  } else if (step.followup && step.followup.enabled) {
    t.db.setBotWaiting(storageJid, Date.now(), connectionId || ''); // arma "se não responder"
  } else {
    t.db.setBotWaiting(storageJid, null, null); // passo espera, mas sem follow-up
  }
}
function doHandoff(t, storageJid, digits, funnel, reason) {
  t.db.setNeedsHuman(storageJid, true, reason || (funnel && funnel.name) || 'Atendimento');
  t.db.setBotPaused(storageJid, true);
  t.db.setBotWaiting(storageJid, null, null);
  const c = findCrmCardForChat(t, digits) || findCrmCardForChat(t, storageJid);
  if (c) { const _u = { label: LBL_HUMAN }; const _mv = (t.db.getConfig() || {}).crmBotMoves; if (_mv && _mv.handoff) _u.columnId = _mv.handoff; t.db.updateCrmCard(c.id, _u); t.db.markCrmCardNewMessage(c.id); }
}

// ── Scanner de follow-up: "se o cliente não responder em X, faz Y" ──
async function runFollowupScan() {
  let clientDefs = [];
  try { clientDefs = loadClients().filter(c => !c.ownerClientId); } catch (e) { return; }
  for (const clientDef of clientDefs) {
    let t; try { t = getTenant(clientDef.id); } catch (e) { continue; }
    const cfg = getAutoAtendimento(t);
    if (!cfg.enabled || !cfg.funnels.length) continue;
    let waiting; try { waiting = t.db.listWaitingContacts(); } catch (e) { continue; }
    for (const w of waiting) {
      try {
        const funnel = cfg.funnels.find(f => f.id === w.botFunnel && f.enabled !== false);
        if (!funnel) continue;
        const steps = Array.isArray(funnel.steps) ? funnel.steps : [];
        const step = steps.find(s => s.id === w.botStepId);
        const fu = step && step.followup;
        if (!fu || !fu.enabled) continue;
        if (Date.now() - (w.botWaitingSince || 0) < followupMs(fu)) continue;
        const digits = String(w.id).replace(/@.*/, '').replace(/\D/g, '');
        const conn = w.botConn || 'lite';
        if (fu.action === 'handoff') {
          doHandoff(t, w.id, digits, funnel, 'Sem resposta em ' + (fu.afterValue || 1) + ' ' + (fu.afterUnit || 'min'));
        } else if (fu.action === 'noreply') {
          const _cNr = findCrmCardForChat(t, digits) || findCrmCardForChat(t, w.id);
          const _mv = (t.db.getConfig() || {}).crmBotMoves;
          if (_cNr && _mv && _mv.noReply) t.db.updateCrmCard(_cNr.id, { columnId: _mv.noReply });
          t.db.setBotPaused(w.id, true); t.db.setBotWaiting(w.id, null, null); t.db.markFollowupDone(w.id);
        } else if (fu.action === 'goto' && fu.gotoStepId) {
          const target = resolvePlayableStep(steps, steps.find(s => s.id === fu.gotoStepId));
          t.db.markFollowupDone(w.id); // não repete este disparo
          await playStep(t, { storageJid: w.id, digits, connectionId: conn, inboundMsgId: null }, cfg, funnel, steps, target);
        } else { // 'message'
          if (fu.text && String(fu.text).trim()) await sendWithTyping(t, w.id, digits, String(fu.text).trim(), conn, cfg.typingDelaySec, null);
          t.db.markFollowupDone(w.id);
        }
      } catch (e) { console.log(`[${clientDef.id}][followup] erro:`, e.message); }
    }
  }
}
setInterval(() => { runFollowupScan().catch(() => {}); }, 60000);

// ═══════ Follow-up de LEAD por TEMPLATE (lead da planilha sem resposta em N min) ═══════
// Config por tenant: cfg.leadFollowup = { enabled, delayMin, connectionId, lang, map }
//   map = { casa, empresa, condominio, default } -> nome do template aprovado
// O card nasce com customFields.followupPending=true (setado no handleSheetsWebhook).
// A cada 60s: se passou delayMin, o lead NÃO respondeu e ainda está na janela, dispara o
// template do serviço (escolhido por tipo_imovel). Fail-safe total (try/catch por card).
function _fuNormWaId(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (!d.startsWith('55')) d = '55' + d;
  return d;
}
function _fuFirstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0] || '';
  return (/[A-Za-zÀ-ÿ]/.test(n) && !/^\d+$/.test(n)) ? n : '';
}
function _fuPickTemplate(lf, card) {
  const m = (lf && lf.map) || {};
  const tipo = String((card.customFields && card.customFields.tipo_imovel) || '').toLowerCase();
  if (/cond/.test(tipo)) return m.condominio || m.default || '';
  if (/emp|coment|loja|indust/.test(tipo)) return m.empresa || m.default || '';
  if (/casa|resid|apart|apto/.test(tipo)) return m.casa || m.default || '';
  return m.default || '';
}
function _fuLeadHasInbound(t, card) {
  try {
    const target = phoneDigitVariants(card.whatsapp || card.phone);
    if (!target.length) return false;
    const dm = (a, b) => a === b || a.endsWith(b) || b.endsWith(a);
    for (const cv of t.db.getConversations()) {
      const cd = phoneDigitVariants(String(cv.contactId || '').replace(/@.*/, ''));
      if (!cd.some(x => target.some(y => dm(x, y)))) continue;
      if (cv.direction === 'in') return true;
      const msgs = t.db.getMessages(cv.contactId);
      if (msgs.some(m => m.direction === 'in')) return true;
    }
  } catch (e) {}
  return false;
}
async function _fuSendTemplate(t, connectionId, phone, tmplName, lang, firstName) {
  const slot = connectionId || 'cloud1';
  const cloud = getCloudSlotByConnection(t, slot);
  const pnid = cloud.phoneNumberId;
  const tok = cloud.accessToken;
  if (!pnid || !tok) throw new Error('API Oficial nao configurada');
  const to = _fuNormWaId(phone);
  const template = {
    name: tmplName,
    language: { code: lang || 'pt_BR' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: firstName || 'tudo bem' }] }],
  };
  const resp = await graphRequestWithToken(tok, `/${pnid}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', to, type: 'template', template } });
  const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
  // grava no chat ao vivo como saída
  try { t.db.recordMessage({ direction: 'out', contactId: to + '@s.whatsapp.net', contactName: '', text: `[template: ${tmplName}]`, connectionId: slot, wamid: wamid || null, deliveryStatus: wamid ? 'sent' : null }); } catch (e) {}
  return wamid;
}
async function runLeadFollowupScan() {
  let clientDefs = [];
  try { clientDefs = loadClients().filter(c => !c.ownerClientId); } catch (e) { return; }
  for (const clientDef of clientDefs) {
    let t; try { t = getTenant(clientDef.id); } catch (e) { continue; }
    const lf = (t.db.getConfig() || {}).leadFollowup;
    if (!lf || !lf.enabled) continue;
    const delayMs = (Number(lf.delayMin) || 3) * 60000;
    const maxAgeMs = Math.max(delayMs + 30 * 60000, 60 * 60000); // janela: pelo menos 1h
    let cards; try { cards = t.db.getCrmCards().filter(c => c.customFields && c.customFields.followupPending); } catch (e) { continue; }
    for (const c of cards) {
      try {
        const age = Date.now() - (c.createdAt || 0);
        if (age < delayMs) continue;
        const cf = c.customFields || {};
        if (age > maxAgeMs) { t.db.updateCrmCard(c.id, { customFields: { ...cf, followupPending: false } }); continue; }
        if (_fuLeadHasInbound(t, c)) { t.db.updateCrmCard(c.id, { customFields: { ...cf, followupPending: false } }); continue; }
        const tmpl = _fuPickTemplate(lf, c);
        const phone = c.whatsapp || c.phone;
        if (!tmpl || !phone) { t.db.updateCrmCard(c.id, { customFields: { ...cf, followupPending: false } }); continue; }
        try {
          await _fuSendTemplate(t, lf.connectionId, phone, tmpl, lf.lang, _fuFirstName(c.contactName));
          logTemplateSend(t, tmpl);
          t.db.updateCrmCard(c.id, { customFields: { ...cf, followupPending: false, followupSent: Date.now(), followupTemplate: tmpl } });
          console.log(`[${clientDef.id}][lead-followup] template ${tmpl} -> ${c.contactName || phone}`);
        } catch (sendErr) {
          const tries = (cf.followupTries || 0) + 1;
          const upd = { followupTries: tries };
          if (tries >= 3) upd.followupPending = false;
          t.db.updateCrmCard(c.id, { customFields: { ...cf, ...upd } });
          console.log(`[${clientDef.id}][lead-followup] falha (${tries}/3) ${tmpl}: ${sendErr.message}`);
        }
      } catch (e) { /* por card */ }
    }
  }
}
setInterval(() => { runLeadFollowupScan().catch(() => {}); }, 60000);

// ── Revive: lead que RESPONDER estando numa coluna "morta" volta pra coluna de atendimento ──
// Config por tenant: crmReviveOnReply = { fromColumnIds:[...], toColumnId, toFunnelId }
function maybeReviveCardOnInbound(t, digitsOrJid) {
  try {
    const rule = (t.db.getConfig() || {}).crmReviveOnReply;
    if (!rule || !Array.isArray(rule.fromColumnIds) || !rule.fromColumnIds.length || !rule.toColumnId) return;
    const d = String(digitsOrJid || '').replace(/\D/g, ''); if (d.length < 8) return;
    const card = findCrmCardForChat(t, `${d}@s.whatsapp.net`) || findCrmCardForChat(t, d);
    if (!card) return;
    if (!rule.fromColumnIds.map(String).includes(String(card.columnId))) return;
    const upd = { columnId: rule.toColumnId };
    if (rule.toFunnelId) upd.funnelId = rule.toFunnelId;
    else { const col = (t.db.getCrmColumns() || []).find(c => String(c.id) === String(rule.toColumnId)); if (col && col.funnelId) upd.funnelId = col.funnelId; }
    t.db.updateCrmCard(card.id, upd);
    console.log(`[${t.clientId}] lead revivido (respondeu): ${card.contactName || d} -> ${rule.toColumnId}`);
  } catch (e) {}
}

// ── No-reply: leads numa coluna (ex.: Novo lead) cuja ÚLTIMA mensagem é de SAÍDA (robô mandou e o
// lead NÃO respondeu), mais velha que afterHours, vão pra outra coluna (ex.: Repescagem). ──
// Config por tenant: crmNoReplyMove = { columnId, toColumnId, toFunnelId, afterHours }
async function runNoReplyMoveScan() {
  let clientDefs = [];
  try { clientDefs = loadClients().filter(c => !c.ownerClientId); } catch (e) { return; }
  for (const clientDef of clientDefs) {
    let t; try { t = getTenant(clientDef.id); } catch (e) { continue; }
    const rule = (t.db.getConfig() || {}).crmNoReplyMove;
    if (!rule || !rule.columnId || !rule.toColumnId) continue;
    const afterMs = (Number(rule.afterHours) || 24) * 3600 * 1000;
    let cards; try { cards = t.db.getCrmCards().filter(c => String(c.columnId) === String(rule.columnId)); } catch (e) { continue; }
    if (!cards.length) continue;
    const last = new Map();
    try { for (const cv of t.db.getConversations()) { const d = String(cv.contactId || '').replace(/@.*/, '').replace(/\D/g, ''); if (d.length >= 8) last.set(d.slice(-8), { dir: cv.direction, at: cv.lastAt || 0 }); } } catch (e) { continue; }
    let toFunnel = rule.toFunnelId;
    if (!toFunnel) { const col = (t.db.getCrmColumns() || []).find(c => String(c.id) === String(rule.toColumnId)); toFunnel = col ? col.funnelId : undefined; }
    let moved = 0;
    for (const c of cards) {
      const d = String(c.whatsapp || c.phone || '').replace(/\D/g, ''); if (d.length < 8) continue;
      const lm = last.get(d.slice(-8));
      if (!lm || lm.dir !== 'out') continue;                 // só se o robô mandou e o lead não respondeu
      if (Date.now() - (lm.at || 0) < afterMs) continue;     // e já passou o tempo
      const upd = { columnId: rule.toColumnId }; if (toFunnel) upd.funnelId = toFunnel;
      try { t.db.updateCrmCard(c.id, upd); moved++; } catch (e) {}
    }
    if (moved) console.log(`[${clientDef.id}] no-reply move: ${moved} lead(s) ${rule.columnId} -> ${rule.toColumnId}`);
  }
}
setInterval(() => { runNoReplyMoveScan().catch(() => {}); }, 10 * 60 * 1000);

// Config por tenant: crmColumnAgeMove = { columnId, toColumnId, toFunnelId, afterDays }
// Card parado há mais de afterDays na coluna (enteredAt = ultima entrada no historico,
// ja vem pronto em getCrmCards) -> move pra outra coluna (ex.: Repescagem -> Arquivo Morto).
// Generico, sem duplicar nada do runNoReplyMoveScan (aquele olha ultima mensagem; este olha
// so tempo parado na coluna, independente de ter mensagem).
async function runColumnAgeMoveScan() {
  let clientDefs = [];
  try { clientDefs = loadClients().filter(c => !c.ownerClientId); } catch (e) { return; }
  for (const clientDef of clientDefs) {
    let t; try { t = getTenant(clientDef.id); } catch (e) { continue; }
    const rule = (t.db.getConfig() || {}).crmColumnAgeMove;
    if (!rule || !rule.columnId || !rule.toColumnId) continue;
    const afterMs = (Number(rule.afterDays) || 90) * 86400000;
    let cards; try { cards = t.db.getCrmCards().filter(c => String(c.columnId) === String(rule.columnId)); } catch (e) { continue; }
    if (!cards.length) continue;
    let toFunnel = rule.toFunnelId;
    if (!toFunnel) { const col = (t.db.getCrmColumns() || []).find(c => String(c.id) === String(rule.toColumnId)); toFunnel = col ? col.funnelId : undefined; }
    let moved = 0;
    for (const c of cards) {
      const ref = c.enteredAt || c.createdAt || 0;
      if (!ref || (Date.now() - ref) < afterMs) continue;
      const upd = { columnId: rule.toColumnId }; if (toFunnel) upd.funnelId = toFunnel;
      try { t.db.updateCrmCard(c.id, upd); moved++; } catch (e) {}
    }
    if (moved) console.log(`[${clientDef.id}] column-age move: ${moved} lead(s) ${rule.columnId} -> ${rule.toColumnId}`);
  }
}
setInterval(() => { runColumnAgeMoveScan().catch(() => {}); }, 30 * 60 * 1000);

// Retenção de mensagens: move (não apaga) o que passou de MESSAGE_RETENTION_DAYS pra
// messages_archive, em todos os clientes deste processo (donos e sub-clientes — cada um
// tem sua própria messages/messages_archive, então precisa iterar todos, sem o filtro de
// ownerClientId que o runFollowupScan usa).
function archiveOldMessagesAllClients() {
  let clientDefs = [];
  try { clientDefs = loadClients(); } catch (e) { return; }
  for (const clientDef of clientDefs) {
    let t; try { t = getTenant(clientDef.id); } catch (e) { continue; }
    try {
      const moved = t.db.archiveOldMessagesOlderThan(MESSAGE_RETENTION_DAYS);
      if (moved) console.log(`[retenção] ${clientDef.id}: ${moved} mensagens arquivadas (+${MESSAGE_RETENTION_DAYS}d)`);
    } catch (e) { console.log(`[retenção] ${clientDef.id}: erro ao arquivar —`, e.message); }
  }
}

// VACUUM semanal: o SQLite nunca encolhe o arquivo sozinho quando apaga/move linhas (só
// marca o espaço como livre pra reuso) — sem isso o arquivo só cresce com o tempo mesmo
// depois de arquivar mensagens antigas. Roda na MESMA conexão que o app já usa (t.db.vacuum,
// dentro do processo), nunca por fora — evita duas conexões brigando pelo mesmo arquivo.
function vacuumAllClients() {
  let clientDefs = [];
  try { clientDefs = loadClients(); } catch (e) { return; }
  for (const clientDef of clientDefs) {
    let t; try { t = getTenant(clientDef.id); } catch (e) { continue; }
    const dbPath = path.join(DATA_DIR, 'data', clientDef.id, 'db.sqlite3');
    let before = 0; try { before = fs.statSync(dbPath).size; } catch (e) {}
    try {
      t.db.vacuum();
      let after = 0; try { after = fs.statSync(dbPath).size; } catch (e) {}
      const savedKb = Math.round((before - after) / 1024);
      console.log(`[vacuum] ${clientDef.id}: ok${savedKb > 0 ? ` (–${savedKb}KB)` : ''}`);
    } catch (e) { console.log(`[vacuum] ${clientDef.id}: erro —`, e.message); }
  }
}

// Tarefas recorrentes: quando uma recorrente marcada FEITA passa 1 dia do vencimento,
// reabre (status 'fazer') e joga o vencimento p/ 3 dias à frente — assim o usuário sabe que precisa repetir.
function advanceRecurringDue(due, rec) {
  const DAY = 86400000;
  const days = rec === 'daily' ? 1 : rec === 'biweekly' ? 14 : rec === 'monthly' ? 30 : 7;
  const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const base = (due && Number(due) >= startOfToday) ? Number(due) : startOfToday;
  const d = new Date(base); d.setHours(12, 0, 0, 0);
  return d.getTime() + days * DAY;
}
function runRecurringTaskScan() {
  const DAY = 86400000;
  const startOfTomorrow = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() + DAY; })();
  const intervalDays = (rec) => rec === 'daily' ? 1 : rec === 'biweekly' ? 14 : rec === 'monthly' ? 30 : 7;
  const nextDue = (rec) => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() + intervalDays(rec) * DAY; };
  // garante que o tenant do processo esteja carregado (o map só enche via request)
  try { const cs = loadClients(); const own = cs.find(c => c.admin && !c.ownerClientId) || cs[0]; if (own) getTenant(own.id); } catch (e) {}
  for (const t of tenants.values()) {
    try {
      const a = getClientAreaObj(t);
      let changed = false;
      const check = (task) => {
        if (task && task.recurring && task.status === 'feito' && task.due && Number(task.due) < startOfTomorrow) {
          task.status = 'fazer'; task.done = false; task.resultado = '';
          changed = true;
        }
      };
      (a.clients || []).forEach(c => (c.tasks || []).forEach(check));
      (a.avulsas || []).forEach(check);
      if (changed) t.db.updateConfig({ clientArea: { clients: a.clients, avulsas: a.avulsas } });
    } catch (e) { /* silencioso */ }
  }
}
setInterval(runRecurringTaskScan, 60 * 60 * 1000); // de hora em hora
setTimeout(runRecurringTaskScan, 20000);           // uma vez após o boot
function runScheduledCampaignScan() {
  const now = Date.now();
  for (const t of tenants.values()) {
    try {
      const arr = getCampaigns(t);
      for (const c of arr) {
        const vencida = c.status === 'agendada' && c.scheduledFor && Number(c.scheduledFor) <= now;
        // Ficou 'enviando' tempo demais: o processo caiu no meio. Retoma de onde parou
        // (sendCampaignNow pula quem ja esta no sentList).
        const travada = c.status === 'enviando' && Number(c.sendingSince || 0) > 0 && (now - Number(c.sendingSince)) > CAMPAIGN_STALE_MS;
        if (!vencida && !travada) continue;
        if (travada) console.log('[campanha] retomando', c.id, '- travada em enviando desde', new Date(Number(c.sendingSince)).toISOString());
        // sendCampaignNow marca 'enviando' e persiste antes do primeiro await.
        sendCampaignNow(t, c, t.clientId + '.gestorwagnnerpires.com.br')
          .catch(e => console.log('[campanha] falha ao enviar', c.id, '-', e && e.message));
      }
    } catch (e) {}
  }
}
setInterval(runScheduledCampaignScan, 60000);
setTimeout(runScheduledCampaignScan, 25000);

// Pausa o bot para um contato (quando um atendente responde manualmente)
// Guarda os ids das mensagens que o PROPRIO sistema enviou (bot/automacao).
// Sem isso, o eco da resposta do bot voltaria como "fromMe" e ele pausaria a si mesmo.
function botMarkSent(t, wamid) {
  if (!wamid) return;
  if (!t._botSentIds) t._botSentIds = new Map();
  t._botSentIds.set(String(wamid), Date.now());
  if (t._botSentIds.size > 600) {
    const corte = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of t._botSentIds) if (v < corte) t._botSentIds.delete(k);
    // Num disparo em massa nada envelhece a tempo: corta os mais antigos pra nao crescer sem fim.
    while (t._botSentIds.size > 600) t._botSentIds.delete(t._botSentIds.keys().next().value);
  }
}
function botWasOurSend(t, wamid) {
  return !!(wamid && t._botSentIds && t._botSentIds.has(String(wamid)));
}
// Atendente respondeu de fora do painel (celular/WhatsApp Web): para o auto atendimento.
function pauseBotFromEcho(t, key) {
  try {
    if (!key || !key.fromMe) return;
    if (botWasOurSend(t, key.id)) return;      // eco do proprio bot, ignora
    const jid = String(key.remoteJid || '');
    if (!jid || jid.endsWith('@g.us')) return;
    const st = t.db.getContactBotState(jid);
    if (st && st.botPaused) return;            // ja estava pausado
    pauseBotForContact(t, jid);
    console.log(`[${t.clientId}] auto atendimento pausado em ${jid}: atendente respondeu por fora do painel`);
  } catch (e) {}
}

function pauseBotForContact(t, contactId) {
  try {
    if (!contactId || String(contactId).endsWith('@g.us')) return;
    const digits = normalizeBrazilianMobileDigits(normalizePhoneNumber(contactId));
    const jid = digits ? `${digits}@s.whatsapp.net` : null;
    const njid = normalizeJid(contactId);
    // Atendente respondeu → para de piscar "Atender" (limpa o alerta) e atualiza a etiqueta
    if (jid) t.db.setNeedsHuman(jid, false);
    t.db.setNeedsHuman(njid, false);
    const card = findCrmCardForChat(t, digits) || findCrmCardForChat(t, njid);
    if (card && (Array.isArray(card.labels) ? card.labels[0] : card.label) === LBL_HUMAN) t.db.updateCrmCard(card.id, { label: 'Em andamento' });
    // Pausa o bot quando um humano assume — vale pro Auto Atendimento E pra IA chatbot (anthropicApiKey).
    const _botAtivo = getAutoAtendimento(t).enabled || !!((t.db.getConfig() || {}).anthropicApiKey);
    if (!_botAtivo) return;
    if (jid) t.db.setBotPaused(jid, true);
    t.db.setBotPaused(njid, true);
  } catch (e) {}
}

async function sendCloudInteractiveButtons(t, to, message, quickReplies) {
  return graphRequest(t, `/${t.WA_PHONE_NUMBER_ID}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive: { type: 'button', body: { text: message }, action: { buttons: quickReplies.map((r, i) => ({ type: 'reply', reply: { id: `btn_${Date.now()}_${i}`, title: r } })) } } } });
}

function isGroupRecipientId(recipientId) {
  return String(recipientId || '').endsWith('@g.us');
}

function getGroupDispatchStatus(t) {
  const canaryFresh = !!t.groupCanaryLastOk && !!t.groupCanaryLastAt && Date.now() - t.groupCanaryLastAt <= GROUP_CANARY_MAX_AGE_MS;
  return {
    paused: !!t.groupDispatchPaused,
    reason: t.groupDispatchPauseReason || '',
    canaryGroupId: t.groupCanaryGroupId || '',
    canaryGroupName: t.groupCanaryGroupName || '',
    canaryLastAt: t.groupCanaryLastAt || 0,
    canaryLastOk: !!t.groupCanaryLastOk,
    canaryFresh,
    maxAgeMinutes: Math.round(GROUP_CANARY_MAX_AGE_MS / 60000)
  };
}

function pauseGroupDispatch(t, reason) {
  let cleanReason = String(reason || 'Falha no envio para grupo')
    .replace(/(Disparo em grupos pausado:\s*)+/gi, '')
    .trim();
  if (!cleanReason) cleanReason = 'Falha no envio para grupo';
  cleanReason = cleanReason.slice(0, 300);
  t.groupDispatchPaused = true;
  t.groupDispatchPauseReason = cleanReason;
  t.db.updateConfig({ groupDispatchPaused: true, groupDispatchPauseReason: cleanReason });
}

function resumeGroupDispatch(t) {
  t.groupDispatchPaused = false;
  t.groupDispatchPauseReason = '';
  t.db.updateConfig({ groupDispatchPaused: false, groupDispatchPauseReason: '' });
}

function markGroupCanary(t, { groupId, groupName, ok, reason }) {
  t.groupCanaryGroupId = groupId || t.groupCanaryGroupId || '';
  t.groupCanaryGroupName = groupName || t.groupCanaryGroupName || '';
  t.groupCanaryLastAt = Date.now();
  t.groupCanaryLastOk = !!ok;
  if (ok) {
    t.groupDispatchPaused = false;
    t.groupDispatchPauseReason = '';
  } else {
    t.groupDispatchPaused = true;
    t.groupDispatchPauseReason = String(reason || 'Canario de grupos falhou').slice(0, 300);
  }
  t.db.updateConfig({
    groupCanaryGroupId: t.groupCanaryGroupId,
    groupCanaryGroupName: t.groupCanaryGroupName,
    groupCanaryLastAt: t.groupCanaryLastAt,
    groupCanaryLastOk: t.groupCanaryLastOk,
    groupDispatchPaused: t.groupDispatchPaused,
    groupDispatchPauseReason: t.groupDispatchPauseReason
  });
}

function assertGroupDispatchHealthy(t, schedule) {
  if (!isGroupRecipientId(schedule.recipientId)) return;
  // O canário fica disponível como diagnóstico, mas não bloqueia a fila.
  // A conexão escolhida na planilha é quem decide o envio.
}

async function runGroupCanary(t, groupId) {
  if (![t.isReady, t.isReady2, t.isReady3, t.isGroupReady].some(Boolean)) throw new Error('Nenhum QR Code conectado para testar grupos.');
  const normalizedGroupId = normalizeJid(groupId || t.groupCanaryGroupId || '');
  if (!isGroupRecipientId(normalizedGroupId)) throw new Error('Selecione um grupo valido para o canario.');
  const groups = await refreshGroups(t);
  const group = groups.find(g => g.id === normalizedGroupId) || { id: normalizedGroupId, name: normalizedGroupId };
  const text = `[canario] teste de envio para grupos - ${new Date().toLocaleString('pt-BR')}`;
  try {
    const { sentMsg, connectionId } = await sendGroupTextWithFallback(t, normalizedGroupId, text, 'web');
    if (!sentMsg?.key?.id) throw new Error('WhatsApp nao confirmou o id da mensagem de teste.');
    t.db.recordMessage({ direction: 'out', contactId: normalizedGroupId, contactName: group.name || normalizedGroupId, text, connectionId });
    markGroupCanary(t, { groupId: normalizedGroupId, groupName: group.name || normalizedGroupId, ok: true });
    return getGroupDispatchStatus(t);
  } catch (error) {
    markGroupCanary(t, { groupId: normalizedGroupId, groupName: group.name || normalizedGroupId, ok: false, reason: error.message });
    throw error;
  }
}

function resolveWebClientForSchedule(t, schedule) {
  const connId = schedule.connectionId || 'web';
  if (connId === 'web2') return { sock: t.waClient2, ready: t.isReady2 };
  if (connId === 'web3') return { sock: t.waClient3, ready: t.isReady3 };
  return { sock: t.waClient, ready: t.isReady };
}

function resolveBaileysConnection(t, connId) {
  if (connId === 'groups' || connId === 'baileys_groups') return { sock: t.waGroupClient, ready: t.isGroupReady };
  if (connId === 'web2') return { sock: t.waClient2, ready: t.isReady2 };
  if (connId === 'web3') return { sock: t.waClient3, ready: t.isReady3 };
  return { sock: t.waClient, ready: t.isReady };
}

function isBaileysCryptoSessionError(error) {
  const m = String(error?.message || error || '').toLowerCase();
  return [
    'no sessions',
    'bad mac',
    'not-acceptable',
    'failed to decrypt',
    'session error',
    'sender key',
    'decrypt message',
    'no senderkey',
  ].some(s => m.includes(s));
}

function markBaileysConnectionUnhealthy(t, connId, error, context = '') {
  const key = connId || 'web';
  if (!t.baileysConnectionHealth) t.baileysConnectionHealth = {};
  t.baileysConnectionHealth[key] = {
    unhealthy: true,
    reason: String(error?.message || error || 'Sessao criptografica invalida').slice(0, 300),
    context,
    at: Date.now(),
  };
}

function clearBaileysConnectionHealth(t, connId) {
  if (!t.baileysConnectionHealth) t.baileysConnectionHealth = {};
  delete t.baileysConnectionHealth[connId || 'web'];
}

function assertBaileysConnectionHealthy(t, connId) {
  const state = t.baileysConnectionHealth?.[connId || 'web'];
  if (!state?.unhealthy) return;
  const when = state.at ? ` desde ${new Date(state.at).toLocaleString('pt-BR')}` : '';
  throw new Error(`WhatsApp ${connId || 'web'} bloqueado por falha de criptografia${when}: ${state.reason}. Gere novo QR/reconecte esta conexao antes de enviar 1:1.`);
}

async function assertBaileysSendAccepted(sock, sentMsg, connId, t) {
  if (!sentMsg?.key?.id) throw new Error('WhatsApp nao confirmou o id da mensagem.');
  await new Promise(resolve => setTimeout(resolve, 350));
  if (sock?.ws && !sock.ws.isOpen) {
    throw new Error(`WhatsApp ${connId || 'web'} fechou a conexao logo apos o envio; mensagem nao foi marcada como enviada.`);
  }
  // Non-blocking ACK tracking: logs a warning if WA does not acknowledge within 8s
  if (t?._pendingMsgAcks && sentMsg.key?.id) {
    const msgId = sentMsg.key.id;
    const jid = sentMsg.key?.remoteJid || '?';
    const timer = setTimeout(() => {
      t._pendingMsgAcks.delete(msgId);
      console.warn(`[${t.clientId}][${connId || 'web'}] AVISO: msg ${msgId} p/ ${jid} sem ACK do WA em 8s — verifique entrega.`);
    }, 8000);
    t._pendingMsgAcks.set(msgId, {
      resolve: () => {},
      reject: (err) => { console.error(`[${t.clientId}][${connId || 'web'}] ${err.message}`); },
      timer,
    });
  }
  return sentMsg;
}



async function sendGroupTextWithFallback(t, jid, text, preferredConnection) {
  const order = [preferredConnection, 'groups', 'web2', 'web3'].filter(c => c && c !== 'web');
  const tried = new Set();
  let lastError = null;
  if (liteEnabled(t)) {
    try { return await sendGroupViaLite(t, { recipientId: jid, message: text, quickReplies: [], documentPath: null, documentName: null }); }
    catch (e) { lastError = e; console.warn(`[${t.clientId}] Falha ao enviar grupo via lite: ${e.message}`); }
  }
  for (const connId of order) {
    if (tried.has(connId)) continue;
    tried.add(connId);
    const { sock, ready } = resolveBaileysConnection(t, connId);
    if (!ready || !sock) continue;
    try {
      const sentMsg = await sock.sendMessage(jid, { text });
      await assertBaileysSendAccepted(sock, sentMsg, connId);
      return { sentMsg, connectionId: connId };
    } catch (error) {
      lastError = error;
      if (isBaileysCryptoSessionError(error)) markBaileysConnectionUnhealthy(t, connId, error, `grupo:${jid}`);
      console.warn(`[${t.clientId}][${connId}] Falha ao enviar grupo ${jid}: ${error.message}`);
    }
  }
  throw lastError || new Error('Nenhum QR Code conectado para enviar este grupo.');
}

async function sendWebScheduledMessage(t, schedule) {
  const { sock, ready } = resolveWebClientForSchedule(t, schedule);
  if (!ready || !sock) throw new Error(`WhatsApp ${schedule.connectionId || 'web'} nao conectado`);
  assertGroupDispatchHealthy(t, schedule);
  const jid = isGroupRecipientId(schedule.recipientId) ? normalizeJid(schedule.recipientId) : await resolveOutboundWebJid(t, schedule.recipientId);
  const connId = schedule.connectionId || 'web';
  if (!isGroupRecipientId(jid)) assertBaileysConnectionHealthy(t, connId);
  const quickReplies = normalizeQuickReplies(schedule.quickReplies);
  const fullMessage = buildFallbackMessage(schedule.message, quickReplies);
  if (schedule.documentPath && !fs.existsSync(schedule.documentPath)) throw new Error(`Documento nao encontrado: ${schedule.documentName}`);
  if (schedule.documentPath && fs.existsSync(schedule.documentPath)) {
    const buffer = fs.readFileSync(schedule.documentPath);
    const mimeType = guessMimeType(schedule.documentPath);
    const fileName = schedule.documentName || path.basename(schedule.documentPath);
    let sentMsg;
    if (mimeType.startsWith('image/')) {
      sentMsg = await sock.sendMessage(jid, { image: buffer, caption: fullMessage });
    } else if (mimeType.startsWith('video/')) {
      sentMsg = await sock.sendMessage(jid, { video: buffer, caption: fullMessage });
    } else {
      sentMsg = await sock.sendMessage(jid, { document: buffer, mimetype: mimeType, fileName, caption: fullMessage });
    }
    await assertBaileysSendAccepted(sock, sentMsg, connId);
    return { connectionId: connId };
  }
  const sentMsg = await sock.sendMessage(jid, { text: fullMessage });
  await assertBaileysSendAccepted(sock, sentMsg, connId);
  if (sentMsg.message) t.msgStore.set(sentMsg.key.id, sentMsg.message);
  return { connectionId: connId };
}

async function sendGroupBaileysMessage(t, schedule) {
  assertGroupDispatchHealthy(t, schedule);
  const jid = normalizeJid(schedule.recipientId);
  if (!jid.endsWith('@g.us')) throw new Error('Destino nao e um grupo.');
  const quickReplies = normalizeQuickReplies(schedule.quickReplies);
  const fullMessage = buildFallbackMessage(schedule.message, quickReplies);
  if (schedule.documentPath && !fs.existsSync(schedule.documentPath)) throw new Error(`Documento nao encontrado: ${schedule.documentName}`);
  if (schedule.documentPath && fs.existsSync(schedule.documentPath)) {
    const buffer = fs.readFileSync(schedule.documentPath);
    const mimeType = guessMimeType(schedule.documentPath);
    const fileName = schedule.documentName || path.basename(schedule.documentPath);
    let sentMsg;
    if (mimeType.startsWith('image/')) sentMsg = await t.waGroupClient.sendMessage(jid, { image: buffer, caption: fullMessage });
    else if (mimeType.startsWith('video/')) sentMsg = await t.waGroupClient.sendMessage(jid, { video: buffer, caption: fullMessage });
    else sentMsg = await t.waGroupClient.sendMessage(jid, { document: buffer, mimetype: mimeType, fileName, caption: fullMessage });
    await assertBaileysSendAccepted(t.waGroupClient, sentMsg, 'groups');
    return { connectionId: 'groups' };
  }
  const sentMsg = await t.waGroupClient.sendMessage(jid, { text: fullMessage });
  await assertBaileysSendAccepted(t.waGroupClient, sentMsg, 'groups');
  if (sentMsg.message) t.msgStore.set(sentMsg.key.id, sentMsg.message);
  return { connectionId: 'groups' };
}

async function sendGroupViaLite(t, schedule) {
  if (!liteEnabled(t)) throw new Error('WhatsApp Lite nao habilitado');
  const jid = normalizeJid(schedule.recipientId);
  if (!jid.endsWith('@g.us')) throw new Error('Destino nao e um grupo.');
  const quickReplies = normalizeQuickReplies(schedule.quickReplies);
  const fullMessage = buildFallbackMessage(schedule.message, quickReplies);
  if (schedule.documentPath && !fs.existsSync(schedule.documentPath)) throw new Error(`Documento nao encontrado: ${schedule.documentName}`);
  let lastErr = null;
  for (const slot of ['1', '2']) {
    const inst = liteInstanceName(t, slot);
    try {
      let r;
      if (schedule.documentPath && fs.existsSync(schedule.documentPath)) {
        const b64 = fs.readFileSync(schedule.documentPath).toString('base64');
        const mimeType = guessMimeType(schedule.documentPath);
        const fileName = schedule.documentName || path.basename(schedule.documentPath);
        const mt = mimeType.startsWith('image/') ? 'image' : (mimeType.startsWith('video/') ? 'video' : 'document');
        r = await evoReq('POST', `/message/sendMedia/${inst}`, { number: jid, mediatype: mt, mimetype: mimeType, media: b64, fileName, caption: fullMessage });
        if ((!r || !r.ok) && mt !== 'document') { r = await evoReq('POST', `/message/sendMedia/${inst}`, { number: jid, mediatype: 'document', mimetype: mimeType, media: b64, fileName, caption: fullMessage }); }
      } else {
        r = await evoReq('POST', `/message/sendText/${inst}`, { number: jid, text: fullMessage });
      }
      if (r && r.ok) return { connectionId: slot === '2' ? 'lite2' : 'lite' };
      lastErr = new Error('Lite respondeu ' + (r && r.status));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('WhatsApp Lite falhou ao enviar para o grupo.');
}

// Mesma logica do sendGroupViaLite, mas pra destinatario individual — faltava esse
// caminho: a fila de agendamento sabia mandar pra grupo via Lite, mas pra contato
// avulso caia sempre no socket Baileys direto (sendWebScheduledMessage), que nao
// entende connectionId 'lite'/'lite2' e falhava com "nao conectado" mesmo com o
// Lite aberto (usado pelo envio direto ao vendedor da vez).
// IMPORTANTE: diferente do sendGroupViaLite (que tenta slot 1 e cai pro 2), aqui
// respeita SÓ o slot configurado em schedule.connectionId ('lite'=1, 'lite2'=2) — igual
// ao Chat ao vivo, onde o usuário escolhe explicitamente. Motivo: o Evolution às vezes
// responde "ok" no sendText mesmo com a instância desconectada (só enfileira e nunca
// entrega, sem erro nenhum) — tentar "adivinhar" o slot mascarava esse tipo de falha
// silenciosa. Por isso também checa o estado da conexão ANTES de tentar enviar.
async function sendIndividualViaLite(t, schedule) {
  if (!liteEnabled(t)) throw new Error('WhatsApp Lite nao habilitado');
  const digits = String(schedule.recipientId || '').replace(/\D/g, '');
  if (!digits) throw new Error('Numero de destino invalido.');
  const slot = String(schedule.connectionId || 'lite') === 'lite2' ? '2' : '1';
  const inst = liteInstanceName(t, slot);
  const state = await evoReq('GET', `/instance/connectionState/${inst}`, null, 8000);
  const liveState = state && state.json && state.json.instance && state.json.instance.state;
  if (liveState !== 'open') throw new Error(`WhatsApp ${slot === '2' ? 'lite2' : 'lite'} nao conectado (estado: ${liveState || 'desconhecido'})`);
  const quickReplies = normalizeQuickReplies(schedule.quickReplies);
  const fullMessage = buildFallbackMessage(schedule.message, quickReplies);
  if (schedule.documentPath && !fs.existsSync(schedule.documentPath)) throw new Error(`Documento nao encontrado: ${schedule.documentName}`);
  let r;
  if (schedule.documentPath && fs.existsSync(schedule.documentPath)) {
    const b64 = fs.readFileSync(schedule.documentPath).toString('base64');
    const mimeType = guessMimeType(schedule.documentPath);
    const fileName = schedule.documentName || path.basename(schedule.documentPath);
    const mt = mimeType.startsWith('image/') ? 'image' : (mimeType.startsWith('video/') ? 'video' : 'document');
    r = await evoReq('POST', `/message/sendMedia/${inst}`, { number: digits, mediatype: mt, mimetype: mimeType, media: b64, fileName, caption: fullMessage });
    if ((!r || !r.ok) && mt !== 'document') { r = await evoReq('POST', `/message/sendMedia/${inst}`, { number: digits, mediatype: 'document', mimetype: mimeType, media: b64, fileName, caption: fullMessage }); }
  } else {
    r = await evoReq('POST', `/message/sendText/${inst}`, { number: digits, text: fullMessage });
  }
  if (r && r.ok) return { connectionId: slot === '2' ? 'lite2' : 'lite' };
  throw new Error('Lite respondeu ' + (r && r.status));
}

async function sendGroupScheduledWithFallback(t, schedule, preferredConnection = null) {
  // web é o socket de chat 1:1 — vai por último para não sobrecarregá-lo com dispatch de grupos
  const order = [preferredConnection, schedule.connectionId, 'groups', 'web2', 'web3'].filter(c => c && c !== 'web');
  const tried = new Set();
  let lastError = null;
  // Agendas antigas ou importadas podem não guardar uma conexão. Nessa situação,
  // prioriza o WhatsApp Lite disponível antes de depender de um QR Code.
  const explicitBaileysConnection = ['groups', 'baileys_groups', 'web', 'web2', 'web3'].includes(String(schedule.connectionId || ''));
  if (!explicitBaileysConnection && liteEnabled(t)) {
    try { return await sendGroupViaLite(t, schedule); }
    catch (error) {
      lastError = error;
      console.warn(`[${t.clientId}] Falha ao enviar grupo agendado via lite: ${error.message}`);
    }
  }
  for (const connId of order) {
    if (tried.has(connId)) continue;
    tried.add(connId);
    const { sock, ready } = resolveBaileysConnection(t, connId);
    if (!ready || !sock) continue;
    try {
      if (connId === 'groups' || connId === 'baileys_groups') {
        await sendGroupBaileysMessage(t, { ...schedule, connectionId: connId });
      } else {
        await sendWebScheduledMessage(t, { ...schedule, connectionId: connId });
      }
      return { connectionId: connId };
    } catch (error) {
      lastError = error;
      if (isBaileysCryptoSessionError(error)) markBaileysConnectionUnhealthy(t, connId, error, `fila-grupo:${schedule.recipientId}`);
      console.warn(`[${t.clientId}] Falha ao enviar grupo via ${connId}: ${error.message}`);
    }
  }
  throw lastError || new Error('Nenhum QR Code conectado para enviar este grupo.');
}

async function uploadCloudScheduledDocument(accessToken, phoneNumberId, documentPath, mimeType, fileName) {
  if (!documentPath || !fs.existsSync(documentPath)) throw new Error(`Documento nao encontrado: ${fileName || documentPath}`);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([fs.readFileSync(documentPath)], { type: mimeType || 'application/octet-stream' }), fileName || path.basename(documentPath));
  const media = await graphRequestWithToken(accessToken, `/${phoneNumberId}/media`, { method: 'POST', formData: form });
  if (!media || !media.id) throw new Error('A API Oficial nao retornou o identificador do documento.');
  return media.id;
}

async function sendCloudScheduledMessage(t, schedule) {
  const to = normalizePhoneNumber(schedule.recipientId);
  if (!to) throw new Error('Numero de destino invalido.');
  const quickReplies = normalizeQuickReplies(schedule.quickReplies);
  const plainMessage = schedule.message;
  const fallbackMessage = buildFallbackMessage(plainMessage, quickReplies);

  const sendWithCreds = async (phoneNumberId, accessToken) => {
    if (!phoneNumberId || !accessToken) throw new Error('API Oficial selecionada nao esta configurada.');
    if (schedule.templatePayload && schedule.templatePayload.name) {
      const _tp = schedule.templatePayload;
      const _tpl = { name: _tp.name, language: { code: _tp.language || 'pt_BR' } };
      if (Array.isArray(_tp.params) && _tp.params.length) _tpl.components = [{ type: 'body', parameters: _tp.params.map(x => ({ type: 'text', text: String(x == null ? '' : x) || ' ' })) }];
      return graphRequestWithToken(accessToken, `/${phoneNumberId}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: _tpl } });
    }
    if (schedule.documentPath) {
      const mimeType = guessMimeType(schedule.documentPath);
      const fileName = schedule.documentName || path.basename(schedule.documentPath);
      const mediaId = await uploadCloudScheduledDocument(accessToken, phoneNumberId, schedule.documentPath, mimeType, fileName);
      return graphRequestWithToken(accessToken, `/${phoneNumberId}/messages`, {
        method: 'POST',
        json: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'document',
          document: { id: mediaId, filename: fileName, caption: fallbackMessage }
        }
      });
    }
    if (quickReplies.length) {
      return graphRequestWithToken(accessToken, `/${phoneNumberId}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive: { type: 'button', body: { text: plainMessage }, action: { buttons: quickReplies.map((r, i) => ({ type: 'reply', reply: { id: `btn_${Date.now()}_${i}`, title: r } })) } } } });
    }
    return graphRequestWithToken(accessToken, `/${phoneNumberId}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: fallbackMessage } } });
  };

  const connId = schedule.connectionId || 'auto';
  const cloudSlots = Object.fromEntries([1, 2, 3, 4, 5].map(n => {
    const c = getCloudSlot(t, n);
    return [c.connectionId, { phoneNumberId: c.phoneNumberId, accessToken: c.accessToken }];
  }));
  if (cloudSlots[connId]) {
    return sendWithCreds(cloudSlots[connId].phoneNumberId, cloudSlots[connId].accessToken);
  }

  let lastError = null;
  for (let n = 1; n <= 5; n++) {
    const c = getCloudSlot(t, n);
    if (!c.phoneNumberId || !c.accessToken) continue;
    try { return await sendWithCreds(c.phoneNumberId, c.accessToken); }
    catch (error) { lastError = error; console.warn(`[${t.clientId}] Cloud ${n} falhou (${error.message}), tentando próxima conexão...`); }
  }
  throw lastError || new Error('Nenhuma API Oficial configurada.');
}

// Nome do destinatario no texto do disparo.
//   {nome}      -> nome completo do lead
//   {primeiro}  -> so o primeiro nome
//   {nome|amigo}-> usa "amigo" quando o lead nao tem nome
// Card sem nome costuma guardar o proprio telefone ali; nesse caso vale o fallback,
// senao sairia "Oi 5551999991111!".
function nomeUtil(bruto) {
  const v = String(bruto || '').trim();
  if (!v) return '';
  if (!/[A-Za-zÀ-ÿ]/.test(v)) return '';        // so numeros/simbolos = sem nome
  if (v.replace(/\D/g, '').length >= 8) return ''; // "5551999991111" ou similar
  return v;
}
function primeiroNome(bruto) {
  const v = nomeUtil(bruto);
  return v ? v.split(/\s+/)[0] : '';
}
function aplicaTagsMensagem(texto, nomeBruto) {
  let out = String(texto || '');
  if (out.indexOf('{') < 0) return out;
  const troca = (re, valor) => {
    out = out.replace(re, (_m, fb) => valor || String(fb || '').replace(/^\|/, '').trim());
  };
  troca(/\{\{?\s*primeiro(?:_?nome)?\s*(\|[^}]*)?\}\}?/gi, primeiroNome(nomeBruto));
  troca(/\{\{?\s*nome\s*(\|[^}]*)?\}\}?/gi, nomeUtil(nomeBruto));
  // Sobrou "Oi !" ou "Olá ," porque nao havia nome nem fallback: limpa a pontuacao solta.
  out = out.replace(/([^\S\n]+)([!?,.])/g, '$2').replace(/[^\S\n]{2,}/g, ' ');
  return out;
}

async function dispatchScheduledMessage(t, schedule) {
  // Personaliza antes de qualquer caminho de envio.
  schedule = { ...schedule, message: aplicaTagsMensagem(schedule.message, schedule.recipientName) };
  const connId = schedule.connectionId || 'auto';
  if (isGroupRecipientId(schedule.recipientId)) {
    if (connId.startsWith('cloud')) throw new Error('API Oficial da Meta nao envia para grupo normal. Escolha um WhatsApp QR Code (web, web2 ou web3).');
    // Relatórios de clientes usam a conexão viva no momento do disparo. Isso evita
    // que uma fila preparada enquanto o Lite oscilava caia em uma rota QR antiga.
    const isWeeklyReport = String(schedule.bulkId || '').startsWith('weekly-report:') || weeklyIsReportMessage(schedule.message);
    if (isWeeklyReport) {
      try {
        const liveConnection = await weeklyGroupConnection(t);
        if (liveConnection === 'lite' || liveConnection === 'lite2') return sendGroupViaLite(t, { ...schedule, connectionId: liveConnection });
      } catch (error) {
        console.warn(`[${t.clientId}] Lite indisponível para relatório em grupo; mantendo fallback: ${error.message}`);
      }
    }
    if (connId === 'lite' || connId === 'lite2') return sendGroupViaLite(t, schedule);
    if (connId === 'groups' || connId === 'baileys_groups') {
      if (!t.isGroupReady || !t.waGroupClient) throw new Error('WhatsApp operacional de grupos nao esta conectado. A fila ficou protegida e nao caiu no WhatsApp principal.');
      return sendGroupScheduledWithFallback(t, schedule, connId);
    }
    if (connId === 'web' || connId === 'web2' || connId === 'web3') {
      return sendGroupScheduledWithFallback(t, schedule, connId);
    }
    return sendGroupScheduledWithFallback(t, schedule, null);
  }
  if (connId.startsWith('cloud')) return sendCloudScheduledMessage(t, schedule);
  if (connId === 'lite' || connId === 'lite2') return sendIndividualViaLite(t, schedule);
  if (connId === 'web' || connId === 'web2' || connId === 'web3') return sendWebScheduledMessage(t, schedule);
  if (t.provider === 'cloud') return sendCloudScheduledMessage(t, schedule);
  return sendWebScheduledMessage(t, schedule);
}

function isTransientWebSessionError(error) {
  const m = String(error?.message || '').toLowerCase();
  return ['connection closed', 'not connected', 'timed out', 'stream errored', 'econnreset', 'lost connection', 'whatsapp not connected', 'socket hang up'].some(s => m.includes(s));
}

// Envia um WS PING e aguarda PONG — detecta sockets TCP mortos silenciosamente
function pingSocket(sock, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const rawSocket = sock?.ws?.socket;
    if (!rawSocket || rawSocket.readyState !== 1) return resolve(false);
    const timer = setTimeout(() => { rawSocket.off('pong', handler); resolve(false); }, timeoutMs);
    const handler = () => { clearTimeout(timer); resolve(true); };
    rawSocket.once('pong', handler);
    try { rawSocket.ping(); } catch { clearTimeout(timer); rawSocket.off('pong', handler); resolve(false); }
  });
}


// ─── Dispatch queue ─────────────────────────────────────────

function enqueueDueSchedules(t) {
  ensureGroupClient(t, 'queue-scan');
  const status = getStatusPayload(t);
  // Lite conta como conexão válida: sem isso, um tenant que só usa Lite tem a fila travada
  if (!status.connected && !t.isGroupReady && !liteEnabled(t)) return;
  for (const s of t.db.getPendingSchedules()) {
    if (t.queuedIds.has(s.id)) continue;
    t.queuedIds.add(s.id);
    t.pendingQueue.push(s.id);
  }
}

async function processDispatchQueue(t) {
  if (t.isDispatching) {
    // Vigia anti-travamento: se um envio ficou pendurado >90s, destrava a fila
    if (t.dispatchStartedAt && Date.now() - t.dispatchStartedAt > 90000) {
      console.warn(`[${t.clientId}] Dispatch travado ha ${Math.round((Date.now() - t.dispatchStartedAt) / 1000)}s — destravando a fila.`);
      t.isDispatching = false;
    } else return;
  }
  const status = getStatusPayload(t);
  const anyQrReady = !!(t.isReady || t.isReady2 || t.isReady3 || t.isGroupReady);
  if (!status.connected && !anyQrReady && !liteEnabled(t)) return;
  if (t.pendingQueue.length === 0) return;
  if (t.bulkRestUntil && Date.now() < t.bulkRestUntil) return;
  const _dispIv = t.provider === 'cloud' ? CLOUD_DISPATCH_INTERVAL_MS : DISPATCH_INTERVAL_MS;
  if (t.lastDispatchAt && Date.now() - t.lastDispatchAt < _dispIv) return;
  if (t.provider === 'web' && !anyQrReady && !liteEnabled(t)) return;
  const scheduleId = t.pendingQueue.shift();
  t.queuedIds.delete(scheduleId);
  const schedule = t.db.getScheduleById(scheduleId);
  if (!schedule) return;
  if (schedule.scheduledFor > Date.now()) return;
  t.isDispatching = true;
  t.dispatchStartedAt = Date.now();
  try {
    const dispatchResult = await dispatchScheduledMessage(t, schedule);
    const usedConnection = dispatchResult?.connectionId || schedule.connectionId || (t.provider === 'cloud' ? 'cloud1' : 'web');
    if (usedConnection !== schedule.connectionId) t.db.updateSchedule(schedule.id, { connectionId: usedConnection });
    if (isGroupRecipientId(schedule.recipientId) && t.groupDispatchPaused) resumeGroupDispatch(t);
    t.db.markSent(schedule.id, true);
    if (schedule.templatePayload && schedule.templatePayload.name) logTemplateSend(t, schedule.templatePayload.name);
    applyPosEnvio(t, schedule);
    if (schedule.bulkId) {
      t.bulkSentCount = (t.bulkSentCount || 0) + 1;
      if (t.provider !== 'cloud' && t.bulkSentCount % BULK_BATCH_SIZE === 0) t.bulkRestUntil = Date.now() + BULK_REST_MS;
      const _tplJobOk = t._tplBcast && t._tplBcast[schedule.bulkId];
      if (_tplJobOk) _tplJobOk.sent++;
    }
    // Disparo de template NÃO grava no chat ao vivo (senão inunda a lista da atendente com 1000s de saídas); a conversa só aparece quando o lead responder (inbound).
    if (!schedule.templatePayload) t.db.recordMessage({ direction: 'out', contactId: schedule.recipientId, contactName: schedule.recipientName, text: aplicaTagsMensagem(schedule.message, schedule.recipientName), scheduleId: schedule.id, connectionId: usedConnection });
    console.log(`[${t.clientId}] Enviado para "${schedule.recipientName}"`);
  } catch (error) {
    // Canário expirado não é falha permanente — reagenda em 30min e não pausa o dispatch
    if (error.message.includes('canario') || error.message.includes('canário')) {
      t.db.rescheduleAfterFailure(schedule.id, { scheduledFor: Date.now() + 30 * 60 * 1000, error: error.message });
      console.warn(`[${t.clientId}] Canário expirado — "${schedule.recipientName}" reagendado em 30min`);
      return;
    }
    if (isGroupRecipientId(schedule.recipientId) && !isTransientWebSessionError(error)) pauseGroupDispatch(t, error.message);
    if (String(schedule.bulkId || '').startsWith('sheets:') && (schedule.retryCount || 0) < MAX_TRANSIENT_RETRIES) {
      t.db.rescheduleAfterFailure(schedule.id, { scheduledFor: Date.now() + TRANSIENT_RETRY_DELAY_MS, error: error.message });
      console.warn(`[${t.clientId}] Lead de planilha pausado/reagendado por falha na conexão configurada: ${error.message}`);
      return;
    }
    const retryWithQr = ['web', 'web2', 'web3', 'groups', 'baileys_groups'].includes(schedule.connectionId || '') || (!schedule.connectionId && t.provider === 'web');
    if (retryWithQr && isTransientWebSessionError(error) && (schedule.retryCount || 0) < MAX_TRANSIENT_RETRIES) {
      const delay = schedule.documentPath ? TRANSIENT_RETRY_DELAY_WITH_DOCUMENT_MS : TRANSIENT_RETRY_DELAY_MS;
      t.db.rescheduleAfterFailure(schedule.id, { scheduledFor: Date.now() + delay, error: error.message });
      // Baileys reconecta sozinho via connection.update — não forçar reconnect aqui
      return;
    }
    t.db.markSent(schedule.id, false, error.message);
    if (schedule.bulkId) { const _tplJobErr = t._tplBcast && t._tplBcast[schedule.bulkId]; if (_tplJobErr) _tplJobErr.failed++; }
    console.error(`[${t.clientId}] Erro ao enviar para "${schedule.recipientName}":`, error.message);
  } finally {
    t.lastDispatchAt = Date.now();
    t.isDispatching = false;
  }
}

// ─── AI Module ─────────────────────────────────────────────

async function callAnthropicApi(apiKey, messages, systemPrompt, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Anthropic API error'));
          // Modelos com extended thinking (ex: Opus) mandam o bloco "thinking" ANTES do
          // "text" no array — pegar sempre content[0] quebra silenciosamente nesses casos
          // (sem erro, só volta vazio). Por isso procura o bloco certo pelo type.
          resolve(parsed.content?.find(b => b.type === 'text')?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Mesma API, mas devolve a resposta bruta (content[] inteiro + stop_reason) em vez de só
// o texto — o Agente precisa enxergar blocos tool_use pra saber qual ferramenta chamar.
async function callAnthropicApiRaw(apiKey, messages, systemPrompt, model, tools) {
  return new Promise((resolve, reject) => {
    const payload = { model: model || 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, messages };
    if (tools && tools.length) payload.tools = tools;
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Anthropic API error'));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getAiChatbotSet(t) {
  if (!t._aiChatbotContacts) {
    const cfg = t.db.getConfig();
    t._aiChatbotContacts = new Set(Array.isArray(cfg.aiChatbotContacts) ? cfg.aiChatbotContacts : []);
  }
  return t._aiChatbotContacts;
}
// Exceção manual: contato que NÃO deve receber IA mesmo estando na coluna configurada
// (ex: clicou "Assumir" num lead que caiu automaticamente na coluna gatilho). Sem isso,
// o botão "Assumir" não tinha como desligar a IA de um contato ligado só pelo match de coluna.
function getAiChatbotExcludedSet(t) {
  if (!t._aiChatbotExcluded) {
    const cfg = t.db.getConfig();
    t._aiChatbotExcluded = new Set(Array.isArray(cfg.aiChatbotExcluded) ? cfg.aiChatbotExcluded : []);
  }
  return t._aiChatbotExcluded;
}

// Move o atendimento pra humano: pausa a IA (mesmo sinal do Auto Atendimento) e
// marca "precisa de atendimento humano", que já aparece no alerta existente com o
// botão "Resolver / reativar bot" — nenhuma tela nova precisou ser criada pra isso.
const AI_LABEL_POSITIVO = '🟢 Quer visita (confirmar data)';
const AI_LABEL_NEGATIVO = '🔴 Sem interesse';

// Acha a coluna "Atender Lead" (ou variação do nome) dentro do MESMO funil do card, pra
// mover o lead pra lá quando o resultado é positivo. Funciona em qualquer tenant que tenha
// uma coluna com esse nome — se não tiver, só não move (continua só com a etiqueta).
function findAtenderLeadColumn(t, funnelId) {
  const cols = t.db.getCrmColumns().filter(c => String(c.funnelId || 'default') === String(funnelId || 'default'));
  return cols.find(c => /atender\s*lead/i.test(c.name || '')) || null;
}

function doAiHandoff(t, storageJid, digits, reason) {
  t.db.setNeedsHuman(storageJid, true, reason || 'IA identificou que precisa de atendimento humano');
  t.db.setBotPaused(storageJid, true);
}

// Memória do negócio pro atendente de IA: um único bloco COMPARTILHADO entre todos os
// leads (nunca por pessoa — fato aprendido numa conversa não pode vazar pra outra). Cap bem
// mais curto que a memória do Agente porque isso é injetado em toda mensagem de todo lead,
// não só nos comandos do dono — cada entrada a mais pesa no custo de TODAS as conversas.
const BUSINESS_MEMORY_MAX_ENTRIES = 40;
function saveBusinessMemory(t, fact) {
  const clean = String(fact || '').trim().slice(0, 300);
  if (!clean) return;
  const cfg = t.db.getConfig();
  const mem = (Array.isArray(cfg.businessMemory) ? cfg.businessMemory : []).concat([{ text: clean, at: Date.now() }]);
  t.db.updateConfig({ businessMemory: mem.slice(-BUSINESS_MEMORY_MAX_ENTRIES) });
}

const AI_REPLY_DEBOUNCE_MS = 6000; // espera o lead parar de digitar antes de responder (nao fala por cima) — default; config aiReplyDelaySec sobrescreve por tenant
function aiReplyDebounceMs(t) {
  const sec = Number((t.db.getConfig() || {}).aiReplyDelaySec);
  return (Number.isFinite(sec) && sec > 0) ? Math.round(sec * 1000) : AI_REPLY_DEBOUNCE_MS;
}
function scheduleAiChatbotReply(t, contactId, digits, connectionId) {
  if (!t._aiReplyTimers) t._aiReplyTimers = {};
  if (t._aiReplyTimers[contactId]) clearTimeout(t._aiReplyTimers[contactId]);
  t._aiReplyTimers[contactId] = setTimeout(() => {
    delete t._aiReplyTimers[contactId];
    try { if (t.db.getContactBotState(contactId).botPaused) return; } catch (e) {}
    handleAiChatbotReply(t, contactId, digits, connectionId).catch(err => console.error(`[${t.clientId}] AI chatbot:`, err.message));
  }, aiReplyDebounceMs(t));
}
async function handleAiChatbotReply(t, contactId, digits, connectionId) {
  const cfg = t.db.getConfig();
  const apiKey = cfg.anthropicApiKey;
  if (!apiKey) return;
  const messages = t.db.getMessages(contactId);
  if (!messages.length) return;
  const _startTs = messages.length ? (messages[messages.length - 1].timestamp || 0) : 0;
  // Nome do lead pro tom ficar mais pessoal — pega da última mensagem recebida com nome
  // real (ignora quando o WhatsApp não resolveu nome nenhum e caiu no próprio número).
  const leadNameRaw = [...messages].reverse().find(m => m.direction === 'in' && m.contactName)?.contactName || '';
  const leadName = (leadNameRaw && !/^\d{5,}$/.test(leadNameRaw) && !leadNameRaw.includes('@')) ? leadNameRaw.trim() : '';
  const businessMemory = Array.isArray(cfg.businessMemory) ? cfg.businessMemory : [];
  const memoryBlock = businessMemory.length ? `\n\nCoisas que você já aprendeu sobre este negócio em conversas anteriores (vale pra qualquer lead, não só este):\n${businessMemory.map(m => '- ' + m.text).join('\n')}` : '';
  const systemPrompt = `Você é um assistente de atendimento ao cliente. Hoje é ${brTodayLabel(Date.now())} e agora são ${brNowHM()} (horário de Brasília).${leadName ? ` O nome do lead é ${leadName} — trate-o pelo nome quando fizer sentido (ex: no cumprimento inicial ou ao retomar a conversa), sem exagerar repetindo o nome toda hora.` : ''}${cfg.aiBusinessContext ? ' Contexto do negócio: ' + cfg.aiBusinessContext : ''} Responda de forma natural, amigável e concisa em português. Seja direto e útil. Nunca revele que você é uma IA a menos que diretamente perguntado.

Formatação: isso vai direto pro WhatsApp, que usa *um asterisco* pra negrito, não **dois** (Markdown normal). Nunca use \`**texto**\` — ou usa \`*texto*\` ou não usa negrito nenhum.

Quando o cliente manda uma foto, áudio ou outro arquivo, você NÃO consegue ver o conteúdo — só sabe que algo foi enviado (aparece como algo do tipo "[foto enviada]" na conversa). Trate isso como uma resposta válida à sua última pergunta, a menos que o contexto do negócio diga o contrário ou realmente precise de confirmação por texto.

Se o lead já demonstrou pronto pra falar com um humano — confirmou agendamento/visita, pediu preço fechado, pediu explicitamente por atendente, ou fez pergunta que você não tem certeza de responder — termine sua resposta, numa linha separada no final, com: [HANDOFF: motivo breve]. Use isso só quando fizer sentido encerrar o atendimento automático ali, não em toda mensagem.

Marque também, em outra linha separada no final: [RESULTADO: positivo] assim que o lead confirmar que SIM, quer seguir em frente (ex: topou a visita/agendamento) — mesmo que você ainda pretenda fazer mais perguntas de qualificação depois, marque positivo no exato momento em que ele disser sim, não espere uma segunda confirmação. Marque [RESULTADO: negativo] se ele disser claramente que não tem interesse ou não quer continuar. Não use nenhuma das duas se a resposta dele ainda for ambígua — a maioria das mensagens não deve ter essa tag.

Se aprender algo sobre o NEGÓCIO em si (não sobre esse lead específico) que vale lembrar em qualquer conversa futura — uma regra, um preço, uma política, uma correção do dono — marque numa linha separada no final: [MEMORIZAR: o fato, de forma objetiva]. Use raramente, só pra fatos genuinamente reutilizáveis; nunca guarde dado pessoal de um lead (nome, telefone, endereço) aqui.${memoryBlock}`;
  // Foto/áudio sem legenda fica com texto vazio no banco (fica só a miniatura no Chat ao
  // vivo) — sem esse placeholder a IA nem percebia que algo tinha chegado, a mensagem
  // simplesmente sumia da conversa que ela enxerga.
  const mediaPlaceholder = { image: '[foto enviada]', video: '[vídeo enviado]', audio: '[áudio enviado]', document: '[arquivo enviado]', sticker: '[figurinha enviada]' };
  const claudeMessages = messages.slice(-20)
    .map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text || (m.mediaType ? (mediaPlaceholder[m.mediaType] || '[mídia enviada]') : '') }))
    .filter(m => m.content);
  if (!claudeMessages.length) return;
  // Ensure first message is from user
  while (claudeMessages.length && claudeMessages[0].role === 'assistant') claudeMessages.shift();
  if (!claudeMessages.length) return;
  const rawReply = await callAnthropicApi(apiKey, claudeMessages, systemPrompt, cfg.aiModel);
  if (!rawReply) return;
  // Chegou mensagem nova enquanto a IA pensava? Nao responde por cima.
  try {
    const _mn = t.db.getMessages(contactId) || [];
    const _novas = _mn.filter(m => (m.timestamp || 0) > _startTs);
    if (_novas.length) {
      // Um HUMANO (Dr. Gustavo/atendente) respondeu -> a IA nao envia e pausa (humano assumiu).
      if (_novas.some(m => m.direction === 'out')) { try { pauseBotForContact(t, contactId); } catch (e) {} return; }
      // So o lead mandou msg nova -> reagenda pra depois que ele parar de digitar.
      scheduleAiChatbotReply(t, contactId, digits, connectionId); return;
    }
  } catch (e) {}
  const handoffMatch = rawReply.match(/\[HANDOFF:\s*([^\]]*)\]/i);
  const resultMatch = rawReply.match(/\[RESULTADO:\s*(positivo|negativo)\]/i);
  const memorizeMatch = rawReply.match(/\[MEMORIZAR:\s*([^\]]*)\]/i);
  const escMatch = (cfg.aiEscalation && cfg.aiEscalation.notifyNumber) ? rawReply.match(/\[FLAGRANTE(?::\s*([^\]]*))?\]/i) : null;
  let reply = rawReply;
  if (handoffMatch) reply = reply.replace(handoffMatch[0], '');
  if (resultMatch) reply = reply.replace(resultMatch[0], '');
  if (memorizeMatch) { reply = reply.replace(memorizeMatch[0], ''); saveBusinessMemory(t, memorizeMatch[1]); }
  if (escMatch) reply = reply.replace(escMatch[0], '');
  reply = reply.trim();
  if (!reply) return;
  // sendWithTyping/sendAutoReplyText já sabem mandar por web, lite/lite2 ou cloud —
  // igual o Auto Atendimento usa, então a IA funciona em qualquer canal conectado.
  await sendWithTyping(t, contactId, digits || digitsFromJid(contactId), reply, connectionId, 2, null, 'IA');
  // Escalação (config-driven): flagrante/urgência -> avisa o número responsável (ex.: Dr. Gustavo)
  try {
    const _esc = cfg.aiEscalation;
    if (escMatch && _esc && _esc.notifyNumber) {
      const _leadNum = (digits || digitsFromJid(contactId) || '').replace(/\D/g, '');
      const _reason = (escMatch[1] || '').trim();
      const _nome = leadName || 'Sem nome';
      const _g = String(_esc.notifyNumber).replace(/\D/g, '');
      const _alerta = `🚨 *FLAGRANTE / URGENTE*\nUm lead pediu atendimento imediato no WhatsApp.\n\n👤 ${_nome}\n📱 +${_leadNum}  ·  wa.me/${_leadNum}${_reason ? '\n📝 ' + _reason : ''}\n\n_Aviso automático do atendimento._`;
      if (_esc.viaAgente) {
        await evoReq('POST', `/message/sendText/${agentInstanceName(t)}`, { number: _g, text: _alerta });
      } else {
        await sendWithTyping(t, _g + '@s.whatsapp.net', _g, _alerta, connectionId, 0, null, 'Atendimento');
      }
    }
  } catch (e) { console.error('[' + t.clientId + '] escalacao flagrante falhou:', e.message); }
  // Todo RESULTADO (positivo ou negativo) encerra o ciclo automático — é o "chegou numa
  // conclusão" que a IA não deveria continuar puxando assunto sozinha depois disso, mesmo
  // que ela não tenha marcado [HANDOFF] explicitamente na mesma resposta.
  if (handoffMatch) {
    doAiHandoff(t, contactId, digits, handoffMatch[1].trim());
    // Candidatura a vaga: move o card pra coluna de emprego (config aiVagaColumnId).
    try {
      const _cfgV = t.db.getConfig() || {};
      if (_cfgV.aiVagaColumnId && /vaga|emprego|curr[i\u00ed]culo|candidat/i.test(handoffMatch[1] || '')) {
        const _cv = findCrmCardForChat(t, contactId);
        if (_cv) { const _col = (t.db.getCrmColumns() || []).find(c => String(c.id) === String(_cfgV.aiVagaColumnId)); const _upd = { columnId: _cfgV.aiVagaColumnId }; if (_col && _col.funnelId) _upd.funnelId = _col.funnelId; t.db.updateCrmCard(_cv.id, _upd); }
      }
    } catch (e) {}
  }
  else if (resultMatch) doAiHandoff(t, contactId, digits, resultMatch[1].toLowerCase() === 'positivo' ? 'Lead qualificado, aguardando confirmação de data' : 'Lead sem interesse');
  // Etiqueta o card com o resultado da qualificação — é isso que aparece no Chat ao vivo
  // (e dá pra filtrar por etiqueta) pra equipe saber quem deu positivo/negativo depois.
  if (resultMatch) {
    const cardForResult = findCrmCardForChat(t, contactId);
    if (cardForResult) {
      const isPositivo = resultMatch[1].toLowerCase() === 'positivo';
      const labelText = isPositivo ? AI_LABEL_POSITIVO : AI_LABEL_NEGATIVO;
      const updateFields = { labels: [labelText] };
      // Além da etiqueta: se o resultado foi positivo, joga o lead pra coluna "Atender
      // Lead" do mesmo funil (se existir) — pedido explícito além do que já funcionava.
      if (isPositivo) {
        const atenderCol = findAtenderLeadColumn(t, cardForResult.funnelId);
        if (atenderCol && atenderCol.id !== cardForResult.columnId) updateFields.columnId = atenderCol.id;
      }
      t.db.updateCrmCard(cardForResult.id, updateFields);
    }
  }
}

// ─── Recording replies ──────────────────────────────────────

async function recordIncomingReply(t, { recipientId, senderId, senderName, replyText, isGroup, connectionId }) {
  if (!replyText) return;
  const connId = connectionId || (t.provider === 'cloud' ? 'cloud1' : 'web');
  if (!isGroup) t.db.recordMessage({ direction: 'in', contactId: senderId, contactName: senderName || senderId, text: replyText, connectionId: connId });
  const recentLogs = t.db.getRecentLogsForRecipient(recipientId);
  for (const log of recentLogs) {
    const matched = (log.quickReplies || []).find(q => q.toLowerCase() === replyText.toLowerCase());
    if (!matched) continue;
    t.db.recordResponse({ scheduleId: log.scheduleId, senderId, senderName: senderName || senderId, recipientId, recipientName: log.recipientName, reply: replyText, matchedButton: matched, responseTimeMs: Date.now() - log.sentAt });
    break;
  }
}

// ══════════════════════════════════════════════════════════════
// ─── Routes ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Auth routes (sem requireAuth)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const clients = loadClients();
  const found = clients.find(c => c.username === username && c.password === password);
  if (!found) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = createToken(found);
  const dataClientId = found.ownerClientId || found.id;
  res.json({ ok: true, token, clientId: dataClientId, loginId: found.id, clientName: found.name, admin: !!found.admin && !found.ownerClientId, defaultConnectionId: found.defaultConnectionId || null, chatConnectionId: found.chatConnectionId || found.defaultConnectionId || null, broadcastConnectionId: found.broadcastConnectionId || null, personalWaba: found.personalWaba ? { phoneNumberId: found.personalWaba.phoneNumberId, displayPhone: found.personalWaba.displayPhone || '', connected: true } : null, permissions: { features: getUserFeatures(found), workspaceSpaces: found.permissions?.workspaceSpaces || [], workspaceAdmin: !!found.permissions?.workspaceAdmin } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const found = req.user;
  if (!found) return res.status(401).json({ error: 'Cliente não encontrado' });
  res.json({ clientId: req.clientId, loginId: found.id, clientName: found.name, admin: !!found.admin && !found.ownerClientId, defaultConnectionId: found.defaultConnectionId || null, chatConnectionId: found.chatConnectionId || found.defaultConnectionId || null, broadcastConnectionId: found.broadcastConnectionId || null, personalWaba: found.personalWaba ? { phoneNumberId: found.personalWaba.phoneNumberId, displayPhone: found.personalWaba.displayPhone || '', connected: true } : null, permissions: { features: getUserFeatures(found), workspaceSpaces: found.permissions?.workspaceSpaces || [], workspaceAdmin: !!found.permissions?.workspaceAdmin } });
});

// WhatsApp Cloud Embedded Signup
function getMetaEmbeddedConfig() {
  return {
    appId: process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '',
    configId: process.env.WA_EMBEDDED_CONFIG_ID || process.env.META_EMBEDDED_CONFIG_ID || '',
    graphVersion: GRAPH_API_VERSION
  };
}

function missingEmbeddedFields() {
  const cfg = getMetaEmbeddedConfig();
  const missing = [];
  if (!cfg.appId) missing.push('META_APP_ID');
  if (!cfg.configId) missing.push('WA_EMBEDDED_CONFIG_ID');
  if (!process.env.META_APP_SECRET && !process.env.FACEBOOK_APP_SECRET) missing.push('META_APP_SECRET');
  return missing;
}

async function exchangeEmbeddedSignupCode(code) {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '';
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';
  const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  if (process.env.WA_EMBEDDED_REDIRECT_URI) body.set('redirect_uri', process.env.WA_EMBEDDED_REDIRECT_URI);
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, { method: 'POST', body });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || !data.access_token) throw new Error(data?.error?.message || data?.raw || 'Meta nao retornou access_token.');

  // Tenta estender para token de longa duração (~60 dias)
  try {
    const extRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${data.access_token}`);
    const extData = await extRes.json();
    if (extData.access_token) {
      data.access_token = extData.access_token;
      data.expires_in = extData.expires_in || data.expires_in;
      console.log('[meta] Token estendido para longa duracao:', extData.expires_in, 'segundos');
    }
  } catch (e) { console.warn('[meta] Nao foi possivel estender token:', e.message); }

  return data;
}

async function debugMetaToken(token) {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '';
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';
  if (!appId || !appSecret || !token) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${appId}|${appSecret}`);
    const data = await res.json();
    const d = data?.data;
    if (!d) return null;
    return {
      isValid: d.is_valid !== false,
      expiresAt: d.expires_at === 0 ? null : (d.expires_at ? d.expires_at * 1000 : null),
      neverExpires: d.expires_at === 0,
      type: d.type || null,
    };
  } catch { return null; }
}

app.get('/api/cloud/embedded-config', requireAuth, requireFeature('config'), (req, res) => {
  const t = getTenant(req.clientId);
  res.json({ ...getMetaEmbeddedConfig(), missing: missingEmbeddedFields(), webhookUrl: `${req.protocol}://${req.get('host')}/webhook/${req.clientId}`, verifyToken: t.WA_VERIFY_TOKEN });
});

app.post('/api/cloud/embedded-signup', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  console.log('[' + t.clientId + '] embedded-signup IN: keys=' + Object.keys(req.body||{}).join(',') + ' code=' + !!(req.body&&req.body.code) + ' phoneId=' + ((req.body&&(req.body.phoneNumberId||req.body.phone_number_id))||'-') + ' waba=' + ((req.body&&(req.body.wabaId||req.body.waba_id))||'-'));
  const missing = missingEmbeddedFields();
  if (missing.length) return res.status(400).json({ error: `Configure no servidor: ${missing.join(', ')}` });
  const code = String(req.body?.code || '').trim();
  const phoneNumberId = String(req.body?.phoneNumberId || req.body?.phone_number_id || '').trim();
  const wabaId = String(req.body?.wabaId || req.body?.waba_id || '').trim();
  const businessId = String(req.body?.businessId || req.body?.business_id || '').trim();
  const slot = String(req.body?.slot || '1');
  if (!code) return res.status(400).json({ error: 'Meta nao retornou o codigo de autorizacao.' });
  if (!phoneNumberId) return res.status(400).json({ error: 'Meta nao retornou o phone_number_id. Selecione um WhatsApp no popup.' });
  try {
    const tokenData = await exchangeEmbeddedSignupCode(code);
    let phoneInfo = {};
    try { phoneInfo = await graphRequestWithToken(tokenData.access_token, `/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`); } catch {}
    if (wabaId) {
      // Webhook POR-CLIENTE: cada WABA manda os eventos pro subdomínio do próprio cliente
      // (override_callback_uri), garantindo isolamento — sem isso tudo cai na URL única do app.
      try {
        const overrideUrl = `https://${req.get('host')}/webhook/${t.clientId}`;
        await graphRequestWithToken(tokenData.access_token, `/${wabaId}/subscribed_apps`, { method: 'POST', json: { override_callback_uri: overrideUrl, verify_token: t.WA_VERIFY_TOKEN } });
      } catch (e) { console.warn(`[${t.clientId}] Nao foi possivel assinar webhook do WABA:`, e.message); }
    }
    if (!/^[1-5]$/.test(slot)) return res.status(400).json({ error: 'Posição de conexão inválida.' });
    const saved = saveCloudSlot(t, slot, { accessToken: tokenData.access_token, phoneNumberId, wabaId, displayPhone: phoneInfo.display_phone_number || '' });
    if (slot === '1') {
      t.db.updateConfig({ provider: 'cloud', WA_BUSINESS_ID: businessId, WA_VERIFY_TOKEN: t.WA_VERIFY_TOKEN });
      t.provider = 'cloud'; t.WA_BUSINESS_ID = businessId;
    }
    res.json({ ok: true, slot, phoneNumberId, wabaId, businessId, displayPhoneNumber: saved.displayPhone });
  } catch (e) {
    console.error('[' + t.clientId + '] embedded-signup ERRO:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Multi-connections API ───────────────────────────────────

app.get('/api/connections', requireAuth, requireFeature('config'), (req, res) => {
  res.json(getConnectionsPayload(getTenant(req.clientId)));
});

// Cloud 2 — Embedded Signup
app.post('/api/connections/cloud2/embedded-signup', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const missing = missingEmbeddedFields();
  if (missing.length) return res.status(400).json({ error: `Configure no servidor: ${missing.join(', ')}` });
  const code = String(req.body?.code || '').trim();
  const phoneNumberId = String(req.body?.phoneNumberId || req.body?.phone_number_id || '').trim();
  const wabaId = String(req.body?.wabaId || req.body?.waba_id || '').trim();
  if (!code) return res.status(400).json({ error: 'Meta nao retornou o codigo de autorizacao.' });
  if (!phoneNumberId) return res.status(400).json({ error: 'Meta nao retornou o phone_number_id. Selecione um WhatsApp no popup.' });
  try {
    const tokenData = await exchangeEmbeddedSignupCode(code);
    let phoneInfo = {};
    try { phoneInfo = await graphRequestWithToken(tokenData.access_token, `/${phoneNumberId}?fields=display_phone_number,verified_name`); } catch {}
    if (wabaId) {
      try {
        const overrideUrl = `https://${req.get('host')}/webhook/${t.clientId}`;
        await graphRequestWithToken(tokenData.access_token, `/${wabaId}/subscribed_apps`, { method: 'POST', json: { override_callback_uri: overrideUrl, verify_token: t.WA_VERIFY_TOKEN } });
      } catch {}
    }
    const fields = { WA_ACCESS_TOKEN_2: tokenData.access_token, WA_PHONE_NUMBER_ID_2: phoneNumberId, WA_WABA_ID_2: wabaId, WA_DISPLAY_PHONE_NUMBER_2: phoneInfo.display_phone_number || '' };
    t.db.updateConfig(fields);
    t.WA_ACCESS_TOKEN_2 = fields.WA_ACCESS_TOKEN_2;
    t.WA_PHONE_NUMBER_ID_2 = fields.WA_PHONE_NUMBER_ID_2;
    t.WA_WABA_ID_2 = fields.WA_WABA_ID_2;
    t.WA_DISPLAY_PHONE_NUMBER_2 = fields.WA_DISPLAY_PHONE_NUMBER_2;
    res.json({ ok: true, phoneNumberId, wabaId, displayPhoneNumber: fields.WA_DISPLAY_PHONE_NUMBER_2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cloud 2 — manual config
app.post('/api/connections/cloud2/configure', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const phoneNumberId = String(req.body?.phoneNumberId || '').trim();
  const accessToken = String(req.body?.accessToken || '').trim();
  if (!phoneNumberId || !accessToken) return res.status(400).json({ error: 'phoneNumberId e accessToken sao obrigatorios.' });
  let displayPhone = '';
  try { const info = await graphRequestWithToken(accessToken, `/${phoneNumberId}?fields=display_phone_number`); displayPhone = info.display_phone_number || ''; } catch {}
  const fields = { WA_ACCESS_TOKEN_2: accessToken, WA_PHONE_NUMBER_ID_2: phoneNumberId, WA_DISPLAY_PHONE_NUMBER_2: displayPhone };
  t.db.updateConfig(fields);
  t.WA_ACCESS_TOKEN_2 = accessToken;
  t.WA_PHONE_NUMBER_ID_2 = phoneNumberId;
  t.WA_DISPLAY_PHONE_NUMBER_2 = displayPhone;
  res.json({ ok: true, displayPhone });
});

// Cloud 1 — disconnect
app.delete('/api/connections/cloud1', requireAuth, requireFeature('config'), (req, res) => {
  const t = getTenant(req.clientId);
  t.WA_ACCESS_TOKEN = ''; t.WA_PHONE_NUMBER_ID = ''; t.WA_DISPLAY_PHONE_NUMBER = ''; t.WA_WABA_ID = ''; t.WA_BUSINESS_ID = '';
  t.db.updateConfig({ WA_ACCESS_TOKEN: '', WA_PHONE_NUMBER_ID: '', WA_DISPLAY_PHONE_NUMBER: '', WA_WABA_ID: '', WA_BUSINESS_ID: '' });
  res.json({ ok: true });
});

// Cloud 2 — disconnect
app.delete('/api/connections/cloud2', requireAuth, requireFeature('config'), (req, res) => {
  const t = getTenant(req.clientId);
  t.WA_ACCESS_TOKEN_2 = ''; t.WA_PHONE_NUMBER_ID_2 = ''; t.WA_DISPLAY_PHONE_NUMBER_2 = ''; t.WA_WABA_ID_2 = '';
  t.db.updateConfig({ WA_ACCESS_TOKEN_2: '', WA_PHONE_NUMBER_ID_2: '', WA_DISPLAY_PHONE_NUMBER_2: '', WA_WABA_ID_2: '' });
  res.json({ ok: true });
});

// Cloud 3 — manual token configure
app.post('/api/connections/cloud3/configure', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const phoneNumberId = String(req.body?.phoneNumberId || '').trim();
  const accessToken = String(req.body?.accessToken || '').trim();
  if (!phoneNumberId || !accessToken) return res.status(400).json({ error: 'phoneNumberId e accessToken são obrigatórios.' });
  let displayPhone = '';
  try { const info = await graphRequestWithToken(accessToken, `/${phoneNumberId}?fields=display_phone_number`); displayPhone = info.display_phone_number || ''; } catch {}
  const fields = { WA_ACCESS_TOKEN_3: accessToken, WA_PHONE_NUMBER_ID_3: phoneNumberId, WA_DISPLAY_PHONE_NUMBER_3: displayPhone };
  t.db.updateConfig(fields);
  t.WA_ACCESS_TOKEN_3 = accessToken;
  t.WA_PHONE_NUMBER_ID_3 = phoneNumberId;
  t.WA_DISPLAY_PHONE_NUMBER_3 = displayPhone;
  res.json({ ok: true, displayPhone });
});

// Cloud 3 — disconnect
app.delete('/api/connections/cloud3', requireAuth, requireFeature('config'), (req, res) => {
  const t = getTenant(req.clientId);
  t.WA_ACCESS_TOKEN_3 = ''; t.WA_PHONE_NUMBER_ID_3 = ''; t.WA_DISPLAY_PHONE_NUMBER_3 = ''; t.WA_WABA_ID_3 = '';
  t.db.updateConfig({ WA_ACCESS_TOKEN_3: '', WA_PHONE_NUMBER_ID_3: '', WA_DISPLAY_PHONE_NUMBER_3: '', WA_WABA_ID_3: '' });
  res.json({ ok: true });
});

app.delete('/api/connections/cloud/:slot', requireAuth, requireFeature('config'), (req, res) => {
  const slot = String(req.params.slot || '');
  if (!/^[1-5]$/.test(slot)) return res.status(400).json({ error: 'Posição inválida.' });
  const t = getTenant(req.clientId);
  saveCloudSlot(t, slot, { accessToken: '', phoneNumberId: '', wabaId: '', displayPhone: '' });
  res.json({ ok: true, slot });
});

// Token status (debug via Meta API)
app.get('/api/cloud/token-status', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const slot = String(req.query.slot || '1');
  const token = getCloudSlot(t, slot).accessToken;
  if (!token) return res.json({ configured: false });
  const info = await debugMetaToken(token);
  if (!info) return res.json({ configured: true, checkFailed: true });
  const now = Date.now();
  const daysLeft = info.expiresAt ? Math.ceil((info.expiresAt - now) / 86400000) : null;
  res.json({ configured: true, ...info, daysLeft });
});

// Le os ativos do negocio (WABA) usando business_management / whatsapp_business_management.
// Endpoint usado na tela de Configuracoes para demonstrar visualmente o uso da permissao:
// busca o nome do WhatsApp Business Account e a lista de numeros vinculados.
app.get('/api/cloud/business-assets', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const slot = String(req.query.slot || '1');
  const creds = getTemplateCloudCreds(t, slot);
  if (!creds.accessToken) return res.status(400).json({ error: 'No official connection configured for this slot.' });
  if (!creds.wabaId) return res.status(400).json({ error: 'WABA ID not available. Reconnect via the Meta popup.' });
  try {
    const waba = await graphRequestWithToken(creds.accessToken, `/${creds.wabaId}?fields=id,name,timezone_id,message_template_namespace`);
    let phoneNumbers = [];
    try {
      const pn = await graphRequestWithToken(creds.accessToken, `/${creds.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`);
      phoneNumbers = Array.isArray(pn?.data) ? pn.data : [];
    } catch (e) { console.warn(`[${t.clientId}] business-assets phone_numbers:`, e.message); }
    res.json({
      ok: true,
      wabaId: waba.id || creds.wabaId,
      businessName: waba.name || '',
      timezoneId: waba.timezone_id || '',
      phoneNumbers: phoneNumbers.map(p => ({
        id: p.id,
        displayPhoneNumber: p.display_phone_number || '',
        verifiedName: p.verified_name || '',
        qualityRating: p.quality_rating || ''
      }))
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to read business assets from Meta.' });
  }
});

// Atualizar token de qualquer slot cloud (sem refazer Embedded Signup)
app.post('/api/connections/cloud1/update-token', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const accessToken = String(req.body?.accessToken || '').trim();
  if (!accessToken) return res.status(400).json({ error: 'accessToken obrigatorio' });
  t.db.updateConfig({ WA_ACCESS_TOKEN: accessToken });
  t.WA_ACCESS_TOKEN = accessToken;
  res.json({ ok: true });
});

app.post('/api/connections/cloud2/update-token', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const accessToken = String(req.body?.accessToken || '').trim();
  if (!accessToken) return res.status(400).json({ error: 'accessToken obrigatorio' });
  t.db.updateConfig({ WA_ACCESS_TOKEN_2: accessToken });
  t.WA_ACCESS_TOKEN_2 = accessToken;
  res.json({ ok: true });
});

app.post('/api/connections/cloud3/update-token', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const accessToken = String(req.body?.accessToken || '').trim();
  if (!accessToken) return res.status(400).json({ error: 'accessToken obrigatorio' });
  t.db.updateConfig({ WA_ACCESS_TOKEN_3: accessToken });
  t.WA_ACCESS_TOKEN_3 = accessToken;
  res.json({ ok: true });
});

// Groups Baileys — connect / status
app.post('/api/connections/groups/connect', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  if (!t.waGroupClient) initGroupBaileysClient(t).catch(e => console.error(`[${t.clientId}][grupos] init error:`, e.message));
  res.json({ ok: true, bootState: t.groupSessionState });
});

app.get('/api/connections/groups/status', requireAuth, requireFeature('config'), (req, res) => {
  const t = getTenant(req.clientId);
  res.json({ connected: t.isGroupReady, bootState: t.groupSessionState, qr: t.groupQrCode, pairingCode: t.groupPairingCode });
});

app.post('/api/connections/groups/pairing-code', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  const phone = String(req.body?.phoneNumber || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phoneNumber obrigatorio.' });
  t.groupPairPhone = phone;
  if (!t.waGroupClient) initGroupBaileysClient(t).catch(e => console.error(`[${t.clientId}][grupos] init error:`, e.message));
  res.json({ ok: true });
});

app.post('/api/connections/groups/reset', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  t.isGroupReady = false; t.groupQrCode = null; t.groupPairingCode = null; t.groupSessionState = 'idle';
  if (t.waGroupClient) { try { t.waGroupClient.end(new Error('reset')); } catch {} t.waGroupClient = null; }
  await new Promise(r => setTimeout(r, 1000));
  initGroupBaileysClient(t).catch(e => console.error(`[${t.clientId}][grupos] reset error:`, e.message));
  res.json({ ok: true });
});

app.delete('/api/connections/groups', requireAuth, requireFeature('config'), async (req, res) => {
  const t = getTenant(req.clientId);
  if (t.waGroupClient) { try { t.waGroupClient.end(new Error('disconnect')); } catch {} t.waGroupClient = null; }
  t.isGroupReady = false; t.groupQrCode = null; t.groupSessionState = 'idle';
  const authDir = getGroupAuthDir(t);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// Extra Baileys slots (web2, web3)
app.post('/api/connections/:slot/connect', requireAuth, requireFeature('config'), async (req, res) => {
  const { slot } = req.params;
  if (!EXTRA_BAILEYS_SLOTS[slot]) return res.status(400).json({ error: 'Slot invalido' });
  const t = getTenant(req.clientId);
  const s = EXTRA_BAILEYS_SLOTS[slot];
  if (!t[s.clientKey]) initExtraBaileysClient(t, slot).catch(e => console.error(`[${t.clientId}][${slot}] init error:`, e.message));
  res.json({ ok: true, bootState: t[s.stateKey] });
});

app.get('/api/connections/:slot/status', requireAuth, requireFeature('config'), (req, res) => {
  const { slot } = req.params;
  if (!EXTRA_BAILEYS_SLOTS[slot]) return res.status(400).json({ error: 'Slot invalido' });
  const t = getTenant(req.clientId);
  const s = EXTRA_BAILEYS_SLOTS[slot];
  res.json({ connected: t[s.readyKey], bootState: t[s.stateKey], qr: t[s.qrKey], pairingCode: t[s.codeKey] });
});

app.post('/api/connections/:slot/pairing-code', requireAuth, requireFeature('config'), async (req, res) => {
  const { slot } = req.params;
  if (!EXTRA_BAILEYS_SLOTS[slot]) return res.status(400).json({ error: 'Slot invalido' });
  const t = getTenant(req.clientId);
  const phone = String(req.body?.phoneNumber || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phoneNumber obrigatorio.' });
  const s = EXTRA_BAILEYS_SLOTS[slot];
  t[s.phoneKey] = phone;
  if (!t[s.clientKey]) initExtraBaileysClient(t, slot).catch(e => console.error(`[${t.clientId}][${slot}] init error:`, e.message));
  res.json({ ok: true });
});

app.post('/api/connections/:slot/reset', requireAuth, requireFeature('config'), async (req, res) => {
  const { slot } = req.params;
  if (!EXTRA_BAILEYS_SLOTS[slot]) return res.status(400).json({ error: 'Slot invalido' });
  const t = getTenant(req.clientId);
  const s = EXTRA_BAILEYS_SLOTS[slot];
  t[s.readyKey] = false; t[s.qrKey] = null; t[s.codeKey] = null; t[s.stateKey] = 'idle';
  if (t[s.clientKey]) { try { t[s.clientKey].end(new Error('reset')); } catch {} t[s.clientKey] = null; }
  await new Promise(r => setTimeout(r, 1000));
  initExtraBaileysClient(t, slot).catch(e => console.error(`[${t.clientId}][${slot}] reset error:`, e.message));
  res.json({ ok: true });
});

app.delete('/api/connections/:slot', requireAuth, requireFeature('config'), async (req, res) => {
  const { slot } = req.params;
  if (!EXTRA_BAILEYS_SLOTS[slot]) return res.status(400).json({ error: 'Slot invalido' });
  const t = getTenant(req.clientId);
  const s = EXTRA_BAILEYS_SLOTS[slot];
  if (t[s.clientKey]) { try { t[s.clientKey].end(new Error('disconnect')); } catch {} t[s.clientKey] = null; }
  t[s.readyKey] = false; t[s.qrKey] = null; t[s.stateKey] = 'idle';
  const authDir = path.join(BAILEYS_AUTH_BASE, t.clientId + s.authSuffix);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// WhatsApp connect trigger
app.use('/api/schedules', requireAuth, requireAnyFeature(['schedule','pending']));
app.use('/api/logs', requireAuth, requireFeature('logs'));
app.use('/api/reports', requireAuth, requireFeature('reports'));
app.use('/api/metrics', requireAuth, requireFeature('reports'));
app.use('/api/templates', requireAuth, requireFeature('templates'));
app.use('/api/chat', requireAuth, requireFeature('chat'));
app.use('/api/funnels', requireAuth, requireFeature('crm'));
// Lista de usuários do time (só id/nome/admin) — fica FORA do bloqueio de feature 'crm'
// abaixo de propósito: é usada também pelo seletor de "Responsável" da Área de Clientes
// (feature 'clientarea'), então um usuário sem a feature 'crm' (ex: só workspace+clientarea)
// não pode tomar 403 aqui, senão a tela de nova tarefa quebra ao montar esse campo.
app.get('/api/crm/users', requireAuth, (req, res) => {
  const own = String(req.clientId || '');
  const out = loadClients()
    .filter(c => c.id === own || c.ownerClientId === own)
    .map(c => ({ id: c.id, name: c.name || c.username || c.id, admin: !!c.admin && !c.ownerClientId }));
  res.json(out);
});
app.use('/api/crm', requireAuth, requireFeature('crm'));
app.use('/api/prospects', requireAuth, requireFeature('prospects'));
app.use('/api/consultants', requireAuth, requireFeature('queue'));
app.use('/api/config', requireAuth, requireFeature('config'));

app.post('/api/connect', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  ensureWebClient(t);
  res.json({ ok: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  res.json(getStatusPayload(t));
});

app.get('/api/debug/ack', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const pending = [...(t._pendingMsgAcks || new Map()).entries()].map(([id]) => id);
  res.json({
    pendingAcks: pending.length,
    pendingIds: pending,
    reachoutLocked: !!t.reachoutLocked,
    reachoutLockedUntil: t.reachoutLockedUntil || null,
    baileysHealth: t.baileysConnectionHealth || {},
    isReady: t.isReady,
    isGroupReady: t.isGroupReady,
  });
});

app.get('/api/debug/lids', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const lidContacts = t.contacts.filter(c => c.lid);
  const lidMap = t.db.getAllLidMappings ? t.db.getAllLidMappings() : [];
  res.json({ lidContacts, lidMap, totalContacts: t.contacts.length });
});

// ─── Admin: gerenciamento de usuários ──────────────────────

app.get('/api/admin/clients', requireAuth, requireAdmin, (req, res) => {
  const clients = loadClients();
  res.json(clients.filter(c => !c.ownerClientId || c.ownerClientId === req.clientId).map(c => ({ id: c.id, name: c.name, username: c.username, admin: !!c.admin, invited: !!c.ownerClientId, permissions: c.permissions || null })));
});

app.post('/api/admin/clients', requireAuth, requireAdmin, (req, res) => {
  const { name, username, password } = req.body || {};
  // 'equipe' = pessoa que trabalha nesta conta (com permissoes). 'cliente' = nova empresa/tenant.
  const tipo = (req.body && req.body.tipo) === 'equipe' ? 'equipe' : 'cliente';
  // Para equipe o ID e opcional: deriva do login.
  let id = String((req.body && req.body.id) || '').trim();
  if (!id && tipo === 'equipe') id = String(username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 28);
  if (!id || !name || !username || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (!/^[a-z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'ID deve conter apenas letras minúsculas, números, - ou _' });
  const clients = loadClients();
  if (clients.find(c => c.id === id)) return res.status(400).json({ error: 'Esse ID já existe' });
  if (clients.find(c => c.username === username)) return res.status(400).json({ error: 'Esse usuário já existe' });

  if (tipo === 'equipe') {
    const isAdmin = !!req.body.admin;
    const features = Array.isArray(req.body.features) ? req.body.features.filter(f => ALL_FEATURES.includes(f)) : [];
    if (!isAdmin && !features.length) return res.status(400).json({ error: 'Escolha ao menos uma área de acesso' });
    clients.push({
      id, ownerClientId: req.clientId, name, username, password, admin: isAdmin,
      defaultConnectionId: null, chatConnectionId: null, broadcastConnectionId: null,
      permissions: { features, workspaceSpaces: [], workspaceAdmin: false, restrictToOwnLeads: !!req.body.restrictToOwnLeads, allowedGroups: Array.isArray(req.body.allowedGroups) ? req.body.allowedGroups.map(String).slice(0, 100) : null },
    });
  } else {
    clients.push({ id, name, username, password });
  }
  saveClients(clients);
  res.json({ ok: true, id, tipo });
});

app.put('/api/admin/clients/:id', requireAuth, requireAdmin, (req, res) => {
  const clients = loadClients();
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { name, username, password } = req.body || {};
  if (name) clients[idx].name = name;
  // Permissoes so fazem sentido para usuario de equipe (tem dono).
  if (clients[idx].ownerClientId) {
    if ('admin' in req.body) clients[idx].admin = !!req.body.admin;
    if (Array.isArray(req.body.features)) {
      const features = req.body.features.filter(f => ALL_FEATURES.includes(f));
      if (!clients[idx].admin && !features.length) return res.status(400).json({ error: 'Escolha ao menos uma área de acesso' });
      clients[idx].permissions = { ...(clients[idx].permissions || {}), features };
    }
    if ('restrictToOwnLeads' in req.body) {
      clients[idx].permissions = { ...(clients[idx].permissions || {}), restrictToOwnLeads: !!req.body.restrictToOwnLeads };
    }
    if ('allowedGroups' in req.body) {
      // null/ausente = sem restrição (vê todos os grupos); array (mesmo vazio) = allowlist explícita
      clients[idx].permissions = { ...(clients[idx].permissions || {}), allowedGroups: Array.isArray(req.body.allowedGroups) ? req.body.allowedGroups.map(String).slice(0, 100) : null };
    }
  }
  if (username) {
    const conflict = clients.find((c, i) => c.username === username && i !== idx);
    if (conflict) return res.status(400).json({ error: 'Esse login já está em uso' });
    clients[idx].username = username;
  }
  if (password) clients[idx].password = password;
  saveClients(clients);
  res.json({ ok: true });
});

app.post('/api/admin/impersonate/:id', requireAuth, requireAdmin, (req, res) => {
  const clients = loadClients();
  // Allow impersonating any account visible in the admin list, except yourself
  const target = clients.find(c => c.id === req.params.id && c.id !== req.clientId && (!c.ownerClientId || c.ownerClientId === req.clientId));
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  const token = createToken(target);
  res.json({ token, clientId: target.ownerClientId || target.id, loginId: target.id, clientName: target.name, admin: false, permissions: { features: getUserFeatures(target), workspaceSpaces: target.permissions?.workspaceSpaces || [], workspaceAdmin: !!target.permissions?.workspaceAdmin } });
});

app.delete('/api/admin/clients/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.clientId) return res.status(400).json({ error: 'Você não pode excluir seu próprio usuário' });
  const clients = loadClients();
  const filtered = clients.filter(c => c.id !== req.params.id);
  if (filtered.length === clients.length) return res.status(404).json({ error: 'Usuário não encontrado' });
  saveClients(filtered);
  res.json({ ok: true });
});

app.post('/api/provider', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const requestedProvider = String(req.body?.provider || '').toLowerCase();
  if (!['web', 'cloud'].includes(requestedProvider)) return res.status(400).json({ error: 'Provider invalido.' });
  if (requestedProvider === t.provider) return res.json({ ok: true, provider: t.provider, restarted: false });
  t.db.updateConfig({ provider: requestedProvider });
  t.provider = requestedProvider;
  ensureWebClient(t);
  res.json({ ok: true, provider: requestedProvider, restarted: false });
});

app.post('/api/web/reset-session', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const sessionDir = path.join(BAILEYS_AUTH_BASE, t.clientId);
  try {
    t.isReady = false;
    t.qrCodeData = null;
    t.latestPairingCode = null;
    t.sessionRestoreState = 'idle';
    t.msgStore.clear();
    t.msgRetryCounterCache.clear();
    if (t.waClient) {
      try { t.waClient.logout?.(); } catch {}
      try { t.waClient.end?.(new Error('reset crypto session')); } catch {}
      t.waClient = null;
    }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, restarted: false });
  setTimeout(() => ensureWebClient(t), 300);
});

app.post('/api/pairing-code/start', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const phone = String(req.body?.phoneNumber || '').replace(/\D/g, '');
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Número inválido. Use formato internacional: 5511987654321' });
  t.pairPhoneNumber = phone;
  res.json({ ok: true });
  await resetWebClient(t);
});

app.post('/api/pairing-code/cancel', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  t.pairPhoneNumber = null;
  t.latestPairingCode = null;
  res.json({ ok: true });
  await resetWebClient(t);
});

app.post('/api/force-reset', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  res.json({ ok: true });
  await forceKillAndReset(t);
});

// ─── Email (IMAP/SMTP) ─────────────────────────
function emailLibs() {
  const { ImapFlow } = require('imapflow');
  const nodemailer = require('nodemailer');
  const { simpleParser } = require('mailparser');
  return { ImapFlow, nodemailer, simpleParser };
}
function getEmailAccounts(t) {
  try {
    const c=t.db.getConfig()||{};
    if(Array.isArray(c.emailAccounts)&&c.emailAccounts.length)return c.emailAccounts;
    if(c.emailConfig)return [{...c.emailConfig,id:c.emailConfig.id||'legacy',provider:c.emailConfig.provider||'imap',label:c.emailConfig.label||c.emailConfig.user,active:true}];
  } catch(e) {}
  return [];
}
function saveEmailAccounts(t,accounts){ t.db.updateConfig({emailAccounts:accounts}); return accounts; }
function getEmailCfg(t, accountId) {
  const list=getEmailAccounts(t); return list.find(a=>String(a.id)===String(accountId||''))||list.find(a=>a.active!==false)||list[0]||null;
}
function publicEmailAccount(a){return a?{id:a.id,provider:a.provider||'imap',user:a.user||'',label:a.label||a.user||'',fromName:a.fromName||'',active:a.active!==false,hasPassword:!!a.pass,connected:!!(a.pass||a.refreshToken)}:null;}
function microsoftEmailApp(t){try{return (t.db.getConfig()||{}).microsoftEmailOAuth||{};}catch{return {};}}
function emailOauthState(clientId){const raw=Buffer.from(JSON.stringify({clientId,iat:Date.now(),nonce:crypto.randomBytes(10).toString('hex')})).toString('base64url');return raw+'.'+crypto.createHmac('sha256',JWT_SECRET).update(raw).digest('hex');}
function parseEmailOauthState(state){const [raw,sig]=String(state||'').split('.');if(!raw||!sig)return null;const exp=crypto.createHmac('sha256',JWT_SECRET).update(raw).digest('hex');if(sig.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(exp)))return null;try{const d=JSON.parse(Buffer.from(raw,'base64url').toString());return Date.now()-d.iat<15*60*1000?d:null;}catch{return null;}}
async function microsoftRefreshAccount(t,cfg){if(cfg.provider!=='microsoft')return cfg;if(cfg.accessToken&&Number(cfg.expiresAt||0)>Date.now()+120000)return cfg;const appCfg=microsoftEmailApp(t);if(!appCfg.clientId||!appCfg.clientSecret||!cfg.refreshToken)throw new Error('Reconecte esta conta Microsoft.');const body=new URLSearchParams({client_id:appCfg.clientId,client_secret:appCfg.clientSecret,grant_type:'refresh_token',refresh_token:cfg.refreshToken,scope:'offline_access User.Read openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'});const r=await fetch('https://login.microsoftonline.com/'+encodeURIComponent(appCfg.tenant||'common')+'/oauth2/v2.0/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const d=await r.json();if(!r.ok||!d.access_token)throw new Error(d.error_description||'Falha ao renovar acesso Microsoft.');const next={...cfg,accessToken:d.access_token,refreshToken:d.refresh_token||cfg.refreshToken,expiresAt:Date.now()+Number(d.expires_in||3600)*1000};saveEmailAccounts(t,getEmailAccounts(t).map(a=>a.id===cfg.id?next:a));return next;}
function normalizeEmailList(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\n,;]+/g);
  return [...new Set(raw.map(v => String(v || '').trim()).filter(Boolean))];
}
function loadClientDashboardProfile(clientId) {
  if (!clientId) return {};
  try {
    if (fs.existsSync(path.join('/root/clients', clientId, 'data', clientId, 'db.sqlite3'))) {
      const Database = require('better-sqlite3');
      const db = new Database(path.join('/root/clients', clientId, 'data', clientId, 'db.sqlite3'), { readonly: true, fileMustExist: true });
      let profile = {};
      try {
        const row = db.prepare("SELECT value FROM config WHERE key='clientDashboard'").get();
        if (row && row.value) profile = JSON.parse(row.value) || {};
      } catch (e) {}
      try { db.close(); } catch (e) {}
      return profile;
    }
  } catch (e) {}
  return {};
}
function saveClientDashboardProfile(clientId, profile) {
  if (!clientId) return null;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join('/root/clients', clientId, 'data', clientId, 'db.sqlite3');
    const db = new Database(dbPath, { fileMustExist: true });
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('clientDashboard', JSON.stringify(profile || {}));
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('updatedAt', JSON.stringify(Date.now()));
    try { db.close(); } catch (e) {}
    return profile;
  } catch (e) { return null; }
}
function getEmailGroupsFromProfile(profile) {
  return {
    geral: normalizeEmailList((profile && profile.emailsGeral || []).map(x => x && x.email)),
    relatorio: normalizeEmailList((profile && profile.emailsRelatorio || []).map(x => x && x.email)),
    financeiro: normalizeEmailList((profile && profile.emailsFinanceiro || []).map(x => x && x.email)),
  };
}
function getEmailTemplates(t) {
  try {
    const cfg = t.db.getConfig() || {};
    const raw = cfg.emailTemplates;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) { return []; }
    }
    if (raw && Array.isArray(raw.templates)) return raw.templates;
    return [];
  } catch (e) { return []; }
}
function normalizeStoredEmailTemplate(tpl, profile) {
  const safeProfile = profile || {};
  const baseSubject = 'ULTIMAS30 acaba hoje!';
  const base = {
    id: 'tpl-' + Date.now().toString(36),
    name: 'Template Virando a Chave',
    subject: baseSubject,
    html: renderDefaultEmailTemplate(safeProfile),
    designer: {
      subject: baseSubject,
      kicker: 'Cupom para você',
      headline: 'CUPOM PARA VOCÊ',
      intro: 'O cupom ULTIMAS30 está ativo.',
      body: 'Selecione a opção desejada e confira os produtos disponíveis com 30% de desconto.',
      highlight: 'ULTIMAS30',
      ctaLabel: 'Comprar agora',
      ctaUrl: 'https://virandoachave.gestorwagnnerpires.com.br',
      footer: `Equipe ${safeProfile?.name || 'Virando a Chave'}`,
      logoData: safeProfile?.logo || '',
      brandName: safeProfile?.name || 'Virando a Chave',
    },
    updatedAt: Date.now(),
  };
  return {
    ...base,
    ...(tpl && typeof tpl === 'object' ? tpl : {}),
    id: String(tpl?.id || base.id),
    name: String(tpl?.name || base.name),
    subject: String(tpl?.subject || base.subject),
    html: String(tpl?.html || base.html),
    designer: (tpl && tpl.designer && typeof tpl.designer === 'object') ? { ...base.designer, ...tpl.designer } : base.designer,
    updatedAt: Number(tpl?.updatedAt || Date.now()),
  };
}
function renderDefaultEmailTemplate(profile) {
  const name = String(profile?.name || 'Nossa Empresa');
  const site = String(profile?.site || profile?.url || '#');
  const logo = profile?.logo ? `<img src="${String(profile.logo)}" alt="${name}" style="max-width:220px;display:block;margin:0 auto;">` : `<div style="font-size:26px;font-weight:900;color:#111111;text-align:center;">${name}</div>`;
  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR">',
    '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#171717;">',
    '  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">',
    '    <tr><td align="center">',
    '      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;overflow:hidden;">',
    '        <tr><td style="padding:26px 28px 18px;background:#ffffff;text-align:center;">',
    `          ${logo}`,
    '        </td></tr>',
    '        <tr><td style="padding:32px 48px 40px;background:#ffffff;">',
    `          <div style="font-size:42px;line-height:1.05;font-weight:900;letter-spacing:-.03em;color:#111111;margin:0 0 24px;">Olá! Temos novidades para você.</div>`,
    `          <p style="margin:0 0 20px;font-size:18px;line-height:1.6;color:#1a1a1a;">Esperamos que esteja bem. Gostaríamos de compartilhar algumas novidades da <strong>${name}</strong>.</p>`,
    '          <p style="margin:0 0 28px;font-size:18px;line-height:1.6;color:#1a1a1a;">Confira as ofertas e novidades que preparamos especialmente para você.</p>',
    `          <a href="${site}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:16px 34px;border-radius:999px;font-weight:700;font-size:16px;">Saiba mais</a>`,
    '          <div style="height:48px;"></div>',
    '          <div style="padding:20px 24px;border-radius:14px;background:#f8f8f8;border:1px solid #ececec;">',
    '            <div style="font-size:16px;font-weight:700;color:#111111;margin:0 0 8px;">Alguma dúvida?</div>',
    '            <div style="font-size:14px;line-height:1.7;color:#555555;">Responda este email ou entre em contato — estamos aqui para ajudar.</div>',
    '          </div>',
    '        </td></tr>',
    '        <tr><td style="padding:24px 48px 34px;background:#ffffff;border-top:1px solid #ececec;">',
    '          <div style="font-size:12px;line-height:1.8;color:#818181;">',
    `            Enviado por ${name}.<br>Se precisar, responda este email para continuar o atendimento.`,
    '          </div>',
    '        </td></tr>',
    '      </table>',
    '    </td></tr>',
    '  </table>',
    '</body>',
    '</html>',
  ].join('');
}
function ensureEmailTemplates(t) {
  const existing = getEmailTemplates(t);
  if (existing.length) {
    const profile = (() => { try { return (t.db.getConfig() || {}).clientDashboard || {}; } catch (e) { return {}; } })();
    let changed = false;
    const next = existing.map(tpl => {
      const serialized = JSON.stringify(tpl || {});
      const looksOldDefault = String(tpl?.name || '') === 'Template Virando a Chave'
        && (/Chegou a hora de virar a chave/i.test(serialized) || /MOVA SUA MARCA COM MAIS PRESENÇA/i.test(serialized) || /ULTIMAS30/i.test(serialized) || /virandoachave\.gestorwagnnerpires/i.test(serialized));
      if (!looksOldDefault) return tpl;
      changed = true;
      return {
        ...tpl,
        subject: `Novidades da ${profile?.name || 'nossa empresa'}`,
        html: renderDefaultEmailTemplate(profile),
        designer: {
          subject: `Novidades da ${profile?.name || 'nossa empresa'}`,
          kicker: 'Olá!',
          headline: 'Temos novidades para você',
          intro: `Confira as últimas novidades da ${profile?.name || 'nossa empresa'}.`,
          body: 'Preparamos conteúdo especial para você. Clique no botão abaixo para saber mais.',
          highlight: '',
          ctaLabel: 'Saiba mais',
          ctaUrl: profile?.site || '#',
          footer: `Equipe ${profile?.name || 'nossa empresa'}`,
          logoData: profile?.logo || '',
          brandName: profile?.name || 'nossa empresa',
        },
        updatedAt: Date.now(),
      };
    });
    if (changed) t.db.updateConfig({ emailTemplates: next });
    return next;
  }
  const profile = (() => { try { return (t.db.getConfig() || {}).clientDashboard || {}; } catch (e) { return {}; } })();
  const seeded = [{
    id: 'tpl-' + Date.now().toString(36),
    name: `Template ${profile?.name || 'Padrão'}`,
    subject: `Novidades da ${profile?.name || 'nossa empresa'}`,
    html: renderDefaultEmailTemplate(profile),
    designer: {
      subject: `Novidades da ${profile?.name || 'nossa empresa'}`,
      kicker: 'Olá!',
      headline: 'Temos novidades para você',
      intro: `Confira as últimas novidades da ${profile?.name || 'nossa empresa'}.`,
      body: 'Preparamos conteúdo especial para você. Clique no botão abaixo para saber mais.',
      highlight: '',
      ctaLabel: 'Saiba mais',
      ctaUrl: profile?.site || '#',
      footer: `Equipe ${profile?.name || 'nossa empresa'}`,
      logoData: profile?.logo || '',
      brandName: profile?.name || 'nossa empresa',
    },
    updatedAt: Date.now(),
  }];
  t.db.updateConfig({ emailTemplates: seeded });
  return seeded;
}
const EMAIL_SPECIAL_FOLDER_FALLBACK = { '\\Sent': 'INBOX.Sent', '\\Trash': 'INBOX.Trash' };
function emailFolderSentinel(folderParam) {
  if (folderParam === 'sent') return '\\Sent';
  if (folderParam === 'trash') return '\\Trash';
  return 'INBOX';
}
async function emailImapOpen(t, cfg, box) {
  const { ImapFlow } = emailLibs();
  cfg=await microsoftRefreshAccount(t,cfg);
  const auth=cfg.provider==='microsoft'?{user:cfg.user,accessToken:cfg.accessToken}:{user:cfg.user,pass:cfg.pass};
  const c = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort || 993, secure: true, auth, logger: false, emitLogs: false });
  // O ImapFlow emite 'error' no proprio objeto, fora da promise. Sem listener o Node
  // derruba o processo inteiro (crash-loop com Office365, que recusa basic auth em IMAP).
  c.on('error', () => {});
  await c.connect();
  let target = box || 'INBOX';
  // '\Sent'/'\Trash' são pedidos de "ache essa pasta especial" — o nome real varia por
  // provedor (Hostinger usa INBOX.Sent, outros usam só "Sent"), então descobre pelo
  // specialUse em vez de cravar um nome fixo.
  if (target.startsWith('\\')) {
    const fallback = EMAIL_SPECIAL_FOLDER_FALLBACK[target] || 'INBOX';
    try {
      const list = await c.list();
      const found = list.find(mb => mb.specialUse === target);
      target = found ? found.path : fallback;
    } catch (e) { target = fallback; }
  }
  await c.mailboxOpen(target);
  return c;
}
async function emailTransport(t,cfg){const {nodemailer}=emailLibs();cfg=await microsoftRefreshAccount(t,cfg);const auth=cfg.provider==='microsoft'?{type:'OAuth2',user:cfg.user,accessToken:cfg.accessToken}:{user:cfg.user,pass:cfg.pass};return nodemailer.createTransport({host:cfg.smtpHost,port:cfg.smtpPort||465,secure:(Number(cfg.smtpPort)||465)===465,requireTLS:(Number(cfg.smtpPort)||465)!==465,auth});}

// ─── Email ao vivo: checa a caixa de entrada de tempo em tempo (IMAP não empurra
// sozinho como o WhatsApp) e avisa via SSE quando chega algo novo. Guarda o último UID
// visto por tenant pra não notificar a caixa inteira de novo a cada restart do processo.
async function emailPollTick() {
  for (const t of tenants.values()) {
    const accounts = getEmailAccounts(t);
    if (!accounts.length) continue;
    for (const account of accounts) {
      const cfg = getEmailCfg(t, account.id);
      if (!cfg) continue;
      let c;
      try {
      c = await emailImapOpen(t, cfg, 'INBOX');
      const total = (c.mailbox && c.mailbox.exists) || 0;
      if (!total) continue;
      const last = await c.fetchOne(String(total), { uid: true });
      const maxUid = last ? last.uid : 0;
      if (!maxUid) continue;
      const storedConfig = t.db.getConfig() || {};
      const seenByAccount = Object.assign({}, storedConfig.emailLastSeenUids || {});
      const lastSeen = Number(seenByAccount[cfg.id] || (cfg.id === 'legacy' ? storedConfig.emailLastSeenUid : 0) || 0);
      if (!lastSeen) {
        // primeira vez que este tenant é visto — só marca o ponto de partida, não
        // dispara notificação retroativa da caixa inteira.
        seenByAccount[cfg.id] = maxUid;
        t.db.updateConfig({ emailLastSeenUids: seenByAccount });
        continue;
      }
      if (maxUid <= lastSeen) continue;
      const fresh = [];
      for await (const m of c.fetch(`${lastSeen + 1}:*`, { envelope: true, uid: true }, { uid: true })) {
        if (m.uid <= lastSeen) continue;
        const fr = (m.envelope && m.envelope.from && m.envelope.from[0]) || {};
        fresh.push({ uid: m.uid, from: fr.address || '', fromName: fr.name || fr.address || '', subject: (m.envelope && m.envelope.subject) || '(sem assunto)' });
      }
      seenByAccount[cfg.id] = maxUid;
      t.db.updateConfig({ emailLastSeenUids: seenByAccount });
      fresh.forEach(msg => broadcastEmailEvent(t, Object.assign({ accountId: cfg.id, accountEmail: cfg.user }, msg)));
      } catch (e) { /* silencioso — tenta de novo no próximo ciclo */ }
      finally { if (c) { try { await c.logout(); } catch (e) {} } }
    }
  }
}
setInterval(() => { emailPollTick().catch(() => {}); }, 30000);

app.get('/api/email/status', requireAuth, (req, res) => {
  const t=getTenant(req.clientId),accounts=getEmailAccounts(t),cfg=getEmailCfg(t,req.query.accountId);
  res.json({ configured: !!cfg, user: cfg ? cfg.user : null, account:publicEmailAccount(cfg), accounts:accounts.map(publicEmailAccount) });
});

app.get('/api/email/config', requireAuth, (req, res) => {
  const t=getTenant(req.clientId),cfg = getEmailCfg(t,req.query.accountId) || {},appCfg=microsoftEmailApp(t);
  res.json({
    id:cfg.id||'', provider:cfg.provider||'imap', label:cfg.label||'', accounts:getEmailAccounts(t).map(publicEmailAccount),
    user: cfg.user || '',
    fromName: cfg.fromName || '',
    imapHost: cfg.imapHost || '',
    imapPort: cfg.imapPort || 993,
    smtpHost: cfg.smtpHost || '',
    smtpPort: cfg.smtpPort || 465,
    hasPassword: !!cfg.pass, microsoft:{configured:!!(appCfg.clientId&&appCfg.clientSecret),clientId:appCfg.clientId||'',tenant:appCfg.tenant||'common',redirectUri:`${req.protocol}://${req.get('host')}/api/email/microsoft/callback`}
  });
});

app.put('/api/email/config', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const current = getEmailCfg(t,req.body?.id) || {};
  const body = req.body || {};
  const next = {
    id:String(body.id||current.id||('mail-'+Date.now().toString(36))),provider:'imap',label:String(body.label||body.user||'').trim(),user: String(body.user || '').trim(),
    fromName: String(body.fromName || '').trim(),
    imapHost: String(body.imapHost || '').trim(),
    imapPort: Number(body.imapPort) || 993,
    smtpHost: String(body.smtpHost || '').trim(),
    smtpPort: Number(body.smtpPort) || 465,
    pass: String(body.pass || '').trim() || current.pass || '',
  };
  if (!next.user || !next.imapHost || !next.smtpHost || !next.pass) {
    return res.status(400).json({ error: 'Preencha usuário, senha, IMAP e SMTP.' });
  }
  const list=getEmailAccounts(t),out=list.some(a=>a.id===next.id)?list.map(a=>a.id===next.id?next:a):[...list,next];saveEmailAccounts(t,out);
  res.json({ ok: true,account:publicEmailAccount(next),accounts:out.map(publicEmailAccount) });
});

app.put('/api/email/microsoft/app',requireAuth,requireFeature('config'),(req,res)=>{const t=getTenant(req.clientId),b=req.body||{},old=microsoftEmailApp(t),next={clientId:String(b.clientId||old.clientId||'').trim(),clientSecret:String(b.clientSecret||'').trim()||old.clientSecret||'',tenant:String(b.tenant||old.tenant||'common').trim()};if(!next.clientId||!next.clientSecret)return res.status(400).json({error:'Informe o Client ID e o segredo do aplicativo Microsoft.'});t.db.updateConfig({microsoftEmailOAuth:next});res.json({ok:true,configured:true});});
app.get('/api/email/microsoft/start',requireAuth,(req,res)=>{const t=getTenant(req.clientId),a=microsoftEmailApp(t);if(!a.clientId||!a.clientSecret)return res.status(400).json({error:'Configure primeiro o aplicativo Microsoft.'});const redirect=`${req.protocol}://${req.get('host')}/api/email/microsoft/callback`,q=new URLSearchParams({client_id:a.clientId,response_type:'code',redirect_uri:redirect,response_mode:'query',scope:'offline_access User.Read openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',state:emailOauthState(req.clientId),prompt:'select_account'});res.json({url:`https://login.microsoftonline.com/${encodeURIComponent(a.tenant||'common')}/oauth2/v2.0/authorize?${q}`});});
app.get('/api/email/microsoft/callback',async(req,res)=>{const st=parseEmailOauthState(req.query.state);if(!st)return res.status(400).send('Estado OAuth inválido ou expirado.');const t=getTenant(st.clientId),a=microsoftEmailApp(t),redirect=`${req.protocol}://${req.get('host')}/api/email/microsoft/callback`;try{const body=new URLSearchParams({client_id:a.clientId,client_secret:a.clientSecret,grant_type:'authorization_code',code:String(req.query.code||''),redirect_uri:redirect,scope:'offline_access User.Read openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'}),tr=await fetch(`https://login.microsoftonline.com/${encodeURIComponent(a.tenant||'common')}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}),tok=await tr.json();if(!tr.ok||!tok.access_token)throw new Error(tok.error_description||'A Microsoft não retornou o token.');const meRes=await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',{headers:{Authorization:'Bearer '+tok.access_token}}),me=await meRes.json(),user=me.mail||me.userPrincipalName;if(!user)throw new Error('A Microsoft não informou o email da conta.');const id='ms-'+crypto.createHash('sha1').update(user.toLowerCase()).digest('hex').slice(0,12),account={id,provider:'microsoft',label:user,user,fromName:me.displayName||'',imapHost:'outlook.office365.com',imapPort:993,smtpHost:'smtp.office365.com',smtpPort:587,accessToken:tok.access_token,refreshToken:tok.refresh_token,expiresAt:Date.now()+Number(tok.expires_in||3600)*1000,active:true};const list=getEmailAccounts(t),out=list.some(x=>x.id===id)?list.map(x=>x.id===id?account:x):[...list,account];saveEmailAccounts(t,out);res.type('html').send('<!doctype html><meta charset="utf-8"><title>Microsoft conectado</title><script>if(opener)opener.postMessage({type:"microsoft-email-oauth",ok:true},location.origin);setTimeout(()=>close(),700)</script><h2>Conta Microsoft conectada. Esta janela pode ser fechada.</h2>');}catch(e){res.status(500).send('Falha ao conectar: '+String(e.message).replace(/[<>]/g,''));}});
app.delete('/api/email/accounts/:id',requireAuth,requireFeature('config'),(req,res)=>{const t=getTenant(req.clientId),list=getEmailAccounts(t),next=list.filter(a=>String(a.id)!==String(req.params.id));if(next.length===list.length)return res.status(404).json({error:'Conta não encontrada.'});saveEmailAccounts(t,next);res.json({ok:true,accounts:next.map(publicEmailAccount)});});

app.get('/api/email/templates', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const profile = (() => { try { return (t.db.getConfig() || {}).clientDashboard || {}; } catch (e) { return {}; } })();
  res.json(ensureEmailTemplates(t).map(tpl => normalizeStoredEmailTemplate(tpl, profile)));
});

app.post('/api/email/templates', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const body = req.body || {};
  const templates = ensureEmailTemplates(t);
  const payload = {
    id: String(body.id || '').trim() || ('tpl-' + Date.now().toString(36)),
    name: String(body.name || '').trim() || 'Template sem nome',
    subject: String(body.subject || '').trim() || 'Sem assunto',
    html: String(body.html || '').trim() || renderDefaultEmailTemplate({}),
    updatedAt: Date.now(),
  };
  const next = templates.some(tpl => tpl.id === payload.id)
    ? templates.map(tpl => tpl.id === payload.id ? payload : tpl)
    : [payload, ...templates];
  t.db.updateConfig({ emailTemplates: next });
  res.json({ ok: true, template: payload, templates: next });
});

app.delete('/api/email/templates/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const next = ensureEmailTemplates(t).filter(tpl => tpl.id !== req.params.id);
  t.db.updateConfig({ emailTemplates: next });
  res.json({ ok: true, templates: next });
});

app.get('/api/email/clients', requireAuth, (req, res) => {
  const ownId = String(req.clientId || '');
  if (ownId !== 'virandoachave') {
    const profile = (getTenant(ownId).db.getConfig() || {}).clientDashboard || {};
    const groups = getEmailGroupsFromProfile(profile);
    return res.json([{ clientId: ownId, name: profile.name || ownId, logo: profile.logo || '', groups }]);
  }
  let Database; try { Database = require('better-sqlite3'); } catch (e) { return res.status(500).json({ error: 'db lib indisponivel' }); }
  const base = '/root/clients';
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter(d => d !== 'data' && fs.existsSync(path.join(base, d, 'data', d, 'db.sqlite3'))); } catch (e) {}
  const out = [];
  for (const id of dirs) {
    try {
      const db = new Database(path.join(base, id, 'data', id, 'db.sqlite3'), { readonly: true, fileMustExist: true });
      let profile = {};
      try {
        const row = db.prepare("SELECT value FROM config WHERE key='clientDashboard'").get();
        if (row && row.value) profile = JSON.parse(row.value) || {};
      } catch (e) {}
      try { db.close(); } catch (e) {}
      out.push({ clientId: id, name: profile.name || id, logo: profile.logo || '', groups: getEmailGroupsFromProfile(profile) });
    } catch (e) {}
  }
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));
  res.json(out);
});

app.get('/api/email/client/:clientId', requireAuth, (req, res) => {
  const requester = String(req.clientId || '');
  const target = String(req.params.clientId || '').trim();
  if (!target) return res.status(400).json({ error: 'Cliente inválido' });
  if (requester !== 'virandoachave' && requester !== target) return res.status(403).json({ error: 'Sem permissão' });
  const profile = requester === target ? ((getTenant(target).db.getConfig() || {}).clientDashboard || {}) : loadClientDashboardProfile(target);
  res.json({
    clientId: target,
    name: profile.name || target,
    logo: profile.logo || '',
    emailsFinanceiro: normalizeEmailList((profile.emailsFinanceiro || []).map(x => x && x.email)),
    emailsRelatorio: normalizeEmailList((profile.emailsRelatorio || []).map(x => x && x.email)),
    emailsGeral: normalizeEmailList((profile.emailsGeral || []).map(x => x && x.email)),
  });
});

app.put('/api/email/client/:clientId', requireAuth, (req, res) => {
  const requester = String(req.clientId || '');
  const target = String(req.params.clientId || '').trim();
  if (!target) return res.status(400).json({ error: 'Cliente inválido' });
  if (requester !== 'virandoachave' && requester !== target) return res.status(403).json({ error: 'Sem permissão' });
  const sourceProfile = requester === target ? ((getTenant(target).db.getConfig() || {}).clientDashboard || {}) : loadClientDashboardProfile(target);
  const profile = { ...sourceProfile };
  profile.emailsFinanceiro = normalizeEmailList(req.body?.emailsFinanceiro).map(email => ({ email }));
  profile.emailsRelatorio = normalizeEmailList(req.body?.emailsRelatorio).map(email => ({ email }));
  profile.emailsGeral = normalizeEmailList(req.body?.emailsGeral).map(email => ({ email }));
  if (requester === target) getTenant(target).db.updateConfig({ clientDashboard: profile });
  else if (!saveClientDashboardProfile(target, profile)) return res.status(500).json({ error: 'Não foi possível salvar os emails do cliente' });
  res.json({ ok: true, profile });
});

app.get('/api/email/inbox', requireAuth, async (req, res) => {
  const t=getTenant(req.clientId),cfg = getEmailCfg(t,req.query.accountId);
  if (!cfg) return res.status(400).json({ error: 'Email nao configurado' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
  const folder = emailFolderSentinel(req.query.folder);
  let c;
  try {
    c = await emailImapOpen(t,cfg, folder);
    const total = (c.mailbox && c.mailbox.exists) || 0;
    const out = [];
    if (total > 0) {
      const start = Math.max(1, total - limit + 1);
      for await (const m of c.fetch(`${start}:*`, { envelope: true, flags: true, internalDate: true })) {
        const fr = (m.envelope && m.envelope.from && m.envelope.from[0]) || {};
        out.push({
          uid: m.uid,
          from: fr.address || '',
          fromName: fr.name || fr.address || '',
          subject: (m.envelope && m.envelope.subject) || '(sem assunto)',
          date: m.internalDate,
          seen: !!(m.flags && m.flags.has('\\Seen'))
        });
      }
    }
    out.reverse();
    res.json(out);
  } catch (e) {
    console.log('[email-inbox] erro:', e.message);
    res.status(502).json({ error: e.message });
  } finally { if (c) { try { await c.logout(); } catch (e) {} } }
});

app.get('/api/email/message/:uid', requireAuth, async (req, res) => {
  const t=getTenant(req.clientId),cfg = getEmailCfg(t,req.query.accountId);
  if (!cfg) return res.status(400).json({ error: 'Email nao configurado' });
  const { simpleParser } = emailLibs();
  const folder = emailFolderSentinel(req.query.folder);
  let c;
  try {
    c = await emailImapOpen(t,cfg, folder);
    const msg = await c.fetchOne(req.params.uid, { source: true }, { uid: true });
    if (!msg || !msg.source) return res.status(404).json({ error: 'Mensagem nao encontrada' });
    const p = await simpleParser(msg.source);
    try { await c.messageFlagsAdd(req.params.uid, ['\\Seen'], { uid: true }); } catch (e) {}
    res.json({
      subject: p.subject || '(sem assunto)',
      from: (p.from && p.from.text) || '',
      to: (p.to && p.to.text) || '',
      date: p.date,
      html: p.html || null,
      text: p.text || ''
    });
  } catch (e) {
    console.log('[email-message] erro:', e.message);
    res.status(502).json({ error: e.message });
  } finally { if (c) { try { await c.logout(); } catch (e) {} } }
});

// Apaga um email: se estiver na Lixeira, apaga de vez (IMAP delete); se estiver em
// qualquer outra pasta (inbox/enviados), move pra Lixeira em vez de descartar direto —
// mesmo comportamento de qualquer webmail (dá pra "desfazer" tirando da lixeira depois).
app.delete('/api/email/message/:uid', requireAuth, async (req, res) => {
  const t=getTenant(req.clientId),cfg = getEmailCfg(t,req.query.accountId);
  if (!cfg) return res.status(400).json({ error: 'Email nao configurado' });
  const folderParam = req.query.folder === 'trash' ? 'trash' : (req.query.folder === 'sent' ? 'sent' : 'inbox');
  const source = emailFolderSentinel(folderParam);
  let c;
  try {
    c = await emailImapOpen(t,cfg, source);
    if (folderParam === 'trash') {
      await c.messageDelete(req.params.uid, { uid: true });
    } else {
      const list = await c.list();
      const trashBox = list.find(mb => mb.specialUse === '\\Trash');
      const trashPath = trashBox ? trashBox.path : EMAIL_SPECIAL_FOLDER_FALLBACK['\\Trash'];
      await c.messageMove(req.params.uid, trashPath, { uid: true });
    }
    res.json({ ok: true });
  } catch (e) {
    console.log('[email-delete] erro:', e.message);
    res.status(502).json({ error: e.message });
  } finally { if (c) { try { await c.logout(); } catch (e) {} } }
});

app.post('/api/email/send', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = getEmailCfg(t,req.body?.accountId);
  if (!cfg) return res.status(400).json({ error: 'Email nao configurado' });
  const { to, subject, body, html, clientId, recipientGroup, recipientMode } = req.body || {};
  let recipients = normalizeEmailList(to);
  if (recipientMode && recipientMode !== 'manual') {
    const target = String(clientId || req.clientId || '').trim();
    if (!target) return res.status(400).json({ error: 'Selecione um cliente para o disparo' });
    if (String(req.clientId) !== 'virandoachave' && String(req.clientId) !== target) return res.status(403).json({ error: 'Sem permissão para esse cliente' });
    const profile = String(req.clientId) === target ? ((t.db.getConfig() || {}).clientDashboard || {}) : loadClientDashboardProfile(target);
    const groups = getEmailGroupsFromProfile(profile);
    recipients = groups[String(recipientGroup || 'geral')] || [];
  }
  if (!recipients.length || !subject) return res.status(400).json({ error: 'Destinatário e assunto são obrigatórios' });
  try {
    const tr = await emailTransport(t,cfg);
    const fromAddr = cfg.fromName ? ('"' + cfg.fromName + '" <' + cfg.user + '>') : cfg.user;
    const htmlBody = String(html || body || '').trim();
    const textBody = String(body || htmlBody || '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim();
    await tr.sendMail({ from: fromAddr, to: recipients.join(', '), subject, text: textBody || subject, html: htmlBody || String(body || '').replace(/\n/g, '<br>') });
    res.json({ ok: true });
  } catch (e) {
    console.log('[email-send] erro:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Arquivos (trabalhos aprovados) ────────────
function getFilesList(t) { try { const c = t.db.getConfig() || {}; return Array.isArray(c.arquivos) ? c.arquivos : []; } catch (e) { return []; } }
function saveFilesList(t, arr) { t.db.updateConfig({ arquivos: arr }); }
function escapeHtmlPage(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════ Email Marketing: Campanhas + rastreamento (aberturas/cliques) ═══════════════
function getCampaigns(t) { try { const c = t.db.getConfig() || {}; return Array.isArray(c.emailCampaigns) ? c.emailCampaigns : []; } catch (e) { return []; } }
function saveCampaigns(t, arr) { t.db.updateConfig({ emailCampaigns: arr }); }
function campToken() { return require('crypto').randomBytes(9).toString('hex'); }
// Um card do CRM costuma ter mais de um email no mesmo campo ("a@x.com; b@y.com")
// e as vezes ponto/virgula sobrando no fim. Extrai so os enderecos validos.
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
function extractEmails(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[\s,;]+/)) {
    const e = part.trim().replace(/[.,;:]+$/, '');
    if (EMAIL_RX.test(e)) out.push(e);
  }
  return out;
}
function normalizeCampaignRecipients(r) {
  r = r || {};
  const mode = (r.mode === 'group' || r.mode === 'pipeline') ? r.mode : 'manual';
  return {
    mode,
    group: r.group || 'geral',
    text: r.text || '',
    funnelId: r.funnelId ? String(r.funnelId) : '',
    columnIds: Array.isArray(r.columnIds) ? r.columnIds.map(String).filter(Boolean) : [],
  };
}
function resolveCampaignRecipients(t, camp) {
  // recipients: {mode:'manual'|'group'|'pipeline', group, text, funnelId, columnIds}
  const r = camp.recipients || {};
  if (r.mode === 'pipeline') {
    // Colunas do CRM. Exige selecao explicita: sem coluna marcada nao dispara nada,
    // pra ninguem mandar pro funil inteiro sem querer.
    const colIds = Array.isArray(r.columnIds) ? r.columnIds.map(String) : [];
    if (!colIds.length) return [];
    const cards = t.db.getCrmCards(r.funnelId || undefined) || [];
    const out = [];
    const seen = new Set();
    for (const card of cards) {
      if (!colIds.includes(String(card.columnId))) continue;
      for (const email of extractEmails(card.email)) {
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ email, name: card.contactName || '' });
      }
    }
    return out;
  }
  if (r.mode === 'group') {
    const profile = (t.db.getConfig() || {}).clientDashboard || {};
    const groups = getEmailGroupsFromProfile(profile);
    return (groups[r.group || 'geral'] || []).map(e => ({ email: e, name: '' }));
  }
  // manual: linhas "Nome <email>" ou "email"
  const lines = String(r.text || '').split(/[\n,;]+/g).map(x => x.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const ln of lines) {
    let email = ln, name = '';
    const m = ln.match(/^(.*?)<([^>]+)>$/);
    if (m) { name = m[1].trim(); email = m[2].trim(); }
    email = email.trim();
    if (!email || !email.includes('@') || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ email, name });
  }
  return out;
}
function buildTrackedHtml(html, base, cid, token, rec) {
  let h = String(html || '');
  // merge {{nome}}
  h = h.replace(/\{\{\s*nome\s*\}\}/gi, (rec && rec.name) ? rec.name : '');
  // reescreve links http(s) para passar pelo tracking de clique
  h = h.replace(/href="(https?:\/\/[^"]+)"/gi, (mm, url) => {
    if (url.indexOf(base + '/e/') === 0) return mm; // ja e tracking
    return 'href="' + base + '/e/' + cid + '/c/' + token + '?u=' + encodeURIComponent(url) + '"';
  });
  // pixel de abertura
  const pixel = '<img src="' + base + '/e/' + cid + '/o/' + token + '" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden">';
  if (/<\/body>/i.test(h)) h = h.replace(/<\/body>/i, pixel + '</body>'); else h = h + pixel;
  return h;
}
// Office365 corta em ~30 mensagens/minuto. Um respiro entre envios evita throttling.
const CAMPAIGN_SEND_INTERVAL_MS = 2200;
// Grava o progresso a cada N envios, pra uma queda no meio nao reenviar quem ja recebeu.
const CAMPAIGN_SAVE_EVERY = 10;
// Campanha travada em 'enviando' por mais que isso = o processo morreu no meio. Retoma.
const CAMPAIGN_STALE_MS = 30 * 60 * 1000;

// Persiste o andamento sem pisar em aberturas/cliques que o tracking gravou em paralelo:
// rele o estado do disco e mexe so nos campos do envio.
function saveCampaignProgress(t, camp) {
  try {
    const arr = getCampaigns(t);
    const i = arr.findIndex(x => x.id === camp.id);
    if (i < 0) return;
    const stored = arr[i];
    stored.sentList = camp.sentList;
    stored.status = camp.status;
    stored.updatedAt = Date.now();
    if (camp.sentAt) stored.sentAt = camp.sentAt;
    if ('scheduledFor' in camp) stored.scheduledFor = camp.scheduledFor;
    if (camp.sendingSince) stored.sendingSince = camp.sendingSince; else delete stored.sendingSince;
    stored.stats = Object.assign({}, stored.stats || {}, { sent: camp.stats.sent, fail: camp.stats.fail });
    saveCampaigns(t, arr);
  } catch (e) {}
}

async function sendCampaignNow(t, camp, host) {
  const cfg = getEmailCfg(t);
  if (!cfg) throw new Error('Email nao configurado');
  const recips = resolveCampaignRecipients(t, camp);
  if (!recips.length) throw new Error('Nenhum destinatario');
  const base = 'https://' + (host || (t.clientId + '.gestorwagnnerpires.com.br'));
  const tr = await emailTransport(t, cfg);
  const fromAddr = cfg.fromName ? ('"' + cfg.fromName + '" <' + cfg.user + '>') : cfg.user;

  // Retomada: quem ja foi tentado numa rodada anterior nao recebe de novo.
  const built = Array.isArray(camp.sentList) ? camp.sentList.slice() : [];
  const done = new Set(built.map(x => String(x && x.email || '').toLowerCase()));
  let ok = built.filter(x => x && !x.failed).length;
  let fail = built.filter(x => x && x.failed).length;

  camp.recipients = camp.recipients || {};
  camp.sentList = built;
  camp.stats = Object.assign({ opens: 0, opened: 0, clicks: 0, clicked: 0 }, camp.stats || {}, { sent: ok, fail });
  // Trava: marcado sincronamente, antes do primeiro await. O scan seguinte ve
  // 'enviando' e nao abre um segundo disparo da mesma campanha.
  camp.status = 'enviando';
  camp.sendingSince = Date.now();
  camp.scheduledFor = null;
  saveCampaignProgress(t, camp);

  try {
    const pending = recips.filter(r => !done.has(String(r.email || '').toLowerCase()));
    let since = 0;
    for (const rec of pending) {
      const token = campToken();
      const html = buildTrackedHtml(camp.html, base, t.clientId, token, rec);
      const text = String(camp.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const entry = { email: rec.email, name: rec.name || '', token, opens: 0, clicks: 0, sentAt: Date.now(), lastOpen: null, lastClick: null };
      try {
        await tr.sendMail({ from: fromAddr, to: rec.email, subject: camp.subject || 'Sem assunto', text: text || camp.subject, html });
        ok++;
      } catch (e) { fail++; entry.failed = true; entry.error = String(e && e.message || e).slice(0, 160); }
      built.push(entry);
      done.add(String(rec.email || '').toLowerCase());
      camp.stats.sent = ok; camp.stats.fail = fail;
      if (++since >= CAMPAIGN_SAVE_EVERY) { since = 0; saveCampaignProgress(t, camp); }
      if (CAMPAIGN_SEND_INTERVAL_MS > 0) await new Promise(r => setTimeout(r, CAMPAIGN_SEND_INTERVAL_MS));
    }
  } finally {
    try { tr.close(); } catch (e) {}
  }

  camp.sentList = built;
  camp.status = 'enviada';
  camp.sentAt = Date.now();
  camp.stats.sent = ok; camp.stats.fail = fail;
  delete camp.sendingSince;
  saveCampaignProgress(t, camp);
  return camp;
}

app.get('/api/email/campaigns', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const list = getCampaigns(t).map(c => ({ id: c.id, name: c.name, subject: c.subject, status: c.status, scheduledFor: c.scheduledFor || null, sentAt: c.sentAt || null, createdAt: c.createdAt, stats: c.stats || { sent: 0, opens: 0, opened: 0, clicks: 0, clicked: 0 }, recipientsCount: (c.sentList || []).length || 0 }));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list);
});
app.get('/api/email/campaigns/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const c = getCampaigns(t).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'nao encontrada' });
  res.json(c);
});
app.post('/api/email/campaigns', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const b = req.body || {};
  const camp = {
    id: 'camp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(b.name || '').slice(0, 160) || 'Campanha sem nome',
    subject: String(b.subject || '').slice(0, 240),
    html: String(b.html || ''),
    templateId: b.templateId || null,
    recipients: normalizeCampaignRecipients(b.recipients),
    status: 'rascunho',
    scheduledFor: b.scheduledFor ? Number(b.scheduledFor) : null,
    sentList: [], stats: { sent: 0, opens: 0, opened: 0, clicks: 0, clicked: 0 },
    createdAt: Date.now(), updatedAt: Date.now()
  };
  const arr = getCampaigns(t); arr.unshift(camp); saveCampaigns(t, arr);
  res.json(camp);
});
app.put('/api/email/campaigns/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const arr = getCampaigns(t); const i = arr.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'nao encontrada' });
  const b = req.body || {}; const c = arr[i];
  if ('name' in b) c.name = String(b.name || '').slice(0, 160);
  if ('subject' in b) c.subject = String(b.subject || '').slice(0, 240);
  if ('html' in b) c.html = String(b.html || '');
  if ('templateId' in b) c.templateId = b.templateId || null;
  if (b.recipients) c.recipients = normalizeCampaignRecipients(b.recipients);
  if ('scheduledFor' in b) c.scheduledFor = b.scheduledFor ? Number(b.scheduledFor) : null;
  c.updatedAt = Date.now();
  saveCampaigns(t, arr);
  res.json(c);
});
app.post('/api/email/campaigns/preview-recipients', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  try {
    const recs = resolveCampaignRecipients(t, { recipients: normalizeCampaignRecipients(req.body && req.body.recipients) });
    res.json({ count: recs.length, sample: recs.slice(0, 3).map(x => x.email) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/email/campaigns/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const arr = getCampaigns(t).filter(x => x.id !== req.params.id);
  saveCampaigns(t, arr);
  res.json({ ok: true });
});
app.post('/api/email/campaigns/:id/send', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const arr = getCampaigns(t); const c = arr.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'nao encontrada' });
  if (c.status === 'enviando' && Number(c.sendingSince || 0) > 0 && (Date.now() - Number(c.sendingSince)) < CAMPAIGN_STALE_MS) {
    return res.status(409).json({ error: 'Esta campanha ja esta sendo enviada agora.' });
  }
  const when = req.body && req.body.scheduledFor ? Number(req.body.scheduledFor) : null;
  if (when && when > Date.now() + 30000) {
    c.scheduledFor = when; c.status = 'agendada'; c.updatedAt = Date.now();
    saveCampaigns(t, arr);
    return res.json({ ok: true, scheduled: true, campaign: { id: c.id, status: c.status, scheduledFor: c.scheduledFor } });
  }
  try {
    await sendCampaignNow(t, c, req.get('host'));
    saveCampaigns(t, arr);
    res.json({ ok: true, sent: c.stats.sent, fail: c.stats.fail });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Tracking publico (sem auth) ──
const TRACK_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Guarda cada abertura/clique com hora exata (histórico completo, não só o último),
// pra dar rastreio "profissional": quando abriu de fato e em qual link clicou.
const TRACK_EVENTS_MAX = 200; // por destinatário, evita crescer sem limite com bots de scanner de email
function recordCampaignEvent(clientId, token, kind, extra) {
  try {
    const t = getTenant(clientId);
    const arr = getCampaigns(t); let changed = false;
    for (const c of arr) {
      const rec = (c.sentList || []).find(r => r.token === token);
      if (!rec) continue;
      c.stats = c.stats || { sent: (c.sentList || []).length, opens: 0, opened: 0, clicks: 0, clicked: 0 };
      const now = Date.now();
      const event = { type: kind, at: now };
      if (kind === 'click' && extra && extra.url) event.url = extra.url;
      if (extra && extra.ip) event.ip = extra.ip;
      if (extra && extra.ua) event.ua = String(extra.ua).slice(0, 200);
      rec.events = Array.isArray(rec.events) ? rec.events : [];
      rec.events.push(event);
      if (rec.events.length > TRACK_EVENTS_MAX) rec.events = rec.events.slice(-TRACK_EVENTS_MAX);
      if (kind === 'open') {
        if (!rec.opens) { c.stats.opened = (c.stats.opened || 0) + 1; rec.firstOpen = now; }
        rec.opens = (rec.opens || 0) + 1; rec.lastOpen = now; c.stats.opens = (c.stats.opens || 0) + 1;
      } else {
        if (!rec.clicks) c.stats.clicked = (c.stats.clicked || 0) + 1;
        rec.clicks = (rec.clicks || 0) + 1; rec.lastClick = now; c.stats.clicks = (c.stats.clicks || 0) + 1;
      }
      changed = true; break;
    }
    if (changed) saveCampaigns(t, arr);
  } catch (e) {}
}
app.get('/e/:clientId/o/:token', (req, res) => {
  recordCampaignEvent(req.params.clientId, req.params.token, 'open', { ip: req.ip, ua: req.get('user-agent') });
  res.set('Content-Type', 'image/gif'); res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private'); res.set('Pragma', 'no-cache');
  res.end(TRACK_PIXEL);
});
app.get('/e/:clientId/c/:token', (req, res) => {
  let url = String(req.query.u || '');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  recordCampaignEvent(req.params.clientId, req.params.token, 'click', { url, ip: req.ip, ua: req.get('user-agent') });
  res.redirect(302, url);
});

app.get('/api/files', requireAuth, (req, res) => { res.json(getFilesList(getTenant(req.clientId))); });

app.get('/public/files/:clientId/:id', (req, res) => {
  try {
    const t = getTenant(req.params.clientId);
    const item = getFilesList(t).find(f => String(f.id) === String(req.params.id));
    if (!item) return res.status(404).send('Arquivo não encontrado');
    if (item.type === 'bundle' && Array.isArray(item.files) && item.files.length) {
      const cards = item.files.map(file => `
        <a class="gallery-card" href="${escapeHtmlPage(file.url)}" target="_blank" rel="noopener noreferrer">
          <img src="${escapeHtmlPage(file.url)}" alt="${escapeHtmlPage(file.name || 'Imagem')}">
          <span>${escapeHtmlPage(file.name || 'Imagem')}</span>
        </a>
      `).join('');
      return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtmlPage(item.name || 'Pasta de imagens')}</title><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f6f4;color:#1f1f1f}main{max-width:1100px;margin:0 auto;padding:36px 20px 48px}h1{font-size:40px;line-height:1.05;margin:0 0 8px}p{margin:0 0 28px;color:#777}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}.gallery-card{display:block;background:#fff;border:1px solid #ece6df;border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 8px 22px rgba(0,0,0,.05)}.gallery-card img{display:block;width:100%;height:220px;object-fit:cover;background:#f0f0f0}.gallery-card span{display:block;padding:12px 14px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 24px}.pill{display:inline-flex;align-items:center;padding:9px 14px;border-radius:999px;background:#fff1e7;color:#a55725;font-size:13px;font-weight:700}</style></head><body><main><h1>${escapeHtmlPage(item.name || 'Pasta de imagens')}</h1><p>Galeria pública compartilhada</p><div class="meta"><span class="pill">${item.files.length} imagens</span><span class="pill">${new Date(item.date || Date.now()).toLocaleDateString('pt-BR')}</span></div><section class="gallery">${cards}</section></main></body></html>`);
    }
    if (item.url) return res.redirect(item.url);
    return res.status(404).send('Arquivo não encontrado');
  } catch (e) {
    return res.status(500).send('Erro ao abrir galeria');
  }
});

app.post('/api/files', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  let bb; try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  let savedFiles = [], done = false, note = '';
  bb.on('field', (n, v) => { if (n === 'note') note = String(v || '').slice(0, 200); });
  bb.on('file', (n, stream, info) => {
    const { filename, mimeType } = info; if (!filename) { stream.resume(); return; }
    const ext = path.extname(filename) || '';
    const safe = 'file-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    const savedPath = path.join(t.uploadsDir, safe);
    const savedUrl = '/uploads/' + t.clientId + '/' + safe;
    const fileItem = { name: filename, mime: info.mimeType || '', url: savedUrl, path: savedPath, size: 0 };
    savedFiles.push(fileItem);
    const ws = fs.createWriteStream(savedPath);
    stream.on('data', d => { fileItem.size += d.length; });
    stream.on('limit', () => {
      ws.destroy();
      fs.unlink(savedPath, () => {});
      if (!done) { done = true; res.status(413).json({ error: 'Arquivo muito grande (máximo 200 MB)' }); }
    });
    ws.on('finish', () => createVideoDerivatives(savedPath, mimeType));
    stream.pipe(ws);
  });
  bb.on('finish', () => {
    if (done) return; done = true;
    if (!savedFiles.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const now = Date.now();
    const arr = getFilesList(t);
    const allImages = savedFiles.every(file => /^image\//.test(file.mime || ''));
    const publicBase = `/public/files/${t.clientId}/`;
    if (savedFiles.length > 1 && allImages) {
      const bundleId = now + '-' + Math.round(Math.random() * 1e6);
      const item = {
        id: String(bundleId),
        type: 'bundle',
        name: savedFiles.length === 1 ? savedFiles[0].name : `Pasta com ${savedFiles.length} imagens`,
        files: savedFiles.map(file => ({ name: file.name, mime: file.mime, url: file.url, size: file.size })),
        mime: 'bundle/images',
        size: savedFiles.reduce((sum, file) => sum + file.size, 0),
        count: savedFiles.length,
        note,
        date: now,
        publicUrl: publicBase + bundleId,
      };
      arr.unshift(item);
      saveFilesList(t, arr);
      return res.json(item);
    }
    const created = savedFiles.map(file => ({
      id: Date.now() + '-' + Math.round(Math.random() * 1e6),
      name: file.name,
      url: file.url,
      mime: file.mime,
      size: file.size,
      note,
      date: now,
      publicUrl: file.url,
    }));
    created.slice().reverse().forEach(item => arr.unshift(item));
    saveFilesList(t, arr);
    res.json(created.length === 1 ? created[0] : created);
  });
  bb.on('error', e => { if (!done) { done = true; res.status(500).json({ error: e.message }); } });
  req.pipe(bb);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const arr = getFilesList(t);
  const item = arr.find(f => f.id === req.params.id);
  saveFilesList(t, arr.filter(f => f.id !== req.params.id));
  if (item && item.type === 'bundle' && Array.isArray(item.files)) {
    item.files.forEach(file => { if (file && file.url) { try { fs.unlinkSync(path.join(UPLOADS_BASE, file.url.replace('/uploads/', ''))); } catch (e) {} } });
  } else if (item && item.url) {
    try { fs.unlinkSync(path.join(UPLOADS_BASE, item.url.replace('/uploads/', ''))); } catch (e) {}
  }
  res.json({ ok: true });
});

app.get('/api/groups', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const conn = String(req.query.connectionId || '');
  if (conn === 'lite' || conn === 'lite2') {
    if (!liteEnabled(t)) return res.status(503).json({ error: 'WhatsApp Lite nao habilitado' });
    const inst = liteInstanceName(t, conn === 'lite2' ? '2' : '1');
    // Cache: o fetchAllGroups da Evolution é MUITO lento com muitos grupos (~80s p/ 158).
    // Serve do cache (5 min) pra a tela não ficar "Carregando..." toda vez.
    t._liteGroupsCache = t._liteGroupsCache || {};
    t._liteGroupsInflight = t._liteGroupsInflight || {};
    const cached = t._liteGroupsCache[conn];
    const nocache = String(req.query.force || '') === '1';
    // Dispara a busca (lenta) só se não houver uma em andamento. Reaproveita a mesma promessa.
    const kickRefresh = () => {
      if (t._liteGroupsInflight[conn]) return t._liteGroupsInflight[conn];
      t._liteGroupsInflight[conn] = (async () => {
        const r = await evoReq('GET', `/group/fetchAllGroups/${inst}?getParticipants=false`, null, 90000);
        const arr = Array.isArray(r.json) ? r.json : ((r.json && r.json.data) || null);
        if (!r.ok || !Array.isArray(arr)) throw new Error('sync');
        const groups = arr.map(g => ({ id: g.id, name: g.subject || g.subjectOwner || g.id }));
        t._liteGroupsCache[conn] = { at: Date.now(), groups };
        return groups;
      })().finally(() => { delete t._liteGroupsInflight[conn]; });
      return t._liteGroupsInflight[conn];
    };
    // stale-while-revalidate: se tem cache (mesmo velho), serve na hora e atualiza em bg quando velho.
    if (cached && !nocache) {
      if (Date.now() - cached.at >= 5 * 60 * 1000) kickRefresh().catch(() => {});
      return res.json(filterGroupsByClientAreaPermission(t, req, cached.groups));
    }
    // Sem cache nenhum (1ª carga): precisa esperar a busca.
    try { return res.json(filterGroupsByClientAreaPermission(t, req, await kickRefresh())); }
    catch (e) { return res.status(503).json({ error: 'Grupos ainda sincronizando (dispositivo recém-conectado com muitos grupos). Aguarde 1-2 min e clique em carregar de novo.' }); }
  }
  if (![t.isReady, t.isReady2, t.isReady3, t.isGroupReady].some(Boolean)) return res.status(503).json({ error: 'Nenhum QR Code conectado' });
  await refreshGroups(t, { force: true });
  res.json(t.groups);
});

app.get('/api/contacts', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (![t.isReady, t.isReady2, t.isReady3].some(Boolean)) return res.status(503).json({ error: 'Nenhum QR Code conectado' });
  await refreshContacts(t);
  res.json(t.contacts);
});

// Importa contatos do telefone para o CRM em massa
app.post('/api/contacts/import-to-crm', requireAuth, requireFeature('crm'), (req, res) => {
  const t = getTenant(req.clientId);
  const contacts = req.body?.contacts;
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'Lista de contatos vazia' });
  const inbox = getFirstCrmColumn(t);
  if (!inbox) return res.status(400).json({ error: 'Nenhuma coluna no CRM para receber os contatos' });
  const existing = t.db.getCrmCards();
  let imported = 0, skipped = 0;
  for (const c of contacts) {
    const name = String(c.name || '').trim();
    const phone = String(c.phone || c.id || '').replace(/\D/g, '');
    const whatsappId = c.id ? normalizeJid(c.id) : (phone ? `${phone}@s.whatsapp.net` : '');
    if (!name && !phone) { skipped++; continue; }
    const already = existing.find(e =>
      (whatsappId && e.whatsappId === whatsappId) ||
      (phone && e.phone && e.phone.replace(/\D/g, '') === phone)
    );
    if (already) { skipped++; continue; }
    if (crmIsNoFunnel(t, phone || whatsappId)) { skipped++; continue; }
    t.db.createCrmCard({ columnId: inbox.columnId, funnelId: inbox.funnelId, contactName: name || phone, whatsapp: phone, whatsappId });
    imported++;
  }
  res.json({ ok: true, imported, skipped });
});

app.get('/api/group-dispatch/status', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  res.json(getGroupDispatchStatus(getTenant(req.clientId)));
});

app.post('/api/group-dispatch/canary', requireAuth, requireAnyFeature(['broadcast','schedule']), async (req, res) => {
  const t = getTenant(req.clientId);
  try {
    const status = await runGroupCanary(t, req.body?.groupId);
    res.json({ ok: true, status });
  } catch (e) {
    pauseGroupDispatch(t, e.message);
    res.status(500).json({ error: e.message, status: getGroupDispatchStatus(t) });
  }
});

app.post('/api/group-dispatch/pause', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  const t = getTenant(req.clientId);
  pauseGroupDispatch(t, req.body?.reason || 'Pausado manualmente');
  res.json({ ok: true, status: getGroupDispatchStatus(t) });
});

// App-level webhook verification (used by Meta Developer Portal)
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Cloud webhook (public, identifies tenant by clientId in path)
app.get('/webhook/:clientId', (req, res) => {
  const t = getTenant(req.params.clientId);
  if (t.provider !== 'cloud') return res.status(404).send('Webhook apenas no modo cloud.');
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === t.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook/:clientId', async (req, res) => {
  const t = getTenant(req.params.clientId);
  const hasCloud = [1, 2, 3, 4, 5].some(n => getCloudSlot(t, n).phoneNumberId);
  if (!hasCloud) return res.sendStatus(404);
  res.sendStatus(200); // responde imediatamente para o Meta não retentar

  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'smb_message_echoes') {
        const value = change.value;
        if (!value) continue;
        const inboundPhoneIdEcho = value.metadata?.phone_number_id || '';
        const inboundCloudEcho = findCloudConnectionByPhoneId(t, inboundPhoneIdEcho);
        if (!inboundCloudEcho) continue;
        const connectionIdEcho = inboundCloudEcho.connectionId;
        const mediaTokenEcho = inboundCloudEcho.accessToken;

        for (const echo of value.message_echoes || []) {
          if (!echo) continue;
          const toRaw = String(echo.to || '');
          const to = normalizeBrazilianMobileDigits(normalizePhoneNumber(toRaw));
          if (!to) continue;
          const storageJidEcho = `${to}@s.whatsapp.net`;
          const etype = echo.type;

          let echoText = '';
          let echoMediaType = null;
          let echoMedia = null;

          if (etype === 'text') {
            echoText = echo.text?.body?.trim() || '';
          } else if (etype === 'revoke') {
            echoText = '🗑️ Mensagem apagada pelo app do celular';
          } else if (etype === 'edit') {
            const edited = echo.edit?.message;
            echoText = edited?.type === 'text' ? (edited.text?.body?.trim() || '') : `(editado) [${edited?.type || 'mensagem'}]`;
            echoText = `✏️ Editado: ${echoText}`;
          } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(etype)) {
            echoText = echo[etype]?.caption?.trim() || '';
            echoMediaType = etype;
            echoMedia = await saveCloudMedia(t, echo, mediaTokenEcho);
          }

          const echoDisplayText = echoMedia ? (echoText || '') : (echoText || (echoMediaType ? `[${echoMediaType}]` : '[mensagem do celular]'));
          // Sem o wamid do eco a mensagem que o atendente manda pelo celular nunca
          // casa com o webhook de status — fica pra sempre sem "entregue"/"lida".
          // updateMessageDeliveryByWamid tem trava de rank, então 'sent' aqui é só o
          // piso: delivered/read chegam depois e sobrescrevem.
          t.db.recordMessage({
            direction: 'out', contactId: storageJidEcho, contactName: to,
            text: echoDisplayText, mediaUrl: echoMedia?.url || null, mediaType: echoMedia?.type || null, mediaName: echoMedia?.name || null,
            connectionId: connectionIdEcho, phone: to,
            wamid: echo.id || null, deliveryStatus: echo.id ? 'sent' : null
          });

          const _existCardEcho = findCrmCardForChat(t, to);
          if (!_existCardEcho) {
            const inboxEcho = getFirstCrmColumn(t);
            if (inboxEcho && !crmIsNoFunnel(t, to)) t.db.createCrmCard({ columnId: inboxEcho.columnId, funnelId: inboxEcho.funnelId, contactName: to, whatsapp: to, whatsappId: storageJidEcho });
          }
          // Atendente respondeu direto pelo app do celular (coexistência) — pausa a IA
          // igual já fazemos quando ele responde pelo painel. Sem isso a IA não sabia
          // que um humano assumiu e continuava respondendo por cima (áudio inclusive).
          try { pauseBotForContact(t, storageJidEcho); } catch (e) {}
        }
        continue;
      }
      if (change.field === 'calls') {
        const value = change.value;
        if (!value || !value.calls || !value.calls.length) continue;
        const inboundPhoneIdCall = value.metadata?.phone_number_id || '';
        const inboundCloudCall = findCloudConnectionByPhoneId(t, inboundPhoneIdCall);
        if (!inboundCloudCall) continue;
        const connectionIdCall = inboundCloudCall.connectionId;

        for (const call of value.calls) {
          if (!call) continue;
          // "from" é sempre quem chamou. Em USER_INITIATED é o cliente; nesse caso o
          // contato do chat é o "from". Em BUSINESS_INITIATED seria o "to".
          const otherPartyRaw = call.direction === 'BUSINESS_INITIATED' ? call.to : call.from;
          const otherParty = normalizeBrazilianMobileDigits(normalizePhoneNumber(String(otherPartyRaw || '')));
          if (!otherParty) continue;
          const storageJidCall = `${otherParty}@s.whatsapp.net`;

          if (call.event === 'connect') {
            t.db.recordCallEvent({ contactId: storageJidCall, connectionId: connectionIdCall, wacallId: call.id, event: 'connect', direction: call.direction, startedAt: call.timestamp ? Number(call.timestamp) * 1000 : Date.now() });
            const quemLigou = call.direction === 'BUSINESS_INITIATED' ? 'Ligação iniciada por nós' : 'Ligação recebida pelo WhatsApp';
            t.db.recordMessage({ direction: call.direction === 'BUSINESS_INITIATED' ? 'out' : 'in', contactId: storageJidCall, contactName: otherParty, text: `📞 ${quemLigou}`, connectionId: connectionIdCall, phone: otherParty });
          } else if (call.event === 'terminate') {
            const statusVal = Array.isArray(call.status) ? call.status[call.status.length - 1] : call.status;
            const durationSec = Number(call.duration) || 0;
            const mm = Math.floor(durationSec / 60), ss = durationSec % 60;
            const durTxt = durationSec > 0 ? `${mm}m${String(ss).padStart(2, '0')}s` : null;
            t.db.recordCallEvent({ contactId: storageJidCall, connectionId: connectionIdCall, wacallId: call.id, event: 'terminate', direction: call.direction, status: statusVal, duration: durationSec, startedAt: call.start_time ? Number(call.start_time) * 1000 : null, endedAt: call.end_time ? Number(call.end_time) * 1000 : Date.now() });
            const falhou = String(statusVal || '').toLowerCase() === 'failed';
            const txtTerm = falhou ? '📞 Chamada não completada' : `📞 Chamada encerrada${durTxt ? ' - ' + durTxt : ''}`;
            t.db.recordMessage({ direction: call.direction === 'BUSINESS_INITIATED' ? 'out' : 'in', contactId: storageJidCall, contactName: otherParty, text: txtTerm, connectionId: connectionIdCall, phone: otherParty });
          }

          const _existCardCall = findCrmCardForChat(t, otherParty);
          if (!_existCardCall) {
            const inboxCall = getFirstCrmColumn(t);
            if (inboxCall && !crmIsNoFunnel(t, otherParty)) t.db.createCrmCard({ columnId: inboxCall.columnId, funnelId: inboxCall.funnelId, contactName: otherParty, whatsapp: otherParty, whatsappId: storageJidCall });
          }
        }
        continue;
      }
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value) continue;
      if (value.statuses && value.statuses.length) {
        for (const st of value.statuses) {
          const errText = st.errors ? describeCloudSendError(st.errors[0]) : null;
          if (st.id) t.db.updateMessageDeliveryByWamid(st.id, st.status, errText);
          if (st.status === 'failed') console.log(`[${t.clientId}][cloud-status] to=${st.recipient_id} status=failed wamid=${st.id} errors=${JSON.stringify(st.errors || [])}`);
        }
      }
      if (!value.messages || !value.messages.length) continue;

      // Mapa de nome por número (o Meta envia no array contacts)
      const nameByPhone = {};
      for (const c of value.contacts || []) {
        if (c.wa_id) nameByPhone[c.wa_id] = c.profile?.name || c.wa_id;
      }

      // Identifica qual conexão recebeu baseado no phone_number_id do metadata
      const inboundPhoneId = value.metadata?.phone_number_id || '';
      const inboundCloud = findCloudConnectionByPhoneId(t, inboundPhoneId);
      if (!inboundCloud) continue;
      const connectionId = inboundCloud.connectionId;

      for (const message of value.messages || []) {
        if (!message) continue;
        const fromRaw = String(message.from || '');
        const from = normalizeBrazilianMobileDigits(normalizePhoneNumber(fromRaw));
        if (!from) continue;
        const storageJid = `${from}@s.whatsapp.net`;
        const senderName = nameByPhone[fromRaw] || nameByPhone[from] || from;

        // Extrai texto e info de mídia por tipo
        let text = '';
        let mediaType = null;
        const mtype = message.type;
        if (mtype === 'text') {
          text = message.text?.body?.trim() || '';
        } else if (mtype === 'interactive') {
          const _iv = message.interactive || {};
          if (_iv.type === 'nfm_reply' && _iv.nfm_reply) text = formatFlowReply(_iv.nfm_reply);
          text = text || _iv.button_reply?.title || _iv.list_reply?.title || _iv.list_reply?.description || _iv.button_reply?.id || _iv.list_reply?.id || '';
        } else if (mtype === 'button') {
          text = message.button?.text || message.button?.payload || '';
        } else if (mtype === 'contacts') {
          text = cloudContactsToText(message.contacts);
        } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(mtype)) {
          text = message[mtype]?.caption?.trim() || '';
          mediaType = mtype;
        } else if (mtype === 'location') {
          const loc = message.location || {};
          text = `📍 ${loc.name || ''}${loc.name ? ' ' : ''}(${loc.latitude},${loc.longitude})`.trim();
        } else if (mtype === 'reaction') {
          // Anexa na mensagem original (igual o WhatsApp mostra) em vez de virar um balão
          // novo — só cai pro balão avulso se a mensagem original não estiver salva aqui.
          const emoji = message.reaction?.emoji || '';
          if (t.db.setMessageReaction(message.reaction?.message_id, storageJid, emoji)) continue;
          text = emoji ? `${emoji} reagiu a uma mensagem` : 'removeu a reação';
        }
        // Rede de seguranca: nunca virar '[mensagem]' vazio
        if (!text && !mediaType) {
          const _deep = deepFindMessageText(message[mtype]);
          text = _deep || (mtype ? `[${mtype}]` : '');
        }

        const displayText = text || (mediaType ? `[${mediaType}]` : '[mensagem]');
        const cleanDisplayText = stripTrackingTags(displayText);

        // Baixa a midia da Cloud API (se houver) para abrir no chat
        let cloudMedia = null;
        if (mediaType) {
          const mediaToken = inboundCloud.accessToken;
          cloudMedia = await saveCloudMedia(t, message, mediaToken);
        }

        // Salva no chat ao vivo
        const wabaId = value.metadata?.waba_id || '';
        t.db.recordMessage({ direction: 'in', contactId: storageJid, contactName: senderName, text: cloudMedia ? stripTrackingTags(text || '') : cleanDisplayText, mediaUrl: cloudMedia?.url || null, mediaType: cloudMedia?.type || null, mediaName: cloudMedia?.name || null, connectionId, waId: fromRaw, phone: from, phoneNumberId: inboundPhoneId, wabaId: wabaId || null, username: (senderName !== from ? senderName : null) });
        try { aplicarRespostaCampanha(t, storageJid, text); } catch (e) {}
        try { maybeReviveCardOnInbound(t, storageJid); } catch (e) {}

        // Auto-cria card no CRM; atualiza se já existir em branco
        const _existCardCloud = findCrmCardForChat(t, from);
        if (!_existCardCloud) {
          const inbox = getFirstCrmColumn(t);
          if (inbox && !crmIsNoFunnel(t, from)) {
            const newCardCloud = t.db.createCrmCard({ columnId: inbox.columnId, funnelId: inbox.funnelId, contactName: senderName || from, whatsapp: from, whatsappId: from });
            if (newCardCloud) { t.db.markCrmCardNewMessage(newCardCloud.id); applyLeadSourceTag(t, newCardCloud, displayText); captureSiteRef(t, newCardCloud, displayText); captureFbCookies(t, newCardCloud, displayText); captureGoogleAdsRef(t, newCardCloud, displayText); }
          }
        } else {
          if (!_existCardCloud.contactName && senderName) t.db.updateCrmCard(_existCardCloud.id, { contactName: senderName });
          t.db.markCrmCardNewMessage(_existCardCloud.id);
          applyLeadSourceTag(t, _existCardCloud, displayText); captureSiteRef(t, _existCardCloud, displayText); captureFbCookies(t, _existCardCloud, displayText); captureGoogleAdsRef(t, _existCardCloud, displayText);
        }
        if (message.referral) { const _cardRef = findCrmCardForChat(t, from); if (_cardRef) captureAdReferral(t, _cardRef, message.referral); }

        // Verifica se é resposta a um quick reply agendado (sem re-gravar a mensagem)
        if (text) {
          const recentLogs = t.db.getRecentLogsForRecipient(from);
          for (const log of recentLogs) {
            const matched = (log.quickReplies || []).find(q => q.toLowerCase() === text.toLowerCase());
            if (!matched) continue;
            t.db.recordResponse({ scheduleId: log.scheduleId, senderId: from, senderName, recipientId: from, recipientName: log.recipientName, reply: text, matchedButton: matched, responseTimeMs: Date.now() - log.sentAt });
            break;
          }
        }

        // Auto Atendimento (funil de conversa)
        await maybeAutoRespond(t, { storageJid, digits: from, text, connectionId, inboundMsgId: message.id, firstMessage: !_existCardCloud });

        if (text) {
          const _aiCardCloud = findCrmCardForChat(t, storageJid);
          if (aiChatbotShouldTrigger(t, storageJid, _aiCardCloud?.columnId)) {
            scheduleAiChatbotReply(t, storageJid, from, connectionId);
          }
        }
      }

      // Status updates (entregues, lidos) — ignora silenciosamente
    }
  }
});

// Upload
app.post('/api/upload', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  let responded = false;
  function reply(status, body) { if (responded) return; responded = true; res.status(status).json(body); }
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return reply(400, { error: e.message }); }
  let savedFile = null, bbDone = false, pendingWrites = 0, fileSeen = false;
  function tryRespond() { if (!bbDone || pendingWrites > 0) return; if (!savedFile) return reply(400, { error: 'Nenhum arquivo enviado' }); reply(200, savedFile); }
  bb.on('file', (fieldname, fileStream, info) => {
    fileSeen = true;
    const { filename, mimeType } = info;
    if (!filename) { fileStream.resume(); return; }
    const ext = path.extname(filename) || '';
    const savePath = path.join(t.uploadsDir, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    const out = fs.createWriteStream(savePath);
    pendingWrites++;
    fileStream.on('limit', () => { out.destroy(); fs.unlink(savePath, () => {}); pendingWrites = Math.max(0, pendingWrites - 1); reply(400, { error: 'Arquivo muito grande (máximo 200 MB)' }); });
    fileStream.pipe(out);
    out.on('finish', () => {
      createVideoDerivatives(savePath, mimeType);
      const storedName = path.basename(savePath);
      savedFile = {
        path: savePath,
        name: filename,
        url: '/uploads/' + t.clientId + '/' + storedName,
        downloadUrl: '/download/' + encodeURIComponent(t.clientId) + '/' + encodeURIComponent(storedName) + '?name=' + encodeURIComponent(filename),
      };
      pendingWrites = Math.max(0, pendingWrites - 1);
      tryRespond();
    });
    out.on('error', e => reply(500, { error: e.message }));
  });
  bb.on('error', e => reply(500, { error: e.message }));
  bb.on('close', () => { bbDone = true; if (!fileSeen) return reply(400, { error: 'Nenhum arquivo enviado' }); tryRespond(); });
  req.pipe(bb);
});

// Schedules
app.post('/api/schedules', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const { recipientType, recipientId, recipientName, message, documentPath, documentName, bulkId, connectionId } = req.body;
  const quickReplies = normalizeQuickReplies(req.body.quickReplies);
  const scheduledFor = Number(req.body.scheduledFor);
  const connId = connectionId || null;
  const isGroupTarget = recipientType === 'group' || isGroupRecipientId(recipientId);
  const useCloud = !isGroupTarget && ((connId && String(connId).startsWith('cloud')) || (!connId && t.provider === 'cloud'));
  const normalizedRecipientId = useCloud ? normalizePhoneNumber(recipientId) : recipientId;
  if (!normalizedRecipientId) return res.status(400).json({ error: 'Selecione um destinatario valido' });
  if (!message) return res.status(400).json({ error: 'Digite uma mensagem' });
  if (!scheduledFor || isNaN(scheduledFor)) return res.status(400).json({ error: 'Data e hora invalida' });
  if (scheduledFor <= Date.now()) return res.status(400).json({ error: 'A data deve ser no futuro' });
  const id = t.db.createSchedule({ recipientType: isGroupTarget ? 'group' : 'contact', recipientId: normalizedRecipientId, recipientName: recipientName || normalizedRecipientId, message, scheduledFor, documentPath, documentName, quickReplies, bulkId, connectionId: connId });
  res.json({ id });
});

// Filtra por "entrou nesta coluna entre estas datas" (calendário do disparo) — reaproveita
// getColumnEntryEvents (já existe pro dashboard medir visitas) pra achar quais cards
// entraram na coluna dentro do período, sem duplicar a lógica de histórico.
function cardsEnteredColumnIdSet(t, columnId, fromKey, toKey) {
  if (!columnId || !fromKey) return null;
  try {
    const { start } = brDayBounds(fromKey);
    const { start: toStart } = brDayBounds(toKey || fromKey);
    const end = toStart + 24 * 60 * 60 * 1000;
    const events = t.db.getColumnEntryEvents(columnId, start, end);
    return new Set(events.map(e => e.cardId));
  } catch (e) { return null; }
}
// Filtra por "última mensagem (enviada OU recebida) caiu dentro deste período" — segunda
// opção de data que o disparo em massa oferece, alternativa a "data de entrada na coluna".
// Casa por telefone (últimos 8 dígitos, mesmo padrão usado em todo o CRM) porque messages.contact_id
// é um JID (ex.: 5551999999999@s.whatsapp.net) e crm_cards guarda telefone em formatos variados.
function cardsLastMessageInRangeSet(t, cards, fromKey, toKey) {
  if (!fromKey) return null;
  try {
    const { start } = brDayBounds(fromKey);
    const { start: toStart } = brDayBounds(toKey || fromKey);
    const end = toStart + 24 * 60 * 60 * 1000;
    const rows = t.db.getLastMessageTimestamps();
    const lastByDigits = new Map();
    rows.forEach(r => {
      const d = String(r.contactId || '').replace(/\D/g, '');
      if (d.length < 8) return;
      const key = d.slice(-8);
      const cur = lastByDigits.get(key);
      if (cur == null || r.at > cur) lastByDigits.set(key, r.at);
    });
    const matchSet = new Set();
    cards.forEach(c => {
      for (const v of [c.phone, c.whatsapp, c.whatsappId]) {
        const d = String(v || '').replace(/\D/g, '');
        if (d.length < 8) continue;
        const at = lastByDigits.get(d.slice(-8));
        if (at != null && at >= start && at < end) { matchSet.add(c.id); break; }
      }
    });
    return matchSet;
  } catch (e) { return null; }
}
app.get('/api/broadcast/targets', requireAuth, requireAnyFeature(['broadcast','schedule']), async (req, res) => {
  const t = getTenant(req.clientId);
  const source = String(req.query.source || 'crm');
  try {
    if (source === 'groups') {
      const groups = await refreshGroups(t, { force: true });
      return res.json(groups.map(g => ({ id: g.id, name: g.name, type: 'group' })));
    }
    if (source === 'contacts') {
      const contacts = await refreshContacts(t);
      return res.json(contacts.map(c => ({ id: c.id, name: c.name, type: 'contact' })));
    }
    const labels = String(req.query.labels || '').split(',').map(s => s.trim()).filter(Boolean);
    const funnelId = String(req.query.funnelId || '').trim();
    const columnId = String(req.query.columnId || '').trim();
    const enteredFrom = String(req.query.enteredFrom || '').trim();
    const enteredTo = String(req.query.enteredTo || '').trim();
    const dateMode = String(req.query.dateMode || 'entrada').trim();
    const limit = Math.max(0, Number(req.query.limit) || 0);
    const cards = funnelId ? t.db.getCrmCards(funnelId) : t.db.getCrmCards();
    const enteredSet = dateMode === 'ultimaMsg' ? cardsLastMessageInRangeSet(t, cards, enteredFrom, enteredTo) : cardsEnteredColumnIdSet(t, columnId, enteredFrom, enteredTo);
    const targets = cards.filter(card => {
      if (columnId && String(card.columnId || '') !== columnId) return false;
      if (enteredSet && !enteredSet.has(card.id)) return false;
      const cardLabels = Array.isArray(card.labels) ? card.labels : (card.label ? [card.label] : []);
      return labels.length === 0 || labels.every(label => cardLabels.includes(label));
    }).map(card => {
      const phone = String(card.phone || '').replace(/\D/g, '');
      const id = phone ? `${phone}@c.us` : (isLidJid(card.whatsappId) ? '' : (card.whatsappId || ''));
      return id ? { id, name: card.contactName || card.phone || id, type: id.endsWith('@g.us') ? 'group' : 'contact', cardId: card.id, labels: Array.isArray(card.labels) ? card.labels : (card.label ? [card.label] : []) } : null;
    }).filter(Boolean);
    // countOnly: o front so quer saber quantos existem, sem trazer a lista inteira.
    if (String(req.query.countOnly || '') === '1') return res.json({ count: targets.length });
    // Blocos de 5: o front pede em multiplos, aqui so cortamos no tamanho pedido.
    res.json(limit ? targets.slice(0, limit) : targets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════ Disparo de MODELO (template Meta) em massa por coluna ═══════════
// Reaproveita a busca de alvos por pipeline/coluna e o mesmo envio do send-template do chat.
// Roda em BACKGROUND com pacing (4-7s entre envios) pra não tomar flag de spam. Progresso
// fica em t._tplBcast[jobId], lido pelo /status. Preenche {{1}} com o 1o nome do lead quando
// o param vier como o sentinel "__NOME__".
app.post('/api/broadcast/send-template', requireAuth, requireAnyFeature(['broadcast','schedule']), async (req, res) => {
  const t = getTenant(req.clientId);
  const slot = String(req.body && req.body.slot || '1');
  const name = String(req.body && req.body.name || '').trim();
  const language = String(req.body && req.body.language || 'pt_BR').trim();
  const funnelId = String(req.body && req.body.funnelId || '').trim();
  const columnId = String(req.body && req.body.columnId || '').trim();
  const moveToColumnId = String(req.body && req.body.moveToColumnId || '').trim();
  const enteredFrom = String(req.body && req.body.enteredFrom || '').trim();
  const enteredTo = String(req.body && req.body.enteredTo || '').trim();
  const dateMode = String(req.body && req.body.dateMode || 'entrada').trim();
  // O tamanho do bloco e obrigatorio. Nunca trate valor ausente/invalido como
  // "todos", pois isso pode enfileirar a coluna inteira por engano.
  const rawBlockLimit = req.body && (req.body.blockLimit ?? req.body.limit);
  const blockLimit = Number(rawBlockLimit);
  const paramsTemplate = Array.isArray(req.body && req.body.params) ? req.body.params.map(x => String(x == null ? '' : x)) : [];
  if (!name) return res.status(400).json({ error: 'Escolha um modelo.' });
  if (!columnId) return res.status(400).json({ error: 'Escolha a coluna.' });
  if (!Number.isInteger(blockLimit) || blockLimit < 1) return res.status(400).json({ error: 'Informe uma quantidade valida para o bloco.' });
  const creds = getTemplateCloudCreds(t, slot);
  const pnid = getCloudSlot(t, slot).phoneNumberId;
  if (!creds.accessToken || !pnid) return res.status(409).json({ error: 'API Oficial não conectada neste slot.' });
  const cardsBase = (funnelId ? t.db.getCrmCards(funnelId) : t.db.getCrmCards()).filter(c => String(c.columnId || '') === columnId);
  const enteredSet = dateMode === 'ultimaMsg' ? cardsLastMessageInRangeSet(t, cardsBase, enteredFrom, enteredTo) : cardsEnteredColumnIdSet(t, columnId, enteredFrom, enteredTo);
  const cards = cardsBase.filter(c => !enteredSet || enteredSet.has(c.id));
  const seen = new Set();
  const targets = [];
  for (const c of cards) {
    // BUG achado 26/09/2026: aqui só olhava c.phone — muitos leads (77 só na Repescagem
    // da sulsolar) têm o número salvo em whatsapp/whatsappId e ficavam de fora do disparo
    // sem erro nenhum (a contagem em /api/broadcast/targets já usava esse fallback, então
    // a tela mostrava "vai enviar pra 52" e só mandava pra 1). Mesmo fallback usado no
    // resto do CRM (phone -> whatsapp -> whatsappId).
    const digits = String(c.phone || c.whatsapp || c.whatsappId || '').replace(/\D/g, '');
    if (!digits) continue;
    const to = normalizeBrazilianMobileDigits(normalizePhoneNumber(digits));
    if (!to || seen.has(to)) continue;
    seen.add(to);
    targets.push({ to, name: String(c.contactName || '').trim(), contactId: `${digits}@s.whatsapp.net` });
  }
  if (!targets.length) return res.status(400).json({ error: 'Nenhum lead com WhatsApp nessa coluna.' });
  const sendTargets = targets.slice(0, blockLimit);
  // Enfileira na MESMA fila do disparo de texto: agendamentos escalonados (40s entre
  // envios, pausa de 5min a cada 5) e o dispatcher manda o template (sendCloudScheduledMessage
  // lê schedule.templatePayload). Persistente e monitorável em Disparos > Pendentes.
  const now = Date.now();
  const pendingList = t.db.getSchedules();
  const intervalMs = t.provider === 'cloud' ? CLOUD_DISPATCH_INTERVAL_MS : DISPATCH_INTERVAL_MS, batchSize = BULK_BATCH_SIZE, restMs = t.provider === 'cloud' ? 0 : BULK_REST_MS;
  const pendingBase = pendingList.length ? pendingList[pendingList.length - 1].scheduledFor + intervalMs : now + 1000;
  const base = Math.max(now + 1000, pendingBase);
  const bulkId = `bulk-tpl-${now.toString(36)}`;
  let created = 0;
  sendTargets.forEach((tg, index) => {
    const firstName = (tg.name && /[A-Za-zÀ-ÿ]/.test(tg.name)) ? tg.name.split(/\s+/)[0] : '';
    const params = paramsTemplate.map(pp => pp === '__NOME__' ? firstName : pp);
    const scheduledFor = base + (index * intervalMs) + Math.floor(index / batchSize) * restMs;
    const preview = `\uD83D\uDCCB Modelo: ${name}` + (firstName ? ` (${firstName})` : '');
    try { t.db.createSchedule({ recipientType: 'contact', recipientId: tg.to, recipientName: tg.name || tg.to, message: preview, scheduledFor, connectionId: 'cloud' + slot, bulkId, templatePayload: { name, language, params } }); created++; } catch (e) {}
  });
  // Roteamento por resposta: SIM -> Em qualificacao, NAO -> Negocio perdido (colunas do funil).
  try {
    const _norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const _cols = t.db.getCrmColumns() || [];
    const _pick = (re) => { let list = funnelId ? _cols.filter(c => String(c.funnelId) === String(funnelId)) : _cols; let h = list.find(c => re.test(_norm(c.name))); if (!h && funnelId) h = _cols.find(c => re.test(_norm(c.name))); return h ? h.id : ''; };
    const yesColumnId = _pick(/em qualifica/);
    const noColumnId = _pick(/negocio perdido|(^|\s)perdido/);
    if (yesColumnId || noColumnId || moveToColumnId) {
      const rules = getBroadcastRules(t); rules[bulkId] = { onReply: { yesColumnId, noColumnId }, moveToColumnId, createdAt: now }; saveBroadcastRules(t, rules);
    }
    if (yesColumnId || noColumnId) {
      const w = getReplyWatch(t); sendTargets.forEach(tg => { const d = String(tg.to).replace(/\D/g, ''); if (d) w[d.slice(-8)] = { bulkId, at: now }; }); saveReplyWatch(t, w);
    }
  } catch (e) {}
  // Progresso ao vivo (contador "X de Y enviados"): o dispatcher incrementa .sent/.failed
  // conforme processa cada agendamento deste bulkId (ver processDispatchQueue). O envio em
  // si continua pelo mesmo mecanismo de sempre (fila persistente, 500ms/sem pausa no Cloud).
  t._tplBcast = t._tplBcast || {};
  t._tplBcast[bulkId] = { total: created, sent: 0, failed: 0, startedAt: now, provider: t.provider };
  res.json({ ok: true, total: created, remaining: Math.max(0, targets.length - sendTargets.length), scheduled: true, bulkId, jobId: bulkId });
});
app.get('/api/broadcast/send-template/status', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  const t = getTenant(req.clientId);
  const job = (t._tplBcast || {})[String(req.query.jobId || '')];
  if (!job) return res.status(404).json({ error: 'job não encontrado' });
  const done = (job.sent + job.failed) >= job.total;
  res.json({ ...job, done });
});

// ═══════════ Regras por campanha (disparo) ═══════════
// Guardadas por bulkId: o que fazer com o lead depois do envio e quando ele responder.
function getBroadcastRules(t) {
  const c = (t.db.getConfig() || {}).broadcastRules;
  return (c && typeof c === 'object') ? c : {};
}
function saveBroadcastRules(t, r) { t.db.updateConfig({ broadcastRules: r }); }
function getReplyWatch(t) {
  const c = (t.db.getConfig() || {}).broadcastReplyWatch;
  return (c && typeof c === 'object') ? c : {};
}
function saveReplyWatch(t, r) {
  // guarda no maximo 5000 telefones em observacao, descartando os mais antigos
  const ent = Object.entries(r).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 5000);
  t.db.updateConfig({ broadcastReplyWatch: Object.fromEntries(ent) });
}
function sanitizeBroadcastRule(b) {
  b = b || {};
  const rep = b.onReply || {};
  return {
    moveToColumnId: String(b.moveToColumnId || '').trim(),
    onReply: {
      columnId: String(rep.columnId || '').trim(),
      funnelId: String(rep.funnelId || '').trim(),
      owner: String(rep.owner || '').trim(),
    },
    createdAt: Date.now(),
  };
}
// Aplica ao card o que a campanha mandou fazer depois do envio.
// Contagem de templates da API Oficial enviados por dia (Brasília) — pro dashboard mostrar
// "quantos templates enviei no período". Bucket diário (leve, sem crescer sem limite) com
// total + quebra por nome de template. Cobre TODO envio de template (bulk, follow-up, avulso).
function logTemplateSend(t, templateName) {
  try {
    const day = brDateKey(Date.now());
    const cfg = t.db.getConfig() || {};
    const counts = (cfg.templateSendCounts && typeof cfg.templateSendCounts === 'object') ? cfg.templateSendCounts : {};
    const bucket = (counts[day] && typeof counts[day] === 'object') ? counts[day] : { total: 0, byTemplate: {} };
    bucket.total = (bucket.total || 0) + 1;
    const name = String(templateName || 'sem_nome');
    bucket.byTemplate = bucket.byTemplate || {};
    bucket.byTemplate[name] = (bucket.byTemplate[name] || 0) + 1;
    counts[day] = bucket;
    const days = Object.keys(counts).sort();
    if (days.length > 400) { for (const d of days.slice(0, days.length - 400)) delete counts[d]; }
    t.db.updateConfig({ templateSendCounts: counts });
  } catch (e) {}
}
function applyPosEnvio(t, schedule) {
  try {
    if (!schedule || !schedule.bulkId) return;
    const regra = getBroadcastRules(t)[schedule.bulkId];
    if (!regra) return;
    const digits = String(schedule.recipientId || '').replace(/@.*/, '').replace(/\D/g, '');
    if (!digits) return;
    const precisaCard = regra.moveToColumnId || schedule.templatePayload;
    let card = null;
    if (precisaCard) card = findCrmCardForChat(t, `${digits}@s.whatsapp.net`) || findCrmCardForChat(t, digits);
    if (regra.moveToColumnId && card) {
      const col = (t.db.getCrmColumns() || []).find(c => String(c.id) === String(regra.moveToColumnId));
      const campos = { columnId: regra.moveToColumnId };
      if (col && col.funnelId) campos.funnelId = col.funnelId;
      t.db.updateCrmCard(card.id, campos);
    }
    // Disparo de template: carimba o card como "recebido, pendente de resposta". Só passa aqui
    // quem REALMENTE enviou (applyPosEnvio roda apos markSent), entao nao conta quem bateu o teto do tier.
    if (schedule.templatePayload && card) {
      const cf = card.customFields || {};
      if (cf.disparoResp !== 'sim' && cf.disparoResp !== 'nao') {
        t.db.updateCrmCard(card.id, { customFields: Object.assign({}, cf, { disparoDia: brDateKey(Date.now()), disparoResp: 'pendente' }) });
      }
    }
    const rep = regra.onReply || {};
    if (rep.columnId || rep.funnelId || rep.owner || rep.yesColumnId || rep.noColumnId) {
      const w = getReplyWatch(t);
      w[digits.slice(-8)] = { bulkId: schedule.bulkId, at: Date.now() };
      saveReplyWatch(t, w);
    }
  } catch (e) {}
}

// Lead da campanha respondeu: move de coluna/pipeline e/ou troca o dono.
// Classifica a resposta do lead como afirmativa (sim) ou negativa (nao) pro roteamento.
function classifyReplySimNao(text) {
  const s = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!s) return null;
  if (/^n+ao?$/.test(s) || s === 'n' || s === 'nop' || s === 'nunca' || s === 'jamais') return 'no';
  if (/(^|\s|,|\.)(nao|agora nao|no momento nao|sem interesse|nao quero|nao tenho interesse|nao me interessa|nao pode|nao vou|nao da|nao obrigad|deixa pra la|para de|parar|pare|descadastr|sair|cancela)(\s|,|\.|!|\?|$)/.test(s)) return 'no';
  if (/(^|\s|,|\.)(sim|isso|claro|pode|podemos|quero|bora|vamos|com certeza|positivo|ok|okay|beleza|blz|dale|manda|segue|continuar|pode continuar|pode sim|prosseguir)(\s|,|\.|!|\?|$)/.test(s) || /\ud83d\udc4d|\u2705/.test(String(text || ''))) return 'yes';
  return null;
}
function aplicarRespostaCampanha(t, storageJid, text) {
  try {
    const digits = String(storageJid || '').replace(/@.*/, '').replace(/\D/g, '');
    if (!digits) return;
    const chave = digits.slice(-8);
    const w = getReplyWatch(t);
    const alvo = w[chave];
    if (!alvo) return;
    const regra = (getBroadcastRules(t)[alvo.bulkId] || {}).onReply || {};
    const card = findCrmCardForChat(t, storageJid) || findCrmCardForChat(t, digits);
    const cls = classifyReplySimNao(text);
    // Etiqueta de INTERESSE + rastreio do disparo (dia do disparo = alvo.at, guardado no card).
    let novasLabels = null, novoCF = null;
    if (card) {
      const interesse = cls === 'no' ? 'Sem interesse' : 'Tem interesse';
      const oposto = cls === 'no' ? 'Tem interesse' : 'Sem interesse';
      let ls = Array.isArray(card.labels) ? card.labels.slice() : (card.label ? [card.label] : []);
      ls = ls.filter(l => String(l).toLowerCase() !== oposto.toLowerCase());
      if (!ls.some(l => String(l).toLowerCase() === interesse.toLowerCase())) ls.push(interesse);
      novasLabels = ls;
      novoCF = Object.assign({}, card.customFields || {}, { disparoDia: brDateKey(alvo.at || Date.now()), disparoResp: (cls === 'no' ? 'nao' : 'sim') });
    }
    const isCond = !!(regra.yesColumnId || regra.noColumnId);
    let targetColumnId = '';
    if (isCond) {
      if (cls === 'yes') targetColumnId = regra.yesColumnId || '';
      else if (cls === 'no') targetColumnId = regra.noColumnId || '';
      else {
        // ambiguo: etiqueta "Tem interesse" + rastreio, mas nao move de coluna nem tira do watch
        if (card) t.db.updateCrmCard(card.id, { labels: novasLabels, customFields: novoCF });
        return;
      }
    } else {
      targetColumnId = regra.columnId || '';
      if (!targetColumnId && !regra.funnelId && !regra.owner) {
        if (card) t.db.updateCrmCard(card.id, { labels: novasLabels, customFields: novoCF });
        delete w[chave]; saveReplyWatch(t, w); return;
      }
    }
    delete w[chave]; saveReplyWatch(t, w);
    if (!card) return;
    const campos = {};
    if (novasLabels) campos.labels = novasLabels;
    if (novoCF) campos.customFields = novoCF;
    if (targetColumnId) {
      campos.columnId = targetColumnId;
      const col = (t.db.getCrmColumns() || []).find(c => String(c.id) === String(targetColumnId));
      if (col && col.funnelId) campos.funnelId = col.funnelId;
    } else if (regra.funnelId) campos.funnelId = regra.funnelId;
    if (regra.owner) campos.owner = regra.owner;
    if (Object.keys(campos).length) {
      t.db.updateCrmCard(card.id, campos);
      console.log(`[${t.clientId}] campanha: ${card.contactName || digits} respondeu -> col:${targetColumnId || '-'} resp:${novoCF ? novoCF.disparoResp : '?'}`);
    }
  } catch (e) {}
}

const MADRUGADA_INTERVAL_MS = 2 * 60 * 1000;   // 2min entre envios
const MADRUGADA_REST_MS     = 20 * 60 * 1000;  // 20min de pausa a cada bloco

// Recebe uma lista (colada ou de arquivo CSV) e devolve destinatarios prontos.
// Aceita "Nome;Telefone", "Nome,Telefone" ou so o telefone, um por linha.
app.post('/api/broadcast/parse-list', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  const texto = String((req.body && req.body.text) || '');
  const linhas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  const vistos = new Set();
  let invalidos = 0, repetidos = 0;
  for (const [i, linha] of linhas.entries()) {
    const partes = linha.split(/[;,\t]/).map(x => x.trim());
    let nome = '', tel = '';
    if (partes.length >= 2) { nome = partes[0]; tel = partes[partes.length - 1]; }
    else { tel = partes[0]; }
    let d = String(tel).replace(/\D/g, '');
    if (i === 0 && !d && /nome|telefone|celular|phone/i.test(linha)) continue; // cabecalho
    if (d.length < 10) { invalidos++; continue; }
    if (!d.startsWith('55')) d = '55' + d;
    const k = d.slice(-8);
    if (vistos.has(k)) { repetidos++; continue; }
    vistos.add(k);
    out.push({ id: `${d}@c.us`, name: nome || d, type: 'contact' });
  }
  res.json({ targets: out, total: linhas.length, validos: out.length, invalidos, repetidos });
});

// Previa da personalizacao: devolve como o texto sai para os primeiros destinatarios.
app.post('/api/broadcast/preview-message', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  const texto = String((req.body && req.body.message) || '');
  const nomes = Array.isArray(req.body && req.body.names) ? req.body.names.slice(0, 3) : [];
  if (!nomes.length) nomes.push('');
  res.json({ exemplos: nomes.map(n => ({ nome: n, texto: aplicaTagsMensagem(texto, n) })) });
});

app.post('/api/broadcast/enqueue', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  const t = getTenant(req.clientId);
  const message = String(req.body?.message || '').trim();
  const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const documentPath = req.body?.documentPath || null;
  const documentName = req.body?.documentName || null;
  const quickReplies = normalizeQuickReplies(req.body?.quickReplies);
  const mode = req.body?.mode === 'madrugada' ? 'madrugada' : 'normal';

  if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
  if (!targets.length) return res.status(400).json({ error: 'Selecione ao menos um destinatário' });
  const hasGroupTarget = targets.some(target => isGroupRecipientId(target?.id));

  // Ritmo: se o usuario nao informar, segue a regra padrao do app.
  const _intervalSec = Number(req.body?.intervalSec) || 0;
  const _batchSize   = Number(req.body?.batchSize) || 0;
  const _restMin     = Number(req.body?.restMin) || 0;
  const intervalMs = _intervalSec > 0 ? Math.max(5, Math.min(3600, _intervalSec)) * 1000
    : (mode === 'madrugada' ? MADRUGADA_INTERVAL_MS : DISPATCH_INTERVAL_MS);
  const restMs = _restMin > 0 ? Math.max(1, Math.min(720, _restMin)) * 60 * 1000
    : (mode === 'madrugada' ? MADRUGADA_REST_MS : BULK_REST_MS);
  const batchSize = _batchSize > 0 ? Math.max(1, Math.min(500, _batchSize)) : BULK_BATCH_SIZE;
  const _connEscolhida = String(req.body?.connectionId || '').trim() || null;
  const startAt    = Number(req.body?.startAt) || null;
  const endAt      = Number(req.body?.endAt)   || null;

  // Protocolo Madrugada: filtra destinatários que já receberam nas últimas 24h
  let filteredTargets = targets;
  let filteredOut = 0;
  if (mode === 'madrugada') {
    const alreadySent = new Set(t.db.getRecentSuccessLogs(24 * 60 * 60 * 1000).map(l => l.recipientId));
    filteredTargets = targets.filter(tgt => !alreadySent.has(String(tgt.id || '')));
    filteredOut = targets.length - filteredTargets.length;
  }

  if (!filteredTargets.length) return res.status(400).json({ error: `Todos os ${targets.length} destinatários já receberam mensagem nas últimas 24h.` });

  const now = Date.now();
  const pending = t.db.getSchedules();
  const pendingBase = pending.length ? pending[pending.length - 1].scheduledFor + intervalMs : now + 1000;
  const requestedBase = startAt && startAt > now ? startAt : now + 1000;
  // Data escolhida na tela manda. Sem escolha, entra depois do que ja esta na fila
  // pra duas campanhas nao se atropelarem. Mesmo sobrepondo, o dispatcher respeita
  // o intervalo minimo entre envios, entao o numero nao leva rajada.
  const base = startAt && startAt > now ? requestedBase : Math.max(requestedBase, pendingBase);

  const bulkId = `bulk-${mode === 'madrugada' ? 'mad' : ''}-${now.toString(36)}`;
  let created = 0;
  filteredTargets.forEach((target, index) => {
    const recipientId = String(target.id || '').trim();
    if (!recipientId) return;
    const extraRest = Math.floor(index / batchSize) * restMs;
    const scheduledFor = base + (index * intervalMs) + extraRest;
    if (endAt && scheduledFor > endAt) return; // não agenda além do horário de término
    const targetType = target.type || (recipientId.endsWith('@g.us') ? 'group' : 'contact');
    // Numero escolhido na tela vale para todos; sem escolha, decide na hora do envio.
    const connectionId = target.connectionId || _connEscolhida || (targetType === 'group' ? 'web' : null);
    t.db.createSchedule({ recipientType: targetType, recipientId, recipientName: target.name || recipientId, message, scheduledFor, documentPath, documentName, quickReplies, bulkId, connectionId });
    created++;
  });

  if (!created) return res.status(400).json({ error: 'Nenhuma mensagem criada — verifique o intervalo de horário informado.' });

  // Guarda o que fazer com estes leads depois do envio e quando responderem.
  const _regra = sanitizeBroadcastRule(req.body);
  if (_regra.moveToColumnId || _regra.onReply.columnId || _regra.onReply.funnelId || _regra.onReply.owner) {
    const todas = getBroadcastRules(t);
    todas[bulkId] = _regra;
    // limpa regras com mais de 60 dias
    const corte = Date.now() - 60 * 86400000;
    for (const k of Object.keys(todas)) if ((todas[k].createdAt || 0) < corte) delete todas[k];
    saveBroadcastRules(t, todas);
  }
  // Avisa quando a fila existente empurrou o inicio para depois do pedido.
  const _empurrado = (!startAt && pendingBase > requestedBase) ? Math.round((pendingBase - requestedBase) / 1000) : 0;
  // Escolheu data mas ja ha fila naquele periodo: avisa que vao se intercalar.
  const _sobrepoe = !!(startAt && pending.some(x => x.scheduledFor >= base));
  res.json({
    ok: true, bulkId, created, filteredOut, mode, startsAt: base, hasGroupTarget,
    adiadoPorFilaSegundos: _empurrado,
    sobrepoeFila: _sobrepoe,
    pendentesAntes: pending.length,
    connectionId: _connEscolhida || null,
    rule: { intervalSeconds: intervalMs / 1000, batchSize, restMinutes: restMs / 60000 },
  });
});

// Resolve a conexão ATUAL configurada para o grupo de destino (canal de planilha),
// para que reenvios ("Enviar agora"/"Voltar à fila") usem o WhatsApp atual do canal
// e não a conexão antiga gravada na mensagem que falhou.
async function currentConnectionForRecipient(t, recipientId, fallback = null) {
  if (!recipientId || !isGroupRecipientId(recipientId)) return fallback;
  const cfg = t.db.getConfig();
  const target = normalizeJid(recipientId);
  const channels = Array.isArray(cfg.sheetsChannels) ? cfg.sheetsChannels : [];
  const ch = channels.find(c => c.groupId && normalizeJid(c.groupId) === target);
  if (ch && ch.connectionId) return ch.connectionId;
  if (cfg.sheetsGroupId && normalizeJid(cfg.sheetsGroupId) === target && cfg.sheetsConnectionId) return cfg.sheetsConnectionId;
  // Relatórios de clientes não usam, necessariamente, um canal de planilha.
  // Resolve a conexão atual (Lite primeiro) em vez de reaproveitar uma rota QR antiga.
  try { return (await weeklyGroupConnection(t)) || fallback; } catch (_) { return fallback; }
}

// Relatórios semanais seguem a conexão operacional atual. Assim, uma configuração
// antiga de planilha apontando para QR Code não desvia o reenvio de um grupo Lite.
async function currentConnectionForReportRetry(t, log) {
  if (isGroupRecipientId(log && log.recipientId) && weeklyIsReportMessage(log && log.message)) {
    try {
      const connectionId = await weeklyGroupConnection(t);
      if (connectionId) return connectionId;
    } catch (_) {}
  }
  return currentConnectionForRecipient(t, log.recipientId, log.connectionId || null);
}

app.post('/api/broadcast/requeue-log/:id', requireAuth, requireAnyFeature(['broadcast','schedule']), async (req, res) => {
  const t = getTenant(req.clientId);
  const log = t.db.getLogs().find(l => String(l.id) === String(req.params.id));
  if (!log) return res.status(404).json({ error: 'Log não encontrado' });
  const pending = t.db.getSchedules();
  const now = Date.now();
  const base = Math.max(now + 1000, pending.length ? pending[pending.length - 1].scheduledFor + DISPATCH_INTERVAL_MS : now + 1000);
  const conn = await currentConnectionForReportRetry(t, log);
  t.db.createSchedule({ recipientType: log.recipientType, recipientId: log.recipientId, recipientName: log.recipientName, message: log.message, scheduledFor: base, documentPath: log.documentPath || null, documentName: log.documentName || null, quickReplies: log.quickReplies || [], bulkId: `manual-${now.toString(36)}`, connectionId: conn });
  res.json({ ok: true });
});

app.get('/api/broadcast/retry-failed', requireAuth, requireAnyFeature(['broadcast','schedule']), (req, res) => {
  const t = getTenant(req.clientId);
  const allLogs = t.db.getLogs();
  const lastSuccess = allLogs.filter(l => l.success).sort((a, b) => b.sentAt - a.sentAt)[0];
  const cutoff = lastSuccess ? lastSuccess.sentAt : 0;
  const seen = new Set();
  const count = allLogs
    .filter(l => !l.success && l.sentAt > cutoff)
    .filter(l => { if (seen.has(l.recipientId)) return false; seen.add(l.recipientId); return true; })
    .length;
  res.json({ count });
});

app.post('/api/broadcast/retry-failed', requireAuth, requireAnyFeature(['broadcast','schedule']), async (req, res) => {
  const t = getTenant(req.clientId);
  const allLogs = t.db.getLogs();
  // Find timestamp of last successful send
  const lastSuccess = allLogs.filter(l => l.success).sort((a, b) => b.sentAt - a.sentAt)[0];
  const cutoff = lastSuccess ? lastSuccess.sentAt : 0;
  // Only failures after the last success, deduplicated by recipient
  const seen = new Set();
  const toRetry = allLogs
    .filter(l => !l.success && l.sentAt > cutoff)
    .sort((a, b) => a.sentAt - b.sentAt)
    .filter(l => { if (seen.has(l.recipientId)) return false; seen.add(l.recipientId); return true; });
  if (!toRetry.length) return res.json({ requeued: 0 });
  const now = Date.now();
  const pending = t.db.getSchedules();
  const base = Math.max(now + 1000, pending.length ? pending[pending.length - 1].scheduledFor + DISPATCH_INTERVAL_MS : now + 1000);
  for (const [index, l] of toRetry.entries()) {
    const extraRest = Math.floor(index / BULK_BATCH_SIZE) * BULK_REST_MS;
    const scheduledFor = base + (index * DISPATCH_INTERVAL_MS) + extraRest;
    const conn = await currentConnectionForReportRetry(t, l);
    t.db.createSchedule({ recipientType: l.recipientType, recipientId: l.recipientId, recipientName: l.recipientName, message: l.message, scheduledFor, documentPath: l.documentPath || null, documentName: l.documentName || null, quickReplies: l.quickReplies || [], bulkId: `retry-${now.toString(36)}`, connectionId: conn });
  }
  res.json({ ok: true, requeued: toRetry.length });
});

app.get('/api/schedules', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getSchedules()));
app.get('/api/schedules/:id', requireAuth, (req, res) => {
  const s = getTenant(req.clientId).db.getScheduleById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Nao encontrado' });
  res.json(s);
});
app.put('/api/schedules/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const { recipientType, recipientId, recipientName, message, documentPath, documentName, connectionId } = req.body;
  const quickReplies = normalizeQuickReplies(req.body.quickReplies);
  const scheduledFor = Number(req.body.scheduledFor);
  const connId = connectionId || null;
  const isGroupTarget = recipientType === 'group' || isGroupRecipientId(recipientId);
  const useCloud = !isGroupTarget && ((connId && String(connId).startsWith('cloud')) || (!connId && t.provider === 'cloud'));
  const normalizedId = useCloud ? normalizePhoneNumber(recipientId) : recipientId;
  if (!normalizedId || !message || !scheduledFor || isNaN(scheduledFor)) return res.status(400).json({ error: 'Dados incompletos' });
  const ok = t.db.updateSchedule(req.params.id, { recipientType: isGroupTarget ? 'group' : 'contact', recipientId: normalizedId, recipientName: recipientName || normalizedId, message, scheduledFor, documentPath, documentName, quickReplies, connectionId: connId });
  if (!ok) return res.status(404).json({ error: 'Nao encontrado' });
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', requireAuth, (req, res) => { getTenant(req.clientId).db.deleteSchedule(req.params.id); res.json({ ok: true }); });
app.delete('/api/schedules', requireAuth, (req, res) => { const t = getTenant(req.clientId); const all = [...t.db.getSchedules(), ...t.db.getPendingSchedules()]; all.forEach(s => t.db.deleteSchedule(s.id)); t.pendingQueue = []; t.queuedIds.clear(); res.json({ ok: true, deleted: all.length }); });

app.get('/api/logs', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getLogs()));
app.post('/api/logs/:id/resend-now', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const log = t.db.getLogById(req.params.id);
  if (!log) return res.status(404).json({ error: 'Nao encontrado' });
  const conn = await currentConnectionForReportRetry(t, log);
  try {
    await dispatchScheduledMessage(t, { id: `manual-${Date.now()}`, ...log, connectionId: conn, quickReplies: log.quickReplies || [] });
    t.db.appendLog({ ...log, connectionId: conn }, true);
    res.json({ ok: true });
  } catch (e) { t.db.appendLog({ ...log, connectionId: conn }, false, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/reports', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getReport(req.query || {})));
app.get('/api/metrics/new-contacts', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getNewContactsByDay(req.query || {})));

// ─── Auto Atendimento ─────────────────────────────────────────
app.get('/api/auto-atendimento', requireAuth, (req, res) => {
  const cfg = getTenant(req.clientId).db.getConfig();
  res.json(cfg.autoAtendimento || { enabled: false, rules: [] });
});
app.put('/api/auto-atendimento', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const body = req.body || {};
  const funnels = Array.isArray(body.funnels) ? body.funnels.map((f, fi) => ({
    id: f.id || `funnel-${Date.now().toString(36)}-${fi}`,
    name: String(f.name || '').slice(0, 80) || `Funil ${fi + 1}`,
    enabled: f.enabled !== false,
    trigger: {
      keywords: (Array.isArray(f.trigger?.keywords) ? f.trigger.keywords : String(f.trigger?.keywords || '').split(',')).map(s => String(s).trim()).filter(Boolean),
      onFirstMessage: !!(f.trigger && f.trigger.onFirstMessage),
    },
    steps: (Array.isArray(f.steps) ? f.steps : []).map((s, si) => ({
      id: s.id || `step-${Date.now().toString(36)}-${fi}-${si}`,
      type: s.type === 'randomizer' ? 'randomizer' : 'message',
      x: (s.x != null && isFinite(s.x)) ? Math.round(Number(s.x)) : null,
      y: (s.y != null && isFinite(s.y)) ? Math.round(Number(s.y)) : null,
      text: String(s.text || '').slice(0, 2000),
      text2: String(s.text2 || '').slice(0, 2000),
      text2Off: String(s.text2Off || '').slice(0, 2000),
      gapSec: Math.max(0, Math.min(20, Number(s.gapSec) || 0)),
      status: ['quente', 'morno', 'frio'].includes(String(s.status || '').toLowerCase()) ? String(s.status).toLowerCase() : '',
      handoff: !!s.handoff,
      handoffReason: String(s.handoffReason || '').slice(0, 120),
      showButtons: !!s.showButtons,
      followup: (s.followup && s.followup.enabled) ? {
        enabled: true,
        afterValue: Math.max(1, Number(s.followup.afterValue) || 1),
        afterUnit: ['min', 'hour', 'day'].includes(String(s.followup.afterUnit)) ? String(s.followup.afterUnit) : 'min',
        action: ['message', 'goto', 'handoff', 'noreply'].includes(String(s.followup.action)) ? String(s.followup.action) : 'message',
        text: String(s.followup.text || '').slice(0, 2000),
        gotoStepId: String(s.followup.gotoStepId || '').trim() || null,
      } : { enabled: false },
      options: (Array.isArray(s.options) ? s.options : []).map((o, oi) => ({
        id: o.id || `opt-${Date.now().toString(36)}-${fi}-${si}-${oi}`,
        label: String(o.label || '').slice(0, 60),
        keywords: (Array.isArray(o.keywords) ? o.keywords : String(o.keywords || '').split(',')).map(x => String(x).trim()).filter(Boolean),
        weight: Math.max(0, Number(o.weight) || 0),
        nextStepId: String(o.nextStepId || '').trim() || null,
      })).filter(o => o.nextStepId),
    })),
  })) : [];
  const auto = { enabled: !!body.enabled, typingDelaySec: Math.max(0, Math.min(30, Number(body.typingDelaySec) != null ? Number(body.typingDelaySec) : 3)), funnels };
  t.db.updateConfig({ autoAtendimento: auto });
  res.json(auto);
});
app.get('/api/auto-atendimento/pending', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.listNeedsHuman()));
app.post('/api/auto-atendimento/reactivate/:contactId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const id = req.params.contactId;
  t.db.reactivateBot(id);
  const digits = normalizeBrazilianMobileDigits(normalizePhoneNumber(id));
  if (digits) t.db.reactivateBot(`${digits}@s.whatsapp.net`);
  res.json({ ok: true });
});
// Testa qual funil iniciaria para um texto (usado na tela de configuração)
app.post('/api/auto-atendimento/test', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = getAutoAtendimento(t);
  const funnel = pickFunnelToStart(cfg.funnels, String(req.body?.text || ''));
  const firstStep = funnel && Array.isArray(funnel.steps) ? funnel.steps[0] : null;
  res.json({ matched: !!funnel, funnelName: funnel ? funnel.name : '', firstReply: firstStep ? (firstStep.text || '') : '' });
});

// Chat
app.post('/api/chat/reset-sync', requireAuth, requireFeature('chat'), async (req, res) => {
  const t = getTenant(req.clientId);
  try {
    t.db.clearChatData();
    t.contacts = [];
    t.groups = [];
    t.syncFullHistoryOnce = true;
    t.msgStore.clear();
    res.json({ ok: true, syncing: true });
    await resetWebClient(t);
    const ready = await waitForWebClientReady(t, 30000);
    if (ready) await syncGroupsIntoChat(t);
  } catch (e) {
    console.error(`[${t.clientId}] Erro ao sincronizar chat:`, e.message);
  }
});

function liveChatGroupsDisabledForClient(clientId) {
  return String(clientId || '') === 'hw';
}

app.post('/api/chat/sync-groups', requireAuth, requireFeature('chat'), async (req, res) => {
  const t = getTenant(req.clientId);
  if (liveChatGroupsDisabledForClient(req.clientId)) return res.json({ ok: true, count: 0, disabled: true });
  if (![t.isReady, t.isReady2, t.isReady3, t.isGroupReady].some(Boolean)) return res.status(409).json({ error: 'Nenhum QR Code conectado' });
  try {
    const count = await syncGroupsIntoChat(t);
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chat', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  // Usuários convidados com conexão padrão só enxergam a própria conexão
  const forcedConnection = req.user?.defaultConnectionId || null;
  const connectionId = forcedConnection || req.query.connectionId || null;
  // 1 leitura leve da tabela de cards, reaproveitada em enrich + filtro de dono abaixo
  // (antes eram até 2 SELECT * completos por conversa nessa mesma requisição).
  const cardsForMatching = t.db.getCrmCardsForMatching();
  let conversations = enrichChatConversations(t, t.db.getConversations(connectionId, { archivedOnly: req.query.archived === '1' }), cardsForMatching);
  if (liveChatGroupsDisabledForClient(req.clientId)) {
    conversations = conversations.filter(c => !String(c.contactId || '').endsWith('@g.us'));
  }
  // "Só ver leads atribuídos a esta pessoa": mantém conversas sem card/sem dono ainda visíveis
  // (evita esconder lead novo), só esconde as já atribuídas a outra pessoa da equipe.
  if (req.user?.permissions?.restrictToOwnLeads) {
    conversations = conversations.filter(c => {
      const card = findCrmCardInList(cardsForMatching, c.contactId);
      return !card || !card.owner || card.owner === req.loginClientId;
    });
  }
  res.json(conversations);
});

// Lista os modelos APROVADOS da WABA (pra usar no chat, ex: reabrir conversa fora da janela de 24h)
app.get('/api/chat/templates', requireAuth, requireFeature('chat'), async (req, res) => {
  const t = getTenant(req.clientId);
  const slot = String(req.query.slot || '1');
  const creds = getTemplateCloudCreds(t, slot);
  if (!creds.accessToken || !creds.wabaId) return res.status(409).json({ error: 'Conecte a API Oficial para ver os modelos.' });
  try {
    const fields = 'name,status,category,language,components';
    const data = await graphRequestWithToken(creds.accessToken, `/${creds.wabaId}/message_templates?fields=${encodeURIComponent(fields)}&limit=100`);
    const list = (data.data || []).filter(x => String(x.status).toUpperCase() === 'APPROVED').map(x => {
      const comps = x.components || [];
      const body = comps.find(c => String(c.type).toUpperCase() === 'BODY');
      const header = comps.find(c => String(c.type).toUpperCase() === 'HEADER');
      const bodyText = (body && body.text) || '';
      const varCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
      const btns = comps.find(c => String(c.type).toUpperCase() === 'BUTTONS');
      return { name: x.name, language: x.language, category: x.category, bodyText, headerText: (header && header.text) || '', varCount, buttons: ((btns && btns.buttons) || []).map(b => b.text) };
    });
    res.json({ ok: true, slot, templates: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envia um modelo (template) pra um contato pela API Oficial
app.post('/api/chat/:contactId/send-template', requireAuth, requireFeature('chat'), async (req, res) => {
  const t = getTenant(req.clientId);
  const contactId = req.params.contactId;
  const slot = String(req.body?.slot || '1');
  const name = String(req.body?.name || '').trim();
  const language = String(req.body?.language || 'pt_BR').trim();
  const params = Array.isArray(req.body?.params) ? req.body.params.map(p => String(p == null ? '' : p)) : [];
  const preview = String(req.body?.preview || '').trim();
  if (!name) return res.status(400).json({ error: 'Modelo não informado.' });
  const creds = getTemplateCloudCreds(t, slot);
  const pnid = getCloudSlot(t, slot).phoneNumberId;
  if (!creds.accessToken || !pnid) return res.status(409).json({ error: 'API Oficial não conectada neste slot.' });
  const digits = String(contactId).replace(/@.*/, '').replace(/\D/g, '');
  const to = normalizeBrazilianMobileDigits(normalizePhoneNumber(digits));
  if (!to) return res.status(400).json({ error: 'Contato inválido para template (só 1:1, não grupo).' });
  const template = { name, language: { code: language } };
  if (params.length) template.components = [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }];
  try {
    const resp = await graphRequestWithToken(creds.accessToken, `/${pnid}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template } });
    const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id || null;
    logTemplateSend(t, name);
    pauseBotForContact(t, contactId);
    t.db.recordMessage({ direction: 'out', contactId: normalizeJid(contactId), contactName: '', text: preview || `[modelo] ${name}`, connectionId: 'cloud' + slot, wamid, deliveryStatus: wamid ? 'sent' : null });
    res.json({ ok: true, wamid });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/chat/:contactId/rename', requireAuth, requireFeature('chat'), (req, res) => {
  const t = getTenant(req.clientId);
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (!name && !phone) return res.status(400).json({ error: 'Informe ao menos nome ou telefone' });
  if (name) {
    const aliases = getChatContactAliases(t, req.params.contactId);
    aliases.forEach(alias => t.db.updateContactName(alias, name));
  }
  const card = findCrmCardForChat(t, req.params.contactId);
  const cardUpdate = {};
  if (name) cardUpdate.contactName = name;
  if (phone) cardUpdate.phone = phone;
  if (card && Object.keys(cardUpdate).length) t.db.updateCrmCard(card.id, cardUpdate);
  res.json({ ok: true, contactName: name, phone });
});
// Chat em tempo real (SSE). Precisa vir antes de /api/chat/:contactId, senão o Express
// tentaria casar "stream" como se fosse um contactId. requireAuth já aceita o token via
// ?t= (query), já que o EventSource do navegador não manda header Authorization customizado.
app.get('/api/chat/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx nao pode bufferizar isso, senao o evento so chega no proximo flush
  res.flushHeaders();
  const t = getTenant(req.clientId);
  t.chatSseClients.add(res);
  res.write(': connected\n\n');
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ka); t.chatSseClients.delete(res); });
});
app.get('/api/chat/:contactId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  if (liveChatGroupsDisabledForClient(req.clientId) && isGroupRecipientId(req.params.contactId)) {
    return res.json([]);
  }
  const aliases = getChatContactAliases(t, req.params.contactId);
  const byId = new Map();
  aliases.forEach(alias => t.db.getMessages(alias).forEach(msg => byId.set(msg.id, msg)));
  res.json([...byId.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-200));
});
app.delete('/api/chat/:contactId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const aliases = getChatContactAliases(t, req.params.contactId);
  aliases.forEach(alias => t.db.deleteConversation(alias));
  t.db.deleteConversation(req.params.contactId);
  res.json({ ok: true });
});
// Arquivar: some da lista principal, mas as mensagens continuam guardadas (dá pra restaurar).
app.post('/api/chat/:contactId/archive', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const aliases = getChatContactAliases(t, req.params.contactId);
  aliases.forEach(alias => t.db.archiveConversation(alias));
  t.db.archiveConversation(req.params.contactId);
  res.json({ ok: true });
});
app.post('/api/chat/:contactId/unarchive', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const aliases = getChatContactAliases(t, req.params.contactId);
  aliases.forEach(alias => t.db.unarchiveConversation(alias));
  t.db.unarchiveConversation(req.params.contactId);
  res.json({ ok: true });
});
// Marca a conversa como lida de verdade (zera a contagem real de não lidas usada no
// badge do Chat ao vivo) — chamado toda vez que o usuário abre uma conversa.
app.post('/api/chat/:contactId/read', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const aliases = getChatContactAliases(t, req.params.contactId);
  aliases.forEach(alias => t.db.markContactRead(alias));
  t.db.markContactRead(req.params.contactId);
  res.json({ ok: true });
});
app.post('/api/chat/:contactId/unread', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const aliases = getChatContactAliases(t, req.params.contactId);
  aliases.forEach(alias => t.db.markContactUnread(alias));
  t.db.markContactUnread(req.params.contactId);
  res.json({ ok: true });
});
// Lista enxuta (só ids) das conversas arquivadas — usada pelo Chat ao vivo pra
// esconder cards do CRM cuja conversa foi arquivada (sem isso, o card "orfão"
// afundava pro final da lista em vez de sumir).
app.get('/api/chat/archived-ids', requireAuth, (req, res) => {
  res.json(getTenant(req.clientId).db.getArchivedContactIds());
});
// ═══════════ Assinatura do atendente + dono do lead ═══════════
// A assinatura sai como prefixo em negrito ("*Fran:*") na mensagem enviada ao cliente.
function getChatSignature(t, user) {
  const all = (t.db.getConfig() || {}).chatSignatures || {};
  const id = String(user && user.id || '');
  const saved = all[id] || {};
  return {
    userId: id,
    name: String(saved.name || user && user.name || user && user.username || id || '').slice(0, 40),
    enabled: saved.enabled !== false,
  };
}
function applyChatSignature(t, user, text) {
  const sig = getChatSignature(t, user);
  if (!sig.enabled || !sig.name) return text;
  return '*' + sig.name + ':*\n' + text;
}
// Primeiro atendimento humano define o dono do lead, se ainda nao tiver.
function claimLeadOwner(t, contactId, loginId) {
  try {
    if (!loginId) return null;
    const alvo = normalizeJid(contactId);
    const digits = digitsFromJid(contactId);
    const card = (t.db.getCrmCards() || []).find(c => {
      if (c.whatsappId && normalizeJid(c.whatsappId) === alvo) return true;
      const cd = String(c.whatsapp || c.phone || '').replace(/\D/g, '');
      return !!cd && !!digits && (cd === digits || cd.endsWith(digits) || digits.endsWith(cd));
    });
    if (!card || card.owner) return card || null;
    t.db.updateCrmCard(card.id, { owner: loginId });
    return { ...card, owner: loginId };
  } catch (e) { return null; }
}
function getLeadTransfers(t) {
  const arr = (t.db.getConfig() || {}).leadTransfers;
  return Array.isArray(arr) ? arr : [];
}
function saveLeadTransfers(t, arr) { t.db.updateConfig({ leadTransfers: arr.slice(0, 200) }); }

app.get('/api/chat-signature', requireAuth, (req, res) => {
  res.json(getChatSignature(getTenant(req.clientId), req.user));
});
app.put('/api/chat-signature', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = (t.db.getConfig() || {}).chatSignatures || {};
  const id = String(req.user.id);
  cfg[id] = {
    name: String((req.body && req.body.name) || '').slice(0, 40),
    enabled: !(req.body && req.body.enabled === false),
  };
  t.db.updateConfig({ chatSignatures: cfg });
  res.json(getChatSignature(t, req.user));
});

// Usuarios do tenant, para atribuir/transferir lead e filtrar o chat.
// Delta dos cards: devolve so o que mudou desde 'since'. O chat usa isso pra refletir
// troca de dono/pipeline/etiqueta feita por outro usuario sem recarregar a pagina.
// Nome com hifen (e nao /cards/updates) pra nao colidir com as rotas /cards/:id/*.
app.get('/api/crm/cards-updates', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const since = Number(req.query.since) || 0;
  const cards = (t.db.getCrmCards() || [])
    .filter(c => Number(c.updatedAt || 0) > since)
    .map(c => ({
      id: c.id, owner: c.owner || '', funnelId: c.funnelId || '', columnId: c.columnId || '',
      contactName: c.contactName || '', label: c.label || null, labels: c.labels || [],
      updatedAt: c.updatedAt || 0,
    }));
  res.json({ now: Date.now(), cards });
});

app.post('/api/crm/cards/:id/transfer', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const para = String((req.body && req.body.to) || '').trim();
  if (!para) return res.status(400).json({ error: 'Informe o usuario de destino' });
  const card = (t.db.getCrmCards() || []).find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'Lead nao encontrado' });
  const validos = loadClients().filter(c => c.id === req.clientId || c.ownerClientId === req.clientId).map(c => c.id);
  if (!validos.includes(para)) return res.status(400).json({ error: 'Usuario invalido' });
  if (para === card.owner) return res.json({ ok: true, card, semMudanca: true });

  t.db.updateCrmCard(card.id, { owner: para });
  const deQuem = loadClients().find(c => c.id === req.loginClientId);
  const aviso = {
    id: 'trf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    to: para,
    fromId: req.loginClientId,
    fromName: (deQuem && (deQuem.name || deQuem.username)) || req.loginClientId,
    cardId: card.id,
    cardName: card.contactName || card.whatsapp || card.phone || 'Lead',
    whatsappId: card.whatsappId || '',
    at: Date.now(),
    seen: false,
  };
  // Atribuir para si mesmo nao gera pop-up: voce acabou de fazer a acao.
  if (para !== req.loginClientId) saveLeadTransfers(t, [aviso].concat(getLeadTransfers(t)));
  res.json({ ok: true, card: { ...card, owner: para }, aviso: para !== req.loginClientId ? aviso : null });
});

// Avisos de transferencia ainda nao vistos pelo usuario logado.
app.get('/api/crm/transfers/pending', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  res.json(getLeadTransfers(t).filter(x => !x.seen && x.to === req.loginClientId).slice(0, 10));
});
app.post('/api/crm/transfers/seen', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
  const arr = getLeadTransfers(t).map(x => (ids.includes(String(x.id)) && x.to === req.loginClientId) ? { ...x, seen: true } : x);
  saveLeadTransfers(t, arr);
  res.json({ ok: true });
});

app.post('/api/chat/:contactId/send', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const contactId = req.params.contactId;
  const textoOriginal = String(req.body?.text || '').trim();
  if (!textoOriginal) return res.status(400).json({ error: 'Mensagem vazia' });
  // Assinatura do atendente no texto que o cliente recebe.
  const text = isGroupRecipientId(contactId) ? textoOriginal : applyChatSignature(t, req.user, textoOriginal);
  // Primeiro humano que responde vira o dono do lead.
  if (!isGroupRecipientId(contactId)) claimLeadOwner(t, contactId, req.loginClientId);
  if (liveChatGroupsDisabledForClient(req.clientId) && isGroupRecipientId(contactId)) {
    return res.status(403).json({ error: 'Grupos do chat ao vivo estão desativados para esta conta.' });
  }
  // Atendente respondeu manualmente → pausa o bot de auto atendimento nesta conversa
  pauseBotForContact(t, contactId);
  // Roteamento estrito: cada conversa/grupo pertence a um número específico e deve responder por ele.
  // Não há fallback para outro número — cada contato/grupo tem sua etiqueta de conexão.
  const forcedConnectionId = req.body?.connectionId || null;
  const lastInbound = t.db.getConversations().find(c => c.contactId === contactId);
  const isGroupChat = isGroupRecipientId(contactId);
  const userPersonalWaba = req.user?.personalWaba;
  // Canal de resposta automatico: prioriza o canal pelo qual o CLIENTE chegou por ultimo
  // (ultima mensagem recebida), para que Lite e API Oficial nao se misturem. Se nao houver
  // entrada registrada, cai pro canal da ultima mensagem da conversa.
  const inboundConn = !isGroupChat ? t.db.getLastInboundConnection(contactId) : null;
  const autoConn = inboundConn || lastInbound?.connectionId || null;
  // WhatsApp Lite (Evolution) - envio dedicado (slots lite e lite2)
  const _liteConn = (forcedConnectionId === 'lite' || forcedConnectionId === 'lite2') ? forcedConnectionId
    : ((!forcedConnectionId && (autoConn === 'lite' || autoConn === 'lite2')) ? autoConn : null);
  if (_liteConn && liteEnabled(t) && !isGroupChat) {
    const _ld = String(contactId).replace(/@.*/, '').replace(/\D/g, '');
    const _lr = await evoReq('POST', `/message/sendText/${liteInstanceName(t, _liteConn === 'lite2' ? '2' : '1')}`, { number: _ld, text });
    if (!_lr.ok) {
      // Sem este log a falha de envio fica invisível: o 502 volta pro navegador e
      // não sobra rastro nenhum no servidor pra diagnosticar depois.
      const _det = typeof _lr.json === 'string' ? _lr.json : JSON.stringify(_lr.json || {});
      console.log(`[lite-send-text] falha ${_lr.status} slot=${_liteConn} para=${_ld}:`, _det.slice(0, 300));
      // "Connection Closed" = a instância diz estar aberta mas o socket do WhatsApp caiu.
      const _closed = /Connection Closed|428/.test(_det);
      return res.status(502).json({ error: _closed
        ? `WhatsApp Lite (${_liteConn}) perdeu a conexão com o WhatsApp. Reconecte em Configurações e tente de novo.`
        : 'Falha ao enviar pelo WhatsApp Lite', detail: _lr.json });
    }
    const _lc = normalizeBrazilianMobileDigits(_ld);
    // Guarda o id da mensagem na Evolution: e por ele que o recibo de entrega/leitura chega.
    const _lwamid = liteWamid(_lr.json);
    botMarkSent(t, _lwamid);
    t.db.recordMessage({ direction: 'out', contactId: `${_lc}@s.whatsapp.net`, contactName: _lc, text, connectionId: _liteConn, wamid: _lwamid, deliveryStatus: _lwamid ? 'sent' : null });
    return res.json({ ok: true, connection: _liteConn });
  }
  // Grupo: usa a conexão da última mensagem do grupo. 1:1: usa a conexão da última mensagem recebida.
  const rawConn = (userPersonalWaba && !isGroupChat)
    ? 'cloud_personal'
    : (forcedConnectionId || autoConn || (t.provider === 'cloud' ? 'cloud1' : 'web'));
  // Se a conversa estava marcada como cloud mas a conta não tem cloud configurado, volta pra web
  const cloudNotConfigured = rawConn.startsWith('cloud') && rawConn !== 'cloud_personal' && !t.WA_PHONE_NUMBER_ID;
  const effectiveConnection = cloudNotConfigured ? 'web' : rawConn;
  const useCloud = effectiveConnection.startsWith('cloud');
  let usedConnection = effectiveConnection;
  const { sock: webSock, ready: webReady } = resolveBaileysConnection(t, effectiveConnection);
  // Grupos via WhatsApp Lite (Evolution) quando o Baileys nao esta conectado — tenta os 2 slots
  if (isGroupChat && !useCloud && !webReady && liteEnabled(t)) {
    const _order = (forcedConnectionId === 'lite2' || lastInbound?.connectionId === 'lite2') ? ['2', '1'] : ['1', '2'];
    let _glast = null;
    for (const _sl of _order) {
      const _gr = await evoReq('POST', `/message/sendText/${liteInstanceName(t, _sl)}`, { number: contactId, text });
      _glast = _gr;
      if (_gr.ok) {
        const _gc = _sl === '2' ? 'lite2' : 'lite';
        t.db.recordMessage({ direction: 'out', contactId, contactName: (lastInbound && lastInbound.contactName) || contactId, text, connectionId: _gc });
        return res.json({ ok: true, connection: _gc });
      }
    }
    console.log(`[lite-send-grupo] falha ${_glast && _glast.status} grupo=${contactId}:`, JSON.stringify((_glast && _glast.json) || {}).slice(0, 300));
    return res.status(502).json({ error: 'Falha ao enviar pro grupo pelo WhatsApp Lite (verifique se o numero esta conectado e no grupo).', detail: _glast && _glast.json });
  }
  if (!useCloud && !webReady) return res.status(409).json({ error: `WhatsApp ${effectiveConnection} nao conectado. Aguarde a reconexão.` });
  if (!useCloud && webReady && !webSock?.user) return res.status(409).json({ error: `WhatsApp ${effectiveConnection} reconectando. Tente em alguns segundos.` });
  if (useCloud && !getStatusPayload(t).connected) return res.status(409).json({ error: 'WhatsApp nao conectado' });
  if (!useCloud && !isGroupChat) {
    try { assertBaileysConnectionHealthy(t, effectiveConnection); }
    catch (e) { return res.status(409).json({ error: e.message }); }
  }
  // Restrição nativa do WA após alto volume de envios em grupo
  if (!useCloud && !isGroupRecipientId(contactId)) {
    const lockKey = effectiveConnection === 'web' ? 'reachoutLocked' : `reachoutLocked_${effectiveConnection}`;
    const lockUntilKey = effectiveConnection === 'web' ? 'reachoutLockedUntil' : `reachoutLockedUntil_${effectiveConnection}`;
    if (t[lockKey]) {
      const until = t[lockUntilKey] ? ` até ${new Date(t[lockUntilKey]).toLocaleString('pt-BR')}` : '';
      return res.status(429).json({ error: `WhatsApp restringiu envios 1:1 temporariamente${until}. Grupos continuam funcionando.` });
    }
  }
  try {
    if (!useCloud) {
      const isGroup = isGroupRecipientId(contactId);
      let jid;
      if (isGroup) {
        jid = normalizeJid(contactId);
      } else if (lastInbound) {
        // Contato já tem conversa — JID é válido. Se for @lid, tenta resolver p/ telefone.
        // Se não resolver, responde via @lid (mesmo canal que recebeu a mensagem) — WA entrega.
        if (isLidJid(normalizeJid(contactId))) {
          const resolved = t.db.resolveLid(normalizeJid(contactId));
          if (resolved && !isLidJid(resolved)) {
            jid = normalizeJid(resolved);
          } else {
            const contact = t.contacts.find(c => c.lid === normalizeJid(contactId) && c.id && !isLidJid(c.id));
            jid = contact ? normalizeJid(contact.id) : normalizeJid(contactId);
          }
        } else {
          jid = normalizeJid(contactId);
        }
      } else {
        // Sem conversa anterior — resolve via onWhatsApp ou usa o JID bruto (incluindo @lid)
        jid = await resolveOutboundWebJid(t, contactId).catch(() => normalizeJid(contactId));
      }
      let sentMsg;
      if (isGroup) {
        sentMsg = await webSock.sendMessage(jid, { text });
        await assertBaileysSendAccepted(webSock, sentMsg, effectiveConnection);
        usedConnection = effectiveConnection;
      } else {
        console.log(`[${t.clientId}][chat-send] 1:1 JID=${jid} conn=${effectiveConnection}`);
        sentMsg = await webSock.sendMessage(jid, { text });
        await assertBaileysSendAccepted(webSock, sentMsg, effectiveConnection, t);
      }
      if (sentMsg.message) t.msgStore.set(sentMsg.key.id, sentMsg.message);
      const contactName = await resolveWebChatName(t, jid, jid);
      // Grava com o JID normalizado pelo telefone (não o @lid do Baileys) para que o CRM encontre pelo número
      const recordId = isGroup ? jid : normalizeJid(contactId);
      t.db.recordMessage({ direction: 'out', contactId: recordId, contactName, text, connectionId: usedConnection });
    } else if (effectiveConnection === 'cloud_personal' && userPersonalWaba) {
      if (!userPersonalWaba.phoneNumberId) throw new Error('WABA pessoal sem phone_number_id configurado. Reconecte pelo painel.');
      const cloudTo = normalizeBrazilianMobileDigits(normalizePhoneNumber(contactId));
      const cloudResp = await graphRequestWithToken(userPersonalWaba.accessToken, `/${userPersonalWaba.phoneNumberId}/messages`, {
        method: 'POST',
        json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: cloudTo, type: 'text', text: { preview_url: false, body: text } }
      });
      const cloudWamid = cloudResp?.messages?.[0]?.id || null;
      t.db.recordMessage({ direction: 'out', contactId: `${cloudTo}@s.whatsapp.net`, contactName: 'Você', text, connectionId: 'cloud_personal', wamid: cloudWamid, deliveryStatus: cloudWamid ? 'sent' : null });
    } else {
      const selectedCloud = getCloudSlotByConnection(t, effectiveConnection);
      if (!selectedCloud.phoneNumberId || !selectedCloud.accessToken) throw new Error(`API Oficial ${selectedCloud.slot} não configurada.`);
      const cloudTo = normalizeBrazilianMobileDigits(normalizePhoneNumber(contactId));
      const cloudResp = await sendCloudText(t, cloudTo, text, effectiveConnection);
      const cloudWamid = cloudResp?.messages?.[0]?.id || null;
      t.db.recordMessage({ direction: 'out', contactId: `${cloudTo}@s.whatsapp.net`, contactName: 'Você', text, connectionId: effectiveConnection, wamid: cloudWamid, deliveryStatus: cloudWamid ? 'sent' : null });
    }
    res.json({ ok: true, connectionId: usedConnection || effectiveConnection });
  } catch (e) {
    console.error('[chat-send] ERRO:', e.message, '| contactId:', contactId, '| conn:', effectiveConnection);
    if (!useCloud && isGroupChat && isBaileysCryptoSessionError(e)) {
      markBaileysConnectionUnhealthy(t, effectiveConnection, e, `chat-grupo:${contactId}`);
    }
    if (!useCloud && isTransientWebSessionError(e)) {
      reconnectWebClient(t, e.message).catch(() => {});
    }
    res.status(500).json({ error: e.message });
  }
});

// Reagir a uma mensagem — precisa do wamid de VERDADE (nosso id interno não é
// reconhecido pelo WhatsApp) e mandar pelo canal certo (Cloud/Lite/Baileys usam APIs
// bem diferentes entre si; antes só Baileys web/web2/web3 funcionava e usava o id errado,
// então "reagir" nunca fazia nada em Lite/Cloud e às vezes nem em Baileys).
app.post('/api/chat/:contactId/react', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const contactId = req.params.contactId;
  const { messageId, emoji, connectionId: forcedConnectionId } = req.body || {};
  if (!messageId || !emoji) return res.status(400).json({ error: 'messageId e emoji obrigatorios' });
  const msg = t.db.getMessageById(messageId);
  if (!msg) return res.status(404).json({ error: 'Mensagem nao encontrada' });
  if (!msg.wamid) return res.status(400).json({ error: 'Essa mensagem não tem identificador do WhatsApp — não dá pra reagir a ela (provavelmente é muito antiga).' });
  const lastInbound = t.db.getConversations().find(c => c.contactId === contactId);
  const effectiveConnection = forcedConnectionId || msg.connectionId || lastInbound?.connectionId || (t.provider === 'cloud' ? 'cloud1' : 'web');
  try {
    const isGroup = isGroupRecipientId(contactId);
    if (effectiveConnection.startsWith('cloud')) {
      const cloud = getCloudSlotByConnection(t, effectiveConnection);
      const pnid = cloud.phoneNumberId;
      const tok = cloud.accessToken;
      if (!pnid || !tok) return res.status(409).json({ error: 'API Oficial não configurada nesse slot.' });
      const digits = String(contactId).replace(/@.*/, '');
      await graphRequestWithToken(tok, `/${pnid}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', to: digits, type: 'reaction', reaction: { message_id: msg.wamid, emoji } } });
    } else if (effectiveConnection === 'lite' || effectiveConnection === 'lite2') {
      const digits = String(contactId).replace(/@.*/, '');
      const jid = isGroup ? contactId : `${digits}@s.whatsapp.net`;
      const r = await evoReq('POST', `/message/sendReaction/${liteInstanceName(t, effectiveConnection === 'lite2' ? '2' : '1')}`, { key: { remoteJid: jid, fromMe: msg.direction === 'out', id: msg.wamid }, reaction: emoji });
      if (!r || !r.ok) return res.status(500).json({ error: 'WhatsApp Lite não respondeu ao tentar reagir.' });
    } else {
      const { sock, ready } = resolveBaileysConnection(t, effectiveConnection);
      if (!ready || !sock?.user) return res.status(409).json({ error: `WhatsApp ${effectiveConnection} nao conectado` });
      const jid = isGroup ? normalizeJid(contactId) : await resolveOutboundWebJid(t, contactId);
      await sock.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, fromMe: msg.direction === 'out', id: msg.wamid } } });
    }
    // Deixa a reação anexada na mensagem original de vez, igual o WhatsApp mostra —
    // pra aparecer no chat sem depender do eco (que só chega minutos depois, se chegar).
    t.db.setMessageReaction(msg.wamid, contactId, emoji);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat/:contactId/send-media', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const contactId = req.params.contactId;
  pauseBotForContact(t, contactId); // atendente respondeu manualmente → pausa o bot
  const lastInbound = t.db.getConversations().find(c => c.contactId === contactId);
  const isGroupChat = isGroupRecipientId(contactId);
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  let savedPath = null, savedName = null, savedPublicUrl = null, savedMime = null, savedMediaType = null, done = false;
  let forcedConnectionId = null;
  let caption = '';
  let writeDone = null; // promessa que resolve quando o arquivo terminar de gravar no disco
  bb.on('field', (fieldname, value) => {
    if (fieldname === 'connectionId') forcedConnectionId = String(value || '').trim() || null;
    if (fieldname === 'caption') caption = String(value || '').slice(0, 4096);
  });
  bb.on('file', (fieldname, fileStream, info) => {
    const { filename } = info;
    if (!filename) { fileStream.resume(); return; }
    const ext = path.extname(filename) || '';
    const safeName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    savedPath = path.join(t.uploadsDir, safeName);
    savedPublicUrl = `/uploads/${t.clientId}/${safeName}`;
    savedName = filename;
    savedMime = info.mimeType || '';
    savedMediaType = savedMime.startsWith('image/') ? 'image' : (savedMime.startsWith('video/') ? 'video' : (savedMime.startsWith('audio/') ? 'audio' : 'document'));
    const ws = fs.createWriteStream(savedPath);
    writeDone = new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
    fileStream.on('limit', () => {
      ws.destroy();
      fs.unlink(savedPath, () => {});
      if (!done) { done = true; res.status(413).json({ error: 'Arquivo muito grande (máximo 200 MB)' }); }
    });
    fileStream.pipe(ws);
  });
  bb.on('finish', async () => {
    if (done) return; done = true;
    if (!savedPath) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    // Aguarda o arquivo terminar de gravar antes de ler (evita "Input Buffer is empty" / PNG corrompido)
    try { if (writeDone) await writeDone; } catch (e) { return res.status(500).json({ error: 'Falha ao salvar o arquivo enviado' }); }
    createVideoDerivatives(savedPath, savedMime);
    try {
      const effectiveConnection = forcedConnectionId || lastInbound?.connectionId || 'web';
      if (effectiveConnection === 'lite' || effectiveConnection === 'lite2') {
        if (!liteEnabled(t)) return res.status(409).json({ error: 'WhatsApp Lite nao habilitado' });
        const inst = liteInstanceName(t, effectiveConnection === 'lite2' ? '2' : '1');
        const isGroupL = String(contactId || '').endsWith('@g.us');
        const number = isGroupL ? contactId : String(contactId).replace(/@.*/, '').replace(/\D/g, '');
        const b64 = fs.readFileSync(savedPath).toString('base64');
        let rl;
        if (savedMediaType === 'audio') {
          let audioB64 = b64;
          let oggPath = null;
          try {
            oggPath = await convertToWhatsAppOgg(savedPath);
            audioB64 = fs.readFileSync(oggPath).toString('base64');
          } catch (convErr) {
            console.warn('[lite-send-media] falha ao converter audio para ogg/opus, enviando original:', convErr.message);
          } finally {
            if (oggPath) fs.unlink(oggPath, () => {});
          }
          rl = await evoReq('POST', `/message/sendWhatsAppAudio/${inst}`, { number, audio: audioB64 });
          if (!rl || !rl.ok) {
            console.log('[lite-send-media] sendWhatsAppAudio falhou, reenviando como documento. err:', rl && JSON.stringify(rl.json).slice(0, 140));
            let docName = savedName || 'audio.webm';
            if (!path.extname(docName)) docName += '.webm';
            rl = await evoReq('POST', `/message/sendMedia/${inst}`, { number, mediatype: 'document', mimetype: savedMime || 'application/octet-stream', media: b64, fileName: docName, caption: caption || undefined });
          }
        } else {
          const mtype = savedMediaType === 'image' ? 'image' : (savedMediaType === 'video' ? 'video' : 'document');
          rl = await evoReq('POST', `/message/sendMedia/${inst}`, { number, mediatype: mtype, mimetype: savedMime || 'application/octet-stream', media: b64, fileName: savedName, caption: caption || undefined });
          // Fallback: a Evolution às vezes falha ao processar a imagem/vídeo internamente
          // (sharp/libspng: "read error" ou "Input Buffer is empty"). Reenvia como documento,
          // que não passa pelo processamento de imagem — o arquivo chega do mesmo jeito.
          if ((!rl || !rl.ok) && mtype !== 'document') {
            console.log('[lite-send-media] falha como', mtype, '→ reenviando como documento. err:', rl && JSON.stringify(rl.json).slice(0, 140));
            let docName = savedName || 'arquivo';
            if (!path.extname(docName)) docName += (savedMediaType === 'image' ? '.png' : (savedMediaType === 'video' ? '.mp4' : ''));
            rl = await evoReq('POST', `/message/sendMedia/${inst}`, { number, mediatype: 'document', mimetype: savedMime || 'application/octet-stream', media: b64, fileName: docName, caption: caption || undefined });
          }
        }
        if (!rl || !rl.ok) { console.log('[lite-send-media] falha', rl && rl.status, rl && JSON.stringify(rl.json).slice(0,200)); return res.status(502).json({ error: 'Falha ao enviar midia pelo WhatsApp Lite' }); }
        const _mwamid = liteWamid(rl.json);
        botMarkSent(t, _mwamid);
        t.db.recordMessage({ direction: 'out', contactId: normalizeJid(contactId), contactName: (lastInbound && lastInbound.contactName) || '', text: savedMediaType === 'audio' ? '' : (caption || `[arquivo: ${savedName}]`), mediaUrl: savedPublicUrl, mediaType: savedMediaType, mediaName: savedName, connectionId: effectiveConnection, wamid: _mwamid, deliveryStatus: _mwamid ? 'sent' : null });
        return res.json({ ok: true });
      }
      // ── API Oficial (Cloud): faltava o branch de mídia — texto ia pro cloud mas
      // arquivo caía no Baileys e dava "cloud1 nao conectado". Faz upload no Graph
      // (/{pnid}/media -> media id) e envia por tipo.
      if (effectiveConnection.startsWith('cloud')) {
        const slot = effectiveConnection;
        const cloud = getCloudSlotByConnection(t, slot);
        const pnid = cloud.phoneNumberId;
        const tok = cloud.accessToken;
        if (!pnid || !tok) return res.status(409).json({ error: 'API Oficial nao configurada' });
        const toNum = String(contactId).replace(/@.*/, '').replace(/\D/g, '');
        try {
          let sendPath = savedPath, sendMime = savedMime || 'application/octet-stream', tmpOgg = null;
          if (savedMediaType === 'audio') {
            try { tmpOgg = await convertToWhatsAppOgg(savedPath); sendPath = tmpOgg; sendMime = 'audio/ogg'; }
            catch (convErr) { console.warn('[cloud-send-media] falha ao converter audio p/ ogg, enviando original:', convErr.message); }
          }
          const form = new FormData();
          form.append('messaging_product', 'whatsapp');
          form.append('type', sendMime);
          form.append('file', new Blob([fs.readFileSync(sendPath)], { type: sendMime }), savedName || path.basename(sendPath));
          const up = await graphRequestWithToken(tok, `/${pnid}/media`, { method: 'POST', formData: form });
          if (tmpOgg) fs.unlink(tmpOgg, () => {});
          if (!up || !up.id) return res.status(502).json({ error: 'A API Oficial nao retornou o id da midia.' });
          const mid = up.id;
          const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: toNum };
          if (savedMediaType === 'image') { payload.type = 'image'; payload.image = caption ? { id: mid, caption } : { id: mid }; }
          else if (savedMediaType === 'video') { payload.type = 'video'; payload.video = caption ? { id: mid, caption } : { id: mid }; }
          else if (savedMediaType === 'audio') { payload.type = 'audio'; payload.audio = { id: mid }; }
          else { payload.type = 'document'; payload.document = caption ? { id: mid, filename: savedName || 'arquivo', caption } : { id: mid, filename: savedName || 'arquivo' }; }
          const sent = await graphRequestWithToken(tok, `/${pnid}/messages`, { method: 'POST', json: payload });
          const _cwamid = sent?.messages?.[0]?.id || null;
          t.db.recordMessage({ direction: 'out', contactId: normalizeJid(contactId), contactName: (lastInbound && lastInbound.contactName) || '', text: savedMediaType === 'audio' ? '' : (caption || `[arquivo: ${savedName}]`), mediaUrl: savedPublicUrl, mediaType: savedMediaType, mediaName: savedName, connectionId: effectiveConnection, wamid: _cwamid, deliveryStatus: _cwamid ? 'sent' : null });
          return res.json({ ok: true });
        } catch (e) {
          console.log('[cloud-send-media] falha', e.message);
          return res.status(502).json({ error: 'Falha ao enviar midia pela API Oficial: ' + e.message });
        }
      }
      const { sock: webSock, ready: sockReady } = resolveBaileysConnection(t, effectiveConnection);
      if (!sockReady || !webSock?.user) return res.status(409).json({ error: `WhatsApp ${effectiveConnection} nao conectado` });
      const isGroup = String(contactId || '').endsWith('@g.us');
      if (!isGroup) assertBaileysConnectionHealthy(t, effectiveConnection);
      let jid;
      if (isGroup) {
        jid = normalizeJid(contactId);
      } else if (lastInbound && isLidJid(normalizeJid(contactId))) {
        const resolved = t.db.resolveLid(normalizeJid(contactId));
        if (resolved && !isLidJid(resolved)) {
          jid = normalizeJid(resolved);
        } else {
          const contact = t.contacts.find(c => c.lid === normalizeJid(contactId) && c.id && !isLidJid(c.id));
          jid = contact ? normalizeJid(contact.id) : normalizeJid(contactId);
        }
      } else if (lastInbound) {
        jid = normalizeJid(contactId);
      } else {
        jid = await resolveOutboundWebJid(t, contactId);
      }
      const buffer = fs.readFileSync(savedPath);
      let sentMsg;
      if (savedMime.startsWith('image/')) {
        sentMsg = await webSock.sendMessage(jid, { image: buffer, caption: caption || undefined });
      } else if (savedMime.startsWith('video/')) {
        sentMsg = await webSock.sendMessage(jid, { video: buffer, caption: caption || undefined });
      } else if (savedMime.startsWith('audio/')) {
        sentMsg = await webSock.sendMessage(jid, { audio: buffer, mimetype: savedMime || 'audio/ogg', ptt: false });
      } else {
        sentMsg = await webSock.sendMessage(jid, { document: buffer, mimetype: savedMime || 'application/octet-stream', fileName: savedName, caption: caption || undefined });
      }
      if (!isGroup) console.log(`[${t.clientId}][chat-send-media] 1:1 JID=${jid} conn=${effectiveConnection}`);
      await assertBaileysSendAccepted(webSock, sentMsg, effectiveConnection, !isGroup ? t : undefined);
      const contactName = await resolveWebChatName(t, jid, jid);
      const recordId = isGroup ? jid : normalizeJid(contactId);
      t.db.recordMessage({ direction: 'out', contactId: recordId, contactName, text: savedMediaType === 'audio' ? '' : (caption || `[arquivo: ${savedName}]`), mediaUrl: savedPublicUrl, mediaType: savedMediaType, mediaName: savedName, connectionId: effectiveConnection });
      res.json({ ok: true });
    } catch (e) {
      const effectiveConnection = forcedConnectionId || lastInbound?.connectionId || 'web';
      if (isGroupChat && isBaileysCryptoSessionError(e)) {
        markBaileysConnectionUnhealthy(t, effectiveConnection, e, `chat-media-grupo:${contactId}`);
      }
      res.status(500).json({ error: e.message });
    }
  });
  bb.on('error', e => { if (!done) { done = true; res.status(500).json({ error: e.message }); } });
  req.pipe(bb);
});

// Compartilhar um contato (vCard) no chat ao vivo — Cloud (type=contacts), Lite (sendContact) ou Baileys (vcard).
app.post('/api/chat/:contactId/send-contact', requireAuth, requireFeature('chat'), async (req, res) => {
  const t = getTenant(req.clientId);
  const contactId = req.params.contactId;
  const rawName = String(req.body?.name || '').trim().slice(0, 120);
  const digits = String(req.body?.phone || '').replace(/\D/g, '');
  if (!rawName || digits.length < 8) return res.status(400).json({ error: 'Informe nome e telefone validos do contato' });
  pauseBotForContact(t, contactId);
  const waId = normalizeBrazilianMobileDigits(digits) || digits;
  const shownPhone = '+' + waId;
  const recordText = '👤 ' + rawName + '\n📞 ' + shownPhone;
  const isGroupChat = isGroupRecipientId(contactId);
  const lastInbound = t.db.getConversations().find(c => c.contactId === contactId);
  const forcedConnectionId = req.body?.connectionId || null;
  const inboundConn = !isGroupChat ? t.db.getLastInboundConnection(contactId) : null;
  const autoConn = forcedConnectionId || inboundConn || (lastInbound && lastInbound.connectionId) || (t.provider === 'cloud' ? 'cloud1' : 'web');
  try {
    if (autoConn === 'lite' || autoConn === 'lite2') {
      if (!liteEnabled(t)) return res.status(409).json({ error: 'WhatsApp Lite nao conectado' });
      const inst = liteInstanceName(t, autoConn === 'lite2' ? '2' : '1');
      const number = isGroupChat ? contactId : String(contactId).replace(/@.*/, '').replace(/\D/g, '');
      const rl = await evoReq('POST', `/message/sendContact/${inst}`, { number, contact: [{ fullName: rawName, wuid: waId, phoneNumber: shownPhone }] });
      if (!rl || !rl.ok) return res.status(502).json({ error: 'Falha ao enviar contato pelo WhatsApp Lite' });
      const _w = liteWamid(rl.json); botMarkSent(t, _w);
      t.db.recordMessage({ direction: 'out', contactId: normalizeJid(contactId), contactName: (lastInbound && lastInbound.contactName) || '', text: recordText, connectionId: autoConn, wamid: _w, deliveryStatus: _w ? 'sent' : null });
      return res.json({ ok: true });
    }
    if (autoConn.startsWith('cloud')) {
      const cloud = getCloudSlotByConnection(t, autoConn);
      if (!cloud.phoneNumberId || !cloud.accessToken) return res.status(409).json({ error: 'API Oficial nao configurada' });
      const to = normalizeBrazilianMobileDigits(normalizePhoneNumber(contactId));
      const contactsPayload = [{ name: { formatted_name: rawName, first_name: rawName }, phones: [{ phone: shownPhone, type: 'CELL', wa_id: waId }] }];
      const sent = await graphRequestWithToken(cloud.accessToken, `/${cloud.phoneNumberId}/messages`, { method: 'POST', json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'contacts', contacts: contactsPayload } });
      const _w = sent?.messages?.[0]?.id || null;
      t.db.recordMessage({ direction: 'out', contactId: `${to}@s.whatsapp.net`, contactName: 'Voce', text: recordText, connectionId: autoConn, wamid: _w, deliveryStatus: _w ? 'sent' : null });
      return res.json({ ok: true });
    }
    const { sock, ready } = resolveBaileysConnection(t, autoConn);
    if (!ready || !sock?.user) return res.status(409).json({ error: `WhatsApp ${autoConn} nao conectado` });
    const jid = isGroupChat ? normalizeJid(contactId) : await resolveOutboundWebJid(t, contactId).catch(() => normalizeJid(contactId));
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:' + rawName + '\nTEL;type=CELL;type=VOICE;waid=' + waId + ':' + shownPhone + '\nEND:VCARD';
    await sock.sendMessage(jid, { contacts: { displayName: rawName, contacts: [{ vcard }] } });
    t.db.recordMessage({ direction: 'out', contactId: isGroupChat ? jid : normalizeJid(contactId), contactName: (lastInbound && lastInbound.contactName) || '', text: recordText, connectionId: autoConn });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[send-contact] ERRO:', e.message, '| contactId:', contactId);
    return res.status(500).json({ error: e.message });
  }
});

// Meta message templates
app.get('/api/templates', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const creds = getTemplateCloudCreds(t, req.query.slot || '1');
  if (!creds.accessToken || !creds.wabaId) return res.status(409).json({ error: 'Conecte uma API Oficial com WABA antes de listar modelos.' });
  try {
    const fields = 'name,status,category,language,components,rejected_reason,quality_score';
    const data = await graphRequestWithToken(creds.accessToken, `/${creds.wabaId}/message_templates?fields=${encodeURIComponent(fields)}&limit=100`);
    res.json({ ok: true, slot: creds.slot, displayPhone: creds.displayPhone || '', templates: data.data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/templates', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const creds = getTemplateCloudCreds(t, req.body?.slot || '1');
  if (!creds.accessToken || !creds.wabaId) return res.status(409).json({ error: 'Conecte uma API Oficial com WABA antes de enviar modelos.' });
  try {
    const payload = buildMetaTemplatePayload(req.body || {});
    const data = await graphRequestWithToken(creds.accessToken, `/${creds.wabaId}/message_templates`, { method: 'POST', json: payload });
    res.json({ ok: true, payload, result: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Funnels
app.get('/api/funnels', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getFunnels()));
app.post('/api/funnels', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const chatConnectionId = req.body?.chatConnectionId ? String(req.body.chatConnectionId).trim() : null;
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  res.json(getTenant(req.clientId).db.createFunnel(name, chatConnectionId));
});
app.put('/api/funnels/:id', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const chatConnectionId = Object.prototype.hasOwnProperty.call(req.body || {}, 'chatConnectionId')
    ? (req.body?.chatConnectionId ? String(req.body.chatConnectionId).trim() : null)
    : undefined;
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  getTenant(req.clientId).db.updateFunnel(req.params.id, name, chatConnectionId) ? res.json({ ok: true }) : res.status(404).json({ error: 'Nao encontrado' });
});
app.delete('/api/funnels/:id', requireAuth, (req, res) => { getTenant(req.clientId).db.deleteFunnel(req.params.id); res.json({ ok: true }); });

// CRM
app.get('/api/crm/columns', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getCrmColumns(req.query.funnelId)));
app.post('/api/crm/columns', requireAuth, (req, res) => { const name = String(req.body?.name || '').trim(); const funnelId = String(req.body?.funnelId || ''); if (!name) return res.status(400).json({ error: 'Nome obrigatorio' }); res.json(getTenant(req.clientId).db.createCrmColumn(name, funnelId)); });
app.put('/api/crm/columns/:id', requireAuth, (req, res) => { const name = String(req.body?.name || '').trim(); if (!name) return res.status(400).json({ error: 'Nome obrigatorio' }); res.json({ ok: getTenant(req.clientId).db.updateCrmColumn(req.params.id, name) }); });
app.delete('/api/crm/columns/:id', requireAuth, (req, res) => { getTenant(req.clientId).db.deleteCrmColumn(req.params.id); res.json({ ok: true }); });
app.post('/api/crm/columns/reorder', requireAuth, (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids obrigatorio' });
  getTenant(req.clientId).db.reorderCrmColumns(ids);
  res.json({ ok: true });
});
// Quantos cards entraram em cada coluna do funil num dia (default hoje, fuso SP).
// { columnId: quantidade } — 1 query pra todas as colunas, não uma por coluna.
app.get('/api/crm/columns/entries', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const funnelId = String(req.query.funnelId || 'default');
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : brDateKey(Date.now());
  const { start, end } = brDayBounds(dateKey);
  res.json({ date: dateKey, entries: t.db.getColumnEntryCounts(funnelId, start, end) });
});
app.get('/api/crm/cards', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  let cards = enrichCrmCardsWithAvatars(t, t.db.getCrmCards(req.query.funnelId));
  // "Só ver leads atribuídos a esta pessoa": cards sem dono ainda ficam visíveis pra todos
  // (evita esconder lead novo até alguém assumir), só some o que já é de outra pessoa.
  if (req.user?.permissions?.restrictToOwnLeads) {
    cards = cards.filter(c => !c.owner || c.owner === req.loginClientId);
  }
  res.json(cards);
});
app.get('/api/crm/duplicates', requireAuth, (req, res) => {
  res.json(getTenant(req.clientId).db.findDuplicateCrmCards());
});
// De qual coluna esse card veio antes da atual (útil pra distinguir, por ex., quem
// caiu em "Reagendar" vindo de "Visita Agendada" de quem nunca chegou a agendar).
// Busca avulsa (não entra na listagem de cards, pra não virar N+1).
app.get('/api/crm/cards/:id/previous-column', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const prev = t.db.getPreviousColumn(req.params.id);
  if (!prev) return res.json(null);
  const col = t.db.getCrmColumns().find(c => c.id === prev.fromColumnId);
  res.json({ columnId: prev.fromColumnId, columnName: col ? col.name : null, at: prev.at });
});
// Resumo de 1 lead pro chat ao vivo: por quais colunas passou (e quanto tempo em cada),
// estatística da conversa (1ª/última mensagem, quantas trocas) e ligações via WhatsApp.
app.get('/api/chat/:contactId/summary', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const contactId = req.params.contactId;
  const card = findCrmCardForChat(t, contactId);
  let timeline = [];
  if (card) {
    const cols = t.db.getCrmColumns();
    const colName = id => (cols.find(c => c.id === id) || {}).name || null;
    timeline = t.db.getCardColumnTimeline(card.id).map(r => ({ ...r, fromColumnName: colName(r.fromColumnId), toColumnName: colName(r.toColumnId) }));
  }
  const conversation = t.db.getConversationStats(contactId);
  const calls = t.db.getCallEvents(contactId);
  res.json({ columnTimeline: timeline, conversation, calls });
});
function extractAdReply(m) {
  try {
    if (!m) return null;
    const cands = [m.extendedTextMessage, m.imageMessage, m.videoMessage, m.buttonsResponseMessage, m.listResponseMessage];
    for (const c of cands) { if (c && c.contextInfo && c.contextInfo.externalAdReply) return c.contextInfo.externalAdReply; }
    if (m.contextInfo && m.contextInfo.externalAdReply) return m.contextInfo.externalAdReply;
  } catch (e) {}
  return null;
}
async function resolveAdName(t, cardId, adId) {
  try {
    const am = (t.db.getConfig() || {}).adsMeta;
    const token = (am && am.token) || (t.clientId === 'virandoachave' ? loadMetaToken() : '');
    if (!token) return;
    const d = await fetch(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${adId}?fields=name,adset{name},campaign{name}&access_token=${encodeURIComponent(token)}`).then(r => r.json());
    if (!d || d.error || !d.name) return;
    const card = t.db.getCrmCards().find(c => c.id === cardId);
    if (!card) return;
    const extra = 'Anúncio: ' + d.name + (d.campaign && d.campaign.name ? ' · Campanha: ' + d.campaign.name : '') + (d.adset && d.adset.name ? ' · Conjunto: ' + d.adset.name : '');
    if (card.notes && card.notes.indexOf('Anúncio: ' + d.name) >= 0) return;
    const notes = card.notes ? (card.notes + '\n' + extra) : extra;
    t.db.updateCrmCard(cardId, { notes });
  } catch (e) {}
}
function captureAdReferral(t, card, raw) {
  try {
    if (!card || !raw) return;
    const adId = String(raw.source_id || raw.sourceId || '').trim();
    const headline = String(raw.headline || raw.title || '').trim();
    const body = String(raw.body || '').trim();
    const url = String(raw.source_url || raw.sourceUrl || '').trim();
    // Identificador do clique no anuncio: e ele que liga a venda ao anuncio no Meta.
    const clid = String(raw.ctwa_clid || raw.ctwaClid || '').trim();
    if (clid && !card.ctwaClid) { try { t.db.updateCrmCard(card.id, { ctwaClid: clid }); card.ctwaClid = clid; } catch (e) {} }
    if (!adId && !headline && !body && !url) return;
    if (card.notes && /Veio de an[úu]ncio/i.test(card.notes)) return; // já capturado
    const lines = ['📢 Veio de anúncio (Meta)'];
    if (headline) lines.push('Criativo: ' + headline);
    if (body) lines.push('Texto do anúncio: ' + body);
    if (url) lines.push('Link: ' + url);
    if (adId) lines.push('ID do anúncio: ' + adId);
    const block = lines.join('\n');
    const notes = card.notes ? (block + '\n\n' + card.notes) : block;
    let labels = Array.isArray(card.labels) ? card.labels.slice() : [];
    const _hasL = (x) => labels.some(l => String(l).toLowerCase() === String(x).toLowerCase());
    const creativeLbl = headline ? headline.slice(0, 30).trim() : '';
    if (labels.length === 0) { if (creativeLbl) labels.push(creativeLbl); if (!_hasL('meta')) labels.push('meta'); }
    else { if (!_hasL('meta')) labels.push('meta'); if (creativeLbl && !_hasL(creativeLbl)) labels.push(creativeLbl); }
    t.db.updateCrmCard(card.id, { notes, labels });
    if (adId) resolveAdName(t, card.id, adId).catch(() => {});
  } catch (e) {}
}
// O botao do site manda os cookies do Facebook junto da mensagem, no formato
// [fb: <_fbc>|<_fbp>]. Sao eles que ligam a conversa do WhatsApp ao anuncio.
// Remove as tags técnicas de rastreio ([gads: ...], [fb: ...], [ref: ...]) do texto
// antes de gravar/exibir a mensagem no chat — elas continuam sendo lidas (pelas funções
// abaixo) pra alimentar as notas do card, só não devem aparecer pro atendente/lead.
function stripTrackingTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/\[\s*(?:gads|fb|ref)\s*:\s*[^\]]{1,400}\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function captureFbCookies(t, card, text) {
  try {
    if (!card || !text) return;
    const m = String(text).match(/\[\s*fb\s*:\s*([^\]]{1,200})\]/i);
    if (!m) return;
    const partes = m[1].split('|').map(x => x.trim());
    const fbc = partes[0] && partes[0].startsWith('fb.') ? partes[0] : '';
    const fbp = partes[1] && partes[1].startsWith('fb.') ? partes[1] : '';
    const campos = {};
    if (fbc && !card.fbc) campos.fbc = fbc;
    if (fbp && !card.fbp) campos.fbp = fbp;
    if (!Object.keys(campos).length) return;
    t.db.updateCrmCard(card.id, campos);
    Object.assign(card, campos);
  } catch (e) {}
}
function captureSiteRef(t, card, text) {
  try {
    if (!card || !text) return;
    const m = String(text).match(/\[\s*ref\s*:\s*([^\]]{1,60})\]/i);
    // marcadores tecnicos nao viram etiqueta
    if (!m) return;
    const ref = m[1].trim();
    if (!ref) return;
    if (card.notes && card.notes.indexOf('Origem (site): ' + ref) >= 0) return;
    const note = '🌐 Origem (site): ' + ref;
    const notes = card.notes ? (note + '\n\n' + card.notes) : note;
    let labels = Array.isArray(card.labels) ? card.labels.slice() : [];
    const lbl = ref.slice(0, 30);
    if (labels.length === 0) labels.push(lbl);
    else if (!labels.some(l => String(l).toLowerCase() === lbl.toLowerCase())) labels.push(lbl);
    t.db.updateCrmCard(card.id, { notes, labels });
  } catch (e) {}
}
// Resolve campanha/grupo de anúncios do Google Ads a partir dos IDs numéricos que vieram
// no ValueTrack ({campaignid}/{adgroupid} não são legíveis por si só, precisam de uma
// consulta na API pra virar nome — mesmo padrão do resolveAdName pro Meta). O ID da conta
// Google Ads fica salvo no config do próprio tenant (googleAdsCustomerId), não fixo no
// código — assim qualquer cliente pode usar isso, não só quem motivou a feature.
async function resolveGoogleAdsRef(t, cardId, campaignid, adgroupid, adid) {
  try {
    const custid = String((t.db.getConfig() || {}).googleAdsCustomerId || '').replace(/\D/g, '');
    if (!custid || !campaignid || !adgroupid) return;
    const rows = await gadsSearch(custid, `SELECT campaign.name, ad_group.name FROM ad_group WHERE campaign.id = ${Number(campaignid)} AND ad_group.id = ${Number(adgroupid)}`, custid);
    const row = rows[0];
    if (!row) return;
    const campanha = row.campaign && row.campaign.name;
    const grupo = row.adGroup && row.adGroup.name;
    // O anúncio (RSA normalmente) não tem "nome" de verdade — usa o primeiro título
    // configurado como identificador legível, é o que mais se aproxima de "qual anúncio".
    let anuncio = '';
    if (adid) {
      try {
        const adRows = await gadsSearch(custid, `SELECT ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines FROM ad_group_ad WHERE ad_group_ad.ad.id = ${Number(adid)}`, custid);
        const adRow = adRows[0];
        const heads = adRow && adRow.adGroupAd && adRow.adGroupAd.ad && adRow.adGroupAd.ad.responsiveSearchAd && adRow.adGroupAd.ad.responsiveSearchAd.headlines;
        if (Array.isArray(heads) && heads.length) anuncio = heads[0].text || '';
      } catch (e) {}
    }
    if (!campanha && !grupo && !anuncio) return;
    const card = t.db.getCrmCards().find(c => c.id === cardId);
    if (!card) return;
    const extra = 'Campanha (Google): ' + (campanha || '?') + (grupo ? ' · Grupo de anúncios: ' + grupo : '') + (anuncio ? ' · Anúncio: ' + anuncio : '');
    if (card.notes && card.notes.indexOf(extra) >= 0) return;
    const notes = card.notes ? (card.notes + '\n' + extra) : extra;
    t.db.updateCrmCard(cardId, { notes });
  } catch (e) {}
}
// O botão de WhatsApp no site (script no Custom Code) embute isso na mensagem quando o
// clique veio de um anúncio do Google (gclid/campaignid/adgroupid/adid via ValueTrack no
// sufixo de URL do anúncio, keyword/searchterm já vêm como texto legível do próprio
// Google). Formato: [gads: gclid|campaignid|adgroupid|adid|keyword|searchterm], cada
// campo URL-encoded pra suportar espaço/acento sem quebrar o parser.
function captureGoogleAdsRef(t, card, text) {
  try {
    if (!card || !text) return;
    const m = String(text).match(/\[\s*gads\s*:\s*([^\]]{1,400})\]/i);
    if (!m) return;
    if (card.notes && /Origem \(Google Ads\)/i.test(card.notes)) return; // já capturado
    const dec = x => { try { return decodeURIComponent(String(x || '').trim()); } catch (e) { return String(x || '').trim(); } };
    const partes = m[1].split('|').map(dec);
    // Compatibilidade: sites com o script antigo mandam 5 campos (sem o id do anúncio);
    // sites com o script novo mandam 6. Detecta pela quantidade em vez de travar um formato.
    const [gclid, campaignid, adgroupid] = partes;
    const adid = partes.length >= 6 ? partes[3] : '';
    const keyword = partes.length >= 6 ? partes[4] : partes[3];
    const searchterm = partes.length >= 6 ? partes[5] : partes[4];
    if (!gclid && !keyword && !searchterm) return;
    const lines = ['🔍 Origem (Google Ads)'];
    if (keyword) lines.push('Palavra-chave: ' + keyword);
    if (searchterm) lines.push('Termo pesquisado: ' + searchterm);
    if (gclid) lines.push('GCLID: ' + gclid);
    const block = lines.join('\n');
    const notes = card.notes ? (block + '\n\n' + card.notes) : block;
    let labels = Array.isArray(card.labels) ? card.labels.slice() : [];
    const _hasL = x => labels.some(l => String(l).toLowerCase() === String(x).toLowerCase());
    if (!_hasL('google ads')) labels.push('google ads');
    t.db.updateCrmCard(card.id, { notes, labels });
    if (campaignid && adgroupid) resolveGoogleAdsRef(t, card.id, campaignid, adgroupid, adid).catch(() => {});
  } catch (e) {}
}
function applyLeadSourceTag(t, card, text) {
  try {
    if (!card || !text) return;
    const rules = ((t.db.getConfig() || {}).leadSourceRules) || [];
    if (!rules.length) return;
    const norm = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const txt = norm(text);
    for (const r of rules) {
      const phrase = norm(r.phrase);
      if (phrase && txt.indexOf(phrase) >= 0) {
        const tag = String(r.tag || '').trim();
        const note = String(r.note || '').trim();
        const upd = {};
        if (tag) { const labels = Array.isArray(card.labels) ? card.labels.slice() : []; if (!labels.some(l => String(l).toLowerCase() === tag.toLowerCase())) { labels.push(tag); upd.labels = labels; } }
        if (note && !(card.notes && card.notes.indexOf(note) >= 0)) { upd.notes = card.notes ? (note + '\n\n' + card.notes) : note; }
        if (Object.keys(upd).length) t.db.updateCrmCard(card.id, upd);
        return;
      }
    }
  } catch (e) {}
}
app.get('/api/crm/lead-source-rules', requireAuth, (req, res) => {
  const rules = ((getTenant(req.clientId).db.getConfig() || {}).leadSourceRules) || [];
  res.json(Array.isArray(rules) ? rules : []);
});
app.put('/api/crm/lead-source-rules', requireAuth, (req, res) => {
  const arr = Array.isArray(req.body && req.body.rules) ? req.body.rules : [];
  const clean = arr.map(r => ({ id: r.id || ('lsr-' + Math.random().toString(36).slice(2, 8)), phrase: String(r.phrase || '').slice(0, 300), tag: String(r.tag || '').slice(0, 40), note: String(r.note || '').slice(0, 300) })).filter(r => r.phrase && (r.tag || r.note));
  getTenant(req.clientId).db.updateConfig({ leadSourceRules: clean });
  res.json({ ok: true, rules: clean });
});
app.post('/api/crm/cards', requireAuth, (req, res) => { const { columnId, funnelId, contactName, phone, instagram, site, notes, label, labels, checks, whatsappId, estado, cidade, email, whatsapp } = req.body; if (!columnId) return res.status(400).json({ error: 'columnId obrigatorio' }); res.json(getTenant(req.clientId).db.createCrmCard({ columnId, funnelId, contactName, phone, instagram, site, notes, label, labels, checks, whatsappId, estado, cidade, email, whatsapp })); });
function crmIsNoFunnel(t, x) { try { const arr = (t.db.getConfig() || {}).crmNoFunnel; const d = String(x || '').replace(/\D/g, ''); return Array.isArray(arr) && !!d && arr.includes(d); } catch (e) { return false; } }
function crmAddNoFunnel(t, x) { const d = String(x || '').replace(/\D/g, ''); if (!d) return; const cfg = t.db.getConfig() || {}; const arr = Array.isArray(cfg.crmNoFunnel) ? cfg.crmNoFunnel : []; if (!arr.includes(d)) { arr.push(d); t.db.updateConfig({ crmNoFunnel: arr }); } }
app.put('/api/crm/cards/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  if (req.body && req.body.columnId === '__nofunnel__') {
    const card = (t.db.getCrmCards() || []).find(c => c.id === req.params.id);
    if (card) { crmAddNoFunnel(t, card.whatsapp || card.phone || card.whatsappId); t.db.deleteCrmCard(card.id); }
    return res.json({ ok: true, removed: true });
  }
  const antes = (t.db.getCrmCards() || []).find(c => c.id === req.params.id);
  const card = t.db.updateCrmCard(req.params.id, req.body);
  if (!card) return res.status(404).json({ error: 'Card nao encontrado' });
  // Mudou de coluna? Se a coluna nova esta configurada, avisa o Meta.
  if (antes && String(antes.columnId || '') !== String(card.columnId || '')) {
    aoEntrarNaColuna(t, card.id, card.columnId).catch(() => {});
    // Se a coluna nova é a gatilho da IA e o lead já está com a última mensagem sem
    // resposta (ex: card movido manualmente pra lá, ou mensagem chegou antes da IA
    // estar configurada), dispara na hora — sem isso, ficaria esperando uma mensagem
    // NOVA chegar pra responder, e o lead que já estava esperando nunca era atendido.
    const contactIdForAi = card.whatsappId || (card.whatsapp ? `${card.whatsapp}@s.whatsapp.net` : null);
    if (contactIdForAi && aiChatbotShouldTrigger(t, contactIdForAi, card.columnId)) {
      const msgsForAi = t.db.getMessages(contactIdForAi);
      const lastForAi = msgsForAi[msgsForAi.length - 1];
      if (lastForAi && lastForAi.direction === 'in') {
        const digitsForAi = String(card.whatsapp || card.phone || '').replace(/\D/g, '');
        const connForAi = t.db.getLastInboundConnection(contactIdForAi) || 'cloud1';
        handleAiChatbotReply(t, contactIdForAi, digitsForAi, connForAi).catch(err => console.error(`[${t.clientId}] AI chatbot (mudança de coluna):`, err.message));
      }
    }
  }
  res.json(card);
});
// Força a IA a responder agora um lead específico, mesmo sem mensagem nova chegando —
// útil quando o lead ficou esperando resposta desde antes da IA estar configurada.
app.post('/api/ai/chatbot/nudge', requireAuth, async (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const t = getTenant(req.clientId);
  const card = findCrmCardForChat(t, contactId);
  if (!aiChatbotShouldTrigger(t, contactId, card?.columnId)) return res.status(400).json({ error: 'IA não está habilitada pra esse contato.' });
  const digits = String(card?.whatsapp || card?.phone || contactId).replace(/\D/g, '');
  const connId = t.db.getLastInboundConnection(contactId) || 'cloud1';
  try {
    await handleAiChatbotReply(t, contactId, digits, connId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/crm/cards/:id', requireAuth, (req, res) => { getTenant(req.clientId).db.deleteCrmCard(req.params.id); res.json({ ok: true }); });
app.post('/api/crm/cards/:id/mark-read', requireAuth, (req, res) => { getTenant(req.clientId).db.clearCrmCardNewMessage(req.params.id); res.json({ ok: true }); });

// ═══════════ Meta CAPI: reporta lead qualificado / venda ═══════════
// A venda acontece no WhatsApp, nao no site. Entao e o CRM que avisa o Meta
// quando um lead virou bom, pra ele buscar mais gente parecida.
function getCapiCfg(t) {
  const c = (t.db.getConfig() || {}).metaCapi || {};
  return {
    enabled: !!c.enabled,
    pixelId: String(c.pixelId || '').trim(),
    token: String(c.token || '').trim(),
    testCode: String(c.testCode || '').trim(),
    moeda: String(c.moeda || 'BRL').trim(),
    nomeCrm: String(c.nomeCrm || '').trim() || 'CRM WhatsApp',
    // [{ columnId, eventName, sendValue }]
    colunas: Array.isArray(c.colunas) ? c.colunas : [],
  };
}
function saveCapiCfg(t, c) { t.db.updateConfig({ metaCapi: c }); }
function capiLog(t, item) {
  try {
    const cfg = t.db.getConfig() || {};
    const log = Array.isArray(cfg.metaCapiLog) ? cfg.metaCapiLog : [];
    t.db.updateConfig({ metaCapiLog: [{ ...item, at: Date.now() }].concat(log).slice(0, 100) });
  } catch (e) {}
}
function sha256(v) {
  const x = String(v || '').trim().toLowerCase();
  return x ? crypto.createHash('sha256').update(x).digest('hex') : null;
}
// O Meta quer os dados pessoais hasheados. Quanto mais campos, melhor ele casa
// o lead com o usuario do Facebook — e melhor fica a otimizacao.
function capiUserData(card) {
  const u = {};
  const tel = String(card.whatsapp || card.phone || '').replace(/\D/g, '');
  if (tel) u.ph = [sha256(tel)];
  if (card.email) u.em = [sha256(card.email)];
  const nome = String(card.contactName || '').trim().split(/\s+/);
  if (nome[0] && /[A-Za-zÀ-ÿ]/.test(nome[0])) {
    u.fn = [sha256(nome[0])];
    if (nome.length > 1) u.ln = [sha256(nome[nome.length - 1])];
  }
  if (card.cidade) u.ct = [sha256(String(card.cidade).replace(/\s/g, ''))];
  if (card.estado) u.st = [sha256(card.estado)];
  u.country = [sha256('br')];
  if (card.id) u.external_id = [sha256(card.id)];
  // Lead vindo de formulario instantaneo do Meta: o lead_id casa direto, sem hash.
  const lid = String((card.customFields && card.customFields.lead_id) || '').replace(/\D/g, '');
  if (lid) u.lead_id = Number(lid);
  if (card.ctwaClid) u.ctwa_clid = card.ctwaClid; // nao vai hasheado
  if (card.fbc) u.fbc = card.fbc;                 // idem
  if (card.fbp) u.fbp = card.fbp;
  return u;
}
async function enviarEventoCapi(t, card, regra, opts) {
  const cfg = getCapiCfg(t);
  // O teste manual roda mesmo com a integracao desligada: e pra validar antes de ligar.
  if (!cfg.enabled && !(opts && opts.forcar)) return { pulado: 'integração desligada' };
  if (!cfg.pixelId || !cfg.token) return { pulado: 'sem pixel ou token' };

  const evento = String(regra.eventName || 'Lead').slice(0, 50);
  const jaFoi = (card.metaReported || {})[evento];
  if (jaFoi) return { pulado: 'já reportado em ' + new Date(jaFoi).toLocaleString('pt-BR') };

  const eventId = 'crm-' + card.id + '-' + evento;
  // Evento vindo de CRM usa 'system_generated' + event_source 'crm'. Com
  // 'business_messaging' o Meta exige page_id e recusa nome fora da lista dele.
  const ev = {
    event_name: evento,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,                 // deduplicacao
    action_source: 'system_generated',
    user_data: capiUserData(card),
    custom_data: {
      event_source: 'crm',
      lead_event_source: cfg.nomeCrm || 'CRM WhatsApp',
    },
  };
  if (regra.sendValue && Number(card.valor) > 0) {
    ev.custom_data.value = Number(card.valor);
    ev.custom_data.currency = cfg.moeda || 'BRL';
  }
  const body = { data: [ev] };
  if (cfg.testCode) body.test_event_code = cfg.testCode;

  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.pixelId}/events?access_token=${encodeURIComponent(cfg.token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (r.ok) {
      const rep = { ...(card.metaReported || {}), [evento]: Date.now() };
      t.db.updateCrmCard(card.id, { metaReported: rep });
    }
    capiLog(t, { card: card.contactName || card.id, evento, ok: r.ok, valor: ev.custom_data ? ev.custom_data.value : null, resposta: r.ok ? (j.events_received || 1) : (j.error && j.error.message) || 'erro' });
    return { ok: r.ok, evento, valor: ev.custom_data ? ev.custom_data.value : null, meta: j };
  } catch (e) {
    capiLog(t, { card: card.contactName || card.id, evento, ok: false, resposta: e.message });
    return { ok: false, erro: e.message };
  }
}
// Chamado quando o card muda de coluna: se a coluna nova esta configurada, reporta.
async function aoEntrarNaColuna(t, cardId, colunaNova) {
  try {
    const cfg = getCapiCfg(t);
    if (!cfg.enabled || !colunaNova) return null;
    const regra = cfg.colunas.find(c => String(c.columnId) === String(colunaNova));
    if (!regra) return null;
    const card = (t.db.getCrmCards() || []).find(c => c.id === cardId);
    if (!card) return null;
    return await enviarEventoCapi(t, card, regra);
  } catch (e) { return null; }
}

app.get('/api/meta-capi/config', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const c = getCapiCfg(t);
  res.json({ ...c, token: c.token ? '***' : '', temToken: !!c.token });
});
app.put('/api/meta-capi/config', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const atual = getCapiCfg(t);
  const b = req.body || {};
  const colunas = (Array.isArray(b.colunas) ? b.colunas : []).map(x => ({
    columnId: String(x.columnId || '').trim(),
    eventName: String(x.eventName || 'Lead').trim().slice(0, 50),
    sendValue: !!x.sendValue,
  })).filter(x => x.columnId);
  saveCapiCfg(t, {
    enabled: !!b.enabled,
    pixelId: String(b.pixelId || '').trim(),
    // token em branco mantem o que ja estava (a tela nunca devolve o valor real)
    token: (b.token && b.token !== '***') ? String(b.token).trim() : atual.token,
    testCode: String(b.testCode || '').trim(),
    moeda: String(b.moeda || 'BRL').trim(),
    nomeCrm: String(b.nomeCrm || '').trim(),
    colunas,
  });
  const c = getCapiCfg(t);
  res.json({ ok: true, ...c, token: c.token ? '***' : '', temToken: !!c.token });
});
app.get('/api/meta-capi/log', requireAuth, (req, res) => {
  const c = getTenant(req.clientId).db.getConfig() || {};
  res.json(Array.isArray(c.metaCapiLog) ? c.metaCapiLog.slice(0, 30) : []);
});
// Envia um evento de teste a partir de um lead real, usando o test_event_code.
app.post('/api/meta-capi/testar', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const card = (t.db.getCrmCards() || []).find(c => c.id === String(req.body && req.body.cardId || ''));
  if (!card) return res.status(404).json({ error: 'Lead não encontrado' });
  const r = await enviarEventoCapi(t, { ...card, metaReported: {} }, { eventName: String(req.body.eventName || 'Lead'), sendValue: true }, { forcar: true });
  res.json(r);
});

// ── Qualificação de lead (plugin WhatsApp Web → CRM + Meta CAPI) ──
function getOrCreateCrmColumn(t, name) {
  const funnels = t.db.getFunnels();
  if (!funnels.length) return null;
  const fid = funnels[0].id;
  const cols = t.db.getCrmColumns(fid);
  const found = cols.find(c => String(c.name).trim().toLowerCase() === String(name).toLowerCase());
  if (found) return { columnId: found.id, funnelId: fid };
  const nc = t.db.createCrmColumn(name, fid);
  return { columnId: nc.id, funnelId: fid };
}
async function sendMetaLeadEvent(t, { name, phone, status }) {
  const cfg = t.db.getConfig();
  const pixel = cfg.META_PIXEL_ID, token = cfg.META_CAPI_TOKEN;
  if (!pixel || !token) return { skipped: 'sem META_PIXEL_ID/META_CAPI_TOKEN' };
  const digits = String(phone || '').replace(/\D/g, '');
  const eventName = status === 'qualificado' ? 'LeadQualificado' : 'LeadDesqualificado';
  const payload = { data: [{
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    user_data: { ph: digits ? [crypto.createHash('sha256').update(digits).digest('hex')] : [] },
  }] };
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pixel}/events?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json();
    return { ok: r.ok, event: eventName, meta: j };
  } catch (e) { return { ok: false, error: e.message }; }
}
app.post('/api/lead-qualify', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const name = String(req.body?.name || '').slice(0, 120);
  const status = req.body?.status === 'desqualificado' ? 'desqualificado' : 'qualificado';
  const digits = normalizeBrazilianMobileDigits(normalizePhoneNumber(req.body?.whatsapp || ''));
  if (!digits) return res.status(400).json({ error: 'whatsapp inválido' });
  const storageJid = `${digits}@s.whatsapp.net`;
  const colName = status === 'qualificado' ? 'Qualificada' : 'Desqualificado';
  const col = getOrCreateCrmColumn(t, colName);
  if (!col) return res.status(409).json({ error: 'Nenhum funil configurado no CRM.' });
  const label = status === 'qualificado' ? 'Qualificado' : 'Desqualificado';
  let card = findCrmCardForChat(t, storageJid);
  if (card) {
    t.db.updateCrmCard(card.id, { columnId: col.columnId, funnelId: col.funnelId, label, labels: [label], contactName: name || card.contactName });
  } else {
    card = t.db.createCrmCard({ columnId: col.columnId, funnelId: col.funnelId, contactName: name || digits, whatsapp: digits, whatsappId: storageJid, label, labels: [label] });
  }
  const meta = await sendMetaLeadEvent(t, { name, phone: digits, status });
  res.json({ ok: true, status, column: colName, cardId: card && card.id, meta });
});

// ── CRM Card Comments ──────────────────────────────────────
app.get('/api/crm/cards/:id/comments', requireAuth, (req, res) => {
  res.json(getTenant(req.clientId).db.getCrmComments(req.params.id) || []);
});
app.post('/api/crm/cards/:id/comments', requireAuth, (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comentario vazio' });
  const author = req.user?.name || 'Usuario';
  res.json(getTenant(req.clientId).db.addCrmComment(req.params.id, author, text));
});
app.delete('/api/crm/cards/:id/comments/:commentId', requireAuth, (req, res) => {
  getTenant(req.clientId).db.deleteCrmComment(req.params.commentId);
  res.json({ ok: true });
});

const DEFAULT_CRM_CHECKLIST = [
  { key: 'firstMessage', label: 'Primeira mensagem enviada' },
  { key: 'followedOnInsta', label: 'Segui no Instagram' },
  { key: 'commented', label: 'Comentei no post' }
];
app.get('/api/crm/checklist', requireAuth, (req, res) => {
  const c = getTenant(req.clientId).db.getConfig();
  res.json(Object.prototype.hasOwnProperty.call(c, 'crmChecklist')
    ? (Array.isArray(c.crmChecklist) ? c.crmChecklist : [])
    : DEFAULT_CRM_CHECKLIST);
});
app.put('/api/crm/checklist', requireAuth, (req, res) => {
  const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
    .map(i => ({ key: String(i.key || '').trim(), label: String(i.label || '').trim() }))
    .filter(i => i.key && i.label);
  getTenant(req.clientId).db.updateConfig({ crmChecklist: items });
  res.json({ ok: true, items });
});

const DEFAULT_CRM_LABELS = [
  { key: 'em_andamento', label: 'Em andamento', color: '#f59f00' },
  { key: 'nao_respondeu', label: 'Não respondeu', color: '#ff6b6b' },
  { key: 'finalizado', label: 'Finalizado', color: '#51cf66' },
  { key: 'quente', label: 'Quente', color: '#fa5252' },
  { key: 'morno', label: 'Morno', color: '#fd7e14' },
  { key: 'frio', label: 'Frio', color: '#4dabf7' },
  { key: 'atendimento_bot', label: 'Atendimento Bot', color: '#15aabf' },
  { key: 'atender', label: 'Atender', color: '#e8590c' },
];
app.get('/api/crm/labels', requireAuth, (req, res) => {
  const c = getTenant(req.clientId).db.getConfig();
  res.json(Object.prototype.hasOwnProperty.call(c, 'crmLabels')
    ? (Array.isArray(c.crmLabels) ? c.crmLabels : [])
    : DEFAULT_CRM_LABELS);
});
app.put('/api/crm/labels', requireAuth, (req, res) => {
  const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
    .map(i => ({ key: String(i.key || '').trim(), label: String(i.label || '').trim(), color: /^#[0-9a-fA-F]{6}$/.test(i.color) ? i.color : '#888888' }))
    .filter(i => i.key && i.label);
  getTenant(req.clientId).db.updateConfig({ crmLabels: items });
  res.json({ ok: true, items });
});

// Status manual do cliente na Área de Clientes (Crítico/Moderado/Bom/Excelente por padrão,
// lista editável — mesmo padrão de crmLabels acima, só que específico dessa tela).
const DEFAULT_CLIENT_AREA_STATUSES = [
  { key: 'critico', label: 'Crítico', color: '#fa5252' },
  { key: 'moderado', label: 'Moderado', color: '#f59f00' },
  { key: 'bom', label: 'Bom', color: '#4dabf7' },
  { key: 'excelente', label: 'Excelente', color: '#40c057' },
];
app.get('/api/client-area-statuses', requireAuth, (req, res) => {
  const c = getTenant(req.clientId).db.getConfig();
  res.json(Object.prototype.hasOwnProperty.call(c, 'clientAreaStatuses')
    ? (Array.isArray(c.clientAreaStatuses) ? c.clientAreaStatuses : [])
    : DEFAULT_CLIENT_AREA_STATUSES);
});
app.put('/api/client-area-statuses', requireAuth, (req, res) => {
  const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
    .map(i => ({ key: String(i.key || '').trim(), label: String(i.label || '').trim(), color: /^#[0-9a-fA-F]{6}$/.test(i.color) ? i.color : '#888888' }))
    .filter(i => i.key && i.label);
  getTenant(req.clientId).db.updateConfig({ clientAreaStatuses: items });
  res.json({ ok: true, items });
});

app.get('/api/crm/custom-fields', requireAuth, (req, res) => {
  const c = getTenant(req.clientId).db.getConfig();
  res.json(Array.isArray(c.crmCustomFields) ? c.crmCustomFields : []);
});
app.put('/api/crm/custom-fields', requireAuth, (req, res) => {
  const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
    .map(i => ({ key: String(i.key || '').trim(), label: String(i.label || '').trim(), type: String(i.type || 'text').trim() }))
    .filter(i => i.key && i.label);
  getTenant(req.clientId).db.updateConfig({ crmCustomFields: items });
  res.json({ ok: true, items });
});

// Quais campos do lead aparecem na coluna lateral do Chat ao vivo. Vazio/ausente = todos
// (comportamento padrão, mesmo de antes desta configuração existir).
app.get('/api/crm/live-panel-fields', requireAuth, (req, res) => {
  const c = getTenant(req.clientId).db.getConfig();
  res.json({ keys: Array.isArray(c.liveLeadPanelFields) ? c.liveLeadPanelFields : [] });
});
app.put('/api/crm/live-panel-fields', requireAuth, (req, res) => {
  const keys = (Array.isArray(req.body && req.body.keys) ? req.body.keys : [])
    .map(k => String(k || '').trim()).filter(Boolean);
  getTenant(req.clientId).db.updateConfig({ liveLeadPanelFields: keys });
  res.json({ ok: true, keys });
});

// ===== Dashboard do cliente =====
app.get('/api/dashboard', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  const profile = cfg.clientDashboard || {};
  let cards = [];
  try { cards = t.db.getCrmCards() || []; } catch (e) {}
  const now = Date.now();
  const leads7 = cards.filter(c => (c.createdAt || c.created_at || 0) > now - 7 * 864e5).length;
  const leadsHoje = cards.filter(c => (c.createdAt || c.created_at || 0) > now - 864e5).length;
  res.json({ profile, metrics: { leadsTotal: cards.length, leads7, leadsHoje } });
});

app.get('/api/dashboard/ops', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const DAY = 864e5;
  // Intervalo escolhido no dashboard (?from=AAAA-MM-DD&to=AAAA-MM-DD). Aceita também o
  // antigo ?date= (um dia só, from=to=date) por compatibilidade. Sem nenhum parâmetro,
  // cai em hoje. brDayBounds/brDateKey resolvem tudo no fuso de Brasília — antes esse
  // cálculo usava o fuso do próprio servidor (UTC na VPS), então "hoje" podia estar até
  // 3h errado.
  const isDateStr = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const todayKey = brDateKey(Date.now());
  let fromKey = isDateStr(req.query.from) ? req.query.from : (isDateStr(req.query.date) ? req.query.date : todayKey);
  let toKey = isDateStr(req.query.to) ? req.query.to : (isDateStr(req.query.date) ? req.query.date : todayKey);
  if (fromKey > toKey) { const tmp = fromKey; fromKey = toKey; toKey = tmp; }
  const selectedDate = fromKey === toKey ? fromKey : null; // compat: só quando é um único dia
  const { start: startOfToday } = brDayBounds(fromKey); // início do período
  const { start: toStart } = brDayBounds(toKey);
  const rangeEnd = toStart + DAY; // fim do período (exclusivo)
  let cards = [];
  try { cards = t.db.getCrmCards() || []; } catch (e) {}
  const cAt = (c) => Number(c.createdAt || c.created_at || 0);
  const leadsToday = cards.filter(c => cAt(c) >= startOfToday && cAt(c) < rangeEnd).length;
  const leadsTotal = cards.length;
  // Gráfico diário: cobre o período inteiro, até um teto de 60 barras (períodos maiores
  // mostram só a janela mais recente dentro do intervalo, pra não virar um gráfico ilegível).
  const seriesDays = Math.min(60, Math.max(1, Math.round((rangeEnd - startOfToday) / DAY)));
  const series = [];
  for (let i = seriesDays - 1; i >= 0; i--) {
    const d0 = rangeEnd - (i + 1) * DAY, d1 = d0 + DAY;
    const cnt = cards.filter(c => cAt(c) >= d0 && cAt(c) < d1).length;
    const dd = new Date(d0);
    series.push({ day: dd.getDate() + '/' + (dd.getMonth() + 1), count: cnt });
  }
  const colName = {};
  try { (t.db.getCrmColumns() || []).forEach(cl => { colName[cl.id] = cl.name; }); } catch (e) {}
  const colInfo = {};
  try {
    const funnels = t.db.getFunnels() || [];
    const funnelName = {};
    funnels.forEach(f => { funnelName[f.id] = f.name; });
    (t.db.getCrmColumns() || []).forEach(cl => {
      colInfo[cl.id] = {
        columnId: cl.id,
        columnName: cl.name,
        funnelId: cl.funnelId || '',
        funnelName: funnelName[cl.funnelId] || ''
      };
    });
  } catch (e) {}
  // Quantos cards entraram em cada coluna HOJE, agrupado por funil — mesma pergunta do
  // board ("+N hoje"), só que consolidada num relatório único pro dashboard.
  let columnEntriesToday = [];
  try {
    const funnels = t.db.getFunnels() || [];
    const allCols = t.db.getCrmColumns() || [];
    funnels.forEach(f => {
      const counts = t.db.getColumnEntryCounts(f.id, startOfToday, rangeEnd);
      allCols.filter(c => c.funnelId === f.id).forEach(c => {
        if (counts[c.id]) columnEntriesToday.push({ funnelName: f.name, columnId: c.id, columnName: c.name, count: counts[c.id] });
      });
    });
  } catch (e) {}
  // Origem dos leads (Meta/Google/Site) — usa a mesma etiqueta que "Origem dos leads"
  // (config leadSourceRules) grava em card.labels quando a frase do 1º contato bate.
  const LEAD_SOURCE_TAGS = ['meta', 'google', 'site'];
  const LEAD_SOURCE_NAMES = { meta: 'Meta Ads', google: 'Google Ads', site: 'Site' };
  const cardSourceTag = (c) => {
    if (!Array.isArray(c.labels)) return null;
    const low = c.labels.map(l => String(l).toLowerCase());
    return LEAD_SOURCE_TAGS.find(tag => low.includes(tag)) || null;
  };
  const leadSourceToday = LEAD_SOURCE_TAGS.map(tag => ({ tag, name: LEAD_SOURCE_NAMES[tag], count: cards.filter(c => cAt(c) >= startOfToday && cAt(c) < rangeEnd && cardSourceTag(c) === tag).length }));
  const leadSourceTotal = LEAD_SOURCE_TAGS.map(tag => ({ tag, name: LEAD_SOURCE_NAMES[tag], count: cards.filter(c => cardSourceTag(c) === tag).length }));
  const leadSource = {
    todayTotal: cards.filter(c => cAt(c) >= startOfToday && cAt(c) < rangeEnd && cardSourceTag(c)).length,
    total: cards.filter(c => cardSourceTag(c)).length,
    today: leadSourceToday,
    allTime: leadSourceTotal,
  };
  // Visitas tecnicas — quantos leads entraram na coluna "Visita agendada" no periodo,
  // que horas entraram, e quanto tempo demorou desde o 1o contato (card.createdAt) ate
  // isso acontecer. "Feita" aqui = entrou na coluna (nao existe etapa de "visita
  // realizada" separada hoje); pedido explicito do Wagnner 25/09/2026.
  let visitas = null;
  try {
    const visitaCol = (t.db.getCrmColumns() || []).find(c => /visita\s*agendada/i.test(c.name || ''));
    if (visitaCol) {
      const events = t.db.getColumnEntryEvents(visitaCol.id, startOfToday, rangeEnd);
      const cardById = {};
      cards.forEach(c => { cardById[c.id] = c; });
      const items = events.map(e => {
        const card = cardById[e.cardId];
        const created = card ? cAt(card) : null;
        const waitMs = (created && e.at >= created) ? (e.at - created) : null;
        return {
          name: card ? (card.contactName || card.phone || card.whatsapp || '(sem nome)') : '(card removido)',
          at: e.at,
          hora: brHM(e.at),
          waitMs,
        };
      });
      const withWait = items.filter(i => i.waitMs != null);
      const avgWaitMs = withWait.length ? Math.round(withWait.reduce((s, i) => s + i.waitMs, 0) / withWait.length) : 0;
      const buckets = { ate1h: 0, mesmoDia: 0, maisDeUmDia: 0 };
      withWait.forEach(i => {
        const h = i.waitMs / 3600000;
        if (h <= 1) buckets.ate1h++; else if (h <= 24) buckets.mesmoDia++; else buckets.maisDeUmDia++;
      });
      const perDayMap = {};
      items.forEach(i => { const k = brDateKey(i.at); perDayMap[k] = (perDayMap[k] || 0) + 1; });
      const perDay = Object.keys(perDayMap).sort().map(k => ({ day: k, count: perDayMap[k] }));
      visitas = {
        columnName: visitaCol.name,
        total: items.length,
        avgWaitHours: Math.round((avgWaitMs / 3600000) * 10) / 10,
        buckets,
        perDay,
        list: items.slice().sort((a, b) => b.at - a.at).slice(0, 100).map(i => ({ name: i.name, hora: i.hora, waitHours: i.waitMs != null ? Math.round((i.waitMs / 3600000) * 10) / 10 : null })),
      };
    }
  } catch (e) {}

  // Horario de pico de mensagens recebidas (Brasilia), no periodo selecionado.
  let horarioPico = null;
  try {
    const inboundTs = t.db.getInboundMessageTimestamps(startOfToday, rangeEnd);
    const hourCounts = new Array(24).fill(0);
    inboundTs.forEach(ts => { hourCounts[brHour(ts)]++; });
    let peakHour = 0, peakCount = 0;
    hourCounts.forEach((c, h) => { if (c > peakCount) { peakCount = c; peakHour = h; } });
    horarioPico = { total: inboundTs.length, peakHour, peakCount, byHour: hourCounts.map((count, hour) => ({ hour, count })) };
  } catch (e) {}

  const trafficCardsToday = cards.filter(c => cAt(c) >= startOfToday && cAt(c) < rangeEnd && cardSourceTag(c));
  const trafficStageMap = {};
  trafficCardsToday.forEach(c => {
    const info = colInfo[c.columnId] || { columnId: c.columnId || '', columnName: 'Sem etapa', funnelName: '' };
    const key = info.columnId || info.columnName;
    const row = trafficStageMap[key] = trafficStageMap[key] || {
      columnId: info.columnId || '',
      columnName: info.columnName || 'Sem etapa',
      funnelName: info.funnelName || '',
      count: 0,
      sources: {}
    };
    row.count++;
    const src = cardSourceTag(c) || 'outro';
    row.sources[src] = (row.sources[src] || 0) + 1;
  });
  const trafficOutcome = {
    total: trafficCardsToday.length,
    stages: Object.values(trafficStageMap).sort((a, b) => b.count - a.count)
  };
  const callbacks = cards.filter(c => c.callbackAt).sort((a, b) => (b.callbackAt || 0) - (a.callbackAt || 0)).slice(0, 60).map(c => ({
    id: c.id,
    name: c.contactName || c.whatsapp || c.phone || '(sem nome)',
    phone: c.whatsapp || c.phone || '',
    at: c.callbackAt,
    reason: c.callbackReason || '',
    whatsappId: c.whatsappId || '',
    column: colName[c.columnId] || ''
  }));
  const area = getClientAreaObj(t);
  const groupsMap = {};
  let tTotal = 0, tDone = 0;
  const addTask = (task, group) => {
    if (!task || !task.due) return;
    const due = Number(task.due);
    if (due < startOfToday || due >= rangeEnd) return;
    const g = group || 'Sem grupo';
    const gm = groupsMap[g] = groupsMap[g] || { total: 0, done: 0, resp: {} };
    gm.total++; tTotal++;
    if (task.status === 'feito') { gm.done++; tDone++; }
    const r = String(task.responsavel || '').trim() || '(sem resp)';
    gm.resp[r] = (gm.resp[r] || 0) + 1;
  };
  (area.clients || []).forEach(c => (c.tasks || []).forEach(tk => addTask(sanitizeClientTask(tk), c.group)));
  (area.avulsas || []).forEach(tk => addTask(sanitizeClientTask(tk), 'Avulsas'));
  const byGroup = Object.keys(groupsMap).map(g => ({ group: g, total: groupsMap[g].total, done: groupsMap[g].done })).sort((a, b) => b.total - a.total);
  const respAgg = {};
  Object.values(groupsMap).forEach(gm => { Object.keys(gm.resp).forEach(r => { respAgg[r] = (respAgg[r] || 0) + gm.resp[r]; }); });
  const byResp = Object.keys(respAgg).map(r => ({ resp: r, count: respAgg[r] })).sort((a, b) => b.count - a.count);
  // Sucesso do disparo POR DIA (from/to). interesse/sem = customFields.disparoResp+disparoDia; naoResponderam = reply watch pendente no periodo.
  const _inRangeDia = (dia) => !!dia && dia >= fromKey && dia <= toKey;
  const _dispInteresse = cards.filter(c => c.customFields && _inRangeDia(c.customFields.disparoDia) && c.customFields.disparoResp === 'sim').length;
  const _dispSem = cards.filter(c => c.customFields && _inRangeDia(c.customFields.disparoDia) && c.customFields.disparoResp === 'nao').length;
  const _dispNao = cards.filter(c => c.customFields && _inRangeDia(c.customFields.disparoDia) && c.customFields.disparoResp === 'pendente').length;
  const _dispResp = _dispInteresse + _dispSem;
  const _dispTaxa = _dispResp ? Math.round(_dispInteresse / _dispResp * 100) : 0;
  // Templates da API Oficial enviados no período — soma os buckets diarios entre fromKey..toKey.
  let _tplTotal = 0; const _tplByName = {};
  try {
    const _tplCounts = (t.db.getConfig() || {}).templateSendCounts || {};
    Object.keys(_tplCounts).forEach(day => {
      if (day < fromKey || day > toKey) return;
      const b = _tplCounts[day] || {};
      _tplTotal += (b.total || 0);
      Object.keys(b.byTemplate || {}).forEach(n => { _tplByName[n] = (_tplByName[n] || 0) + b.byTemplate[n]; });
    });
  } catch (e) {}
  const templatesEnviados = { total: _tplTotal, byTemplate: Object.entries(_tplByName).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
  res.json({
    selectedDate,
    selectedFrom: fromKey,
    selectedTo: toKey,
    leads: { today: leadsToday, total: leadsTotal, series },
    tarefas: { today: tTotal, done: tDone, todo: tTotal - tDone, byGroup, byResp },
    callbacks,
    columnEntriesToday,
    leadSource,
    trafficOutcome,
    disparo: { interesse: _dispInteresse, semInteresse: _dispSem, naoResponderam: _dispNao, respondidos: _dispResp, total: _dispResp + _dispNao, taxa: _dispTaxa },
    templatesEnviados,
    visitas,
    horarioPico
  });
});
// Médias do funil no período: tempo médio até cada coluna, conversa e ligações — pros
// leads CRIADOS no período (mesmo from/to do resto do dashboard).
app.get('/api/dashboard/funnel-averages', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const isDateStr = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const todayKey = brDateKey(Date.now());
  let fromKey = isDateStr(req.query.from) ? req.query.from : todayKey;
  let toKey = isDateStr(req.query.to) ? req.query.to : todayKey;
  if (fromKey > toKey) { const tmp = fromKey; fromKey = toKey; toKey = tmp; }
  const { start: fromTs } = brDayBounds(fromKey);
  const { start: toStart } = brDayBounds(toKey);
  const toTs = toStart + 864e5;

  const funnels = t.db.getFunnels() || [];
  const funnelId = req.query.funnelId && funnels.some(f => f.id === req.query.funnelId) ? req.query.funnelId : (funnels[0] ? funnels[0].id : 'default');
  const cols = (t.db.getCrmColumns() || []).filter(c => (c.funnelId || 'default') === funnelId);
  const colName = {}; cols.forEach(c => { colName[c.id] = c.name; });

  const data = t.db.getFunnelAverages(funnelId, fromTs, toTs);
  data.columns = data.columns.map(c => ({ ...c, columnName: colName[c.columnId] || c.columnId })).sort((a, b) => b.reached - a.reached);
  res.json({ selectedFrom: fromKey, selectedTo: toKey, funnelId, funnels: funnels.map(f => ({ id: f.id, name: f.name })), ...data });
});
app.get('/api/dashboard/agency', requireAuth, (req, res) => {
  if (String(req.clientId) !== 'virandoachave') return res.status(403).json({ error: 'Apenas a agencia' });
  let Database; try { Database = require('better-sqlite3'); } catch (e) { return res.status(500).json({ error: 'db lib indisponivel' }); }
  const base = '/root/clients';
  const now = Date.now();
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter(d => d !== 'data' && d !== 'virandoachave' && fs.existsSync(path.join(base, d, 'data', d, 'db.sqlite3'))); } catch (e) {}
  const out = [];
  for (const id of dirs) {
    const dbPath = path.join(base, id, 'data', id, 'db.sqlite3');
    let profile = {}, metrics = { leadsTotal: 0, leads7: 0, leadsHoje: 0 };
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try { const row = db.prepare("SELECT value FROM config WHERE key='clientDashboard'").get(); if (row && row.value) profile = JSON.parse(row.value) || {}; } catch (e) {}
      try {
        metrics.leadsTotal = ((db.prepare('SELECT COUNT(*) n FROM crm_cards').get()) || {}).n || 0;
        metrics.leads7 = ((db.prepare('SELECT COUNT(*) n FROM crm_cards WHERE created_at > ?').get(now - 7 * 864e5)) || {}).n || 0;
        metrics.leadsHoje = ((db.prepare('SELECT COUNT(*) n FROM crm_cards WHERE created_at > ?').get(now - 864e5)) || {}).n || 0;
      } catch (e) {}
      db.close();
    } catch (e) {}
    out.push({ clientId: id, name: profile.name || id, url: 'https://' + id + '.gestorwagnnerpires.com.br', profile, metrics });
  }
  out.sort((a, b) => (b.metrics.leadsTotal || 0) - (a.metrics.leadsTotal || 0));
  res.json(out);
});


app.put('/api/dashboard', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const profile = (req.body && req.body.profile && typeof req.body.profile === 'object') ? req.body.profile : {};
  t.db.updateConfig({ clientDashboard: profile });
  res.json({ ok: true });
});

// ═══════════════ Área do Cliente (gestão de clientes da agência) ═══════════════
function getClientAreaObj(t) { const a = (t.db.getConfig() || {}).clientArea || {}; return { clients: Array.isArray(a.clients) ? a.clients : [], avulsas: Array.isArray(a.avulsas) ? a.avulsas : [] }; }
// Permissão "allowedGroups": null/ausente = usuário vê todos os grupos (comportamento
// de sempre); array presente = allowlist explícita dos grupos de cliente (client.group)
// que este usuário de equipe pode ver — '__none' representa clientes sem grupo definido.
function clientAreaGroupKey(client) { return (client && client.group) ? String(client.group) : '__none'; }
function clientAreaAllowedGroups(req) {
  const allowed = req.user?.permissions?.allowedGroups;
  return Array.isArray(allowed) ? allowed.map(String) : null;
}
function filterClientsByGroupPermission(req, clients) {
  const allowed = clientAreaAllowedGroups(req);
  if (!allowed) return clients;
  return clients.filter(c => allowed.includes(clientAreaGroupKey(c)));
}
function clientAreaClientVisible(req, client) {
  const allowed = clientAreaAllowedGroups(req);
  return !allowed || allowed.includes(clientAreaGroupKey(client));
}
// O seletor de "Grupos monitorados" (Área de Clientes) busca em /api/groups a lista
// completa de grupos do WhatsApp do tenant, sem filtro nenhum — um usuário restrito por
// allowedGroups (ex: só vê os clientes do grupo "KAROL") conseguia ver e escolher grupos
// de QUALQUER outro cliente da agência. Aqui escondemos os grupos já usados por clientes
// fora do allowedGroups dela; grupos ainda não vinculados a ninguém continuam visíveis
// (senão ela nunca conseguiria vincular um grupo novo aos próprios clientes).
function filterGroupsByClientAreaPermission(t, req, groups) {
  const allowed = clientAreaAllowedGroups(req);
  if (!allowed || !Array.isArray(groups)) return groups;
  const area = getClientAreaObj(t);
  const forbidden = new Set();
  area.clients.forEach(c => {
    if (!allowed.includes(clientAreaGroupKey(c))) {
      (c.monitor && c.monitor.groups || []).forEach(g => { if (g && g.id) forbidden.add(g.id); });
    }
  });
  return groups.filter(g => !forbidden.has(g.id));
}

// ─── Meta Ads (reaproveita o token/contas do painel envio) ───
function loadMetaToken() { try { return (JSON.parse(fs.readFileSync(path.join(__dirname, 'meta-config.json'), 'utf8')).accessToken) || ''; } catch (e) { return ''; } }
function loadMetaAccountsList() { try { const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta-accounts.json'), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
async function fetchMetaAdInsights(accountId, token, preset) {
  const tok = encodeURIComponent(token);
  const g = (u) => fetch(u).then(r => r.json());
  const [acc, ins] = await Promise.all([
    g(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}?fields=name,account_status,currency&access_token=${tok}`),
    g(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}/insights?fields=impressions,clicks,actions,frequency,spend&date_preset=${preset}&access_token=${tok}`),
  ]);
  if (acc.error) throw new Error(acc.error.message);
  if (ins.error) throw new Error(ins.error.message);
  const d = (ins.data && ins.data[0]) || {};
  const impressions = parseInt(d.impressions || 0), clicks = parseInt(d.clicks || 0), spend = parseFloat(d.spend || 0), frequency = parseFloat(d.frequency || 0);
  const actions = d.actions || [];
  const leads = parseInt((actions.find(a => a.action_type === 'lead') || {}).value || 0);
  const messages = parseInt((actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d' || a.action_type === 'onsite_conversion.messaging_first_reply') || {}).value || 0);
  const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
  const cpl = leads > 0 ? parseFloat((spend / leads).toFixed(2)) : 0;
  return { accountName: acc.name || accountId, accountStatus: acc.account_status === 1 ? 'ativa' : 'pausada', currency: acc.currency || 'BRL', impressions, clicks, spend: parseFloat(spend.toFixed(2)), frequency: parseFloat(frequency.toFixed(2)), leads, messages, ctr, cpl };
}
app.get('/api/meta-ad-accounts', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.json([]);
  try {
    const out = [];
    let url = `https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/me/adaccounts?fields=name,account_status&limit=200&access_token=${encodeURIComponent(token)}`;
    let pages = 0;
    while (url && pages < 20) {
      const d = await fetch(url).then(r => r.json());
      if (d.error) throw new Error(d.error.message);
      (d.data || []).forEach(a => out.push({ id: String(a.id || '').replace(/^act_/, ''), name: a.name || a.id, status: a.account_status === 1 ? 'ativa' : 'pausada' }));
      url = (d.paging && d.paging.next) || null;
      pages++;
    }
    out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const allow = tenantAllowedAccounts(req);
    res.json(allow ? out.filter(a => allow.includes(a.id)) : out);
  } catch (e) {
    const stat = loadMetaAccountsList().map(a => ({ id: a.id, name: a.name }));
    res.json(stat);
  }
});
// ═══════════════ Anúncios — Google Ads (relatório, credenciais cifradas) ═══════════════
const GADS_API = 'https://googleads.googleapis.com/v22'; // v21 foi descontinuada pelo Google (bloqueada em produção)
let _gadsCreds = null, _gadsTok = null, _gadsTokExp = 0, _gadsAcctCache = null, _gadsAcctCacheAt = 0, _gadsLoginMap = {};
function loadGoogleAdsCreds() {
  if (_gadsCreds) return _gadsCreds;
  try {
    const blob = Buffer.from(fs.readFileSync(path.join(__dirname, 'google-ads.enc'), 'utf8').trim(), 'base64');
    const secret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';
    const key = require('crypto').createHash('sha256').update(secret + '::vac-google-ads').digest();
    const d = require('crypto').createDecipheriv('aes-256-gcm', key, blob.slice(0, 12));
    d.setAuthTag(blob.slice(12, 28));
    _gadsCreds = JSON.parse(Buffer.concat([d.update(blob.slice(28)), d.final()]).toString('utf8'));
    return _gadsCreds;
  } catch (e) { return null; }
}
async function gadsToken() {
  if (_gadsTok && Date.now() < _gadsTokExp) return _gadsTok;
  const c = loadGoogleAdsCreds(); if (!c) throw new Error('Google Ads não configurado.');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) }).then(x => x.json());
  if (!r.access_token) throw new Error('Falha no token Google: ' + (r.error_description || r.error || ''));
  _gadsTok = r.access_token; _gadsTokExp = Date.now() + Math.max(60, (r.expires_in || 3600) - 60) * 1000;
  return _gadsTok;
}
async function gadsSearch(customerId, query, loginId) {
  const c = loadGoogleAdsCreds(); const tok = await gadsToken();
  const cid = String(customerId).replace(/\D/g, '');
  const r = await fetch(`${GADS_API}/customers/${cid}/googleAds:search`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'developer-token': c.developer_token, 'login-customer-id': String(loginId || cid).replace(/\D/g, ''), 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }).then(x => x.json());
  if (r.error) throw new Error(r.error.message || 'erro Google Ads');
  return r.results || [];
}
async function gadsListAccounts() {
  if (_gadsAcctCache && Date.now() - _gadsAcctCacheAt < 600000) return _gadsAcctCache;
  const c = loadGoogleAdsCreds(); const tok = await gadsToken();
  const la = await fetch(`${GADS_API}/customers:listAccessibleCustomers`, { headers: { 'Authorization': 'Bearer ' + tok, 'developer-token': c.developer_token } }).then(x => x.json());
  const ids = (la.resourceNames || []).map(rn => String(rn).replace('customers/', ''));
  const out = []; const loginMap = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const rows = await gadsSearch(id, 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code FROM customer_client', id);
      rows.forEach(row => { const cc = row.customerClient || {}; if (cc.manager) return; const _a = String(cc.id); out.push({ id: _a, name: cc.descriptiveName || _a, currency: cc.currencyCode || 'BRL' }); if (!loginMap[_a] || _a === id) loginMap[_a] = id; });
    } catch (e) {}
  }));
  const seen = {}; const dedup = out.filter(a => (seen[a.id] ? false : (seen[a.id] = 1)));
  dedup.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  _gadsAcctCache = dedup; _gadsAcctCacheAt = Date.now(); _gadsLoginMap = loginMap;
  return dedup;
}
function gadsLoginFor(id) { return (_gadsLoginMap && _gadsLoginMap[String(id).replace(/\D/g, '')]) || null; }
function googleAdsAllowed(req) { try { const arr = (getTenant(req.clientId).db.getConfig() || {}).adsGoogleAllowed; if (Array.isArray(arr) && arr.length) return arr.map(String); } catch (e) {} return null; }

app.get('/api/ads/google/accounts', requireAuth, async (req, res) => {
  if (!loadGoogleAdsCreds()) return res.json([]);
  try {
    let list = await gadsListAccounts();
    const allow = googleAdsAllowed(req);
    if (allow) list = list.filter(a => allow.includes(a.id));
    else if (req.clientId !== 'virandoachave') list = [];
    res.json(list);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/ads/google/report', requireAuth, async (req, res) => {
  if (!loadGoogleAdsCreds()) return res.status(400).json({ error: 'Google Ads não configurado.' });
  const accountId = String(req.query.account || '').replace(/\D/g, '');
  if (!accountId) return res.status(400).json({ error: 'Informe a conta.' });
  const allow = googleAdsAllowed(req);
  if (allow ? !allow.includes(accountId) : req.clientId !== 'virandoachave') return res.status(403).json({ error: 'Conta não permitida para este cliente.' });
  const VALID = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'];
  const preset = VALID.includes(req.query.preset) ? req.query.preset : 'last_7d';
  const R = reportRangeFromExplicitDates(req.query.weeklySince, req.query.weeklyUntil, req.query.weeklyPrevSince, req.query.weeklyPrevUntil) || metaRanges(preset);
  const between = (r) => `segments.date BETWEEN '${r.since}' AND '${r.until}'`;
  const M = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.cost_per_conversion, metrics.conversions_value';
  function kpi(rows) {
    const m = (rows[0] && rows[0].metrics) || {};
    const cost = (+(m.costMicros || 0)) / 1e6, conv = +(m.conversions || 0);
    return { cost, impressions: +(m.impressions || 0), clicks: +(m.clicks || 0), ctr: (+(m.ctr || 0)) * 100, cpc: (+(m.averageCpc || 0)) / 1e6, cpm: (+(m.averageCpm || 0)) / 1e6, conversions: conv, cpConv: conv > 0 ? cost / conv : 0, convValue: +(m.conversionsValue || 0) };
  }
  try {
    let login = gadsLoginFor(accountId);
    if (!login) { try { await gadsListAccounts(); } catch (e) {} login = gadsLoginFor(accountId) || accountId; }
    const [curR, prevR, dailyR, campR] = await Promise.all([
      gadsSearch(accountId, `SELECT ${M} FROM customer WHERE ${between(R.cur)}`, login),
      gadsSearch(accountId, `SELECT ${M} FROM customer WHERE ${between(R.prev)}`, login),
      gadsSearch(accountId, `SELECT segments.date, metrics.cost_micros FROM customer WHERE ${between(R.cur)} ORDER BY segments.date`, login),
      gadsSearch(accountId, `SELECT campaign.name, ${M} FROM campaign WHERE ${between(R.cur)} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 10`, login),
    ]);
    const cur = kpi(curR), prev = kpi(prevR);
    const changes = {}; Object.keys(cur).forEach(k => { const c = cur[k], p = prev[k]; changes[k] = (p > 0) ? ((c - p) / p * 100) : (c > 0 ? 100 : 0); });
    const dailySpend = dailyR.map(r => ({ date: (r.segments && r.segments.date) || '', spend: (+((r.metrics && r.metrics.costMicros) || 0)) / 1e6 }));
    const campaigns = campR.map(r => { const m = r.metrics || {}; const cost = (+(m.costMicros || 0)) / 1e6, conv = +(m.conversions || 0); return { name: (r.campaign && r.campaign.name) || '—', spend: cost, impressions: +(m.impressions || 0), clicks: +(m.clicks || 0), ctr: (+(m.ctr || 0)) * 100, cpc: (+(m.averageCpc || 0)) / 1e6, conversions: conv, cpConv: conv > 0 ? cost / conv : 0 }; });
    let name = accountId, currency = 'BRL';
    try { const acc = (await gadsListAccounts()).find(a => a.id === accountId); if (acc) { name = acc.name; currency = acc.currency; } } catch (e) {}
    res.json({ account: { id: accountId, name, currency }, preset, range: R, kpis: { cur, prev, changes }, dailySpend, campaigns });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ═══════════════ Anúncios — conexão Meta por tenant (OAuth Facebook) ═══════════════
const ADS_REDIRECT_URI = process.env.ADS_META_REDIRECT_URI || 'https://virandoachave.gestorwagnnerpires.com.br/api/ads/meta/callback';
function _adsSecret(){ return process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || 'x'; }
function _adsAppId(){ return process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || ''; }
function signAdsState(clientId){ const crypto = require('crypto'); const ts = Date.now().toString(36); const base = clientId + '.' + ts; const sig = crypto.createHmac('sha256', _adsSecret()).update(base).digest('hex').slice(0, 24); return base + '.' + sig; }
function verifyAdsState(state){ try { const crypto = require('crypto'); const parts = String(state || '').split('.'); if (parts.length !== 3) return null; const base = parts[0] + '.' + parts[1]; const exp = crypto.createHmac('sha256', _adsSecret()).update(base).digest('hex').slice(0, 24); if (exp !== parts[2]) return null; if (Date.now() - parseInt(parts[1], 36) > 900000) return null; return { clientId: parts[0] }; } catch (e) { return null; } }

// Link público "fila da vez": permite o CLIENTE (sem login no CRM) gerenciar só os
// consultores cadastrados, por um link fixo (sem expiração — pensado pra ficar salvo
// no navegador do cliente). Mesmo padrão de assinatura do signAdsState, só sem timestamp.
function signConsultantsLink(clientId){ const crypto = require('crypto'); const sig = crypto.createHmac('sha256', _adsSecret()).update('consultants:' + clientId).digest('hex').slice(0, 32); return clientId + '.' + sig; }
function verifyConsultantsLink(token){ try { const crypto = require('crypto'); const parts = String(token || '').split('.'); if (parts.length !== 2) return null; const [clientId, sig] = parts; const exp = crypto.createHmac('sha256', _adsSecret()).update('consultants:' + clientId).digest('hex').slice(0, 32); if (exp !== sig) return null; return clientId; } catch (e) { return null; } }
function requirePublicConsultantsToken(req, res, next) {
  const clientId = verifyConsultantsLink(req.query.t);
  if (!clientId) return res.status(401).json({ error: 'Link inválido.' });
  req.clientId = clientId;
  next();
}
function tenantMetaToken(req){ try { const am = (getTenant(req.clientId).db.getConfig() || {}).adsMeta; if (am && am.token) return am.token; } catch (e) {} if (req.clientId === 'virandoachave') return loadMetaToken(); return ''; }
function tenantAllowedAccounts(req){ try { const arr = (getTenant(req.clientId).db.getConfig() || {}).adsAllowedAccounts; if (Array.isArray(arr) && arr.length) return arr.map(String); } catch (e) {} return null; }
async function exchangeAdsCode(code){
  const appId = _adsAppId(), appSecret = _adsSecret();
  const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, code, redirect_uri: ADS_REDIRECT_URI });
  const r = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, { method: 'POST', body });
  const d = await r.json(); if (!d.access_token) throw new Error((d.error && d.error.message) || 'Meta não retornou token.');
  try { const e = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${d.access_token}`).then(x => x.json()); if (e.access_token) d.access_token = e.access_token; } catch (_) {}
  return d.access_token;
}
function adsPopupHtml(msg, ok, msgType){ msgType = msgType || 'ads-meta-oauth'; const safe = String(msg).replace(/[<>&]/g, ''); return '<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0c0c0c;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:42px">' + (ok ? '✅' : '⚠️') + '</div><p style="max-width:340px;line-height:1.5">' + safe + '</p><button onclick="window.close()" style="padding:10px 18px;border-radius:8px;border:0;background:#2563eb;color:#fff;font-size:14px;cursor:pointer">Fechar</button></div><script>try{window.opener&&window.opener.postMessage({type:"' + msgType + '",ok:' + (ok ? 'true' : 'false') + '},"*")}catch(e){}setTimeout(function(){try{window.close()}catch(e){}},' + (ok ? '1200' : '6000') + ');</script></body>'; }

// ═══════════════ Redes Sociais — Instagram/Facebook (inbox + comentários) ═══════════════
// Mesmo mecanismo de OAuth dos Anúncios (state assinado, popup, postMessage), só que com
// escopos de mensagens/comentários e guardando o token DA PÁGINA (não do usuário) — é o
// token de página que a API de mensagens e comentários exige.
const SOCIAL_REDIRECT_URI = process.env.SOCIAL_META_REDIRECT_URI || 'https://virandoachave.gestorwagnnerpires.com.br/api/social/meta/callback';
const SOCIAL_SCOPES = 'instagram_basic,instagram_manage_messages,instagram_manage_comments,pages_show_list,pages_messaging,pages_manage_engagement,pages_read_engagement,business_management';
function signSocialState(clientId){ const crypto = require('crypto'); const ts = Date.now().toString(36); const base = clientId + '.' + ts; const sig = crypto.createHmac('sha256', _adsSecret()).update('social:' + base).digest('hex').slice(0, 24); return base + '.' + sig; }
function verifySocialState(state){ try { const crypto = require('crypto'); const parts = String(state || '').split('.'); if (parts.length !== 3) return null; const base = parts[0] + '.' + parts[1]; const exp = crypto.createHmac('sha256', _adsSecret()).update('social:' + base).digest('hex').slice(0, 24); if (exp !== parts[2]) return null; if (Date.now() - parseInt(parts[1], 36) > 900000) return null; return { clientId: parts[0] }; } catch (e) { return null; } }
async function exchangeSocialCode(code){
  const appId = _adsAppId(), appSecret = _adsSecret();
  const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, code, redirect_uri: SOCIAL_REDIRECT_URI });
  const r = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, { method: 'POST', body });
  const d = await r.json(); if (!d.access_token) throw new Error((d.error && d.error.message) || 'Meta não retornou token.');
  try { const e = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${d.access_token}`).then(x => x.json()); if (e.access_token) d.access_token = e.access_token; } catch (_) {}
  return d.access_token;
}
app.get('/api/social/meta/status', requireAuth, (req, res) => {
  try {
    const sm = (getTenant(req.clientId).db.getConfig() || {}).socialMeta;
    if (sm && sm.token) return res.json({ connected: true, pageName: sm.pageName || '', igUsername: sm.igUsername || '', at: sm.at || null });
  } catch (e) {}
  res.json({ connected: false });
});
app.get('/api/social/meta/connect', requireAuth, (req, res) => {
  const appId = _adsAppId(); if (!appId) return res.status(500).json({ error: 'META_APP_ID não configurado.' });
  const state = signSocialState(req.clientId);
  const url = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(SOCIAL_REDIRECT_URI)}&state=${encodeURIComponent(state)}&response_type=code&scope=${encodeURIComponent(SOCIAL_SCOPES)}`;
  res.json({ url });
});
app.get('/api/social/meta/callback', async (req, res) => {
  if (req.query.error) { console.log('[social-oauth] FB retornou erro:', JSON.stringify({ error: req.query.error, reason: req.query.error_reason, desc: req.query.error_description })); return res.send(adsPopupHtml('Conexão cancelada: ' + (req.query.error_description || req.query.error), false, 'social-meta-oauth')); }
  const parsed = verifySocialState(req.query.state);
  if (!parsed) return res.send(adsPopupHtml('Sessão inválida ou expirada. Tente conectar novamente.', false, 'social-meta-oauth'));
  try {
    const token = await exchangeSocialCode(req.query.code);
    const pages = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`).then(r => r.json());
    if (pages.error) throw new Error(pages.error.message || 'Falha ao listar Páginas.');
    const page = (pages.data || [])[0];
    if (!page) throw new Error('Nenhuma Página do Facebook encontrada nessa conta (é preciso ser admin de alguma Página).');
    const ig = page.instagram_business_account || null;
    writeTenantConfigKey(parsed.clientId, 'socialMeta', {
      token: page.access_token,
      pageId: page.id, pageName: page.name || '',
      igId: ig ? ig.id : '', igUsername: ig ? ig.username : '',
      at: Date.now()
    });
    res.send(adsPopupHtml('Conectado' + (page.name ? ' (' + page.name + (ig && ig.username ? ' + @' + ig.username : ' — sem Instagram vinculado') + ')' : '') + '! Pode fechar esta janela.', true, 'social-meta-oauth'));
  } catch (e) { res.send(adsPopupHtml('Falha ao conectar: ' + e.message, false, 'social-meta-oauth')); }
});
app.post('/api/social/meta/disconnect', requireAuth, (req, res) => {
  try { getTenant(req.clientId).db.updateConfig({ socialMeta: null }); } catch (e) {}
  res.json({ ok: true });
});
// Webhook exigido pela Meta pra ativar o produto Instagram Graph API/Messenger no App.
// Verificação (GET) segue o mesmo protocolo hub.challenge do webhook do WhatsApp. O POST só
// registra no log por enquanto — receber DM/comentário do Instagram na caixa de entrada do
// CRM é feature futura, ainda não construída.
const SOCIAL_VERIFY_TOKEN = process.env.SOCIAL_VERIFY_TOKEN || 'troque-este-token';
app.get('/api/social/meta/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === SOCIAL_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post('/api/social/meta/webhook', (req, res) => {
  try { console.log('[social-webhook]', JSON.stringify(req.body).slice(0, 500)); } catch (e) {}
  res.sendStatus(200);
});
// ── Instagram Business Login (produto novo da Meta, substituiu o Facebook Login pra
// permissões de Instagram — as antigas instagram_basic/instagram_manage_messages etc.
// foram descontinuadas em 27/01/2025). App ID/Secret e endpoints são próprios do Instagram,
// diferentes do app principal do Facebook. Grava no MESMO socialMeta que o fluxo antigo usava,
// pra não precisar mexer no resto do CRM (status/polling/UI continuam iguais).
const IG_LOGIN_REDIRECT_URI = process.env.IG_LOGIN_REDIRECT_URI || 'https://virandoachave.gestorwagnnerpires.com.br/api/social/instagram/callback';
const IG_LOGIN_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish';
function _igAppId(){ return process.env.IG_APP_ID || ''; }
function _igAppSecret(){ return process.env.IG_APP_SECRET || ''; }
app.get('/api/social/instagram/connect', requireAuth, (req, res) => {
  const appId = _igAppId(); if (!appId) return res.status(500).json({ error: 'IG_APP_ID não configurado.' });
  const state = signSocialState(req.clientId);
  const url = `https://www.instagram.com/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(IG_LOGIN_REDIRECT_URI)}&state=${encodeURIComponent(state)}&response_type=code&scope=${encodeURIComponent(IG_LOGIN_SCOPES)}`;
  res.json({ url });
});
app.get('/api/social/instagram/callback', async (req, res) => {
  if (req.query.error) return res.send(adsPopupHtml('Conexão cancelada: ' + (req.query.error_description || req.query.error), false, 'social-meta-oauth'));
  const parsed = verifySocialState(req.query.state);
  if (!parsed) return res.send(adsPopupHtml('Sessão inválida ou expirada. Tente conectar novamente.', false, 'social-meta-oauth'));
  try {
    const appId = _igAppId(), appSecret = _igAppSecret();
    const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: IG_LOGIN_REDIRECT_URI, code: req.query.code });
    const shortR = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body }).then(r => r.json());
    if (!shortR.access_token) throw new Error(shortR.error_message || 'Instagram não retornou token.');
    const longR = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortR.access_token)}`).then(r => r.json());
    const token = longR.access_token || shortR.access_token;
    const me = await fetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`).then(r => r.json());
    if (me.error) throw new Error(me.error.message || 'Falha ao buscar conta do Instagram.');
    writeTenantConfigKey(parsed.clientId, 'socialMeta', {
      token, pageId: '', pageName: '',
      igId: me.user_id || '', igUsername: me.username || '',
      at: Date.now(), via: 'instagram_login'
    });
    res.send(adsPopupHtml('Conectado' + (me.username ? ' (@' + me.username + ')' : '') + '! Pode fechar esta janela.', true, 'social-meta-oauth'));
  } catch (e) { res.send(adsPopupHtml('Falha ao conectar: ' + e.message, false, 'social-meta-oauth')); }
});
app.get('/api/ads/meta/status', requireAuth, (req, res) => {
  try { const am = (getTenant(req.clientId).db.getConfig() || {}).adsMeta; if (am && am.token) return res.json({ connected: true, name: am.name || '', at: am.at || null }); } catch (e) {}
  if (req.clientId === 'virandoachave' && loadMetaToken()) return res.json({ connected: true, name: 'Conta da agência', central: true });
  res.json({ connected: false });
});
app.get('/api/ads/meta/connect', requireAuth, (req, res) => {
  const appId = _adsAppId(); if (!appId) return res.status(500).json({ error: 'META_APP_ID não configurado.' });
  const state = signAdsState(req.clientId);
  const url = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(ADS_REDIRECT_URI)}&state=${encodeURIComponent(state)}&response_type=code&scope=${encodeURIComponent('ads_read,ads_management,business_management,pages_show_list')}`;
  res.json({ url });
});
function writeTenantConfigKey(clientId, key, value){
  const Database = require('better-sqlite3');
  const safe = String(clientId).replace(/[^a-z0-9_-]/gi, '');
  const dbPath = path.join(path.dirname(DATA_DIR), safe, 'data', safe, 'db.sqlite3');
  const db = new Database(dbPath, { fileMustExist: true });
  try { db.pragma('busy_timeout = 5000'); const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'); stmt.run(key, JSON.stringify(value)); stmt.run('updatedAt', JSON.stringify(Date.now())); } finally { db.close(); }
}
app.get('/api/ads/meta/callback', async (req, res) => {
  if (req.query.error) { console.log('[ads-oauth] FB retornou erro:', JSON.stringify({ error: req.query.error, reason: req.query.error_reason, desc: req.query.error_description })); return res.send(adsPopupHtml('Conexão cancelada: ' + (req.query.error_description || req.query.error), false)); }
  const parsed = verifyAdsState(req.query.state);
  if (!parsed) return res.send(adsPopupHtml('Sessão inválida ou expirada. Tente conectar novamente.', false));
  try {
    const token = await exchangeAdsCode(req.query.code);
    let name = ''; try { const me = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me?fields=name&access_token=${encodeURIComponent(token)}`).then(r => r.json()); name = me.name || ''; } catch (_) {}
    writeTenantConfigKey(parsed.clientId, 'adsMeta', { token, name, at: Date.now() });
    res.send(adsPopupHtml('Conta conectada' + (name ? ' (' + name + ')' : '') + '! Pode fechar esta janela.', true));
  } catch (e) { res.send(adsPopupHtml('Falha ao conectar: ' + e.message, false)); }
});
app.post('/api/ads/meta/disconnect', requireAuth, (req, res) => {
  try { getTenant(req.clientId).db.updateConfig({ adsMeta: null }); } catch (e) {}
  res.json({ ok: true });
});

// ═══════════════ Anúncios — Subir criativo / criar anúncio (Meta) ═══════════════
// Requer token com escopo ads_management (contas conectadas antes de 22/09/2026 só tinham
// ads_read — precisam reconectar em Anúncios pra ganhar permissão de escrita).
function _adsAccountGuard(req, accountRaw) {
  const accountId = String(accountRaw || '').replace(/\D/g, '');
  if (!accountId) throw new Error('Informe a conta de anúncios.');
  const allow = tenantAllowedAccounts(req);
  if (allow && allow.indexOf(accountId) < 0) { const e = new Error('Conta não permitida para este cliente.'); e.status = 403; throw e; }
  return accountId;
}
app.get('/api/ads/meta/pages', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  try {
    const data = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/me/accounts?fields=id,name&limit=200&access_token=${encodeURIComponent(token)}`);
    res.json({ pages: (data.data || []).map(p => ({ id: p.id, name: p.name })) });
  } catch (e) { res.status(502).json({ error: e.message + ' — reconecte a conta em Anúncios pra pedir a permissão pages_show_list.' }); }
});
// Página padrão da conta de anúncios — pra pré-selecionar no upload de criativo em vez
// de obrigar escolher entre 100+ páginas toda vez. Tenta a Página associada à conta
// (promote_pages); se vazio, olha o page_id do anúncio mais recente da conta.
app.get('/api/ads/meta/account-page', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  try {
    const accountId = _adsAccountGuard(req, req.query.account);
    try {
      const pp = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}/promote_pages?fields=id,name&limit=5&access_token=${encodeURIComponent(token)}`);
      const first = (pp.data || [])[0];
      if (first) return res.json({ page: { id: first.id, name: first.name } });
    } catch (e) { /* segue pro fallback */ }
    try {
      const ads = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}/ads?fields=creative{effective_object_story_id}&limit=10&access_token=${encodeURIComponent(token)}`);
      for (const ad of (ads.data || [])) {
        const storyId = ad.creative && ad.creative.effective_object_story_id;
        if (storyId && storyId.includes('_')) { const pageId = storyId.split('_')[0]; return res.json({ page: { id: pageId, name: '' } }); }
      }
    } catch (e) { /* sem sorte */ }
    res.json({ page: null });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/ads/meta/campaigns', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  try {
    const accountId = _adsAccountGuard(req, req.query.account);
    const camps = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}/campaigns?fields=id,name,status,effective_status&limit=200&filtering=${encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]))}&access_token=${encodeURIComponent(token)}`);
    const list = camps.data || [];
    const withAdsets = await Promise.all(list.map(async c => {
      try {
        const as = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${c.id}/adsets?fields=id,name,status,effective_status&limit=200&access_token=${encodeURIComponent(token)}`);
        return { id: c.id, name: c.name, status: c.effective_status || c.status, adsets: (as.data || []).map(a => ({ id: a.id, name: a.name, status: a.effective_status || a.status })) };
      } catch (e) { return { id: c.id, name: c.name, status: c.effective_status || c.status, adsets: [] }; }
    }));
    res.json({ campaigns: withAdsets });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
// Sobe imagem/vídeo pra biblioteca da conta + cria o criativo + cria o anúncio (PAUSADO,
// pra revisar antes de ativar). Um POST só, multipart (arquivo + campos).
// Sobe 1 arquivo (imagem/vídeo) + cria o criativo + cria o anúncio (PAUSADO). Compartilhado
// pelo upload único e pelo upload em lote (bulk-ads) — mesma lógica, sem duplicar.
async function graphFormPostWithToken(token, pathStr, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(x => body.append(k, (x && typeof x === 'object') ? JSON.stringify(x) : String(x)));
    else if (typeof v === 'object') body.append(k, JSON.stringify(v));
    else body.append(k, String(v));
  }
  const r = await fetch(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${pathStr}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch (e) { j = { raw: text }; }
  if (!r.ok) {
    const err = (j && j.error) || {};
    const detail = err.error_user_msg || (err.error_data && err.error_data.details) || '';
    const parts = [err.error_user_title, err.message, detail].filter(Boolean);
    throw new Error(parts.length ? parts.join(' — ') : ((j && j.raw) || `Erro HTTP ${r.status}`));
  }
  return j;
}
// Monta o page_welcome_message (doc oficial: developers.facebook.com/docs/marketing-api/
// ad-creative/messaging-ads/click-to-whatsapp/) — a "mensagem de boas-vindas"/"modelo de
// conversa" que aparece quando alguem clica no anuncio de WhatsApp e abre o chat.
function buildWelcomeMessage(wm) {
  if (!wm || !wm.greeting) return null;
  const base = { type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text' };
  if (wm.mode === 'icebreakers') {
    const breakers = (wm.icebreakers || []).filter(Boolean).slice(0, 4).map(t => ({ title: String(t).slice(0, 80) }));
    if (!breakers.length) return null;
    return Object.assign({}, base, { text_format: { customer_action_type: 'ice_breakers', message: { text: String(wm.greeting).slice(0, 500), ice_breakers: breakers } } });
  }
  if (!wm.autofillText) return null;
  return Object.assign({}, base, { text_format: { customer_action_type: 'autofill_message', message: { text: String(wm.greeting).slice(0, 500), autofill_message: { content: String(wm.autofillText).slice(0, 500) } } } });
}
async function uploadOneAdCreative(token, accountId, opts) {
  // A Meta exige algum link pro tipo de criativo de imagem/video (link_data/video_data) —
  // sem isso a criacao do anuncio falha. Se o usuario deixou em branco, cai na propria
  // Pagina do Facebook como destino (nunca bloqueia o fluxo por falta de link).
  const effectiveLink = opts.linkUrl || (opts.pageId ? "https://www.facebook.com/" + opts.pageId : '');
  opts = Object.assign({}, opts, { linkUrl: effectiveLink });
  const isVideo = String(opts.fileMime || '').startsWith('video/');
  const form1 = new FormData();
  form1.append('source', new Blob([opts.fileBuf], { type: opts.fileMime || 'application/octet-stream' }), opts.fileName);
  let storySpec, mediaInfo;
  if (isVideo) {
    const up = await graphRequestWithToken(token, `/act_${accountId}/advideos`, { method: 'POST', formData: form1 });
    if (!up || !up.id) throw new Error('A Meta não retornou o id do vídeo enviado (' + opts.fileName + ').');
    const videoId = up.id;
    let statusNow = 'processing';
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const st = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`);
        statusNow = (st.status && st.status.video_status) || statusNow;
        if (statusNow === 'ready') break;
      } catch (e) { break; }
    }
    storySpec = { page_id: opts.pageId, video_data: {
      video_id: videoId,
      title: String(opts.headline || '').slice(0, 255) || undefined,
      link_description: String(opts.description || '').slice(0, 255) || undefined,
      message: String(opts.message || '').slice(0, 2000) || undefined,
      call_to_action: { type: String(opts.cta || 'LEARN_MORE'), value: opts.linkUrl ? { link: opts.linkUrl } : undefined },
      page_welcome_message: buildWelcomeMessage(opts.welcomeMessage) || undefined,
    } };
    mediaInfo = { type: 'video', id: videoId, status: statusNow };
  } else {
    const up = await graphRequestWithToken(token, `/act_${accountId}/adimages`, { method: 'POST', formData: form1 });
    const imgs = up && up.images ? Object.values(up.images) : [];
    const hash = imgs[0] && imgs[0].hash;
    if (!hash) throw new Error('A Meta não retornou o hash da imagem enviada (' + opts.fileName + ').');
    storySpec = { page_id: opts.pageId, link_data: {
      image_hash: hash,
      link: opts.linkUrl || undefined,
      message: String(opts.message || '').slice(0, 2000) || undefined,
      name: String(opts.headline || '').slice(0, 255) || undefined,
      description: String(opts.description || '').slice(0, 255) || undefined,
      call_to_action: { type: String(opts.cta || 'LEARN_MORE'), value: opts.linkUrl ? { link: opts.linkUrl } : undefined },
      page_welcome_message: buildWelcomeMessage(opts.welcomeMessage) || undefined,
    } };
    mediaInfo = { type: 'image', hash };
  }
  const creative = await graphRequestWithToken(token, `/act_${accountId}/adcreatives`, { method: 'POST', json: { name: opts.adName || ('Criativo ' + new Date().toLocaleDateString('pt-BR')), object_story_spec: storySpec } });
  if (!creative || !creative.id) throw new Error('A Meta não retornou o id do criativo (' + opts.fileName + ').');
  const ad = await graphRequestWithToken(token, `/act_${accountId}/ads`, { method: 'POST', json: {
    name: opts.adName || ('Anúncio ' + new Date().toLocaleDateString('pt-BR')),
    adset_id: opts.adsetId,
    creative: { creative_id: creative.id },
    status: 'PAUSED',
  } });
  if (!ad || !ad.id) throw new Error('A Meta não retornou o id do anúncio (' + opts.fileName + ').');
  return { creativeId: creative.id, adId: ad.id, media: mediaInfo };
}
app.post('/api/ads/meta/ad', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  const fields = {};
  let fileBuf = null, fileName = '', fileMime = '';
  bb.on('field', (name, value) => { fields[name] = value; });
  bb.on('file', (name, stream, info) => {
    fileName = info.filename || 'arquivo'; fileMime = info.mimeType || '';
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => { fileBuf = Buffer.concat(chunks); });
  });
  bb.on('finish', async () => {
    try {
      if (!fileBuf) return res.status(400).json({ error: 'Envie um arquivo de imagem ou vídeo.' });
      const accountId = _adsAccountGuard(req, fields.account);
      const pageId = String(fields.page_id || '').trim();
      const adsetId = String(fields.adset_id || '').trim();
      const linkUrl = String(fields.link_url || '').trim();
      if (!pageId) return res.status(400).json({ error: 'Escolha a Página.' });
      if (!adsetId) return res.status(400).json({ error: 'Escolha o conjunto de anúncios.' });
      let welcomeMessage = null;
      try { welcomeMessage = fields.welcome_greeting ? { greeting: fields.welcome_greeting, mode: fields.welcome_mode, autofillText: fields.welcome_autofill, icebreakers: JSON.parse(fields.welcome_icebreakers || '[]') } : null; } catch (e) {}
      const result = await uploadOneAdCreative(token, accountId, {
        fileBuf, fileName, fileMime, pageId, adsetId, linkUrl,
        headline: fields.headline, description: fields.description, message: fields.message, cta: fields.cta,
        adName: fields.ad_name, welcomeMessage,
      });
      res.json({ ok: true, creativeId: result.creativeId, adId: result.adId, media: result.media, status: 'PAUSED' });
    } catch (e) {
      console.error('[ads-creative] falha:', e.message);
      res.status(502).json({ error: e.message });
    }
  });
  bb.on('error', e => res.status(500).json({ error: e.message }));
  req.pipe(bb);
});

// Cria campanha nova (PAUSADA). objective: MESSAGES (Conversas/WhatsApp) | LEADS (Cadastro) | TRAFFIC.
app.post('/api/ads/meta/campaign', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  try {
    const accountId = _adsAccountGuard(req, req.body && req.body.account);
    const name = String(req.body && req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome da campanha.' });
    const OBJ_MAP = { MESSAGES: 'OUTCOME_ENGAGEMENT', LEADS: 'OUTCOME_LEADS', TRAFFIC: 'OUTCOME_TRAFFIC', ENGAGEMENT: 'OUTCOME_ENGAGEMENT', AWARENESS: 'OUTCOME_AWARENESS' };
    const objective = OBJ_MAP[String(req.body && req.body.objective || '').toUpperCase()] || OBJ_MAP.TRAFFIC;
    const campBody = {
      name, objective, status: 'PAUSED', special_ad_categories: '[]',
      // A Meta exige esse campo na CAMPANHA (não no conjunto — confirmado testando contra
      // a API de verdade). 'false' = conjuntos desta campanha não compartilham 20% de budget.
      is_adset_budget_sharing_enabled: 'false',
    };
    // Orçamento na CAMPANHA (CBO) em vez de no conjunto — opcional, só quando o front escolhe isso.
    // Com orçamento na campanha, a estratégia de lance também é da campanha (não do conjunto).
    const campBudgetReais = Number(req.body && req.body.daily_budget) || 0;
    if (campBudgetReais > 0) { campBody.daily_budget = Math.round(campBudgetReais * 100); campBody.bid_strategy = 'LOWEST_COST_WITHOUT_CAP'; }
    const camp = await graphFormPostWithToken(token, `act_${accountId}/campaigns`, campBody);
    if (!camp || !camp.id) throw new Error('A Meta não retornou o id da campanha.');
    res.json({ ok: true, campaignId: camp.id });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
// Cria conjunto de anúncios novo (PAUSADO) dentro de uma campanha (existente ou recém-criada).
// Campos variam por objetivo: Mensagens/WhatsApp precisa da Página + destination_type WHATSAPP;
// Cadastro de Leads precisa da Página (LEAD_GENERATION); Tráfego só precisa do link (LINK_CLICKS).
// Busca de localização (cidade/região/país) pra targeting — pra digitar e escolher em vez
// de decorar o "key" interno da Meta. Edge global /search, não depende de conta específica.
app.get('/api/ads/meta/geo-search', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
    const data = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/search?type=adgeolocation&q=${encodeURIComponent(q)}&location_types=${encodeURIComponent(JSON.stringify(['country', 'region', 'city']))}&limit=12&access_token=${encodeURIComponent(token)}`);
    const results = (data.data || []).map(g => ({ key: g.key, name: g.name, type: g.type, region: g.region || '', countryCode: g.country_code || '' }));
    res.json({ results });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Lista os números de WhatsApp que a agência enxerga (todas as WABAs das Businesses que o
// token administra ou que compartilharam acesso) — pra ESCOLHER na hora de criar o conjunto
// em vez de digitar. IMPORTANTE: isso NÃO filtra só os números "vinculados" a UMA conta de
// anúncios específica — a Meta não documenta nenhum endpoint pra descobrir isso (confirmado
// checando a doc oficial de Click-to-WhatsApp + issue aberta no SDK oficial sem solução). Então
// a lista pode conter número que a Meta recusa na hora de criar (erro "not linked", já traduzido
// no /api/ads/meta/adset) — mas evita erro de digitação, que era o problema mais comum.
const _waNumbersCacheByBiz = new Map(); // bizId -> { at, list }
app.get('/api/ads/meta/whatsapp-numbers', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  try {
    const accountId = _adsAccountGuard(req, req.query.account);
    const q = String(req.query.q || '').trim().toLowerCase();
    const now = Date.now();
    // /me/businesses costuma vir vazio (o token não é "dono" direto da Business, só tem acesso
    // via contas de anúncio específicas) — confirmado testando de verdade. Por isso a Business
    // vem da PRÓPRIA conta de anúncios escolhida (act_<id>?fields=business), não de /me/businesses.
    const cached = _waNumbersCacheByBiz.get(accountId);
    if (!cached || (now - cached.at) > 10 * 60 * 1000) {
      const acctData = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}?fields=business&access_token=${encodeURIComponent(token)}`);
      const bizId = acctData.business && acctData.business.id;
      const wabaMap = new Map(); // id -> name
      if (bizId) {
        for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
          try {
            const d = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${bizId}/${edge}?fields=id,name&limit=200&access_token=${encodeURIComponent(token)}`);
            for (const w of (d.data || [])) if (!wabaMap.has(w.id)) wabaMap.set(w.id, w.name || '');
          } catch (e) { /* ignora aresta sem permissão */ }
        }
      }
      const list = [];
      for (const [wabaId, wabaName] of wabaMap.entries()) {
        try {
          const d = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=50&access_token=${encodeURIComponent(token)}`);
          for (const ph of (d.data || [])) {
            list.push({
              wabaId, wabaName,
              phoneId: ph.id,
              display: ph.display_phone_number || '',
              verifiedName: ph.verified_name || '',
              digits: String(ph.display_phone_number || '').replace(/\D/g, ''),
            });
          }
        } catch (e) { /* WABA sem número ou sem permissão — ignora */ }
      }
      _waNumbersCacheByBiz.set(accountId, { at: now, list });
    }
    let results = _waNumbersCacheByBiz.get(accountId).list;
    if (q) results = results.filter(n => (n.display + ' ' + n.verifiedName + ' ' + n.wabaName).toLowerCase().includes(q));
    res.json({ numbers: results.slice(0, 60) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/ads/meta/adset', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  try {
    const accountId = _adsAccountGuard(req, req.body && req.body.account);
    const name = String(req.body && req.body.name || '').trim();
    const campaignId = String(req.body && req.body.campaign_id || '').trim();
    const pageId = String(req.body && req.body.page_id || '').trim();
    const dailyBudgetReais = Number(req.body && req.body.daily_budget) || 0;
    const budgetLevel = String(req.body && req.body.budget_level || 'adset');
    if (!name) return res.status(400).json({ error: 'Informe o nome do conjunto.' });
    if (!campaignId) return res.status(400).json({ error: 'Escolha ou crie a campanha primeiro.' });
    if (budgetLevel === 'adset' && dailyBudgetReais <= 0) return res.status(400).json({ error: 'Informe o orçamento diário.' });
    const objectiveKey = String(req.body && req.body.objective || '').toUpperCase();
    // Localização: geo.included/geo.excluded = [{key,type}], type = country|region|city.
    // Sem nenhuma incluída, cai no padrão de sempre (Brasil todo).
    const geoIn = (req.body && req.body.geo && Array.isArray(req.body.geo.included)) ? req.body.geo.included : [];
    const geoOut = (req.body && req.body.geo && Array.isArray(req.body.geo.excluded)) ? req.body.geo.excluded : [];
    function bucketGeo(list) {
      const out = { countries: [], regions: [], cities: [] };
      for (const g of list) {
        if (!g || !g.key) continue;
        if (g.type === 'country') out.countries.push(g.key);
        else if (g.type === 'region') out.regions.push({ key: g.key });
        else if (g.type === 'city') {
          const cityEntry = { key: g.key };
          // radiusKm vindo do front: numero = raio em km; ausente/0/null = so a cidade
          // (a Meta trata cidade sem raio como o limite administrativo dela, nao um circulo).
          const radiusKm = Number(g.radiusKm);
          if (radiusKm > 0) { cityEntry.radius = radiusKm; cityEntry.distance_unit = 'kilometer'; }
          out.cities.push(cityEntry);
        }
      }
      const clean = {};
      if (out.countries.length) clean.countries = out.countries;
      if (out.regions.length) clean.regions = out.regions;
      if (out.cities.length) clean.cities = out.cities;
      return clean;
    }
    const geoLocations = geoIn.length ? bucketGeo(geoIn) : { countries: ['BR'] };
    const excludedGeoLocations = geoOut.length ? bucketGeo(geoOut) : null;
    const targeting = { geo_locations: geoLocations };
    if (excludedGeoLocations && Object.keys(excludedGeoLocations).length) targeting.excluded_geo_locations = excludedGeoLocations;
    // Posicionamento: 'auto' (padrão, Advantage+) omite os campos e deixa a Meta escolher;
    // 'manual' fixa as plataformas escolhidas (facebook/instagram/messenger/audience_network).
    const placementMode = (req.body && req.body.placement && req.body.placement.mode) || 'auto';
    if (placementMode === 'manual') {
      const platforms = (req.body.placement.platforms || []).filter(p => ['facebook', 'instagram', 'messenger', 'audience_network'].includes(p));
      if (platforms.length) targeting.publisher_platforms = platforms;
    } else if (placementMode === 'feed' || placementMode === 'story') {
      // Modo Feed+Stories pareados: cada par vira 2 conjuntos (um só-Feed, um só-Stories),
      // porque posicionamento é configurado no CONJUNTO, não no anúncio individual.
      targeting.publisher_platforms = ['facebook', 'instagram'];
      targeting.facebook_positions = [placementMode === 'feed' ? 'feed' : 'story'];
      targeting.instagram_positions = [placementMode === 'feed' ? 'stream' : 'story'];
    }
    const body = {
      name, campaign_id: campaignId, status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      // Sem valor de lance manual nem meta de ROAS — deixa a Meta escolher o lance automatico
      // (mesma estrategia que a outra feature de criar campanha ja usa com sucesso).
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting,
    };
    // Orçamento no CONJUNTO (padrão) — exige is_adset_budget_sharing_enabled (a Meta quer a
    // string 'false', não o booleano). Orçamento na CAMPANHA (CBO) — o conjunto não leva
    // nenhum dos dois campos, o dinheiro já foi definido na campanha.
    if (budgetLevel === 'adset') {
      body.daily_budget = Math.round(dailyBudgetReais * 100);
    }
    if (objectiveKey === 'MESSAGES') {
      if (!pageId) return res.status(400).json({ error: 'Escolha a Página (necessária pro objetivo Mensagens/WhatsApp).' });
      body.optimization_goal = 'CONVERSATIONS';
      body.destination_type = 'WHATSAPP';
      body.promoted_object = { page_id: pageId };
      // Opcional: cliente com MAIS de 1 número de WhatsApp conectado — escolhe qual recebe as
      // conversas do anúncio (senão a Meta usa o número padrão da Página, que pode ser o errado).
      // Só funciona se esse número já estiver "vinculado" à conta de anúncios (Configurações do
      // Negócio → Contas do WhatsApp) — confirmado via teste real: número não vinculado dá erro
      // "This WhatsApp phone number is not linked to your account" (traduzido abaixo).
      const waNum = String(req.body && req.body.whatsapp_phone_number || '').replace(/\D/g, '');
      if (waNum) body.promoted_object.whatsapp_phone_number = waNum;
    } else if (objectiveKey === 'LEADS') {
      if (!pageId) return res.status(400).json({ error: 'Escolha a Página (necessária pro objetivo Cadastro de Leads).' });
      body.optimization_goal = 'LEAD_GENERATION';
      body.promoted_object = { page_id: pageId };
    } else if (objectiveKey === 'ENGAGEMENT') {
      body.optimization_goal = 'POST_ENGAGEMENT';
    } else if (objectiveKey === 'AWARENESS') {
      body.optimization_goal = 'REACH';
    } else {
      body.optimization_goal = 'LINK_CLICKS';
    }
    const adset = await graphFormPostWithToken(token, `act_${accountId}/adsets`, body);
    if (!adset || !adset.id) throw new Error('A Meta não retornou o id do conjunto.');
    res.json({ ok: true, adsetId: adset.id });
  } catch (e) {
    let msg = e.message || '';
    if (/not linked to your account/i.test(msg)) msg = 'Esse número de WhatsApp ainda não está vinculado a esta conta de anúncios. No Gerenciador de Negócios → Contas → Contas do WhatsApp, conecte esse número a esta conta de anúncios primeiro (ou deixe o campo em branco pra usar o número padrão da Página).';
    res.status(e.status || 502).json({ error: msg });
  }
});
// Sobe VÁRIOS criativos de uma vez (até 15 arquivos), um anúncio PAUSADO por arquivo, todos
// no mesmo conjunto — pro fluxo rápido de "campanha nova + conjunto novo + N criativos".
app.post('/api/ads/meta/bulk-ads', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES, files: 15 } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  const fields = {};
  const files = [];
  bb.on('field', (name, value) => { fields[name] = value; });
  bb.on('file', (name, stream, info) => {
    const entry = { fileName: info.filename || 'arquivo', fileMime: info.mimeType || '', chunks: [] };
    files.push(entry);
    stream.on('data', c => entry.chunks.push(c));
  });
  bb.on('finish', async () => {
    try {
      if (!files.length) return res.status(400).json({ error: 'Envie ao menos 1 arquivo.' });
      const accountId = _adsAccountGuard(req, fields.account);
      const pageId = String(fields.page_id || '').trim();
      const adsetId = String(fields.adset_id || '').trim();
      const linkUrl = String(fields.link_url || '').trim();
      if (!pageId) return res.status(400).json({ error: 'Escolha a Página.' });
      if (!adsetId) return res.status(400).json({ error: 'Escolha o conjunto de anúncios.' });
      const baseName = String(fields.ad_name || 'Criativo').trim() || 'Criativo';
      const results = [];
      let idx = 0;
      for (const f of files) {
        idx++;
        try {
          const r = await uploadOneAdCreative(token, accountId, {
            fileBuf: Buffer.concat(f.chunks), fileName: f.fileName, fileMime: f.fileMime,
            pageId, adsetId, linkUrl,
            headline: fields.headline, description: fields.description, message: fields.message, cta: fields.cta,
            adName: files.length > 1 ? `${baseName} ${idx}` : baseName,
          });
          results.push({ fileName: f.fileName, ok: true, adId: r.adId, creativeId: r.creativeId, media: r.media });
        } catch (e) {
          results.push({ fileName: f.fileName, ok: false, error: e.message });
        }
      }
      const okCount = results.filter(r => r.ok).length;
      res.json({ ok: okCount > 0, total: files.length, okCount, results });
    } catch (e) {
      console.error('[ads-bulk-creative] falha:', e.message);
      res.status(502).json({ error: e.message });
    }
  });
  bb.on('error', e => res.status(500).json({ error: e.message }));
  req.pipe(bb);
});
// ═══════════════ Anúncios — Meta Ads report ═══════════════
function _metaFmtDate(d){ return d.toISOString().slice(0, 10); }
function metaRanges(preset){
  const DAY = 86400000;
  const now = new Date(); now.setHours(0, 0, 0, 0); const t = now.getTime();
  let cs, cu;
  switch (preset) {
    case 'today': cs = t; cu = t; break;
    case 'yesterday': cs = t - DAY; cu = t - DAY; break;
    case 'last_14d': cu = t - DAY; cs = t - 14 * DAY; break;
    case 'last_30d': cu = t - DAY; cs = t - 30 * DAY; break;
    case 'this_month': cs = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); cu = t - DAY; if (cu < cs) cu = cs; break;
    case 'last_month': cs = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(); cu = new Date(now.getFullYear(), now.getMonth(), 0).getTime(); break;
    case 'last_7d': default: cu = t - DAY; cs = t - 7 * DAY; break;
  }
  const len = Math.round((cu - cs) / DAY) + 1;
  const pu = cs - DAY, ps = cs - len * DAY;
  return { cur: { since: _metaFmtDate(new Date(cs)), until: _metaFmtDate(new Date(cu)) }, prev: { since: _metaFmtDate(new Date(ps)), until: _metaFmtDate(new Date(pu)) }, len };
}
function metaRangeFromExplicitDates(sinceRaw, untilRaw) {
  const since = String(sinceRaw || '').trim();
  const until = String(untilRaw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return null;
  const start = new Date(`${since}T12:00:00Z`);
  const end = new Date(`${until}T12:00:00Z`);
  if (start.toISOString().slice(0, 10) !== since || end.toISOString().slice(0, 10) !== until || end < start) return null;
  const DAY = 86400000;
  const len = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  if (len < 1 || len > 31) return null;
  const prevUntil = new Date(start.getTime() - DAY);
  const prevSince = new Date(prevUntil.getTime() - (len - 1) * DAY);
  return {
    cur: { since, until },
    prev: { since: _metaFmtDate(prevSince), until: _metaFmtDate(prevUntil) },
    len
  };
}
function reportRangeFromExplicitDates(sinceRaw, untilRaw, prevSinceRaw, prevUntilRaw) {
  const current = metaRangeFromExplicitDates(sinceRaw, untilRaw);
  if (!current) return null;
  const prevSince = String(prevSinceRaw || '').trim();
  const prevUntil = String(prevUntilRaw || '').trim();
  if (!prevSince && !prevUntil) return current;
  const previous = metaRangeFromExplicitDates(prevSince, prevUntil);
  return previous ? { ...current, prev: previous.cur } : current;
}
const META_ADS_GRAPH_API_VERSION = process.env.META_ADS_GRAPH_API_VERSION || GRAPH_API_VERSION || 'v22.0';
const META_INSIGHT_FIELDS = 'spend,impressions,clicks,inline_link_clicks,ctr,inline_link_click_ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type';
function _metaAct(row, type){ const a = (row.actions || []).find(x => x.action_type === type); return a ? (parseFloat(a.value) || 0) : 0; }
function _metaKpis(row){
  row = row || {};
  const spend = +(row.spend || 0), impressions = +(row.impressions || 0), clicks = +(row.clicks || 0), reach = +(row.reach || 0), frequency = +(row.frequency || 0);
  const convs = _metaAct(row, 'onsite_conversion.messaging_conversation_started_7d');
  const formLeads = _metaAct(row, 'lead');
  const leads = formLeads || _metaAct(row, 'onsite_conversion.lead_grouped');
  const linkClicks = +(row.inline_link_clicks || 0) || _metaAct(row, 'link_click');
  const ctr = +(row.inline_link_click_ctr || row.ctr || 0), cpc = +(row.cpc || 0), cpm = +(row.cpm || 0);
  // Métricas de e-commerce (lojas com pixel/catálogo) — cliente pede "vendas, carrinho
  // abandonado, iniciação de checkout" em vez de "conversas". Actions do pixel vêm com
  // prefixo offsite_conversion.fb_pixel_* OU sem prefixo (purchase/add_to_cart/initiate_checkout)
  // dependendo de como foi configurado — soma os dois formatos pra não perder nada.
  const purchases = _metaAct(row, 'purchase') || _metaAct(row, 'offsite_conversion.fb_pixel_purchase') || _metaAct(row, 'omni_purchase');
  const addToCart = _metaAct(row, 'add_to_cart') || _metaAct(row, 'offsite_conversion.fb_pixel_add_to_cart') || _metaAct(row, 'omni_add_to_cart');
  const initiateCheckout = _metaAct(row, 'initiate_checkout') || _metaAct(row, 'offsite_conversion.fb_pixel_initiate_checkout') || _metaAct(row, 'omni_initiated_checkout');
  return { spend, impressions, clicks, reach, frequency, ctr, cpc, cpm, convs, leads, formLeads, linkClicks, purchases, addToCart, initiateCheckout, cpConv: convs > 0 ? spend / convs : 0, cpl: leads > 0 ? spend / leads : 0, cpFormLead: formLeads > 0 ? spend / formLeads : 0, cpPurchase: purchases > 0 ? spend / purchases : 0 };
}
function _metaBreakdownRows(list, dimension, sortByLabel){
  const rows = (list || []).map(row => {
    const k = _metaKpis(row);
    return {
      name: String(row[dimension] || 'Não informado'), spend: k.spend, impressions: k.impressions,
      reach: k.reach, clicks: k.clicks, ctr: k.ctr, cpc: k.cpc, cpm: k.cpm
    };
  });
  return sortByLabel
    ? rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }))
    : rows.sort((a, b) => b.impressions - a.impressions);
}
function _metaConversions(row){
  return (row && row.actions || []).map(item => {
    const cost = ((row.cost_per_action_type || []).find(costItem => costItem.action_type === item.action_type) || {}).value;
    return { type: String(item.action_type || ''), total: +(item.value || 0), cost: +(cost || 0) };
  })
    .filter(item => item.type && item.total > 0)
    .sort((a, b) => b.total - a.total);
}
async function _metaGet(url){ const d = await fetch(url).then(r => r.json()); if (d.error) throw new Error(d.error.message); return d; }
async function _metaGetAll(url, maxPages = 5){
  let next = url, page = 0, data = [];
  while (next && page < maxPages) {
    const result = await _metaGet(next);
    data = data.concat(result.data || []);
    next = result.paging && result.paging.next;
    page++;
  }
  return { data };
}
async function _metaGetSafe(url){ try { return await _metaGet(url); } catch (_) { return { data: [] }; } }
function _metaInsUrl(accountId, token, range, extra){
  const p = new URLSearchParams({ access_token: token, time_range: JSON.stringify({ since: range.since, until: range.until }), fields: META_INSIGHT_FIELDS });
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return `https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}/insights?` + p.toString();
}
async function _metaAdCreativeThumbnail(ad, token){
  if (!ad || !ad.id) return ad;
  try {
    const data = await _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/${encodeURIComponent(ad.id)}?fields=creative{thumbnail_url,image_url}&access_token=${encodeURIComponent(token)}`);
    const creative = data && data.creative;
    return { ...ad, thumbnail: creative && (creative.thumbnail_url || creative.image_url) || '' };
  } catch (_) { return ad; }
}
// ─── Analytics do site / mapa de calor ───────────────────────────────────────
function heatmapDefaults(t) {
  const cfg=t.db.getConfig()||{}, old=cfg.webAnalytics||{};
  if (!old.siteKey) {
    const created={ enabled:true,siteKey:'vac_'+crypto.randomBytes(18).toString('hex'),domains:[],retentionDays:90,requireConsent:true,maskText:true,createdAt:Date.now() };
    t.db.updateConfig({webAnalytics:created}); return created;
  }
  return Object.assign({enabled:true,domains:[],retentionDays:90,requireConsent:true,maskText:true},old);
}
function heatOriginAllowed(req,cfg){
  const raw=String(req.headers.origin||req.headers.referer||'');
  if(!raw) return true;
  let host=''; try{host=new URL(raw).hostname.toLowerCase();}catch{return false;}
  const domains=(cfg.domains||[]).map(x=>String(x).toLowerCase().replace(/^https?:\/\//,'').split('/')[0]);
  return !domains.length||domains.some(d=>host===d||host.endsWith('.'+d));
}
app.get('/analytics.js',(req,res)=>{
  res.type('application/javascript').set('Cache-Control','public,max-age=300').send(`(()=>{if(window.__vacAnalytics)return;window.__vacAnalytics=1;const S=document.currentScript,K=S&&((new URL(S.src)).searchParams.get('key')||S.dataset.key),END=S?new URL('/api/analytics/collect',S.src).href:'';if(!K||!END)return;let consent=(S.dataset.consent||'required')!=='required'||localStorage.getItem('vac_analytics_consent')==='granted'||document.cookie.includes('vac_analytics_consent=granted');let q=[],started=Date.now(),lastMove=0,maxScroll=0;const rid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2),vid=localStorage.getItem('vac_vid')||rid(),sid=sessionStorage.getItem('vac_sid')||rid();try{localStorage.setItem('vac_vid',vid);sessionStorage.setItem('vac_sid',sid)}catch{}let pid=rid(),pstart=Date.now();const device=/Mobi|Android/i.test(navigator.userAgent)?'mobile':(/Tablet|iPad/i.test(navigator.userAgent)?'tablet':'desktop');const browser=/Edg\//.test(navigator.userAgent)?'Edge':/Firefox\//.test(navigator.userAgent)?'Firefox':/Chrome\//.test(navigator.userAgent)?'Chrome':/Safari\//.test(navigator.userAgent)?'Safari':'Outro';const qp=new URLSearchParams(location.search);function target(el){if(!el||!el.closest)return'';el=el.closest('a,button,[role=button],input,form')||el;let s=(el.id?'#'+el.id:el.tagName.toLowerCase())+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'');return s.slice(0,150)}function snap(){try{let c=document.documentElement.cloneNode(true);c.querySelectorAll('script,noscript,iframe,object,embed').forEach(x=>x.remove());c.querySelectorAll('input,textarea,select,[contenteditable]').forEach(x=>{x.removeAttribute('value');x.textContent='••••'});c.querySelectorAll('[data-private],[data-heatmap-mask],.private').forEach(x=>x.textContent='••••');let h='<!doctype html>'+c.outerHTML;return h.length<250000?h:null}catch{return null}}function page(){return{id:pid,url:location.href,path:location.pathname,title:document.title,referrer:document.referrer,startedAt:pstart,duration:Date.now()-pstart,viewportW:innerWidth,viewportH:innerHeight,documentH:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),maxScroll,snapshot:q.some(x=>x.type==='snapshot')?null:snap()}}function send(final){if(!consent||!q.length)return;let body=JSON.stringify({key:K,session:{id:sid,visitorId:vid,startedAt:started,device,browser,utmSource:qp.get('utm_source')||'',utmMedium:qp.get('utm_medium')||'',utmCampaign:qp.get('utm_campaign')||''},pageview:page(),events:q.splice(0,100)});if(final&&navigator.sendBeacon)navigator.sendBeacon(END,new Blob([body],{type:'application/json'}));else fetch(END,{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{})}function ev(type,o={}){if(!consent)return;q.push(Object.assign({id:rid(),type,at:Date.now()},o));if(q.length>=20)send(false)}addEventListener('click',e=>{let x=e.pageX/Math.max(1,document.documentElement.scrollWidth),y=e.pageY/Math.max(1,document.documentElement.scrollHeight),el=e.target,t=target(el);ev('click',{x,y,target:t});let a=el.closest&&el.closest('a');if(a&&/^(https?:\/\/(wa\.me|api\.whatsapp)|tel:|mailto:)/i.test(a.href))ev('conversion',{name:'Clique '+a.protocol.replace(':','')})},true);addEventListener('submit',e=>ev('submit',{name:'Formulário enviado',target:target(e.target)}),true);addEventListener('scroll',()=>{let p=Math.round(100*(scrollY+innerHeight)/Math.max(innerHeight,document.documentElement.scrollHeight));if(p>maxScroll){maxScroll=Math.min(100,p);if(maxScroll%10<3)ev('scroll',{scroll:maxScroll})}},{passive:true});addEventListener('mousemove',e=>{if(Date.now()-lastMove<500)return;lastMove=Date.now();ev('mousemove',{x:e.pageX/Math.max(1,document.documentElement.scrollWidth),y:e.pageY/Math.max(1,document.documentElement.scrollHeight)})},{passive:true});addEventListener('pagehide',()=>send(true));addEventListener('visibilitychange',()=>{if(document.hidden)send(true)});setInterval(()=>send(false),5000);window.VACAnalytics={consent(v){consent=!!v;if(v)localStorage.setItem('vac_analytics_consent','granted')},track(name,value){ev('conversion',{name:String(name||'Conversão').slice(0,100),value:Number(value)||0})}};ev('snapshot')})();`);
});
app.options('/api/analytics/collect',(req,res)=>{res.set('Access-Control-Allow-Origin',req.headers.origin||'*').set('Access-Control-Allow-Headers','Content-Type').sendStatus(204);});
app.post('/api/analytics/collect',(req,res)=>{
  const id=ownClientId(); if(!id)return res.status(404).end(); const t=getTenant(id),cfg=heatmapDefaults(t),body=req.body||{};
  if(!cfg.enabled||String(body.key||'')!==cfg.siteKey||!heatOriginAllowed(req,cfg))return res.status(403).json({error:'not_allowed'});
  res.set('Access-Control-Allow-Origin',req.headers.origin||'*').set('Vary','Origin');
  try{const out=t.db.ingestWebAnalytics(body);const pv=body.pageview||{};if(!pv.snapshot&&pv.id&&pv.url){try{const pageUrl=new URL(String(pv.url)),originUrl=new URL(String(req.headers.origin||req.headers.referer||pv.url));if(pageUrl.protocol==='https:'&&pageUrl.hostname===originUrl.hostname){const ac=new AbortController();setTimeout(()=>ac.abort(),8000);fetch(pageUrl.href,{signal:ac.signal,headers:{'User-Agent':'VAC Analytics Snapshot/2.0'}}).then(r=>{if(!r.ok)throw new Error('status '+r.status);return r.text()}).then(html=>{html=String(html).slice(0,2000000).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,'').replace(/<meta\b[^>]*http-equiv[^>]*>/gi,'').replace(/(<input\b[^>]*?)\svalue=("[^"]*"|'[^']*')/gi,'$1');t.db.saveWebAnalyticsSnapshot(pv.id,html)}).catch(e=>console.warn('[analytics-snapshot]',e.message));}}catch(_){}}if(Math.random()<.01)t.db.purgeWebAnalytics(cfg.retentionDays); res.json(out);}catch(e){console.error('[analytics]',e.message);res.status(400).json({error:'invalid_batch'});}
});
app.get('/api/analytics/config',requireAuth,(req,res)=>{const t=getTenant(req.clientId),cfg=heatmapDefaults(t);const proto='https';res.json({...cfg,snippet:`<script async src="${proto}://${req.get('host')}/analytics.js?v=2&key=${cfg.siteKey}" data-consent="${cfg.requireConsent?'required':'none'}"></script>`});});
app.put('/api/analytics/config',requireAuth,requireFeature('config'),(req,res)=>{const t=getTenant(req.clientId),prev=heatmapDefaults(t),b=req.body||{};const cfg={...prev,enabled:b.enabled!==false,domains:Array.isArray(b.domains)?b.domains.map(x=>String(x).trim()).filter(Boolean).slice(0,30):prev.domains,retentionDays:[30,60,90,180,365].includes(Number(b.retentionDays))?Number(b.retentionDays):prev.retentionDays,requireConsent:b.requireConsent!==false,maskText:b.maskText!==false};if(b.regenerate)cfg.siteKey='vac_'+crypto.randomBytes(18).toString('hex');t.db.updateConfig({webAnalytics:cfg});t.db.purgeWebAnalytics(cfg.retentionDays);res.json(cfg);});
app.get('/api/analytics/report',requireAuth,(req,res)=>{const t=getTenant(req.clientId),days=Math.max(1,Math.min(365,Number(req.query.days)||30));let from=Date.now()-days*86400000,to=Date.now();if(/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from||''))){from=new Date(req.query.from+'T00:00:00').getTime();to=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to||''))?new Date(req.query.to+'T23:59:59.999').getTime():from+86400000-1;}res.json(t.db.webAnalyticsReport({from,to,path:String(req.query.path||'').slice(0,500)}));});
app.get('/api/analytics/sessions/:id',requireAuth,(req,res)=>res.json(getTenant(req.clientId).db.webAnalyticsSession(String(req.params.id).slice(0,100))));
app.get('/api/analytics/page-snapshot',requireAuth,(req,res)=>res.json(getTenant(req.clientId).db.webAnalyticsPageSnapshot(String(req.query.path||'').slice(0,500))||{}));
app.delete('/api/analytics/data',requireAuth,requireFeature('config'),(req,res)=>{getTenant(req.clientId).db.clearWebAnalytics();res.json({ok:true});});

app.get('/api/ads/report-brand', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig() || {};
  res.json(cfg.adsReportBrand && typeof cfg.adsReportBrand === 'object' ? cfg.adsReportBrand : {});
});
app.put('/api/ads/report-brand', requireAuth, requireFeature('config'), (req, res) => {
  const t = getTenant(req.clientId);
  const body = req.body || {};
  const previous = (t.db.getConfig() || {}).adsReportBrand || {};
  let logoUrl = String(body.logoUrl || '').trim().slice(0, 600);
  const uploadPrefix = `/uploads/${t.clientId}/`;
  if (logoUrl.startsWith(uploadPrefix)) {
    const source = path.join(t.uploadsDir, path.basename(logoUrl));
    if (fs.existsSync(source) && !path.basename(source).startsWith('brand-logo-')) {
      const targetName = `brand-logo-${Date.now()}${path.extname(source).slice(0, 12) || '.img'}`;
      const target = path.join(t.uploadsDir, targetName);
      fs.renameSync(source, target);
      logoUrl = uploadPrefix + targetName;
    }
  }
  if (previous.logoUrl && previous.logoUrl !== logoUrl && String(previous.logoUrl).startsWith(uploadPrefix)) {
    try { fs.unlinkSync(path.join(t.uploadsDir, path.basename(previous.logoUrl))); } catch (_) {}
  }
  const brand = {
    name: String(body.name || '').trim().slice(0, 100),
    title: String(body.title || '').trim().slice(0, 120),
    logoUrl
  };
  t.db.updateConfig({ adsReportBrand: brand });
  res.json(brand);
});
app.get('/api/ads/meta/report', requireAuth, async (req, res) => {
  const token = tenantMetaToken(req);
  if (!token) return res.status(401).json({ error: 'Conecte sua conta de anúncios (Facebook).', needConnect: true });
  const accountId = String(req.query.account || '').replace(/\D/g, '');
  if (!accountId) return res.status(400).json({ error: 'Informe a conta.' });
  const VALID = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'];
  const preset = VALID.includes(req.query.preset) ? req.query.preset : 'last_7d';
  const allow = tenantAllowedAccounts(req);
  if (allow && allow.indexOf(accountId) < 0) return res.status(403).json({ error: 'Conta não permitida para este cliente.' });
  const R = reportRangeFromExplicitDates(req.query.weeklySince, req.query.weeklyUntil, req.query.weeklyPrevSince, req.query.weeklyPrevUntil) || metaRanges(preset);
  try {
    const [meta, curD, prevD, daily, camps, adsets, ads, age, gender, platform, device, hourly] = await Promise.all([
      _metaGet(`https://graph.facebook.com/${META_ADS_GRAPH_API_VERSION}/act_${accountId}?fields=name,currency&access_token=${encodeURIComponent(token)}`),
      _metaGet(_metaInsUrl(accountId, token, R.cur)),
      _metaGet(_metaInsUrl(accountId, token, R.prev)),
      _metaGet(_metaInsUrl(accountId, token, R.cur, { time_increment: '1' })),
      _metaGetAll(_metaInsUrl(accountId, token, R.cur, { level: 'campaign', limit: '100', fields: `campaign_name,${META_INSIGHT_FIELDS}` })),
      _metaGetAll(_metaInsUrl(accountId, token, R.cur, { level: 'adset', limit: '100', fields: `adset_name,${META_INSIGHT_FIELDS}` })),
      _metaGetAll(_metaInsUrl(accountId, token, R.cur, { level: 'ad', limit: '100', fields: `ad_id,ad_name,${META_INSIGHT_FIELDS}` })),
      _metaGetSafe(_metaInsUrl(accountId, token, R.cur, { breakdowns: 'age' })),
      _metaGetSafe(_metaInsUrl(accountId, token, R.cur, { breakdowns: 'gender' })),
      _metaGetSafe(_metaInsUrl(accountId, token, R.cur, { breakdowns: 'publisher_platform' })),
      _metaGetSafe(_metaInsUrl(accountId, token, R.cur, { breakdowns: 'device_platform' })),
      _metaGetSafe(_metaInsUrl(accountId, token, R.cur, { breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone' })),
    ]);
    const cur = _metaKpis((curD.data || [])[0] || {});
    const prev = _metaKpis((prevD.data || [])[0] || {});
    const changes = {}; Object.keys(cur).forEach(k => { const c = cur[k], p = prev[k]; changes[k] = (p > 0) ? ((c - p) / p * 100) : (c > 0 ? 100 : 0); });
    const dailySpend = (daily.data || []).map(x => ({ date: x.date_start, ..._metaKpis(x) }));
    function pack(list, nameKey, idKey){ return (list || []).map(x => { const k = _metaKpis(x); return { id: idKey ? String(x[idKey] || '') : '', name: x[nameKey] || '—', spend: k.spend, impressions: k.impressions, clicks: k.clicks, ctr: k.ctr, cpc: k.cpc, cpm: k.cpm, reach: k.reach, frequency: k.frequency, convs: k.convs, leads: k.leads }; }).sort((a, b) => b.spend - a.spend); }
    const adRows = pack(ads.data, 'ad_name', 'ad_id');
    const creativeRows = await Promise.all(adRows.slice(0, 24).map(ad => _metaAdCreativeThumbnail(ad, token)));
    const creativeById = new Map(creativeRows.map(ad => [ad.id, ad]));
    const adsWithCreatives = adRows.map(ad => creativeById.get(ad.id) || ad);
    res.json({
      account: { id: accountId, name: meta.name || accountId, currency: meta.currency || 'BRL' }, preset, range: R,
      kpis: { cur, prev, changes }, dailySpend, conversions: _metaConversions((curD.data || [])[0] || {}),
      campaigns: pack(camps.data, 'campaign_name'), adsets: pack(adsets.data, 'adset_name'), ads: adsWithCreatives,
      breakdowns: {
        age: _metaBreakdownRows(age.data, 'age'), gender: _metaBreakdownRows(gender.data, 'gender'),
        platform: _metaBreakdownRows(platform.data, 'publisher_platform'), device: _metaBreakdownRows(device.data, 'device_platform')
      },
      hourly: _metaBreakdownRows(hourly.data, 'hourly_stats_aggregated_by_advertiser_time_zone', true)
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/client-area/:id/meta', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId); const c = getClientAreaClients(t).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!clientAreaClientVisible(req, c)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  if (!c.metaAccountId) return res.json({ linked: false });
  const token = tenantMetaToken(req);
  if (!token) return res.json({ linked: true, metaAccountId: c.metaAccountId, error: 'Conecte sua conta de anúncios (Facebook) na aba Anúncios.' });
  const VALID = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'];
  const preset = VALID.includes(req.query.preset) ? req.query.preset : 'last_7d';
  try { const metrics = await fetchMetaAdInsights(c.metaAccountId, token, preset); res.json({ linked: true, metaAccountId: c.metaAccountId, preset, metrics }); }
  catch (e) { res.json({ linked: true, metaAccountId: c.metaAccountId, preset, error: e.message }); }
});
function getClientAreaClients(t) { return getClientAreaObj(t).clients; }

// ─── Relatórios semanais automáticos (agência) ───────────────
// O job roda no domingo para preparar PDFs com os últimos sete dias completos
// (domingo a sábado) e programar o primeiro envio para segunda, 07:00 BRT.
const WEEKLY_REPORT_TIME_ZONE = 'America/Sao_Paulo';
const WEEKLY_REPORT_BULK_PREFIX = 'weekly-report:';
const WEEKLY_REPORT_PRINT_MEASURE_CSS = 'body.ads-printing #tab-ads{display:block!important;width:1440px!important;max-width:none!important}body.ads-printing .ads-wrap{width:1440px!important;max-width:none!important;box-sizing:border-box!important}body.ads-printing .ads-overview-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}body.ads-printing .ads-kpis-report{grid-template-columns:repeat(12,minmax(0,1fr))!important}body.ads-printing .ads-kpis-report .ads-kpi{grid-column:span 3!important}body.ads-printing .ads-kpis-count-11 .ads-kpi:nth-child(n+9){grid-column:span 4!important}body.ads-printing .ads-kpis-count-10 .ads-kpi:nth-child(n+9){grid-column:span 6!important}body.ads-printing .ads-kpis-count-9 .ads-kpi:nth-child(n+7){grid-column:span 4!important}body.ads-printing .ads-visual-grid,body.ads-printing .ads-visual-grid-wide{grid-template-columns:repeat(2,minmax(0,1fr))!important}body.ads-printing .ads-visual-grid-three{grid-template-columns:repeat(3,minmax(0,1fr))!important}body.ads-printing .ads-platform-grid{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))!important}body.ads-printing .ads-creative-grid{grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:12px!important}';
let weeklyReportRunPromise = null;

function weeklyIsoDateInTimeZone(date = new Date(), timeZone = WEEKLY_REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = {};
  parts.forEach(part => { if (part.type !== 'literal') value[part.type] = part.value; });
  return value.year + '-' + value.month + '-' + value.day;
}
function weeklyShiftIsoDate(iso, days) {
  const d = new Date(String(iso) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function weeklyDateParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('Data semanal inválida.');
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}
function weeklyBrtDateTimeToUtcMs(iso, hour, minute) {
  const target = weeklyDateParts(iso);
  const desired = Date.UTC(target.year, target.month - 1, target.day, Number(hour || 0), Number(minute || 0), 0);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: WEEKLY_REPORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  for (let i = 0; i < 3; i++) {
    const values = {};
    formatter.formatToParts(new Date(guess)).forEach(part => { if (part.type !== 'literal') values[part.type] = Number(part.value); });
    const actual = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second || 0);
    const delta = desired - actual;
    if (!delta) break;
    guess += delta;
  }
  return guess;
}
function weeklyCurrentBrtClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WEEKLY_REPORT_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = {};
  parts.forEach(part => { if (part.type !== 'literal') value[part.type] = Number(part.value); });
  return { hour: value.hour || 0, minute: value.minute || 0 };
}
function weeklyCompletedRange(referenceAt = new Date()) {
  const today = weeklyIsoDateInTimeZone(referenceAt);
  const until = weeklyShiftIsoDate(today, -1);
  const since = weeklyShiftIsoDate(until, -6);
  const prevUntil = weeklyShiftIsoDate(since, -1);
  const prevSince = weeklyShiftIsoDate(prevUntil, -6);
  return { cur: { since, until }, prev: { since: prevSince, until: prevUntil }, len: 7 };
}
function weeklyScheduledBatchRange(referenceAt, nextMonday) {
  const today = weeklyIsoDateInTimeZone(referenceAt);
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  const clock = weeklyCurrentBrtClock(referenceAt);
  // Às primeiras horas de segunda, o lote já foi preparado no domingo:
  // mantém a janela domingo–sábado para todos os clientes daquela entrega.
  if (weekday === 1 && nextMonday && nextMonday.date === today && clock.hour < 7) {
    const until = weeklyShiftIsoDate(today, -2);
    const since = weeklyShiftIsoDate(until, -6);
    const prevUntil = weeklyShiftIsoDate(since, -1);
    const prevSince = weeklyShiftIsoDate(prevUntil, -6);
    return { cur: { since, until }, prev: { since: prevSince, until: prevUntil }, len: 7 };
  }
  return weeklyCompletedRange(referenceAt);
}
function weeklyLastCompletedMonthRange(referenceAt = new Date()) {
  const today = weeklyIsoDateInTimeZone(referenceAt);
  const currentMonthStart = today.slice(0, 8) + '01';
  const until = weeklyShiftIsoDate(currentMonthStart, -1);
  const since = until.slice(0, 8) + '01';
  const prevUntil = weeklyShiftIsoDate(since, -1);
  const prevSince = prevUntil.slice(0, 8) + '01';
  const len = Math.round((new Date(until + 'T12:00:00Z') - new Date(since + 'T12:00:00Z')) / 86400000) + 1;
  return { cur: { since, until }, prev: { since: prevSince, until: prevUntil }, len };
}
function weeklyNextMondayAtSeven(referenceAt = new Date()) {
  const today = weeklyIsoDateInTimeZone(referenceAt);
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  let addDays = (1 - weekday + 7) % 7;
  if (addDays === 0) {
    const clock = weeklyCurrentBrtClock(referenceAt);
    if (clock.hour > 7 || (clock.hour === 7 && clock.minute > 0)) addDays = 7;
  }
  const date = weeklyShiftIsoDate(today, addDays);
  return { date, at: weeklyBrtDateTimeToUtcMs(date, 7, 0) };
}
function weeklyFormatDate(iso) {
  const parts = String(iso || '').split('-');
  return parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0] : String(iso || '');
}
function weeklySafeFilePart(value) {
  return String(value || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'cliente';
}
function weeklyFormatMoney(value, currency) {
  const number = Number(value || 0);
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency || 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
  } catch (_) {
    return 'R$ ' + number.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
function weeklyFormatInt(value) {
  return Math.round(Number(value || 0)).toLocaleString('pt-BR');
}
function weeklyIsValidImageUrl(value, t) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url.slice(0, 1200);
  const prefix = '/uploads/' + t.clientId + '/';
  if (url.startsWith(prefix)) return url.slice(0, 1200);
  return '';
}
function weeklyClientReportIdentity(t, client) {
  const info = client && client.info && typeof client.info === 'object' ? client.info : {};
  const cfg = t.db.getConfig() || {};
  const agencyBrand = cfg.adsReportBrand && typeof cfg.adsReportBrand === 'object' ? cfg.adsReportBrand : {};
  const docs = Array.isArray(client && client.docs) ? client.docs : [];
  const imageDoc = docs.find(doc => {
    const mime = String(doc && doc.mime || '').toLowerCase();
    const url = String(doc && doc.url || '').toLowerCase();
    return mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)(\?|$)/.test(url);
  });
  const logoCandidates = [
    client && client.reportLogoUrl, client && client.logoUrl, client && client.photoUrl,
    info.reportLogoUrl, info.logoUrl, info.logo, info.photoUrl, info.photo, info.fotoUrl, info.foto, info.imagemUrl,
    imageDoc && imageDoc.url
  ];
  const logoUrl = logoCandidates.map(value => weeklyIsValidImageUrl(value, t)).find(Boolean) || '';
  const name = String((client && (client.reportName || client.name)) || 'Cliente').trim().slice(0, 120) || 'Cliente';
  const title = String((client && client.reportTitle) || info.reportTitle || agencyBrand.title || 'Análise de desempenho').trim().slice(0, 120) || 'Análise de desempenho';
  const initials = name.split(/\s+/).map(word => word[0] || '').join('').slice(0, 2).toUpperCase() || 'R';
  return { name, title, logoUrl, initials };
}
// ─── Motor de envio (automações agendadas da agência) ──────────────────────
// Generaliza o antigo cron fixo de domingo: cada automação (relatório de Ads,
// mensagens de quarta, etc) vira um registro em config.sendAutomations, com
// dia/hora, clientes participantes e (pro relatório de Ads) exceções por
// cliente que antes viviam congeladas neste arquivo. runSendAutomationsTick
// roda a cada minuto — igual ao cron de schedules — e decide quem dispara.
const SEND_AUTOMATION_LEGACY_ADS_RULES = {
  // Clientes com relatório mensal: sempre o último mês calendário fechado.
  'cli-mrthm8yj': { frequency: 'monthly', includeFormLeads: true }, // Entrega EPI
  'cli-ws-1784030399488': { frequency: 'monthly' }, // Volpi
  // Karol usa lead/CPL como métrica principal.
  'cli-mscnqbta': { primaryMetric: 'leads' }
};
function genSendAutomationId() { return 'auto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function sanitizeSendAutomationSchedule(s) {
  return {
    weekday: Math.min(6, Math.max(0, Number(s && s.weekday) || 0)),
    hour: Math.min(23, Math.max(0, Number(s && s.hour) || 0)),
    minute: Math.min(59, Math.max(0, Number(s && s.minute) || 0))
  };
}
function getSendAutomations(t) {
  const cfg = t.db.getConfig() || {};
  if (Array.isArray(cfg.sendAutomations)) return cfg.sendAutomations;
  // Migração: primeira leitura sem config salva — recria o relatório de Ads
  // com o comportamento que já estava em produção, sem exigir ação do usuário.
  const clients = getClientAreaClients(t);
  const adsClientIds = clients.filter(c => weeklyReportChannelsForClient(c).length).map(c => String(c.id));
  const seeded = [{
    id: 'auto_ads_weekly',
    type: 'ads_weekly_report',
    name: 'Relatório Semanal de Ads',
    active: true,
    schedule: { weekday: 0, hour: 18, minute: 0 },
    clientIds: adsClientIds,
    overrides: SEND_AUTOMATION_LEGACY_ADS_RULES,
    config: {},
    lastRunWeekKey: '',
    history: {}
  }];
  t.db.updateConfig({ sendAutomations: seeded });
  return seeded;
}
function saveSendAutomations(t, list) {
  t.db.updateConfig({ sendAutomations: list });
  return list;
}
function weeklyClientGroup(client) {
  const info = client && client.info && typeof client.info === 'object' ? client.info : {};
  return String((client && (client.group || client.clientGroup || client.segment)) || info.group || info.clientGroup || info.segment || '').trim();
}
function weeklyRuleForClient(client, overrides) {
  const explicit = (overrides && overrides[String(client && client.id || '')]) || {};
  const isStart = weeklyClientGroup(client).toUpperCase() === 'START';
  return {
    frequency: explicit.frequency === 'monthly' ? 'monthly' : 'weekly',
    includeFormLeads: !!explicit.includeFormLeads,
    primaryMetric: (client && client.reportPrimaryMetric) || (explicit.primaryMetric === 'leads' ? 'leads' : 'convs'),
    attachPdf: !isStart,
    // Escolha por cliente (ficha do cliente, campo reportSource): 'sistema' (padrão, PDF/texto
    // gerado por aqui com dados do Meta/Google Ads direto) ou 'reportei' (gera link via API do
    // Reportei e manda ele, usa o reporteiProjectId já vinculado no cliente).
    reportSource: client && client.reportSource === 'reportei' ? 'reportei' : 'sistema'
  };
}
function weeklyGoogleAccountId(client) {
  const info = client && client.info && typeof client.info === 'object' ? client.info : {};
  const candidates = [
    client && client.googleAccountId, client && client.googleAdsAccountId, client && client.adsGoogleAccountId,
    client && client.googleAccount, client && client.googleAds,
    info.googleAccountId, info.googleAdsAccountId, info.adsGoogleAccountId, info.googleAccount, info.googleAds
  ];
  for (const candidate of candidates) {
    const raw = candidate && typeof candidate === 'object' ? (candidate.id || candidate.accountId || candidate.customerId || '') : candidate;
    const id = String(raw || '').replace(/\D/g, '');
    if (id) return id;
  }
  return '';
}
function weeklyReportChannelsForClient(client) {
  const metaAccountId = String(client && client.metaAccountId || '').replace(/\D/g, '');
  const googleAccountId = weeklyGoogleAccountId(client);
  const channels = [];
  if (metaAccountId) channels.push({ channel: 'meta', accountId: metaAccountId });
  if (googleAccountId) channels.push({ channel: 'google', accountId: googleAccountId });
  return channels;
}
function weeklyRangeForRule(rule, referenceAt, defaultRange) {
  return rule.frequency === 'monthly' ? weeklyLastCompletedMonthRange(referenceAt) : (defaultRange || weeklyCompletedRange(referenceAt));
}
function weeklyRuleIsDue(rule, nextMonday) {
  return rule.frequency !== 'monthly' || Number(String(nextMonday && nextMonday.date || '').slice(-2)) <= 7;
}
// A capa nunca deve usar a foto do grupo interno da agência: ela representa a
// agência, não o cliente. Quando ainda não há logo cadastrado no cliente,
// usamos o primeiro thumbnail disponível de um anúncio real daquela conta.
// A foto de perfil da Página exige pages_read_engagement no token Meta, que
// não está liberado nesta integração.
async function weeklyIdentityWithCreativeThumbnail(t, accountId, identity) {
  if (identity.logoUrl) return identity;
  try {
    const token = weeklyMetaTokenForTenant(t);
    const id = String(accountId || '').replace(/\D/g, '');
    if (!token || !id) return identity;
    const data = await _metaGet(
      'https://graph.facebook.com/' + META_ADS_GRAPH_API_VERSION + '/act_' + id +
      '/ads?fields=creative{thumbnail_url,image_url}&limit=25&access_token=' + encodeURIComponent(token)
    );
    const creative = (Array.isArray(data && data.data) ? data.data : [])
      .map(ad => ad && ad.creative || {})
      .find(item => weeklyIsValidImageUrl(item.thumbnail_url || item.image_url, t));
    const logoUrl = creative && weeklyIsValidImageUrl(creative.thumbnail_url || creative.image_url, t);
    return logoUrl ? { ...identity, logoUrl } : identity;
  } catch (_) {
    return identity;
  }
}
function weeklyNormalMonitorEntries(list) {
  return (Array.isArray(list) ? list : []).map(entry => {
    if (entry && typeof entry === 'object') return { id: String(entry.id || '').trim(), name: String(entry.name || entry.id || '').trim() };
    return { id: String(entry || '').trim(), name: String(entry || '').trim() };
  }).filter(entry => entry.id);
}
function weeklyResolveCrmPhone(t, entry) {
  const raw = String(entry && entry.id || '').trim();
  if (!raw.endsWith('@lid')) {
    const direct = normalizeBrazilianMobileDigits(normalizePhoneNumber(raw.replace(/@.*/, '')));
    if (direct && direct.length >= 10) return { id: direct, sourceId: raw, name: entry.name || direct };
    return null;
  }
  const matchingCards = (t.db.getCrmCards() || []).filter(card => String(card && card.whatsappId || '') === raw);
  const phones = [...new Set(matchingCards.map(card => normalizeBrazilianMobileDigits(normalizePhoneNumber((card && (card.phone || card.whatsapp)) || ''))).filter(phone => phone && phone.length >= 10))];
  if (phones.length !== 1) return null;
  return { id: phones[0], sourceId: raw, name: entry.name || phones[0] };
}
function weeklyTargetForClient(t, client) {
  const monitor = client && client.monitor && typeof client.monitor === 'object' ? client.monitor : {};
  const group = weeklyNormalMonitorEntries(monitor.groups).find(entry => isGroupRecipientId(entry.id));
  if (group) return { recipientType: 'group', recipientId: normalizeJid(group.id), recipientName: group.name || client.name || group.id, sourceId: group.id };
  const contacts = weeklyNormalMonitorEntries(monitor.crmContacts);
  for (const contact of contacts) {
    const resolved = weeklyResolveCrmPhone(t, contact);
    if (resolved) return { recipientType: 'contact', recipientId: resolved.id, recipientName: resolved.name || client.name || resolved.id, sourceId: resolved.sourceId };
  }
  return null;
}
// Slot do Lite conectado (se tiver) — extraído do antigo weeklyGroupConnection pra poder
// ser reaproveitado também pra contato direto (achado 28/09/2026: contato direto nunca
// checava o Lite, só grupo checava — cliente com provider='cloud' na config mas que na
// prática manda pelo Lite ficava sempre preso na exigência de janela de 24h da API Oficial,
// mesmo com o Lite conectado e funcionando).
async function weeklyLiteSlotIfConnected(t) {
  if (!liteEnabled(t)) return null;
  let disabled = [];
  try { disabled = (t.db.getConfig() || {}).liteDisabledSlots || []; } catch (_) {}
  for (const slot of ['1', '2']) {
    if (disabled.includes(slot)) continue;
    const status = await evoReq('GET', '/instance/connectionState/' + liteInstanceName(t, slot), null, 15000);
    const state = status && status.json && status.json.instance && status.json.instance.state;
    if (state === 'open') return slot === '2' ? 'lite2' : 'lite';
  }
  return null;
}
async function weeklyGroupConnection(t) {
  const liteSlot = await weeklyLiteSlotIfConnected(t);
  if (liteSlot) return liteSlot;
  if (t.isGroupReady && t.waGroupClient) return 'groups';
  if (t.isReady2 && t.waClient2) return 'web2';
  if (t.isReady3 && t.waClient3) return 'web3';
  if (t.isReady && t.waClient) return 'web';
  return null;
}
function weeklyCloudWindowIsOpen(t, target) {
  const ids = new Set([String(target.recipientId || ''), String(target.sourceId || ''), String(target.recipientId || '') + '@s.whatsapp.net']);
  for (const id of ids) {
    if (!id) continue;
    const newestInbound = (t.db.getMessages(id) || []).filter(message => message.direction === 'in').sort((a, b) => b.timestamp - a.timestamp)[0];
    if (newestInbound && Date.now() - Number(newestInbound.timestamp || 0) < 23 * 60 * 60 * 1000 + 50 * 60 * 1000) return true;
  }
  return false;
}
async function weeklyConnectionForTarget(t, target) {
  if (target.recipientType === 'group') {
    const connectionId = await weeklyGroupConnection(t);
    return connectionId ? { connectionId } : { error: 'grupo sem conexão WhatsApp disponível' };
  }
  // Contato direto: tenta o Lite primeiro, igual grupo já fazia — antes só entrava direto na
  // exigência de janela de 24h da API Oficial mesmo quando o envio de verdade sai pelo Lite.
  const liteSlot = await weeklyLiteSlotIfConnected(t);
  if (liteSlot) return { connectionId: liteSlot };
  if (t.provider === 'cloud') {
    if (!t.WA_PHONE_NUMBER_ID || !t.WA_ACCESS_TOKEN) return { error: 'API Oficial não configurada' };
    if (!weeklyCloudWindowIsOpen(t, target)) return { error: 'contato CRM fora da janela de 24h da API Oficial (precisa de template aprovado)' };
    return { connectionId: 'cloud1' };
  }
  if (t.isReady && t.waClient) return { connectionId: 'web' };
  if (t.isReady2 && t.waClient2) return { connectionId: 'web2' };
  if (t.isReady3 && t.waClient3) return { connectionId: 'web3' };
  return { error: 'contato CRM sem conexão WhatsApp disponível' };
}
function weeklyMetaTokenForTenant(t) {
  const config = t.db.getConfig() || {};
  if (config.adsMeta && config.adsMeta.token) return config.adsMeta.token;
  return t.clientId === 'virandoachave' ? loadMetaToken() : '';
}
async function weeklyFetchMetaSummary(t, accountId, range) {
  const token = weeklyMetaTokenForTenant(t);
  if (!token) throw new Error('Conta Meta da agência não está conectada.');
  const id = String(accountId || '').replace(/\D/g, '');
  if (!id) throw new Error('Conta Meta inválida.');
  const result = await Promise.all([
    _metaGet('https://graph.facebook.com/' + META_ADS_GRAPH_API_VERSION + '/act_' + id + '?fields=name,currency&access_token=' + encodeURIComponent(token)),
    _metaGet(_metaInsUrl(id, token, range.cur)),
    _metaGet(_metaInsUrl(id, token, range.prev))
  ]);
  const meta = result[0], curData = result[1], prevData = result[2];
  const cur = _metaKpis((curData.data || [])[0] || {});
  const prev = _metaKpis((prevData.data || [])[0] || {});
  const changes = {};
  Object.keys(cur).forEach(key => {
    const current = Number(cur[key] || 0), previous = Number(prev[key] || 0);
    changes[key] = previous > 0 ? ((current - previous) / previous * 100) : (current > 0 ? 100 : 0);
  });
  // Antes o relatório sempre dizia "os anúncios seguem rodando normalmente" sem checar
  // nada de verdade. Confere se existe pelo menos 1 campanha com effective_status=ACTIVE.
  let hasActiveCampaigns = null; // null = não deu pra checar (não afirma nem nega)
  try {
    const campData = await _metaGet('https://graph.facebook.com/' + META_ADS_GRAPH_API_VERSION + '/act_' + id + '/campaigns?fields=effective_status&limit=200&access_token=' + encodeURIComponent(token));
    hasActiveCampaigns = (campData.data || []).some(c => c.effective_status === 'ACTIVE');
  } catch (e) {}
  return { account: { id, name: meta.name || id, currency: meta.currency || 'BRL' }, range, kpis: { cur, prev, changes }, hasActiveCampaigns };
}
async function weeklyFetchGoogleSummary(t, accountId, range) {
  if (!loadGoogleAdsCreds()) throw new Error('Google Ads não está configurado.');
  const id = String(accountId || '').replace(/\D/g, '');
  if (!id) throw new Error('Conta Google Ads inválida.');
  const between = value => "segments.date BETWEEN '" + value.since + "' AND '" + value.until + "'";
  const metrics = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.cost_per_conversion, metrics.conversions_value';
  const kpi = rows => {
    const item = (rows[0] && rows[0].metrics) || {};
    const cost = Number(item.costMicros || 0) / 1000000;
    const conversions = Number(item.conversions || 0);
    return {
      cost,
      impressions: Number(item.impressions || 0),
      clicks: Number(item.clicks || 0),
      ctr: Number(item.ctr || 0) * 100,
      cpc: Number(item.averageCpc || 0) / 1000000,
      cpm: Number(item.averageCpm || 0) / 1000000,
      conversions,
      cpConv: conversions > 0 ? cost / conversions : 0,
      convValue: Number(item.conversionsValue || 0)
    };
  };
  let login = gadsLoginFor(id);
  if (!login) {
    try { await gadsListAccounts(); } catch (_) {}
    login = gadsLoginFor(id) || id;
  }
  const result = await Promise.all([
    gadsSearch(id, 'SELECT ' + metrics + ' FROM customer WHERE ' + between(range.cur), login),
    gadsSearch(id, 'SELECT ' + metrics + ' FROM customer WHERE ' + between(range.prev), login)
  ]);
  const cur = kpi(result[0]), prev = kpi(result[1]), changes = {};
  Object.keys(cur).forEach(key => {
    const current = Number(cur[key] || 0), previous = Number(prev[key] || 0);
    changes[key] = previous > 0 ? ((current - previous) / previous * 100) : (current > 0 ? 100 : 0);
  });
  let account = { id, name: id, currency: 'BRL' };
  try {
    const found = (await gadsListAccounts()).find(item => String(item.id) === id);
    if (found) account = { id, name: found.name || id, currency: found.currency || 'BRL' };
  } catch (_) {}
  // Mesma checagem do Meta: confere campanha com status ENABLED antes de afirmar que
  // está tudo rodando.
  let hasActiveCampaigns = null;
  try {
    const rows = await gadsSearch(id, "SELECT campaign.status FROM campaign WHERE campaign.status = 'ENABLED' LIMIT 1", login);
    hasActiveCampaigns = rows.length > 0;
  } catch (_) {}
  return { account, range, kpis: { cur, prev, changes }, hasActiveCampaigns };
}
function weeklyMetaMessageLines(report, rule = {}) {
  const current = report.kpis.cur || {}, previous = report.kpis.prev || {};
  const useLeads = rule.primaryMetric === 'leads';
  const useEcommerce = rule.primaryMetric === 'ecommerce';
  const currentMetric = Number(useEcommerce ? current.purchases : (useLeads ? current.leads : current.convs || 0));
  const previousMetric = Number(useEcommerce ? previous.purchases : (useLeads ? previous.leads : previous.convs || 0));
  const metricLabel = useEcommerce ? 'Vendas' : (useLeads ? 'Leads' : 'Conversas iniciadas');
  const metricLower = useEcommerce ? 'vendas' : (useLeads ? 'leads' : 'conversas iniciadas');
  const costLabel = useEcommerce ? 'Custo por venda' : (useLeads ? 'Custo por lead' : 'Custo por conversa');
  const cost = useEcommerce ? current.cpPurchase : (useLeads ? current.cpl : current.cpConv);
  let insight;
  if (previousMetric <= 0 && currentMetric > 0) insight = 'Tivemos ' + weeklyFormatInt(currentMetric) + ' ' + metricLower + ' neste período. Vamos acompanhar os próximos dias para consolidar a comparação.';
  else if (currentMetric > previousMetric) insight = 'Tivemos um aumento no volume de ' + metricLower + ' em comparação ao período anterior. Seguimos acompanhando para manter esse ritmo.';
  else if (currentMetric < previousMetric) insight = 'Notei uma queda no volume de ' + metricLower + ' em comparação ao período anterior. Já estamos analisando os pontos de melhoria para retomar os números ideais.';
  else insight = 'O volume de ' + metricLower + ' ficou estável em comparação ao período anterior. Seguimos acompanhando os próximos movimentos.';
  const lines = [
    '✅ Valor investido: ' + weeklyFormatMoney(current.spend, report.account.currency),
    '🚀 Alcance Total: ' + weeklyFormatInt(current.reach) + ' pessoas',
    '✅ ' + metricLabel + ': ' + weeklyFormatInt(currentMetric),
    '🚀 ' + costLabel + ': ' + (currentMetric > 0 ? weeklyFormatMoney(cost, report.account.currency) : '—')
  ];
  if (rule.includeFormLeads) {
    const formLeads = Number(current.formLeads || 0);
    lines.push('✅ Leads de formulário: ' + weeklyFormatInt(formLeads));
    lines.push('🚀 Custo por lead de formulário: ' + (formLeads > 0 ? weeklyFormatMoney(current.cpFormLead, report.account.currency) : '—'));
  }
  if (useEcommerce) {
    lines.push('🛒 Iniciações de checkout: ' + weeklyFormatInt(current.initiateCheckout));
    lines.push('🧺 Adições ao carrinho: ' + weeklyFormatInt(current.addToCart));
  }
  lines.push('Tivemos um total de ' + weeklyFormatInt(current.clicks) + ' cliques nos anúncios no período.');
  lines.push(insight);
  return lines;
}
function weeklyGoogleMessageLines(report) {
  const current = report.kpis.cur || {}, previous = report.kpis.prev || {};
  const conversions = Number(current.conversions || 0), previousConversions = Number(previous.conversions || 0);
  let insight;
  if (previousConversions <= 0 && conversions > 0) insight = 'Tivemos ' + weeklyFormatInt(conversions) + ' conversões neste período. Vamos acompanhar os próximos dias para consolidar a comparação.';
  else if (conversions > previousConversions) insight = 'Tivemos um aumento no volume de conversões em comparação ao período anterior. Seguimos acompanhando para manter esse ritmo.';
  else if (conversions < previousConversions) insight = 'Notei uma queda no volume de conversões em comparação ao período anterior. Já estamos analisando os pontos de melhoria para retomar os números ideais.';
  else insight = 'O volume de conversões ficou estável em comparação ao período anterior. Seguimos acompanhando os próximos movimentos.';
  return [
    '✅ Valor investido: ' + weeklyFormatMoney(current.cost, report.account.currency),
    '🚀 Impressões: ' + weeklyFormatInt(current.impressions),
    '✅ Conversões: ' + weeklyFormatInt(conversions),
    '🚀 Custo por conversão: ' + (conversions > 0 ? weeklyFormatMoney(current.cpConv, report.account.currency) : '—'),
    'Tivemos um total de ' + weeklyFormatInt(current.clicks) + ' cliques nos anúncios no período.',
    insight
  ];
}
// Antes essa linha era fixa em todo relatório, sem checar nada. Agora usa o
// hasActiveCampaigns que weeklyFetchMetaSummary/weeklyFetchGoogleSummary apuram de
// verdade (campanha com effective_status=ACTIVE / status=ENABLED).
function weeklyRunningStatusLine(flags) {
  const known = flags.filter(f => f.active === true || f.active === false);
  if (!known.length) return 'Não consegui confirmar agora se as campanhas estão ativas — recomendo dar uma olhada quando puder.';
  const inactive = known.filter(f => !f.active);
  if (!inactive.length) return 'Os anúncios seguem rodando normalmente. 🚀';
  if (inactive.length === known.length) return '⚠️ Não identifiquei nenhuma campanha ativa no momento — vale a pena revisar.';
  return '⚠️ Atenção: não identifiquei campanha ativa em ' + inactive.map(f => f.label).join(' e ') + ' no momento — vale a pena revisar.';
}
function weeklyMessageForClient(client, report, rule = {}) {
  const name = String(client && client.name || 'cliente').trim();
  const lines = weeklyMetaMessageLines(report, rule);
  return [
    'Bom dia família ' + name + '! 🤝',
    '.',
    'Segue o relatório de desempenho do Meta Ads (' + weeklyFormatDate(report.range.cur.since) + ' a ' + weeklyFormatDate(report.range.cur.until) + '):',
    '.',
    ...lines.slice(0, 4),
    '.',
    ...lines.slice(4),
    '.',
    weeklyRunningStatusLine([{ label: 'Meta Ads', active: report.hasActiveCampaigns }]),
    '.',
    'Qualquer dúvida, estou à disposição!'
  ].join('\n');
}
function weeklyGoogleMessageForClient(client, report) {
  const name = String(client && client.name || 'cliente').trim();
  const lines = weeklyGoogleMessageLines(report);
  return [
    'Bom dia família ' + name + '! 🤝',
    '.',
    'Segue o relatório de desempenho do Google Ads (' + weeklyFormatDate(report.range.cur.since) + ' a ' + weeklyFormatDate(report.range.cur.until) + '):',
    '.',
    ...lines.slice(0, 4),
    '.',
    ...lines.slice(4),
    '.',
    weeklyRunningStatusLine([{ label: 'Google Ads', active: report.hasActiveCampaigns }]),
    '.',
    'Qualquer dúvida, estou à disposição!'
  ].join('\n');
}
function weeklyMessageForReports(client, reports, rule = {}) {
  const meta = reports && reports.meta, google = reports && reports.google;
  if (meta && !google) return weeklyMessageForClient(client, meta, rule);
  if (google && !meta) return weeklyGoogleMessageForClient(client, google);
  const name = String(client && client.name || 'cliente').trim();
  const range = meta ? meta.range : google.range;
  return [
    'Bom dia família ' + name + '! 🤝',
    '.',
    'Segue o relatório de desempenho de Meta Ads e Google Ads (' + weeklyFormatDate(range.cur.since) + ' a ' + weeklyFormatDate(range.cur.until) + '):',
    '.',
    '*Meta Ads*',
    ...weeklyMetaMessageLines(meta, rule).slice(0, 4),
    '.',
    ...weeklyMetaMessageLines(meta, rule).slice(4),
    '.',
    '*Google Ads*',
    ...weeklyGoogleMessageLines(google).slice(0, 4),
    '.',
    ...weeklyGoogleMessageLines(google).slice(4),
    '.',
    weeklyRunningStatusLine([{ label: 'Meta Ads', active: meta.hasActiveCampaigns }, { label: 'Google Ads', active: google.hasActiveCampaigns }]),
    '.',
    'Qualquer dúvida, estou à disposição!'
  ].join('\n');
}
function weeklyAutomationToken(t) {
  const users = loadClients();
  const user = users.find(item => item && !item.ownerClientId && item.admin && item.id === t.clientId) || users.find(item => item && !item.ownerClientId && item.admin);
  if (!user) throw new Error('Usuário administrador da agência não encontrado para renderizar o relatório.');
  return createToken(user);
}
function weeklyChromeExecutablePath() {
  const configured = process.env.WEEKLY_REPORT_CHROME_EXECUTABLE || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  if (configured && fs.existsSync(configured)) return configured;
  const root = '/root/.cache/puppeteer/chrome-headless-shell';
  let versions = [];
  try { versions = fs.readdirSync(root).sort().reverse(); } catch (_) {}
  for (const version of versions) {
    const candidate = path.join(root, version, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Navegador de geração de PDF não encontrado no servidor.');
}
async function weeklyLaunchBrowser() {
  if (!puppeteerCore) puppeteerCore = require('puppeteer-core');
  return puppeteerCore.launch({
    executablePath: weeklyChromeExecutablePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
  });
}
async function weeklyRenderPdf(t, browser, client, channels, range, weekKey, identityOverride, options = {}) {
  const reportDir = path.join(t.uploadsDir, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const identity = identityOverride || weeklyClientReportIdentity(t, client);
  const activeChannels = (Array.isArray(channels) ? channels : []).filter(item => item && ['meta', 'google'].includes(item.channel) && item.accountId);
  if (!activeChannels.length) throw new Error('Nenhuma conta de anúncios disponível para gerar o PDF.');
  const fileName = 'Relatorio de Anuncios - ' + identity.name + ' - ' + weeklyFormatDate(range.cur.since).replace(/\//g, '-') + ' a ' + weeklyFormatDate(range.cur.until).replace(/\//g, '-') + '.pdf';
  const filePath = path.join(reportDir, 'relatorio-anuncios-' + weeklySafeFilePart(client.id || identity.name) + '-' + weekKey + '.pdf');
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.evaluateOnNewDocument(token => {
      localStorage.setItem('wa-token', token);
      localStorage.setItem('wa-theme', 'light');
    }, weeklyAutomationToken(t));
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const dashboard = document.getElementById('screen-dashboard');
      return dashboard && dashboard.classList.contains('active');
    });
    await page.evaluate(payload => {
      window.__weeklyReportPayload = payload;
      if (window.__weeklyReportFetchWrapped) return;
      const nativeFetch = window.fetch.bind(window);
      window.__weeklyReportFetchWrapped = true;
      window.fetch = function(input, fetchOptions) {
        const raw = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
        if (raw.indexOf('/api/ads/meta/report') >= 0 || raw.indexOf('/api/ads/google/report') >= 0) {
          const state = window.__weeklyReportPayload || {};
          const url = new URL(raw, window.location.origin);
          url.searchParams.set('weeklySince', state.since || '');
          url.searchParams.set('weeklyUntil', state.until || '');
          url.searchParams.set('weeklyPrevSince', state.prevSince || '');
          url.searchParams.set('weeklyPrevUntil', state.prevUntil || '');
          return nativeFetch(url.pathname + url.search, fetchOptions);
        }
        return nativeFetch(input, fetchOptions);
      };
    }, { since: range.cur.since, until: range.cur.until, prevSince: range.prev.since, prevUntil: range.prev.until });
    const reportMarkup = [];
    for (const descriptor of activeChannels) {
      await page.evaluate(async channel => {
        if (channel === 'google') {
          if (typeof window.adsSetChannel !== 'function') throw new Error('Tela de Google Ads não carregou.');
          window.adsSetChannel('google');
          return;
        }
        if (typeof window.loadAdsReport !== 'function') throw new Error('Tela de Meta Ads não carregou.');
        await window.loadAdsReport();
      }, descriptor.channel);
      await page.waitForFunction(channel => {
        const active = document.querySelector('.ads-chan-btn.on');
        return active && String(active.textContent || '').toLowerCase().indexOf(channel === 'google' ? 'google' : 'meta') >= 0;
      }, {}, descriptor.channel);
      await page.waitForSelector('.ads-sel-acct');
      await page.evaluate(id => {
        if (typeof window.adsSetAcct !== 'function') throw new Error('Tela de anúncios não carregou.');
        window.adsSetAcct(id);
      }, String(descriptor.accountId));
      await page.waitForFunction(() => !!document.getElementById('ads-report') || !!document.querySelector('.ads-error'));
      const renderError = await page.$eval('.ads-error', node => node.textContent || '').catch(() => '');
      if (renderError) throw new Error(renderError.trim());
      const markup = await page.$eval('#ads-report', (node, channel) => {
        const clone = node.cloneNode(true);
        clone.dataset.weeklyChannel = channel;
        return clone.outerHTML;
      }, descriptor.channel);
      reportMarkup.push(markup);
    }
    if (reportMarkup.length > 1) {
      await page.evaluate(markup => {
        const root = document.getElementById('tab-ads');
        if (!root) throw new Error('Área do relatório não encontrada.');
        root.innerHTML = '<div class="ads-wrap ads-weekly-combined">' + markup.join('<div class="ads-weekly-channel-divider"></div>') + '</div>';
      }, reportMarkup.map((markup, index) => markup.replace('id="ads-report"', 'id="ads-report-' + index + '"')));
    }
    await page.evaluate(async payload => {
      const reports = Array.from(document.querySelectorAll('.ads-report'));
      if (!reports.length) throw new Error('Relatório não foi renderizado.');
      reports.forEach(report => {
        const channel = report.dataset.weeklyChannel || payload.defaultChannel || 'meta';
        const mark = report.querySelector('.ads-report-mark');
        if (mark) {
          mark.replaceChildren();
          if (payload.logoUrl) {
            const image = new Image();
            image.src = payload.logoUrl;
            image.alt = payload.name;
            image.addEventListener('error', () => { mark.textContent = payload.initials; }, { once: true });
            mark.appendChild(image);
          } else mark.textContent = payload.initials;
        }
        const name = report.querySelector('.ads-report-client');
        if (name) name.textContent = payload.name;
        const title = report.querySelector('.ads-report-hero h2');
        if (title) title.textContent = payload.title;
        if (payload.includeFormLeads && channel === 'meta') {
          report.querySelectorAll('.ads-kpi-l').forEach(label => {
            if (String(label.textContent || '').trim().toLowerCase() === 'leads') label.textContent = 'Leads de formulário';
          });
        }
        const footer = report.querySelector('.ads-report-foot');
        if (footer) footer.textContent = payload.name + ' · Relatório ' + (channel === 'google' ? 'Google Ads' : 'Meta Ads');
      });
      document.title = payload.name + ' - ' + payload.title;
      document.body.classList.add('ads-printing');
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await Promise.all(Array.from(document.querySelectorAll('.ads-report img')).filter(image => !image.complete).map(image => new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 8000);
      })));
    }, { ...identity, includeFormLeads: !!options.includeFormLeads, defaultChannel: activeChannels.length === 1 ? activeChannels[0].channel : '' });
    await page.addStyleTag({ content: WEEKLY_REPORT_PRINT_MEASURE_CSS });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const height = await page.evaluate(extraSpace => {
      const printable = document.getElementById('tab-ads');
      const wrapper = printable && (printable.querySelector('.ads-wrap') || printable);
      return Math.ceil(Math.max(printable ? printable.scrollHeight : 0, printable ? printable.getBoundingClientRect().height : 0, wrapper ? wrapper.scrollHeight : 0, wrapper ? wrapper.getBoundingClientRect().height : 0) + extraSpace);
    }, reportMarkup.length > 1 ? 1800 : 560);
    const continuous = height <= 19000;
    const pageCss = WEEKLY_REPORT_PRINT_MEASURE_CSS + (continuous
      ? '@page{size:1440px ' + Math.max(1200, height) + 'px;margin:0}'
      : '@page{size:A4 landscape;margin:10mm}');
    await page.addStyleTag({ content: pageCss });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.pdf({ path: filePath, printBackground: true, preferCSSPageSize: true });
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (size < 4096) throw new Error('PDF gerado está vazio ou incompleto.');
    return { filePath, fileName, bytes: size, identity };
  } finally {
    await page.close().catch(() => {});
  }
}
function weeklyIsReportMessage(message) {
  return /relat[oó]rio de desempenho[\s\S]*(meta ads|google ads|an[uú]ncios)/i.test(String(message || ''));
}
function weeklyScheduleBulkId(weekKey, client) {
  return WEEKLY_REPORT_BULK_PREFIX + weekKey + ':' + weeklySafeFilePart(client && client.id || 'cliente');
}
function weeklyScheduleBelongsToClient(schedule, client, legacyBulkId, scheduleBulkId) {
  if (!schedule) return false;
  if (String(schedule.bulkId || '') === scheduleBulkId) return true;
  if (String(schedule.bulkId || '') !== legacyBulkId) return false;
  const key = weeklySafeFilePart(client && client.id || '');
  const asset = String(schedule.documentPath || '').toLowerCase();
  if (key && asset.indexOf('-' + key.toLowerCase() + '-') >= 0) return true;
  const message = String(schedule.message || '').toLowerCase();
  const name = String(client && client.name || '').trim().toLowerCase();
  return !!name && weeklyIsReportMessage(message) && message.indexOf('bom dia família ' + name + '!') >= 0;
}
function weeklySchedulePrepared(schedule, rule, channels, range) {
  if (!schedule) return false;
  if (!rule.attachPdf) return !schedule.documentPath;
  if (!schedule.documentPath || !fs.existsSync(schedule.documentPath)) return false;
  const asset = String(schedule.documentPath || '').toLowerCase();
  const documentName = String(schedule.documentName || '').toLowerCase();
  const since = weeklyFormatDate(range.cur.since).replace(/\//g, '-').toLowerCase();
  const until = weeklyFormatDate(range.cur.until).replace(/\//g, '-').toLowerCase();
  if (documentName && (documentName.indexOf(since) < 0 || documentName.indexOf(until) < 0)) return false;
  const hasGoogle = channels.some(item => item.channel === 'google');
  const hasMeta = channels.some(item => item.channel === 'meta');
  const generic = asset.indexOf('/relatorio-anuncios-') >= 0 || documentName.indexOf('relatorio de anuncios') >= 0;
  if (hasGoogle && (!generic || !hasMeta && !generic)) return false;
  return true;
}
function weeklyDispatchAt(base, index) {
  return base + index * DISPATCH_INTERVAL_MS + Math.floor(index / BULK_BATCH_SIZE) * BULK_REST_MS;
}
function weeklyNextFreeDispatchAt(base, schedules) {
  const occupied = Array.isArray(schedules) ? schedules : [];
  for (let index = 0; index < 240; index++) {
    const candidate = weeklyDispatchAt(base, index);
    const inUse = occupied.some(schedule => Math.abs(Number(schedule && schedule.scheduledFor || 0) - candidate) < Math.max(1000, DISPATCH_INTERVAL_MS - 1000));
    if (!inUse) return candidate;
  }
  throw new Error('Não foi possível encontrar horário disponível para o envio.');
}
function weeklyReflowBatchSchedules(t, weekKey, base, schedules) {
  const prefix = WEEKLY_REPORT_BULK_PREFIX + weekKey;
  const batch = (Array.isArray(schedules) ? schedules : [])
    .filter(schedule => String(schedule && schedule.bulkId || '').startsWith(prefix))
    .sort((left, right) => Number(left.scheduledFor || 0) - Number(right.scheduledFor || 0) || String(left.id || '').localeCompare(String(right.id || '')));
  let changed = 0;
  batch.forEach((schedule, index) => {
    const scheduledFor = weeklyDispatchAt(base, index);
    if (Number(schedule.scheduledFor || 0) === scheduledFor) return;
    t.db.updateSchedule(schedule.id, { scheduledFor });
    schedule.scheduledFor = scheduledFor;
    changed++;
  });
  return changed;
}
async function runWeeklyReports(t, options = {}) {
  if (weeklyReportRunPromise) return { ok: false, busy: true, error: 'Uma preparação semanal já está em andamento.' };
  const execute = async () => {
    const referenceAt = options.referenceAt ? new Date(options.referenceAt) : new Date();
    const nextMonday = weeklyNextMondayAtSeven(referenceAt);
    const defaultRange = weeklyScheduledBatchRange(referenceAt, nextMonday);
    const weekKey = nextMonday.date;
    const legacyBulkId = WEEKLY_REPORT_BULK_PREFIX + weekKey;
    const dryRun = !!options.dryRun;
    const force = !!options.force;
    const onlyClientId = options.onlyClientId ? String(options.onlyClientId) : '';
    const explicitClientIds = Array.isArray(options.clientIds) ? options.clientIds : null;
    const onlyClientIds = new Set((explicitClientIds || []).map(value => String(value || '')).filter(Boolean));
    const overrides = options.overrides && typeof options.overrides === 'object' ? options.overrides : {};
    const result = {
      ok: true,
      dryRun,
      trigger: options.trigger || 'manual',
      weekKey,
      range: defaultRange,
      scheduledFor: nextMonday.at,
      created: [],
      updated: [],
      skipped: [],
      errors: []
    };
    if (t.clientId !== 'virandoachave') throw new Error('A rotina semanal só pode ser executada na conta da agência.');
    const allClients = getClientAreaClients(t);
    const clients = onlyClientId
      ? allClients.filter(client => String(client.id) === onlyClientId)
      : (explicitClientIds !== null ? allClients.filter(client => onlyClientIds.has(String(client.id))) : allClients);
    if (onlyClientId && !clients.length) throw new Error('Cliente informado não foi encontrado.');
    let browser = null;
    let existingSchedules = t.db.getSchedules();
    try {
      for (const client of clients) {
        const clientName = String(client.name || client.id || 'Cliente');
        const rule = weeklyRuleForClient(client, overrides);
        if (!weeklyRuleIsDue(rule, nextMonday)) {
          result.skipped.push({ clientId: client.id, client: clientName, reason: 'relatório mensal: próximo envio no primeiro domingo útil do mês' });
          continue;
        }
        const useReportei = rule.reportSource === 'reportei';
        // Reportei tem as próprias integrações — não depende de metaAccountId/googleAccountId
        // vinculados aqui, só do reporteiProjectId. Só exige conta Meta/Google quando for o
        // modo "sistema" (o de sempre).
        const channels = weeklyReportChannelsForClient(client);
        if (!useReportei && !channels.length) {
          result.skipped.push({ clientId: client.id, client: clientName, reason: 'sem conta Meta Ads ou Google Ads vinculada' });
          continue;
        }
        if (useReportei && !client.reporteiProjectId) {
          result.skipped.push({ clientId: client.id, client: clientName, reason: 'modo Reportei escolhido mas sem projeto Reportei vinculado' });
          continue;
        }
        const target = weeklyTargetForClient(t, client);
        if (!target) {
          result.skipped.push({ clientId: client.id, client: clientName, reason: 'sem grupo ou número WhatsApp CRM utilizável' });
          continue;
        }
        const connection = await weeklyConnectionForTarget(t, target);
        if (connection.error) {
          result.skipped.push({ clientId: client.id, client: clientName, reason: connection.error });
          continue;
        }
        const scheduleBulkId = weeklyScheduleBulkId(weekKey, client);
        const replacement = existingSchedules.find(schedule => String(schedule.recipientId || '') === String(target.recipientId || '') && weeklyScheduleBelongsToClient(schedule, client, legacyBulkId, scheduleBulkId));
        const range = (options.range && options.range.cur && options.range.cur.since) ? options.range : weeklyRangeForRule(rule, referenceAt, defaultRange);
        if (!dryRun && !force && weeklySchedulePrepared(replacement, rule, channels, range)) {
          result.skipped.push({ clientId: client.id, client: clientName, reason: 'já preparado para esta segunda-feira', scheduleId: replacement.id });
          continue;
        }
        if (useReportei) {
          let reporteiUrl;
          try {
            reporteiUrl = await reporteiCreateReportUrl(client.reporteiProjectId, `Relatório ${clientName}`, range.cur.since, range.cur.until);
          } catch (error) {
            result.errors.push({ clientId: client.id, client: clientName, error: 'Reportei: ' + error.message });
            continue;
          }
          // Junta a MESMA análise de KPIs/comentário que o modo "sistema" gera (se o cliente
          // tiver conta Meta/Google vinculada) com o link do Reportei no final. Sem conta
          // vinculada, cai no texto curto de sempre (só o link) — não trava o envio.
          let reporteiMessage = '';
          if (channels.length) {
            const reportsForReportei = {};
            for (const descriptor of channels) {
              try {
                reportsForReportei[descriptor.channel] = descriptor.channel === 'meta'
                  ? await weeklyFetchMetaSummary(t, descriptor.accountId, range)
                  : await weeklyFetchGoogleSummary(t, descriptor.accountId, range);
              } catch (error) {
                result.errors.push({ clientId: client.id, client: clientName, error: (descriptor.channel === 'meta' ? 'Meta Ads: ' : 'Google Ads: ') + error.message });
              }
            }
            if (Object.keys(reportsForReportei).length) {
              reporteiMessage = weeklyMessageForReports(client, reportsForReportei, rule) + `\n\n🔗 Relatório completo: ${reporteiUrl}`;
            }
          }
          if (!reporteiMessage) {
            reporteiMessage = `📊 Relatório de marketing — ${clientName}\nPeríodo: ${weeklyFormatDate(range.cur.since)} a ${weeklyFormatDate(range.cur.until)}\n${reporteiUrl}`;
          }
          if (dryRun) {
            result.created.push({ clientId: client.id, client: clientName, preview: true, recipient: target.recipientName, attachment: false, channels: ['reportei'], range });
            continue;
          }
          const reporteiScheduleData = {
            recipientType: target.recipientType, recipientId: target.recipientId, recipientName: target.recipientName,
            message: reporteiMessage,
            scheduledFor: replacement ? Number(replacement.scheduledFor) : weeklyNextFreeDispatchAt(nextMonday.at, existingSchedules),
            documentPath: null, documentName: null, quickReplies: [], bulkId: scheduleBulkId, connectionId: connection.connectionId
          };
          if (replacement) {
            t.db.updateSchedule(replacement.id, reporteiScheduleData);
            existingSchedules = existingSchedules.map(schedule => String(schedule.id) === String(replacement.id) ? { ...schedule, ...reporteiScheduleData } : schedule);
            result.updated.push({ clientId: client.id, client: clientName, scheduleId: replacement.id, recipient: target.recipientName, scheduledFor: reporteiScheduleData.scheduledFor, attachment: false, channels: ['reportei'], range });
          } else {
            const reporteiScheduleId = t.db.createSchedule(reporteiScheduleData);
            existingSchedules = existingSchedules.concat([{ ...reporteiScheduleData, id: reporteiScheduleId }]);
            result.created.push({ clientId: client.id, client: clientName, scheduleId: reporteiScheduleId, recipient: target.recipientName, scheduledFor: reporteiScheduleData.scheduledFor, attachment: false, channels: ['reportei'], range });
          }
          continue;
        }
        const reports = {};
        for (const descriptor of channels) {
          try {
            reports[descriptor.channel] = descriptor.channel === 'meta'
              ? await weeklyFetchMetaSummary(t, descriptor.accountId, range)
              : await weeklyFetchGoogleSummary(t, descriptor.accountId, range);
          } catch (error) {
            result.errors.push({ clientId: client.id, client: clientName, error: (descriptor.channel === 'meta' ? 'Meta Ads: ' : 'Google Ads: ') + error.message });
          }
        }
        const renderedChannels = channels.filter(descriptor => reports[descriptor.channel]);
        if (!renderedChannels.length) continue;
        let pdf = null;
        if (rule.attachPdf) {
          if (!browser) browser = await weeklyLaunchBrowser();
          try {
            let identity = weeklyClientReportIdentity(t, client);
            const meta = renderedChannels.find(item => item.channel === 'meta');
            if (meta) identity = await weeklyIdentityWithCreativeThumbnail(t, meta.accountId, identity);
            pdf = await weeklyRenderPdf(t, browser, client, renderedChannels, range, weekKey, identity, { includeFormLeads: rule.includeFormLeads });
          } catch (error) {
            result.errors.push({ clientId: client.id, client: clientName, error: 'PDF: ' + error.message });
            continue;
          }
        }
        const message = weeklyMessageForReports(client, reports, rule);
        if (dryRun) {
          if (pdf) {
            try { fs.unlinkSync(pdf.filePath); } catch (_) {}
          }
          result.created.push({ clientId: client.id, client: clientName, preview: true, recipient: target.recipientName, bytes: pdf ? pdf.bytes : 0, attachment: !!pdf, channels: renderedChannels.map(item => item.channel), range });
          continue;
        }
        const scheduleData = {
          recipientType: target.recipientType,
          recipientId: target.recipientId,
          recipientName: target.recipientName,
          message,
          scheduledFor: replacement ? Number(replacement.scheduledFor) : weeklyNextFreeDispatchAt(nextMonday.at, existingSchedules),
          documentPath: pdf ? pdf.filePath : null,
          documentName: pdf ? pdf.fileName : null,
          quickReplies: [],
          bulkId: scheduleBulkId,
          connectionId: connection.connectionId
        };
        if (replacement) {
          t.db.updateSchedule(replacement.id, scheduleData);
          existingSchedules = existingSchedules.map(schedule => String(schedule.id) === String(replacement.id) ? { ...schedule, ...scheduleData } : schedule);
          result.updated.push({ clientId: client.id, client: clientName, scheduleId: replacement.id, recipient: target.recipientName, scheduledFor: scheduleData.scheduledFor, pdfBytes: pdf ? pdf.bytes : 0, attachment: !!pdf, channels: renderedChannels.map(item => item.channel), range });
        } else {
          const scheduleId = t.db.createSchedule(scheduleData);
          existingSchedules = existingSchedules.concat([{ ...scheduleData, id: scheduleId }]);
          result.created.push({ clientId: client.id, client: clientName, scheduleId, recipient: target.recipientName, scheduledFor: scheduleData.scheduledFor, pdfBytes: pdf ? pdf.bytes : 0, attachment: !!pdf, channels: renderedChannels.map(item => item.channel), range });
        }
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    if (!dryRun) {
      result.reflowed = weeklyReflowBatchSchedules(t, weekKey, nextMonday.at, existingSchedules);
      const cfg = t.db.getConfig() || {};
      const previousRuns = Array.isArray(cfg.weeklyReportRuns) ? cfg.weeklyReportRuns : [];
      const runLog = {
        weekKey, range: defaultRange, at: Date.now(), trigger: result.trigger,
        created: result.created.length, updated: result.updated.length,
        skipped: result.skipped.length, errors: result.errors.length, reflowed: result.reflowed
      };
      t.db.updateConfig({ weeklyReportRuns: [runLog].concat(previousRuns.filter(run => run && run.weekKey !== weekKey)).slice(0, 20) });
    }
    console.log('[weekly-reports] ' + JSON.stringify({ weekKey, created: result.created.length, updated: result.updated.length, skipped: result.skipped.length, errors: result.errors.length }));
    return result;
  };
  weeklyReportRunPromise = execute();
  try {
    return await weeklyReportRunPromise;
  } finally {
    weeklyReportRunPromise = null;
  }
}
// ─── Automação "Mensagens Quarta" (checkin_message) ────────────────────────
// Feriados nacionais: BrasilAPI é pública e não exige chave. Cache simples em
// memória por ano — não vale a pena persistir isso no banco.
const _brHolidaysCache = {};
async function fetchBrazilHolidays(year) {
  const cached = _brHolidaysCache[year];
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.list;
  try {
    const r = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
    if (!r.ok) throw new Error('status ' + r.status);
    const list = await r.json();
    _brHolidaysCache[year] = { at: Date.now(), list: Array.isArray(list) ? list : [] };
    return _brHolidaysCache[year].list;
  } catch (error) {
    console.warn('[send-automations] Falha ao buscar feriados:', error.message);
    return cached ? cached.list : [];
  }
}
async function holidayWithinDays(referenceAt, days) {
  const todayIso = weeklyIsoDateInTimeZone(referenceAt, WEEKLY_REPORT_TIME_ZONE);
  const year = Number(todayIso.slice(0, 4));
  const limitIso = weeklyShiftIsoDate(todayIso, days);
  const lists = await Promise.all([fetchBrazilHolidays(year), fetchBrazilHolidays(year + 1)]);
  const all = lists[0].concat(lists[1]);
  return all.find(h => h && h.date >= todayIso && h.date <= limitIso) || null;
}
async function generateCheckinMessage(apiKey, { clientName, baseMessage, previous, holiday }) {
  const systemPrompt = [
    'Você escreve mensagens curtas de WhatsApp em português, de uma agência de marketing pra seus clientes.',
    'Mantenha o mesmo tom, estrutura e objetivo da mensagem de referência abaixo, mas reescreva com palavras diferentes — nunca repita literalmente a redação usada nas últimas semanas.',
    'Não use markdown. Pode usar emojis pontuais como na referência. Responda só com o texto final da mensagem, sem comentários extras.',
    '',
    'Mensagem de referência:',
    baseMessage
  ].join('\n');
  const holidayNote = holiday
    ? `Atenção: há um feriado (${holiday.name}, ${holiday.date}) nos próximos dias. Em vez de pedir feedback/solicitações, escreva um aviso cordial de que a demanda pode cair nesse período por causa do feriado.`
    : '';
  const previousNote = previous.length
    ? 'Mensagens já enviadas nas últimas semanas (não repita a redação, varie de verdade):\n- ' + previous.join('\n- ')
    : '';
  const userPrompt = ['Cliente: ' + clientName, holidayNote, previousNote, 'Escreva a mensagem agora.'].filter(Boolean).join('\n\n');
  const text = await callAnthropicApi(apiKey, [{ role: 'user', content: userPrompt }], systemPrompt);
  return String(text || '').trim() || baseMessage.replace(/\[\s*nome(\s*do\s*cliente)?\s*\]/i, clientName);
}
async function runCheckinMessageAutomation(t, automation) {
  const result = { ok: true, trigger: 'auto', created: [], skipped: [], errors: [] };
  const cfg = t.db.getConfig() || {};
  const apiKey = cfg.anthropicApiKey;
  if (!apiKey) {
    result.ok = false;
    result.errors.push({ error: 'IA não configurada — cole uma chave da Anthropic em Configurações → IA.' });
    return result;
  }
  const baseMessage = String((automation.config && automation.config.baseMessage) || '').trim();
  if (!baseMessage) {
    result.ok = false;
    result.errors.push({ error: 'Mensagem-base não configurada nesta automação.' });
    return result;
  }
  const checkHolidays = !automation.config || automation.config.checkHolidays !== false;
  const holiday = checkHolidays ? await holidayWithinDays(new Date(), 5) : null;
  const allClients = getClientAreaClients(t);
  const wanted = new Set((automation.clientIds || []).map(String));
  const clients = allClients.filter(c => wanted.has(String(c.id)));
  const history = automation.history && typeof automation.history === 'object' ? automation.history : {};
  for (const client of clients) {
    const clientName = String(client.name || client.id || 'Cliente');
    try {
      const target = weeklyTargetForClient(t, client);
      if (!target) { result.skipped.push({ clientId: client.id, client: clientName, reason: 'sem grupo ou número WhatsApp CRM utilizável' }); continue; }
      const connection = await weeklyConnectionForTarget(t, target);
      if (connection.error) { result.skipped.push({ clientId: client.id, client: clientName, reason: connection.error }); continue; }
      const previous = Array.isArray(history[client.id]) ? history[client.id].slice(-4) : [];
      const message = await generateCheckinMessage(apiKey, { clientName, baseMessage, previous, holiday });
      const scheduleData = {
        recipientType: target.recipientType,
        recipientId: target.recipientId,
        recipientName: target.recipientName,
        message,
        scheduledFor: Date.now(),
        quickReplies: [],
        bulkId: 'checkin:' + automation.id + ':' + weeklyIsoDateInTimeZone(new Date(), WEEKLY_REPORT_TIME_ZONE),
        connectionId: connection.connectionId
      };
      const scheduleId = t.db.createSchedule(scheduleData);
      history[client.id] = previous.concat([message]).slice(-6);
      result.created.push({ clientId: client.id, client: clientName, scheduleId, recipient: target.recipientName, holiday: !!holiday });
    } catch (error) {
      result.errors.push({ clientId: client.id, client: clientName, error: error.message });
    }
  }
  automation.history = history;
  automation.lastRunAt = Date.now();
  return result;
}

// ─── Tick do motor de envio: decide quem dispara a cada minuto ────────────
function sendAutomationIsDue(automation, referenceAt) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: WEEKLY_REPORT_TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(referenceAt);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const sched = automation.schedule || {};
  return weekdayMap[map.weekday] === Number(sched.weekday) && Number(map.hour) === Number(sched.hour) && Number(map.minute) === Number(sched.minute);
}
async function runSendAutomationsTick() {
  // Esse tick roda (via cron.schedule global) em TODOS os processos, mas o motor de envio
  // só faz sentido rodar de verdade no processo que É o virandoachave — senão cada um dos
  // outros 14 processos ficava plantando um TenantState('virandoachave') em si mesmo, e o
  // watchdog do WhatsApp Lite (que varre tenants.values()) passava a tentar gerenciar a
  // mesma sessão a partir de 15 processos ao mesmo tempo.
  if (ownClientId() !== 'virandoachave') return;
  const t = getTenant('virandoachave');
  const automations = getSendAutomations(t);
  const now = new Date();
  const todayKey = weeklyIsoDateInTimeZone(now, WEEKLY_REPORT_TIME_ZONE);
  let changed = false;
  for (const automation of automations) {
    if (!automation.active) continue;
    if (automation.lastRunWeekKey === todayKey) continue;
    if (!sendAutomationIsDue(automation, now)) continue;
    automation.lastRunWeekKey = todayKey;
    changed = true;
    try {
      if (automation.type === 'ads_weekly_report') {
        await runWeeklyReports(t, { trigger: 'cron', clientIds: automation.clientIds || [], overrides: automation.overrides || {} });
      } else if (automation.type === 'checkin_message') {
        await runCheckinMessageAutomation(t, automation);
      }
    } catch (error) {
      console.error(`[send-automations] Falha ao rodar "${automation.name}":`, error.message);
    }
  }
  if (changed) saveSendAutomations(t, automations);
}

app.post('/api/admin/weekly-reports/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const t = getTenant('virandoachave');
    const adsAutomation = getSendAutomations(t).find(a => a.type === 'ads_weekly_report');
    const opts = {
      dryRun: !!body.dryRun,
      force: !!body.force,
      onlyClientId: body.clientId || '',
      overrides: adsAutomation ? adsAutomation.overrides : {},
      trigger: 'manual'
    };
    if (body.range && body.range.cur && body.range.cur.since && body.range.cur.until) opts.range = body.range;
    if (Array.isArray(body.clientIds) && body.clientIds.length) opts.clientIds = body.clientIds;
    const result = await runWeeklyReports(t, opts);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/admin/weekly-reports/status', requireAuth, requireAdmin, (req, res) => {
  const cfg = getTenant('virandoachave').db.getConfig() || {};
  res.json({ running: !!weeklyReportRunPromise, runs: Array.isArray(cfg.weeklyReportRuns) ? cfg.weeklyReportRuns : [] });
});

// ─── Motor de envio: rotas de administração das automações ────────────────
function requireVacAdmin(req, res, next) {
  if (req.clientId !== 'virandoachave') return res.status(403).json({ error: 'Disponível apenas na conta da agência.' });
  next();
}
app.get('/api/admin/send-automations', requireAuth, requireAdmin, requireVacAdmin, (req, res) => {
  const t = getTenant('virandoachave');
  res.json({ automations: getSendAutomations(t), aiConfigured: !!(t.db.getConfig() || {}).anthropicApiKey });
});
app.post('/api/admin/send-automations', requireAuth, requireAdmin, requireVacAdmin, (req, res) => {
  const t = getTenant('virandoachave');
  const body = req.body || {};
  const type = body.type === 'checkin_message' || body.type === 'ads_weekly_report' ? body.type : null;
  if (!type) return res.status(400).json({ error: 'Tipo de automação inválido.' });
  const automations = getSendAutomations(t);
  const automation = {
    id: genSendAutomationId(),
    type,
    name: String(body.name || (type === 'checkin_message' ? 'Nova automação' : 'Relatório de Ads')).slice(0, 120),
    active: !!body.active,
    schedule: sanitizeSendAutomationSchedule(body.schedule),
    clientIds: Array.isArray(body.clientIds) ? body.clientIds.map(String) : [],
    overrides: {},
    config: type === 'checkin_message' ? { baseMessage: String(body.baseMessage || '').slice(0, 2000), checkHolidays: body.checkHolidays !== false } : {},
    lastRunWeekKey: '',
    history: {}
  };
  automations.push(automation);
  saveSendAutomations(t, automations);
  res.json({ automation });
});
app.put('/api/admin/send-automations/:id', requireAuth, requireAdmin, requireVacAdmin, (req, res) => {
  const t = getTenant('virandoachave');
  const automations = getSendAutomations(t);
  const automation = automations.find(a => a.id === req.params.id);
  if (!automation) return res.status(404).json({ error: 'Automação não encontrada.' });
  const body = req.body || {};
  if (body.name !== undefined) automation.name = String(body.name).slice(0, 120);
  if (body.active !== undefined) automation.active = !!body.active;
  if (body.schedule !== undefined) automation.schedule = sanitizeSendAutomationSchedule(body.schedule);
  if (body.clientIds !== undefined) automation.clientIds = Array.isArray(body.clientIds) ? body.clientIds.map(String) : [];
  if (body.overrides !== undefined && automation.type === 'ads_weekly_report') automation.overrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
  if (automation.type === 'checkin_message') {
    automation.config = automation.config && typeof automation.config === 'object' ? automation.config : {};
    if (body.baseMessage !== undefined) automation.config.baseMessage = String(body.baseMessage).slice(0, 2000);
    if (body.checkHolidays !== undefined) automation.config.checkHolidays = !!body.checkHolidays;
  }
  saveSendAutomations(t, automations);
  res.json({ automation });
});
app.delete('/api/admin/send-automations/:id', requireAuth, requireAdmin, requireVacAdmin, (req, res) => {
  const t = getTenant('virandoachave');
  const automations = getSendAutomations(t).filter(a => a.id !== req.params.id);
  saveSendAutomations(t, automations);
  res.json({ ok: true });
});
app.post('/api/admin/send-automations/:id/run-now', requireAuth, requireAdmin, requireVacAdmin, async (req, res) => {
  const t = getTenant('virandoachave');
  const automations = getSendAutomations(t);
  const automation = automations.find(a => a.id === req.params.id);
  if (!automation) return res.status(404).json({ error: 'Automação não encontrada.' });
  try {
    let result;
    if (automation.type === 'ads_weekly_report') {
      result = await runWeeklyReports(t, { trigger: 'manual', clientIds: automation.clientIds || [], overrides: automation.overrides || {} });
    } else {
      result = await runCheckinMessageAutomation(t, automation);
      saveSendAutomations(t, automations); // persiste o history atualizado (variação de texto)
    }
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function saveClientAreaClients(t, clients) { const a = getClientAreaObj(t); t.db.updateConfig({ clientArea: { clients, avulsas: a.avulsas } }); }
function saveClientAreaAvulsas(t, avulsas) { const a = getClientAreaObj(t); t.db.updateConfig({ clientArea: { clients: a.clients, avulsas } }); }
// ─── Histórico de atividades do cliente (Área de Clientes) ────────────────
// Cada cliente guarda seu próprio "quem fez o quê e quando" — nada a ver com o
// taskLog abaixo, que é do tenant inteiro e só alimenta o relatório de tarefas.
const CLIENT_ACTIVITY_MAX = 1000;
const CLIENT_ACTIVITY_TYPES = new Set(['client', 'status', 'group', 'task', 'note', 'doc', 'link', 'monitor', 'meta', 'google', 'message', 'senha']);
function logActivity(client, req, type, summary) {
  if (!client || !summary) return;
  if (!Array.isArray(client.activity)) client.activity = [];
  client.activity.push({
    id: 'act-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    by: (req.user && (req.user.name || req.user.id)) || 'sistema',
    type: CLIENT_ACTIVITY_TYPES.has(type) ? type : 'client',
    summary: String(summary).slice(0, 300)
  });
  if (client.activity.length > CLIENT_ACTIVITY_MAX) client.activity = client.activity.slice(-CLIENT_ACTIVITY_MAX);
}
const TASK_STATUS_LABEL = { fazer: 'A fazer', progresso: 'Em progresso', feito: 'Feito' };
function diffClientActivity(oldC, newC) {
  const out = [];
  if (!oldC) return out;
  if ((oldC.name || '') !== (newC.name || '')) out.push({ type: 'client', summary: `Nome alterado: "${oldC.name || ''}" → "${newC.name || ''}"` });
  if ((oldC.group || '') !== (newC.group || '')) out.push({ type: 'group', summary: `Grupo alterado: "${oldC.group || '(sem grupo)'}" → "${newC.group || '(sem grupo)'}"` });
  if ((oldC.status || '') !== (newC.status || '')) out.push({ type: 'status', summary: `Status alterado: "${oldC.status || '(sem status)'}" → "${newC.status || '(sem status)'}"` });
  // Tarefas: só o que importa (criada/excluída/status/responsável) — não cada campo.
  const oldTasks = Array.isArray(oldC.tasks) ? oldC.tasks : [];
  const newTasks = Array.isArray(newC.tasks) ? newC.tasks : [];
  const oldById = {}; oldTasks.forEach(t => { oldById[t.id] = t; });
  const seen = new Set();
  newTasks.forEach(nt => {
    seen.add(nt.id);
    const ot = oldById[nt.id];
    if (!ot) { out.push({ type: 'task', summary: `Tarefa criada: "${nt.title}"` }); return; }
    if ((ot.status || '') !== (nt.status || '')) out.push({ type: 'task', summary: `Tarefa "${nt.title}": ${TASK_STATUS_LABEL[ot.status] || ot.status} → ${TASK_STATUS_LABEL[nt.status] || nt.status}` });
    if ((ot.responsavel || '') !== (nt.responsavel || '')) out.push({ type: 'task', summary: `Tarefa "${nt.title}" atribuída a ${nt.responsavel || '(ninguém)'}` });
  });
  oldTasks.forEach(ot => { if (!seen.has(ot.id)) out.push({ type: 'task', summary: `Tarefa excluída: "${ot.title}"` }); });
  // Links
  const oldLinks = new Set((Array.isArray(oldC.links) ? oldC.links : []).map(l => l.url));
  const newLinks = new Set((Array.isArray(newC.links) ? newC.links : []).map(l => l.url));
  (newC.links || []).forEach(l => { if (!oldLinks.has(l.url)) out.push({ type: 'link', summary: `Link adicionado: ${l.label || l.url}` }); });
  (oldC.links || []).forEach(l => { if (!newLinks.has(l.url)) out.push({ type: 'link', summary: `Link removido: ${l.label || l.url}` }); });
  // Monitoramento (grupos/contatos)
  const oldMon = oldC.monitor || {}; const newMon = newC.monitor || {};
  ['groups', 'crmContacts'].forEach(kind => {
    const label = kind === 'groups' ? 'Grupo monitorado' : 'Contato monitorado';
    const oldIds = new Set((oldMon[kind] || []).map(x => x.id));
    const newIds = new Set((newMon[kind] || []).map(x => x.id));
    (newMon[kind] || []).forEach(x => { if (!oldIds.has(x.id)) out.push({ type: 'monitor', summary: `${label} adicionado: ${x.name || x.id}` }); });
    (oldMon[kind] || []).forEach(x => { if (!newIds.has(x.id)) out.push({ type: 'monitor', summary: `${label} removido: ${x.name || x.id}` }); });
  });
  // Contas de Ads
  if ((oldC.metaAccountId || '') !== (newC.metaAccountId || '')) {
    if (!oldC.metaAccountId) out.push({ type: 'meta', summary: 'Conta Meta Ads vinculada' });
    else if (!newC.metaAccountId) out.push({ type: 'meta', summary: 'Conta Meta Ads desvinculada' });
    else out.push({ type: 'meta', summary: 'Conta Meta Ads alterada' });
  }
  if ((oldC.googleAccountId || '') !== (newC.googleAccountId || '')) {
    if (!oldC.googleAccountId) out.push({ type: 'google', summary: 'Conta Google Ads vinculada' });
    else if (!newC.googleAccountId) out.push({ type: 'google', summary: 'Conta Google Ads desvinculada' });
    else out.push({ type: 'google', summary: 'Conta Google Ads alterada' });
  }
  if ((oldC.reporteiProjectId || '') !== (newC.reporteiProjectId || '')) {
    if (!oldC.reporteiProjectId) out.push({ type: 'reportei', summary: 'Projeto Reportei vinculado' });
    else if (!newC.reporteiProjectId) out.push({ type: 'reportei', summary: 'Projeto Reportei desvinculado' });
    else out.push({ type: 'reportei', summary: 'Projeto Reportei alterado' });
  }
  // Senhas — nunca loga o valor, só o serviço
  const oldSenhas = {}; (Array.isArray(oldC.senhas) ? oldC.senhas : []).forEach(s => { oldSenhas[s.id] = s; });
  const newSenhaIds = new Set();
  (Array.isArray(newC.senhas) ? newC.senhas : []).forEach(s => { newSenhaIds.add(s.id); if (!oldSenhas[s.id]) out.push({ type: 'senha', summary: `Senha adicionada: ${s.service || 'serviço'}` }); });
  (Array.isArray(oldC.senhas) ? oldC.senhas : []).forEach(s => { if (!newSenhaIds.has(s.id)) out.push({ type: 'senha', summary: `Senha removida: ${s.service || 'serviço'}` }); });
  return out;
}
function sanitizeClientTask(x) {
  const status = ['fazer', 'progresso', 'feito'].includes(String(x.status)) ? String(x.status) : (x.done ? 'feito' : 'fazer');
  return {
    id: x.id || ('tsk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    title: String(x.title || '').slice(0, 200),
    status,
    resultado: ['bom', 'medio', 'ruim', 'pausado'].includes(String(x.resultado)) ? String(x.resultado) : '',
    responsavel: String(x.responsavel || '').slice(0, 60),
    due: x.due ? Number(x.due) : null,
    startMin: (x.startMin === null || x.startMin === undefined || x.startMin === '') ? null : Math.max(0, Math.min(1439, Math.round(Number(x.startMin) || 0))),
    durMin: Math.max(5, Math.min(1440, Math.round(Number(x.durMin) || 30))),
    allDay: !!x.allDay,
    done: status === 'feito',
    recurring: !!x.recurring,
    recurrence: ['daily', 'weekly', 'biweekly', 'monthly'].includes(String(x.recurrence)) ? String(x.recurrence) : 'weekly',
    priority: ['baixa', 'normal', 'alta'].includes(String(x.priority)) ? String(x.priority) : '',
    // Última vez que a tarefa foi marcada como feita. Sobrevive à reabertura das
    // recorrentes — é o histórico, não o estado atual.
    doneAt: x.doneAt ? Number(x.doneAt) : null,
    doneCount: Math.max(0, Math.round(Number(x.doneCount) || 0)),
    notes: String(x.notes || '').slice(0, 500),
    subtasks: (Array.isArray(x.subtasks) ? x.subtasks : []).map(s => ({ id: s.id || ('sub-' + Math.random().toString(36).slice(2, 8)), title: String(s.title || '').slice(0, 200), done: !!s.done })),
    attachments: (Array.isArray(x.attachments) ? x.attachments : []).map(a => ({ id: a.id || ('att-' + Math.random().toString(36).slice(2, 8)), name: String(a.name || 'arquivo').slice(0, 200), url: String(a.url || '').slice(0, 500), mime: String(a.mime || '').slice(0, 100), size: Number(a.size) || 0 })).filter(a => a.url),
  };
}
// ===== Histórico de conclusões (alimenta o relatório de tarefas realizadas) =====
const TASK_LOG_MAX = 20000;
function getTaskLog(t) { const l = (t.db.getConfig() || {}).taskLog; return Array.isArray(l) ? l : []; }
function appendTaskLog(t, entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return;
  const log = getTaskLog(t).concat(list);
  t.db.updateConfig({ taskLog: log.length > TASK_LOG_MAX ? log.slice(-TASK_LOG_MAX) : log });
}
// Carimba a conclusão quando a tarefa ENTRA em 'feito' (transição, não estado).
// Devolve o registro para o log, ou null se não houve transição.
function stampTaskDone(oldTask, newTask, ctx) {
  const wasDone = !!(oldTask && oldTask.status === 'feito');
  const isDone = newTask.status === 'feito';
  if (!isDone || wasDone) {
    // preserva o histórico quando o corpo da requisição não trouxe os campos
    if (oldTask) {
      if (!newTask.doneAt && oldTask.doneAt) newTask.doneAt = Number(oldTask.doneAt);
      if (!newTask.doneCount && oldTask.doneCount) newTask.doneCount = Number(oldTask.doneCount);
    }
    return null;
  }
  const at = Date.now();
  newTask.doneAt = at;
  newTask.doneCount = (Number(oldTask && oldTask.doneCount) || 0) + 1;
  return {
    id: 'log-' + at.toString(36) + Math.random().toString(36).slice(2, 6),
    taskId: newTask.id,
    title: newTask.title,
    clientId: String((ctx && ctx.clientId) || ''),
    clientName: String((ctx && ctx.clientName) || ''),
    group: String((ctx && ctx.group) || ''),
    responsavel: newTask.responsavel || '',
    resultado: newTask.resultado || '',
    due: newTask.due || null,
    recurring: !!newTask.recurring,
    recurrence: newTask.recurring ? (newTask.recurrence || '') : '',
    doneAt: at,
    by: String((ctx && ctx.by) || ''),
  };
}
// Aplica stampTaskDone em uma lista inteira (usado nos PUTs que mandam o array todo)
function stampTaskList(oldTasks, newTasks, ctx) {
  const prev = {}; (oldTasks || []).forEach(tk => { if (tk && tk.id) prev[tk.id] = tk; });
  const logs = [];
  newTasks.forEach(tk => { const e = stampTaskDone(prev[tk.id], tk, ctx); if (e) logs.push(e); });
  return logs;
}
// Termômetro: conta mensagens ENVIADAS por nós ao grupo/contato monitorado nos últimos 7 dias
function computeClientHealth(t, client) {
  const m = client.monitor || {};
  const pluck = (arr) => (Array.isArray(arr) ? arr : []).map(x => (x && typeof x === 'object') ? x.id : x).filter(Boolean);
  const ids = [...pluck(m.groups), ...pluck(m.crmContacts)];
  if (!ids.length) return { status: 'unset', count: 0, lastAt: null };
  const { count, lastAt } = t.db.countOutboundMessagesSince(ids, Date.now() - 7 * 864e5);
  let status = 'red'; if (count >= 2) status = 'green'; else if (count === 1) status = 'yellow';
  return { status, count, lastAt };
}

// ===== Tarefas (board unificado) — MESMA base da Área do Cliente, organizado por grupo =====
// Espaço = grupo do cliente; cada cliente = um "ID"; tarefa = a mesma tarefa da Área do Cliente (2 vias).
// ═══════════════ Automacoes do Quadro de Tarefas ═══════════════
// Regra = gatilho (vencimento) + filtros + acoes (mudar status/prioridade, avisar no WhatsApp).
// Roda a cada 10 min. Aviso sai no maximo 1x por tarefa por dia, depois do horario configurado.

// Dia no fuso de Sao Paulo. O servidor roda em UTC; sem isso "vence hoje" viraria
// as 21h do dia anterior no horario de Brasilia.
function brDateKey(ts) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ts)); }
  catch (e) { return new Date(ts).toISOString().slice(0, 10); }
}
// "Hoje é sábado, 23/08/2026" no fuso de Brasília — usado pra IA do chatbot saber que dia
// é (sem isso ela não tem como saber, e regras tipo "só nos finais de semana" no contexto
// do negócio nunca funcionariam de verdade).
function brTodayLabel(ts) {
  try {
    const d = new Date(ts || Date.now());
    const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' }).format(d);
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
    return `${weekday}, ${date}`;
  } catch (e) { return ''; }
}
// Início/fim (epoch ms) de um dia no fuso de Sao Paulo. Brasil não tem mais horário de
// verão desde 2019, então -03:00 é fixo o ano inteiro.
function brDayBounds(dateKey) {
  const start = new Date(`${dateKey}T00:00:00-03:00`).getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}
function brNowHM() {
  try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
  catch (e) { return '00:00'; }
}
// Mesma coisa que brNowHM, mas pra um timestamp qualquer (nao so "agora") — usado pro
// dashboard mostrar a hora exata que um lead entrou numa coluna, ou o pico de mensagens.
function brHM(ts) {
  try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)); }
  catch (e) { return '00:00'; }
}
function brHour(ts) {
  try { return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date(ts)), 10) % 24; }
  catch (e) { return 0; }
}
function dayKeyDiff(fromKey, toKey) {
  const a = Date.UTC(+fromKey.slice(0, 4), +fromKey.slice(5, 7) - 1, +fromKey.slice(8, 10));
  const b = Date.UTC(+toKey.slice(0, 4), +toKey.slice(5, 7) - 1, +toKey.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

const AUTOM_MAX_NOTIFY_PER_RUN = 30; // trava de seguranca contra disparo em massa

function sanitizeTaskAutomation(x) {
  x = x || {};
  const tg = x.trigger || {};
  const ac = x.actions || {};
  const nt = ac.notify || {};
  return {
    id: String(x.id || '').trim() || ('aut-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    name: String(x.name || '').slice(0, 120) || 'Automacao sem nome',
    enabled: x.enabled !== false,
    trigger: {
      type: ['due_today', 'overdue', 'due_in'].includes(String(tg.type)) ? String(tg.type) : 'due_today',
      days: Math.max(1, Math.min(60, Math.round(Number(tg.days) || 1))),
    },
    filters: {
      group: String((x.filters || {}).group || '').slice(0, 60),
      responsavel: String((x.filters || {}).responsavel || '').slice(0, 60),
      titleContains: String((x.filters || {}).titleContains || '').slice(0, 120),
      includeDone: !!(x.filters || {}).includeDone,
    },
    actions: {
      setPriority: ['baixa', 'normal', 'alta'].includes(String(ac.setPriority)) ? String(ac.setPriority) : '',
      setStatus: ['fazer', 'progresso'].includes(String(ac.setStatus)) ? String(ac.setStatus) : '',
      notify: {
        enabled: !!nt.enabled,
        to: nt.to === 'fixo' ? 'fixo' : 'responsavel',
        number: String(nt.number || '').replace(/[^\d]/g, '').slice(0, 15),
        connectionId: String(nt.connectionId || 'lite').slice(0, 20),
        message: String(nt.message || '').slice(0, 600) || 'Lembrete: a tarefa *{{tarefa}}* do cliente *{{cliente}}* vence em {{vencimento}}.',
      },
    },
    runAt: /^\d{2}:\d{2}$/.test(String(x.runAt)) ? String(x.runAt) : '09:00',
    lastRunAt: x.lastRunAt || null,
    runCount: Number(x.runCount) || 0,
  };
}

function getTaskAutomations(t) {
  const c = (t.db.getConfig() || {}).taskAutomations || {};
  return {
    rules: (Array.isArray(c.rules) ? c.rules : []).map(sanitizeTaskAutomation),
    contacts: (c.contacts && typeof c.contacts === 'object') ? c.contacts : {},
    sent: (c.sent && typeof c.sent === 'object') ? c.sent : {},
    log: Array.isArray(c.log) ? c.log : [],
  };
}
function saveTaskAutomations(t, cfg) { t.db.updateConfig({ taskAutomations: cfg }); }

// Percorre todas as tarefas (clientes + avulsas) num formato uniforme.
function allBoardTasks(area) {
  const out = [];
  for (const c of (area.clients || [])) {
    for (const tk of (c.tasks || [])) out.push({ task: tk, client: c, avulsa: false });
  }
  for (const tk of (area.avulsas || [])) out.push({ task: tk, client: { id: '__avulsas', name: 'Tarefa avulsa', group: '' }, avulsa: true });
  return out;
}

function automationMatches(rule, entry, todayKey) {
  const tk = entry.task;
  if (!tk.due) return null;
  if (!rule.filters.includeDone && tk.status === 'feito') return null;
  const f = rule.filters;
  if (f.group && String(entry.client.group || '') !== f.group) return null;
  if (f.responsavel && String(tk.responsavel || '').toLowerCase() !== f.responsavel.toLowerCase()) return null;
  if (f.titleContains && String(tk.title || '').toLowerCase().indexOf(f.titleContains.toLowerCase()) < 0) return null;
  // atraso positivo = venceu ha N dias; negativo = vence daqui a N dias
  const atraso = dayKeyDiff(brDateKey(Number(tk.due)), todayKey);
  const tp = rule.trigger.type;
  if (tp === 'due_today' && atraso !== 0) return null;
  if (tp === 'overdue' && atraso < rule.trigger.days) return null;
  if (tp === 'due_in' && atraso !== -rule.trigger.days) return null;
  return { atraso };
}

function renderAutomationMessage(tplStr, entry, atraso) {
  const tk = entry.task;
  const venc = tk.due ? new Date(Number(tk.due)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
  return String(tplStr || '')
    .replace(/\{\{\s*tarefa\s*\}\}/gi, tk.title || '')
    .replace(/\{\{\s*cliente\s*\}\}/gi, entry.client.name || '')
    .replace(/\{\{\s*grupo\s*\}\}/gi, entry.client.group || '')
    .replace(/\{\{\s*responsavel\s*\}\}/gi, tk.responsavel || '')
    .replace(/\{\{\s*vencimento\s*\}\}/gi, venc)
    .replace(/\{\{\s*dias\s*\}\}/gi, String(Math.abs(atraso)))
    .replace(/\{\{\s*notas\s*\}\}/gi, tk.notes || '');
}

async function evalTaskAutomations(t, opts) {
  opts = opts || {};
  const dry = !!opts.dryRun;
  const cfg = getTaskAutomations(t);
  const rules = cfg.rules.filter(r => (opts.ruleId ? r.id === opts.ruleId : r.enabled));
  const preview = [];
  if (!rules.length) return { rules: 0, matched: 0, changed: 0, notified: 0, preview };

  const area = getClientAreaObj(t);
  const entries = allBoardTasks(area);
  const todayKey = brDateKey(Date.now());
  const nowHM = brNowHM();
  let changed = 0, notified = 0, dirty = false;

  for (const rule of rules) {
    const podeAvisar = opts.ruleId ? true : nowHM >= rule.runAt; // no teste manual ignora o horario
    for (const entry of entries) {
      const hit = automationMatches(rule, entry, todayKey);
      if (!hit) continue;
      const tk = entry.task;
      const item = { rule: rule.name, cliente: entry.client.name, tarefa: tk.title, responsavel: tk.responsavel || '', atraso: hit.atraso, acoes: [] };

      if (rule.actions.setPriority && tk.priority !== rule.actions.setPriority) {
        item.acoes.push('prioridade -> ' + rule.actions.setPriority);
        if (!dry) { tk.priority = rule.actions.setPriority; dirty = true; changed++; }
      }
      if (rule.actions.setStatus && tk.status !== rule.actions.setStatus) {
        item.acoes.push('status -> ' + rule.actions.setStatus);
        if (!dry) { tk.status = rule.actions.setStatus; tk.done = false; dirty = true; changed++; }
      }

      if (rule.actions.notify.enabled) {
        const chave = rule.id + '|' + tk.id + '|' + todayKey;
        const jaAvisou = !!cfg.sent[chave];
        const nt = rule.actions.notify;
        const destino = nt.to === 'fixo'
          ? normalizePhoneNumber(nt.number)
          : normalizePhoneNumber(cfg.contacts[String(tk.responsavel || '').toUpperCase()] || '');
        const texto = renderAutomationMessage(nt.message, entry, hit.atraso);
        if (!destino) item.acoes.push('AVISO SEM NUMERO (responsavel "' + (tk.responsavel || '-') + '" nao mapeado)');
        else if (jaAvisou) item.acoes.push('aviso ja enviado hoje');
        else if (!podeAvisar) item.acoes.push('aviso so a partir das ' + rule.runAt);
        else if (dry) item.acoes.push('avisaria ' + destino + ': "' + texto.slice(0, 80) + '"');
        else if (notified >= AUTOM_MAX_NOTIFY_PER_RUN) item.acoes.push('limite de ' + AUTOM_MAX_NOTIFY_PER_RUN + ' avisos por rodada atingido');
        else {
          const digits = normalizeBrazilianMobileDigits(destino) || destino;
          try {
            await sendAutoReplyText(t, digits + '@s.whatsapp.net', digits, texto, nt.connectionId || 'lite');
            cfg.sent[chave] = Date.now();
            notified++; dirty = true;
            item.acoes.push('avisado ' + digits);
          } catch (e) {
            item.acoes.push('FALHA no aviso: ' + (e && e.message || e));
          }
        }
      }

      if (item.acoes.length) preview.push(item);
    }
    if (!dry) { rule.lastRunAt = Date.now(); rule.runCount = (rule.runCount || 0) + 1; }
  }

  if (!dry && dirty) {
    saveClientAreaClients(t, area.clients);
    saveClientAreaAvulsas(t, area.avulsas);
    // poda o anti-repeticao: guarda so os ultimos 30 dias
    const corte = Date.now() - 30 * 86400000;
    for (const k of Object.keys(cfg.sent)) if (Number(cfg.sent[k]) < corte) delete cfg.sent[k];
    cfg.log = [{ at: Date.now(), changed, notified, itens: preview.slice(0, 40) }].concat(cfg.log).slice(0, 30);
    cfg.rules = cfg.rules.map(r => (rules.find(x => x.id === r.id) || r));
    saveTaskAutomations(t, cfg);
  }
  return { rules: rules.length, matched: preview.length, changed, notified, preview };
}

let _automScanRodando = false;
async function runTaskAutomationScan() {
  if (_automScanRodando) return;
  _automScanRodando = true;
  try {
    try { const cs = loadClients(); const own = cs.find(c => c.admin && !c.ownerClientId) || cs[0]; if (own) getTenant(own.id); } catch (e) {}
    for (const t of tenants.values()) {
      try { await evalTaskAutomations(t, {}); }
      catch (e) { console.log('[automacoes]', t.clientId, '-', e && e.message); }
    }
  } finally { _automScanRodando = false; }
}
setInterval(() => { void runTaskAutomationScan(); }, 10 * 60 * 1000);
setTimeout(() => { void runTaskAutomationScan(); }, 45000);

app.get('/api/tarefas/automations', requireAuth, (req, res) => {
  const cfg = getTaskAutomations(getTenant(req.clientId));
  res.json({ rules: cfg.rules, contacts: cfg.contacts, log: cfg.log.slice(0, 10) });
});
app.post('/api/tarefas/automations', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = getTaskAutomations(t);
  const rule = sanitizeTaskAutomation(req.body || {});
  const i = cfg.rules.findIndex(r => r.id === rule.id);
  if (i >= 0) { rule.lastRunAt = cfg.rules[i].lastRunAt; rule.runCount = cfg.rules[i].runCount; cfg.rules[i] = rule; }
  else cfg.rules.unshift(rule);
  saveTaskAutomations(t, cfg);
  res.json({ ok: true, rule });
});
app.delete('/api/tarefas/automations/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = getTaskAutomations(t);
  cfg.rules = cfg.rules.filter(r => r.id !== req.params.id);
  saveTaskAutomations(t, cfg);
  res.json({ ok: true, rules: cfg.rules });
});
app.put('/api/tarefas/automations-contacts', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = getTaskAutomations(t);
  const out = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    const nome = String(k || '').trim().toUpperCase().slice(0, 60);
    const num = String(v || '').replace(/[^\d]/g, '').slice(0, 15);
    if (nome && num) out[nome] = num;
  }
  cfg.contacts = out;
  saveTaskAutomations(t, cfg);
  res.json({ ok: true, contacts: out });
});
// Simulacao: mostra o que aconteceria, sem mudar nada e sem mandar WhatsApp.
app.post('/api/tarefas/automations/:id/preview', requireAuth, async (req, res) => {
  try { res.json(await evalTaskAutomations(getTenant(req.clientId), { dryRun: true, ruleId: req.params.id })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Execucao manual de uma regra, pra valer.
app.post('/api/tarefas/automations/:id/run', requireAuth, async (req, res) => {
  try { res.json(await evalTaskAutomations(getTenant(req.clientId), { ruleId: req.params.id })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tarefas/board', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const area = getClientAreaObj(t);
  const restricted = !!clientAreaAllowedGroups(req);
  const clients = filterClientsByGroupPermission(req, area.clients || []);
  const avulsas = restricted ? [] : (area.avulsas || []); // avulsas não pertencem a grupo nenhum, então ficam fora do escopo de quem tem allowedGroups
  const allTemplates = getTaskTemplates(t);
  const templates = restricted ? Object.fromEntries(Object.entries(allTemplates).filter(([g]) => clientAreaAllowedGroups(req).includes(g))) : allTemplates;
  const groupSet = new Set();
  clients.forEach(c => { if (c.group) groupSet.add(c.group); });
  Object.keys(templates).forEach(g => { if (g) groupSet.add(g); });
  const groups = [...groupSet].sort((a, b) => String(a).localeCompare(String(b)));
  const semGrupo = clients.filter(c => !c.group).length;
  const out = clients.map(c => ({ id: c.id, name: c.name || '(sem nome)', group: c.group || '', status: c.status || '', resultado: c.resultado || '', due: c.due || null, priority: c.priority || '', comments: (c.notas || []).length, tasks: (c.tasks || []).map(sanitizeClientTask), health: computeClientHealth(t, c), facebook: c.facebook || '', google: c.google || '', saldo: c.saldo || '', empresa: c.empresa || '', segmento: c.segmento || '', responsavel: c.responsavel || '', updatedAt: c.updatedAt || 0 }));
  if (avulsas.length) out.push({ id: '__avulsas', name: 'Tarefas avulsas', group: '', tasks: avulsas.map(sanitizeClientTask), health: null });
  res.json({ groups, clients: out, semGrupo, templates });
});
app.post('/api/tarefas/task', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const task = sanitizeClientTask({ ...req.body, title: req.body?.title || 'Nova tarefa' });
  if (req.body?.clientId === '__avulsas') {
    if (clientAreaAllowedGroups(req)) return res.status(403).json({ error: 'Sem permissão para tarefas avulsas' });
    const area = getClientAreaObj(t); const avulsas = area.avulsas || [];
    avulsas.unshift(task); saveClientAreaAvulsas(t, avulsas); return res.json(task);
  }
  const clients = getClientAreaClients(t);
  const c = clients.find(x => x.id === String(req.body?.clientId || ''));
  if (!c) return res.status(404).json({ error: 'cliente não encontrado' });
  if (!clientAreaClientVisible(req, c)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  c.tasks = c.tasks || []; c.tasks.unshift(task);
  saveClientAreaClients(t, clients);
  res.json(task);
});
app.put('/api/tarefas/task/:taskId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const area = getClientAreaObj(t);
  const clients = area.clients || [];
  for (const c of clients) {
    const i = (c.tasks || []).findIndex(x => x.id === req.params.taskId);
    if (i >= 0) {
      if (!clientAreaClientVisible(req, c)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
      const _old = c.tasks[i]; const _new = sanitizeClientTask({ ...c.tasks[i], ...req.body, id: c.tasks[i].id }); const _log = stampTaskDone(_old, _new, { clientId: c.id, clientName: c.name, group: c.group, by: req.user.name || req.user.id }); if (_new.recurring && _new.status === 'feito' && _old.status !== 'feito') _new.due = advanceRecurringDue(_new.due, _new.recurrence); c.tasks[i] = _new; saveClientAreaClients(t, clients); appendTaskLog(t, [_log]); return res.json(c.tasks[i]);
    }
  }
  const avulsas = area.avulsas || [];
  const ai = avulsas.findIndex(x => x.id === req.params.taskId);
  if (ai >= 0) {
    if (clientAreaAllowedGroups(req)) return res.status(403).json({ error: 'Sem permissão para tarefas avulsas' });
    const _old = avulsas[ai]; const _new = sanitizeClientTask({ ...avulsas[ai], ...req.body, id: avulsas[ai].id }); const _log = stampTaskDone(_old, _new, { clientId: '__avulsas', clientName: 'Tarefas avulsas', group: '', by: req.user.name || req.user.id }); if (_new.recurring && _new.status === 'feito' && _old.status !== 'feito') _new.due = advanceRecurringDue(_new.due, _new.recurrence); avulsas[ai] = _new; saveClientAreaAvulsas(t, avulsas); appendTaskLog(t, [_log]); return res.json(avulsas[ai]);
  }
  res.status(404).json({ error: 'tarefa não encontrada' });
});
app.delete('/api/tarefas/task/:taskId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  for (const c of clients) {
    const i = (c.tasks || []).findIndex(x => x.id === req.params.taskId);
    if (i >= 0) {
      if (!clientAreaClientVisible(req, c)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
      c.tasks.splice(i, 1); saveClientAreaClients(t, clients); return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'tarefa não encontrada' });
});
app.put('/api/tarefas/client/:id/group', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'cliente não encontrado' });
  if (!clientAreaClientVisible(req, c)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  c.group = String(req.body?.group || '').slice(0, 60);
  // ao entrar num grupo, pode já puxar as tarefas padrão que ainda faltam
  let adicionadas = 0;
  if (c.group && req.body?.applyTemplate) {
    const tpl = getTaskTemplates(t)[c.group] || [];
    c.tasks = c.tasks || [];
    const existentes = new Set(c.tasks.map(tk => String(tk.title || '').trim().toLowerCase()));
    tpl.forEach(x => {
      const key = String(x.title || '').trim().toLowerCase();
      if (!key || existentes.has(key)) return;
      c.tasks.push(sanitizeClientTask({ ...x, status: 'fazer', due: null }));
      existentes.add(key); adicionadas++;
    });
  }
  saveClientAreaClients(t, clients);
  res.json({ ok: true, group: c.group, adicionadas, tasks: c.tasks || [] });
});
app.put('/api/tarefas/client/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const c = clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'cliente não encontrado' });
  if (!clientAreaClientVisible(req, c)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  const b = req.body || {};
  if ('status' in b) c.status = ['fazer', 'progresso', 'feito'].includes(String(b.status)) ? String(b.status) : (c.status || 'fazer');
  if ('resultado' in b) c.resultado = ['bom', 'medio', 'ruim', 'pausado'].includes(String(b.resultado)) ? String(b.resultado) : '';
  if ('priority' in b) c.priority = ['baixa', 'normal', 'alta'].includes(String(b.priority)) ? String(b.priority) : '';
  if ('due' in b) c.due = b.due ? Number(b.due) : null;
  const _S = (v, n) => String(v == null ? '' : v).slice(0, n);
  const _FBV = ['', 'otimizando', 'pausado', 'revisar', 'escala', 'sem_verba'];
  if ('facebook' in b) c.facebook = _FBV.includes(String(b.facebook)) ? String(b.facebook) : (c.facebook || '');
  if ('google' in b) c.google = _FBV.includes(String(b.google)) ? String(b.google) : (c.google || '');
  if ('saldo' in b) c.saldo = ['', 'ok', 'cartao', 'sem_saldo'].includes(String(b.saldo)) ? String(b.saldo) : (c.saldo || '');
  if ('empresa' in b) c.empresa = _S(b.empresa, 60);
  if ('segmento' in b) c.segmento = _S(b.segmento, 60);
  if ('responsavel' in b) c.responsavel = _S(b.responsavel, 40);
  c.updatedAt = Date.now();
  saveClientAreaClients(t, clients);
  res.json({ ok: true });
});

// ===== Relatório de tarefas realizadas =====
// Fonte: o log de conclusões (histórico completo, inclusive das recorrentes que já
// reabriram). O estado atual da tarefa não serve como relatório — ele se perde a cada ciclo.
app.get('/api/tarefas/relatorio', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const q = req.query || {};
  const dayStart = (s) => { const d = new Date(String(s) + 'T00:00:00'); return isNaN(d) ? null : d.getTime(); };
  const dayEnd = (s) => { const d = new Date(String(s) + 'T23:59:59.999'); return isNaN(d) ? null : d.getTime(); };
  const from = q.from ? dayStart(q.from) : null;
  const to = q.to ? dayEnd(q.to) : null;
  const norm = (s) => String(s || '').toLowerCase();
  const termo = norm(q.q);

  let rows = getTaskLog(t).filter(e => {
    if (from && Number(e.doneAt) < from) return false;
    if (to && Number(e.doneAt) > to) return false;
    if (q.group && String(e.group || '') !== String(q.group)) return false;
    if (q.clientId && String(e.clientId || '') !== String(q.clientId)) return false;
    if (q.responsavel && String(e.responsavel || '') !== String(q.responsavel)) return false;
    if (termo && !(norm(e.title).includes(termo) || norm(e.clientName).includes(termo))) return false;
    return true;
  });
  rows.sort((a, b) => Number(b.doneAt) - Number(a.doneAt));

  const fmtDate = (ms) => { const d = new Date(Number(ms)); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };

  if (String(q.format) === 'csv') {
    const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Data', 'Cliente', 'Grupo', 'Tarefa', 'Responsável', 'Resultado', 'Vencimento', 'Rotina', 'Concluído por'];
    const lines = [head.map(cell).join(';')].concat(rows.map(e => [
      fmtDate(e.doneAt), e.clientName, e.group, e.title, e.responsavel,
      ({ bom: 'Bom', medio: 'Médio', ruim: 'Ruim', pausado: 'Pausado' })[e.resultado] || '',
      e.due ? new Date(Number(e.due)).toLocaleDateString('pt-BR') : '',
      e.recurring ? ({ daily: 'Diária', weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal' })[e.recurrence] || 'Sim' : '',
      e.by,
    ].map(cell).join(';')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tarefas-realizadas.csv"');
    return res.send('﻿' + lines.join('\r\n'));
  }

  const bump = (obj, k) => { const key = k || '(sem)'; obj[key] = (obj[key] || 0) + 1; };
  const porResp = {}, porGrupo = {}, porCliente = {}, porDia = {};
  rows.forEach(e => {
    bump(porResp, e.responsavel);
    bump(porGrupo, e.group);
    bump(porCliente, e.clientName);
    bump(porDia, new Date(Number(e.doneAt)).toISOString().slice(0, 10));
  });
  const area = getClientAreaObj(t);
  res.json({
    total: rows.length,
    rows: rows.slice(0, Number(q.limit) || 1000),
    resumo: { porResp, porGrupo, porCliente, porDia },
    filtros: {
      grupos: [...new Set((area.clients || []).map(c => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      clientes: (area.clients || []).map(c => ({ id: c.id, name: c.name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
      responsaveis: [...new Set(getTaskLog(t).map(e => e.responsavel).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    },
  });
});

// ===== Tarefas padrão por grupo de negócio =====
function getTaskTemplates(t) { const v = (t.db.getConfig() || {}).taskTemplates; return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function saveTaskTemplates(t, tpl) { t.db.updateConfig({ taskTemplates: tpl }); }
function sanitizeTemplateTask(x) {
  return {
    title: String(x && x.title || '').slice(0, 200),
    responsavel: String(x && x.responsavel || '').slice(0, 60),
    recurring: !!(x && x.recurring),
    recurrence: ['daily', 'weekly', 'biweekly', 'monthly'].includes(String(x && x.recurrence)) ? String(x.recurrence) : 'monthly',
    priority: ['baixa', 'normal', 'alta'].includes(String(x && x.priority)) ? String(x.priority) : '',
    notes: String(x && x.notes || '').slice(0, 500),
  };
}
// Sugere um modelo olhando o que a maioria dos clientes do grupo já tem hoje
function suggestTemplates(t) {
  const area = getClientAreaObj(t);
  const byGroup = {};
  (area.clients || []).forEach(c => { if (!c.group) return; (byGroup[c.group] = byGroup[c.group] || []).push(c); });
  const out = {};
  Object.keys(byGroup).forEach(g => {
    const cs = byGroup[g]; const freq = {}; const sample = {};
    cs.forEach(c => (c.tasks || []).forEach(tk => {
      const k = String(tk.title || '').trim(); if (!k) return;
      freq[k] = (freq[k] || 0) + 1; if (!sample[k]) sample[k] = tk;
    }));
    const min = Math.max(2, Math.ceil(cs.length * 0.5));
    out[g] = Object.keys(freq).filter(k => freq[k] >= min)
      .sort((a, b) => freq[b] - freq[a])
      .map(k => sanitizeTemplateTask({ title: k, recurring: sample[k].recurring, recurrence: sample[k].recurrence, priority: sample[k].priority }));
  });
  return out;
}
app.get('/api/tarefas/templates', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const area = getClientAreaObj(t);
  const grupos = [...new Set((area.clients || []).map(c => c.group).filter(Boolean))];
  const templates = getTaskTemplates(t);
  Object.keys(templates).forEach(g => { if (!grupos.includes(g)) grupos.push(g); });
  res.json({ templates, grupos: grupos.sort((a, b) => a.localeCompare(b)), sugeridos: suggestTemplates(t) });
});
app.put('/api/tarefas/templates', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const b = req.body && req.body.templates;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'templates inválido' });
  const out = {};
  Object.keys(b).slice(0, 100).forEach(g => {
    const g2 = String(g).slice(0, 60); if (!g2) return;
    out[g2] = (Array.isArray(b[g]) ? b[g] : []).slice(0, 200).map(sanitizeTemplateTask).filter(x => x.title);
  });
  saveTaskTemplates(t, out);
  res.json({ ok: true, templates: out });
});
// Aplica o modelo do grupo em clientes existentes.
// mode 'missing' (padrão) só cria o que falta; 'all' recria tudo que o modelo tem.
app.post('/api/tarefas/templates/apply', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const templates = getTaskTemplates(t);
  const clients = getClientAreaClients(t);
  const b = req.body || {};
  const mode = b.mode === 'all' ? 'all' : 'missing';
  const onlyEmpty = !!b.onlyEmpty;
  let alvos = clients;
  if (Array.isArray(b.clientIds) && b.clientIds.length) alvos = clients.filter(c => b.clientIds.includes(c.id));
  else if (b.group) alvos = clients.filter(c => (c.group || '') === String(b.group));
  const result = [];
  alvos.forEach(c => {
    const tpl = templates[c.group || ''] || [];
    if (!tpl.length) return;
    c.tasks = c.tasks || [];
    if (onlyEmpty && c.tasks.length) return;
    const existentes = new Set(c.tasks.map(tk => String(tk.title || '').trim().toLowerCase()));
    let add = 0;
    tpl.forEach(x => {
      const key = String(x.title || '').trim().toLowerCase();
      if (mode === 'missing' && existentes.has(key)) return;
      if (existentes.has(key)) return; // nunca duplica título dentro do mesmo cliente
      c.tasks.push(sanitizeClientTask({ ...x, status: 'fazer', due: null }));
      existentes.add(key); add++;
    });
    if (add) result.push({ id: c.id, name: c.name, group: c.group, adicionadas: add });
  });
  saveClientAreaClients(t, clients);
  res.json({ ok: true, aplicados: result, total: result.reduce((n, r) => n + r.adicionadas, 0) });
});

app.get('/api/client-area', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const a = getClientAreaObj(t);
  const clients = filterClientsByGroupPermission(req, a.clients).map(c => ({ ...c, health: computeClientHealth(t, c) }));
  res.json({ clients, avulsas: a.avulsas });
});
app.put('/api/client-area-avulsas', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const _oldAv = {}; (getClientAreaObj(t).avulsas || []).forEach(tk => { _oldAv[tk.id] = tk; });
  const _logs = [];
  const avulsas = (Array.isArray(req.body?.avulsas) ? req.body.avulsas : []).map(tk => { const st = sanitizeClientTask(tk); const _o = _oldAv[st.id]; const _lg = stampTaskDone(_o, st, { clientId: '__avulsas', clientName: 'Tarefas avulsas', group: '', by: req.user.name || req.user.id }); if (_lg) _logs.push(_lg); if (st.recurring && st.status === 'feito' && (!_o || _o.status !== 'feito')) st.due = advanceRecurringDue(st.due, st.recurrence); return st; });
  saveClientAreaAvulsas(t, avulsas);
  appendTaskLog(t, _logs);
  res.json({ ok: true, avulsas });
});
app.post('/api/client-area', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const group = String(req.body?.group || '').slice(0, 60);
  const c = { id: 'cli-' + Date.now().toString(36), name: String(req.body?.name || 'Novo cliente').slice(0, 120), group, info: {}, docs: [], links: [], tasks: [], monitor: { groups: [], crmContacts: [] }, createdAt: Date.now(), updatedAt: Date.now() };
  // Grupo de negócio já traz as tarefas padrão — o cliente não precisa cadastrar na mão
  if (group && req.body?.applyTemplate !== false) {
    c.tasks = (getTaskTemplates(t)[group] || []).map(x => sanitizeClientTask({ ...x, status: 'fazer', due: null }));
  }
  logActivity(c, req, 'client', 'Cliente criado');
  clients.push(c); saveClientAreaClients(t, clients);
  res.json({ ...c, health: computeClientHealth(t, c), tarefasPadrao: c.tasks.length });
});
app.put('/api/client-area/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (!clientAreaClientVisible(req, clients[idx])) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  const b = req.body || {}; const next = { ...clients[idx] };
  const _prevMetaAccountId = clients[idx].metaAccountId, _prevPageId = clients[idx].pageId;
  if (typeof b.name === 'string') next.name = b.name.slice(0, 120);
  if ('group' in b) next.group = b.group ? String(b.group).slice(0, 60) : '';
  if ('status' in b) next.status = b.status ? String(b.status).slice(0, 60) : '';
  if (b.info && typeof b.info === 'object') next.info = b.info;
  if ('metaAccountId' in b) next.metaAccountId = b.metaAccountId ? String(b.metaAccountId).replace(/\D/g, '').slice(0, 30) : null;
  if ('googleAccountId' in b) next.googleAccountId = b.googleAccountId ? String(b.googleAccountId).replace(/\D/g, '').slice(0, 30) : null;
  if ('reporteiProjectId' in b) next.reporteiProjectId = b.reporteiProjectId ? String(b.reporteiProjectId).replace(/\D/g, '').slice(0, 30) : null;
  // Escolha por cliente de como o relatório semanal é enviado — 'sistema' (padrão) ou 'reportei'.
  if ('reportSource' in b) next.reportSource = b.reportSource === 'reportei' ? 'reportei' : 'sistema';
  if ('reportPrimaryMetric' in b) next.reportPrimaryMetric = ['leads', 'ecommerce'].includes(b.reportPrimaryMetric) ? b.reportPrimaryMetric : null;
  if ('pageId' in b) next.pageId = b.pageId ? String(b.pageId).replace(/\D/g, '').slice(0, 30) : null;
  if (Array.isArray(b.links)) next.links = b.links.map(l => ({ id: l.id || ('lnk-' + Math.random().toString(36).slice(2, 8)), label: String(l.label || '').slice(0, 80), url: String(l.url || '').slice(0, 500) })).filter(l => l.url || l.label);
  let _taskLogs = [];
  if (Array.isArray(b.tasks)) { const _oldT = {}; (clients[idx].tasks || []).forEach(tk => { _oldT[tk.id] = tk; }); next.tasks = b.tasks.map(tk => { const st = sanitizeClientTask(tk); const _o = _oldT[st.id]; const _lg = stampTaskDone(_o, st, { clientId: next.id, clientName: next.name, group: next.group, by: req.user.name || req.user.id }); if (_lg) _taskLogs.push(_lg); if (st.recurring && st.status === 'feito' && (!_o || _o.status !== 'feito')) st.due = advanceRecurringDue(st.due, st.recurrence); return st; }); }
  if (Array.isArray(b.metas)) next.metas = b.metas.map(m => ({ id: m.id || ('meta-' + Math.random().toString(36).slice(2, 8)), label: String(m.label || '').slice(0, 80), current: Number(m.current) || 0, target: Number(m.target) || 0 }));
  if (Array.isArray(b.senhas)) next.senhas = b.senhas.map(s => ({ id: s.id || ('pw-' + Math.random().toString(36).slice(2, 8)), service: String(s.service || '').slice(0, 80), login: String(s.login || '').slice(0, 120), password: String(s.password || '').slice(0, 200) }));
  if (Array.isArray(b.notas)) next.notas = b.notas.map(n => ({ id: n.id || ('nota-' + Math.random().toString(36).slice(2, 8)), text: String(n.text || '').slice(0, 1000), date: String(n.date || '').slice(0, 40), attachments: (Array.isArray(n.attachments) ? n.attachments : []).map(a => ({ id: a.id || ('att-' + Math.random().toString(36).slice(2, 8)), name: String(a.name || 'arquivo').slice(0, 200), url: String(a.url || '').slice(0, 500), mime: String(a.mime || '').slice(0, 100), size: Number(a.size) || 0 })).filter(a => a.url) }));
  if (b.emails && typeof b.emails === 'object') next.emails = { financeiro: String(b.emails.financeiro || '').slice(0, 200), relatorio: String(b.emails.relatorio || '').slice(0, 200), geral: String(b.emails.geral || '').slice(0, 200) };
  if (b.monitor && typeof b.monitor === 'object') {
    const cleanMon = (arr) => (Array.isArray(arr) ? arr : []).map(x => (x && typeof x === 'object') ? { id: String(x.id || ''), name: String(x.name || x.id || '').slice(0, 120) } : { id: String(x), name: String(x) }).filter(x => x.id);
    next.monitor = { groups: cleanMon(b.monitor.groups), crmContacts: cleanMon(b.monitor.crmContacts) };
  }
  next.updatedAt = Date.now();
  next.activity = Array.isArray(clients[idx].activity) ? clients[idx].activity : [];
  diffClientActivity(clients[idx], next).forEach(e => logActivity(next, req, e.type, e.summary));
  clients[idx] = next; saveClientAreaClients(t, clients);
  appendTaskLog(t, _taskLogs);
  res.json({ ...next, health: computeClientHealth(t, next) });
  // Assim que a conta/Página é vinculada (ou trocada) no cliente, tenta autorizar o
  // monitor_ads sozinho — fire-and-forget, não atrasa a resposta. Se a conta não estiver
  // ao alcance do Business Manager, só fica registrado no log; não trava nada pro usuário.
  if (next.metaAccountId && next.metaAccountId !== _prevMetaAccountId) {
    metaAutoShareAsset('account', next.metaAccountId).then(r => { if (!r.ok) console.warn(`[meta-autoshare] conta ${next.metaAccountId} (${next.name}):`, r.error); }).catch(() => {});
  }
  if (next.pageId && next.pageId !== _prevPageId) {
    metaAutoShareAsset('page', next.pageId).then(r => { if (!r.ok) console.warn(`[meta-autoshare] página ${next.pageId} (${next.name}):`, r.error); }).catch(() => {});
  }
});
app.delete('/api/client-area/:id', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const all = getClientAreaClients(t);
  const target = all.find(c => c.id === req.params.id);
  if (target && !clientAreaClientVisible(req, target)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  const clients = all.filter(c => c.id !== req.params.id);
  saveClientAreaClients(t, clients);
  res.json({ ok: true });
});
app.post('/api/client-area/:id/docs', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'not found' });
  if (!clientAreaClientVisible(req, client)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  let bb; try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  let responded = false; function reply(s, b) { if (responded) return; responded = true; res.status(s).json(b); }
  bb.on('file', (_f, fileStream, info) => {
    const { filename, mimeType } = info;
    if (!filename) { fileStream.resume(); return; }
    const ext = path.extname(filename) || '';
    const saveName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    const savePath = path.join(t.uploadsDir, saveName);
    const url = `/uploads/${t.clientId}/${saveName}`;
    const out = fs.createWriteStream(savePath); let size = 0;
    fileStream.on('data', d => size += d.length);
    fileStream.on('limit', () => { out.destroy(); fs.unlink(savePath, () => {}); reply(400, { error: 'Arquivo muito grande (máximo 200 MB)' }); });
    fileStream.pipe(out);
    out.on('finish', () => { createVideoDerivatives(savePath, mimeType); if (responded) return; if (!client.docs) client.docs = []; const entry = { id: 'doc-' + Date.now().toString(36), name: filename, url, mime: mimeType || '', size, uploadedAt: Date.now() }; client.docs.push(entry); logActivity(client, req, 'doc', 'Documento anexado: ' + filename); saveClientAreaClients(t, clients); reply(200, entry); });
    out.on('error', e => reply(500, { error: e.message }));
  });
  bb.on('finish', () => { if (!responded) reply(400, { error: 'Nenhum arquivo recebido' }); });
  bb.on('error', e => reply(500, { error: e.message }));
  req.pipe(bb);
});
app.post('/api/client-area/:id/comment', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'cliente nao encontrado' });
  if (!clientAreaClientVisible(req, client)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  const text = String(req.body?.text || '').slice(0, 1000);
  const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : []).map(a => ({ id: a.id || ('att-' + Math.random().toString(36).slice(2, 8)), name: String(a.name || 'arquivo').slice(0, 200), url: String(a.url || '').slice(0, 500), mime: String(a.mime || '').slice(0, 100), size: Number(a.size) || 0 })).filter(a => a.url);
  if (!text && !attachments.length) return res.status(400).json({ error: 'comentario vazio' });
  const nota = { id: 'nota-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, date: new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }), by: req.user.name || req.user.id, attachments };
  client.notas = client.notas || [];
  client.notas.unshift(nota);
  logActivity(client, req, 'note', 'Nota adicionada' + (text ? ': ' + text.slice(0, 80) : ''));
  saveClientAreaClients(t, clients);
  res.json(nota);
});
app.delete('/api/client-area/:id/docs/:docId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'not found' });
  if (!clientAreaClientVisible(req, client)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  const doc = (client.docs || []).find(d => d.id === req.params.docId);
  if (doc && doc.url) { const fp = path.join(t.uploadsDir, path.basename(doc.url)); if (fs.existsSync(fp)) fs.unlink(fp, () => {}); }
  if (doc) logActivity(client, req, 'doc', 'Documento removido: ' + doc.name);
  client.docs = (client.docs || []).filter(d => d.id !== req.params.docId);
  saveClientAreaClients(t, clients);
  res.json({ ok: true });
});
// Ponto de entrada genérico pro frontend registrar eventos que não passam pelo PUT
// principal (hoje só "mensagem enviada pela ficha" — caDoSend chama isto depois do envio).
const CLIENT_ACTIVITY_MANUAL_TYPES = new Set(['message']);
app.post('/api/client-area/:id/activity', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const clients = getClientAreaClients(t);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'not found' });
  if (!clientAreaClientVisible(req, client)) return res.status(403).json({ error: 'Sem permissão para este cliente' });
  const type = CLIENT_ACTIVITY_MANUAL_TYPES.has(req.body?.type) ? req.body.type : null;
  const summary = String(req.body?.summary || '').slice(0, 200);
  if (!type || !summary) return res.status(400).json({ error: 'type/summary invalidos' });
  logActivity(client, req, type, summary);
  saveClientAreaClients(t, clients);
  res.json({ ok: true });
});

// Link do formulario (autenticado) — gera/retorna o token
app.get('/api/dashboard/form-link', requireAuth, (req, res) => {
  const t = getTenant(req.clientId); const cfg = t.db.getConfig();
  let tok = cfg.dashFormToken;
  if (!tok) { tok = Math.random().toString(36).slice(2, 11) + Date.now().toString(36); t.db.updateConfig({ dashFormToken: tok }); }
  res.json({ url: `https://${req.clientId}.gestorwagnnerpires.com.br/dform.html?c=${req.clientId}&t=${tok}`, token: tok });
});

// Formulario publico (cliente preenche) — validado por token
function dformAuth(req) {
  try { const t = getTenant(req.params.clientId); const cfg = t.db.getConfig(); return (cfg.dashFormToken && req.query.t === cfg.dashFormToken) ? t : null; } catch (e) { return null; }
}
app.get('/dform/:clientId/data', (req, res) => {
  const t = dformAuth(req); if (!t) return res.status(403).json({ error: 'Link invalido ou expirado.' });
  const p = t.db.getConfig().clientDashboard || {};
  res.json({ name: p.name || '', razaoSocial: p.razaoSocial || '', cnpj: p.cnpj || '', responsavel: p.responsavel || '', segmento: p.segmento || '', links: Array.isArray(p.links) ? p.links : [] });
});
app.post('/dform/:clientId/save', (req, res) => {
  const t = dformAuth(req); if (!t) return res.status(403).json({ error: 'Link invalido ou expirado.' });
  const b = req.body || {}; const cur = t.db.getConfig().clientDashboard || {};
  const merged = Object.assign({}, cur, {
    name: String(b.name || cur.name || ''),
    razaoSocial: String(b.razaoSocial || ''),
    cnpj: String(b.cnpj || ''),
    responsavel: String(b.responsavel || ''),
    segmento: String(b.segmento || ''),
    links: Array.isArray(b.links) ? b.links.filter(l => l && (l.url || l.label)).map(l => ({ label: String(l.label || '').slice(0, 40), url: String(l.url || '').slice(0, 300) })) : (cur.links || [])
  });
  t.db.updateConfig({ clientDashboard: merged });
  res.json({ ok: true });
});

// ── CRM Card Files ─────────────────────────────────────────
app.get('/api/crm/cards/:id/files', requireAuth, (req, res) => {
  res.json(getTenant(req.clientId).db.getCrmFiles(req.params.id) || []);
});
app.post('/api/crm/cards/:id/files', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const cardId = req.params.id;
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  let responded = false;
  function reply(status, body) { if (responded) return; responded = true; res.status(status).json(body); }
  bb.on('file', (_field, fileStream, info) => {
    const { filename, mimeType } = info;
    if (!filename) { fileStream.resume(); return; }
    const ext = path.extname(filename) || '';
    const saveName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    const savePath = path.join(t.uploadsDir, saveName);
    const url = `/uploads/${t.clientId}/${saveName}`;
    const out = fs.createWriteStream(savePath);
    let size = 0;
    fileStream.on('data', d => size += d.length);
    fileStream.on('limit', () => { out.destroy(); fs.unlink(savePath, () => {}); reply(400, { error: 'Arquivo muito grande (máximo 200 MB)' }); });
    fileStream.pipe(out);
    out.on('finish', () => {
      createVideoDerivatives(savePath, mimeType);
      if (responded) return;
      const entry = t.db.addCrmFile(cardId, { name: filename, url, mime: mimeType || '', size });
      reply(200, entry);
    });
    out.on('error', e => reply(500, { error: e.message }));
  });
  bb.on('finish', () => { if (!responded) reply(400, { error: 'Nenhum arquivo recebido' }); });
  bb.on('error', e => reply(500, { error: e.message }));
  req.pipe(bb);
});
app.delete('/api/crm/cards/:id/files/:fileId', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const files = t.db.getCrmFiles(req.params.id) || [];
  const file = files.find(f => f.id === req.params.fileId);
  if (file?.url) {
    const filename = file.url.split('/').pop();
    const filePath = path.join(t.uploadsDir, filename);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
  t.db.deleteCrmFile(req.params.fileId);
  res.json({ ok: true });
});
app.get('/api/crm/report', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getCrmReport()));

// Recupera cards órfãos (sem whatsappId e sem phone) cruzando com histórico de mensagens pelo nome
app.post('/api/crm/recover-links', requireAuth, (req, res) => {
  res.json(getTenant(req.clientId).db.recoverCrmLinks());
});

// Resolve telefones de cards @lid usando mapeamento em memória do Baileys
app.post('/api/crm/resolve-phones', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const before = t.db.getCrmCards().filter(c => c.whatsappId && isLidJid(c.whatsappId) && !c.phone).length;
  resolveCrmLidPhones(t);
  const after = t.db.getCrmCards().filter(c => c.whatsappId && isLidJid(c.whatsappId) && !c.phone).length;
  res.json({ resolved: before - after });
});

// Prospects
app.get('/api/prospects', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getProspects()));
app.post('/api/prospects', requireAuth, (req, res) => { const { name, instagram, site, phone } = req.body; if (!name) return res.status(400).json({ error: 'Nome obrigatorio' }); res.json(getTenant(req.clientId).db.createProspect({ name, instagram, site, phone })); });
app.post('/api/prospects/bulk', requireAuth, (req, res) => { const list = req.body?.list; if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'Lista invalida' }); res.json(getTenant(req.clientId).db.bulkCreateProspects(list)); });
app.delete('/api/prospects/:id', requireAuth, (req, res) => { getTenant(req.clientId).db.deleteProspect(req.params.id); res.json({ ok: true }); });

// Google Sheets config
app.get('/api/config/sheets', requireAuth, (req, res) => {
  const cfg = getTenant(req.clientId).db.getConfig();
  res.json({ secret: cfg.sheetsSecret || 'vac-sheets-2026', groupId: cfg.sheetsGroupId || '', groupName: cfg.sheetsGroupName || '', connectionId: cfg.sheetsConnectionId || 'web', template: cfg.sheetsTemplate || '🔔 Novo lead!\n\nNome: {nome}\nTelefone: {telefone}\nOrigem: {origem}\nEmail: {email}' });
});
app.post('/api/config/sheets', requireAuth, (req, res) => {
  const { secret, groupId, groupName, template, connectionId } = req.body || {};
  getTenant(req.clientId).db.updateConfig({ sheetsSecret: secret, sheetsGroupId: groupId, sheetsGroupName: groupName, sheetsTemplate: template, sheetsConnectionId: connectionId || 'web' });
  res.json({ ok: true });
});

// Sheets channels (additional webhooks per client)
app.get('/api/sheets/channels', requireAuth, (req, res) => {
  const cfg = getTenant(req.clientId).db.getConfig();
  res.json(cfg.sheetsChannels || []);
});

app.post('/api/sheets/channels', requireAuth, (req, res) => {
  const { name, secret, groupId, groupName, template, connectionId } = req.body || {};
  if (!name || !secret) return res.status(400).json({ error: 'Nome e token obrigatórios' });
  const cfg = getTenant(req.clientId).db.getConfig();
  const channels = cfg.sheetsChannels || [];
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  channels.push({ id, name, secret, groupId: groupId || '', groupName: groupName || '', connectionId: connectionId || 'web', template: template || '🔔 Novo lead!\n\nNome: {nome}\nTelefone: {telefone}\nEmail: {email}' });
  getTenant(req.clientId).db.updateConfig({ sheetsChannels: channels });
  res.json({ ok: true, id });
});

app.put('/api/sheets/channels/:id', requireAuth, (req, res) => {
  const { name, secret, groupId, groupName, template, connectionId } = req.body || {};
  const cfg = getTenant(req.clientId).db.getConfig();
  const channels = cfg.sheetsChannels || [];
  const idx = channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Canal não encontrado' });
  channels[idx] = { ...channels[idx], name: name || channels[idx].name, secret: secret || channels[idx].secret, groupId: groupId ?? channels[idx].groupId, groupName: groupName ?? channels[idx].groupName, connectionId: connectionId ?? channels[idx].connectionId ?? 'web', template: template ?? channels[idx].template };
  getTenant(req.clientId).db.updateConfig({ sheetsChannels: channels });
  res.json({ ok: true });
});

app.delete('/api/sheets/channels/:id', requireAuth, (req, res) => {
  const cfg = getTenant(req.clientId).db.getConfig();
  getTenant(req.clientId).db.updateConfig({ sheetsChannels: (cfg.sheetsChannels || []).filter(c => c.id !== req.params.id) });
  res.json({ ok: true });
});

// Webhook by channel ID
app.post('/api/webhook/sheets/:clientId/:channelId', async (req, res) => {
  const t = getTenant(req.params.clientId);
  const cfg = t.db.getConfig();
  const channel = (cfg.sheetsChannels || []).find(c => c.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
  const channelCfg = { sheetsSecret: channel.secret, sheetsGroupId: channel.groupId, sheetsGroupName: channel.groupName, sheetsConnectionId: channel.connectionId || 'web', sheetsChannelId: channel.id, sheetsTemplate: channel.template, leadsPaused: cfg.leadsPaused };
  await handleSheetsWebhook(t, req.body || {}, res, channelCfg);
});

// Consultants
app.get('/api/consultants', requireAuth, (req, res) => res.json(getTenant(req.clientId).db.getConsultants()));
app.post('/api/consultants', requireAuth, (req, res) => { const { name, phone } = req.body || {}; if (!name) return res.status(400).json({ error: 'Nome obrigatorio' }); res.json(getTenant(req.clientId).db.createConsultant(name.trim(), phone ? String(phone).replace(/\D/g, '') : '')); });
app.put('/api/consultants/:id', requireAuth, (req, res) => { const fields = { ...req.body }; if ('phone' in fields) fields.phone = String(fields.phone || '').replace(/\D/g, ''); const r = getTenant(req.clientId).db.updateConsultant(req.params.id, fields); if (!r) return res.status(404).json({ error: 'Nao encontrado' }); res.json(r); });
app.delete('/api/consultants/:id', requireAuth, (req, res) => { getTenant(req.clientId).db.deleteConsultant(req.params.id); res.json({ ok: true }); });

// Gera o link público (sem login) pra o próprio cliente gerenciar os consultores.
app.get('/api/consultants-link', requireAuth, requireFeature('queue'), (req, res) => {
  const token = signConsultantsLink(req.clientId);
  res.json({ url: `${req.protocol}://${req.get('host')}/fila-da-vez.html?t=${token}` });
});

// Mesmas 4 rotas de consultores, só que autenticadas pelo token do link público em vez
// do login normal do CRM — é o que a tela fila-da-vez.html consome.
app.get('/api/public/consultants', requirePublicConsultantsToken, (req, res) => res.json(getTenant(req.clientId).db.getConsultants()));
app.post('/api/public/consultants', requirePublicConsultantsToken, (req, res) => { const { name, phone } = req.body || {}; if (!name) return res.status(400).json({ error: 'Nome obrigatorio' }); res.json(getTenant(req.clientId).db.createConsultant(name.trim(), phone ? String(phone).replace(/\D/g, '') : '')); });
app.put('/api/public/consultants/:id', requirePublicConsultantsToken, (req, res) => { const fields = { ...req.body }; delete fields.t; if ('phone' in fields) fields.phone = String(fields.phone || '').replace(/\D/g, ''); const r = getTenant(req.clientId).db.updateConsultant(req.params.id, fields); if (!r) return res.status(404).json({ error: 'Nao encontrado' }); res.json(r); });
app.delete('/api/public/consultants/:id', requirePublicConsultantsToken, (req, res) => { getTenant(req.clientId).db.deleteConsultant(req.params.id); res.json({ ok: true }); });

app.post('/api/sheets/channels/:id/test', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  const channel = (cfg.sheetsChannels || []).find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
  if (!channel.groupId) return res.status(409).json({ error: 'Nenhum grupo configurado neste canal.' });
  const connectionId = channel.connectionId || 'web';
  const fakeBody = { nome: 'João Teste Silva', telefone: '5511999999999', cidade: 'São Paulo', conta_luz: 'R$ 450', campanha: 'Campanha Teste', anuncio: 'Anúncio Teste', plataforma: 'facebook', vendedor: 'Vendedor Teste', hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) };
  const channelCfg = { sheetsTemplate: channel.template, sheetsGroupId: channel.groupId, sheetsGroupName: channel.groupName };
  const message = '🧪 *[TESTE]* ' + buildSheetsMessage(channelCfg, fakeBody);
  try {
    await dispatchScheduledMessage(t, { id: `test-${Date.now()}`, recipientType: 'group', recipientId: channel.groupId, recipientName: channel.groupName || 'Grupo', message, quickReplies: [], connectionId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/consultants/test-lead', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  const groupId = cfg.sheetsGroupId;
  const groupName = cfg.sheetsGroupName || 'Grupo de Leads';
  if (!groupId) return res.status(409).json({ error: 'Nenhum grupo configurado.' });
  const next = t.db.assignNextConsultant();
  const fakeBody = {
    nome: 'João Teste Silva', telefone: '5511999999999', email: 'teste@exemplo.com',
    cidade: 'Porto Alegre', origem: 'Facebook', produto: 'Produto Teste',
    conta_luz: 'R$ 500', campanha: 'Campanha Teste', anuncio: 'Anúncio Teste',
    plataforma: 'facebook', consultor: next ? next.name : 'Sem consultor disponível',
  };
  const message = '🧪 *[TESTE]* ' + buildSheetsMessage(cfg, fakeBody);
  const configuredConnection = cfg.sheetsConnectionId || 'web';
  if ((configuredConnection === 'groups' || configuredConnection === 'baileys_groups') && !t.isGroupReady) {
    ensureGroupClient(t, 'test-lead');
    return res.status(503).json({ error: 'WhatsApp operacional de grupos nao conectado. Va em Configuracoes > Conexoes e reconecte WhatsApp Web (Grupos).' });
  }
  try {
    await dispatchScheduledMessage(t, { id: `test-${Date.now()}`, recipientType: 'group', recipientId: groupId, recipientName: groupName, message, quickReplies: [], connectionId: cfg.sheetsConnectionId || 'web' });
    res.json({ ok: true, proximo: fakeBody.consultor });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Leads pause
app.post('/api/leads/pause', requireAuth, (req, res) => { getTenant(req.clientId).db.updateConfig({ leadsPaused: true }); res.json({ ok: true, paused: true }); });
app.post('/api/leads/resume', requireAuth, (req, res) => { getTenant(req.clientId).db.updateConfig({ leadsPaused: false }); res.json({ ok: true, paused: false }); });
app.get('/api/leads/status', requireAuth, (req, res) => res.json({ paused: !!getTenant(req.clientId).db.getConfig().leadsPaused }));

function buildSheetsMessage(cfg, body) {
  const arrivedAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const template = cfg.sheetsTemplate || '🔔 Novo lead!\n\nNome: {nome}\nTelefone: {telefone}\nOrigem: {origem}\nEmail: {email}';
  // Replace every {variavel} with the matching value from body, or '-' if missing
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key === 'data') return arrivedAt;
    const val = body[key];
    return (val !== undefined && val !== null && String(val).trim() !== '') ? String(val) : '-';
  });
}

function getFirstCrmColumn(t) {
  const funnels = t.db.getFunnels();
  if (!funnels.length) return null;
  const cols = t.db.getCrmColumns(funnels[0].id);
  if (!cols.length) return null;
  return { columnId: cols[0].id, funnelId: funnels[0].id };
}
// Se o tenant tiver uma coluna de CRM com o mesmo nome do consultor (qualquer funil —
// pensado pro funil "Por Vendedor" da Fila da vez), o lead atribuído a ele já nasce
// organizado nessa coluna, em vez de cair na coluna genérica de entrada.
function getConsultantCrmColumn(t, consultantName) {
  if (!consultantName) return null;
  const norm = String(consultantName).trim().toLowerCase();
  if (!norm) return null;
  const match = t.db.getCrmColumns().find(c => String(c.name || '').trim().toLowerCase() === norm);
  return match ? { columnId: match.id, funnelId: match.funnelId } : null;
}

async function handleSheetsWebhook(t, body, res, cfgOverride = null) {
  const dbCfg = t.db.getConfig();
  const cfg = cfgOverride ? { ...dbCfg, ...cfgOverride } : dbCfg;
  const { secret } = body || {};
  if (!secret || secret !== (cfg.sheetsSecret || 'vac-sheets-2026')) return res.status(401).json({ error: 'Token inválido' });
  if (cfg.leadsPaused) return res.status(503).json({ error: 'Sistema pausado.' });
  const groupId = cfg.sheetsGroupId;
  const groupName = cfg.sheetsGroupName || 'Grupo de Leads';
  // Auto-assign consultant if configured, inject as {consultor}
  const serverConsultants = t.db.getConsultants();
  let assignedConsultant = null;
  if (serverConsultants.length > 0 && !body.consultor) {
    assignedConsultant = t.db.assignNextConsultant();
    body = { ...body, consultor: assignedConsultant ? assignedConsultant.name : 'Sem consultor disponível' };
  }
  let scheduledFor = null;
  if (groupId) {
    const message = buildSheetsMessage(cfg, body);
    const now = Date.now();
    const pending = t.db.getSchedules().filter(s => s.scheduledFor <= now + 30 * 60 * 1000);
    const lastTime = pending.length > 0 ? pending[pending.length - 1].scheduledFor : now;
    const intervalMs = (cfg.sheetsQueueIntervalSec || 40) * 1000;
    scheduledFor = Math.max(now + 5000, lastTime + intervalMs);
    const connectionId = cfg.sheetsConnectionId || 'web';
    const sheetsChannelId = cfg.sheetsChannelId || 'default';
    t.db.createSchedule({ recipientType: 'group', recipientId: groupId, recipientName: groupName, message, scheduledFor, quickReplies: [], connectionId, bulkId: `sheets:${sheetsChannelId}` });
  }
  // Manda o mesmo lead também no WhatsApp pessoal do vendedor da vez (além do grupo),
  // se ele tiver telefone cadastrado na Fila da vez. Agendado uns segundos depois da
  // mensagem do grupo, sem competir pelo mesmo espaçamento da fila (intervalMs é só
  // pra não estourar mensagem em cima de mensagem no grupo).
  if (assignedConsultant && assignedConsultant.phone) {
    const dmMessage = buildSheetsMessage(cfg, body);
    const dmConnectionId = cfg.sheetsConnectionId || 'web';
    const dmScheduledFor = Math.max(Date.now() + 5000, (scheduledFor || 0) + 3000);
    // recipientId precisa ser o JID completo (numero@s.whatsapp.net), não só o número puro —
    // é a mesma chave (contact_id) que as respostas do consultor usam pra gravar no histórico.
    // Com só o número, o envio ficava gravado como um contato "fantasma" separado da conversa
    // de verdade, e por isso nunca aparecia no Chat ao vivo.
    const dmDigits = String(assignedConsultant.phone).replace(/\D/g, '');
    t.db.createSchedule({ recipientType: 'contact', recipientId: dmDigits + '@s.whatsapp.net', recipientName: assignedConsultant.name, message: dmMessage, scheduledFor: dmScheduledFor, quickReplies: [], connectionId: dmConnectionId, bulkId: `sheets-consultor:${cfg.sheetsChannelId || 'default'}` });
  }

  // Auto-create CRM card: se existir coluna com o nome do consultor atribuído, o lead já
  // nasce organizado nela; senão cai na coluna de entrada padrão (comportamento de sempre).
  const inbox = (assignedConsultant && getConsultantCrmColumn(t, assignedConsultant.name)) || getFirstCrmColumn(t);
  if (inbox) {
    // Try multiple field name variations for name — rejeita @lid (c:...) e números puros
    const _rawName = body.nome || body.nome_completo || body.lead_name || body.name || body.full_name || '';
    const _isLid  = _rawName.startsWith('c:') || /^\d{8,}$/.test(_rawName);
    const contactName = (!_isLid && _rawName)
      ? _rawName
      : (body.nome_completo || body.lead_name || body.name || 'Lead sem nome');

    // Try multiple variations for phone
    const _rawPhone = body.telefone || body['número_do_whatsapp'] || body.numero_whatsapp
                   || body.numero || body.whatsapp || body.phone || '';
    const phone = String(_rawPhone).replace(/\D/g, '');

    // Dump ALL received fields in notes so the user can see everything
    const _skip = new Set(['secret']);
    const _labels = {
      nome: 'Nome', nome_completo: 'Nome completo', telefone: 'Telefone',
      email: 'Email', cidade: 'Cidade', origem: 'Origem', produto: 'Produto',
      conta_luz: 'Conta de luz', campanha: 'Campanha', anuncio: 'Anúncio',
      plataforma: 'Plataforma', platform: 'Plataforma', consultor: 'Consultor',
      ajuda: 'Como ajudar', como_podemos_te_ajudar: 'Como ajudar',
      is_organic: 'Orgânico', data: 'Data',
    };
    const noteParts = Object.entries(body)
      .filter(([k, v]) => !_skip.has(k) && v !== undefined && v !== null && String(v).trim() !== '')
      .map(([k, v]) => `${_labels[k] || k}: ${v}`);

    const phoneDigits = phoneDigitVariants(phone);
    const nameNorm = String(contactName || '').trim().toLowerCase();
    const existing = t.db.getCrmCards().find(card => {
      if (phoneDigits.length) {
        const cardDigits = phoneDigitVariants(card.phone || card.whatsapp || digitsFromJid(card.whatsappId));
        if (cardDigits.some(d => phoneDigits.some(pd => pd === d || pd.endsWith(d) || d.endsWith(pd)))) return true;
      }
      return nameNorm && String(card.contactName || '').trim().toLowerCase() === nameNorm;
    });
    const _camp = (body.campanha && String(body.campanha).trim()) || (body.anuncio && String(body.anuncio).trim()) || '';
    const _leadLbls = _camp ? [_camp.slice(0, 30), 'meta'] : [];
    // id do lead do formulario do Meta (coluna "id" da planilha) -> match preciso na CAPI (customFields.lead_id)
    const _leadId = String(body.lead_id || body.leadgen_id || body.id || '').replace(/\D/g, '');
    const _tipoImovel = String(body.tipo_imovel || '').trim();
    if (!existing) {
      const _novoCard = t.db.createCrmCard({
        columnId: inbox.columnId,
        funnelId: inbox.funnelId,
        contactName: contactName || 'Lead sem nome',
        phone,
        notes: noteParts.join('\n'),
        labels: _leadLbls,
      });
      if (_novoCard) {
        const _novoCF = { ...(_novoCard.customFields || {}), followupPending: true };
        if (_leadId) _novoCF.lead_id = _leadId;
        if (_tipoImovel) _novoCF.tipo_imovel = _tipoImovel;
        t.db.updateCrmCard(_novoCard.id, { customFields: _novoCF });
      }
    } else {
      const upd = {};
      if (noteParts.length) upd.notes = noteParts.join('\n');
      if (_leadLbls.length) {
        const existingLabels = Array.isArray(existing.labels) ? existing.labels.slice() : [];
        const hasLabel = x => existingLabels.some(l => String(l).toLowerCase() === String(x).toLowerCase());
        _leadLbls.forEach(l => { if (!hasLabel(l)) existingLabels.push(l); });
        upd.labels = existingLabels;
      }
      if (_leadId && !(existing.customFields && existing.customFields.lead_id)) upd.customFields = { ...(existing.customFields || {}), lead_id: _leadId };
      if (Object.keys(upd).length) t.db.updateCrmCard(existing.id, upd);
    }
  }

  res.json({ ok: true, queued: !!groupId, scheduledFor });
}

// Sheets webhook (public — clientId in path)
app.post('/api/webhook/sheets/:clientId', async (req, res) => {
  await handleSheetsWebhook(getTenant(req.params.clientId), req.body || {}, res);
});

// Backward compat: old webhook URL (sem clientId)
app.post('/api/webhook/sheets', async (req, res) => {
  const _primaryId = (loadClients().find(c => !c.ownerClientId) || {}).id || 'vac';
  await handleSheetsWebhook(getTenant(_primaryId), req.body || {}, res);
});

app.post('/api/restart', requireAuth, (req, res) => { res.json({ ok: true }); setTimeout(() => process.exit(0), 300); });

// ─── WorkSpace ─────────────────────────────────────────────

const WORKSPACE_LEGACY_FILE = path.join(DATA_DIR, 'workspace.json');

function getWorkspaceFile(clientId) {
  return path.join(DATA_DIR, `workspace-${String(clientId).replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function defaultWorkspaceStore(tasks = []) {
  return {
    spaces: [{ id: 'default', name: 'VIRANDO A CHAVE', createdAt: Date.now() }],
    tasksBySpace: { default: Array.isArray(tasks) ? tasks : [] }
  };
}

function loadWorkspaceStore(clientId) {
  // Try per-tenant file first
  const clientFile = getWorkspaceFile(clientId);
  try {
    const raw = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
    if (Array.isArray(raw)) return defaultWorkspaceStore(raw);
    if (!raw.spaces || !raw.tasksBySpace) return defaultWorkspaceStore([]);
    return raw;
  } catch {}
  // Fallback: legacy workspace.json (migrates on next save)
  try {
    const raw = JSON.parse(fs.readFileSync(WORKSPACE_LEGACY_FILE, 'utf8'));
    if (Array.isArray(raw)) return defaultWorkspaceStore(raw);
    if (raw.spaces && raw.tasksBySpace) return raw;
  } catch {}
  return defaultWorkspaceStore([]);
}

function saveWorkspaceStore(store, clientId) {
  fs.writeFileSync(getWorkspaceFile(clientId), JSON.stringify(store, null, 2), 'utf8');
}

function canManageWorkspace(req) {
  return (!!req.user && !req.user.ownerClientId) || !!req.user?.permissions?.workspaceAdmin;
}

function allowedWorkspaceSpaceIds(req, store) {
  if (canManageWorkspace(req)) return store.spaces.map(s => s.id);
  return (req.user?.permissions?.workspaceSpaces || []).filter(id => store.spaces.some(s => s.id === id));
}

function getRequestedSpace(req, store) {
  const allowed = allowedWorkspaceSpaceIds(req, store);
  const requested = String(req.query.spaceId || req.body?.spaceId || allowed[0] || 'default');
  if (!allowed.includes(requested)) return null;
  if (!store.tasksBySpace[requested]) store.tasksBySpace[requested] = [];
  return requested;
}

app.get('/api/workspace/spaces', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const allowed = new Set(allowedWorkspaceSpaceIds(req, store));
  res.json({ spaces: store.spaces.filter(s => allowed.has(s.id)), canManage: canManageWorkspace(req) });
});

app.post('/api/workspace/spaces', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão para criar espaços' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const store = loadWorkspaceStore(req.clientId);
  const id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || Date.now().toString(36);
  const finalId = store.spaces.some(s => s.id === id) ? `${id}-${Date.now().toString(36).slice(-4)}` : id;
  const space = { id: finalId, name, createdAt: Date.now() };
  store.spaces.push(space);
  store.tasksBySpace[finalId] = [];
  saveWorkspaceStore(store, req.clientId);
  res.json(space);
});

app.get('/api/workspace/invites', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão' });
  const clients = loadClients();
  res.json(clients.filter(c => c.ownerClientId === req.clientId).map(c => ({ id: c.id, name: c.name, username: c.username, permissions: c.permissions || {}, defaultConnectionId: c.defaultConnectionId || null, chatConnectionId: c.chatConnectionId || c.defaultConnectionId || null, broadcastConnectionId: c.broadcastConnectionId || null })));
});

app.post('/api/workspace/invites', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão para convidar' });
  const { name, username, password } = req.body || {};
  const features = Array.isArray(req.body?.features) ? req.body.features.filter(f => ALL_FEATURES.includes(f)) : ['workspace'];
  const workspaceSpaces = Array.isArray(req.body?.workspaceSpaces) ? req.body.workspaceSpaces.map(String) : [];
  if (!name || !username || !password) return res.status(400).json({ error: 'Preencha nome, usuário e senha' });
  const clients = loadClients();
  if (clients.some(c => c.username === username)) return res.status(400).json({ error: 'Esse usuário já existe' });
  const idBase = username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 28) || Date.now().toString(36);
  const id = clients.some(c => c.id === idBase) ? `${idBase}-${Date.now().toString(36).slice(-4)}` : idBase;
  // Auto-atribui próximo slot disponível (web2 → web3)
  const usedSlots = new Set(clients.filter(c => c.ownerClientId === req.clientId).map(c => c.chatConnectionId).filter(Boolean));
  const INVITE_SLOTS = ['web2', 'web3'];
  const chatConnectionId = INVITE_SLOTS.find(s => !usedSlots.has(s)) || 'web2';
  const broadcastConnectionId = null;
  clients.push({ id, ownerClientId: req.clientId, name, username, password, admin: false, defaultConnectionId: chatConnectionId, chatConnectionId, broadcastConnectionId, permissions: { features, workspaceSpaces, workspaceAdmin: !!req.body?.workspaceAdmin } });
  saveClients(clients);
  res.json({ ok: true, id });
});

app.put('/api/workspace/invites/:id', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão' });
  const clients = loadClients();
  const idx = clients.findIndex(c => c.id === req.params.id && c.ownerClientId === req.clientId);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  const features = Array.isArray(req.body?.features) ? req.body.features.filter(f => ALL_FEATURES.includes(f)) : (clients[idx].permissions?.features || ['workspace']);
  if (!features.includes('workspace')) features.push('workspace');
  const workspaceSpaces = Array.isArray(req.body?.workspaceSpaces) ? req.body.workspaceSpaces.map(String) : (clients[idx].permissions?.workspaceSpaces || []);
  if (req.body?.name) clients[idx].name = String(req.body.name).trim();
  if (req.body?.password) clients[idx].password = String(req.body.password).trim();
  if ('chatConnectionId' in req.body) clients[idx].chatConnectionId = req.body.chatConnectionId || null;
  if ('broadcastConnectionId' in req.body) clients[idx].broadcastConnectionId = req.body.broadcastConnectionId || null;
  if ('defaultConnectionId' in req.body) clients[idx].defaultConnectionId = req.body.defaultConnectionId || null;
  // Sincroniza defaultConnectionId com chatConnectionId para compat
  clients[idx].defaultConnectionId = clients[idx].chatConnectionId || clients[idx].defaultConnectionId || null;
  clients[idx].permissions = { ...clients[idx].permissions, features, workspaceSpaces, workspaceAdmin: !!req.body?.workspaceAdmin };
  saveClients(clients);
  res.json({ ok: true });
});

app.delete('/api/workspace/invites/:id', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão' });
  const clients = loadClients();
  const filtered = clients.filter(c => !(c.id === req.params.id && c.ownerClientId === req.clientId));
  saveClients(filtered);
  res.json({ ok: true });
});

// Save personal WABA credentials for logged-in sub-user
app.put('/api/me/waba', requireAuth, (req, res) => {
  const { phoneNumberId, accessToken, wabaId, displayPhone } = req.body || {};
  if (!phoneNumberId || !accessToken) return res.status(400).json({ error: 'phoneNumberId e accessToken obrigatórios' });
  const clients = loadClients();
  const idx = clients.findIndex(c => c.id === req.loginClientId);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  clients[idx].personalWaba = { phoneNumberId, accessToken, wabaId: wabaId || '', displayPhone: displayPhone || '' };
  clients[idx].chatConnectionId = 'cloud_personal';
  clients[idx].defaultConnectionId = 'cloud_personal';
  saveClients(clients);
  res.json({ ok: true });
});

// Remove personal WABA — revert to next available Baileys slot
app.delete('/api/me/waba', requireAuth, (req, res) => {
  const clients = loadClients();
  const idx = clients.findIndex(c => c.id === req.loginClientId);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  delete clients[idx].personalWaba;
  const ownerClients = clients.filter(c => c.ownerClientId === clients[idx].ownerClientId && c.id !== clients[idx].id);
  const usedSlots = new Set(ownerClients.map(c => c.chatConnectionId).filter(s => s && s !== 'cloud_personal'));
  const INVITE_SLOTS = ['web2', 'web3'];
  const newSlot = INVITE_SLOTS.find(s => !usedSlots.has(s)) || 'web2';
  clients[idx].chatConnectionId = newSlot;
  clients[idx].defaultConnectionId = newSlot;
  saveClients(clients);
  res.json({ ok: true });
});

app.get('/api/workspace/tasks', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  res.json(store.tasksBySpace[spaceId] || []);
});

app.put('/api/workspace/tasks/:id', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const tasks = store.tasksBySpace[spaceId] || [];
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  tasks[idx] = { ...tasks[idx], ...req.body, id: req.params.id };
  delete tasks[idx].spaceId;
  saveWorkspaceStore(store, req.clientId);
  res.json(tasks[idx]);
});

app.put('/api/workspace/tasks', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const { ids, fields } = req.body;
  if (!Array.isArray(ids) || !fields || typeof fields !== 'object') return res.status(400).json({ error: 'ids[] e fields{} obrigatórios' });
  const tasks = store.tasksBySpace[spaceId] || [];
  ids.forEach(id => {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx !== -1) { tasks[idx] = { ...tasks[idx], ...fields, id }; delete tasks[idx].spaceId; }
  });
  saveWorkspaceStore(store, req.clientId);
  res.json({ updated: ids.length });
});

app.post('/api/workspace/tasks', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão para criar itens' });
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const task = { id: Date.now().toString(36), ...req.body };
  delete task.spaceId;
  store.tasksBySpace[spaceId].push(task);
  saveWorkspaceStore(store, req.clientId);
  res.json(task);
});

app.delete('/api/workspace/tasks/:id', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão para excluir' });
  const t = getTenant(req.clientId);
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const task = (store.tasksBySpace[spaceId] || []).find(tk => tk.id === req.params.id);
  if (task?.files?.length) {
    task.files.forEach(f => {
      const filename = f.url.split('/').pop();
      const filePath = path.join(t.uploadsDir, filename);
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    });
  }
  store.tasksBySpace[spaceId] = (store.tasksBySpace[spaceId] || []).filter(tk => tk.id !== req.params.id);
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

app.post('/api/workspace/reorder', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const tasks = store.tasksBySpace[spaceId] || [];
  const map = Object.fromEntries(tasks.map(t => [t.id, t]));
  const reordered = ids.map(id => map[id]).filter(Boolean);
  const rest = tasks.filter(t => !ids.includes(t.id));
  store.tasksBySpace[spaceId] = [...reordered, ...rest];
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

app.delete('/api/workspace/tasks', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão para excluir' });
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  store.tasksBySpace[spaceId] = (store.tasksBySpace[spaceId] || []).filter(t => !ids.includes(t.id));
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

// ─── Workspace Automations ────────────────────────────────

app.get('/api/workspace/automations', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  res.json(store.automations || []);
});

app.post('/api/workspace/automations', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão' });
  const store = loadWorkspaceStore(req.clientId);
  const { name, trigger, action, spaceId, active } = req.body || {};
  if (!trigger || !action) return res.status(400).json({ error: 'trigger e action obrigatórios' });
  const auto = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || '', trigger, action, spaceId: spaceId || null, active: active !== false, createdAt: Date.now() };
  if (!store.automations) store.automations = [];
  store.automations.push(auto);
  saveWorkspaceStore(store, req.clientId);
  res.json(auto);
});

app.put('/api/workspace/automations/:id', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão' });
  const store = loadWorkspaceStore(req.clientId);
  if (!store.automations) store.automations = [];
  const idx = store.automations.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  store.automations[idx] = { ...store.automations[idx], ...req.body, id: req.params.id };
  saveWorkspaceStore(store, req.clientId);
  res.json(store.automations[idx]);
});

app.delete('/api/workspace/automations/:id', requireAuth, requireFeature('workspace'), (req, res) => {
  if (!canManageWorkspace(req)) return res.status(403).json({ error: 'Sem permissão' });
  const store = loadWorkspaceStore(req.clientId);
  if (!store.automations) store.automations = [];
  store.automations = store.automations.filter(a => a.id !== req.params.id);
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

// ─── Workspace Task Files ─────────────────────────────────

app.post('/api/workspace/tasks/:id/files', requireAuth, requireFeature('workspace'), (req, res) => {
  const t = getTenant(req.clientId);
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const tasks = store.tasksBySpace[spaceId] || [];
  const task = tasks.find(tk => tk.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_MEDIA_BYTES } }); } catch (e) { return res.status(400).json({ error: e.message }); }
  let responded = false;
  function reply(status, body) { if (responded) return; responded = true; res.status(status).json(body); }

  bb.on('file', (_field, fileStream, info) => {
    const { filename, mimeType } = info;
    if (!filename) { fileStream.resume(); return; }
    const ext = path.extname(filename) || '';
    const saveName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    const savePath = path.join(t.uploadsDir, saveName);
    const url = `/uploads/${t.clientId}/${saveName}`;
    const out = fs.createWriteStream(savePath);
    let size = 0;
    fileStream.on('data', d => size += d.length);
    fileStream.on('limit', () => { out.destroy(); fs.unlink(savePath, () => {}); reply(400, { error: 'Arquivo muito grande (máximo 200 MB)' }); });
    fileStream.pipe(out);
    out.on('finish', () => {
      createVideoDerivatives(savePath, mimeType);
      if (responded) return;
      if (!task.files) task.files = [];
      const entry = { name: filename, url, mime: mimeType || '', size };
      task.files.push(entry);
      saveWorkspaceStore(store, req.clientId);
      reply(200, entry);
    });
    out.on('error', e => reply(500, { error: e.message }));
  });
  bb.on('finish', () => { if (!responded) reply(400, { error: 'Nenhum arquivo recebido' }); });
  bb.on('error', e => reply(500, { error: e.message }));
  req.pipe(bb);
});

app.delete('/api/workspace/tasks/:id/files/:filename', requireAuth, requireFeature('workspace'), (req, res) => {
  const t = getTenant(req.clientId);
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const tasks = store.tasksBySpace[spaceId] || [];
  const task = tasks.find(tk => tk.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(t.uploadsDir, filename);
  if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  task.files = (task.files || []).filter(f => !f.url.endsWith('/' + filename));
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

// ─── Workspace Task Comments ───────────────────────────────

app.get('/api/workspace/tasks/:id/comments', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const task = (store.tasksBySpace[spaceId] || []).find(tk => tk.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task.comments || []);
});

app.post('/api/workspace/tasks/:id/comments', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const task = (store.tasksBySpace[spaceId] || []).find(tk => tk.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comentário vazio' });
  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    author: req.user?.name || 'Você',
    createdAt: Date.now()
  };
  if (!Array.isArray(task.comments)) task.comments = [];
  task.comments.push(comment);
  saveWorkspaceStore(store, req.clientId);
  res.json(comment);
});

app.delete('/api/workspace/tasks/:id/comments/:commentId', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  const task = (store.tasksBySpace[spaceId] || []).find(tk => tk.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  task.comments = (task.comments || []).filter(c => c.id !== req.params.commentId);
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

// ─── Workspace Custom Columns ──────────────────────────────
app.get('/api/workspace/columns', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  res.json(Array.isArray(store.customColumns) ? store.customColumns : []);
});

app.post('/api/workspace/columns', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Nome da coluna obrigatorio' });
  if (!Array.isArray(store.customColumns)) store.customColumns = [];
  const col = { field: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, type: 'text' };
  store.customColumns.push(col);
  saveWorkspaceStore(store, req.clientId);
  res.json(col);
});

app.delete('/api/workspace/columns/:field', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  if (Array.isArray(store.customColumns)) {
    store.customColumns = store.customColumns.filter(c => c.field !== req.params.field);
    saveWorkspaceStore(store, req.clientId);
  }
  res.json({ ok: true });
});

// ─── Workspace Reset ───────────────────────────────────────

app.post('/api/workspace/reset', requireAuth, requireFeature('workspace'), (req, res) => {
  if (req.body?.phrase !== 'APAGA_O_MASTER_GALO_NOVO') return res.status(400).json({ error: 'Frase de confirmação incorreta' });
  const store = loadWorkspaceStore(req.clientId);
  const backupName = `workspace-${req.clientId}-backup-${Date.now()}.json`;
  fs.writeFileSync(path.join(__dirname, backupName), JSON.stringify(store, null, 2), 'utf8');
  const emptyStore = { ...store, tasksBySpace: {} };
  Object.keys(store.tasksBySpace).forEach(k => { emptyStore.tasksBySpace[k] = []; });
  if (store.labelsBySpace) emptyStore.labelsBySpace = {};
  saveWorkspaceStore(emptyStore, req.clientId);
  res.json({ ok: true, backup: backupName });
});

// ─── Workspace Labels ──────────────────────────────────────

const LABEL_COLORS = ['#f03e3e','#e67700','#f59f00','#2f9e44','#1971c2','#6741d9','#d6336c','#0c8599','#868e96'];

app.get('/api/workspace/labels', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  res.json(store.labelsBySpace?.[spaceId] || []);
});

app.post('/api/workspace/labels', requireAuth, requireFeature('workspace'), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  if (!store.labelsBySpace) store.labelsBySpace = {};
  if (!store.labelsBySpace[spaceId]) store.labelsBySpace[spaceId] = [];
  const existing = store.labelsBySpace[spaceId].find(l => l.name === name);
  if (existing) return res.json(existing);
  const usedColors = store.labelsBySpace[spaceId].map(l => l.color);
  const color = req.body?.color || LABEL_COLORS.find(c => !usedColors.includes(c)) || LABEL_COLORS[store.labelsBySpace[spaceId].length % LABEL_COLORS.length];
  const label = { name, color };
  store.labelsBySpace[spaceId].push(label);
  saveWorkspaceStore(store, req.clientId);
  res.json(label);
});

app.delete('/api/workspace/labels/:name', requireAuth, requireFeature('workspace'), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = getRequestedSpace(req, store);
  if (!spaceId) return res.status(403).json({ error: 'Sem acesso a este espaço' });
  if (store.labelsBySpace?.[spaceId]) {
    store.labelsBySpace[spaceId] = store.labelsBySpace[spaceId].filter(l => l.name !== name);
  }
  if (store.tasksBySpace[spaceId]) {
    store.tasksBySpace[spaceId].forEach(t => {
      if (Array.isArray(t.labels)) t.labels = t.labels.filter(l => l !== name);
    });
  }
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

// ─── Workspace Status Config ───────────────────────────────

app.get('/api/workspace/status-config', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = req.query.spaceId || '_global';
  res.json(store.statusConfig?.[spaceId] || null);
});

app.put('/api/workspace/status-config', requireAuth, requireFeature('workspace'), (req, res) => {
  const store = loadWorkspaceStore(req.clientId);
  const spaceId = req.query.spaceId || '_global';
  const statuses = req.body?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return res.status(400).json({ error: 'statuses inválido' });
  if (!store.statusConfig) store.statusConfig = {};
  store.statusConfig[spaceId] = statuses.map(s => ({ name: String(s.name).trim(), color: s.color || '#888', bg: s.bg || '#222' }));
  saveWorkspaceStore(store, req.clientId);
  res.json({ ok: true });
});

// ─── AI Config ────────────────────────────────────────────

app.get('/api/config/ai', requireAuth, requireAdmin, (req, res) => {
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  const funnels = t.db.getFunnels();
  const columns = t.db.getCrmColumns();
  res.json({
    hasKey: !!cfg.anthropicApiKey,
    aiBusinessContext: cfg.aiBusinessContext || '',
    aiChatbotColumnId: cfg.aiChatbotColumnId || '',
    funnels: funnels.map(f => ({ id: f.id, name: f.name, columns: columns.filter(c => c.funnelId === f.id).map(c => ({ id: c.id, name: c.name })) }))
  });
});

app.put('/api/config/ai', requireAuth, requireAdmin, (req, res) => {
  const { anthropicApiKey, aiBusinessContext, aiChatbotColumnId } = req.body || {};
  const t = getTenant(req.clientId);
  const fields = { aiBusinessContext: aiBusinessContext || '', aiChatbotColumnId: aiChatbotColumnId || '' };
  if (anthropicApiKey !== undefined) fields.anthropicApiKey = anthropicApiKey.trim();
  t.db.updateConfig(fields);
  res.json({ hasKey: !!t.db.getConfig().anthropicApiKey, aiBusinessContext: aiBusinessContext || '', aiChatbotColumnId: aiChatbotColumnId || '' });
});

// ─── AI Actions ───────────────────────────────────────────

app.post('/api/ai/review-conversation', requireAuth, async (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  if (!cfg.anthropicApiKey) return res.status(400).json({ error: 'Chave Anthropic não configurada. Acesse Configurações → IA.' });
  const messages = t.db.getMessages(contactId);
  if (!messages.length) return res.json({ result: 'Nenhuma mensagem encontrada nesta conversa.' });
  const systemPrompt = `Você é um analista de vendas e CRM.${cfg.aiBusinessContext ? ' Contexto do negócio: ' + cfg.aiBusinessContext : ''} Analise a conversa e forneça: 1) Resumo breve da situação, 2) Tom e intenção do lead, 3) Próxima ação recomendada. Seja conciso (máx. 5 linhas).`;
  const claudeMessages = messages.slice(-30)
    .map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text || '' }))
    .filter(m => m.content);
  while (claudeMessages.length && claudeMessages[0].role === 'assistant') claudeMessages.shift();
  if (!claudeMessages.length) return res.json({ result: 'Sem mensagens de texto para analisar.' });
  try {
    const result = await callAnthropicApi(cfg.anthropicApiKey, claudeMessages, systemPrompt);
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/suggest-reply', requireAuth, async (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  if (!cfg.anthropicApiKey) return res.status(400).json({ error: 'Chave Anthropic não configurada. Acesse Configurações → IA.' });
  const messages = t.db.getMessages(contactId);
  if (!messages.length) return res.json({ result: 'Nenhuma mensagem para basear a sugestão.' });
  const systemPrompt = `Você é um assistente de vendas.${cfg.aiBusinessContext ? ' Contexto: ' + cfg.aiBusinessContext : ''} Baseado na conversa, escreva UMA resposta pronta para enviar. Responda APENAS com o texto da mensagem, sem explicações, sem aspas, sem prefixo.`;
  const claudeMessages = messages.slice(-20)
    .map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text || '' }))
    .filter(m => m.content);
  while (claudeMessages.length && claudeMessages[0].role === 'assistant') claudeMessages.shift();
  if (!claudeMessages.length) return res.json({ result: '' });
  try {
    const result = await callAnthropicApi(cfg.anthropicApiKey, claudeMessages, systemPrompt);
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/fix-grammar', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const t = getTenant(req.clientId);
  const cfg = t.db.getConfig();
  if (!cfg.anthropicApiKey) return res.status(400).json({ error: 'Chave Anthropic não configurada. Acesse Configurações → IA.' });
  const systemPrompt = 'Corrija gramática e ortografia do texto em português. Mantenha o tom informal se o texto for informal. Responda APENAS com o texto corrigido, sem explicações, sem aspas.';
  try {
    const result = await callAnthropicApi(cfg.anthropicApiKey, [{ role: 'user', content: text }], systemPrompt);
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liga/desliga a IA pra ESSE contato específico — considera o estado REAL (que já leva em
// conta match de coluna e bot pausado, não só o toggle manual), pra funcionar certo mesmo
// num contato que só está "ligado" porque o card dele caiu na coluna gatilho configurada.
app.post('/api/ai/chatbot/toggle', requireAuth, (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const t = getTenant(req.clientId);
  const card = findCrmCardForChat(t, contactId);
  const wasEnabled = aiChatbotShouldTrigger(t, contactId, card?.columnId);
  const included = getAiChatbotSet(t);
  const excluded = getAiChatbotExcludedSet(t);
  if (wasEnabled) { included.delete(contactId); excluded.add(contactId); }
  else { excluded.delete(contactId); included.add(contactId); }
  t.db.updateConfig({ aiChatbotContacts: [...included], aiChatbotExcluded: [...excluded] });
  res.json({ enabled: !wasEnabled, contactId });
});

app.get('/api/ai/chatbot/status', requireAuth, (req, res) => {
  const { contactId } = req.query;
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const t = getTenant(req.clientId);
  const card = findCrmCardForChat(t, contactId);
  res.json({ enabled: aiChatbotShouldTrigger(t, contactId, card?.columnId), paused: !!t.db.getContactBotState(contactId).botPaused });
});

// ─── Test Chat routes ───────────────────────────────────────

// ─── Financeiro API ───────────────────────────────────────────────────────────
app.get('/api/fin/months', requireAuth, (req, res) => {
  res.json(getTenant(req.clientId).db.listFinMonths());
});
app.get('/api/fin/months/:year/:month', requireAuth, (req, res) => {
  const db = getTenant(req.clientId).db;
  const m = db.getOrCreateFinMonth(Number(req.params.year), Number(req.params.month));
  const data = db.getFinMonthData(m.id);
  res.json({ month: m, ...data });
});
app.post('/api/fin/months/:year/:month/income', requireAuth, (req, res) => {
  const db = getTenant(req.clientId).db;
  const m = db.getOrCreateFinMonth(Number(req.params.year), Number(req.params.month));
  res.json(db.addFinIncome(m.id, req.body));
});
app.put('/api/fin/income/:id', requireAuth, (req, res) => {
  getTenant(req.clientId).db.updateFinIncome(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/fin/income/:id', requireAuth, (req, res) => {
  getTenant(req.clientId).db.deleteFinIncome(req.params.id);
  res.json({ ok: true });
});
app.post('/api/fin/months/:year/:month/expenses/:category', requireAuth, (req, res) => {
  const db = getTenant(req.clientId).db;
  const m = db.getOrCreateFinMonth(Number(req.params.year), Number(req.params.month));
  res.json(db.addFinExpense(m.id, req.params.category, req.body));
});
app.put('/api/fin/expenses/:id', requireAuth, (req, res) => {
  getTenant(req.clientId).db.updateFinExpense(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/fin/expenses/:id', requireAuth, (req, res) => {
  getTenant(req.clientId).db.deleteFinExpense(req.params.id);
  res.json({ ok: true });
});
app.put('/api/fin/months/:year/:month/distribution', requireAuth, (req, res) => {
  const db = getTenant(req.clientId).db;
  const m = db.getOrCreateFinMonth(Number(req.params.year), Number(req.params.month));
  res.json(db.upsertFinDistribution(m.id, req.body));
});

app.get('/test-chat', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test-chat.html'));
});

// SSE — mensagens em tempo real
app.get('/api/test-chat/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const t = getTenant(req.clientId);
  const state = getTestChatTenantState(t.clientId);
  state.sseClients.add(res);

  // Keepalive a cada 25s para evitar proxy timeout
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); state.sseClients.delete(res); });
});

// Histórico em memória (sem DB)
app.get('/api/test-chat/history', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const state = getTestChatTenantState(t.clientId);
  const { jid } = req.query;
  if (jid) return res.json(state.convs.get(jid) || []);
  const result = {};
  for (const [j, msgs] of state.convs) result[j] = msgs;
  res.json(result);
});

// Enviar mensagem
app.post('/api/test-chat/send', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  const { to, text, connectionId = 'web' } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to e text são obrigatórios' });
  const { sock, ready } = resolveBaileysConnection(t, connectionId);
  if (!ready || !sock) return res.status(503).json({ error: `Socket ${connectionId} não conectado` });
  try {
    const jid = normalizeJid(to);
    await sock.sendMessage(jid, { text });
    pushTestChatEntry(t.clientId, {
      id: Date.now().toString(),
      jid,
      fromMe: true,
      senderName: 'Eu',
      text,
      ts: Date.now(),
      connId: connectionId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cron ──────────────────────────────────────────────────

cron.schedule('* * * * *', () => {
  tenants.forEach(t => enqueueDueSchedules(t));
  void runSendAutomationsTick().catch(error => console.error('[send-automations] tick falhou:', error.message));
});
cron.schedule(MEDIA_CLEANUP_SCHEDULE, cleanupExpiredMedia);
cleanupExpiredMedia();
cron.schedule(MESSAGE_ARCHIVE_SCHEDULE, archiveOldMessagesAllClients);
archiveOldMessagesAllClients();
cron.schedule(VACUUM_SCHEDULE, vacuumAllClients);
// (sem chamada imediata aqui, diferente dos outros — VACUUM reescreve o arquivo inteiro;
// não faz sentido pagar esse custo a cada restart/deploy, só na janela semanal mesmo)
setInterval(() => { tenants.forEach(t => { enqueueDueSchedules(t); void processDispatchQueue(t); }); }, QUEUE_SCAN_INTERVAL_MS);
setInterval(() => { tenants.forEach(t => void processDispatchQueue(t)); }, 1000);

// Wake detection
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > 10000) {
    console.warn('Salto no tempo detectado. Reconectando clientes...');
    tenants.forEach(t => { if (t.isReady) void reconnectWebClient(t, 'System wake up'); });
  }
  lastTick = now;
}, 2000);

// ─── Helpers ───────────────────────────────────────────────

function loadEnvFile(dir = __dirname) {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ─── Start ─────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ===================== WhatsApp Lite (Evolution API) - gated por cliente =====================
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://127.0.0.1:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
function liteEnabled(t) { return !!EVOLUTION_API_KEY && !!t; }
function liteInstanceName(t, slot) { return `${(slot===2||slot==='2')?'lite2':'lite'}-${t.clientId}`; }
function liteWebhookUrl(clientId, slot) { return `https://${clientId}.gestorwagnnerpires.com.br/webhook/evolution/${clientId}${(slot===2||slot==='2')?'?conn=lite2':''}`; }
async function evoReq(method, pathStr, body, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 45000); // evita requisição pendurada travar a fila
  try {
    const r = await fetch(`${EVOLUTION_API_URL}${pathStr}`, { method, headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch { json = txt; }
    return { ok: r.ok, status: r.status, json };
  } catch (e) { return { ok: false, status: 0, json: { error: e.name === 'AbortError' ? 'Evolution timeout (sem resposta)' : e.message } }; }
  finally { clearTimeout(to); }
}

app.post('/api/lite/connect', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.status(404).json({ error: 'WhatsApp Lite nao habilitado.' });
  const slot = String((req.body && req.body.slot) || (req.query && req.query.slot) || '1');
  const inst = liteInstanceName(t, slot);
  const qrKey = slot === '2' ? '_lite2Qr' : '_liteQr';
  // Reconectar de propósito limpa a marca de "desligado", senão o /status continuaria
  // reportando desconectado e o watchdog não cuidaria mais deste slot.
  setLiteSlotDisabled(t, slot, false);
  const exists = await evoReq('GET', `/instance/fetchInstances?instanceName=${inst}`);
  let has = Array.isArray(exists.json) && exists.json.length > 0;

  // "Gerar novo QR": enquanto as credenciais antigas existirem, /instance/connect só
  // reata a sessão e nunca devolve QR. Pra realmente trocar de número é preciso
  // derrubar a sessão antes — logout quando ele funciona, delete quando não funciona
  // (socket meio-morto recusa logout com "Connection Closed").
  if (has && req.body && req.body.novoQr) {
    const out = await evoReq('DELETE', `/instance/logout/${inst}`);
    let st = await evoReq('GET', `/instance/connectionState/${inst}`, null, 8000);
    let estado = (st.json && st.json.instance && st.json.instance.state) || '';
    if (!out.ok || estado === 'open') {
      const del = await evoReq('DELETE', `/instance/delete/${inst}`);
      console.warn(`[${t.clientId}][lite${slot === '2' ? '2' : ''}] novo QR: logout=${out.ok} estado=${estado} → delete=${del.ok}`);
      if (!del.ok) return res.status(502).json({ error: 'A sessão antiga está travada no servidor do WhatsApp Lite: ela recusa tanto o logout quanto a exclusão, então não dá para gerar um QR novo por aqui.', detail: del.json, travada: true });
      has = false; // recriada logo abaixo, já com QR
    } else {
      has = false;
      await evoReq('DELETE', `/instance/delete/${inst}`);
    }
    t[qrKey] = null;
    // Deixa a Evolution assentar antes de recriar com o mesmo nome.
    await new Promise(r => setTimeout(r, 3000));
  }

  if (!has) {
    // O /instance/create do Evolution 2.3.7 estoura (erro de Prisma) se receber o bloco
    // "webhook" aninhado — cria sem ele e configura o webhook logo em seguida.
    // E logo depois de um delete ela também falha (estado residual em integrationSession),
    // então vale esperar e tentar de novo em vez de devolver erro na cara do usuário.
    let c = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      c = await evoReq('POST', '/instance/create', { instanceName: inst, integration: 'WHATSAPP-BAILEYS', qrcode: true });
      if (c.ok) break;
      console.warn(`[${t.clientId}][lite${slot === '2' ? '2' : ''}] create tentativa ${tentativa}/3 falhou:`, String(JSON.stringify(c.json || {})).slice(0, 200));
      if (tentativa < 3) await new Promise(r => setTimeout(r, 3000));
    }
    if (!c || !c.ok) {
      return res.status(500).json({ error: 'Falha ao criar instancia', detail: c && c.json });
    }
    // base64:false de propósito — com o arquivo embutido no webhook, um vídeo de 25 MB
    // vira ~33 MB de JSON e estoura o body-parser, derrubando a mensagem inteira.
    // O saveLiteMedia busca a mídia depois via getBase64FromMediaMessage.
    const w = await evoReq('POST', `/webhook/set/${inst}`, { webhook: { enabled: true, url: liteWebhookUrl(t.clientId, slot), byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'] } });
    if (!w.ok) console.warn(`[${t.clientId}][lite${slot === '2' ? '2' : ''}] instancia criada mas SEM webhook:`, String(JSON.stringify(w.json || {})).slice(0, 300));
    const qr = c.json && c.json.qrcode ? (c.json.qrcode.base64 || null) : null;
    t[qrKey] = qr || null;
    return res.json({ state: 'connecting', qr, webhookOk: !!w.ok });
  }
  const conn = await evoReq('GET', `/instance/connect/${inst}`);
  const qr = (conn.json && (conn.json.base64 || (conn.json.qrcode && conn.json.qrcode.base64))) || null;
  t[qrKey] = qr || t[qrKey] || null;
  return res.json({ state: 'connecting', qr });
});

app.get('/api/lite/status', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.json({ enabled: false });
  const slot = String((req.query && req.query.slot) || '1');
  // slot desativado manualmente (número movido pra API Oficial) → reporta desconectado
  let _disabled = [];
  try { _disabled = (t.db.getConfig() || {}).liteDisabledSlots || []; } catch {}
  if (_disabled.includes(slot)) return res.json({ enabled: true, state: 'close', disabled: true, number: '', qr: null });
  const r = await evoReq('GET', `/instance/connectionState/${liteInstanceName(t, slot)}`);
  const state = (r.json && r.json.instance && r.json.instance.state) || 'close';
  const qrKey = slot === '2' ? '_lite2Qr' : '_liteQr';
  if (state === 'open') t[qrKey] = null;
  res.json({ enabled: true, state, number: t[slot==='2'?'_lite2Number':'_liteNumber'] || '', qr: t[qrKey] || null });
});

// Marca/desmarca o slot como desligado de propósito. É esta flag que o watchdog,
// o webhook e o /status respeitam — sem ela o watchdog reconecta em até 90s e o
// botão "Desconectar" parece teimoso.
function setLiteSlotDisabled(t, slot, disabled) {
  let atual = [];
  try { atual = (t.db.getConfig() || {}).liteDisabledSlots || []; } catch {}
  const s = String(slot);
  const novo = disabled ? [...new Set([...atual, s])] : atual.filter(x => String(x) !== s);
  t.db.updateConfig({ liteDisabledSlots: novo });
  return novo;
}

app.post('/api/lite/disconnect', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.status(404).json({ error: 'nao habilitado' });
  const slot = String((req.body && req.body.slot) || (req.query && req.query.slot) || '1');
  const inst = liteInstanceName(t, slot);

  // Desliga ANTES do logout: se o watchdog rodar no meio, já encontra o slot marcado
  // e não ressuscita a sessão.
  setLiteSlotDisabled(t, slot, true);

  let out = await evoReq('DELETE', `/instance/logout/${inst}`);
  // Socket meio-morto costuma recusar o logout na primeira; uma segunda tentativa resolve.
  if (!out.ok) {
    await evoReq('GET', `/instance/connectionState/${inst}`, null, 8000);
    out = await evoReq('DELETE', `/instance/logout/${inst}`);
  }
  if (!out.ok) console.warn(`[${t.clientId}][lite${slot === '2' ? '2' : ''}] logout recusado pela Evolution:`, String(JSON.stringify(out.json || {})).slice(0, 200));

  if (slot==='2'){ t._lite2Number=''; t._lite2Connected=false; t._lite2Qr=null; } else { t._liteNumber=''; t._liteConnected=false; t._liteQr=null; }
  t[`_liteWasOpen_${slot}`] = false;

  const estado = await evoReq('GET', `/instance/connectionState/${inst}`, null, 8000);
  const state = (estado.json && estado.json.instance && estado.json.instance.state) || 'close';
  // Mesmo que a Evolution ainda diga "open", o slot está desligado do nosso lado:
  // watchdog não reconecta, webhook ignora e o painel mostra desconectado.
  res.json({ ok: true, desligado: true, logout: out.ok, estadoEvolution: state });
});

// ═══════════════ Agente — WhatsApp de comando (IA com tool-use, executa ações no CRM) ═══════════════
// Conexão Evolution própria, SEPARADA das slots lite/lite (1/2) de propósito — não é uma
// linha de atendimento a lead, é um canal de comando pro dono usar a ferramenta por voz/texto.
// Por isso não reaproveita liteInstanceName/slot (evita qualquer risco de mexer no código
// que já atende lead de verdade) e não grava as mensagens no histórico de conversa do CRM.
function agentInstanceName(t) { return `agente-${t.clientId}`; }
function agentWebhookUrl(clientId) { return `https://${clientId}.gestorwagnnerpires.com.br/webhook/agente/${clientId}`; }
function getAgentAllowedDigits(t) {
  const cfg = t.db.getConfig() || {};
  return new Set((Array.isArray(cfg.agentAllowedNumbers) ? cfg.agentAllowedNumbers : []).map(n => String(n).replace(/\D/g, '')).filter(Boolean));
}

const AGENT_TOOLS = [
  {
    name: 'create_task',
    description: 'Cria uma nova tarefa no CRM. Use quando o usuário pedir para criar, adicionar ou lembrar de fazer algo.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título/descrição curta da tarefa.' },
        ownerName: { type: 'string', description: 'Nome do cliente dono da tarefa, se o usuário mencionar um cliente. Deixe vazio (não inclua o campo) se for uma tarefa avulsa, sem cliente.' },
        due: { type: 'string', description: 'Data de vencimento no formato YYYY-MM-DD, só se o usuário mencionar uma data (hoje, amanhã, uma data específica etc). Deixe vazio se não houver data.' },
        responsavel: { type: 'string', description: 'Nome do responsável pela tarefa, só se o usuário mencionar quem vai fazer.' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_tasks',
    description: 'Lista tarefas do CRM. Use quando o usuário perguntar quais tarefas existem, o que tem pra fazer, tarefas de um cliente específico, ou tarefas atrasadas/de hoje.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Nome do cliente pra filtrar, se o usuário mencionar um cliente específico. Deixe vazio pra ver de todos os clientes.' },
        status: { type: 'string', enum: ['fazer', 'progresso', 'feito', 'all'], description: 'Filtrar por status. Padrão: all.' },
        onlyOverdueOrToday: { type: 'boolean', description: 'true pra mostrar só tarefas atrasadas ou que vencem hoje.' }
      },
      required: []
    }
  },
  {
    name: 'send_reportei_report',
    description: 'Gera o link do relatório de marketing (Reportei) de um cliente para um período específico e envia no grupo ou contato de WhatsApp monitorado desse cliente. Use quando o usuário pedir pra mandar/enviar/puxar o relatório de um cliente.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Nome do cliente (ex: Arroba, Megainvest, Sanger).' },
        start: { type: 'string', description: 'Data de início do período, formato YYYY-MM-DD. Se o usuário disser "esse mês", "mês passado" etc, calcule a data real a partir de hoje.' },
        end: { type: 'string', description: 'Data de fim do período, formato YYYY-MM-DD.' },
        targetType: { type: 'string', enum: ['contact', 'group'], description: 'Se o usuário pedir explicitamente pro "contato" ou pro "grupo" do cliente. Deixe vazio pra usar o que existir (prioriza grupo).' }
      },
      required: ['clientName', 'start', 'end']
    }
  },
  {
    name: 'schedule_message',
    description: 'Agenda uma mensagem de WhatsApp pra ser enviada numa data/hora futura, pro grupo monitorado de um cliente, pra um grupo de WhatsApp qualquer (pelo nome) ou pra um número direto. Use quando o usuário pedir pra programar, agendar ou marcar o envio de uma mensagem.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Nome do cliente, se a mensagem for pro contato ou grupo de WhatsApp monitorado desse cliente.' },
        targetType: { type: 'string', enum: ['contact', 'group'], description: 'Se o usuário pedir explicitamente pro "contato" ou pro "grupo" desse cliente. Deixe vazio pra usar o que existir.' },
        groupName: { type: 'string', description: 'Nome (ou parte do nome) de um grupo de WhatsApp, se não estiver vinculado a um cliente específico. Use quando o usuário citar o grupo pelo nome direto.' },
        phoneNumber: { type: 'string', description: 'Número de telefone direto (DDI+DDD+número, só dígitos), se não for pra um cliente nem grupo.' },
        message: { type: 'string', description: 'Texto da mensagem a enviar.' },
        when: { type: 'string', description: 'Data e hora do envio, formato YYYY-MM-DD HH:mm (24h). Calcule a partir de hoje se o usuário falar de forma relativa (ex: "amanhã às 9h", "sexta de manhã").' }
      },
      required: ['message', 'when']
    }
  },
  {
    name: 'create_ad_campaign',
    description: 'Cria e ativa uma campanha de anúncio no Meta Ads (Facebook/Instagram) pra um cliente, usando o post mais recente da Página dele como criativo. Use quando o usuário pedir pra subir, criar ou lançar uma campanha/anúncio. Isso gasta dinheiro de verdade a partir da criação — não peça confirmação, o usuário já autorizou isso previamente.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Nome do cliente.' },
        objective: { type: 'string', enum: ['trafego', 'engajamento', 'alcance'], description: 'Objetivo: trafego (cliques no link), engajamento (curtidas/comentários no post) ou alcance (mostrar pro máximo de gente possível). Padrão: trafego.' },
        dailyBudget: { type: 'number', description: 'Orçamento diário em reais (ex: 50 para R$50/dia).' },
        campaignName: { type: 'string', description: 'Nome da campanha, se o usuário especificar. Deixe vazio pra gerar um nome automático.' }
      },
      required: ['clientName', 'objective', 'dailyBudget']
    }
  },
  {
    name: 'list_ad_campaigns',
    description: 'Lista as campanhas de anúncio Meta Ads de um cliente, com nome, status e objetivo.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' } }, required: ['clientName'] }
  },
  {
    name: 'get_ad_insights',
    description: 'Mostra o desempenho (gasto, cliques, impressões, resultados como leads/mensagens/compras) de uma campanha específica ou da conta toda de anúncios de um cliente, num período. Use quando o usuário perguntar como está indo/performando um anúncio ou campanha.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string' },
      campaignName: { type: 'string', description: 'Nome (ou parte do nome) da campanha. Deixe vazio pra ver a conta toda.' },
      datePreset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'], description: 'Período. Padrão: last_30d.' }
    }, required: ['clientName'] }
  },
  {
    name: 'list_clients',
    description: 'Lista todos os clientes cadastrados na Área de Clientes, com nome e grupo. Use ISSO ANTES de desistir quando outra ferramenta disser que um cliente não foi encontrado — o nome que a pessoa falou pode estar levemente diferente do nome salvo, e comparando com a lista real você geralmente acha o nome certo sozinho, sem precisar perguntar de volta.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'save_memory',
    description: 'Guarda um fato ou informação importante pra lembrar PERMANENTEMENTE, em qualquer conversa futura (ex: preferência de um cliente, uma decisão tomada, um contexto do negócio que não muda com frequência). Use quando o usuário disser "lembra disso"/"guarda essa informação", ou proativamente quando perceber algo que vale a pena nunca esquecer.',
    input_schema: { type: 'object', properties: { fact: { type: 'string', description: 'O fato a lembrar, de forma clara, objetiva e que faça sentido sozinho (sem depender do contexto da conversa atual).' } }, required: ['fact'] }
  },
  {
    name: 'forget_memory',
    description: 'Apaga uma informação guardada anteriormente na SUA memória permanente (a do Agente, não a do atendente de IA), que não é mais válida ou que o usuário pediu pra esquecer.',
    input_schema: { type: 'object', properties: { searchText: { type: 'string', description: 'Trecho do fato a esquecer, pra encontrar e remover.' } }, required: ['searchText'] }
  },
  {
    name: 'teach_ai_attendant',
    description: 'Ensina algo pro ATENDENTE de IA (o chatbot que conversa com leads/clientes, diferente de você/Agente) — o fato passa a valer em qualquer conversa dele com qualquer lead. Use quando o usuário pedir pra ensinar/corrigir/atualizar o que o atendente sabe ou como ele deve responder.',
    input_schema: { type: 'object', properties: { fact: { type: 'string', description: 'O que o atendente deve saber/fazer, de forma clara e objetiva.' } }, required: ['fact'] }
  },
  {
    name: 'forget_ai_attendant_fact',
    description: 'Apaga algo que o atendente de IA (chatbot de leads) tinha aprendido antes.',
    input_schema: { type: 'object', properties: { searchText: { type: 'string', description: 'Trecho do fato a remover.' } }, required: ['searchText'] }
  },
  {
    name: 'edit_client',
    description: 'Edita nome, grupo ou status de um cliente existente na Área de Clientes.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Nome atual do cliente.' },
      newName: { type: 'string', description: 'Novo nome, se for pra trocar.' },
      group: { type: 'string', description: 'Novo grupo, se for pra trocar.' },
      status: { type: 'string', description: 'Novo status, se for pra trocar.' }
    }, required: ['clientName'] }
  },
  {
    name: 'delete_client',
    description: 'Apaga um cliente inteiro da Área de Clientes, com todas as tarefas, notas e histórico dele. Ação irreversível — use só quando o usuário pedir claramente pra excluir/apagar/remover um cliente.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Nome do cliente a apagar.' } }, required: ['clientName'] }
  },
  {
    name: 'add_client_note',
    description: 'Adiciona uma nota/observação na ficha de um cliente.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string' }, text: { type: 'string', description: 'Texto da nota.' }
    }, required: ['clientName', 'text'] }
  },
  {
    name: 'manage_client_password',
    description: 'Gerencia senhas/credenciais guardadas na ficha de um cliente (ex: senha de login de uma ferramenta, do site, etc). action=add cria uma nova, action=list mostra as que já existem (só o serviço e login, nunca manda a senha em texto puro de volta a menos que o usuário peça explicitamente pra ver), action=remove apaga uma.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string' },
      action: { type: 'string', enum: ['add', 'list', 'remove', 'reveal'] },
      service: { type: 'string', description: 'Nome do serviço (ex: "Instagram", "Hospedagem"). Necessário pra add e útil pra identificar em remove/reveal.' },
      login: { type: 'string', description: 'Usuário/login, pra action=add.' },
      password: { type: 'string', description: 'Senha, pra action=add.' }
    }, required: ['clientName', 'action'] }
  },
  {
    name: 'link_client_account',
    description: 'Vincula uma conta de anúncios (Meta ou Google), projeto Reportei ou Página do Facebook a um cliente.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string' },
      accountType: { type: 'string', enum: ['meta', 'google', 'reportei', 'page'] },
      accountId: { type: 'string', description: 'ID numérico da conta/projeto/página.' }
    }, required: ['clientName', 'accountType', 'accountId'] }
  },
  {
    name: 'add_monitored_group',
    description: 'Vincula um grupo de WhatsApp (que o número já participa) a um cliente, pra poder mandar relatório/mensagem nele depois. Busca pelo nome do grupo entre os grupos que o WhatsApp já conhece.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string' }, groupName: { type: 'string', description: 'Nome (ou parte do nome) do grupo de WhatsApp a vincular.' }
    }, required: ['clientName', 'groupName'] }
  },
  {
    name: 'add_monitored_contact',
    description: 'Vincula um contato individual de WhatsApp (que o número já conversou) a um cliente, pra poder mandar mensagem direto pra pessoa depois. Busca pelo nome entre os contatos individuais já conhecidos.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string' }, contactName: { type: 'string', description: 'Nome (ou parte do nome) do contato individual a vincular.' }
    }, required: ['clientName', 'contactName'] }
  },
  {
    name: 'list_whatsapp_contacts',
    description: 'Lista os contatos INDIVIDUAIS de WhatsApp (não grupos) que o número já conhece, com o nome de cada um. Use quando precisar achar/vincular um contato pelo nome e não souber se ele já existe.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'create_lead',
    description: 'Cria um novo lead/card no funil de vendas (pipeline de CRM, diferente da Área de Clientes).',
    input_schema: { type: 'object', properties: {
      contactName: { type: 'string', description: 'Nome do lead.' },
      phone: { type: 'string', description: 'Telefone do lead, se souber.' },
      columnName: { type: 'string', description: 'Nome da coluna do funil onde criar (ex: "Novos Leads"). Deixe vazio pra usar a primeira coluna.' },
      notes: { type: 'string', description: 'Observação inicial, se houver.' }
    }, required: ['contactName'] }
  },
  {
    name: 'move_lead',
    description: 'Move um lead existente pra outra coluna do funil de vendas (ex: de "Novos Leads" pra "Fechado").',
    input_schema: { type: 'object', properties: {
      contactName: { type: 'string', description: 'Nome do lead a mover.' },
      columnName: { type: 'string', description: 'Nome da coluna de destino.' }
    }, required: ['contactName', 'columnName'] }
  },
  {
    name: 'list_leads',
    description: 'Lista os leads do funil de vendas, opcionalmente filtrando por coluna.',
    input_schema: { type: 'object', properties: {
      columnName: { type: 'string', description: 'Nome da coluna pra filtrar. Deixe vazio pra ver todas.' }
    }, required: [] }
  },
  {
    name: 'delete_lead',
    description: 'Apaga um lead do funil de vendas. Ação irreversível.',
    input_schema: { type: 'object', properties: { contactName: { type: 'string' } }, required: ['contactName'] }
  },
  {
    name: 'send_message_now',
    description: 'Manda uma mensagem de WhatsApp imediatamente (não agendada) pro contato ou grupo de um cliente, pra um grupo de WhatsApp qualquer (pelo nome) ou pra um número direto.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Nome do cliente, se for pro contato ou grupo monitorado dele.' },
      targetType: { type: 'string', enum: ['contact', 'group'], description: 'Se o usuário pedir explicitamente pro "contato" ou pro "grupo" desse cliente. Deixe vazio pra usar o que existir.' },
      groupName: { type: 'string', description: 'Nome (ou parte do nome) de um grupo de WhatsApp, se não estiver vinculado a um cliente. Use quando o usuário citar o grupo pelo nome direto (ex: "manda no grupo Base").' },
      phoneNumber: { type: 'string', description: 'Número direto (DDI+DDD+número), se não for pra um cliente nem grupo.' },
      message: { type: 'string' }
    }, required: ['message'] }
  },
  {
    name: 'list_whatsapp_groups',
    description: 'Lista os grupos de WhatsApp que o número já conhece (já teve mensagem trocada), com o nome de cada um — inclusive os que ainda não estão vinculados a nenhum cliente. Use ANTES de desistir quando precisar mandar mensagem num grupo pelo nome e não souber a qual cliente ele pertence (ou se pertence a algum).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'edit_task',
    description: 'Edita status, responsável ou vencimento de uma tarefa já existente (ache pelo título e cliente/avulsa).',
    input_schema: { type: 'object', properties: {
      title: { type: 'string', description: 'Título (ou parte do título) da tarefa a editar.' },
      clientName: { type: 'string', description: 'Cliente dono da tarefa, se souber. Deixe vazio pra buscar entre avulsas.' },
      status: { type: 'string', enum: ['fazer', 'progresso', 'feito'] },
      responsavel: { type: 'string' },
      due: { type: 'string', description: 'Nova data YYYY-MM-DD, se for pra trocar.' }
    }, required: ['title'] }
  },
  {
    name: 'delete_task',
    description: 'Apaga uma tarefa (ache pelo título e cliente/avulsa). Ação irreversível.',
    input_schema: { type: 'object', properties: {
      title: { type: 'string' }, clientName: { type: 'string', description: 'Deixe vazio pra buscar entre avulsas.' }
    }, required: ['title'] }
  }
];

// ── Meta Ads: cria campanha/conjunto/criativo/anúncio via Graph API, usando o token central
// (meta-config.json, mesmo usado pelo painel de Anúncios). Orçamento em BRL é em CENTAVOS —
// confirmado ao vivo com um teste real (daily_budget=2000 virou R$20,00, não R$2000) antes
// de deixar isso ativar campanha de verdade sem confirmação.
const META_GRAPH_VERSION = 'v22.0';
const AGENT_AD_OBJECTIVES = {
  trafego: { objective: 'OUTCOME_TRAFFIC', billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS' },
  engajamento: { objective: 'OUTCOME_ENGAGEMENT', billing_event: 'IMPRESSIONS', optimization_goal: 'POST_ENGAGEMENT' },
  alcance: { objective: 'OUTCOME_AWARENESS', billing_event: 'IMPRESSIONS', optimization_goal: 'REACH' }
};
async function metaGraphPost(pathStr, params) {
  const token = loadMetaToken();
  if (!token) throw new Error('Token de anúncios (meta-config.json) não configurado');
  // .append em vez de passar array direto pro URLSearchParams — necessário pra campos
  // multi-valor tipo "tasks" (a API só reconhece tasks=A&tasks=B repetido, não "A,B").
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => body.append(k, x)); else body.append(k, v);
  }
  body.append('access_token', token);
  const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pathStr}`, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error(j.error.error_user_msg || j.error.message || 'Erro na API da Meta');
  return j;
}
// Usuário de sistema "monitor_ads" do Business Manager — mesmo dono do token em
// meta-config.json. ID fixo (não muda), confirmado via GET /me com esse token.
const META_SYSTEM_USER_ID = '122103041607318761';
// Compartilha automaticamente uma conta de anúncios ou Página com o monitor_ads assim que
// ela é vinculada a um cliente no CRM — sem isso, colar o ID no cliente não autorizava nada
// de verdade (só guardava o número), e o Agente não conseguia agir na conta.
// Só funciona se a conta/Página já estiver ao alcance do Business Manager do Wagner (dele
// mesmo ou compartilhada como conta de cliente) — pra ativo de terceiro nunca visto antes,
// a Meta recusa e precisa de convite manual, não tem como automatizar por API.
async function metaAutoShareAsset(kind, assetId) {
  const path = kind === 'page' ? assetId : `act_${assetId}`;
  const tasks = kind === 'page' ? ['MANAGE'] : ['MANAGE', 'ADVERTISE'];
  try {
    await metaGraphPost(`${path}/assigned_users`, { user: META_SYSTEM_USER_ID, tasks });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function metaGraphGet(pathStr, params) {
  const token = loadMetaToken();
  if (!token) throw new Error('Token de anúncios (meta-config.json) não configurado');
  const qs = new URLSearchParams(Object.assign({}, params || {}, { access_token: token }));
  const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pathStr}?${qs}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.error_user_msg || j.error.message || 'Erro na API da Meta');
  return j;
}
async function agentCreateAdCampaign(t, input) {
  const clientName = String((input && input.clientName) || '').trim();
  if (!clientName) return { ok: false, error: 'nome do cliente vazio' };
  const a = getClientAreaObj(t);
  const needle = clientName.toLowerCase();
  const client = a.clients.find(c => String(c.name || '').toLowerCase().includes(needle));
  if (!client) return { ok: false, error: `cliente "${clientName}" não encontrado no CRM` };
  if (!client.metaAccountId) return { ok: false, error: `cliente "${client.name}" não tem conta de anúncios Meta vinculada (metaAccountId)` };
  if (!client.pageId) return { ok: false, error: `cliente "${client.name}" não tem Página do Facebook vinculada (campo pageId) — preciso disso pra saber qual post anunciar` };
  const objKey = String((input && input.objective) || 'trafego').toLowerCase();
  const objCfg = AGENT_AD_OBJECTIVES[objKey] || AGENT_AD_OBJECTIVES.trafego;
  const dailyBudgetReais = Number((input && input.dailyBudget) || 0);
  if (!dailyBudgetReais || dailyBudgetReais <= 0) return { ok: false, error: 'orçamento diário inválido' };
  const dailyBudgetCents = Math.round(dailyBudgetReais * 100);
  const accountPath = `act_${client.metaAccountId}`;
  const campaignName = String((input && input.campaignName) || `${client.name} - ${objKey} - ${brTodayLabel(Date.now())}`).slice(0, 100);
  try {
    const camp = await metaGraphPost(`${accountPath}/campaigns`, {
      name: campaignName, objective: objCfg.objective, status: 'ACTIVE',
      special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false'
    });
    const adset = await metaGraphPost(`${accountPath}/adsets`, {
      name: `${campaignName} - conjunto`, campaign_id: camp.id,
      daily_budget: String(dailyBudgetCents), billing_event: objCfg.billing_event, optimization_goal: objCfg.optimization_goal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'ACTIVE',
      targeting: JSON.stringify({ geo_locations: { countries: ['BR'] } })
    });
    const posts = await metaGraphGet(`${client.pageId}/posts`, { limit: '1' });
    const post = posts.data && posts.data[0];
    if (!post) return { ok: false, error: `Campanha e conjunto criados (id ${camp.id}), mas a Página do cliente "${client.name}" não tem nenhum post pra virar anúncio — ficou sem o anúncio em si.` };
    const creative = await metaGraphPost(`${accountPath}/adcreatives`, {
      name: `${campaignName} - criativo`, object_story_id: post.id
    });
    const ad = await metaGraphPost(`${accountPath}/ads`, {
      name: `${campaignName} - anúncio`, adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creative.id }), status: 'ACTIVE'
    });
    return { ok: true, campaignId: camp.id, adsetId: adset.id, adId: ad.id, dailyBudgetReais, objective: objKey, client: client.name };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function agentListAdCampaigns(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  if (!client.metaAccountId) return { ok: false, error: `cliente "${client.name}" não tem conta de anúncios Meta vinculada` };
  try {
    const r = await metaGraphGet(`act_${client.metaAccountId}/campaigns`, { fields: 'id,name,status,objective', limit: '50' });
    return { ok: true, client: client.name, campaigns: (r.data || []).map(c => ({ name: c.name, status: c.status, objective: c.objective })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Nomes de action_type crus da Meta são internos/técnicos demais pra mandar direto pro
// WhatsApp — traduz só os mais úteis pra decisão de negócio, ignora o resto (visualização
// de vídeo, curtida de post etc não interessam pra maioria das perguntas de desempenho).
const AGENT_AD_ACTION_LABELS = {
  'lead': 'leads', 'onsite_conversion.lead': 'leads no site', 'onsite_conversion.lead_grouped': 'leads (total)',
  'link_click': 'cliques no link', 'onsite_conversion.messaging_conversation_started_7d': 'conversas iniciadas no whatsapp/messenger',
  'purchase': 'compras', 'offsite_conversion.fb_pixel_purchase': 'compras (pixel)', 'onsite_conversion.total_messaging_connection': 'mensagens recebidas'
};
function agentSummarizeActions(actions) {
  const out = {};
  (Array.isArray(actions) ? actions : []).forEach(a => { const label = AGENT_AD_ACTION_LABELS[a.action_type]; if (label) out[label] = (out[label] || 0) + Number(a.value || 0); });
  return out;
}
async function agentGetAdInsights(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  if (!client.metaAccountId) return { ok: false, error: `cliente "${client.name}" não tem conta de anúncios Meta vinculada` };
  const validPresets = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'];
  const datePreset = validPresets.includes(input && input.datePreset) ? input.datePreset : 'last_30d';
  let path = `act_${client.metaAccountId}/insights`;
  let campaignLabel = 'conta toda';
  const campaignName = String((input && input.campaignName) || '').trim();
  if (campaignName) {
    try {
      const list = await metaGraphGet(`act_${client.metaAccountId}/campaigns`, { fields: 'id,name', limit: '100' });
      const needle = campaignName.toLowerCase();
      const camp = (list.data || []).find(c => String(c.name || '').toLowerCase().includes(needle));
      if (!camp) return { ok: false, error: `campanha "${campaignName}" não encontrada` };
      path = `${camp.id}/insights`; campaignLabel = camp.name;
    } catch (e) { return { ok: false, error: e.message }; }
  }
  try {
    const r = await metaGraphGet(path, { fields: 'spend,impressions,clicks,ctr,cpc,actions', date_preset: datePreset });
    const row = (r.data && r.data[0]) || null;
    if (!row) return { ok: true, campaign: campaignLabel, period: datePreset, semDados: true };
    return {
      ok: true, campaign: campaignLabel, period: datePreset,
      spend: 'R$ ' + Number(row.spend || 0).toFixed(2), impressions: row.impressions, clicks: row.clicks,
      ctr: row.ctr ? Number(row.ctr).toFixed(2) + '%' : null, cpc: row.cpc ? 'R$ ' + Number(row.cpc).toFixed(2) : null,
      results: agentSummarizeActions(row.actions)
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Reportei: gera link de relatório de período específico via API oficial ──
async function reporteiFetchIntegrationIds(projectId) {
  const token = process.env.REPORTEI_API_TOKEN;
  if (!token) throw new Error('REPORTEI_API_TOKEN não configurado');
  const r = await fetch(`https://app.reportei.com/api/v2/integrations?project_id=${encodeURIComponent(projectId)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const j = await r.json();
  if (!j || !Array.isArray(j.data)) throw new Error('Falha ao buscar integrações do projeto Reportei');
  return j.data.map(i => i.id);
}
// Template "Padrão" da conta Reportei (id 9380) — mesmo usado no teste manual que confirmou o fluxo.
const REPORTEI_DEFAULT_TEMPLATE_ID = 9380;
async function reporteiCreateReportUrl(projectId, title, start, end) {
  const token = process.env.REPORTEI_API_TOKEN;
  if (!token) throw new Error('REPORTEI_API_TOKEN não configurado');
  const integrationIds = await reporteiFetchIntegrationIds(projectId);
  if (!integrationIds.length) throw new Error('Projeto Reportei sem integrações conectadas');
  const body = JSON.stringify({ title, subtitle: `${start} a ${end}`, start, end, template_id: REPORTEI_DEFAULT_TEMPLATE_ID, integration_ids: integrationIds, project_id: Number(projectId) });
  const r = await fetch('https://app.reportei.com/api/v2/reports', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
  const j = await r.json();
  if (!j || !j.report || !j.report.external_url) throw new Error('Reportei não retornou link do relatório');
  return j.report.external_url;
}
async function agentSendReporteiReport(t, input) {
  const clientName = String((input && input.clientName) || '').trim();
  if (!clientName) return { ok: false, error: 'nome do cliente vazio' };
  const a = getClientAreaObj(t);
  const needle = clientName.toLowerCase();
  const client = a.clients.find(c => String(c.name || '').toLowerCase().includes(needle));
  if (!client) return { ok: false, error: `cliente "${clientName}" não encontrado no CRM` };
  if (!client.reporteiProjectId) return { ok: false, error: `cliente "${client.name}" não tem projeto Reportei vinculado` };
  // Relatório é mais "broadcast" — prioriza grupo por padrão, diferente de mensagem avulsa.
  const target = agentResolveClientTarget(client, (input && input.targetType) || 'group');
  if (!target) return { ok: false, error: `cliente "${client.name}" não tem grupo nem contato de WhatsApp monitorado pra enviar o relatório` };
  const start = String((input && input.start) || '').trim();
  const end = String((input && input.end) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { ok: false, error: 'período inválido, use YYYY-MM-DD' };
  let url;
  try { url = await reporteiCreateReportUrl(client.reporteiProjectId, `Relatório ${client.name}`, start, end); }
  catch (e) { return { ok: false, error: 'Falha na Reportei: ' + e.message }; }
  const texto = `📊 Relatório de marketing — ${client.name}\nPeríodo: ${start} a ${end}\n${url}`;
  const slot = await agentPickConnectedLiteSlot(t);
  const r = await evoReq('POST', `/message/sendText/${liteInstanceName(t, slot)}`, { number: target.id, text: texto });
  if (!r.ok) return { ok: false, error: `Falha ao enviar no WhatsApp (slot ${slot}, HTTP ${r.status}): ${agentEvoErrText(r)}` };
  return { ok: true, sentTo: target.name, url };
}

function agentResolveDue(dueStr) {
  if (!dueStr) return null;
  const m = String(dueStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(`${dueStr}T12:00:00`).getTime();
}

function agentCreateTask(t, input) {
  const title = String((input && input.title) || '').trim();
  if (!title) return { ok: false, error: 'título vazio' };
  const a = getClientAreaObj(t);
  let owner = null;
  const ownerName = String((input && input.ownerName) || '').trim();
  if (ownerName) {
    const needle = ownerName.toLowerCase();
    owner = a.clients.find(c => String(c.name || '').toLowerCase().includes(needle)) || null;
  }
  const task = sanitizeClientTask({ title, due: agentResolveDue(input && input.due), responsavel: (input && input.responsavel) || '' });
  if (owner) {
    owner.tasks = Array.isArray(owner.tasks) ? owner.tasks : [];
    owner.tasks.push(task);
    saveClientAreaClients(t, a.clients);
    return { ok: true, ownerLabel: owner.name, task: { title: task.title, due: task.due, responsavel: task.responsavel } };
  }
  a.avulsas.push(task);
  saveClientAreaAvulsas(t, a.avulsas);
  return { ok: true, ownerLabel: ownerName ? `cliente "${ownerName}" não encontrado, criada como avulsa` : 'avulsa', task: { title: task.title, due: task.due, responsavel: task.responsavel } };
}

function agentListTasks(t, input) {
  const a = getClientAreaObj(t);
  const clientNameRaw = String((input && input.clientName) || '').trim();
  const status = String((input && input.status) || 'all').toLowerCase();
  const onlyUrgent = !!(input && input.onlyOverdueOrToday);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const rows = [];
  const collect = (ownerName, tasks) => {
    (Array.isArray(tasks) ? tasks : []).forEach(tk => {
      if (status !== 'all' && tk.status !== status) return;
      if (onlyUrgent && !(tk.due && Number(tk.due) <= todayEnd.getTime())) return;
      rows.push({ owner: ownerName, title: tk.title, status: tk.status, due: tk.due ? new Date(Number(tk.due)).toLocaleDateString('pt-BR') : null, responsavel: tk.responsavel || '' });
    });
  };
  if (clientNameRaw) {
    const needle = clientNameRaw.toLowerCase();
    const client = a.clients.find(c => String(c.name || '').toLowerCase().includes(needle));
    if (!client) return { ok: false, error: `cliente "${clientNameRaw}" não encontrado` };
    collect(client.name, client.tasks);
  } else {
    a.clients.forEach(c => collect(c.name, c.tasks));
    collect('avulsa', a.avulsas);
  }
  rows.sort((x, y) => (x.due ? 0 : 1) - (y.due ? 0 : 1));
  return { ok: true, count: rows.length, tasks: rows.slice(0, 30), obs: rows.length > 30 ? 'lista cortada em 30, tem mais tarefas além dessas' : undefined };
}

async function agentScheduleMessage(t, input) {
  const message = String((input && input.message) || '').trim();
  if (!message) return { ok: false, error: 'mensagem vazia' };
  const whenStr = String((input && input.when) || '').trim();
  const m = whenStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return { ok: false, error: 'data/hora inválida, use YYYY-MM-DD HH:mm' };
  const scheduledFor = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`).getTime();
  if (!scheduledFor || scheduledFor < Date.now()) return { ok: false, error: 'data/hora precisa ser no futuro' };
  const target = agentResolveMessageTarget(t, input);
  if (target.error) return { ok: false, error: target.error };
  // Escolhe o slot conectado AGORA — pra grupo, sendGroupViaLite ainda tenta o outro slot
  // sozinho se esse falhar na hora do disparo, mas pra contato individual não tem fallback
  // (sendIndividualViaLite respeita só o que for gravado aqui), então isso precisa acertar.
  const connSlot = await agentPickConnectedLiteSlot(t);
  const recipientType = target.recipientId.endsWith('@g.us') ? 'group' : 'contact';
  const id = t.db.createSchedule({ recipientType, recipientId: target.recipientId, recipientName: target.recipientName, message, scheduledFor, documentPath: null, documentName: null, quickReplies: [], bulkId: `agente-${Date.now().toString(36)}`, connectionId: connSlot === '2' ? 'lite2' : 'lite' });
  return { ok: true, scheduledFor: new Date(scheduledFor).toLocaleString('pt-BR'), to: target.recipientName, id };
}

// Nome dito pelo usuário raramente bate 100% com o nome salvo (erro de digitação, abreviação,
// acento) — tenta substring direto primeiro (rápido, cobre a maioria) e cai pra comparação
// palavra-a-palavra por prefixo (ex: "Grup" casa com "Group") antes de desistir.
function agentNormalizeName(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }
function agentNameMatches(name, needle) {
  const n = agentNormalizeName(name), q = agentNormalizeName(needle);
  if (!q) return false;
  if (n.includes(q)) return true;
  const nWords = n.split(/\s+/), qWords = q.split(/\s+/);
  return qWords.every(qw => nWords.some(nw => nw.startsWith(qw) || qw.startsWith(nw)));
}
function agentFindClient(a, name) {
  const needle = String(name || '').trim();
  if (!needle) return null;
  return a.clients.find(c => agentNameMatches(c.name, needle)) || null;
}
// Um cliente pode ter contato individual monitorado, grupo monitorado, os dois ou nenhum
// (mesmos dois tipos que já existem na ficha, seção Monitoramento). preferType deixa o
// chamador pedir um tipo específico ("pro contato do Muquem" vs "pro grupo"); sem isso,
// prioriza contato individual (mensagem pessoal é o caso mais comum de "manda pro Fulano").
function agentResolveClientTarget(client, preferType) {
  const contacts = (client.monitor && Array.isArray(client.monitor.crmContacts)) ? client.monitor.crmContacts : [];
  const groups = (client.monitor && Array.isArray(client.monitor.groups)) ? client.monitor.groups : [];
  if (preferType === 'group' && groups.length) return { id: groups[0].id, name: groups[0].name || client.name };
  if (preferType === 'contact' && contacts.length) return { id: contacts[0].id, name: contacts[0].name || client.name };
  if (contacts.length) return { id: contacts[0].id, name: contacts[0].name || client.name };
  if (groups.length) return { id: groups[0].id, name: groups[0].name || client.name };
  return null;
}
function agentListClients(t) {
  const a = getClientAreaObj(t);
  return { ok: true, count: a.clients.length, clients: a.clients.map(c => ({ name: c.name, group: c.group || '' })) };
}

function agentEditClient(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  if (input.newName) client.name = String(input.newName).slice(0, 120);
  if ('group' in (input || {})) client.group = String(input.group || '').slice(0, 60);
  if ('status' in (input || {})) client.status = String(input.status || '').slice(0, 60);
  saveClientAreaClients(t, a.clients);
  return { ok: true, client: client.name };
}

function agentDeleteClient(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  const clients = a.clients.filter(c => c.id !== client.id);
  saveClientAreaClients(t, clients);
  return { ok: true, deleted: client.name };
}

function agentAddClientNote(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  const text = String((input && input.text) || '').trim().slice(0, 1000);
  if (!text) return { ok: false, error: 'nota vazia' };
  client.notas = Array.isArray(client.notas) ? client.notas : [];
  client.notas.push({ id: 'nota-' + Math.random().toString(36).slice(2, 8), text, date: new Date().toLocaleString('pt-BR'), attachments: [] });
  saveClientAreaClients(t, a.clients);
  return { ok: true, client: client.name };
}

function agentManageClientPassword(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  client.senhas = Array.isArray(client.senhas) ? client.senhas : [];
  const action = String((input && input.action) || '').toLowerCase();
  if (action === 'add') {
    const service = String((input && input.service) || '').trim();
    if (!service) return { ok: false, error: 'informe o serviço' };
    const entry = { id: 'pw-' + Math.random().toString(36).slice(2, 8), service: service.slice(0, 80), login: String((input && input.login) || '').slice(0, 120), password: String((input && input.password) || '').slice(0, 200) };
    client.senhas.push(entry);
    saveClientAreaClients(t, a.clients);
    return { ok: true, added: service };
  }
  if (action === 'list') {
    return { ok: true, senhas: client.senhas.map(s => ({ service: s.service, login: s.login })) };
  }
  if (action === 'reveal') {
    const needle = String((input && input.service) || '').toLowerCase();
    const found = client.senhas.filter(s => !needle || String(s.service || '').toLowerCase().includes(needle));
    return { ok: true, senhas: found.map(s => ({ service: s.service, login: s.login, password: s.password })) };
  }
  if (action === 'remove') {
    const needle = String((input && input.service) || '').toLowerCase();
    const before = client.senhas.length;
    client.senhas = client.senhas.filter(s => !String(s.service || '').toLowerCase().includes(needle));
    saveClientAreaClients(t, a.clients);
    return { ok: true, removed: before - client.senhas.length };
  }
  return { ok: false, error: 'action inválida' };
}

function agentLinkClientAccount(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  const id = String((input && input.accountId) || '').replace(/\D/g, '').slice(0, 30);
  if (!id) return { ok: false, error: 'ID inválido' };
  const fieldByType = { meta: 'metaAccountId', google: 'googleAccountId', reportei: 'reporteiProjectId', page: 'pageId' };
  const field = fieldByType[String((input && input.accountType) || '').toLowerCase()];
  if (!field) return { ok: false, error: 'accountType inválido' };
  client[field] = id;
  saveClientAreaClients(t, a.clients);
  if (field === 'metaAccountId') metaAutoShareAsset('account', id).catch(() => {});
  if (field === 'pageId') metaAutoShareAsset('page', id).catch(() => {});
  return { ok: true, client: client.name, field, id };
}

function agentAddMonitoredGroup(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  const needle = String((input && input.groupName) || '').trim().toLowerCase();
  if (!needle) return { ok: false, error: 'informe o nome do grupo' };
  const convs = t.db.getConversations() || [];
  const group = convs.find(c => String(c.contactId || '').endsWith('@g.us') && String(c.contactName || '').toLowerCase().includes(needle));
  if (!group) return { ok: false, error: `grupo "${input.groupName}" não encontrado entre os grupos conhecidos` };
  client.monitor = client.monitor && typeof client.monitor === 'object' ? client.monitor : { groups: [], crmContacts: [] };
  client.monitor.groups = Array.isArray(client.monitor.groups) ? client.monitor.groups : [];
  if (!client.monitor.groups.some(g => g.id === group.contactId)) client.monitor.groups.push({ id: group.contactId, name: group.contactName });
  saveClientAreaClients(t, a.clients);
  return { ok: true, client: client.name, group: group.contactName };
}

function agentFindIndividualContact(t, contactName) {
  const needle = String(contactName || '').trim();
  if (!needle) return null;
  const convs = t.db.getConversations() || [];
  return convs.find(c => String(c.contactId || '').endsWith('@s.whatsapp.net') && agentNameMatches(c.contactName, needle)) || null;
}
function agentListWhatsappContacts(t) {
  const convs = t.db.getConversations() || [];
  const contacts = convs.filter(c => String(c.contactId || '').endsWith('@s.whatsapp.net'));
  return { ok: true, count: contacts.length, contacts: contacts.slice(0, 50).map(c => ({ name: c.contactName })) };
}
function agentAddMonitoredContact(t, input) {
  const a = getClientAreaObj(t);
  const client = agentFindClient(a, input && input.clientName);
  if (!client) return { ok: false, error: `cliente "${input && input.clientName}" não encontrado` };
  const contactName = String((input && input.contactName) || '').trim();
  if (!contactName) return { ok: false, error: 'informe o nome do contato' };
  const contact = agentFindIndividualContact(t, contactName);
  if (!contact) return { ok: false, error: `contato "${contactName}" não encontrado entre os contatos conhecidos — tente list_whatsapp_contacts` };
  client.monitor = client.monitor && typeof client.monitor === 'object' ? client.monitor : { groups: [], crmContacts: [] };
  client.monitor.crmContacts = Array.isArray(client.monitor.crmContacts) ? client.monitor.crmContacts : [];
  if (!client.monitor.crmContacts.some(c => c.id === contact.contactId)) client.monitor.crmContacts.push({ id: contact.contactId, name: contact.contactName });
  saveClientAreaClients(t, a.clients);
  return { ok: true, client: client.name, contact: contact.contactName };
}

function agentFindColumn(t, columnName) {
  const cols = t.db.getCrmColumns();
  if (!columnName) return cols[0] || null;
  const needle = String(columnName).toLowerCase();
  return cols.find(c => String(c.name || '').toLowerCase().includes(needle)) || cols[0] || null;
}

function agentCreateLead(t, input) {
  const contactName = String((input && input.contactName) || '').trim();
  if (!contactName) return { ok: false, error: 'nome do lead vazio' };
  const col = agentFindColumn(t, input && input.columnName);
  if (!col) return { ok: false, error: 'nenhuma coluna de funil encontrada' };
  const card = t.db.createCrmCard({ columnId: col.id, funnelId: col.funnelId, contactName, phone: (input && input.phone) || '', notes: (input && input.notes) || '' });
  return { ok: true, id: card.id, column: col.name, contactName };
}

function agentFindLead(t, contactName) {
  const needle = String(contactName || '').toLowerCase();
  return (t.db.getCrmCards() || []).find(c => String(c.contactName || '').toLowerCase().includes(needle)) || null;
}

function agentMoveLead(t, input) {
  const card = agentFindLead(t, input && input.contactName);
  if (!card) return { ok: false, error: `lead "${input && input.contactName}" não encontrado` };
  const col = agentFindColumn(t, input && input.columnName);
  if (!col) return { ok: false, error: `coluna "${input && input.columnName}" não encontrada` };
  t.db.updateCrmCard(card.id, { columnId: col.id });
  return { ok: true, lead: card.contactName, movedTo: col.name };
}

function agentListLeads(t, input) {
  let cards = t.db.getCrmCards() || [];
  if (input && input.columnName) {
    const col = agentFindColumn(t, input.columnName);
    if (!col) return { ok: false, error: `coluna "${input.columnName}" não encontrada` };
    cards = cards.filter(c => c.columnId === col.id);
  }
  const cols = t.db.getCrmColumns();
  const colName = id => (cols.find(c => c.id === id) || {}).name || id;
  return { ok: true, count: cards.length, leads: cards.slice(0, 30).map(c => ({ contactName: c.contactName, phone: c.phone, column: colName(c.columnId) })) };
}

function agentDeleteLead(t, input) {
  const card = agentFindLead(t, input && input.contactName);
  if (!card) return { ok: false, error: `lead "${input && input.contactName}" não encontrado` };
  t.db.deleteCrmCard(card.id);
  return { ok: true, deleted: card.contactName };
}

// Busca um grupo pelo nome entre TODOS os grupos que o número já conhece (tem mensagem
// trocada), sem depender de estar vinculado a um cliente — resolve o caso de mandar msg
// pra um grupo qualquer que a pessoa cite pelo nome.
function agentFindGroup(t, groupName) {
  const needle = String(groupName || '').trim();
  if (!needle) return null;
  const convs = t.db.getConversations() || [];
  return convs.find(c => String(c.contactId || '').endsWith('@g.us') && agentNameMatches(c.contactName, needle)) || null;
}
function agentListWhatsappGroups(t) {
  const convs = t.db.getConversations() || [];
  const groups = convs.filter(c => String(c.contactId || '').endsWith('@g.us'));
  return { ok: true, count: groups.length, groups: groups.slice(0, 50).map(g => ({ name: g.contactName })) };
}

// O tenant pode ter o slot 1 (lite) desconectado/travado em "connecting" e só o slot 2
// (lite2) realmente aberto (ou vice-versa) — mandar sempre fixo no slot 1 falhava
// silenciosamente nesse caso. Checa o estado de verdade na Evolution antes de enviar.
// Sem isso, uma falha de envio só dizia "falhou", sem o motivo real — o Agente ficava
// inventando um motivo plausível (ex: "conexão instável") em vez de reportar o erro de
// verdade que a Evolution devolveu.
function agentEvoErrText(r) {
  try { return typeof r.json === 'string' ? r.json.slice(0, 300) : JSON.stringify(r.json).slice(0, 300); } catch (e) { return 'erro desconhecido'; }
}
async function agentPickConnectedLiteSlot(t) {
  for (const slot of ['1', '2']) {
    try {
      const r = await evoReq('GET', `/instance/connectionState/${liteInstanceName(t, slot)}`, null, 8000);
      const state = r && r.json && r.json.instance && r.json.instance.state;
      if (state === 'open') return slot;
    } catch (e) {}
  }
  return '1';
}

function agentResolveMessageTarget(t, input) {
  const clientName = String((input && input.clientName) || '').trim();
  if (clientName) {
    const a = getClientAreaObj(t);
    const client = agentFindClient(a, clientName);
    if (!client) return { error: `cliente "${clientName}" não encontrado — tente list_clients` };
    const target = agentResolveClientTarget(client, input && input.targetType);
    if (!target) return { error: `cliente "${client.name}" não tem contato nem grupo de WhatsApp monitorado — tente groupName direto com list_whatsapp_groups, ou vincula um contato/grupo primeiro (add_monitored_group)` };
    return { recipientId: target.id, recipientName: target.name };
  }
  const groupName = String((input && input.groupName) || '').trim();
  if (groupName) {
    const group = agentFindGroup(t, groupName);
    if (!group) return { error: `grupo "${groupName}" não encontrado — tente list_whatsapp_groups pra ver os nomes reais` };
    return { recipientId: group.contactId, recipientName: group.contactName };
  }
  const digits = String((input && input.phoneNumber) || '').replace(/\D/g, '');
  if (digits) return { recipientId: `${digits}@s.whatsapp.net`, recipientName: digits };
  return { error: 'informe clientName, groupName ou phoneNumber' };
}

async function agentSendMessageNow(t, input) {
  const message = String((input && input.message) || '').trim();
  if (!message) return { ok: false, error: 'mensagem vazia' };
  const target = await agentResolveMessageTarget(t, input);
  if (target.error) return { ok: false, error: target.error };
  const slot = await agentPickConnectedLiteSlot(t);
  const r = await evoReq('POST', `/message/sendText/${liteInstanceName(t, slot)}`, { number: target.recipientId, text: message });
  if (!r.ok) return { ok: false, error: `Falha ao enviar no WhatsApp (slot ${slot}, HTTP ${r.status}): ${agentEvoErrText(r)}` };
  return { ok: true, sentTo: target.recipientName };
}

function agentFindTask(t, title, clientName) {
  const a = getClientAreaObj(t);
  const needle = String(title || '').toLowerCase();
  if (clientName) {
    const client = agentFindClient(a, clientName);
    if (!client) return { error: `cliente "${clientName}" não encontrado` };
    const task = (client.tasks || []).find(x => String(x.title || '').toLowerCase().includes(needle));
    return { client, task, list: client.tasks, save: () => saveClientAreaClients(t, a.clients) };
  }
  const task = a.avulsas.find(x => String(x.title || '').toLowerCase().includes(needle));
  return { client: null, task, list: a.avulsas, save: () => saveClientAreaAvulsas(t, a.avulsas) };
}

function agentEditTask(t, input) {
  const found = agentFindTask(t, input && input.title, input && input.clientName);
  if (found.error) return { ok: false, error: found.error };
  if (!found.task) return { ok: false, error: `tarefa "${input && input.title}" não encontrada` };
  if (input.status) found.task.status = input.status;
  if (input.responsavel) found.task.responsavel = input.responsavel;
  if (input.due) found.task.due = agentResolveDue(input.due);
  found.save();
  return { ok: true, task: found.task.title };
}

function agentDeleteTask(t, input) {
  const found = agentFindTask(t, input && input.title, input && input.clientName);
  if (found.error) return { ok: false, error: found.error };
  if (!found.task) return { ok: false, error: `tarefa "${input && input.title}" não encontrada` };
  const idx = found.list.indexOf(found.task);
  found.list.splice(idx, 1);
  found.save();
  return { ok: true, deleted: found.task.title };
}

async function agentRunTool(t, name, input) {
  try {
    if (name === 'create_task') return agentCreateTask(t, input || {});
    if (name === 'list_tasks') return agentListTasks(t, input || {});
    if (name === 'edit_task') return agentEditTask(t, input || {});
    if (name === 'delete_task') return agentDeleteTask(t, input || {});
    if (name === 'send_reportei_report') return await agentSendReporteiReport(t, input || {});
    if (name === 'schedule_message') return await agentScheduleMessage(t, input || {});
    if (name === 'create_ad_campaign') return await agentCreateAdCampaign(t, input || {});
    if (name === 'list_ad_campaigns') return await agentListAdCampaigns(t, input || {});
    if (name === 'get_ad_insights') return await agentGetAdInsights(t, input || {});
    if (name === 'list_clients') return agentListClients(t);
    if (name === 'save_memory') return agentSaveMemory(t, input || {});
    if (name === 'forget_memory') return agentForgetMemory(t, input || {});
    if (name === 'teach_ai_attendant') return agentTeachAiAttendant(t, input || {});
    if (name === 'forget_ai_attendant_fact') return agentForgetAiAttendant(t, input || {});
    if (name === 'edit_client') return agentEditClient(t, input || {});
    if (name === 'delete_client') return agentDeleteClient(t, input || {});
    if (name === 'add_client_note') return agentAddClientNote(t, input || {});
    if (name === 'manage_client_password') return agentManageClientPassword(t, input || {});
    if (name === 'link_client_account') return agentLinkClientAccount(t, input || {});
    if (name === 'add_monitored_group') return agentAddMonitoredGroup(t, input || {});
    if (name === 'add_monitored_contact') return agentAddMonitoredContact(t, input || {});
    if (name === 'list_whatsapp_contacts') return agentListWhatsappContacts(t);
    if (name === 'create_lead') return agentCreateLead(t, input || {});
    if (name === 'move_lead') return agentMoveLead(t, input || {});
    if (name === 'list_leads') return agentListLeads(t, input || {});
    if (name === 'delete_lead') return agentDeleteLead(t, input || {});
    if (name === 'send_message_now') return await agentSendMessageNow(t, input || {});
    if (name === 'list_whatsapp_groups') return agentListWhatsappGroups(t);
    return { ok: false, error: 'ferramenta desconhecida: ' + name };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Memória do Agente: dois níveis. "Histórico" é a conversa recente (rolagem curta, some
// com o tempo — dá continuidade tipo "lembra que eu falei ontem"). "Memória permanente" é
// uma lista de fatos que o próprio Agente decide guardar via ferramenta e NUNCA sai sozinha
// do contexto (até alguém pedir pra esquecer) — fica sempre injetada no prompt, tipo o
// sistema de memória do próprio Claude Code entre conversas.
const AGENT_HISTORY_MAX_MSGS = 30; // ~15 trocas
const AGENT_MEMORY_MAX_ENTRIES = 80;
function agentSaveMemory(t, input) {
  const fact = String((input && input.fact) || '').trim().slice(0, 300);
  if (!fact) return { ok: false, error: 'fato vazio' };
  const cfg = t.db.getConfig();
  const mem = (Array.isArray(cfg.agentMemory) ? cfg.agentMemory : []).concat([{ text: fact, at: Date.now() }]);
  t.db.updateConfig({ agentMemory: mem.slice(-AGENT_MEMORY_MAX_ENTRIES) });
  return { ok: true, saved: fact };
}
function agentForgetMemory(t, input) {
  const needle = String((input && input.searchText) || '').trim().toLowerCase();
  if (!needle) return { ok: false, error: 'informe o que esquecer' };
  const cfg = t.db.getConfig();
  const mem = Array.isArray(cfg.agentMemory) ? cfg.agentMemory : [];
  const kept = mem.filter(m => !String(m.text || '').toLowerCase().includes(needle));
  t.db.updateConfig({ agentMemory: kept });
  return { ok: true, removed: mem.length - kept.length };
}

// Ensina o ATENDENTE de IA (o que fala com lead/cliente) — memória separada da do Agente,
// injetada em toda conversa de todo lead (ver saveBusinessMemory perto de handleAiChatbotReply).
function agentTeachAiAttendant(t, input) {
  const fact = String((input && input.fact) || '').trim();
  if (!fact) return { ok: false, error: 'fato vazio' };
  saveBusinessMemory(t, fact);
  return { ok: true, taught: fact };
}
function agentForgetAiAttendant(t, input) {
  const needle = String((input && input.searchText) || '').trim().toLowerCase();
  if (!needle) return { ok: false, error: 'informe o que esquecer' };
  const cfg = t.db.getConfig();
  const mem = Array.isArray(cfg.businessMemory) ? cfg.businessMemory : [];
  const kept = mem.filter(m => !String(m.text || '').toLowerCase().includes(needle));
  t.db.updateConfig({ businessMemory: kept });
  return { ok: true, removed: mem.length - kept.length };
}

async function handleAgentCommand(t, digits, text) {
  const cfg = t.db.getConfig();
  const apiKey = cfg.anthropicApiKey;
  if (!apiKey || !text) return;
  const memory = Array.isArray(cfg.agentMemory) ? cfg.agentMemory : [];
  const memoryBlock = memory.length ? `\n\nCoisas que você já sabe, guardadas em conversas anteriores (memória permanente — leve em conta sempre que fizer sentido, sem precisar que a pessoa repita):\n${memory.map(m => '- ' + m.text).join('\n')}` : '';
  const systemPrompt = `Você é "Agente", o assistente que o dono do negócio usa pelo WhatsApp pra executar ações dentro do CRM da empresa — pense em si mesmo como um funcionário de confiança, não só um executor de comandos frios. Hoje é ${brTodayLabel(Date.now())}. Quando o pedido corresponder a uma das ferramentas disponíveis, use a ferramenta e depois confirme em UMA frase curta, natural e em português o que foi feito (ex: "Beleza, criei a tarefa X pra você" ou "Criei a tarefa X pro cliente Y, com vencimento em Z"). Isso inclui ações que apagam algo (cliente, lead, tarefa) ou mexem com dinheiro/senha — o dono já autorizou previamente todas as ferramentas disponíveis, então execute direto, sem pedir confirmação antes. Se o pedido não corresponder a nenhuma ferramenta que você tem disponível ainda, diga rapidamente que ainda não sabe fazer isso, sem inventar que executou algo. Se faltar alguma informação obrigatória pra ferramenta (ex: pra qual cliente, qual valor), aí sim pergunte antes de executar. Se uma ferramenta disser que um cliente/lead/tarefa/grupo/contato não foi encontrado pelo nome que a pessoa falou, NÃO desista nem pergunte de volta na hora — primeiro tente a ferramenta de listar correspondente (list_clients, list_leads, list_tasks, list_whatsapp_groups ou list_whatsapp_contacts) pra ver os nomes reais e ache sozinho o mais parecido com o que foi pedido (nomes ditos por voz/texto raramente batem 100% com o nome salvo, e nem todo grupo/contato de WhatsApp está vinculado a um cliente — pode mandar direto pelo nome usando groupName, sem precisar de cliente). Um cliente pode ter contato individual, grupo, os dois ou nenhum vinculado — se o pedido mencionar "o contato" ou "o grupo" explicitamente, use targetType pra indicar qual dos dois usar. Você NÃO tem acesso a navegar telas do CRM, só às ferramentas — então a forma de "ver" o que existe é sempre chamando a ferramenta de listagem certa, nunca perguntando pro usuário pra ele ir olhar em algum lugar. Só pergunte pro usuário se mesmo depois de olhar a lista real você não conseguir identificar com razoável confiança do que se trata. Use a ferramenta save_memory sempre que perceber algo que vale guardar pra sempre (uma preferência, uma decisão, um contexto do negócio que não muda) — não precisa esperar a pessoa pedir "lembra disso", guarde proativamente quando fizer sentido. Nunca use markdown com dois asteriscos — isso vai direto pro WhatsApp, que usa *um asterisco* pra negrito.${memoryBlock}`;
  const history = Array.isArray(cfg.agentHistory) ? cfg.agentHistory : [];
  let messages = history.map(h => ({ role: h.role, content: h.content })).concat([{ role: 'user', content: text }]);
  let finalText = '';
  for (let turn = 0; turn < 8; turn++) {
    let resp;
    try { resp = await callAnthropicApiRaw(apiKey, messages, systemPrompt, cfg.aiModel, AGENT_TOOLS); }
    catch (e) { finalText = 'Deu erro ao falar com a IA: ' + e.message; break; }
    const content = resp.content || [];
    const toolUses = content.filter(b => b.type === 'tool_use');
    const textBlock = content.find(b => b.type === 'text');
    if (!toolUses.length) { finalText = (textBlock && textBlock.text) || ''; break; }
    messages.push({ role: 'assistant', content });
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await agentRunTool(t, tu.name, tu.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
    if (resp.stop_reason !== 'tool_use') { finalText = (textBlock && textBlock.text) || ''; break; }
  }
  if (!finalText) finalText = 'Feito.';
  try { await evoReq('POST', `/message/sendText/${agentInstanceName(t)}`, { number: digits, text: finalText }); } catch (e) {}
  // Só persiste a mensagem original e a resposta final — nunca os blocos intermediários de
  // tool_use/tool_result, que referenciam ids que só fazem sentido dentro desse mesmo ciclo.
  const newHistory = history.concat([{ role: 'user', content: text, at: Date.now() }, { role: 'assistant', content: finalText, at: Date.now() }]);
  t.db.updateConfig({ agentHistory: newHistory.slice(-AGENT_HISTORY_MAX_MSGS) });
}

app.post('/api/agent/connect', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.status(404).json({ error: 'WhatsApp Lite nao habilitado (precisa do EVOLUTION_API_KEY).' });
  const inst = agentInstanceName(t);
  const exists = await evoReq('GET', `/instance/fetchInstances?instanceName=${inst}`);
  let has = Array.isArray(exists.json) && exists.json.length > 0;
  if (!has) {
    let c = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      c = await evoReq('POST', '/instance/create', { instanceName: inst, integration: 'WHATSAPP-BAILEYS', qrcode: true });
      if (c.ok) break;
      console.warn(`[${t.clientId}][agente] create tentativa ${tentativa}/3 falhou:`, String(JSON.stringify(c.json || {})).slice(0, 200));
      if (tentativa < 3) await new Promise(r => setTimeout(r, 3000));
    }
    if (!c || !c.ok) return res.status(500).json({ error: 'Falha ao criar instancia', detail: c && c.json });
    const w = await evoReq('POST', `/webhook/set/${inst}`, { webhook: { enabled: true, url: agentWebhookUrl(t.clientId), byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } });
    if (!w.ok) console.warn(`[${t.clientId}][agente] instancia criada mas SEM webhook:`, String(JSON.stringify(w.json || {})).slice(0, 300));
    const qr = c.json && c.json.qrcode ? (c.json.qrcode.base64 || null) : null;
    t._agentQr = qr || null;
    return res.json({ state: 'connecting', qr, webhookOk: !!w.ok });
  }
  const conn = await evoReq('GET', `/instance/connect/${inst}`);
  const qr = (conn.json && (conn.json.base64 || (conn.json.qrcode && conn.json.qrcode.base64))) || null;
  t._agentQr = qr || t._agentQr || null;
  res.json({ state: 'connecting', qr });
});

app.get('/api/agent/status', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.json({ enabled: false });
  const r = await evoReq('GET', `/instance/connectionState/${agentInstanceName(t)}`);
  const state = (r.json && r.json.instance && r.json.instance.state) || 'close';
  if (state === 'open') t._agentQr = null;
  res.json({ enabled: true, state, number: t._agentNumber || '', qr: t._agentQr || null, allowedNumbers: Array.from(getAgentAllowedDigits(t)) });
});

app.post('/api/agent/allowed-numbers', requireAuth, (req, res) => {
  const t = getTenant(req.clientId);
  const nums = Array.isArray(req.body && req.body.numbers) ? req.body.numbers.map(n => String(n).replace(/\D/g, '')).filter(Boolean) : [];
  t.db.updateConfig({ agentAllowedNumbers: nums });
  res.json({ ok: true, numbers: nums });
});

app.post('/api/agent/disconnect', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.status(404).json({ error: 'nao habilitado' });
  const inst = agentInstanceName(t);
  let out = await evoReq('DELETE', `/instance/logout/${inst}`);
  if (!out.ok) { await evoReq('GET', `/instance/connectionState/${inst}`, null, 8000); out = await evoReq('DELETE', `/instance/logout/${inst}`); }
  t._agentNumber = ''; t._agentQr = null;
  res.json({ ok: true, logout: out.ok });
});

app.post('/webhook/agente/:clientId', async (req, res) => {
  res.sendStatus(200);
  try {
    const t = getTenant(req.params.clientId);
    if (!liteEnabled(t)) return;
    const ev = String((req.body && req.body.event) || '').toLowerCase();
    const data = req.body && req.body.data;
    if (ev === 'connection.update') {
      const st = data && data.state;
      const incomingQr = (data && (data.base64 || (data.qrcode && data.qrcode.base64) || data.qr)) || '';
      if (incomingQr) t._agentQr = incomingQr;
      if (st === 'open') {
        t._agentQr = null;
        const w = (data && data.wuid) || (req.body && req.body.sender);
        if (w) t._agentNumber = String(w).split('@')[0].split(':')[0];
      }
      return;
    }
    if (ev !== 'messages.upsert') return;
    const msg = Array.isArray(data) ? data[0] : data;
    if (!msg || !msg.key || msg.key.fromMe) return; // fromMe = a própria linha do Agente mandando, não comando
    const jid = String(msg.key.remoteJid || '');
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return; // só aceita DM direta, não grupo
    const digits = normalizeBrazilianMobileDigits(jid.replace(/@.*/, '').replace(/\D/g, ''));
    if (!digits) return;
    if ((t.db.getConfig() || {}).agentReplyDisabled) return; // agente so ENVIA avisos, nao responde (nao se mete na conversa)
    const allowed = getAgentAllowedDigits(t);
    if (allowed.size && !allowed.has(digits)) return; // número não autorizado → ignora silenciosamente
    let m = msg.message || {};
    if (typeof liteUnwrap === 'function') m = liteUnwrap(m);
    const text = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
    if (!text.trim()) return; // v1 só entende texto, sem áudio/imagem
    await handleAgentCommand(t, digits, text.trim());
  } catch (e) { console.log('[agente-webhook] erro:', e.message); }
});

// ---- Watchdog da Lite (Evolution): reconecta sozinho se o socket travar ----
// A Evolution às vezes solta "stream errored out" e o socket fica meio-morto até
// alguém abrir o WhatsApp no celular. Este loop checa o estado real de cada
// instância e força a reconexão quando não está "open", pra não depender de você.
const LITE_WATCHDOG_MS = 90 * 1000;
async function liteWatchdogTick() {
  if (!EVOLUTION_API_KEY) return;
  for (const t of tenants.values()) {
    if (!liteEnabled(t)) continue;
    // Slots desativados manualmente (ex: número movido pra API Oficial) — não reconectar.
    let _disabledSlots = [];
    try { _disabledSlots = (t.db.getConfig() || {}).liteDisabledSlots || []; } catch {}
    for (const slot of ['1', '2']) {
      if (_disabledSlots.includes(slot)) continue; // não ressuscitar este slot
      try {
        const inst = liteInstanceName(t, slot);
        const _cid = slot === '2' ? 'lite2' : 'lite';
        const r = await evoReq('GET', `/instance/connectionState/${inst}`, null, 15000);
        const info = r && r.json && r.json.instance;
        if (!info || !info.state) continue; // instância não existe p/ esse slot → ignora
        const ck = slot === '2' ? '_lite2Connected' : '_liteConnected';
        const wasKey = `_liteWasOpen_${slot}`;
        if (info.state === 'open') {
          t[ck] = true;
          // transição desconectado → conectado: recupera as msgs do intervalo
          if (t[wasKey] === false) { liteBackfillGap(t, slot, _cid, inst).catch(() => {}); }
          t[wasKey] = true;
          continue;
        }
        // não está "open" (close/connecting travado) → cutuca a reconexão
        t[ck] = false; t[wasKey] = false;
        const last = t[`_liteWdLog_${slot}`] || 0;
        if (Date.now() - last > 5 * 60 * 1000) { console.warn(`[${t.clientId}][lite${slot === '2' ? '2' : ''}] estado=${info.state} → forçando reconexão (watchdog)`); t[`_liteWdLog_${slot}`] = Date.now(); }
        await evoReq('GET', `/instance/connect/${inst}`, null, 20000);
      } catch (e) { /* silencioso — tenta de novo no próximo ciclo */ }
    }
  }
}
setInterval(() => { liteWatchdogTick().catch(() => {}); }, LITE_WATCHDOG_MS);

app.post('/api/lite/send', requireAuth, async (req, res) => {
  const t = getTenant(req.clientId);
  if (!liteEnabled(t)) return res.status(404).json({ error: 'nao habilitado' });
  const to = String(req.body && req.body.to || '').replace(/\D/g, '');
  const text = String(req.body && req.body.text || '').trim();
  if (!to || !text) return res.status(400).json({ error: 'to e text obrigatorios' });
  const slot = String((req.body && req.body.slot) || '1');
  const r = await evoReq('POST', `/message/sendText/${liteInstanceName(t, slot)}`, { number: to, text });
  if (!r.ok) return res.status(500).json({ error: 'Falha no envio', detail: r.json });
  const digits = normalizeBrazilianMobileDigits(to);
  t.db.recordMessage({ direction: 'out', contactId: `${digits}@s.whatsapp.net`, contactName: digits, text, connectionId: slot==='2'?'lite2':'lite' });
  res.json({ ok: true });
});

async function liteResolveName(t, jid, digits, pushName, instOverride) {
  if (pushName && String(pushName).trim() && String(pushName).replace(/\D/g, '') !== digits) return String(pushName).trim();
  const inst = instOverride || liteInstanceName(t);
  try {
    const fc = await evoReq('POST', `/chat/findContacts/${inst}`, { where: { remoteJid: jid } });
    const arr = Array.isArray(fc.json) ? fc.json : (fc.json && fc.json.data) || [];
    for (const c of arr) {
      const nm = c.pushName || c.name || c.verifiedName;
      if (nm && String(nm).replace(/\D/g, '') !== digits) return String(nm).trim();
    }
  } catch (e) {}
  try {
    const fp = await evoReq('POST', `/chat/fetchProfile/${inst}`, { number: digits });
    const j = fp.json || {};
    const nm = j.name || j.verifiedName || j.pushName;
    if (nm && String(nm).trim() && String(nm).replace(/\D/g, '') !== digits) return String(nm).trim();
  } catch (e) {}
  return (pushName && String(pushName).trim()) || digits;
}

function liteMediaType(m){ if(!m) return null; if(m.imageMessage) return 'image'; if(m.videoMessage) return 'video'; if(m.audioMessage) return 'audio'; if(m.documentMessage) return 'document'; if(m.stickerMessage) return 'sticker'; return null; }
function liteUnwrap(m){
  let d = 0;
  while (m && d < 6) {
    if (m.ephemeralMessage && m.ephemeralMessage.message) { m = m.ephemeralMessage.message; d++; continue; }
    if (m.viewOnceMessage && m.viewOnceMessage.message) { m = m.viewOnceMessage.message; d++; continue; }
    if (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) { m = m.viewOnceMessageV2.message; d++; continue; }
    if (m.viewOnceMessageV2Extension && m.viewOnceMessageV2Extension.message) { m = m.viewOnceMessageV2Extension.message; d++; continue; }
    if (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message) { m = m.documentWithCaptionMessage.message; d++; continue; }
    if (m.editedMessage && m.editedMessage.message) { m = m.editedMessage.message; d++; continue; }
    break;
  }
  return m;
}
// Decodifica uma string base64 pro disco em pedaços, em vez de montar um Buffer do
// arquivo inteiro em memória de uma vez (isso dobrava o pico de RAM: string base64 +
// buffer decodificado, os dois inteiros ao mesmo tempo — perigoso com o
// max_memory_restart de 400MB por tenant e mídia podendo chegar a 200MB).
// Retorna o tamanho decodificado em bytes.
function writeBase64ToFileStreaming(b64, filePath) {
  return new Promise((resolve, reject) => {
    const CHUNK_B64_CHARS = 1_000_000; // ~1MB de texto base64 (~750KB decodificados) por vez
    const ws = fs.createWriteStream(filePath);
    let total = 0;
    let offset = 0;
    ws.on('error', reject);
    function next() {
      if (offset >= b64.length) { ws.end(); return; }
      const end = Math.min(offset + CHUNK_B64_CHARS, b64.length);
      const chunk = Buffer.from(b64.slice(offset, end), 'base64');
      offset = end;
      total += chunk.length;
      if (!ws.write(chunk)) ws.once('drain', next); else setImmediate(next);
    }
    ws.on('finish', () => resolve(total));
    next();
  });
}
// ── Caminho de mídia de BAIXA MEMÓRIA (em teste no virandoachave) ─────────────
// Em vez de puxar o base64 inteiro pra RAM (evoReq faz r.text()+JSON.parse, ~2x o
// tamanho do arquivo), baixa a resposta da Evolution em STREAM e decodifica o valor
// de "base64" direto pro arquivo, em blocos. Pico de memoria fica em KB, nao em
// centenas de MB. Fail-safe: qualquer erro devolve null (mensagem grava sem midia).
async function saveLiteMediaStreaming(t, msg, inst){
  const { Readable } = require('stream');
  try{
    const mt = liteMediaType(msg && msg.message); if(!mt) return null;
    let mime = (msg.message[mt+'Message'] && msg.message[mt+'Message'].mimetype) || (mt+'/octet-stream');
    let ext = (String(mime).split('/')[1]||'').split(';')[0].replace(/[^a-z0-9]/gi,'').slice(0,12) || 'bin';
    if(mt==='audio' && ext==='mpeg') ext='mp3';
    const fn = `media-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filePath = path.join(t.uploadsDir, fn);

    // Caso raro: base64 ja veio embutido no evento -> usa o writer streaming de string.
    let inline = (msg.message && msg.message.base64) || msg.base64 || (msg.message[mt+'Message'] && msg.message[mt+'Message'].base64) || null;
    if(inline){
      inline = String(inline).replace(/^data:[^,]+,/, '');
      const est = Math.floor(inline.length*3/4);
      if(isMediaTooLarge(est)){ console.warn(`[${t.clientId}] midia Evolution ignorada: excede 200 MB`); return null; }
      const w = await writeBase64ToFileStreaming(inline, filePath);
      if(!w || isMediaTooLarge(w)){ try{ fs.unlinkSync(filePath); }catch(e){} return null; }
      createVideoDerivatives(filePath, mime);
      return { url: `/uploads/${t.clientId}/${fn}`, type: mt, name: (msg.message.documentMessage && msg.message.documentMessage.fileName) || null };
    }

    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), 120000);
    let resp;
    try{
      resp = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${inst}`, {
        method:'POST',
        headers:{ apikey: EVOLUTION_API_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify({ message: msg, convertToMp4: false }),
        signal: ctrl.signal
      });
    }catch(e){ clearTimeout(to); console.log('[saveLiteMediaStreaming] fetch falhou', e.message); return null; }
    if(!resp || !resp.ok || !resp.body){ clearTimeout(to); console.log('[saveLiteMediaStreaming] resposta ruim status', resp && resp.status); return null; }

    const ws = fs.createWriteStream(filePath);
    let wsError = null;
    ws.on('error', (e)=>{ wsError = e; });
    const writeBuf = (buf)=> new Promise((res)=>{ if(ws.write(buf)) res(); else ws.once('drain', res); });
    const KEYRE = /"base64"\s*:\s*"/;
    let phase = 0, carry = '', total = 0, tooLarge = false, found = false;

    try{
      const nodeStream = Readable.fromWeb(resp.body);
      for await (const chunkBuf of nodeStream){
        if(wsError) throw wsError;
        let s = carry + chunkBuf.toString('latin1');
        carry = '';
        if(phase===0){
          const m = s.match(KEYRE);
          if(!m){ carry = s.slice(Math.max(0, s.length-40)); continue; }
          s = s.slice(m.index + m[0].length);
          phase = 1; found = true;
        }
        if(phase===1){
          const q = s.indexOf('"');
          const seg = (q===-1) ? s : s.slice(0,q);
          const merged = carry + seg;
          const usable = merged.length - (merged.length % 4);
          const decodeStr = merged.slice(0, usable);
          carry = merged.slice(usable);
          if(decodeStr){
            const buf = Buffer.from(decodeStr, 'base64');
            total += buf.length;
            if(isMediaTooLarge(total)){ tooLarge = true; break; }
            await writeBuf(buf);
          }
          if(q!==-1){
            if(carry){ const b = Buffer.from(carry,'base64'); if(b.length){ total+=b.length; if(!isMediaTooLarge(total)) await writeBuf(b); } carry=''; }
            break;
          }
        }
      }
    }catch(e){
      clearTimeout(to);
      try{ ws.destroy(); }catch(_){}
      try{ fs.unlinkSync(filePath); }catch(_){}
      console.log('[saveLiteMediaStreaming] erro no stream', e.message);
      return null;
    }
    clearTimeout(to);
    await new Promise((res)=>ws.end(res));

    if(wsError){ try{ fs.unlinkSync(filePath); }catch(_){} console.log('[saveLiteMediaStreaming] erro de escrita', wsError.message); return null; }
    if(tooLarge){ console.warn(`[${t.clientId}] midia Evolution ignorada: excede 200 MB`); try{ fs.unlinkSync(filePath); }catch(_){} return null; }
    if(!found || !total){ try{ fs.unlinkSync(filePath); }catch(_){} console.log('[saveLiteMediaStreaming]', mt, 'base64 nao encontrado (found='+found+' total='+total+')'); return null; }
    console.log('[saveLiteMediaStreaming]', mt, 'bytes', total, '(stream, baixa memoria)');
    createVideoDerivatives(filePath, mime);
    return { url: `/uploads/${t.clientId}/${fn}`, type: mt, name: (msg.message.documentMessage && msg.message.documentMessage.fileName) || null };
  }catch(e){ console.log('[saveLiteMediaStreaming] erro', e.message); return null; }
}

async function saveLiteMedia(t, msg, inst){
  // Replicado p/ TODOS os tenants apos teste OK no virandoachave (16/09/2026).
  return saveLiteMediaStreaming(t, msg, inst);
  try{
    const mt = liteMediaType(msg && msg.message); if(!mt) return null;
    let b64 = (msg.message && msg.message.base64) || msg.base64 || (msg.message[mt+'Message'] && msg.message[mt+'Message'].base64) || null;
    let mime = null;
    let _erroBusca = '';
    if (!b64) {
      // Caminho normal desde que o webhook parou de embutir base64: a mídia é
      // buscada aqui. Se falhar, o arquivo some sem deixar rastro — daí o log.
      const r = await evoReq('POST', `/chat/getBase64FromMediaMessage/${inst}`, { message: msg, convertToMp4: false });
      b64 = r.json && (r.json.base64 || (r.json.media && r.json.media.base64));
      mime = r.json && r.json.mimetype;
      if (!b64) _erroBusca = ` BUSCA FALHOU status=${r.status} ` + String(typeof r.json === 'string' ? r.json : JSON.stringify(r.json || {})).slice(0, 200);
    }
    console.log('[saveLiteMedia]', mt, 'b64?', !!b64, 'len', b64 ? b64.length : 0, _erroBusca);
    if(!b64) return null;
    mime = mime || (msg.message[mt+'Message'] && msg.message[mt+'Message'].mimetype) || (mt+'/octet-stream');
    let ext = (String(mime).split('/')[1]||'').split(';')[0].replace(/[^a-z0-9]/gi,'').slice(0,12) || 'bin';
    if(mt==='audio' && ext==='mpeg') ext='mp3';
    b64 = String(b64).replace(/^data:[^,]+,/, '');
    const estimatedSize = Math.floor(b64.length * 3 / 4);
    if (isMediaTooLarge(estimatedSize)) { console.warn(`[${t.clientId}] mídia Evolution ignorada: excede 200 MB`); return null; }
    const fn = `media-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filePath = path.join(t.uploadsDir, fn);
    const written = await writeBase64ToFileStreaming(b64, filePath);
    if (!written || isMediaTooLarge(written)) { try { fs.unlinkSync(filePath); } catch (e) {} return null; }
    createVideoDerivatives(filePath, mime);
    return { url: `/uploads/${t.clientId}/${fn}`, type: mt, name: (msg.message.documentMessage && msg.message.documentMessage.fileName) || null };
  }catch(e){ return null; }
}
// As URLs que a Evolution devolve sao do CDN do WhatsApp e expiram em ~10 dias
// (parametro oe= na querystring). Guardar o link direto faz a foto sumir depois.
// Entao baixamos o arquivo e servimos de /uploads, igual ao caminho do Baileys.
async function saveRemotePicLocally(t, jid, url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (!buffer.length) return null;
    const filename = `avatar-${String(jid).replace(/[^a-z0-9]/gi, '_')}.jpg`;
    fs.writeFileSync(path.join(t.uploadsDir, filename), buffer);
    const local = `/uploads/${t.clientId}/${filename}`;
    t.db.updateContactPic(jid, local);
    return local;
  } catch (e) { return null; }
}
// A Evolution devolve o id da mensagem em formatos diferentes conforme a versao.
function liteWamid(json) {
  if (!json) return null;
  const k = json.key || (json.data && json.data.key) || null;
  return (k && k.id) || json.id || (json.data && json.data.id) || null;
}
// Traduz o status da Evolution para o vocabulario do banco (sent < delivered < read < played).
function liteAckStatus(raw) {
  const v = String(raw || '').toUpperCase();
  if (v === 'READ') return 'read';
  if (v === 'PLAYED') return 'played';
  if (v === 'DELIVERY_ACK' || v === 'DELIVERED') return 'delivered';
  if (v === 'SERVER_ACK' || v === 'SENT' || v === 'PENDING') return 'sent';
  if (v === 'ERROR' || v === 'FAILED') return 'failed';
  return null;
}

async function liteFetchPic(t, jid, digits, inst){
  try{
    const r = await evoReq('POST', `/chat/fetchProfilePictureUrl/${inst}`, { number: digits });
    const url = r.json && r.json.profilePictureUrl;
    if (!url) return;
    if (!(await saveRemotePicLocally(t, jid, url))) t.db.updateContactPic(jid, url); // fallback: pelo menos o link
  }catch(e){}
}

// Repara fotos ja salvas como link do CDN: baixa e troca pelo arquivo local.
// Roda devagar pra nao martelar o CDN nem segurar o processo.
async function backfillRemotePics(t, limite) {
  let n = 0, ok = 0;
  try {
    const pend = (t.db.getKnownContactsWithPics() || []).filter(c => String(c.profile_pic_url || '').startsWith('http'));
    for (const c of pend) {
      if (n >= (limite || 40)) break;
      n++;
      if (await saveRemotePicLocally(t, c.id, c.profile_pic_url)) ok++;
      await new Promise(r => setTimeout(r, 250));
    }
  } catch (e) {}
  return { tentadas: n, salvas: ok };
}
let _picBackfillRodando = false;
async function runPicBackfill() {
  if (_picBackfillRodando) return;
  _picBackfillRodando = true;
  try {
    for (const t of tenants.values()) {
      const r = await backfillRemotePics(t, 40);
      if (r.salvas) console.log('[fotos]', t.clientId, '-', r.salvas, 'de', r.tentadas, 'baixadas');
    }
  } finally { _picBackfillRodando = false; }
}
setInterval(() => { void runPicBackfill(); }, 30 * 60 * 1000);
setTimeout(() => { void runPicBackfill(); }, 60000);

app.post('/api/chat/backfill-pics', requireAuth, async (req, res) => {
  try { res.json(await backfillRemotePics(getTenant(req.clientId), Math.min(500, Number(req.body && req.body.limite) || 200))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
async function liteGroupName(t, jid, inst){
  try{ if(!t._liteGroupNames) t._liteGroupNames={}; if(t._liteGroupNames[jid]) return t._liteGroupNames[jid];
    const r = await evoReq('GET', `/group/findGroupInfos/${inst}?groupJid=${encodeURIComponent(jid)}`);
    const nm = r.json && (r.json.subject || r.json.name); if(nm){ t._liteGroupNames[jid]=nm; return nm; }
  }catch(e){} return null;
}

app.post('/webhook/evolution/:clientId', async (req, res) => {
  res.sendStatus(200);
  try {
    const t = getTenant(req.params.clientId);
    if (!liteEnabled(t)) return;
    const _cid = String((req.query && req.query.conn) || '').toLowerCase() === 'lite2' ? 'lite2' : 'lite';
    const _slotNum = _cid === 'lite2' ? '2' : '1';
    // slot desativado (número movido pra API Oficial) → ignora tudo que a Evolution mandar
    try { if (((t.db.getConfig() || {}).liteDisabledSlots || []).includes(_slotNum)) return; } catch {}
    const _inst = liteInstanceName(t, _slotNum);
    const ev = String((req.body && req.body.event) || '').toLowerCase();
    const data = req.body && req.body.data;
    // Recibo de entrega/leitura das mensagens que nos enviamos.
    if (ev === 'messages.update' || ev === 'message.update') {
      const lista = Array.isArray(data) ? data : [data];
      for (const it of lista) {
        if (!it) continue;
        const wamid = liteWamid(it) || it.keyId || it.messageId || null;
        const status = liteAckStatus(it.status || (it.update && it.update.status));
        if (!wamid || !status) continue;
        try { t.db.updateMessageDeliveryByWamid(wamid, status, status === 'failed' ? 'Falha reportada pelo WhatsApp' : null); } catch (e) {}
      }
      return;
    }
    if (ev === 'connection.update') {
      const st = data && data.state;
      const _nk = _cid === 'lite2' ? '_lite2Number' : '_liteNumber';
      const _ck = _cid === 'lite2' ? '_lite2Connected' : '_liteConnected';
      const _qk = _cid === 'lite2' ? '_lite2Qr' : '_liteQr';
      const incomingQr = (data && (data.base64 || (data.qrcode && data.qrcode.base64) || data.qr)) || '';
      if (incomingQr) t[_qk] = incomingQr;
      const _slot = _cid === 'lite2' ? '2' : '1';
      const _wasKey = `_liteWasOpen_${_slot}`;
      if (st === 'open') {
        t[_ck] = true;
        t[_qk] = null;
        const w = (data && data.wuid) || (req.body && req.body.sender);
        if (w) t[_nk] = String(w).split('@')[0].split(':')[0];
        // reconectou após uma queda → recupera mensagens do intervalo
        if (t[_wasKey] === false) { liteBackfillGap(t, _slot, _cid, _inst).catch(() => {}); }
        t[_wasKey] = true;
      } else if (st === 'close') {
        t[_ck] = false;
        t[_qk] = null;
        t[_wasKey] = false;
      }
      return;
    }
    if (ev !== 'messages.upsert') return;
    const msg = Array.isArray(data) ? data[0] : data;
    await ingestLiteMessage(t, msg, _cid, _inst);
  } catch (e) { console.log('[lite-webhook] erro:', e.message); }
});

// Mensagem que saiu do proprio numero fora do painel (celular / WhatsApp Web do atendente).
// Grava pra ela aparecer no historico da conversa. Pula o que o sistema ja registrou:
// envio do bot ou do painel (marcados em botMarkSent) e wamid ja existente no banco.
async function liteIngestOwnMessage(t, msg, _cid, _inst) {
  try {
    const wamid = msg.key.id || null;
    if (botWasOurSend(t, wamid)) return false;
    if (wamid && t.db.messageExistsByWamid && t.db.messageExistsByWamid(wamid)) return false;
    const jid = String(msg.key.remoteJid || '');
    if (!jid || jid === 'status@broadcast') return false;
    if (msg.message) msg.message = liteUnwrap(msg.message);
    const m = msg.message || {};
    let text = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
    let mediaType = liteMediaType(m);
    if (m.imageMessage) { mediaType = 'image'; text = m.imageMessage.caption || ''; }
    else if (m.videoMessage) { mediaType = 'video'; text = m.videoMessage.caption || ''; }
    else if (m.documentMessage) { mediaType = 'document'; text = m.documentMessage.caption || ''; }
    else if (m.audioMessage) mediaType = 'audio';
    else if (m.stickerMessage) mediaType = 'sticker';
    if (!text && !mediaType) return false;
    const media = mediaType ? await saveLiteMedia(t, msg, _inst) : null;
    const corpo = media ? (text || '') : ((text && text.trim()) || (mediaType ? `[${mediaType}]` : ''));
    if (!corpo && !media) return false;
    const comum = {
      direction: 'out', text: corpo,
      mediaUrl: media ? media.url : null, mediaType: media ? media.type : null, mediaName: media ? media.name : null,
      connectionId: _cid, wamid, deliveryStatus: 'sent',
    };
    if (jid.endsWith('@g.us')) {
      const nome = (await liteGroupName(t, jid, _inst)) || jid;
      t.db.recordMessage({ ...comum, contactId: jid, contactName: nome });
      return true;
    }
    const digits = normalizeBrazilianMobileDigits(jid.replace(/@.*/, '').replace(/\D/g, ''));
    if (!digits) return false;
    const alvo = `${digits}@s.whatsapp.net`;
    const conv = t.db.getConversations().find(c => c.contactId === alvo);
    t.db.recordMessage({ ...comum, contactId: alvo, contactName: (conv && conv.contactName) || digits });
    return true;
  } catch (e) { return false; }
}

// Processa UMA mensagem da Lite (usado tanto pelo webhook quanto pelo backfill do watchdog).
// De-duplica por wamid (key.id). Retorna true se gravou algo novo.
async function ingestLiteMessage(t, msg, _cid, _inst, opts) {
  opts = opts || {};
  if (!msg || !msg.key) return false;
  if (msg.key.fromMe) {
    pauseBotFromEcho(t, msg.key);
    await liteIngestOwnMessage(t, msg, _cid, _inst);
    return false;
  }
  const wamid = msg.key.id || null;
  if (wamid && t.db.messageExistsByWamid && t.db.messageExistsByWamid(wamid)) return false; // já temos
  if (msg.message) msg.message = liteUnwrap(msg.message);
  const jid = String(msg.key.remoteJid || '');
  if (!jid || jid === 'status@broadcast') return false;
  // avança o marcador de última mensagem vista (base do backfill)
  const ts = Number(msg.messageTimestamp) || 0;
  if (ts) { if (!t._liteLastTs) t._liteLastTs = {}; t._liteLastTs[_cid] = Math.max(t._liteLastTs[_cid] || 0, ts); }
  if (jid.endsWith('@g.us')) {
    const _gname = (await liteGroupName(t, jid, _inst)) || jid;
    const _gm = msg.message || {};
    if (_gm.reactionMessage) {
      // Anexa na mensagem original em vez de virar balão novo — só cai pro balão avulso
      // se a original não estiver salva aqui.
      const _grEmoji = _gm.reactionMessage.text || '';
      const _grTargetId = _gm.reactionMessage.key && _gm.reactionMessage.key.id;
      if (t.db.setMessageReaction(_grTargetId, jid, _grEmoji)) return true;
    }
    const _gmt = liteMediaType(_gm);
    if (!_gmt && !opts.backfill) console.log('[lite-grp] tipo nao detectado, keys:', Object.keys(_gm || {}).join(','));
    let _gt = _gm.conversation || (_gm.extendedTextMessage && _gm.extendedTextMessage.text) || '';
    if (_gmt === 'image') _gt = _gm.imageMessage.caption || ''; else if (_gmt === 'video') _gt = _gm.videoMessage.caption || ''; else if (_gmt === 'document') _gt = _gm.documentMessage.caption || '';
    else if (_gm.reactionMessage) _gt = _gm.reactionMessage.text ? `${_gm.reactionMessage.text} reagiu a uma mensagem` : 'removeu a reação';
    const _gs = msg.pushName || (msg.key.participant ? normalizeBrazilianMobileDigits(String(msg.key.participant).replace(/@.*/, '').replace(/\D/g, '')) : '');
    const _gmedia = _gmt ? await saveLiteMedia(t, msg, _inst) : null;
    if (!_gt && !_gmt) { const _git = interactiveMessageText(_gm); if (_git) _gt = _git; }
    const _gbody = (_gt && _gt.trim()) || (_gmt ? `[${_gmt}]` : '[mensagem]');
    t.db.recordMessage({ direction: 'in', contactId: jid, contactName: _gname, text: _gs ? `${_gs}: ${_gbody}` : _gbody, mediaUrl: _gmedia ? _gmedia.url : null, mediaType: _gmedia ? _gmedia.type : null, mediaName: _gmedia ? _gmedia.name : null, connectionId: _cid, wamid });
    return true;
  }
  const digits = normalizeBrazilianMobileDigits(jid.replace(/@.*/, '').replace(/\D/g, ''));
  if (!digits) return false;
  const storageJid = `${digits}@s.whatsapp.net`;
  const senderName = await liteResolveName(t, jid, digits, msg.pushName, _inst);
  const m = msg.message || {};
  if (m.reactionMessage) {
    // Anexa na mensagem original em vez de virar balão novo — só cai pro balão avulso
    // se a original não estiver salva aqui.
    const _rEmoji = m.reactionMessage.text || '';
    const _rTargetId = m.reactionMessage.key && m.reactionMessage.key.id;
    if (t.db.setMessageReaction(_rTargetId, storageJid, _rEmoji)) return true;
  }
  let text = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
  let mediaType = liteMediaType(m);
  if (!mediaType && !opts.backfill && Object.keys(m).filter(k => k !== 'messageContextInfo').length) console.log('[lite-1a1] tipo nao detectado, keys:', Object.keys(m).join(','));
  if (m.imageMessage) { mediaType = 'image'; text = m.imageMessage.caption || ''; }
  else if (m.audioMessage) mediaType = 'audio';
  else if (m.videoMessage) { mediaType = 'video'; text = m.videoMessage.caption || ''; }
  else if (m.documentMessage) { mediaType = 'document'; text = m.documentMessage.caption || ''; }
  else if (m.stickerMessage) mediaType = 'sticker';
  // Reação a uma mensagem (❤️, 👍 etc.) não batia em nenhum tipo acima, então virava
  // "[mensagem]" sem sentido nenhum no Chat ao vivo. emoji vazio = removeu a reação.
  else if (m.reactionMessage) text = m.reactionMessage.text ? `${m.reactionMessage.text} reagiu a uma mensagem` : 'removeu a reação';
  if (!text && !mediaType) { const _it = interactiveMessageText(m); if (_it) text = _it; }
  const _media = mediaType ? await saveLiteMedia(t, msg, _inst) : null;
  const displayText = _media ? (text || '') : ((text && text.trim()) || (mediaType ? `[${mediaType}]` : '[mensagem]'));
  const cleanDisplayText = stripTrackingTags(displayText);
  t.db.recordMessage({ direction: 'in', contactId: storageJid, contactName: senderName, text: cleanDisplayText, mediaUrl: _media ? _media.url : null, mediaType: _media ? _media.type : null, mediaName: _media ? _media.name : null, connectionId: _cid, waId: digits, phone: digits, username: (senderName !== digits ? senderName : null), wamid });
  liteFetchPic(t, storageJid, digits, _inst).catch(() => {});
  aplicarRespostaCampanha(t, storageJid, text); // lead da campanha respondeu -> move/atribui
  try { maybeReviveCardOnInbound(t, storageJid); } catch (e) {}
  const exist = findCrmCardForChat(t, storageJid);
  if (!exist) {
    const inbox = getFirstCrmColumn(t);
    if (inbox && !crmIsNoFunnel(t, digits)) { const c = t.db.createCrmCard({ columnId: inbox.columnId, funnelId: inbox.funnelId, contactName: senderName, whatsapp: digits, whatsappId: storageJid }); if (c) { t.db.markCrmCardNewMessage(c.id); applyLeadSourceTag(t, c, displayText); captureSiteRef(t, c, displayText); captureGoogleAdsRef(t, c, displayText); } }
  } else { if (senderName && senderName !== digits && (!exist.contactName || String(exist.contactName).replace(/\D/g, '') === digits)) t.db.updateCrmCard(exist.id, { contactName: senderName }); t.db.markCrmCardNewMessage(exist.id); applyLeadSourceTag(t, exist, displayText); captureSiteRef(t, exist, displayText); captureGoogleAdsRef(t, exist, displayText); }
  { const _ear = extractAdReply(msg.message); if (_ear) { const _cardR = findCrmCardForChat(t, storageJid); if (_cardR) captureAdReferral(t, _cardR, _ear); } }
  // Auto Atendimento (bot por palavra-chave) — de-dup por wamid garante no máximo 1 disparo
  await maybeAutoRespond(t, { storageJid, digits, text, connectionId: _cid, firstMessage: !exist });

  if (text) {
    const _aiCardLite = findCrmCardForChat(t, storageJid);
    if (aiChatbotShouldTrigger(t, storageJid, _aiCardLite?.columnId)) {
      scheduleAiChatbotReply(t, storageJid, digits, _cid);
    }
  }
  return true;
}

// Recupera mensagens que chegaram no intervalo em que a instância ficou desconectada.
async function liteBackfillGap(t, slot, _cid, _inst) {
  try {
    if (!t._liteLastTs) t._liteLastTs = {};
    const since = t._liteLastTs[_cid] || Math.floor(Date.now() / 1000);
    const r = await evoReq('POST', `/chat/findMessages/${_inst}`, { limit: 60 }, 20000);
    const recs = (r && r.json && r.json.messages && Array.isArray(r.json.messages.records)) ? r.json.messages.records : [];
    const missing = recs
      .filter(mm => mm && mm.key && !mm.key.fromMe && Number(mm.messageTimestamp) > since && String(mm.key.remoteJid || '') !== 'status@broadcast')
      .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp))
      .slice(0, 40);
    let n = 0;
    for (const mm of missing) { try { if (await ingestLiteMessage(t, mm, _cid, _inst, { backfill: true })) n++; } catch {} }
    if (n) console.log(`[${t.clientId}][lite${slot === '2' ? '2' : ''}] backfill: ${n} mensagem(ns) recuperada(s) do intervalo offline`);
  } catch (e) { /* silencioso */ }
}
// ===================== fim WhatsApp Lite =====================

loadBaileys().then(() => { app.listen(PORT, HOST, () => {
  console.log(`\nDashboard em http://localhost:${PORT}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
  console.log('Clientes:', loadClients().filter(c => !c.ownerClientId).map(c => c.id).join(', '));

  // Auto-inicializa tenants principais que já tinham sessão Baileys salva.
  // A sessão dedicada de grupos precisa subir mesmo quando o provider principal é Cloud/Meta,
  // porque planilhas e disparos para grupos usam este socket separado.
  const mainClients = loadClients().filter(c => !c.ownerClientId);
  for (const clientDef of mainClients) {
    const t = getTenant(clientDef.id);
    const groupSessionDir = getGroupAuthDir(t);
    if (hasBaileysAuthSession(groupSessionDir)) {
      console.log(`[${clientDef.id}][grupos] Sessao encontrada — reconectando...`);
      initGroupBaileysClient(t).catch(err => console.error(`[${clientDef.id}][grupos] Erro ao iniciar:`, err.message));
    }

    const sessionDir = path.join(BAILEYS_AUTH_BASE, clientDef.id);
    if (hasBaileysAuthSession(sessionDir)) {
      console.log(`[${clientDef.id}] Sessão Baileys encontrada — reconectando...`);
      initBaileysClient(t).catch(err => console.error(`[${clientDef.id}] Erro ao iniciar:`, err.message));
    }
    for (const slotKey of Object.keys(EXTRA_BAILEYS_SLOTS)) {
      const suffix = EXTRA_BAILEYS_SLOTS[slotKey].authSuffix;
      const slotDir = path.join(BAILEYS_AUTH_BASE, clientDef.id + suffix);
      if (hasBaileysAuthSession(slotDir)) {
        console.log(`[${clientDef.id}][${slotKey}] Sessao encontrada — reconectando...`);
        initExtraBaileysClient(t, slotKey).catch(err => console.error(`[${clientDef.id}][${slotKey}] Erro ao iniciar:`, err.message));
      }
    }
    startDeafSessionMonitor(t);
  }
}); }).catch(err => { console.error('[FATAL] Falha ao carregar Baileys:', err); process.exit(1); });
