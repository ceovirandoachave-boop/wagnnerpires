/* ══════════════════════════════════════════
   WhatsApp Scheduler — Dashboard Frontend
   ══════════════════════════════════════════ */

function icon(name, size = 14) {
  return `<svg width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="display:inline-block;vertical-align:-2px;flex-shrink:0"><use href="#i-${name}"/></svg>`;
}

// ─── Auth ─────────────────────────────────────
let authToken = localStorage.getItem('wa-token') || null;
let isAdmin = false;
let currentUser = null;
let appPermissions = { features: [] };
const ALL_APP_FEATURES = ['crm','chat','schedule','pending','logs','reports','queue','workspace','financeiro','config','debug','broadcast','templates','prospects'];

async function apiFetch(url, opts = {}) {
  const { skipAuthCheck, ...fetchOpts } = opts;
  const headers = { ...(fetchOpts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await (window['fetch'])(url, { ...fetchOpts, headers });
  if (res.status === 401 && !skipAuthCheck) {
    showLoginScreen();
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  return res;
}

async function readApiPayload(res) {
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  if (!raw) return null;
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('A API respondeu JSON inválido.');
    }
  }
  if (contentType.includes('text/html') || raw.trim().startsWith('<')) {
    if (res.redirected) {
      throw new Error('A requisição foi redirecionada pelo servidor. Recarregue a página e tente novamente.');
    }
    throw new Error('O servidor respondeu uma página HTML em vez do JSON esperado.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function showLoginScreen() {
  authToken = null;
  isAdmin = false;
  localStorage.removeItem('wa-token');
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('screen-connect').classList.remove('active');
  document.getElementById('screen-dashboard').classList.remove('active');
}

function hideLoginScreen() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('screen-dashboard').classList.add('active');
}

function setupLogin() {
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('login-username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-password').focus();
  });
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
}

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const fbEl = document.getElementById('login-feedback');
  fbEl.style.display = 'none';
  if (!username || !password) {
    fbEl.textContent = 'Preencha usuário e senha';
    fbEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      skipAuthCheck: true
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Credenciais inválidas');
    authToken = data.token;
    isAdmin = !!data.admin;
    currentUser = data;
    appPermissions = data.permissions || { features: ALL_APP_FEATURES };
    _userDefaultConnectionId = data.chatConnectionId || data.defaultConnectionId || null;
    _userBroadcastConnectionId = data.broadcastConnectionId || null;
    _userPersonalWaba = data.personalWaba || null;
    if (_userDefaultConnectionId) _activeChatConnection = _userDefaultConnectionId;
    localStorage.setItem('wa-token', authToken);
    hideLoginScreen();
    initDashboard();
  } catch(e) {
    fbEl.textContent = e.message;
    fbEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

let groups = [];
let contacts = [];
let quickReplies = [];
let editQuickReplies = [];
let uploadedFile = null; // { path, name }
let isLoadingRecipients = false;
let recipientProgressTimer = null;
let runtimeStatus = { provider: 'web', connected: false, configMissing: [] };
let isSwitchingProvider = false;
let metaSignupData = {};
let metaSignupListenerReady = false;
let pendingSignupSlot = '1';
let connectScreenDismissed = false;
let lastQrValue = null;
let lastConnectView = '';
let lastFunnelSettingsRenderKey = '';
let funnelSettingsLoaded = false;
let funnelSettingsLoadingPromise = null;
let selectedChatContactId = null;
let chatPollingTimer = null;
let chatMessagesPollingTimer = null;
let chatConversationsLoading = false;
let chatMessagesLoadingFor = null;
let _currentChatMessages = [];
let _currentCrmDetailMessages = [];
let _chatMic = null;
let _crmMic = null;
const CHAT_CONVERSATIONS_POLL_MS = 3500;
const CHAT_MESSAGES_POLL_MS = 1500;
let chatSyncStartedAt = Number(localStorage.getItem('wa-chat-sync-started-at') || 0);
const _msgCache = new Map(); // contactId → messages[] (instant nav cache)
let broadcastSource = 'crm';
let broadcastTargets = [];
let broadcastFile = null;
let groupDispatchStatus = null;
let _bcSelectedLabels = new Set();

// ─── Debug log ───────────────────────────────
const debugEntries = [];
function dbgLog(type, label, data) {
  const entry = { time: new Date().toLocaleTimeString('pt-BR'), type, label, data };
  debugEntries.unshift(entry);
  if (debugEntries.length > 50) debugEntries.pop();
  renderDebug();
}
function renderDebug() {
  const el = document.getElementById('debug-log');
  if (!el) return;
  if (debugEntries.length === 0) { el.innerHTML = '<div style="color:#888">Nenhum evento ainda.</div>'; return; }
  el.innerHTML = debugEntries.map(e => {
    const colors = { error: '#ff6b6b', ok: '#69db7c', info: '#74c0fc', warn: '#ffd43b' };
    const bg = { error: '#2c1515', ok: '#152c1a', info: '#152133', warn: '#2c2515' };
    const color = colors[e.type] || '#ccc';
    const background = bg[e.type] || '#1a1a1a';
    const json = typeof e.data === 'object' ? JSON.stringify(e.data, null, 2) : String(e.data);
    return `<div style="background:${background};border:1px solid ${color}33;border-radius:6px;padding:8px 10px;">
      <div style="color:${color};font-weight:bold;margin-bottom:4px;">[${e.time}] ${e.label}</div>
      <pre style="color:#ddd;margin:0;white-space:pre-wrap;word-break:break-all;">${escapeHtml(json)}</pre>
    </div>`;
  }).join('');
}

// Intercepta fetch global para logar tudo (exceto /api/status)
const _origFetch = window.fetch;
window.fetch = async function(url, opts) {
  const method = opts?.method || 'GET';
  if (!String(url).includes('/api/status')) {
    const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : undefined;
    dbgLog('info', `→ ${method} ${url}`, body !== undefined ? { body } : '(sem body)');
  }
  let res;
  try {
    res = await _origFetch(url, opts);
  } catch(e) {
    dbgLog('error', `✗ FETCH FALHOU: ${method} ${url}`, e.message);
    throw e;
  }
  if (!String(url).includes('/api/status')) {
    const clone = res.clone();
    clone.text().then(text => {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      dbgLog(res.ok ? 'ok' : 'error', `← ${res.status} ${method} ${url}`, parsed);
    });
  }
  return res;
};

// ─── Init ────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTheme();
  setupLogin();
  const impersonateName = sessionStorage.getItem('impersonate-name');
  if (impersonateName) {
    const banner = document.getElementById('impersonate-banner');
    document.getElementById('impersonate-name').textContent = impersonateName;
    banner.style.display = 'flex';
  }
  if (authToken) {
    try {
      const res = await apiFetch('/api/auth/me');
      if (res.ok) {
        const me = await res.json();
        isAdmin = !!me.admin;
        currentUser = me;
        appPermissions = me.permissions || { features: ALL_APP_FEATURES };
        _userDefaultConnectionId = me.chatConnectionId || me.defaultConnectionId || null;
        _userBroadcastConnectionId = me.broadcastConnectionId || null;
        _userPersonalWaba = me.personalWaba || null;
        if (_userDefaultConnectionId) _activeChatConnection = _userDefaultConnectionId;
        hideLoginScreen();
        initDashboard();
        return;
      }
    } catch {}
  }
  authToken = null;
  localStorage.removeItem('wa-token');
});

function hasAppFeature(feature) {
  return isAdmin || (appPermissions.features || []).includes(feature);
}

function applyFeaturePermissions() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    if (btn.dataset.tab === 'email' || btn.dataset.tab === 'files') return;
    btn.style.display = hasAppFeature(btn.dataset.tab) ? '' : 'none';
  });
  if (typeof updateEmailNav === 'function') updateEmailNav();
  const active = document.querySelector('.nav-item.active');
  if (active && active.style.display === 'none') {
    active.classList.remove('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    const first = [...document.querySelectorAll('.nav-item[data-tab]')].find(btn => btn.style.display !== 'none');
    if (first) {
      first.classList.add('active');
      document.getElementById('tab-' + first.dataset.tab)?.classList.add('active');
    }
  }
  document.getElementById('schedule-broadcast-section')?.classList.toggle('hidden', !hasAppFeature('broadcast'));
  document.getElementById('config-templates-section')?.classList.toggle('hidden', !hasAppFeature('templates'));
  document.getElementById('btn-open-prospects-from-crm')?.classList.toggle('hidden', !hasAppFeature('prospects'));
  document.getElementById('btn-refresh-all')?.classList.toggle('hidden', !hasAppFeature('schedule') && !hasAppFeature('chat'));
  document.getElementById('btn-restart-server')?.classList.toggle('hidden', !isAdmin);
}

function initDashboard() {
  // Escopo das customizacoes de UI (ex.: ocultacoes para o screencast da Meta) por cliente.
  try {
    const cid = (currentUser && currentUser.clientId) ? String(currentUser.clientId) : '';
    document.body.classList.toggle('client-virandoachave', cid === 'virandoachave');
    // Classe generica por cliente, para escopar customizacoes de UI (ex.: layout do CRM)
    Array.from(document.body.classList).forEach(c => { if (c.startsWith('client-')) document.body.classList.remove(c); });
    document.body.classList.toggle('client-virandoachave', cid === 'virandoachave');
    if (cid) document.body.classList.add('client-' + cid.replace(/[^a-zA-Z0-9_-]/g, ''));
  } catch {}
  applyFeaturePermissions();
  setupProviderSelector();
  setupConnectActions();
  setupTabs();
  setupConfig();
  setupAdminClients();
  setupDebug();
  setupChat();
  setupCrm();
  setupProspects();
  setupCrmImportButton();
  setupSheetsConfig();
  setupQueue();
  setupRecipientSearch();
  setupRecipientLoader();
  setupQuickReplies();
  setupFileUpload();
  setupForm();
  setupBroadcast();
  setupTemplates();
  setupQuickDates();
  setupReports();
  refreshBroadcastLabels();
  setupEditModal();
  setupSidebarResize();
  setupWorkspace();
  if (document.getElementById('tab-crm')?.classList.contains('active')) loadCrm();
  setDatetimeMin('datetime-input');
  document.getElementById('btn-logout').addEventListener('click', () => {
    showLoginScreen();
  });
  startPolling();
}

// ─── Configurações ────────────────────────────
function setupConfig() {
  document.getElementById('btn-config-connect')?.addEventListener('click', async () => {
    await startMetaEmbeddedSignup('existing');
  });
  document.getElementById('btn-meta-new-number')?.addEventListener('click', async () => {
    await startMetaEmbeddedSignup('new');
  });
  document.getElementById('btn-config-reset')?.addEventListener('click', async () => {
    if (!confirm('Isso vai limpar a sessão do WhatsApp e gerar um novo QR. Continuar?')) return;
    try { await apiFetch('/api/web/reset-session', { method: 'POST' }); } catch {}
    openConnectScreen();
  });
}

function ensureMetaSignupListener() {
  if (metaSignupListenerReady) return;
  metaSignupListenerReady = true;
  window.addEventListener('message', (event) => {
    if (!/^https:\/\/([\w-]+\.)?facebook\.com$/.test(event.origin) && !/^https:\/\/([\w-]+\.)?facebook\.net$/.test(event.origin)) return;
    let payload = event.data;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return; }
    }
    if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
    const data = payload.data || {};
    if (payload.event === 'FINISH' || data.phone_number_id || data.waba_id) {
      metaSignupData = {
        phoneNumberId: data.phone_number_id || data.phoneNumberId || metaSignupData.phoneNumberId || '',
        wabaId: data.waba_id || data.wabaId || metaSignupData.wabaId || '',
        businessId: data.business_id || data.businessId || metaSignupData.businessId || ''
      };
    }
  });
}

const EMBEDDED_SIGNUP_PROXY = 'https://envio.gestorwagnnerpires.com.br/embedded-signup-proxy.html';

function openEmbeddedSignupPopup(cfg, mode, slot) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      appId: cfg.appId,
      configId: cfg.configId,
      graphVersion: cfg.graphVersion || 'v22.0',
      mode: mode || 'existing',
      slot: String(slot || '1')
    });
    const url = `${EMBEDDED_SIGNUP_PROXY}?${params}`;
    const w = 620, h = 720;
    const left = Math.round(screen.width / 2 - w / 2);
    const top = Math.round(screen.height / 2 - h / 2);
    const popup = window.open(url, 'meta-signup', `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`);
    if (!popup) {
      reject(new Error('Popup bloqueado pelo navegador. Permita popups para este site e tente novamente.'));
      return;
    }
    let done = false;
    function onMessage(e) {
      if (e.data?.type !== 'embedded-signup-result') return;
      done = true;
      clearInterval(poll);
      window.removeEventListener('message', onMessage);
      if (e.data.error) {
        reject(new Error(e.data.error === 'cancelled'
          ? 'A Meta não retornou autorização. Tente novamente e conclua o popup.'
          : 'Erro ao carregar SDK da Meta. Verifique sua conexão.'));
      } else {
        resolve(e.data);
      }
    }
    window.addEventListener('message', onMessage);
    const poll = setInterval(() => {
      if (popup.closed && !done) {
        clearInterval(poll);
        window.removeEventListener('message', onMessage);
        reject(new Error('A janela da Meta foi fechada antes de concluir. Tente novamente.'));
      }
    }, 600);
  });
}

function updateMetaWizard(step, message) {
  ['cloud1-step-1', 'cloud1-step-2', 'cloud1-step-3'].forEach((id, index) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-active', index + 1 === step);
    el.classList.toggle('is-done', index + 1 < step);
  });
  const info = document.getElementById('cloud1-current-number');
  if (info && message) info.textContent = message;
}

async function finishMetaEmbeddedSignup(code) {
  updateMetaWizard(3, 'Finalizando configuração com a Meta...');
  await new Promise(resolve => setTimeout(resolve, 600));
  const res = await apiFetch('/api/cloud/embedded-signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, ...metaSignupData })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao conectar pela Meta');
  await checkStatus();
  loadConfig();
  updateMetaWizard(4, data.displayPhoneNumber ? `Número conectado: ${data.displayPhoneNumber}` : `Conectado. Phone Number ID: ${data.phoneNumberId || 'salvo'}`);
  return data;
}

async function startMetaEmbeddedSignup(mode = 'existing') {
  const feedback = document.getElementById('provider-switch-feedback') || document.getElementById('connect-feedback');
  updateMetaWizard(1, mode === 'new' ? 'No popup da Meta, escolha criar/conectar um novo número.' : 'No popup da Meta, selecione o WhatsApp Business que quer usar.');
  if (feedback) { feedback.style.display = 'block'; feedback.textContent = 'Abrindo conexão oficial da Meta...'; }
  try {
    const cfgRes = await apiFetch('/api/cloud/embedded-config');
    const cfg = await cfgRes.json();
    if (!cfgRes.ok) throw new Error(cfg.error || 'Erro ao carregar configuração da Meta');
    if (cfg.missing?.length) throw new Error(`Configure no servidor: ${cfg.missing.join(', ')}`);
    updateMetaWizard(2, 'Continue com o Facebook e compartilhe os ativos do WhatsApp.');
    const result = await openEmbeddedSignupPopup(cfg, mode, '1');
    metaSignupData = { phoneNumberId: result.phoneNumberId || '', wabaId: result.wabaId || '', businessId: result.businessId || '' };
    await finishMetaEmbeddedSignup(result.code);
    if (feedback) feedback.textContent = 'WhatsApp oficial conectado com sucesso.';
    setTimeout(showDashboard, 600);
  } catch (e) {
    if (feedback) feedback.textContent = e.message;
    else alert(e.message);
  }
}

// ─── Multi-connections ────────────────────────────────────────

let groupsPollingTimer = null;

function renderActiveConnectionCard(webConnection = null) {
  const cw = webConnection || runtimeStatus.connections?.web || {};
  const lite1 = window._liteConnInfo || null;
  const liteIsPrimary = !!(lite1 && lite1.connected);
  const dot = document.getElementById('conn-active-dot');
  const title = document.getElementById('conn-active-title');
  const badge = document.getElementById('conn-active-badge');
  const info = document.getElementById('conn-active-info');
  const btnConnect = document.getElementById('btn-web1-connect');
  const btnPair = document.getElementById('btn-web1-pair');
  const btnReset = document.getElementById('btn-web1-reset');
  const qrWrap = document.getElementById('conn-web1-qr');
  const qrImg = document.getElementById('conn-web1-qr-img');
  const pairDisplay = document.getElementById('conn-web1-pair-display');
  const pairValue = document.getElementById('conn-web1-pair-value');
  if (!dot || !title || !badge || !info) return;

  const stateLabels = { idle: 'Não conectado', starting: 'Iniciando...', awaiting_qr: 'Leia o QR Code', awaiting_pair_code: 'Digite o código', restoring_session: 'Reconectando...', ready: 'Conectado' };
  dot.className = 'status-dot' + ((cw.connected || liteIsPrimary) ? '' : ' is-warning');
  title.textContent = liteIsPrimary ? 'WhatsApp Lite 1' : 'QR Code 1';
  badge.textContent = 'Principal';
  info.textContent = liteIsPrimary
    ? `Conectado no número ${lite1.phone || ''}`.trim()
    : (cw.connected
      ? (cw.phone ? `Conectado no número ${cw.phone}` : 'Conectado pela sessão principal do WhatsApp Web.')
      : (stateLabels[cw.bootState] || cw.bootState || runtimeStatus.bootMessage || 'QR Code 1 não conectado'));
  if (qrWrap && qrImg) {
    if (!liteIsPrimary && cw.qr && !cw.connected) { qrWrap.style.display = ''; qrImg.src = cw.qr; }
    else { qrWrap.style.display = 'none'; }
  }
  if (pairDisplay && pairValue) {
    if (!liteIsPrimary && cw.pairingCode && !cw.connected) {
      pairDisplay.style.display = '';
      const pc = cw.pairingCode;
      pairValue.textContent = pc.length === 8 ? pc.slice(0, 4) + '-' + pc.slice(4) : pc;
    } else {
      pairDisplay.style.display = 'none';
    }
  }
  if (liteIsPrimary) {
    if (btnConnect) btnConnect.style.display = 'none';
    if (btnPair) btnPair.style.display = 'none';
    if (btnReset) {
      btnReset.style.display = '';
      btnReset.innerHTML = 'Desconectar';
      btnReset.onclick = () => window.liteDisconnect && window.liteDisconnect(1);
    }
  } else {
    if (btnConnect) btnConnect.style.display = (!cw.connected && cw.bootState === 'idle') ? '' : 'none';
    if (btnPair) btnPair.style.display = (!cw.connected && cw.bootState === 'idle') ? '' : 'none';
    if (btnReset) {
      btnReset.style.display = '';
      btnReset.innerHTML = '<svg class="icon"><use href="#i-rotate-cw"/></svg> Gerar novo QR';
      btnReset.onclick = () => window.resetWeb1 && window.resetWeb1();
    }
  }
}

function renderConnectionCards(connections) {
  // Build phone lookup map for badge rendering
  if (connections) {
    if (connections.web?.phone) _connectionPhones['web'] = connections.web.phone;
    ['cloud1','cloud2','cloud3'].forEach(k => {
      const c = connections[k]; if (c?.displayPhone) _connectionPhones[k] = c.displayPhone;
    });
    ['groups','web2','web3'].forEach(k => {
      const c = connections[k]; if (c?.phone) _connectionPhones[k] = c.phone;
    });
  }

  // Esconder cards de conexões que o usuário não tem acesso
  const allowedConns = _userDefaultConnectionId || _userBroadcastConnectionId
    ? new Set([_userDefaultConnectionId, _userBroadcastConnectionId].filter(Boolean))
    : null; // null = admin, vê tudo

  const subUserWebSlot = allowedConns && (allowedConns.has('web2') || allowedConns.has('web3'))
    && !allowedConns.has('web') && !allowedConns.has('cloud1') && !allowedConns.has('cloud2') && !allowedConns.has('cloud3');

  // Para sub-usuário com slot web2/web3: esconde seção principal (toggle Mac/Cloud + QR1)
  // e promove a seção de apoio como principal
  const cardModoOp = document.getElementById('card-modo-operacao');
  if (cardModoOp) cardModoOp.style.display = subUserWebSlot ? 'none' : '';
  const secPrincipal = document.getElementById('conn-section-principal');
  const secApoio = document.getElementById('conn-section-apoio');
  if (subUserWebSlot) {
    if (secPrincipal) secPrincipal.style.display = 'none';
    // Promove a seção de apoio para o lugar de "principal" visualmente e expande
    if (secApoio) {
      secApoio.style.marginTop = '0';
      if ('open' in secApoio) secApoio.open = true;
      const sum = secApoio.querySelector('summary');
      if (sum) sum.innerHTML = 'Your WhatsApp <span class="conn-collapse-sub">/ Conexão Principal</span>';
    }
  } else {
    if (secPrincipal) secPrincipal.style.display = '';
    if (secApoio) {
      secApoio.style.marginTop = '8px';
      const sum = secApoio.querySelector('summary');
      if (sum) sum.innerHTML = 'Support connections <span class="conn-collapse-sub">/ WhatsApp de Apoio</span>';
    }
  }

  const connCardMap = { web: 'conn-active', web2: 'conn-web2', web3: 'conn-web3', groups: 'conn-groups', cloud1: 'conn-cloud1', cloud2: 'conn-cloud2', cloud3: 'conn-cloud3' };
  if (allowedConns) {
    Object.entries(connCardMap).forEach(([connId, cardId]) => {
      const el = document.getElementById(cardId);
      if (el) el.style.display = allowedConns.has(connId) ? '' : 'none';
    });
  } else {
    Object.values(connCardMap).forEach(cardId => {
      const el = document.getElementById(cardId);
      if (el) el.style.display = '';
    });
  }

  // Auto-detecta modo (Mac vs Oficial) baseado nas conexões ativas (só admin)
  if (connections && !subUserWebSlot) {
    const anyCloudConnected = connections.cloud1?.connected || connections.cloud2?.connected || connections.cloud3?.connected;
    const anyWebConnected = connections.web?.connected;
    const currentMode = document.getElementById('conn-cloud-cards')?.style.display === 'none' ? 'web' : 'cloud';
    if (anyCloudConnected && !anyWebConnected && currentMode === 'web') setConnMode('cloud');
    else if (!anyCloudConnected && anyWebConnected && currentMode === 'cloud') setConnMode('web');
  }

  // Show personal WABA section for sub-users
  const personalWabaDiv = document.getElementById('conn-personal-waba');
  if (personalWabaDiv) personalWabaDiv.style.display = subUserWebSlot ? '' : 'none';
  if (subUserWebSlot && _userPersonalWaba?.connected) renderPersonalWabaStatus();

  renderActiveConnectionCard(connections?.web);
  if (!connections) return;

  // Cloud 1
  const c1 = connections.cloud1 || {};
  const dot1 = document.getElementById('conn-cloud1-dot');
  const info1 = document.getElementById('conn-cloud1-info');
  const btnDis1 = document.getElementById('btn-cloud1-disconnect');
  const btnUpd1 = document.getElementById('btn-cloud1-update-token');
  if (dot1) dot1.className = 'status-dot' + (c1.connected ? '' : ' is-warning');
  if (info1) info1.textContent = c1.connected ? (c1.displayPhone || c1.phoneNumberId || 'Conectado') : 'Não configurado';
  const current1 = document.getElementById('cloud1-current-number');
  if (current1) current1.textContent = c1.connected ? `Número oficial: ${c1.displayPhone || c1.phoneNumberId}` : 'Nenhum número oficial conectado ainda';
  updateMetaWizard(c1.connected ? 4 : 1);
  if (btnDis1) btnDis1.style.display = c1.connected ? '' : 'none';
  if (btnUpd1) btnUpd1.style.display = c1.connected ? '' : 'none';
  if (c1.connected) checkTokenExpiry('cloud1', 1);
  // Painéis de permissão Meta
  const permInfo1 = document.getElementById('conn-cloud1-permission-info');
  const permGrants1 = document.getElementById('conn-cloud1-meta-grants');
  if (permInfo1) permInfo1.style.display = c1.connected ? 'none' : '';
  if (permGrants1) {
    permGrants1.style.display = c1.connected ? '' : 'none';
    if (c1.connected) {
      const wabaEl = document.getElementById('conn-cloud1-waba-id');
      const phoneEl = document.getElementById('conn-cloud1-phone-id-display');
      if (wabaEl) wabaEl.textContent = c1.wabaId || '—';
      if (phoneEl) phoneEl.textContent = c1.phoneNumberId || '—';
    }
  }

  // Cloud 2
  const c2 = connections.cloud2 || {};
  const dot2 = document.getElementById('conn-cloud2-dot');
  const info2 = document.getElementById('conn-cloud2-info');
  const btnDis2 = document.getElementById('btn-cloud2-disconnect');
  const btnCon2 = document.getElementById('btn-cloud2-connect');
  if (dot2) dot2.className = 'status-dot' + (c2.connected ? '' : ' is-warning');
  if (info2) info2.textContent = c2.connected ? (c2.displayPhone || c2.phoneNumberId || 'Conectado') : 'Não configurado';
  if (btnDis2) btnDis2.style.display = c2.connected ? '' : 'none';
  if (btnCon2) btnCon2.style.display = c2.connected ? 'none' : '';

  // Cloud 3 — Token Manual
  const c3 = connections.cloud3 || {};
  const dot3 = document.getElementById('conn-cloud3-dot');
  const info3 = document.getElementById('conn-cloud3-info');
  const form3 = document.getElementById('conn-cloud3-form');
  const btnSave3 = document.getElementById('btn-cloud3-save');
  const btnDis3 = document.getElementById('btn-cloud3-disconnect');
  const btnUpd3 = document.getElementById('btn-cloud3-update-token');
  if (dot3) dot3.className = 'status-dot' + (c3.connected ? '' : ' is-warning');
  if (info3) info3.textContent = c3.connected ? (c3.displayPhone || c3.phoneNumberId || 'Conectado') : 'Não configurado';
  if (form3) form3.style.display = c3.connected ? 'none' : '';
  if (btnSave3) btnSave3.style.display = c3.connected ? 'none' : '';
  if (btnDis3) btnDis3.style.display = c3.connected ? '' : 'none';
  if (btnUpd3) btnUpd3.style.display = c3.connected ? '' : 'none';
  if (c3.connected) {
    const pId = document.getElementById('conn-cloud3-phone-id');
    const tok = document.getElementById('conn-cloud3-token');
    if (pId) pId.value = '';
    if (tok) tok.value = '';
    checkTokenExpiry('cloud3', 3);
  }

  // Groups Baileys
  const cg = connections.groups || {};
  const dotG = document.getElementById('conn-groups-dot');
  const infoG = document.getElementById('conn-groups-info');
  const qrWrap = document.getElementById('conn-groups-qr');
  const qrImg = document.getElementById('conn-groups-qr-img');
  const pairDisplay = document.getElementById('conn-groups-pair-display');
  const pairVal = document.getElementById('conn-groups-pair-value');
  const btnReset = document.getElementById('btn-groups-reset');
  const btnDisc = document.getElementById('btn-groups-disconnect');
  const btnCon = document.getElementById('btn-groups-connect');
  const btnPair = document.getElementById('btn-groups-pair');

  if (dotG) dotG.className = 'status-dot' + (cg.connected ? '' : (cg.bootState !== 'idle' ? ' is-warning' : ' is-warning'));
  if (dotG && cg.connected) dotG.className = 'status-dot';

  const stateLabels = { idle: 'Não conectado', starting: 'Iniciando...', awaiting_qr: 'Leia o QR Code', awaiting_pair_code: 'Digite o código', restoring_session: 'Reconectando...', ready: 'Conectado' };
  if (infoG) infoG.textContent = cg.connected && cg.phone ? cg.phone : (stateLabels[cg.bootState] || cg.bootState || 'Não conectado');

  if (qrWrap && qrImg) {
    if (cg.qr && !cg.connected) { qrWrap.style.display = ''; qrImg.src = cg.qr; } else { qrWrap.style.display = 'none'; }
  }
  if (pairDisplay && pairVal) {
    if (cg.pairingCode && !cg.connected) {
      pairDisplay.style.display = '';
      const c = cg.pairingCode;
      pairVal.textContent = c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;
    } else { pairDisplay.style.display = 'none'; }
  }
  if (btnReset) btnReset.style.display = (cg.bootState !== 'idle' && !cg.connected) ? '' : 'none';
  if (btnDisc) btnDisc.style.display = cg.connected ? '' : 'none';
  if (btnCon) btnCon.style.display = (!cg.connected && cg.bootState === 'idle') ? '' : 'none';
  if (btnPair) btnPair.style.display = (!cg.connected && cg.bootState === 'idle') ? '' : 'none';

  // Extra Baileys slots (web2, web3)
  for (const slot of ['web2', 'web3']) {
    const cs = connections[slot] || {};
    const dot = document.getElementById(`conn-${slot}-dot`);
    const info = document.getElementById(`conn-${slot}-info`);
    const qrW = document.getElementById(`conn-${slot}-qr`);
    const qrI = document.getElementById(`conn-${slot}-qr-img`);
    const pairD = document.getElementById(`conn-${slot}-pair-display`);
    const pairV = document.getElementById(`conn-${slot}-pair-value`);
    const bReset = document.getElementById(`btn-${slot}-reset`);
    const bDisc = document.getElementById(`btn-${slot}-disconnect`);
    const bCon = document.getElementById(`btn-${slot}-connect`);
    const bPair = document.getElementById(`btn-${slot}-pair`);

    if (dot) dot.className = 'status-dot' + (cs.connected ? '' : ' is-warning');
    if (info) info.textContent = cs.connected && cs.phone ? cs.phone : (stateLabels[cs.bootState] || cs.bootState || 'Não conectado');
    if (qrW && qrI) { if (cs.qr && !cs.connected) { qrW.style.display = ''; qrI.src = cs.qr; } else { qrW.style.display = 'none'; } }
    if (pairD && pairV) {
      if (cs.pairingCode && !cs.connected) {
        pairD.style.display = '';
        const pc = cs.pairingCode;
        pairV.textContent = pc.length === 8 ? pc.slice(0, 4) + '-' + pc.slice(4) : pc;
      } else { pairD.style.display = 'none'; }
    }
    if (bReset) bReset.style.display = '';
    if (bDisc) bDisc.style.display = cs.connected ? '' : 'none';
    if (bCon) bCon.style.display = (!cs.connected && cs.bootState === 'idle') ? '' : 'none';
    if (bPair) bPair.style.display = (!cs.connected && cs.bootState === 'idle') ? '' : 'none';
  }
}

async function connectExtraSlot(slot) {
  await apiFetch(`/api/connections/${slot}/connect`, { method: 'POST' });
  startExtraSlotPolling(slot);
}

async function connectExtraSlotPair(slot) {
  const phone = prompt('Digite o número do WhatsApp (com DDI+DDD, sem espaços):\nEx: 5548999990000');
  if (!phone) return;
  await apiFetch(`/api/connections/${slot}/pairing-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone.replace(/\D/g, '') })
  });
  startExtraSlotPolling(slot);
}

async function resetExtraSlot(slot) {
  await apiFetch(`/api/connections/${slot}/reset`, { method: 'POST' });
  startExtraSlotPolling(slot);
}

async function disconnectExtraSlot(slot) {
  if (!confirm(`Desconectar WhatsApp ${slot}? A sessão será apagada.`)) return;
  await apiFetch(`/api/connections/${slot}`, { method: 'DELETE' });
  stopExtraSlotPolling(slot);
  await loadConnectionCards();
}

async function connectWeb1() {
  await apiFetch('/api/connect', { method: 'POST' });
  startWeb1Polling();
}

async function connectWeb1Pair() {
  const phone = prompt('Digite o número do WhatsApp (com DDI+DDD, sem espaços):\nEx: 5548999990000');
  if (!phone) return;
  await apiFetch('/api/pairing-code/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone.replace(/\D/g, '') })
  });
  startWeb1Polling();
}

async function resetWeb1() {
  if (!confirm('Gerar novo QR para o QR Code 1?')) return;
  await apiFetch('/api/web/reset-session', { method: 'POST' });
  startWeb1Polling();
}

let _web1Timer = null;
function stopWeb1Polling() {
  if (_web1Timer) { clearInterval(_web1Timer); _web1Timer = null; }
}

function startWeb1Polling() {
  stopWeb1Polling();
  loadConnectionCards();
  _web1Timer = setInterval(async () => {
    try {
      const res = await apiFetch('/api/connections');
      if (!res.ok) return;
      const data = await res.json();
      renderConnectionCards(data);
      const web = data.web || {};
      if (web.connected || (web.qr && web.bootState === 'awaiting_qr')) {
        if (web.connected) stopWeb1Polling();
      }
    } catch {}
  }, 2000);
}

const _extraSlotTimers = {};
function startExtraSlotPolling(slot) {
  stopExtraSlotPolling(slot);
  loadConnectionCards();
  _extraSlotTimers[slot] = setInterval(async () => {
    try {
      const res = await apiFetch(`/api/connections/${slot}/status`);
      const s = await res.json();
      renderConnectionCards({ ...(runtimeStatus.connections || {}), [slot]: s });
      if (s.connected) stopExtraSlotPolling(slot);
    } catch {}
  }, 2000);
}
function stopExtraSlotPolling(slot) {
  if (_extraSlotTimers[slot]) { clearInterval(_extraSlotTimers[slot]); delete _extraSlotTimers[slot]; }
}

async function loadBusinessAssets(slot = '1') {
  const sl = String(slot);
  const box = document.getElementById(`conn-cloud${sl}-assets`);
  const nameEl = document.getElementById(`conn-cloud${sl}-asset-name`);
  const numbersEl = document.getElementById(`conn-cloud${sl}-asset-numbers`);
  const btn = document.getElementById(`btn-cloud${sl}-view-assets`);
  if (box) box.style.display = '';
  if (nameEl) nameEl.textContent = 'Loading...';
  if (numbersEl) numbersEl.innerHTML = '';
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch(`/api/cloud/business-assets?slot=${encodeURIComponent(sl)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to read business assets.');
    if (nameEl) nameEl.textContent = data.businessName || '(no name)';
    if (numbersEl) {
      if (!data.phoneNumbers || !data.phoneNumbers.length) {
        numbersEl.innerHTML = '<div style="color:var(--text3);">No phone numbers found on this WABA.</div>';
      } else {
        numbersEl.innerHTML = data.phoneNumbers.map(p => {
          const label = [p.displayPhoneNumber, p.verifiedName].filter(Boolean).join(' \u00b7 ') || p.id;
          const q = p.qualityRating ? ` <span style="color:var(--text3);">(${p.qualityRating})</span>` : '';
          return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--green);">&#10003;</span><span style="color:var(--text1);">${label}</span>${q}</div>`;
        }).join('');
      }
    }
  } catch (e) {
    if (nameEl) nameEl.textContent = '';
    if (numbersEl) numbersEl.innerHTML = `<div style="color:#ff6b6b;">${e.message}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function disconnectCloud1() {
  if (!confirm('Desconectar API Oficial 1? As credenciais serão apagadas deste workspace.')) return;
  await apiFetch('/api/connections/cloud1', { method: 'DELETE' });
  await loadConnectionCards();
}

async function connectCloud2() {
  pendingSignupSlot = '2';
  try {
    const cfgRes = await apiFetch('/api/cloud/embedded-config');
    const cfg = await cfgRes.json();
    if (!cfgRes.ok) throw new Error(cfg.error);
    if (cfg.missing?.length) throw new Error(`Configure no servidor: ${cfg.missing.join(', ')}`);
    const result = await openEmbeddedSignupPopup(cfg, 'existing', '2');
    metaSignupData = { phoneNumberId: result.phoneNumberId || '', wabaId: result.wabaId || '', businessId: result.businessId || '' };
    await finishMetaEmbeddedSignupSlot(result.code, '2');
  } catch (e) { alert('Erro: ' + e.message); }
  pendingSignupSlot = '1';
}

async function finishMetaEmbeddedSignupSlot(code, slot) {
  await new Promise(r => setTimeout(r, 600));
  const res = await apiFetch('/api/cloud/embedded-signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, slot, ...metaSignupData })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao conectar');
  await loadConnectionCards();
}


async function connectCloud3ViaEmbeddedSignup() {
  try {
    const cfgRes = await apiFetch('/api/cloud/embedded-config');
    const cfg = await cfgRes.json();
    if (!cfgRes.ok) throw new Error(cfg.error);
    if (cfg.missing && cfg.missing.length) throw new Error('Configure no servidor: ' + cfg.missing.join(', '));
    const result = await openEmbeddedSignupPopup(cfg, 'existing', '3');
    metaSignupData = { phoneNumberId: result.phoneNumberId || '', wabaId: result.wabaId || '', businessId: result.businessId || '' };
    const res = await apiFetch('/api/connections/cloud3/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: result.code, ...metaSignupData })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao conectar');
    await loadConnectionCards();
  } catch (e) { alert('Erro: ' + e.message); }
}

async function connectPersonalWabaViaEmbeddedSignup() {
  try {
    const cfgRes = await apiFetch('/api/cloud/embedded-config');
    const cfg = await cfgRes.json();
    if (!cfgRes.ok) throw new Error(cfg.error);
    if (cfg.missing && cfg.missing.length) throw new Error('Configure no servidor: ' + cfg.missing.join(', '));
    const result = await openEmbeddedSignupPopup(cfg, 'existing', 'personal');
    metaSignupData = { phoneNumberId: result.phoneNumberId || '', wabaId: result.wabaId || '', businessId: result.businessId || '' };
    const res = await apiFetch('/api/me/waba/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: result.code, ...metaSignupData })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao conectar');
    alert('WhatsApp conectado: ' + (data.displayPhone || data.phoneNumberId));
    await loadConnectionCards();
  } catch (e) { alert('Erro: ' + e.message); }
}

async function disconnectCloud2() {
  if (!confirm('Desconectar API Oficial 2?')) return;
  await apiFetch('/api/connections/cloud2', { method: 'DELETE' });
  await loadConnectionCards();
}

async function saveCloud3() {
  const phoneNumberId = (document.getElementById('conn-cloud3-phone-id')?.value || '').trim();
  const accessToken = (document.getElementById('conn-cloud3-token')?.value || '').trim();
  if (!phoneNumberId || !accessToken) { alert('Preencha o Phone Number ID e o Access Token.'); return; }
  const btn = document.getElementById('btn-cloud3-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  try {
    const res = await apiFetch('/api/connections/cloud3/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId, accessToken })
    });
    const data = await res.json();
    if (!res.ok) { alert('Erro: ' + (data.error || 'Falha ao salvar')); return; }
    await loadConnectionCards();
  } catch (e) { alert('Erro: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon"><use href="#i-smartphone"/></svg> Salvar e conectar'; } }
}

async function disconnectCloud3() {
  if (!confirm('Desconectar Token Manual? As credenciais serão apagadas deste workspace.')) return;
  await apiFetch('/api/connections/cloud3', { method: 'DELETE' });
  await loadConnectionCards();
}

function toggleTokenForm(slot, show) {
  const form = document.getElementById(`conn-${slot}-update-form`);
  if (form) form.style.display = show ? '' : 'none';
  if (show) document.getElementById(`conn-${slot}-new-token`)?.focus();
}

async function updateCloudToken(slot) {
  const input = document.getElementById(`conn-${slot}-new-token`);
  const token = input?.value?.trim();
  if (!token) { alert('Cole o novo Access Token no campo.'); return; }
  const slotNum = slot === 'cloud2' ? '2' : slot === 'cloud3' ? '3' : '1';
  const res = await apiFetch(`/api/connections/${slot}/update-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token })
  });
  const data = await res.json();
  if (!res.ok) { alert('Erro: ' + (data.error || 'Falha ao salvar')); return; }
  toggleTokenForm(slot, false);
  if (input) input.value = '';
  alert('Token atualizado com sucesso!');
  checkTokenExpiry(slot, slotNum);
}

async function checkTokenExpiry(slot, slotNum) {
  const warn = document.getElementById(`conn-${slot}-token-warning`);
  if (!warn) return;
  try {
    const res = await apiFetch(`/api/cloud/token-status?slot=${slotNum}`);
    if (!res.ok) return;
    const s = await res.json();
    if (!s.configured || s.checkFailed) return;
    if (s.neverExpires) { warn.style.display = 'none'; return; }
    if (!s.expiresAt) return;
    const daysLeft = s.daysLeft ?? Math.ceil((s.expiresAt - Date.now()) / 86400000);
    if (daysLeft <= 0) {
      warn.style.display = '';
      warn.innerHTML = `⚠️ Token <strong>expirado</strong>. O envio pela API Oficial está bloqueado. Clique em 🔑 Atualizar token.`;
    } else if (daysLeft <= 7) {
      warn.style.display = '';
      warn.innerHTML = `⚠️ Token expira em <strong>${daysLeft} dia${daysLeft !== 1 ? 's' : ''}</strong>. Atualize antes que pare de funcionar.`;
    } else {
      warn.style.display = 'none';
    }
  } catch {}
}

async function connectGroups() {
  await apiFetch('/api/connections/groups/connect', { method: 'POST' });
  startGroupsPolling();
}

async function connectGroupsPair() {
  const phone = prompt('Digite o número do WhatsApp (com DDI+DDD, sem espaços):\nEx: 5548999990000');
  if (!phone) return;
  await apiFetch('/api/connections/groups/pairing-code', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone.replace(/\D/g, '') })
  });
  startGroupsPolling();
}

async function resetGroupsConnection() {
  await apiFetch('/api/connections/groups/reset', { method: 'POST' });
  startGroupsPolling();
}

async function disconnectGroups() {
  if (!confirm('Desconectar WhatsApp de grupos? A sessão será apagada.')) return;
  await apiFetch('/api/connections/groups', { method: 'DELETE' });
  stopGroupsPolling();
  await loadConnectionCards();
}

async function loadConnectionCards() {
  try {
    const res = await apiFetch('/api/connections');
    if (!res.ok) return;
    const data = await res.json();
    renderConnectionCards(data);
  } catch {}
}

function startGroupsPolling() {
  stopGroupsPolling();
  loadConnectionCards();
  groupsPollingTimer = setInterval(async () => {
    try {
      const res = await apiFetch('/api/connections/groups/status');
      const s = await res.json();
      renderConnectionCards({ ...(runtimeStatus.connections || {}), groups: s });
      if (s.connected) stopGroupsPolling();
    } catch {}
  }, 2000);
}

function stopGroupsPolling() {
  if (groupsPollingTimer) { clearInterval(groupsPollingTimer); groupsPollingTimer = null; }
}

function hasLiteConnection() {
  return !!((window._liteConnInfo && window._liteConnInfo.connected) || (window._lite2ConnInfo && window._lite2ConnInfo.connected));
}

function hasAnyConnectedChannel() {
  return !!(runtimeStatus.connected || hasLiteConnection());
}

function loadConfig() {
  const dot = document.getElementById('config-status-dot');
  const text = document.getElementById('config-status-text');
  if (dot && text) {
    if (hasAnyConnectedChannel()) {
      dot.className = 'status-dot';
      text.textContent = runtimeStatus.connected
        ? (runtimeStatus.provider === 'cloud' ? `Cloud API conectada${runtimeStatus.cloudDisplayPhoneNumber ? ` (${runtimeStatus.cloudDisplayPhoneNumber})` : ''}` : 'WhatsApp conectado')
        : 'WhatsApp Lite conectado';
      text.style.color = 'var(--green)';
    } else {
      dot.className = 'status-dot is-warning';
      text.textContent = runtimeStatus.bootState === 'server_unreachable'
        ? 'Servidor offline'
        : 'Não conectado — clique em Conectar WhatsApp';
      text.style.color = 'var(--text2)';
    }
  }

  const modeLabel = document.getElementById('current-mode-label');
  const modeDesc = document.getElementById('current-mode-desc');
  if (modeLabel && modeDesc) {
    if (runtimeStatus.provider === 'cloud') {
      modeLabel.textContent = 'Servidor oficial (Cloud API)';
      modeDesc.textContent = 'Usando WhatsApp Business Cloud API da Meta. Recomendado para produção.';
    } else {
      modeLabel.textContent = 'WhatsApp Web (Baileys)';
      modeDesc.textContent = 'Usando sessão de WhatsApp Web. Requer que o celular esteja online.';
    }
  }

  loadWhatsappFunnelSettings();
}

async function saveWhatsappFunnelRoute(funnelId, chatConnectionId) {
  const funnel = crmFunnels.find(f => f.id === funnelId);
  if (!funnel) return;
  await apiFetch(`/api/funnels/${funnelId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: funnel.name, chatConnectionId: chatConnectionId || null })
  });
  funnel.chatConnectionId = chatConnectionId || null;
}

function buildWhatsappFunnelRenderKey() {
  const connectionsKey = whatsappFunnelConnectionOptions().map(opt => `${opt.id}:${opt.label}:${opt.phone || ''}:${opt.connected ? '1' : '0'}`).join('|');
  const funnelsKey = crmFunnels.map(funnel => `${funnel.id}:${funnel.name}:${funnel.chatConnectionId || ''}`).join('|');
  return `${connectionsKey}__${funnelsKey}`;
}

function whatsappFunnelSummary(connectionId) {
  const assigned = crmFunnels.filter(funnel => (funnel.chatConnectionId || '') === (connectionId || ''));
  if (!assigned.length) return 'Nenhum funil';
  if (assigned.length === 1) return assigned[0].name;
  if (assigned.length === 2) return `${assigned[0].name} e ${assigned[1].name}`;
  return `${assigned[0].name} +${assigned.length - 1}`;
}

function updateWhatsappFunnelRow(row) {
  if (!row) return;
  const connId = row.dataset.connId || '';
  const assigned = crmFunnels.filter(funnel => (funnel.chatConnectionId || '') === connId);
  const summary = row.querySelector('.wa-funnel-picker-label');
  const count = row.querySelector('.wa-funnel-row-count');
  const status = row.querySelector('.wa-funnel-status');
  if (summary) summary.textContent = whatsappFunnelSummary(connId);
  if (count) count.textContent = assigned.length ? `${assigned.length} funil${assigned.length > 1 ? 'is' : ''}` : 'Sem funil';
  if (status) {
    status.className = `wa-funnel-status${assigned.length ? ' is-active' : ''}`;
    status.textContent = assigned.length ? 'Ativo' : 'Livre';
  }
  row.querySelectorAll('.wa-funnel-menu-check').forEach(input => {
    const active = (crmFunnels.find(funnel => funnel.id === input.dataset.funnelId)?.chatConnectionId || '') === connId;
    input.checked = active;
    const item = input.closest('.wa-funnel-menu-item');
    if (item) item.classList.toggle('is-active', active);
  });
}

function syncWhatsappFunnelRows(funnelId) {
  document.querySelectorAll('.wa-funnel-row').forEach(updateWhatsappFunnelRow);
  if (!funnelId) return;
  document.querySelectorAll(`.wa-funnel-menu-check[data-funnel-id="${funnelId}"]`).forEach(input => {
    const row = input.closest('.wa-funnel-row');
    if (row) updateWhatsappFunnelRow(row);
  });
}

document.addEventListener('click', event => {
  document.querySelectorAll('.wa-funnel-picker.is-open').forEach(openPicker => {
    if (openPicker.contains(event.target)) return;
    openPicker.classList.remove('is-open');
    const trigger = openPicker.querySelector('.wa-funnel-picker-trigger');
    const menu = openPicker.querySelector('.wa-funnel-menu');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
});

function renderWhatsappFunnelSettings() {
  const card = document.getElementById('whatsapp-funnel-settings-card');
  const list = document.getElementById('whatsapp-funnel-settings-list');
  if (!card || !list) return;
  if (!crmFunnels.length) {
    list.innerHTML = '<div class="wa-funnel-config-empty">Nenhum funil criado ainda. Crie um funil no CRM para definir qual WhatsApp vai responder por ele.</div>';
    lastFunnelSettingsRenderKey = '';
    return;
  }

  const renderKey = buildWhatsappFunnelRenderKey();
  if (renderKey === lastFunnelSettingsRenderKey) return;
  lastFunnelSettingsRenderKey = renderKey;

  const rows = whatsappFunnelConnectionOptions();
  list.innerHTML = `
    <div class="wa-funnel-table">
      <div class="wa-funnel-table-head">
        <div>Nome</div>
        <div>Número</div>
        <div>Funil</div>
        <div>Estado</div>
      </div>
      <div class="wa-funnel-table-body">
        ${rows.map(conn => {
          const assigned = crmFunnels.filter(funnel => (funnel.chatConnectionId || '') === (conn.id || ''));
          const menuItems = crmFunnels.map(funnel => {
            const active = (funnel.chatConnectionId || '') === (conn.id || '');
            return `
              <label class="wa-funnel-menu-item${active ? ' is-active' : ''}">
                <input type="checkbox" class="wa-funnel-menu-check" data-conn-id="${escapeHtml(conn.id)}" data-funnel-id="${escapeHtml(funnel.id)}"${active ? ' checked' : ''}>
                <span>${escapeHtml(funnel.name)}</span>
              </label>
            `;
          }).join('');
          return `
            <div class="wa-funnel-row" data-conn-id="${escapeHtml(conn.id)}">
              <div class="wa-funnel-col wa-funnel-col-name">
                <strong>${escapeHtml(conn.label)}</strong>
              </div>
              <div class="wa-funnel-col wa-funnel-col-number">${escapeHtml(conn.phone || '—')}</div>
              <div class="wa-funnel-col wa-funnel-col-funnel">
                <div class="wa-funnel-picker">
                  <button type="button" class="wa-funnel-picker-trigger" data-conn-id="${escapeHtml(conn.id)}" aria-expanded="false">
                    <span class="wa-funnel-picker-label">${escapeHtml(whatsappFunnelSummary(conn.id))}</span>
                    <span class="wa-funnel-picker-caret">▾</span>
                  </button>
                  <div class="wa-funnel-menu" hidden>
                    <div class="wa-funnel-menu-title">Selecionar funis</div>
                    <div class="wa-funnel-menu-list">${menuItems}</div>
                  </div>
                </div>
                <span class="wa-funnel-row-count">${assigned.length ? `${assigned.length} funil${assigned.length > 1 ? 'is' : ''}` : 'Sem funil'}</span>
              </div>
              <div class="wa-funnel-col wa-funnel-col-status">
                <span class="wa-funnel-status${assigned.length ? ' is-active' : ''}">${assigned.length ? 'Ativo' : 'Livre'}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  list.querySelectorAll('.wa-funnel-picker-trigger').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const picker = button.closest('.wa-funnel-picker');
      const willOpen = !picker.classList.contains('is-open');
      document.querySelectorAll('.wa-funnel-picker.is-open').forEach(openPicker => {
        openPicker.classList.remove('is-open');
        const trigger = openPicker.querySelector('.wa-funnel-picker-trigger');
        const menu = openPicker.querySelector('.wa-funnel-menu');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (menu) menu.hidden = true;
      });
      picker.classList.toggle('is-open', willOpen);
      const menu = picker.querySelector('.wa-funnel-menu');
      button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (menu) menu.hidden = !willOpen;
    });
  });

  list.querySelectorAll('.wa-funnel-menu-check').forEach(input => {
    input.addEventListener('change', async () => {
      const funnelId = input.dataset.funnelId;
      const connId = input.dataset.connId || null;
      const funnel = crmFunnels.find(item => item.id === funnelId);
      if (!funnel) return;
      const nextConnId = input.checked ? connId : null;
      input.disabled = true;
      try {
        await saveWhatsappFunnelRoute(funnelId, nextConnId);
        syncWhatsappFunnelRows(funnelId);
        lastFunnelSettingsRenderKey = buildWhatsappFunnelRenderKey();
      } catch (error) {
        input.checked = !input.checked;
        alert('Não consegui salvar o funil neste WhatsApp: ' + error.message);
      } finally {
        input.disabled = false;
      }
    });
  });
}

async function loadWhatsappFunnelSettings(force = false) {
  const list = document.getElementById('whatsapp-funnel-settings-list');
  if (!list) return;

  if (funnelSettingsLoaded && !force) {
    renderWhatsappFunnelSettings();
    return;
  }
  if (funnelSettingsLoadingPromise && !force) return funnelSettingsLoadingPromise;
  if (!crmFunnels.length || force) {
    list.innerHTML = '<div class="wa-funnel-config-empty">Carregando funis...</div>';
  }

  funnelSettingsLoadingPromise = (async () => {
    try {
      const funnels = await apiFetch('/api/funnels').then(r => r.json());
      crmFunnels = Array.isArray(funnels) ? funnels : [];
      funnelSettingsLoaded = true;
      renderWhatsappFunnelSettings();
    } catch (error) {
      list.innerHTML = `<div class="wa-funnel-config-empty">Erro ao carregar funis: ${escapeHtml(error.message || 'tente novamente')}.</div>`;
      lastFunnelSettingsRenderKey = '';
      funnelSettingsLoaded = false;
    } finally {
      funnelSettingsLoadingPromise = null;
    }
  })();

  return funnelSettingsLoadingPromise;
}

// ─── Admin: usuários ──────────────────────────
function setupAdminClients() {
  if (!isAdmin) {
    document.getElementById('admin-section').style.display = 'none';
    document.getElementById('ai-config-section').style.display = 'none';
    return;
  }
  document.getElementById('admin-section').style.display = 'block';
  document.getElementById('ai-config-section').style.display = 'block';
  loadAiConfig();

  document.getElementById('btn-new-client').addEventListener('click', () => {
    ['new-client-id','new-client-name','new-client-username','new-client-password'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('new-client-feedback').style.display = 'none';
    document.getElementById('new-client-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('new-client-id').focus(), 50);
  });

  document.getElementById('new-client-modal-close').addEventListener('click', () => {
    document.getElementById('new-client-modal').style.display = 'none';
  });
  document.getElementById('new-client-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('new-client-modal'))
      document.getElementById('new-client-modal').style.display = 'none';
  });

  document.getElementById('btn-save-new-client').addEventListener('click', saveNewClient);

  document.getElementById('edit-client-modal-close').addEventListener('click', () => {
    document.getElementById('edit-client-modal').style.display = 'none';
  });
  document.getElementById('edit-client-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-client-modal'))
      document.getElementById('edit-client-modal').style.display = 'none';
  });
  document.getElementById('btn-save-edit-client').addEventListener('click', saveEditClient);

  loadAdminClients();
}

async function loadAdminClients() {
  if (!isAdmin) return;
  try {
    const clients = await apiFetch('/api/admin/clients').then(r => r.json());
    const el = document.getElementById('admin-clients-list');
    if (!clients.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px;">Nenhum usuário cadastrado</div>'; return; }
    el.innerHTML = clients.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;">${escapeHtml(c.name)} ${c.admin ? '<span style="font-size:10px;background:rgba(37,211,102,0.15);color:var(--green);padding:2px 6px;border-radius:4px;font-weight:700;">ADMIN</span>' : ''}</div>
          <div style="font-size:12px;color:var(--text2);">@${escapeHtml(c.username)} · ID: ${escapeHtml(c.id)}</div>
        </div>
        <button onclick="openEditClientModal('${escapeHtml(c.id)}','${escapeHtml(c.name)}','${escapeHtml(c.username)}')" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text1);cursor:pointer;font-size:12px;font-family:inherit;">${icon('edit')} Editar</button>
        ${!c.admin ? `<button onclick="impersonateClient('${escapeHtml(c.id)}','${escapeHtml(c.name)}')" style="padding:4px 10px;border-radius:6px;border:1px solid rgba(124,58,237,0.4);background:transparent;color:#a78bfa;cursor:pointer;font-size:12px;font-family:inherit;">Entrar como</button>` : ''}
        ${!c.admin ? `<button onclick="deleteAdminClient('${escapeHtml(c.id)}')" style="padding:4px 10px;border-radius:6px;border:1px solid #ff6b6b33;background:transparent;color:#ff6b6b;cursor:pointer;font-size:12px;font-family:inherit;">✕</button>` : ''}
      </div>`).join('');
  } catch {}
}

async function saveNewClient() {
  const fbEl = document.getElementById('new-client-feedback');
  const payload = {
    id: document.getElementById('new-client-id').value.trim(),
    name: document.getElementById('new-client-name').value.trim(),
    username: document.getElementById('new-client-username').value.trim(),
    password: document.getElementById('new-client-password').value.trim()
  };
  fbEl.style.display = 'none';
  try {
    const res = await apiFetch('/api/admin/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('new-client-modal').style.display = 'none';
    await loadAdminClients();
    showFeedback(document.getElementById('admin-feedback'), `✓ Usuário "${payload.name}" criado!`, 'success');
  } catch(e) {
    fbEl.textContent = e.message;
    fbEl.style.display = 'block';
  }
}

function openEditClientModal(id, name, username) {
  document.getElementById('edit-client-id').value = id;
  document.getElementById('edit-client-modal-title').textContent = `Editar — ${name}`;
  document.getElementById('edit-client-username').value = username || '';
  document.getElementById('edit-client-password').value = '';
  document.getElementById('edit-client-feedback').style.display = 'none';
  document.getElementById('edit-client-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('edit-client-username').focus(), 50);
}

async function saveEditClient() {
  const fbEl = document.getElementById('edit-client-feedback');
  const id = document.getElementById('edit-client-id').value;
  const username = document.getElementById('edit-client-username').value.trim();
  const password = document.getElementById('edit-client-password').value.trim();
  if (!username) { fbEl.textContent = 'Login não pode ser vazio'; fbEl.style.display = 'block'; return; }
  const payload = { username };
  if (password) payload.password = password;
  try {
    const res = await apiFetch(`/api/admin/clients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('edit-client-modal').style.display = 'none';
    await loadAdminClients();
    showFeedback(document.getElementById('admin-feedback'), '✓ Usuário atualizado!', 'success');
  } catch(e) {
    fbEl.textContent = e.message;
    fbEl.style.display = 'block';
  }
}

async function deleteAdminClient(id) {
  if (!confirm('Excluir este usuário? Isso não apaga os dados dele no servidor.')) return;
  try {
    const res = await apiFetch(`/api/admin/clients/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await loadAdminClients();
  } catch(e) {
    showFeedback(document.getElementById('admin-feedback'), e.message, 'error');
  }
}

async function impersonateClient(id, name) {
  try {
    const res = await apiFetch(`/api/admin/impersonate/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    sessionStorage.setItem('vac-token', authToken);
    sessionStorage.setItem('impersonate-name', name);
    localStorage.setItem('wa-token', data.token);
    location.reload();
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

function stopImpersonating() {
  const vacToken = sessionStorage.getItem('vac-token');
  if (!vacToken) return;
  localStorage.setItem('wa-token', vacToken);
  sessionStorage.removeItem('vac-token');
  sessionStorage.removeItem('impersonate-name');
  location.reload();
}

function setupProviderSelector() {
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchProvider(btn.dataset.provider));
  });
}

function setupConnectActions() {
  document.getElementById('btn-retry-status').addEventListener('click', async () => {
    await checkStatus();
  });
  document.getElementById('btn-back-dashboard').addEventListener('click', () => closeConnectScreen(true));

  document.getElementById('btn-reset-session').addEventListener('click', async () => {
    if (!confirm('Isso vai apagar a sessão criptografada do WhatsApp Web e gerar um novo QR. Use quando as mensagens não chegam ou aparecem como aguardando mensagem. Continuar?')) return;

    const feedback = document.getElementById('connect-feedback');
    feedback.style.display = 'block';
    feedback.textContent = 'Limpando chaves de criptografia antigas e reiniciando o WhatsApp...';

    try {
      await apiFetch('/api/web/reset-session', { method: 'POST' });

      let retries = 0;
      const waitForRestart = setInterval(async () => {
        retries++;
        try {
          const response = await apiFetch('/api/status');
          if (response.ok) {
            clearInterval(waitForRestart);
            feedback.style.display = 'none';
            await checkStatus();
          }
        } catch {}

        if (retries > 25) {
          clearInterval(waitForRestart);
          feedback.textContent = 'O servidor demorou para voltar. Aguarde alguns segundos e recarregue a pagina.';
        }
      }, 1000);
    } catch (error) {
      feedback.style.display = 'block';
      feedback.textContent = 'Nao foi possivel reiniciar a sessao local agora.';
    }
  });

  document.getElementById('btn-force-reset').addEventListener('click', async () => {
    if (!confirm('Vai matar o Chromium e reiniciar o WhatsApp Web sem derrubar o servidor. Continuar?')) return;
    const fb = document.getElementById('connect-feedback');
    fb.style.display = 'block';
    fb.textContent = 'Reiniciando WhatsApp... aguarde ~10 segundos.';
    try {
      await apiFetch('/api/force-reset', { method: 'POST' });
      setTimeout(() => { fb.textContent = ''; fb.style.display = 'none'; checkStatus(); }, 8000);
    } catch(e) {
      fb.textContent = 'Erro ao reiniciar: ' + e.message;
    }
  });

  document.getElementById('btn-use-pairing-code').addEventListener('click', () => {
    document.getElementById('pairing-code-section').style.display = 'block';
    document.getElementById('connect-mode-toggle').style.display = 'none';
    document.getElementById('connect-actions').style.display = 'none';
    document.getElementById('qr-wrap').style.display = 'none';
    document.getElementById('pairing-phone-input').focus();
  });

  document.getElementById('btn-cancel-pairing-code').addEventListener('click', async () => {
    await apiFetch('/api/pairing-code/cancel', { method: 'POST' }).catch(() => {});
    showPairingCodeSection(false);
    await checkStatus();
  });

  document.getElementById('btn-request-pairing-code').addEventListener('click', async () => {
    const phone = document.getElementById('pairing-phone-input').value.trim().replace(/\D/g, '');
    if (!phone || phone.length < 10) {
      alert('Digite o número completo com código do país e DDD. Ex: 5511987654321');
      return;
    }
    const btn = document.getElementById('btn-request-pairing-code');
    btn.disabled = true;
    btn.textContent = 'Aguardando...';
    try {
      const res = await apiFetch('/api/pairing-code/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      document.getElementById('pairing-code-input-wrap').style.display = 'none';
      document.getElementById('pairing-code-display').style.display = 'block';
      document.getElementById('pairing-code-value').textContent = '...';
      // Poll for the code
      let pollCount = 0;
      const poll = setInterval(async () => {
        pollCount++;
        try {
          const s = await apiFetch('/api/status').then(r => r.json());
          if (s.pairingCode) {
            const code = s.pairingCode;
            document.getElementById('pairing-code-value').textContent = code.slice(0, 4) + '-' + code.slice(4);
            clearInterval(poll);
          }
          if (s.connected) { clearInterval(poll); showPairingCodeSection(false); closeConnectScreen(); }
        } catch {}
        if (pollCount > 60) clearInterval(poll);
      }, 2000);
    } catch(e) {
      alert('Erro: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Solicitar código';
    }
  });
}

function showPairingCodeSection(show) {
  document.getElementById('pairing-code-section').style.display = show ? 'block' : 'none';
  document.getElementById('connect-mode-toggle').style.display = show ? 'none' : '';
  document.getElementById('qr-wrap').style.display = show ? 'none' : '';
  document.getElementById('pairing-code-input-wrap').style.display = 'flex';
  document.getElementById('pairing-code-display').style.display = 'none';
  document.getElementById('pairing-phone-input').value = '';
}

function setupDebug() {
  document.getElementById('btn-clear-debug').addEventListener('click', () => {
    debugEntries.length = 0;
    renderDebug();
  });

  document.getElementById('btn-test-schedule').addEventListener('click', async () => {
    dbgLog('info', '🧪 Testando campos do formulário', {
      recipientId: document.getElementById('recipient-id').value,
      recipientName: document.getElementById('recipient-name').value,
      recipientType: document.getElementById('recipient-type').value,
      message: document.getElementById('message-input').value.slice(0, 50),
      datetimeVal: document.getElementById('datetime-input').value,
      scheduledFor: new Date(document.getElementById('datetime-input').value).getTime(),
      uploadedFile,
      quickReplies: [...quickReplies],
      groupsCarregados: groups.length,
      contactsCarregados: contacts.length,
    });
  });
}

// ─── Polling de status ────────────────────────
let statusPollingTimer = null;
function startPolling() {
  if (statusPollingTimer) clearInterval(statusPollingTimer);
  checkStatus();
  statusPollingTimer = setInterval(checkStatus, 3000);
}

async function checkStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    runtimeStatus = data;
    syncProviderSelector();
    updateConnectionUI();
    updateLiveChatSyncNotice();
    renderActiveConnectionCard();
    if (data.connections) renderConnectionCards(data.connections);
    closeConnectScreen();
    await showDashboard();
  } catch {
    runtimeStatus = {
      provider: runtimeStatus.provider || 'web',
      connected: false,
      qr: null,
      bootState: 'server_unreachable',
      bootMessage: 'Servidor indisponivel ou reiniciando.',
      configMissing: []
    };
    syncProviderSelector();
    updateConnectionUI();
    updateLiveChatSyncNotice();
    closeConnectScreen();
    await showDashboard();
  }
}

function showConnecting() {
  const viewKey = `${runtimeStatus.provider}:${runtimeStatus.bootState}:${runtimeStatus.bootMessage || ''}:${(runtimeStatus.configMissing || []).join(',')}`;
  if (lastConnectView === viewKey) return;
  lastConnectView = viewKey;
  lastQrValue = null;

  const sub = document.getElementById('connect-sub');
  const hint = document.getElementById('connect-hint');
  const actions = document.getElementById('connect-actions');
  const feedback = document.getElementById('connect-feedback');
  actions.style.display = 'none';
  if (!feedback.textContent) feedback.style.display = 'none';

  if (runtimeStatus.provider === 'cloud') {
    sub.textContent = 'Conecte pelo popup oficial da Meta';
    hint.textContent = 'Escolha o WhatsApp Business no popup da Meta. O app salva a conexão automaticamente neste workspace.';
    const missing = (runtimeStatus.configMissing || []).length
      ? `<span>Cloud API ainda incompleta: <strong>${runtimeStatus.configMissing.join(', ')}</strong></span>`
      : `<span>${escapeHtml(runtimeStatus.bootMessage || 'Aguardando conexão oficial...')}</span>`;
    const phone = runtimeStatus.cloudDisplayPhoneNumber || runtimeStatus.cloudPhoneNumberId || '';
    document.getElementById('qr-wrap').innerHTML = `<div class="qr-loading">${missing}${phone ? `<span style="margin-top:8px;color:var(--green);">Número conectado: ${escapeHtml(phone)}</span>` : ''}<button type="button" class="btn-primary" id="btn-meta-embedded-connect" style="margin-top:16px;">Conectar pela Meta</button></div>`;
    document.getElementById('btn-meta-embedded-connect')?.addEventListener('click', startMetaEmbeddedSignup);
    return;
  }

  if (runtimeStatus.bootState === 'idle') {
    sub.textContent = 'WhatsApp ainda não foi conectado';
    hint.textContent = 'Vá em Configurações → Conectar WhatsApp para gerar o QR Code.';
    document.getElementById('qr-wrap').innerHTML = `<div class="qr-loading"><span style="font-size:13px;color:#888;">Clique em Configurações para conectar</span></div>`;
    return;
  }

  if (runtimeStatus.bootState === 'server_unreachable') {
    sub.textContent = 'O servidor esta reiniciando ou indisponivel';
    hint.textContent = 'Se voce acabou de reiniciar, aguarde alguns segundos e recarregue a pagina.';
    document.getElementById('qr-wrap').innerHTML = `<div class="qr-loading"><div class="spinner"></div><span>${escapeHtml(runtimeStatus.bootMessage || 'Servidor indisponivel.')}</span></div>`;
    actions.style.display = 'flex';
    return;
  }

  if (runtimeStatus.bootState === 'starting' || runtimeStatus.bootState === 'restoring_session') {
    sub.textContent = 'Conectando ao WhatsApp Web';
    hint.textContent = runtimeStatus.bootState === 'restoring_session'
      ? 'A sessao salva esta sendo restaurada. O QR so aparece se a reconexao falhar.'
      : 'Se a sessao ainda estiver valida, o painel abre sozinho assim que a conexao voltar.';
    document.getElementById('qr-wrap').innerHTML = `<div class="qr-loading"><div class="spinner"></div><span>${escapeHtml(runtimeStatus.bootMessage || 'Conectando ao WhatsApp Web...')}</span></div>`;
    actions.style.display = 'flex';
    return;
  }

  sub.textContent = 'Escaneie o QR Code com seu celular para conectar';
  hint.textContent = 'WhatsApp → Menu → Dispositivos Vinculados → Vincular dispositivo';
  document.getElementById('qr-wrap').innerHTML = `<div class="qr-loading"><div class="spinner"></div><span>Aguardando QR Code...</span></div>`;
  actions.style.display = 'flex';
}

function showQR(url) {
  if (lastQrValue === url) return;
  lastQrValue = url;
  lastConnectView = 'qr';
  syncProviderSelector();
  document.getElementById('connect-actions').style.display = 'flex';
  document.getElementById('qr-wrap').innerHTML = `<img src="${url}" alt="QR Code">`;
}

async function showDashboard() {
  applyProviderMode();
  if (hasAnyConnectedChannel() && groups.length === 0) {
    await loadRecipientOptions('group', { silent: true });
  }
  loadPending();
  loadLogs();
  updatePendingBadge();
}

function updateConnectionUI() {
  loadConfig();
  const currentType = document.getElementById('recipient-type')?.value || 'group';
  updateConnectionSelector(currentType);
  const sidebarStatus = document.getElementById('sidebar-status');
  const statusDot = document.getElementById('sidebar-status-dot');
  const statusText = document.getElementById('sidebar-status-text');
  const banner = document.getElementById('connection-banner');

  sidebarStatus.classList.remove('is-warning', 'is-error');
  statusDot.classList.remove('is-warning', 'is-error');

  if (hasAnyConnectedChannel()) {
    statusText.textContent = runtimeStatus.connected
      ? (runtimeStatus.provider === 'cloud' ? 'Cloud API pronta' : 'Conectado')
      : 'Lite conectado';
    banner.style.display = 'none';
    return;
  }

  if (runtimeStatus.pairingCode) {
    document.getElementById('pairing-code-section').style.display = 'block';
    document.getElementById('connect-mode-toggle').style.display = 'none';
    document.getElementById('qr-wrap').style.display = 'none';
    document.getElementById('connect-actions').style.display = 'none';
    document.getElementById('pairing-code-input-wrap').style.display = 'none';
    document.getElementById('pairing-code-display').style.display = 'block';
    const code = runtimeStatus.pairingCode;
    document.getElementById('pairing-code-value').textContent = code.slice(0, 4) + '-' + code.slice(4);
  } else if (runtimeStatus.qr) {
    showQR(runtimeStatus.qr);
  } else {
    showConnecting();
  }

  if (runtimeStatus.bootState === 'server_unreachable') {
    statusText.textContent = 'Servidor offline';
    sidebarStatus.classList.add('is-error');
    statusDot.classList.add('is-error');
    renderConnectionBanner(
      'is-error',
      runtimeStatus.bootMessage || 'O servidor local esta indisponivel no momento.',
      [
        { id: 'banner-retry-status', label: 'Atualizar status' },
        { id: 'banner-open-connect', label: 'Abrir Configurações' }
      ]
    );
    return;
  }

  if (runtimeStatus.bootState === 'awaiting_qr') {
    statusText.textContent = 'QR pendente';
    sidebarStatus.classList.add('is-warning');
    statusDot.classList.add('is-warning');
    renderConnectionBanner(
      'is-warning',
      'A sessao local expirou. O painel continua acessivel, e voce pode abrir o QR Code quando quiser.',
      [
        { id: 'banner-open-connect', label: 'Abrir Configurações' },
        { id: 'banner-reset-session', label: 'Gerar novo QR' }
      ]
    );
    return;
  }

  statusText.textContent = runtimeStatus.provider === 'cloud' ? 'Cloud pendente' : 'Reconectando...';
  sidebarStatus.classList.add('is-warning');
  statusDot.classList.add('is-warning');
  renderConnectionBanner(
    'is-warning',
    runtimeStatus.bootMessage || 'Reconectando a sessao local do WhatsApp Web.',
    [{ id: 'banner-open-connect', label: 'Abrir Configurações' }]
  );
}

function renderConnectionBanner(toneClass, message, actions) {
  const banner = document.getElementById('connection-banner');
  banner.className = `connection-banner ${toneClass}`.trim();
  banner.innerHTML = `
    <div class="connection-banner-text">${escapeHtml(message)}</div>
    <div class="connection-banner-actions">
      ${actions.map((action) => `<button type="button" class="btn-sidebar-action" id="${action.id}">${escapeHtml(action.label)}</button>`).join('')}
    </div>
  `;
  banner.style.display = 'flex';

  const openBtn = document.getElementById('banner-open-connect');
  if (openBtn) openBtn.addEventListener('click', openConnectScreen);

  const retryBtn = document.getElementById('banner-retry-status');
  if (retryBtn) retryBtn.addEventListener('click', () => checkStatus());

  const resetBtn = document.getElementById('banner-reset-session');
  if (resetBtn) resetBtn.addEventListener('click', resetWeb1);
}

function openConnectScreen(force) {
  closeConnectScreen();
  activateTab('config');
  document.getElementById('conn-active')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeConnectScreen(byUser) {
  if (byUser) connectScreenDismissed = true;
  document.getElementById('screen-connect').classList.remove('active');
  document.getElementById('screen-dashboard').classList.add('active');
}

function setConnMode(mode) {
  const macCards = document.getElementById('conn-mac-cards');
  const cloudCards = document.getElementById('conn-cloud-cards');
  const btnWeb = document.getElementById('btn-conn-mode-web');
  const btnCloud = document.getElementById('btn-conn-mode-cloud');
  if (!macCards || !cloudCards) return;
  if (mode === 'web') {
    macCards.style.display = 'flex';
    cloudCards.style.display = 'none';
    btnWeb?.classList.add('active');
    btnCloud?.classList.remove('active');
  } else {
    macCards.style.display = 'none';
    cloudCards.style.display = 'flex';
    btnCloud?.classList.add('active');
    btnWeb?.classList.remove('active');
  }
}

function setUserConnMode(mode) {
  const qrBtn = document.getElementById('btn-user-mode-qr');
  const wabaBtn = document.getElementById('btn-user-mode-waba');
  const form = document.getElementById('conn-user-waba-form');
  const web2 = document.getElementById('conn-web2');
  const web3 = document.getElementById('conn-web3');
  if (mode === 'waba') {
    if (qrBtn) qrBtn.classList.remove('active');
    if (wabaBtn) wabaBtn.classList.add('active');
    if (form) form.style.display = 'flex';
    if (web2) web2.style.display = 'none';
    if (web3) web3.style.display = 'none';
  } else {
    if (qrBtn) qrBtn.classList.add('active');
    if (wabaBtn) wabaBtn.classList.remove('active');
    if (form) form.style.display = 'none';
    if (web2) web2.style.display = _userDefaultConnectionId === 'web2' ? '' : 'none';
    if (web3) web3.style.display = _userDefaultConnectionId === 'web3' ? '' : 'none';
  }
}

async function savePersonalWaba() {
  const phoneNumberId = document.getElementById('user-waba-phone-id')?.value.trim();
  const accessToken = document.getElementById('user-waba-token')?.value.trim();
  const displayPhone = document.getElementById('user-waba-display')?.value.trim();
  const fb = document.getElementById('user-waba-feedback');
  if (!phoneNumberId || !accessToken) { showFeedback(fb, 'Preencha Phone Number ID e Access Token', 'error'); return; }
  try {
    const res = await apiFetch('/api/me/waba', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNumberId, accessToken, displayPhone }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao salvar');
    showFeedback(fb, '✓ API Oficial configurada', 'success');
    _userPersonalWaba = { phoneNumberId, displayPhone, connected: true };
    renderPersonalWabaStatus();
  } catch(e) { showFeedback(fb, e.message, 'error'); }
}

async function disconnectPersonalWaba() {
  if (!confirm('Desconectar API Oficial? Você voltará a usar QR Code.')) return;
  try {
    await apiFetch('/api/me/waba', { method: 'DELETE' });
    _userPersonalWaba = null;
    renderPersonalWabaStatus();
    setUserConnMode('qr');
  } catch(e) { alert(e.message); }
}

function renderPersonalWabaStatus() {
  const connDiv = document.getElementById('conn-user-waba-connected');
  const formDiv = document.getElementById('conn-user-waba-form');
  const dot = document.getElementById('user-waba-dot');
  const info = document.getElementById('user-waba-info');
  if (!connDiv || !formDiv) return;
  if (_userPersonalWaba?.connected) {
    connDiv.style.display = '';
    formDiv.style.display = 'none';
    if (dot) dot.className = 'status-dot';
    if (info) info.textContent = _userPersonalWaba.displayPhone || _userPersonalWaba.phoneNumberId || 'Conectado';
    const wabaBtn = document.getElementById('btn-user-mode-waba');
    const qrBtn = document.getElementById('btn-user-mode-qr');
    if (wabaBtn) wabaBtn.classList.add('active');
    if (qrBtn) qrBtn.classList.remove('active');
    // Hide QR slots
    const web2 = document.getElementById('conn-web2');
    const web3 = document.getElementById('conn-web3');
    if (web2) web2.style.display = 'none';
    if (web3) web3.style.display = 'none';
  } else {
    connDiv.style.display = 'none';
  }
}

function openTemplatesModal() {
  document.getElementById('templates-modal').style.display = 'flex';
}
function closeTemplatesModal() {
  document.getElementById('templates-modal').style.display = 'none';
}

// ─── Carregar grupos e contatos ───────────────
async function loadGroups() {
  const conn = (document.getElementById('schedule-connection-id') || {}).value || '';
  try { groups = await (await apiFetch('/api/groups' + (conn ? ('?connectionId=' + encodeURIComponent(conn)) : ''))).json(); if (!Array.isArray(groups)) groups = []; } catch { groups = []; }
}
async function loadContacts() {
  try { if (!crmCards || !crmCards.length) { if (typeof loadCrm === 'function') await loadCrm(); } } catch (e) {}
  contacts = (crmCards || []).map(c => { const d = String(c.whatsapp || c.phone || '').replace(/\D/g, ''); return { id: d ? (d + '@s.whatsapp.net') : (c.whatsappId || ''), name: c.contactName || d || 'Sem nome', phone: d }; }).filter(c => c.id && c.name);
}

function setupRecipientLoader() {
  document.getElementById('btn-load-recipients').addEventListener('click', () => {
    loadRecipientOptions(document.getElementById('recipient-type').value, { force: true });
  });

  document.getElementById('btn-smart-select-vac').addEventListener('click', () => {
    const type = document.getElementById('recipient-type').value;
    if (type !== 'group') {
      alert('A auto-seleção inteligente está disponível apenas para grupos.');
      return;
    }
    
    if (groups.length === 0) {
      alert('Carregue os grupos primeiro usando o botão ao lado.');
      return;
    }

    const keywords = ['VAC', 'MKT', 'START'];
    const matches = groups.filter(g => keywords.some(k => g.name.toUpperCase().includes(k)));

    if (matches.length > 0) {
      // Simular busca para mostrar os resultados
      const input = document.getElementById('recipient-input');
      input.value = 'VAC'; // Preencher com VAC para forçar a exibição dos grupos relevantes
      input.dispatchEvent(new Event('input'));
      setRecipientStatus(`${matches.length} grupos inteligentes encontrados! Escolha um na lista abaixo.`, 'success');
    } else {
      alert('Nenhum grupo com VAC, MKT ou START foi encontrado na lista atual.');
    }
  });

  updateRecipientLoaderUI();
}

async function loadRecipientOptions(type, options = {}) {
  const { force = false, silent = false } = options;
  const hasData = type === 'group' ? groups.length > 0 : contacts.length > 0;
  if (isLoadingRecipients) return;
  if (hasData && !force) {
    if (!silent) {
      const total = type === 'group' ? groups.length : contacts.length;
      setRecipientStatus(`${total} ${type === 'group' ? 'grupos' : 'contatos'} prontos para busca.`, 'success');
    }
    return;
  }

  isLoadingRecipients = true;
  updateRecipientLoaderUI();
  showRecipientProgress(type);

  try {
    if (type === 'group') await loadGroups();
    else await loadContacts();

    completeRecipientProgress(type);
    const total = type === 'group' ? groups.length : contacts.length;
    setRecipientStatus(
      total > 0
        ? `${total} ${type === 'group' ? 'grupos' : 'contatos'} carregados com sucesso.`
        : `Nenhum ${type === 'group' ? 'grupo' : 'contato'} encontrado.`
    , total > 0 ? 'success' : 'warn');
  } catch (e) {
    completeRecipientProgress(type, true);
    setRecipientStatus(`Erro ao carregar ${type === 'group' ? 'grupos' : 'contatos'}.`, 'error');
  } finally {
    isLoadingRecipients = false;
    updateRecipientLoaderUI();
  }
}

function updateRecipientLoaderUI() {
  const type = document.getElementById('recipient-type').value;
  const btn = document.getElementById('btn-load-recipients');
  const label = type === 'group' ? 'grupos' : 'contatos';
  btn.innerHTML = isLoadingRecipients ? `Carregando ${label}...` : `${icon('rotate-cw')} Carregar ${label}`;
  btn.disabled = isLoadingRecipients;
}

function showRecipientProgress(type) {
  const wrap = document.getElementById('recipient-progress');
  const fill = document.getElementById('recipient-progress-fill');
  const text = document.getElementById('recipient-progress-text');

  clearInterval(recipientProgressTimer);
  wrap.style.display = 'block';
  fill.style.width = '10%';
  text.textContent = `Preparando a leitura dos ${type === 'group' ? 'grupos' : 'contatos'}...`;

  let progress = 10;
  recipientProgressTimer = setInterval(() => {
    progress = Math.min(progress + 12, 88);
    fill.style.width = `${progress}%`;
    text.textContent = progress < 55
      ? `Conectando ao WhatsApp para buscar ${type === 'group' ? 'grupos' : 'contatos'}...`
      : `Recebendo a lista de ${type === 'group' ? 'grupos' : 'contatos'}...`;
  }, 220);
}

function completeRecipientProgress(type, isError = false) {
  const fill = document.getElementById('recipient-progress-fill');
  const text = document.getElementById('recipient-progress-text');

  clearInterval(recipientProgressTimer);
  recipientProgressTimer = null;
  fill.style.width = '100%';
  text.textContent = isError
    ? `Nao foi possivel concluir a busca de ${type === 'group' ? 'grupos' : 'contatos'}.`
    : `${type === 'group' ? 'Grupos' : 'Contatos'} carregados.`;
}

function setRecipientStatus(message, tone = 'neutral') {
  const status = document.getElementById('recipient-load-status');
  status.textContent = message;
  status.dataset.tone = tone;
}

function syncProviderSelector() {
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === runtimeStatus.provider);
    btn.disabled = isSwitchingProvider;
  });
}

async function switchProvider(provider) {
  if (isSwitchingProvider) return;
  if (provider === runtimeStatus.provider) return;

  const feedback = document.getElementById('provider-switch-feedback');
  isSwitchingProvider = true;
  syncProviderSelector();
  feedback.style.display = 'block';
  feedback.textContent = provider === 'cloud'
    ? 'Trocando para servidor oficial do WhatsApp...'
    : 'Trocando para execucao local no Mac...';

  try {
    await apiFetch('/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider })
    });

    feedback.textContent = 'Modo salvo. Aguardando o servidor reiniciar...';

    let retries = 0;
    const waitForRestart = setInterval(async () => {
      retries++;
      try {
        const response = await apiFetch('/api/status');
        if (response.ok) {
          clearInterval(waitForRestart);
          isSwitchingProvider = false;
          feedback.style.display = 'none';
          await checkStatus();
        }
      } catch {}

      if (retries > 25) {
        clearInterval(waitForRestart);
        isSwitchingProvider = false;
        feedback.textContent = 'O servidor demorou para voltar. Recarregue a pagina em alguns segundos.';
        syncProviderSelector();
      }
    }, 1000);
  } catch (error) {
    isSwitchingProvider = false;
    feedback.style.display = 'block';
    feedback.textContent = 'Nao foi possivel trocar o modo agora.';
    syncProviderSelector();
  }
}

document.getElementById('btn-refresh-all').addEventListener('click', async () => {
  groups = []; contacts = [];
  await Promise.all([loadGroups(), loadContacts()]);
  const currentType = document.getElementById('recipient-type').value;
  setRecipientStatus(
    currentType === 'group'
      ? `${groups.length} grupos prontos para busca.`
      : `${contacts.length} contatos prontos para busca.`,
    'success'
  );
  clearRecipient();
});

document.getElementById('btn-restart-server').addEventListener('click', async () => {
  const btn = document.getElementById('btn-restart-server');
  if (!confirm('Reiniciar o servidor? A conexão com o WhatsApp será mantida (sessão salva).')) return;
  btn.disabled = true;
  btn.textContent = '⏳ Reiniciando...';
  try {
    await apiFetch('/api/restart', { method: 'POST' });
  } catch {}
  // Aguarda o servidor voltar
  btn.innerHTML = 'Aguardando...';
  let tentativas = 0;
  const intervalo = setInterval(async () => {
    tentativas++;
    try {
      const r = await apiFetch('/api/status');
      if (r.ok) {
        clearInterval(intervalo);
        btn.disabled = false;
        btn.innerHTML = `${icon('power')} Reiniciar servidor`;
        alert('Servidor reiniciado! Recarregando...');
        location.reload();
      }
    } catch {}
    if (tentativas > 30) {
      clearInterval(intervalo);
      btn.disabled = false;
      btn.innerHTML = `${icon('power')} Reiniciar servidor`;
      alert('⚠️ Servidor demorou para voltar. Verifique o terminal.');
    }
  }, 1000);
});

// ─── Tipo de destinatário ─────────────────────
const typeBtns = document.querySelectorAll('.type-btn');
typeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    typeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const type = btn.dataset.type;
    document.getElementById('recipient-type').value = type;
    document.getElementById('recipient-label').textContent = type === 'group' ? 'Grupo de destino' : 'Contato de destino';
    document.getElementById('recipient-input').placeholder = type === 'group' ? 'Digite o nome do grupo...' : 'Digite o nome do contato...';
    clearRecipient();
    updateRecipientLoaderUI();
    updateConnectionSelector(type);
    setRecipientStatus(
      type === 'group'
        ? (groups.length ? `${groups.length} grupos prontos para busca.` : 'Clique para carregar os grupos.')
        : (contacts.length ? `${contacts.length} contatos prontos para busca.` : 'Clique para carregar os contatos.')
    );
  });
});

async function updateConnectionSelector(type) {
  const wrap = document.getElementById('connection-selector-wrap');
  const sel = document.getElementById('schedule-connection-id');
  const hint = document.getElementById('connection-selector-hint');
  if (!wrap || !sel) return;
  if (type !== 'group') { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  try { const r1 = await apiFetch('/api/lite/status?slot=1'); const d1 = await r1.json(); if (d1 && d1.enabled) window._liteConnInfo = { connected: d1.state === 'open', phone: d1.number || '' }; } catch (e) {}
  try { const r2 = await apiFetch('/api/lite/status?slot=2'); const d2 = await r2.json(); if (d2 && d2.enabled) window._lite2ConnInfo = { connected: d2.state === 'open', phone: d2.number || '' }; } catch (e) {}
  const conns = runtimeStatus.connections || {};
  const prev = sel.value;
  sel.innerHTML = '';
  const forcedBroadcast = _userBroadcastConnectionId || null;
  const groupSlots = forcedBroadcast ? [forcedBroadcast] : ['lite', 'lite2', 'groups', 'web', 'web2', 'web3'];
  let anyConnected = false;
  groupSlots.forEach(id => {
    let conn = conns[id]; let phone = _connectionPhones[id];
    if (id === 'lite' && window._liteConnInfo) { conn = { connected: window._liteConnInfo.connected }; phone = window._liteConnInfo.phone || phone; }
    else if (id === 'lite2' && window._lite2ConnInfo) { conn = { connected: window._lite2ConnInfo.connected }; phone = window._lite2ConnInfo.phone || phone; }
    if (!conn && !forcedBroadcast) return;
    const base = (CONNECTION_LABELS[id] && CONNECTION_LABELS[id].label) || id;
    const label = phone ? (base + ' · ' + phone) : base;
    const ok = conn && (conn.connected || conn.status === 'connected');
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = ok ? label : ('\u26a0 ' + label + ' — não conectado'); opt.disabled = !ok;
    sel.appendChild(opt);
    if (ok) anyConnected = true;
  });
  if (!sel.querySelector('option')) { const opt = document.createElement('option'); opt.value = 'web'; opt.disabled = true; opt.textContent = '\u26a0 Nenhuma conexão disponível'; sel.appendChild(opt); }
  const firstOk = [...sel.options].find(o => !o.disabled);
  const keepPrev = prev && [...sel.options].some(o => o.value === prev && !o.disabled);
  sel.value = forcedBroadcast || (keepPrev ? prev : (firstOk ? firstOk.value : (sel.options[0] ? sel.options[0].value : '')));
  if (!sel._connBound) { sel._connBound = true; sel.addEventListener('change', () => { const tt = document.getElementById('recipient-type'); if (tt && tt.value === 'group') loadRecipientOptions('group', { force: true }); }); }
  if (hint) { hint.textContent = anyConnected ? 'Conectado.' : 'Conecte um WhatsApp em Configurações antes de agendar para grupos.'; hint.style.color = anyConnected ? 'var(--green)' : '#ff6b6b'; }
}

// ─── Busca de destinatário ────────────────────
function setupRecipientSearch() {
  const input = document.getElementById('recipient-input');
  const results = document.getElementById('recipient-results');
  const wrap = document.getElementById('recipient-search-wrap');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.style.display = 'none'; return; }
    const type = document.getElementById('recipient-type').value;
    const list = type === 'group' ? groups : contacts;
    if (list.length === 0) {
      results.innerHTML = `<div class="search-result-empty">Clique em "Carregar ${type === 'group' ? 'grupos' : 'contatos'}" para preencher esta lista.</div>`;
      results.style.display = 'block';
      return;
    }
    const matches = list.filter(g => g.name.toLowerCase().includes(q)).slice(0, 20);

    results.innerHTML = matches.length === 0
      ? '<div class="search-result-empty">Nenhum resultado</div>'
      : matches.map(g => `<div class="search-result-item" data-id="${g.id}" data-name="${escapeHtml(g.name)}">${icon(type === 'group' ? 'users' : 'user')} ${escapeHtml(g.name)}</div>`).join('');

    results.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => selectRecipient(el.dataset.id, el.dataset.name));
    });
    results.style.display = 'block';
  });

  input.addEventListener('focus', () => { if (input.value.trim()) results.style.display = 'block'; });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) results.style.display = 'none'; });
}

function selectRecipient(id, name) {
  const type = document.getElementById('recipient-type').value;
  document.getElementById('recipient-id').value = id;
  document.getElementById('recipient-name').value = name;
  document.getElementById('recipient-results').style.display = 'none';
  document.getElementById('recipient-search-wrap').style.display = 'none';
  document.getElementById('recipient-selected-label').innerHTML = `${icon(type === 'group' ? 'users' : 'user')} ${escapeHtml(name)}`;
  document.getElementById('recipient-selected').style.display = 'flex';
}

function clearRecipient() {
  document.getElementById('recipient-id').value = '';
  document.getElementById('recipient-name').value = '';
  document.getElementById('recipient-input').value = '';
  document.getElementById('recipient-results').style.display = 'none';
  document.getElementById('recipient-search-wrap').style.display = 'block';
  document.getElementById('recipient-selected').style.display = 'none';
}

document.getElementById('btn-clear-recipient').addEventListener('click', clearRecipient);

// ─── Respostas rápidas ────────────────────────
function setupQuickReplies() {
  document.getElementById('btn-add-reply').addEventListener('click', () => {
    const val = document.getElementById('quick-reply-input').value.trim();
    if (!val || quickReplies.includes(val) || quickReplies.length >= 3) return;
    quickReplies.push(val);
    document.getElementById('quick-reply-input').value = '';
    renderQuickReplies('quick-replies-chips', quickReplies, (i) => {
      quickReplies.splice(i, 1);
      renderQuickReplies('quick-replies-chips', quickReplies, null);
    });
  });

  document.getElementById('quick-reply-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-add-reply').click(); }
  });
}

function renderQuickReplies(containerId, list, onRemove) {
  const container = document.getElementById(containerId);
  container.innerHTML = list.map((qr, i) =>
    `<div class="qr-chip">${escapeHtml(qr)}<button data-i="${i}" title="Remover">✕</button></div>`
  ).join('');
  if (onRemove) {
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => onRemove(parseInt(btn.dataset.i)));
    });
  }
}

// ─── Upload de arquivo ────────────────────────
function setupFileUpload() {
  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-file').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('document', file);

    try {
      const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      uploadedFile = { path: data.path, name: data.name };
      document.getElementById('file-name').textContent = '📎 ' + data.name;
      document.getElementById('file-selected').style.display = 'flex';
      document.getElementById('btn-file').style.display = 'none';
    } catch (e) {
      alert('Erro ao enviar arquivo: ' + e.message);
    }
  });

  document.getElementById('btn-clear-file').addEventListener('click', () => {
    uploadedFile = null;
    fileInput.value = '';
    document.getElementById('file-selected').style.display = 'none';
    document.getElementById('btn-file').style.display = 'block';
  });
}

// ─── Disparador ─────────────────────────────────
function getCrmLabelsFromCache() {
  const set = new Set();
  (crmCards || []).forEach(card => {
    (Array.isArray(card.labels) ? card.labels : (card.label ? [card.label] : [])).forEach(l => { if (l) set.add(l); });
  });
  ['Em andamento', 'Não respondeu', 'Finalizado'].forEach(l => set.add(l));
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function refreshBroadcastLabels() {
  if (!crmCards.length && hasAppFeature('crm')) {
    try { await loadCrm(); } catch {}
  }
  renderBcLabelPicker();
}

function renderBcLabelPicker() {
  const container = document.getElementById('broadcast-label-filter');
  if (!container) return;
  const allLabels = getCrmLabelsFromCache();

  const chips = document.getElementById('bc-label-chips');
  if (chips) {
    chips.innerHTML = [..._bcSelectedLabels].map(l =>
      `<span class="bc-label-chip" style="background:var(--accent);">${escapeHtml(l)}<button data-label="${escapeHtml(l)}" title="Remover">×</button></span>`
    ).join('');
    chips.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        _bcSelectedLabels.delete(btn.dataset.label);
        renderBcLabelPicker();
      });
    });
  }

  const inp = document.getElementById('bc-label-search');
  const dropdown = document.getElementById('bc-label-dropdown');
  if (!inp || !dropdown) return;

  const renderDropdown = (filter = '') => {
    const f = filter.toLowerCase().trim();
    const opts = allLabels.filter(l => !_bcSelectedLabels.has(l) && (!f || l.toLowerCase().includes(f)));
    if (!opts.length && !f) { dropdown.style.display = 'none'; return; }
    dropdown.style.display = 'block';
    dropdown.innerHTML = opts.map(l => `<button class="bc-label-opt" data-label="${escapeHtml(l)}"><span class="bc-dot" style="background:var(--accent);"></span>${escapeHtml(l)}</button>`).join('');
    dropdown.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        _bcSelectedLabels.add(btn.dataset.label);
        inp.value = '';
        dropdown.style.display = 'none';
        renderBcLabelPicker();
      });
    });
  };

  // Re-wire input events (cloneNode removes old listeners to prevent duplicates)
  const newInp = inp.cloneNode(true);
  inp.parentNode.replaceChild(newInp, inp);
  newInp.addEventListener('input', () => renderDropdown(newInp.value));
  newInp.addEventListener('focus', () => renderDropdown(newInp.value));
}

function setupBroadcast() {
  document.querySelectorAll('[data-broadcast-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-broadcast-source]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      broadcastSource = btn.dataset.broadcastSource;
      document.getElementById('broadcast-label-filter-wrap').style.display = broadcastSource === 'crm' ? 'block' : 'none';
      const sw = document.getElementById('broadcast-search-wrap');
      if (sw) sw.style.display = 'none';
      const si = document.getElementById('broadcast-search');
      if (si) si.value = '';
      broadcastTargets = [];
      renderBroadcastTargets();
      renderGroupDispatchStatus();
    });
  });
  loadGroupDispatchStatus();
  document.getElementById('btn-load-group-canary')?.addEventListener('click', loadGroupCanaryOptions);
  document.getElementById('btn-run-group-canary')?.addEventListener('click', runGroupCanary);
  document.getElementById('btn-load-broadcast-targets')?.addEventListener('click', loadBroadcastTargets);
  document.getElementById('btn-enqueue-broadcast')?.addEventListener('click', enqueueBroadcast);
  document.getElementById('btn-enqueue-madrugada')?.addEventListener('click', openMadrugadaPanel);
  document.getElementById('btn-cancel-madrugada')?.addEventListener('click', closeMadrugadaPanel);
  document.getElementById('btn-confirm-madrugada')?.addEventListener('click', confirmMadrugada);
  document.getElementById('btn-retry-failed')?.addEventListener('click', retryFailedLogs);
  document.getElementById('broadcast-search')?.addEventListener('input', renderBroadcastTargets);
  document.getElementById('btn-broadcast-file')?.addEventListener('click', () => document.getElementById('broadcast-file-input')?.click());
  document.getElementById('broadcast-file-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file, file.name);
    try {
      const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao enviar arquivo');
      broadcastFile = data;
      document.getElementById('broadcast-file-name').textContent = data.name;
      document.getElementById('broadcast-file-selected').style.display = 'flex';
    } catch (err) { alert(err.message); }
  });
  document.getElementById('btn-clear-broadcast-file')?.addEventListener('click', () => {
    broadcastFile = null;
    document.getElementById('broadcast-file-input').value = '';
    document.getElementById('broadcast-file-selected').style.display = 'none';
  });
  // Close label dropdown when clicking outside the picker
  document.addEventListener('click', e => {
    if (!e.target.closest('.bc-label-picker')) {
      const dd = document.getElementById('bc-label-dropdown');
      if (dd) dd.style.display = 'none';
    }
  });
}

function selectedBroadcastLabels() {
  return [..._bcSelectedLabels];
}

function formatGroupCanaryStatus(status) {
  if (!status) return 'Status de grupos não carregado.';
  if (status.paused) return `Atenção: ${status.reason || 'houve uma falha recente em grupos.'}`;
  if (status.canaryFresh) {
    const when = status.canaryLastAt ? new Date(status.canaryLastAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    return `Diagnóstico de grupos ok${when ? ` às ${when}` : ''}.`;
  }
  if (status.canaryLastOk) return 'Diagnóstico antigo. A fila pode seguir; rode novamente só se quiser testar.';
  return 'Diagnóstico opcional. A fila usa o QR Code escolhido para enviar aos grupos.';
}

function renderGroupDispatchStatus() {
  const panel = document.getElementById('group-safety-panel');
  const statusEl = document.getElementById('group-safety-status');
  if (!panel || !statusEl) return;
  panel.classList.toggle('is-warning', !groupDispatchStatus?.canaryFresh || !!groupDispatchStatus?.paused);
  panel.classList.toggle('is-ok', !!groupDispatchStatus?.canaryFresh && !groupDispatchStatus?.paused);
  statusEl.textContent = formatGroupCanaryStatus(groupDispatchStatus);
  const sel = document.getElementById('group-canary-select');
  if (sel && groupDispatchStatus?.canaryGroupId && [...sel.options].some(o => o.value === groupDispatchStatus.canaryGroupId)) sel.value = groupDispatchStatus.canaryGroupId;
}

async function loadGroupDispatchStatus() {
  try {
    const res = await apiFetch('/api/group-dispatch/status');
    const data = await res.json();
    if (res.ok) groupDispatchStatus = data;
  } catch {}
  renderGroupDispatchStatus();
}

async function loadGroupCanaryOptions() {
  const fb = document.getElementById('broadcast-feedback');
  const sel = document.getElementById('group-canary-select');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/groups');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao carregar grupos');
    sel.innerHTML = data.length ? data.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name || g.id)}</option>`).join('') : '<option value="">Nenhum grupo encontrado</option>';
    if (groupDispatchStatus?.canaryGroupId && data.some(g => g.id === groupDispatchStatus.canaryGroupId)) sel.value = groupDispatchStatus.canaryGroupId;
    showFeedback(fb, `${data.length} grupos carregados para teste.`, 'success');
  } catch (e) { showFeedback(fb, e.message, 'error'); }
}

async function runGroupCanary() {
  const fb = document.getElementById('broadcast-feedback');
  const btn = document.getElementById('btn-run-group-canary');
  const groupId = document.getElementById('group-canary-select')?.value || groupDispatchStatus?.canaryGroupId || '';
  if (!groupId) return showFeedback(fb, 'Escolha um grupo para o canário.', 'error');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = 'Testando...';
  try {
    const res = await apiFetch('/api/group-dispatch/canary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId })
    });
    const data = await res.json();
    groupDispatchStatus = data.status || null;
    renderGroupDispatchStatus();
    if (!res.ok) throw new Error(data.error || 'Canário falhou');
    showFeedback(fb, 'Canário enviado. Confira no WhatsApp: se ele aparecer como aguardando mensagem, não dispare para clientes.', 'success');
  } catch (e) {
    renderGroupDispatchStatus();
    showFeedback(fb, e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function loadBroadcastTargets() {
  const fb = document.getElementById('broadcast-feedback');
  fb.style.display = 'none';
  const qs = new URLSearchParams({ source: broadcastSource });
  if (broadcastSource === 'crm') qs.set('labels', selectedBroadcastLabels().join(','));
  try {
    const res = await apiFetch(`/api/broadcast/targets?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao carregar destinatários');
    // CRM targets come pre-selected; contacts/groups must be marked manually
    const preSelected = broadcastSource === 'crm';
    broadcastTargets = data.map(t => ({ ...t, selected: preSelected }));
    const searchWrap = document.getElementById('broadcast-search-wrap');
    if (searchWrap) searchWrap.style.display = broadcastSource !== 'crm' ? 'block' : 'none';
    renderBroadcastTargets();
    renderGroupDispatchStatus();
  } catch(e) { showFeedback(fb, e.message, 'error'); }
}

function renderBroadcastTargets() {
  const el = document.getElementById('broadcast-targets');
  const summary = document.getElementById('broadcast-summary');
  if (!el) return;
  if (!broadcastTargets.length) {
    el.innerHTML = '<div class="broadcast-empty">Nenhum destinatário carregado</div>';
    if (summary) summary.textContent = 'Nenhum destinatário selecionado';
    return;
  }
  const searchTerm = (document.getElementById('broadcast-search')?.value || '').toLowerCase().trim();
  const visible = broadcastTargets.map((t, i) => ({ ...t, _i: i })).filter(t =>
    !searchTerm || (t.name || t.id).toLowerCase().includes(searchTerm)
  );
  el.innerHTML = visible.map(t => `<label class="broadcast-target-row"><input type="checkbox" data-index="${t._i}" ${t.selected ? 'checked' : ''}><span><strong>${escapeHtml(t.name || t.id)}</strong><small>${escapeHtml(t.id)}</small></span></label>`).join('');
  el.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    broadcastTargets[Number(input.dataset.index)].selected = input.checked;
    updateBroadcastSummary();
    renderGroupDispatchStatus();
  }));
  updateBroadcastSummary();
}

function updateBroadcastSummary() {
  const count = broadcastTargets.filter(t => t.selected).length;
  const summary = document.getElementById('broadcast-summary');
  if (summary) summary.textContent = count ? `${count} destinatário${count !== 1 ? 's' : ''} selecionado${count !== 1 ? 's' : ''}` : 'Nenhum destinatário selecionado';
}

function openMadrugadaPanel() {
  // Pré-preenche com horário atual + 5min como sugestão de início
  const now = new Date(Date.now() + 5 * 60 * 1000);
  const hhmm = h => `${String(h.getHours()).padStart(2,'0')}:${String(h.getMinutes()).padStart(2,'0')}`;
  const startEl = document.getElementById('madrugada-start');
  if (startEl && !startEl.value) startEl.value = hhmm(now);
  document.getElementById('madrugada-panel').style.display = '';
}

function closeMadrugadaPanel() {
  document.getElementById('madrugada-panel').style.display = 'none';
}

function timeInputToTimestamp(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  // Se o horário já passou hoje, agenda para amanhã
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function confirmMadrugada() {
  closeMadrugadaPanel();
  const startAt = timeInputToTimestamp(document.getElementById('madrugada-start').value);
  const endAt   = timeInputToTimestamp(document.getElementById('madrugada-end').value);
  await enqueueBroadcast('madrugada', startAt, endAt);
}

async function checkFailedLogsBanner() {
  try {
    const data = await (await apiFetch('/api/broadcast/retry-failed')).json();
    const banner = document.getElementById('failed-logs-banner');
    if (!banner) return;
    if (data.count > 0) {
      document.getElementById('failed-logs-count').textContent = `⚠ ${data.count} mensagem${data.count > 1 ? 's' : ''} falharam desde o último envio com sucesso e podem ser re-enviadas.`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  } catch {}
}

async function enqueueBroadcast(mode = 'normal', startAt = null, endAt = null) {
  const fb = document.getElementById('broadcast-feedback');
  const targets = broadcastTargets.filter(t => t.selected).map(({ id, name, type }) => ({ id, name, type }));
  const message = document.getElementById('broadcast-message').value.trim();
  if (!message) return showFeedback(fb, 'Digite uma mensagem', 'error');
  if (!targets.length) return showFeedback(fb, 'Selecione destinatários', 'error');
  try {
    const res = await apiFetch('/api/broadcast/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets, message, documentPath: broadcastFile?.path || null, documentName: broadcastFile?.name || null, mode, startAt, endAt })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao criar fila');
    if (mode === 'madrugada') {
      const skipMsg = data.filteredOut > 0 ? ` (${data.filteredOut} duplicatas ignoradas)` : '';
      const timeMsg = data.startsAt ? ` Início: ${new Date(data.startsAt).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}.` : '';
      showFeedback(fb, `🌙 ${data.created} mensagens agendadas.${timeMsg} 1 a cada 2min, pausa 20min a cada 5.${skipMsg}`, 'success');
    } else {
      showFeedback(fb, `✓ ${data.created} mensagens entraram na fila. Pausa de 5 min a cada 5 envios.`, 'success');
    }
    await loadGroupDispatchStatus();
    loadPending();
  } catch(e) { showFeedback(fb, e.message, 'error'); }
}

async function retryFailedLogs() {
  const btn = document.getElementById('btn-retry-failed');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Reagendando...';
  try {
    const res = await apiFetch('/api/broadcast/retry-failed', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro');
    document.getElementById('failed-logs-banner').style.display = 'none';
    alert(`✓ ${data.requeued} mensagens re-colocadas na fila. Veja em Agendados.`);
    loadPending();
  } catch(e) {
    btn.disabled = false;
    btn.textContent = '↺ Re-colocar na fila';
    alert(e.message);
  }
}

// ─── Modelos Meta ─────────────────────────────
let templatesSetupDone = false;

function setupTemplates() {
  if (templatesSetupDone) return;
  templatesSetupDone = true;
  document.getElementById('btn-submit-template')?.addEventListener('click', submitMetaTemplate);
  document.getElementById('btn-load-templates')?.addEventListener('click', loadTemplates);
  document.getElementById('tpl-list-slot')?.addEventListener('change', loadTemplates);
}

function templateStatusLabel(status) {
  const map = { APPROVED: 'Aprovado', PENDING: 'Em análise', REJECTED: 'Rejeitado', PAUSED: 'Pausado', DISABLED: 'Desativado' };
  return map[status] || status || '-';
}

async function submitMetaTemplate() {
  const fb = document.getElementById('tpl-feedback');
  const payload = {
    slot: document.getElementById('tpl-slot')?.value || '1',
    name: document.getElementById('tpl-name')?.value || '',
    category: document.getElementById('tpl-category')?.value || 'UTILITY',
    language: document.getElementById('tpl-language')?.value || 'pt_BR',
    header: document.getElementById('tpl-header')?.value || '',
    body: document.getElementById('tpl-body')?.value || '',
    samples: document.getElementById('tpl-samples')?.value || '',
    footer: document.getElementById('tpl-footer')?.value || '',
    buttons: document.getElementById('tpl-buttons')?.value || ''
  };
  showFeedback(fb, 'Enviando modelo para a Meta...', '');
  try {
    const res = await apiFetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao enviar modelo');
    showFeedback(fb, `✓ Modelo "${data.payload?.name || payload.name}" enviado para aprovação.`, 'success');
    document.getElementById('tpl-list-slot').value = payload.slot;
    await loadTemplates();
  } catch(e) {
    showFeedback(fb, e.message, 'error');
  }
}

async function loadTemplates() {
  const el = document.getElementById('templates-list');
  if (!el) return;
  const slot = document.getElementById('tpl-list-slot')?.value || '1';
  el.innerHTML = '<div class="empty-state" style="padding:24px 10px;">Carregando modelos...</div>';
  try {
    const res = await apiFetch(`/api/templates?slot=${encodeURIComponent(slot)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao carregar modelos');
    const list = data.templates || [];
    if (!list.length) {
      el.innerHTML = '<div class="empty-state" style="padding:24px 10px;">Nenhum modelo nesta WABA ainda.</div>';
      return;
    }
    el.innerHTML = list.map(t => `
      <div class="template-item">
        <div>
          <strong>${escapeHtml(t.name || '')}</strong>
          <small>${escapeHtml(t.language || '')} · ${escapeHtml(t.category || '')}</small>
          ${t.rejected_reason ? `<small class="template-error">${escapeHtml(t.rejected_reason)}</small>` : ''}
        </div>
        <span class="template-status template-status-${String(t.status || '').toLowerCase()}">${escapeHtml(templateStatusLabel(t.status))}</span>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 10px;color:var(--red);">${escapeHtml(e.message)}</div>`;
  }
}

// ─── Tabs ─────────────────────────────────────
function activateTab(tab) {
  const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  const panel = document.getElementById('tab-' + tab);
  if (!btn || !panel || btn.style.display === 'none') return false;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  panel.classList.add('active');
  const main = document.getElementById('main-content');
  if (tab === 'chat') {
    startChatPolling();
    if (!crmCards.length) loadCrm();
    main?.classList.add('chat-mode');
  } else {
    stopChatPolling();
    main?.classList.remove('chat-mode');
  }
  if (tab !== 'crm') main?.classList.remove('crm-chat-mode');
  if (tab === 'pending') loadPending();
  if (tab === 'schedule') refreshBroadcastLabels();
  if (tab === 'logs') { loadLogs(); checkFailedLogsBanner(); }
  if (tab === 'reports') loadReports();
  if (tab === 'crm') loadCrm();
  if (tab === 'prospects') loadProspects();
  if (tab === 'queue') { loadSheetsConfig(); loadSheetsChannels(); }
  if (tab === 'config') { loadConfig(); loadAdminClients(); loadConnectionCards(); loadTemplates(); }
  if (tab === 'financeiro') finLoad();
  if (tab === 'email') switchEmailView(_emailView || 'inbox');
  if (tab === 'files') loadFiles();
  return true;
}

function setupTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
    });
  });
}

// ─── Formulário de agendamento ────────────────
function setupForm() {
  document.getElementById('message-input').addEventListener('input', e => {
    document.getElementById('char-count').textContent = e.target.value.length;
  });

  let currentTemplateIndex = 0;
  const templates = [
    {
      label: "📊 Mensagem de Quarta (VAC)",
      text: `📊 Relatório de Meio de Semana | [Nome da Empresa]

Olá! Passando para atualizar sobre os números parciais até hoje:

✅ Leads captados: [Inserir]
🔵 Desempenho geral: As campanhas seguem estáveis e dentro da meta.
🚀 Observações: [Ajustes realizados na segunda/terça]

Seguimos acompanhando de perto! 📈`
    },
    {
      label: "📊 Mensagem de Sexta (VAC)",
      text: `📊 Atualização de Sexta-feira | [Nome da Empresa]

Olá! Tudo tranquilo por aqui esta semana:

✅ Leads – volume dentro do esperado!

🔵 Anúncios – sem alterações, as campanhas seguem estáveis e performando bem.

Bom fim de semana! Estaremos de plantão 🙌`
    },
    {
      label: "📊 Mensagem de Segunda (VAC)",
      text: `🚀 Planejamento da Semana | [Nome da Empresa]

Bom dia! Iniciando mais uma semana por aqui. Nosso foco para os próximos dias será:

✅ Manutenção do volume de leads.
🔵 Verificação de criativos e públicos.
🚀 Implementação de: [Novo teste/estratégia]

Tenha uma excelente semana de vendas! 🤝`
    }
  ];

  document.getElementById('btn-template-cycle').addEventListener('click', () => {
    const template = templates[currentTemplateIndex];
    
    // Atualiza o texto
    const textarea = document.getElementById('message-input');
    textarea.value = template.text;
    textarea.dispatchEvent(new Event('input'));

    // Atualiza o botão para o PRÓXIMO modelo (preview)
    currentTemplateIndex = (currentTemplateIndex + 1) % templates.length;
    const nextTemplate = templates[currentTemplateIndex];
    document.getElementById('btn-template-cycle').innerHTML = `${icon('calendar')} Ver Próximo: ${nextTemplate.label.split(' (')[0]}`;
    
    // Feedback visual rápido no botão
    const btn = document.getElementById('btn-template-cycle');
    const originalBg = btn.style.background;
    btn.style.background = 'rgba(37,211,102,0.2)';
    setTimeout(() => { btn.style.background = originalBg; }, 300);
  });

  document.getElementById('btn-schedule').addEventListener('click', scheduleMessage);
}

async function scheduleMessage() {
  const inputVal = document.getElementById('recipient-input').value;
  const recipientType = document.getElementById('recipient-type').value;
  const selectedConnection = document.getElementById('schedule-connection-id')?.value || 'web';
  const isCloudSend = recipientType === 'contact' && selectedConnection.startsWith('cloud');
  const recipientId = isCloudSend
    ? normalizePhoneNumber(document.getElementById('recipient-id').value || inputVal)
    : document.getElementById('recipient-id').value;
  const recipientName = isCloudSend
    ? (document.getElementById('recipient-name').value || recipientId)
    : document.getElementById('recipient-name').value;
  const message = document.getElementById('message-input').value.trim();
  const datetimeVal = document.getElementById('datetime-input').value;
  const fb = document.getElementById('schedule-feedback');

  if (!recipientId) {
    return showFeedback(
      fb,
      isCloudSend ? 'Digite um numero de WhatsApp valido com DDI e DDD' : 'Selecione um destinatário',
      'error'
    );
  }
  if (!message) return showFeedback(fb, 'Digite uma mensagem', 'error');
  if (!datetimeVal) return showFeedback(fb, 'Selecione data e hora', 'error');
  const scheduledFor = new Date(datetimeVal).getTime();
  if (!scheduledFor || isNaN(scheduledFor)) return showFeedback(fb, 'Data e hora inválidas', 'error');
  if (scheduledFor <= Date.now()) return showFeedback(fb, 'A data deve ser no futuro', 'error');

  const btn = document.getElementById('btn-schedule');
  btn.disabled = true; btn.textContent = '⏳ Agendando...';

  try {
    const res = await apiFetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType, recipientId, recipientName, message,
        scheduledFor,
        documentPath: uploadedFile?.path || null,
        documentName: uploadedFile?.name || null,
        quickReplies: [...quickReplies],
        connectionId: recipientType === 'group' ? selectedConnection : null
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const dt = new Date(scheduledFor);
    showFeedback(fb, `✅ Agendado para ${formatDate(dt)} às ${formatTime(dt)}!`, 'success');

    // Reset form
    clearRecipient();
    document.getElementById('message-input').value = '';
    document.getElementById('char-count').textContent = '0';
    document.getElementById('datetime-input').value = '';
    quickReplies = [];
    renderQuickReplies('quick-replies-chips', [], null);
    uploadedFile = null;
    document.getElementById('file-selected').style.display = 'none';
    document.getElementById('btn-file').style.display = 'block';
    document.getElementById('file-input').value = '';
    updatePendingBadge();
  } catch (e) {
    showFeedback(fb, '❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = `${icon('calendar')} Agendar Mensagem`;
  }
}

// ─── Pendentes ────────────────────────────────
async function loadPending() {
  try {
    const schedules = await (await apiFetch('/api/schedules')).json();
    const clearBtn = schedules.length > 0
      ? `<button class="btn-clear-queue" onclick="clearQueue()">🗑 Limpar Fila</button>`
      : '';
    const queueInfo = runtimeStatus.queueLength > 0
      ? `<div class="queue-note">Fila ativa: ${runtimeStatus.queueLength} envio(s) aguardando, com intervalo de ${runtimeStatus.dispatchIntervalSeconds || 40}s. ${clearBtn}</div>`
      : (schedules.length > 0 ? `<div class="queue-note">${clearBtn}</div>` : '');
    const list = document.getElementById('pending-list');
    if (schedules.length === 0) {
      list.innerHTML = `${queueInfo}<div class="empty-state"><div class="empty-icon"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><use href="#i-inbox"/></svg></div><div>Nenhum envio agendado</div></div>`;
      return;
    }
    list.innerHTML = queueInfo + schedules.map(s => {
      const dt = new Date(s.scheduledFor);
      const recipIcon = icon(s.recipientType === 'contact' ? 'user' : 'users');
      return `
        <div class="schedule-item">
          <div class="schedule-time-block">
            <div class="schedule-time-day">${formatDate(dt)}</div>
            <div class="schedule-time-hour">${formatTime(dt)}</div>
          </div>
          <div class="schedule-info">
            <div class="schedule-recipient">${recipIcon} ${escapeHtml(s.recipientName)}</div>
            <div class="schedule-msg">${escapeHtml(s.message)}</div>
            ${s.documentName ? `<div class="schedule-doc">${icon('paperclip')} ${escapeHtml(s.documentName)}</div>` : ''}
            ${s.quickReplies && s.quickReplies.length ? `<div class="schedule-replies">${s.quickReplies.map(q => `<span class="schedule-reply-tag">${escapeHtml(q)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="schedule-actions">
            <button class="btn-edit" onclick="openEditModal('${s.id}')">${icon('edit')} Editar</button>
            <button class="btn-cancel" onclick="cancelSchedule('${s.id}')">✕ Cancelar</button>
          </div>
        </div>`;
    }).join('');
  } catch {}
}

async function cancelSchedule(id) {
  if (!confirm('Cancelar este agendamento?')) return;
  await apiFetch('/api/schedules/' + id, { method: 'DELETE' });
  loadPending(); updatePendingBadge();
}

async function clearQueue() {
  const queueLength = runtimeStatus.queueLength || 0;
  const schedules = await (await apiFetch('/api/schedules')).json();
  const total = Math.max(schedules.length, queueLength);
  if (!total) { alert('A fila já está vazia.'); return; }
  if (!confirm(`Limpar ${total} mensagem(ns) da fila?`)) return;
  await apiFetch('/api/schedules', { method: 'DELETE' });
  loadPending(); updatePendingBadge();
}

async function updatePendingBadge() {
  try {
    const schedules = await (await apiFetch('/api/schedules')).json();
    const badge = document.getElementById('badge-pending');
    badge.textContent = schedules.length;
    badge.classList.toggle('visible', schedules.length > 0);
  } catch {}
}

// ─── Modal de edição ──────────────────────────
function setupEditModal() {
  document.getElementById('modal-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-modal')) closeEditModal();
  });

  document.getElementById('edit-btn-add-reply').addEventListener('click', () => {
    const val = document.getElementById('edit-quick-reply-input').value.trim();
    if (!val || editQuickReplies.includes(val) || editQuickReplies.length >= 3) return;
    editQuickReplies.push(val);
    document.getElementById('edit-quick-reply-input').value = '';
    renderQuickReplies('edit-quick-replies-chips', editQuickReplies, i => {
      editQuickReplies.splice(i, 1);
      renderQuickReplies('edit-quick-replies-chips', editQuickReplies, null);
    });
  });

  document.getElementById('btn-save-edit').addEventListener('click', saveEdit);
}

function applyProviderMode() {
  const groupBtn = document.querySelector('.type-btn[data-type="group"]');
  const note = document.getElementById('provider-note');
  const tools = document.querySelector('.recipient-tools');
  const progress = document.getElementById('recipient-progress');
  const input = document.getElementById('recipient-input');
  const label = document.getElementById('recipient-label');

  groupBtn.disabled = false;
  groupBtn.classList.remove('disabled');
  note.style.display = 'block';
  note.innerHTML = 'Escolha o WhatsApp de envio na planilha ou, para grupos, no seletor de conexão. API Oficial envia apenas para contatos; QR Code envia para contatos e grupos.';
  tools.style.display = '';
  progress.style.display = 'none';
  label.textContent = document.getElementById('recipient-type').value === 'group' ? 'Grupo de destino' : 'Contato de destino';
  input.placeholder = document.getElementById('recipient-type').value === 'group' ? 'Digite o nome do grupo...' : 'Digite o nome do contato...';
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

async function openEditModal(id) {
  const s = await (await apiFetch('/api/schedules/' + id)).json();
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-recipient-label').innerHTML = `${icon(s.recipientType === 'contact' ? 'user' : 'users')} ${escapeHtml(s.recipientName)}`;
  document.getElementById('edit-message').value = s.message;
  const dt = new Date(s.scheduledFor);
  document.getElementById('edit-datetime').value = toLocalISO(dt);
  editQuickReplies = [...(s.quickReplies || [])];
  renderQuickReplies('edit-quick-replies-chips', editQuickReplies, i => {
    editQuickReplies.splice(i, 1);
    renderQuickReplies('edit-quick-replies-chips', editQuickReplies, null);
  });
  document.getElementById('edit-feedback').style.display = 'none';
  document.getElementById('edit-modal').style.display = 'flex';
}

function closeEditModal() {
  document.getElementById('edit-modal').style.display = 'none';
}

async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const message = document.getElementById('edit-message').value.trim();
  const datetimeVal = document.getElementById('edit-datetime').value;
  const fb = document.getElementById('edit-feedback');

  if (!message) return showFeedback(fb, 'Digite uma mensagem', 'error');
  if (!datetimeVal) return showFeedback(fb, 'Selecione data e hora', 'error');
  const scheduledFor = new Date(datetimeVal).getTime();
  if (scheduledFor <= Date.now()) return showFeedback(fb, 'A data deve ser no futuro', 'error');

  const current = await (await apiFetch('/api/schedules/' + id)).json();

  const res = await apiFetch('/api/schedules/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipientType: current.recipientType,
      recipientId: current.recipientId,
      recipientName: current.recipientName,
      message, scheduledFor,
      documentPath: current.documentPath,
      documentName: current.documentName,
      quickReplies: [...editQuickReplies]
    })
  });

  if (res.ok) {
    closeEditModal();
    loadPending();
  } else {
    const data = await res.json();
    showFeedback(fb, '❌ ' + data.error, 'error');
  }
}

// ─── Histórico ────────────────────────────────
async function loadLogs() {
  try {
    const logs = await (await apiFetch('/api/logs')).json();
    const list = document.getElementById('logs-list');
    if (logs.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><use href="#i-inbox"/></svg></div><div>Nenhum envio registrado</div></div>`;
      return;
    }
    list.innerHTML = logs.map(l => {
      const dt = new Date(l.sentAt);
      const logIcon = icon(l.recipientType === 'contact' ? 'user' : 'users');
      return `
        <div class="log-item">
          <div class="log-status">${l.success ? '✅' : '❌'}</div>
          <div class="log-info">
            <div class="log-header">
              <span class="log-group">${logIcon} ${escapeHtml(l.recipientName)}</span>
              <div class="log-header-side">
                <button class="btn-log-resend" data-log-id="${l.id}">${l.success ? 'Reenviar' : 'Enviar agora'}</button>
                <button class="btn-log-copy" data-msg="${escapeHtml(l.message)}">${icon('copy')} Copiar</button>
                ${!l.success ? `<button class="btn-log-requeue" data-log-id="${l.id}" style="background:rgba(100,120,220,.15);border:1px solid rgba(100,120,220,.35);color:#a0aaee;border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer;">↺ Voltar à fila</button>` : ''}
                <span class="log-date">${formatDate(dt)} ${formatTime(dt)}</span>
              </div>
            </div>
            <div class="log-msg">${escapeHtml(l.message)}</div>
            ${l.error ? `<div class="log-error">${escapeHtml(l.error)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.btn-log-resend').forEach(btn => {
      btn.addEventListener('click', () => resendLogNow(btn));
    });
    list.querySelectorAll('.btn-log-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.msg);
        const orig = btn.textContent;
        btn.textContent = '✓ Copiado';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });
    list.querySelectorAll('.btn-log-requeue').forEach(btn => {
      btn.addEventListener('click', () => requeueSingleLog(btn));
    });
  } catch {}
}

async function requeueSingleLog(btn) {
  const id = btn.dataset.logId;
  if (!id) return;
  btn.disabled = true;
  btn.textContent = 'Agendando...';
  try {
    const res = await apiFetch(`/api/broadcast/requeue-log/${id}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro');
    btn.textContent = '✓ Na fila';
    btn.style.color = '#6dbf7e';
  } catch(e) {
    btn.disabled = false;
    btn.textContent = '↺ Voltar à fila';
    alert(e.message);
  }
}

async function resendLogNow(button) {
  const id = button.dataset.logId;
  if (!id) return;

  button.disabled = true;
  button.textContent = 'Enviando...';

  try {
    const res = await apiFetch(`/api/logs/${id}/resend-now`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao reenviar');
    await loadLogs();
    await loadReports();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Enviar agora';
    alert(error.message);
  }
}

// ─── Chat ao vivo (WhatsApp Web style) ────────────────────────────────────────

let _allConvs = [];
let _optimisticChatMessages = [];
let _chatRenderKey = '';
let _activeCrmCard = null; // CRM card selecionado no chat ao vivo
let _activeChatConnection = null; // null = todos (filtro da lista)
let _selectedConns = new Set(); // multi-selecao do filtro de conexao (vazio = todas)
function connSelectionPasses(cid) {
  cid = cid || 'web';
  if (_userDefaultConnectionId) return cid === _userDefaultConnectionId;
  return _selectedConns.size === 0 || _selectedConns.has(cid);
}
let _activeChatConvConnection = null; // conexão ativa para ENVIAR na conversa aberta
let _chatGroupConnId = 'groups'; // socket selecionado manualmente para envio em grupo
let _userDefaultConnectionId = null; // conexão padrão do usuário logado (null = admin vê tudo)
let _userBroadcastConnectionId = null; // conexão de disparo do usuário logado (null = sem restrição)
let _userPersonalWaba = null; // { phoneNumberId, displayPhone, connected }
let _connectionPhones = {}; // { web: '5511999990000', web2: '...', cloud1: '...', ... }

const CONNECTION_LABELS = {
  web:    { label: 'QR Code 1', color: '#25d366' },
  web2:   { label: 'QR Code 2', color: '#00a884' },
  web3:   { label: 'QR Code 3', color: '#ff6b35' },
  cloud1: { label: 'API Oficial 1', color: '#0084ff' },
  cloud2: { label: 'API Oficial 2', color: '#7c4dff' },
  cloud3: { label: 'API Oficial 3', color: '#ff9500' },
  lite: { label: 'WhatsApp Lite', color: '#1877f2' },
  lite2: { label: 'WhatsApp Lite 2', color: '#7c3aed' },
  groups: { label: 'Grupos', color: '#ffd43b' },
};

let _chatDirectConnId = null;

function updateDirectConnSelector(contactId) {
  const bar = document.getElementById('chat-direct-conn-bar');
  const sel = document.getElementById('chat-direct-conn-select');
  if (!bar || !sel) return;
  bar.style.display = 'none'; return; // Enviar via removido (envio automatico pela conexao da conversa)
  const isDirect = !(contactId || '').endsWith('@g.us');
  bar.style.display = isDirect ? 'flex' : 'none';
  if (!isDirect) return;
  const ids = ['web', 'web2', 'web3', 'cloud1', 'cloud2', 'cloud3'];
  const options = ids.map(id => {
    const conn = runtimeStatus?.connections?.[id];
    const connected = conn?.connected;
    const phone = conn?.phone ? ` — ${conn.phone}` : '';
    const label = (CONNECTION_LABELS[id]?.label || id) + phone + (connected ? '' : ' (desconectado)');
    return { id, label, connected };
  }).filter(o => o.connected || ids.indexOf(o.id) < 3);
  if (typeof liteIsSulsolar === 'function' && liteIsSulsolar() && window._liteConnInfo && window._liteConnInfo.connected) { options.push({ id: 'lite', label: 'WhatsApp Lite' + (window._liteConnInfo.phone ? ' \u2014 ' + window._liteConnInfo.phone : ''), connected: true }); }
  sel.innerHTML = options.map(o =>
    `<option value="${o.id}" ${!o.connected ? 'style="color:#aaa"' : ''}>${o.label}</option>`
  ).join('');
  // Preferência salva por contato no localStorage
  const lsKey = `chatDirectConn_${contactId}`;
  const saved = localStorage.getItem(lsKey);
  const savedValid = saved && options.find(o => o.id === saved);
  if (savedValid) {
    _chatDirectConnId = saved;
  } else if (!_chatDirectConnId || !options.find(o => o.id === _chatDirectConnId)) {
    _chatDirectConnId = options.find(o => o.connected)?.id || 'web';
  }
  sel.value = _chatDirectConnId;
  sel.onchange = () => {
    _chatDirectConnId = sel.value;
    localStorage.setItem(lsKey, sel.value);
  };
}

function updateGroupConnSelector(contactId) {
  const bar = document.getElementById('chat-group-conn-bar');
  const sel = document.getElementById('chat-group-conn-select');
  if (!bar || !sel) return;
  bar.style.display = 'none'; return; // Enviar via removido
  const isGroup = (contactId || '').endsWith('@g.us');
  bar.style.display = isGroup ? 'flex' : 'none';
  if (!isGroup) return;
  const baileysSockets = ['groups', 'web', 'web2', 'web3'];
  const options = baileysSockets.map(id => {
    const conn = runtimeStatus?.connections?.[id];
    const connected = conn?.connected;
    const phone = conn?.phone ? ` — ${conn.phone}` : '';
    const label = (CONNECTION_LABELS[id]?.label || id) + phone + (connected ? '' : ' (desconectado)');
    return { id, label, connected };
  });
  sel.innerHTML = options.map(o =>
    `<option value="${o.id}" ${!o.connected ? 'style="color:#aaa"' : ''}>${o.label}</option>`
  ).join('');
  // Preferência salva por grupo no localStorage
  const lsKey = `chatGroupConn_${contactId}`;
  const saved = localStorage.getItem(lsKey);
  const savedValid = saved && options.find(o => o.id === saved);
  if (savedValid) {
    _chatGroupConnId = saved;
  } else if (!options.find(o => o.id === _chatGroupConnId)) {
    _chatGroupConnId = options.find(o => o.connected)?.id || 'groups';
  }
  sel.value = _chatGroupConnId;
  sel.onchange = () => {
    _chatGroupConnId = sel.value;
    localStorage.setItem(lsKey, sel.value);
  };
}

function setupChat() {
  const sendBtn = document.getElementById('chat-send-btn');
  const input   = document.getElementById('chat-input');

  sendBtn?.addEventListener('click', sendChatMessage);
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  // Attach button
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.style.display = 'none';
  fileInput.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip';
  const attachBtn = document.createElement('button');
  attachBtn.className = 'wa-header-btn';
  attachBtn.title = 'Anexar arquivo';
  attachBtn.style.cssText = 'width:42px;height:42px;border-radius:50%;background:#2a3942;flex-shrink:0;';
  attachBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8696a0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) sendChatMedia(fileInput.files[0]); fileInput.value = ''; });
  const inputArea = document.getElementById('chat-input-area');
  if (inputArea) {
    inputArea.insertBefore(fileInput, inputArea.firstChild);
    inputArea.insertBefore(attachBtn, inputArea.firstChild);
  }

  // Emoji picker button
  const emojiToggleBtn = document.createElement('button');
  emojiToggleBtn.className = 'wa-header-btn';
  emojiToggleBtn.title = 'Emojis';
  emojiToggleBtn.style.cssText = 'width:42px;height:42px;border-radius:50%;background:#2a3942;flex-shrink:0;font-size:18px;line-height:1;';
  emojiToggleBtn.textContent = '😊';
  emojiToggleBtn.addEventListener('click', e => { e.stopPropagation(); toggleEmojiPicker(); });
  if (inputArea) inputArea.insertBefore(emojiToggleBtn, inputArea.firstChild);

  // Microphone (live audio recording)
  _chatMic = setupMicRecorder({ inputArea, inputEl: input, sendBtn, sendMediaFn: sendChatMedia }) || _chatMic;

  // Paste image from clipboard
  input?.addEventListener('paste', e => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) sendChatMedia(file);
        return;
      }
    }
  });

  // Reaction picker + reply (event delegation on message container)
  document.getElementById('chat-messages')?.addEventListener('click', e => {
    const reactBtn = e.target.closest('.msg-reaction-btn');
    if (reactBtn) { e.stopPropagation(); showReactionPicker(reactBtn); return; }
    const replyBtn = e.target.closest('.msg-reply-btn');
    if (replyBtn) {
      e.stopPropagation();
      const msgEl = replyBtn.closest('.chat-msg');
      const m = _currentChatMessages.find(x => String(x.id) === replyBtn.dataset.msgId);
      if (m) setChatReplyTo(m.id, quoteSnippet(m), m.direction);
    }
  });

  // Reply bar (injected above the input)
  const chatReplyBar = document.createElement('div');
  chatReplyBar.className = 'chat-reply-bar';
  chatReplyBar.id = 'chat-reply-bar';
  chatReplyBar.innerHTML = `<span class="chat-reply-bar-text" id="chat-reply-bar-text"></span><button class="chat-reply-bar-close" id="chat-reply-bar-close" title="Cancelar">✕</button>`;
  document.getElementById('chat-input-area')?.insertAdjacentElement('beforebegin', chatReplyBar);
  document.getElementById('chat-reply-bar-close')?.addEventListener('click', clearChatReplyTo);

  // Close emoji/reaction on outside click
  document.addEventListener('click', () => {
    document.getElementById('emoji-picker-panel')?.classList.remove('open');
    document.getElementById('reaction-picker')?.classList.remove('open');
  });

  // Search filter
  document.getElementById('wa-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    let filtered = _allConvs;
    const _effectiveConnFilter = _userDefaultConnectionId || _activeChatConnection;
    if (_effectiveConnFilter) filtered = filtered.filter(c => (c.connectionId || 'web') === _effectiveConnFilter);
    if (q) filtered = filtered.filter(c => (c.contactName || '').toLowerCase().includes(q));
    renderConversations(filtered);
  });

  document.getElementById('wa-group-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const groups = _allConvs.filter(c => (c.contactId || '').includes('@g.us'));
    const filtered = q ? groups.filter(c => (c.contactName || '').toLowerCase().includes(q)) : groups;
    renderGroupConversations(filtered);
  });

  document.getElementById('btn-reset-live-chat')?.addEventListener('click', resetLiveChatSync);
  document.getElementById('btn-rename-chat-contact')?.addEventListener('click', openEditChatContactModal);
  document.getElementById('edit-chat-contact-modal-close')?.addEventListener('click', () => { document.getElementById('edit-chat-contact-modal').style.display = 'none'; });
  document.getElementById('btn-save-chat-contact')?.addEventListener('click', saveEditChatContact);
}

function openEditChatContactModal() {
  if (!selectedChatContactId) return;
  const currentName = document.getElementById('wa-convo-name')?.textContent || '';
  const currentPhone = document.getElementById('wa-convo-phone')?.textContent || selectedChatContactId.replace('@s.whatsapp.net','').replace('@lid','').replace('@c.us','');
  document.getElementById('edit-chat-contact-name').value = looksLikeWhatsappIdentifier(currentName) ? '' : currentName;
  document.getElementById('edit-chat-contact-phone').value = currentPhone.replace(/\D/g, '');
  document.getElementById('edit-chat-contact-feedback').style.display = 'none';
  document.getElementById('edit-chat-contact-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('edit-chat-contact-name').focus(), 50);
}

async function saveEditChatContact() {
  if (!selectedChatContactId) return;
  const name = document.getElementById('edit-chat-contact-name').value.trim();
  const phone = document.getElementById('edit-chat-contact-phone').value.replace(/\D/g, '');
  const fb = document.getElementById('edit-chat-contact-feedback');
  if (!name && !phone) { fb.style.display='block'; fb.style.color='#ff6b6b'; fb.textContent='Preencha ao menos o nome ou telefone.'; return; }
  fb.style.display = 'none';
  try {
    const res = await apiFetch(`/api/chat/${encodeURIComponent(selectedChatContactId)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { fb.style.display='block'; fb.style.color='#ff6b6b'; fb.textContent=data.error||'Erro ao salvar'; return; }
    if (name) {
      document.getElementById('wa-convo-name').textContent = name;
      _allConvs = _allConvs.map(c => c.contactId === selectedChatContactId ? { ...c, contactName: name } : c);
    }
    if (phone && document.getElementById('wa-convo-phone')) {
      document.getElementById('wa-convo-phone').textContent = phone;
    }
    renderConversations(_allConvs);
    document.getElementById('edit-chat-contact-modal').style.display = 'none';
  } catch(e) {
    fb.style.display='block'; fb.style.color='#ff6b6b'; fb.textContent=e.message;
  }
}

async function resetLiveChatSync() {
  if (!confirm('Resetar o Chat ao vivo e sincronizar as conversas novamente? O CRM e os agendamentos não serão apagados.')) return;
  const btn = document.getElementById('btn-reset-live-chat');
  btn.disabled = true;
  btn.classList.add('spinning');
  selectedChatContactId = null;
  _chatRenderKey = '';
  _optimisticChatMessages = [];
  closeAiResult();
  updateAiChatbotUI(false);
  renderAiToolbar();
  chatSyncStartedAt = Date.now();
  localStorage.setItem('wa-chat-sync-started-at', String(chatSyncStartedAt));
  document.getElementById('wa-convo').style.display = 'none';
  document.getElementById('wa-welcome').style.display = 'flex';
  renderLiveChatSyncNotice('Reiniciando WhatsApp e preparando sincronização...');
  try {
    const res = await apiFetch('/api/chat/reset-sync', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro ao sincronizar');
    setTimeout(loadConversations, 2500);
  } catch (e) {
    localStorage.removeItem('wa-chat-sync-started-at');
    chatSyncStartedAt = 0;
    renderLiveChatSyncNotice(e.message || 'Erro ao sincronizar', false);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.classList.remove('spinning'); }, 2500);
  }
}

function isLiveChatSyncing() {
  return chatSyncStartedAt && Date.now() - chatSyncStartedAt < 3 * 60 * 1000;
}

function finishLiveChatSync() {
  chatSyncStartedAt = 0;
  localStorage.removeItem('wa-chat-sync-started-at');
}

function renderLiveChatSyncNotice(message, spinning = true) {
  const list = document.getElementById('chat-conv-list');
  const status = document.getElementById('wa-sidebar-status');
  if (status) status.textContent = message;
  if (!list) return;
  list.innerHTML = `<div class="wa-sync-empty">${spinning ? '<div class="spinner"></div>' : ''}<div>${escapeHtml(message)}</div></div>`;
}

function updateLiveChatSyncNotice() {
  if (!isLiveChatSyncing()) return;
  const elapsed = Date.now() - chatSyncStartedAt;
  if (!hasAnyConnectedChannel()) {
    renderLiveChatSyncNotice(runtimeStatus.bootMessage || 'Reconectando WhatsApp...');
  } else if (elapsed < 45000) {
    renderLiveChatSyncNotice('WhatsApp conectado. Sincronizando conversas...');
  } else {
    renderLiveChatSyncNotice('Conectado. O WhatsApp ainda não enviou histórico; novas mensagens vão aparecer aqui.', false);
  }
}

function startChatPolling() {
  loadConversations();
  if (selectedChatContactId) loadChatMessages(selectedChatContactId);
  stopChatPolling();
  chatPollingTimer = setInterval(() => {
    loadConversations();
  }, CHAT_CONVERSATIONS_POLL_MS);
  chatMessagesPollingTimer = setInterval(() => {
    if (selectedChatContactId) loadChatMessages(selectedChatContactId);
  }, CHAT_MESSAGES_POLL_MS);
}

function stopChatPolling() {
  if (chatPollingTimer) { clearInterval(chatPollingTimer); chatPollingTimer = null; }
  if (chatMessagesPollingTimer) { clearInterval(chatMessagesPollingTimer); chatMessagesPollingTimer = null; }
}

function _connPhone(id){ const conns=(typeof runtimeStatus!=='undefined'&&runtimeStatus&&runtimeStatus.connections)||{}; let p=(conns[id]&&conns[id].phone)||(id==='lite'&&window._liteConnInfo?window._liteConnInfo.phone:(id==='lite2'&&window._lite2ConnInfo?window._lite2ConnInfo.phone:''))||''; p=String(p).replace(/\D/g,''); return p?' \u00b7 '+p.slice(-4):''; }
function _connLabel(id){ return ((CONNECTION_LABELS[id]&&CONNECTION_LABELS[id].label)||id)+_connPhone(id); }
function _connColor(id){ return (CONNECTION_LABELS[id]&&CONNECTION_LABELS[id].color)||'#8696a0'; }
function connFilterLabel(){ if(_selectedConns.size===0) return 'Todas as conexoes'; if(_selectedConns.size===1) return _connLabel([..._selectedConns][0]); return _selectedConns.size+' conexoes'; }
function renderConnectionFilter() {
  const el = document.getElementById('chat-connection-filter');
  if (!el) return;
  if (_userDefaultConnectionId) { el.innerHTML=''; return; }
  const present = new Set((_allConvs||[]).map(c=>c.connectionId||'web'));
  const conns = (typeof runtimeStatus!=='undefined'&&runtimeStatus&&runtimeStatus.connections)||{};
  ['web','web2','web3','cloud1','cloud2','cloud3','lite','lite2','groups'].forEach(id=>{ if(conns[id]&&conns[id].connected) present.add(id); });
  if (window._liteConnInfo && window._liteConnInfo.connected) present.add('lite');
  if (window._lite2ConnInfo && window._lite2ConnInfo.connected) present.add('lite2');
  const ids=[...present];
  if (ids.length<=1) { el.innerHTML=''; return; }
  [..._selectedConns].forEach(id=>{ if(!present.has(id)) _selectedConns.delete(id); });
  const rows = ids.map(id=>{
    const checked=_selectedConns.has(id)?'checked':'';
    const c=_connColor(id);
    return '<label style="display:flex;align-items:center;gap:9px;padding:8px 12px;cursor:pointer;font-size:12.5px;color:var(--text);white-space:nowrap;">'+
      '<input type="checkbox" '+checked+' onchange="toggleConnSelection(\''+id+'\', this.checked)" style="accent-color:'+c+';width:15px;height:15px;cursor:pointer;">'+
      '<span style="width:8px;height:8px;border-radius:50%;background:'+c+';flex:none;"></span>'+escapeHtml(_connLabel(id))+'</label>';
  }).join('');
  const _wo = !!(document.getElementById('conn-dropdown') && document.getElementById('conn-dropdown').style.display === 'block');
  el.innerHTML = '<div style="position:relative;display:inline-block;">'+
    '<button type="button" onclick="toggleConnDropdown(event)" style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;">'+
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>'+
      '<span id="conn-filter-label">'+escapeHtml(connFilterLabel())+'</span>'+
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'+
    '</button>'+
    '<div id="conn-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:60;background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px 0;">'+rows+'</div>'+
  '</div>';
  if (_wo) { const _d = document.getElementById('conn-dropdown'); if (_d) _d.style.display = 'block'; }
}
function toggleConnDropdown(e){ if(e){ e.stopPropagation(); e.preventDefault(); } const d=document.getElementById('conn-dropdown'); if(d) d.style.display=(d.style.display==='block')?'none':'block'; }
function toggleConnSelection(id, checked){ if(checked===undefined) checked=!_selectedConns.has(id); if(checked) _selectedConns.add(id); else _selectedConns.delete(id); const lbl=document.getElementById('conn-filter-label'); if(lbl) lbl.textContent=connFilterLabel(); renderConversations(_allConvs); }
function clearConnSelection(){ _selectedConns.clear(); renderConnectionFilter(); renderConversations(_allConvs); }
function setActiveChatConnection(connId){ _selectedConns = connId?new Set([connId]):new Set(); renderConnectionFilter(); renderConversations(_allConvs); }

async function loadConversations() {
  if (chatConversationsLoading) return;
  chatConversationsLoading = true;
  try {
    const convs = await (await apiFetch('/api/chat')).json();
    _allConvs = convs;
    const unread = convs.filter(c => c.direction === 'in' && !(c.contactId || '').includes('@g.us')).length;
    const badge = document.getElementById('badge-chat');
    badge.textContent = unread;
    badge.classList.toggle('visible', unread > 0);
    // Marcar cards CRM com nova mensagem (última msg recebida nos últimos 30min)
    const thirtyMin = Date.now() - 30 * 60 * 1000;
    let crmUnreadChanged = false;
    convs.filter(c => c.direction === 'in' && c.timestamp > thirtyMin).forEach(conv => {
      const jidPhone = String(conv.contactId || '').replace(/@.*$/, '').replace(/\D/g, '');
      const match = crmCards.find(card => {
        if (card.whatsappId === conv.contactId) return true;
        const p = (card.phone || '').replace(/\D/g, '');
        const w = (card.whatsapp || '').replace(/\D/g, '');
        const mt = (x) => x && jidPhone && (x === jidPhone || x.endsWith(jidPhone) || jidPhone.endsWith(x));
        return mt(p) || mt(w);
      });
      if (match && !crmUnreadIds.has(match.id)) { crmUnreadIds.add(match.id); crmUnreadChanged = true; }
    });
    if (crmUnreadChanged) { localStorage.setItem('crm-unread', JSON.stringify([...crmUnreadIds])); renderCrmBoard(); }

    if (convs.length && isLiveChatSyncing()) finishLiveChatSync();
    if (!convs.length && isLiveChatSyncing()) {
      if (hasAnyConnectedChannel()) {
        apiFetch('/api/chat/sync-groups', { method: 'POST' }).then(() => setTimeout(loadConversations, 1200)).catch(() => {});
      }
      updateLiveChatSyncNotice();
      return;
    }

    renderConnectionFilter();
    const q = document.getElementById('wa-search')?.value?.toLowerCase() || '';
    let filtered = convs;
    const _effectiveConnFilter = _userDefaultConnectionId || _activeChatConnection;
    if (_effectiveConnFilter) filtered = filtered.filter(c => (c.connectionId || 'web') === _effectiveConnFilter);
    if (q) filtered = filtered.filter(c => (c.contactName || '').toLowerCase().includes(q));
    renderConversations(filtered);
    const status = document.getElementById('wa-sidebar-status');
    const directCount = convs.filter(c => !(c.contactId || '').includes('@g.us')).length;
    if (status) status.textContent = directCount ? `${directCount} conversa${directCount !== 1 ? 's' : ''}` : 'Sem conversas 1:1';
  } catch {
    if (isLiveChatSyncing()) renderLiveChatSyncNotice('Aguardando o servidor voltar...');
  } finally {
    chatConversationsLoading = false;
  }
}

async function deleteChatConversation() {
  if (!selectedChatContactId) return;
  const name = document.getElementById('wa-convo-name')?.textContent || 'esta conversa';
  if (!confirm(`Apagar todo o histórico de mensagens com "${name}"? Isso não pode ser desfeito. O card do CRM (se houver) não será apagado, só as mensagens.`)) return;
  try {
    await apiFetch(`/api/chat/${encodeURIComponent(selectedChatContactId)}`, { method: 'DELETE' });
    _msgCache.delete(selectedChatContactId);
    _allConvs = _allConvs.filter(c => c.contactId !== selectedChatContactId);
    selectedChatContactId = null;
    document.getElementById('wa-convo').style.display = 'none';
    document.getElementById('wa-welcome').style.display = 'flex';
    renderConversations(_allConvs);
    loadConversations();
  } catch (e) {
    alert('Erro ao apagar conversa: ' + e.message);
  }
}

function getConversationById(contactId) {
  return _allConvs.find(c => c.contactId === contactId) || null;
}

function extractPhoneFromWhatsappId(whatsappId) {
  const id = String(whatsappId || '');
  if (id.endsWith('@g.us') || id.endsWith('@lid')) return '';
  const digits = id.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

function looksLikeWhatsappIdentifier(name) {
  const value = String(name || '').trim();
  if (!value) return true;
  if (/@(s\.whatsapp\.net|c\.us|g\.us|lid)$/.test(value)) return true;
  return /^\d{10,}$/.test(value);
}

const _GENERIC_NAMES = new Set(['contato', 'contact', 'você', 'user', 'unknown', 'sem nome', '(sem nome)']);

function cleanChatDisplayName(name, contactId, fallback = '') {
  const value = String(name || '').trim();

  // 1. Real name (not a JID, not a generic placeholder) → use it
  if (value && !looksLikeWhatsappIdentifier(value) && !_GENERIC_NAMES.has(value.toLowerCase())) return value;

  // 2. Phone extracted from contactId (@s.whatsapp.net / @c.us)
  const phone = extractPhoneFromWhatsappId(contactId);
  if (phone) return phone;

  // 3. Stored name is a plausible phone number (≤13 digits)
  if (value && /^\d{7,13}$/.test(value)) return value;

  // 4. Last resort: strip the JID suffix from contactId and show the bare ID
  //    (LID number or whatever was stored — better than blank)
  const bare = String(contactId || '')
    .replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '')
    .replace(/@lid$/, '').replace(/@g\.us$/, '');
  return bare || fallback;
}

const ICON_VOICE_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_VOICE_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

function buildChatMediaHtml(m) {
  if (!m.mediaUrl) return '';
  const url = escapeHtml(m.mediaUrl);
  const name = escapeHtml(m.mediaName || 'arquivo');
  const margin = m.text ? '6px' : '0';
  const isGif = /\.gif($|\?)/i.test(m.mediaUrl);
  const mediaWidth = isGif ? 100 : 200;
  if (m.mediaType === 'audio' || /\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(m.mediaUrl)) {
    return `<div class="voice-msg" style="margin-bottom:${margin};">
      <audio preload="metadata" src="${url}"></audio>
      <button type="button" class="voice-msg-play" title="Reproduzir">${ICON_VOICE_PLAY}</button>
      <div class="voice-msg-track"><div class="voice-msg-progress"></div></div>
      <span class="voice-msg-time">0:00</span>
    </div>`;
  }
  if (m.mediaType === 'video' || /\.(mp4|webm|mov)$/i.test(m.mediaUrl)) {
    return `<video controls src="${url}" style="max-width:${mediaWidth}px;max-height:${mediaWidth}px;width:auto;height:auto;border-radius:6px;display:block;margin-bottom:${margin};"></video>`;
  }
  if (m.mediaType === 'document') {
    return `<a class="chat-file-link" href="${url}" target="_blank" rel="noopener">${icon('paperclip')} ${name}</a>`;
  }
  return `<img src="${url}" style="max-width:${mediaWidth}px;max-height:${mediaWidth}px;width:auto;height:auto;border-radius:6px;display:block;margin-bottom:${margin};cursor:pointer;object-fit:contain;" onclick="window.open('${url}','_blank')">`;
}

function wireVoiceMessages(container) {
  if (!container) return;
  const fmtTime = s => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };
  container.querySelectorAll('.voice-msg').forEach(el => {
    if (el._wired) return;
    el._wired = true;
    const audio = el.querySelector('audio');
    const playBtn = el.querySelector('.voice-msg-play');
    const track = el.querySelector('.voice-msg-track');
    const progress = el.querySelector('.voice-msg-progress');
    const timeEl = el.querySelector('.voice-msg-time');
    if (!audio || !playBtn) return;
    audio.addEventListener('loadedmetadata', () => { if (isFinite(audio.duration)) timeEl.textContent = fmtTime(audio.duration); });
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) progress.style.width = (audio.currentTime / audio.duration * 100) + '%';
      timeEl.textContent = fmtTime(audio.paused && !audio.currentTime ? audio.duration : audio.currentTime);
    });
    audio.addEventListener('play', () => {
      document.querySelectorAll('.voice-msg audio').forEach(a => { if (a !== audio && !a.paused) a.pause(); });
      playBtn.innerHTML = ICON_VOICE_PAUSE;
    });
    audio.addEventListener('pause', () => { playBtn.innerHTML = ICON_VOICE_PLAY; });
    audio.addEventListener('ended', () => { playBtn.innerHTML = ICON_VOICE_PLAY; progress.style.width = '0%'; });
    playBtn.addEventListener('click', () => { audio.paused ? audio.play().catch(() => {}) : audio.pause(); });
    track?.addEventListener('click', e => {
      if (!audio.duration) return;
      const rect = track.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * audio.duration;
    });
  });
}

// JID helpers (frontend equivalents of server-side utils)
function normalizeJidFE(jid) { return String(jid || '').replace('@c.us', '@s.whatsapp.net'); }
function isLidJidFE(jid) { return String(jid || '').endsWith('@lid'); }

// Best sendable JID for a CRM card (prefers phone over @lid)
function getCardSendJid(card) {
  const wid = String(card.whatsappId || '');
  if (wid && !isLidJidFE(wid) && wid.indexOf('@') >= 0) return normalizeJidFE(wid);
  const wa = (card.whatsapp || '').replace(/\D/g, '');
  if (wa) return `${wa}@s.whatsapp.net`;
  const phone = (card.phone || '').replace(/\D/g, '');
  if (phone) return `${phone}@s.whatsapp.net`;
  if (wid) return normalizeJidFE(wid); // @lid fallback
  return null;
}

const LABEL_COLORS = { 'Em andamento': '#ffd43b', 'Não respondeu': '#ff6b6b', 'Finalizado': '#69db7c' };

function updateChatCrmLabel(card) {
  const el = document.getElementById('wa-crm-label-badge');
  if (!el) return;
  const lbl = (Array.isArray(card?.labels) ? card.labels[0] : card?.label) || null;
  const lc = lbl ? (LABEL_COLORS[lbl] || '#aaa') : null;
  if (lc) {
    el.style.display = 'inline-block';
    el.innerHTML = `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${lc}22;color:${lc};border:1px solid ${lc}44;">${escapeHtml(lbl)}</span>`;
  } else {
    el.style.display = 'none';
    el.innerHTML = '';
  }
}

// Render a CRM card as a conversation list item (left panel)
function renderCrmConvItem(card, conv) {
  const displayName = card.contactName || conv?.contactName || '(sem nome)';
  const rawId = card.whatsappId || card.phone || card.id || '';
  const initials = displayName.split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const hue = [...String(rawId)].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const avatarStyle = `width:46px;height:46px;border-radius:50%;flex-shrink:0;object-fit:cover;`;
  const avatarDiv = `<div class="def-avatar" style="${avatarStyle}background:hsl(${hue},40%,38%);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;"><svg viewBox="0 0 24 24" fill="#fff" style="width:56%;height:56%;opacity:.92"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 5.33V21h16v-1.67C20 16.67 17.33 14 12 14z"/></svg></div>`;
  const avatar = conv?.profilePicUrl
    ? `<img src="${conv.profilePicUrl}" style="${avatarStyle}background:#dfe2e6;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${avatarDiv.replace('display:flex','display:none')}`
    : avatarDiv;
  const lastMsg = conv
    ? (conv.direction === 'out' ? `<span style="color:#00a884;">Você: </span>${escapeHtml(conv.lastMessage || '')}` : escapeHtml(conv.lastMessage || ''))
    : `<span style="color:var(--text3);font-style:italic;">Sem mensagens</span>`;
  const timeStr = conv?.lastAt ? formatTime(new Date(conv.lastAt)) : '';
  const cardLabel = (Array.isArray(card.labels) ? card.labels[0] : card.label) || null;
  const lc = cardLabel ? (LABEL_COLORS[cardLabel] || '#aaa') : null;
  const labelBadge = lc ? `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:${lc}22;color:${lc};border:1px solid ${lc}44;">${escapeHtml(cardLabel)}</span>` : '';
  const connId = conv?.connectionId || '';
  const badgeColor = connId.startsWith('cloud') ? '#ff9500' : '#25d366';
  const phone = _connectionPhones[connId] || '';
  const badgeText = connId ? (phone ? phone.slice(-4) : (CONNECTION_LABELS[connId]?.label || connId)) : '';
  const connBadge = badgeText ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}44;">${escapeHtml(badgeText)}</span>` : '';
  const sendJid = getCardSendJid(card) || '';
  const isActive = sendJid && (sendJid === selectedChatContactId || (card.whatsappId && normalizeJidFE(card.whatsappId) === selectedChatContactId));
  const isUnread = crmUnreadIds.has(card.id);
  return `<div class="conv-item${isActive ? ' active' : ''}${isUnread ? ' crm-conv-unread' : ''}" data-id="${escapeHtml(sendJid)}" data-name="${escapeHtml(displayName)}" data-card-id="${escapeHtml(card.id)}">
    ${avatar}
    <div class="conv-item-info">
      <div class="conv-item-header"><div class="conv-name">${escapeHtml(displayName)}</div><div class="conv-time">${timeStr}</div></div>
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:1px;">${connBadge}${labelBadge}</div>
      <div class="conv-last">${lastMsg}</div>
    </div>
  </div>`;
}

async function selectCrmConversation(card) {
  const contactId = getCardSendJid(card);
  if (!contactId) return;
  _activeCrmCard = card;
  if (crmUnreadIds.has(card.id)) {
    crmUnreadIds.delete(card.id);
    localStorage.setItem('crm-unread', JSON.stringify([...crmUnreadIds]));
    apiFetch(`/api/crm/cards/${card.id}/mark-read`, { method: 'POST' }).catch(() => {});
    const el = document.querySelector(`.conv-item[data-card-id="${card.id}"]`);
    if (el) el.classList.remove('crm-conv-unread');
  }
  await selectConversation(contactId, card.contactName);
}

function renderConvItem(c) {
  const displayName = cleanChatDisplayName(c.contactName, c.contactId);
  const shownName = displayName || '—';
  const initials = displayName ? displayName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() : '?';
  const hue = [...(c.contactId || '')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const avatarStyle = `width:46px;height:46px;border-radius:50%;flex-shrink:0;object-fit:cover;`;
  const avatarDiv = `<div class="def-avatar" style="${avatarStyle}background:hsl(${hue},40%,38%);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;"><svg viewBox="0 0 24 24" fill="#fff" style="width:56%;height:56%;opacity:.92"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 5.33V21h16v-1.67C20 16.67 17.33 14 12 14z"/></svg></div>`;
  const avatar = c.profilePicUrl
    ? `<img src="${c.profilePicUrl}" style="${avatarStyle}background:#dfe2e6;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${avatarDiv.replace('display:flex','display:none')}`
    : avatarDiv;
  const lastMsg = c.direction === 'out'
    ? `<span style="color:#00a884;">Você: </span>${escapeHtml(c.lastMessage || '')}`
    : escapeHtml(c.lastMessage || '');
  const timeStr = c.lastAt ? formatTime(new Date(c.lastAt)) : '';
  const connId = c.connectionId || 'web';
  const isCloud = connId.startsWith('cloud');
  const badgeColor = isCloud ? '#ff9500' : '#25d366';
  const phone = _connectionPhones[connId] || '';
  const badgeText = phone ? phone.slice(-4) : (CONNECTION_LABELS[connId]?.label || connId);
  const connBadge = `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}44;">${escapeHtml(badgeText)}</span>`;
  const rawId = escapeHtml(c.contactId || '');
  return `<div class="conv-item ${c.contactId === selectedChatContactId ? 'active' : ''}" data-id="${rawId}" data-name="${escapeHtml(displayName || '')}">
    ${avatar}
    <div class="conv-item-info">
      <div class="conv-item-header">
        <div class="conv-name">${escapeHtml(shownName)}</div>
        <div class="conv-time">${timeStr}</div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:1px;">
        ${connBadge}
        <span style="font-size:10px;color:var(--muted, #7a8099);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;">${rawId}</span>
      </div>
      <div class="conv-last">${lastMsg}</div>
    </div>
  </div>`;
}

function renderConversations(convs) {
  const el = document.getElementById('chat-conv-list');
  const directConvs = convs.filter(c => !(c.contactId || '').includes('@g.us'));
  const groupConvs = convs.filter(c => (c.contactId || '').includes('@g.us'));

  // Build CRM-card-based items
  const crmItems = crmCards
    .filter(card => !String(card.whatsappId || '').endsWith('@g.us'))
    .map(card => {
      const sendJid = getCardSendJid(card);
      const cardPhone = (card.phone || '').replace(/\D/g, '');
      const conv = directConvs.find(c => {
        if (!c.contactId) return false;
        const cNorm = normalizeJidFE(c.contactId);
        if (sendJid && cNorm === sendJid) return true;
        if (card.whatsappId && cNorm === normalizeJidFE(card.whatsappId)) return true;
        if (cardPhone) {
          const cDigits = c.contactId.replace(/@.*$/, '').replace(/\D/g, '');
          if (cDigits && (cDigits === cardPhone || cDigits.endsWith(cardPhone) || cardPhone.endsWith(cDigits))) return true;
        }
        return false;
      });
      return { type: 'crm', card, conv, sortKey: conv?.lastAt || conv?.timestamp || 0 };
    });

  // Group convs not already matched to a CRM card
  const crmJids = new Set(crmItems.map(i => getCardSendJid(i.card)).filter(Boolean));
  const groupItems = groupConvs
    .filter(g => !crmJids.has(g.contactId))
    .map(g => ({ type: 'group', conv: g, sortKey: g.lastAt || g.timestamp || 0 }));

  // Apply search + connection filter
  const q = document.getElementById('wa-search')?.value?.toLowerCase() || '';
  const connFilter = _userDefaultConnectionId || _activeChatConnection;

  const filteredCrm = crmItems.filter(({ card, conv }) => {
    if (q && !(card.contactName || '').toLowerCase().includes(q) && !(conv?.contactName || '').toLowerCase().includes(q)) return false;
    if (conv ? !connSelectionPasses(conv.connectionId) : (_userDefaultConnectionId || _selectedConns.size > 0)) return false;
    return true;
  });

  const filteredGroups = groupItems.filter(({ conv }) => {
    if (q && !(conv.contactName || '').toLowerCase().includes(q)) return false;
    if (!connSelectionPasses(conv.connectionId)) return false;
    return true;
  });

  // Merge and sort by recency
  const allItems = [...filteredCrm, ...filteredGroups].sort((a, b) => b.sortKey - a.sortKey);

  if (!allItems.length) {
    el.innerHTML = `<div class="wa-empty">${(crmCards.length || groupConvs.length) ? 'Nenhuma conversa encontrada' : 'Aguardando mensagens...'}</div>`;
  } else {
    el.innerHTML = allItems.map(item =>
      item.type === 'crm' ? renderCrmConvItem(item.card, item.conv) : renderConvItem(item.conv)
    ).join('');
    el.querySelectorAll('.conv-item').forEach(item => {
      item.addEventListener('click', () => {
        const cardId = item.dataset.cardId;
        if (cardId) {
          const card = crmCards.find(c => c.id === cardId);
          if (card) selectCrmConversation(card);
        } else {
          selectConversation(item.dataset.id, item.dataset.name);
        }
      });
    });
  }
}

function renderGroupConversations(groups) {
  // kept for backward compat — no-op if separate list removed
  const el = document.getElementById('chat-group-conv-list');
  if (!el) return;
  el.innerHTML = groups.length ? groups.map(renderConvItem).join('') : '<div class="wa-empty">Nenhum grupo</div>';
  el.querySelectorAll('.conv-item').forEach(item => {
    item.addEventListener('click', () => selectConversation(item.dataset.id, item.dataset.name));
  });
}

async function selectConversation(contactId, contactName) {
  selectedChatContactId = contactId;

  // Show convo panel, hide welcome
  document.getElementById('wa-welcome').style.display = 'none';
  const convo = document.getElementById('wa-convo');
  convo.style.display = 'flex';

  // Update header
  const convoData = getConversationById(contactId);
  const displayName = cleanChatDisplayName(convoData?.contactName || contactName, contactId);
  const initials = (displayName || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const hue = [...(contactId || '')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const avatarEl = document.getElementById('wa-convo-avatar');
  avatarEl.style.background = `hsl(${hue},40%,38%)`;
  avatarEl.classList.toggle('def-avatar', !convoData?.profilePicUrl);
  avatarEl.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff" style="width:56%;height:56%;opacity:.92"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 5.33V21h16v-1.67C20 16.67 17.33 14 12 14z"/></svg>';
  if (convoData?.profilePicUrl) {
    avatarEl.innerHTML = `<img src="${escapeHtml(convoData.profilePicUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.remove()">`;
  }
  document.getElementById('wa-convo-name').textContent = displayName;
  const phoneDisplay = contactId.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@g.us', ' (grupo)').replace('@lid', '');
  document.getElementById('wa-convo-sub').textContent = phoneDisplay;
  const phoneEl = document.getElementById('wa-convo-phone');
  if (phoneEl) phoneEl.textContent = phoneDisplay;
  _activeChatConvConnection = convoData?.connectionId || 'web';
  updateGroupConnSelector(contactId);
  updateDirectConnSelector(contactId);
  // Atualiza badge read-only da conexão ativa
  const connBadgeEl = document.getElementById('wa-conn-badge');
  if (connBadgeEl) {
    const connId = _activeChatConvConnection;
    const isCloud = connId.startsWith('cloud');
    const color = isCloud ? '#ff9500' : (CONNECTION_LABELS[connId]?.color || '#25d366');
    const phone = runtimeStatus?.connections?.[connId]?.phone || '';
    const label = phone ? phone.slice(-4) : (CONNECTION_LABELS[connId]?.label || connId);
    connBadgeEl.innerHTML = `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${color}22;color:${color};border:1px solid ${color}44;">📱 ${escapeHtml(label)}</span>`;
  }

  _chatRenderKey = '';
  document.getElementById('chat-messages').innerHTML = '<div class="chat-empty-area"><div class="spinner"></div></div>';
  document.getElementById('chat-input').focus();

  // CRM label badge
  updateChatCrmLabel(_activeCrmCard);

  // Mark active in list
  document.querySelectorAll('.conv-item').forEach(i => i.classList.toggle('active', i.dataset.id === contactId || i.dataset.cardId === _activeCrmCard?.id));

  closeAiResult();
  updateAiChatbotUI(false);
  renderAiToolbar();
  loadAiChatbotStatus(contactId);

  await loadChatMessages(contactId);
}

async function sendChatMessage() {
  if (_chatMic?.isRecording()) { await _chatMic.finishAndSend(); return; }
  const input = document.getElementById('chat-input');
  const typed = input.value.trim();
  if (!typed || !selectedChatContactId) return;
  const text = _chatReplyTo ? `> ${_chatReplyTo.text}\n\n${typed}` : typed;
  const btn = document.getElementById('chat-send-btn');
  const tempMsg = { id: `tmp-${Date.now()}`, direction: 'out', contactId: selectedChatContactId, text, timestamp: Date.now(), pending: true };
  _optimisticChatMessages.push(tempMsg);
  input.value = '';
  input.style.height = 'auto';
  clearChatReplyTo();
  btn.disabled = true;
  btn.textContent = '...';
  renderChatMessages(_currentChatMessages);
  try {
    const isGroupChat = (selectedChatContactId || '').endsWith('@g.us');
    const connId = isGroupChat ? _chatGroupConnId : (_chatDirectConnId || undefined);
    const res = await apiFetch(`/api/chat/${encodeURIComponent(selectedChatContactId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, connectionId: connId })
    });
    const data = await readApiPayload(res);
    if (!res.ok) throw new Error(data?.error || data?.message || `Falha ao enviar (${res.status})`);
    _optimisticChatMessages = _optimisticChatMessages.filter(m => m.id !== tempMsg.id);
    _msgCache.delete(selectedChatContactId); // invalidate so next load fetches fresh
    await loadChatMessages(selectedChatContactId);
    loadConversations();
  } catch (e) {
    _optimisticChatMessages = _optimisticChatMessages.filter(m => m.id !== tempMsg.id);
    input.value = typed;
    alert('Erro ao enviar: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function sendChatMedia(file) {
  if (!selectedChatContactId) return;
  const formData = new FormData();
  formData.append('file', file, file.name);
  try {
    const res = await apiFetch(`/api/chat/${encodeURIComponent(selectedChatContactId)}/send-media`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await loadChatMessages(selectedChatContactId);
    loadConversations();
  } catch (e) {
    alert('Erro ao enviar arquivo: ' + e.message);
  }
}

const EMOJI_LIST = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😋','😛','😜','🤪','😎','🥳','🤩','😏','🙄','😒','😞','😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','😱','😨','😰','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','😯','😦','😧','😮','😲','🥱','😴','🤤','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','😈','👿','💀','💩','🤡','👋','✋','👌','✌️','🤞','👍','👎','✊','👊','🤛','🤜','👏','🙌','🤝','🙏','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❤️‍🔥','💯','🔥','✅','❌','⚠️','🎉','🎊','🏆','⭐','🌟','💫','✨','💥','💰','📱','🏠','🚗','✈️','☕','🎵','🎶','🌎','🌞','🌙','⚡','🌈','💎','🎯','🔑','🔒','📅','📌','📎','✏️','📝','🗑️','🔔','💡','🚀','🎮','🎤','📸','🍕','🍔','🍺','🍷','🎂'];

function toggleEmojiPicker() {
  const panel = document.getElementById('emoji-picker-panel');
  if (!panel) return;
  if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
  if (!panel.childElementCount) {
    EMOJI_LIST.forEach(em => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn-pick';
      btn.textContent = em;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const input = document.getElementById('chat-input');
        if (!input) return;
        const start = input.selectionStart, end = input.selectionEnd;
        input.value = input.value.slice(0, start) + em + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + em.length;
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
      panel.appendChild(btn);
    });
  }
  panel.classList.add('open');
}

function showReactionPicker(triggerBtn) {
  const panel = document.getElementById('reaction-picker');
  if (!panel) return;
  const QUICK = ['❤️','👍','😂','😮','😢','🙏'];
  const messageId = triggerBtn.dataset.msgId;
  const direction = triggerBtn.dataset.dir;
  const isCrm = !!triggerBtn.closest('#crm-detail-messages');
  const contactId = isCrm ? crmDetailContactId : selectedChatContactId;
  panel.innerHTML = '';
  QUICK.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'reaction-opt';
    btn.textContent = em;
    btn.title = em;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      panel.classList.remove('open');
      sendReaction(messageId, direction, em, contactId);
    });
    panel.appendChild(btn);
  });
  const rect = triggerBtn.getBoundingClientRect();
  panel.style.top = (rect.top - 56 + window.scrollY) + 'px';
  panel.style.left = Math.max(8, rect.left - 80 + window.scrollX) + 'px';
  panel.classList.add('open');
}

async function sendReaction(messageId, direction, emoji, contactId) {
  contactId = contactId || selectedChatContactId;
  if (!contactId || !messageId) return;
  try {
    await apiFetch(`/api/chat/${encodeURIComponent(contactId)}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, emoji })
    });
  } catch (e) {
    alert('Erro ao reagir: ' + e.message);
  }
}

// ─── Reply (quote) ─────────────────────────
let _chatReplyTo = null;
let _crmReplyTo = null;

function parseQuoted(text) {
  const t = text || '';
  const m = t.match(/^> (.*)\n\n([\s\S]*)$/);
  if (!m) return { quote: null, body: t };
  return { quote: m[1], body: m[2] };
}

function quoteSnippet(m) {
  const { body } = parseQuoted(m.text || '');
  const raw = body || (m.mediaType ? `[${m.mediaType}]` : '');
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
}

function setChatReplyTo(msgId, text, direction) {
  _chatReplyTo = { id: msgId, text, direction };
  renderChatReplyBar();
}
function clearChatReplyTo() {
  _chatReplyTo = null;
  renderChatReplyBar();
}
function renderChatReplyBar() {
  const bar = document.getElementById('chat-reply-bar');
  if (!bar) return;
  bar.classList.toggle('open', !!_chatReplyTo);
  const textEl = document.getElementById('chat-reply-bar-text');
  if (textEl && _chatReplyTo) textEl.textContent = `Respondendo: ${_chatReplyTo.text}`;
}

function setCrmReplyTo(msgId, text, direction) {
  _crmReplyTo = { id: msgId, text, direction };
  renderCrmReplyBar();
}
function clearCrmReplyTo() {
  _crmReplyTo = null;
  renderCrmReplyBar();
}
function renderCrmReplyBar() {
  const bar = document.getElementById('crm-reply-bar');
  if (!bar) return;
  bar.classList.toggle('open', !!_crmReplyTo);
  const textEl = document.getElementById('crm-reply-bar-text');
  if (textEl && _crmReplyTo) textEl.textContent = `Respondendo: ${_crmReplyTo.text}`;
}

async function loadChatMessages(contactId) {
  if (!contactId) return;
  if (chatMessagesLoadingFor === contactId) return;

  // Render cached messages instantly (no spinner on repeat visits)
  const cached = _msgCache.get(contactId);
  if (cached && cached.length) {
    _currentChatMessages = cached;
    renderChatMessages(cached);
  }

  chatMessagesLoadingFor = contactId;
  try {
    const msgs = await (await apiFetch(`/api/chat/${encodeURIComponent(contactId)}`)).json();
    if (contactId !== selectedChatContactId) return;
    const arr = Array.isArray(msgs) ? msgs : [];
    // Only re-render if content actually changed vs cache
    const freshKey = arr.length + ':' + (arr[arr.length - 1]?.timestamp || 0);
    const cacheKey = cached ? (cached.length + ':' + (cached[cached.length - 1]?.timestamp || 0)) : '';
    if (freshKey !== cacheKey) {
      _currentChatMessages = arr;
      renderChatMessages(arr);
    }
    // Cap cache at 60 conversations to avoid memory leak
    if (_msgCache.size >= 60) { const first = _msgCache.keys().next().value; _msgCache.delete(first); }
    _msgCache.set(contactId, arr);
  } catch {
  } finally {
    if (chatMessagesLoadingFor === contactId) chatMessagesLoadingFor = null;
  }
}

function renderChatMessages(msgs) {
  const el = document.getElementById('chat-messages');
  const pendingForConversation = _optimisticChatMessages.filter(m => m.contactId === selectedChatContactId);
  if (pendingForConversation.length) msgs = [...msgs, ...pendingForConversation];

  const renderKey = `${selectedChatContactId}:${msgs.length}:${msgs[msgs.length - 1]?.timestamp || 0}`;

  if (!msgs.length) {
    if (_chatRenderKey !== renderKey) {
      _chatRenderKey = renderKey;
      el.innerHTML = '<div class="chat-empty-area">Nenhuma mensagem nesta conversa</div>';
    }
    return;
  }

  if (renderKey === _chatRenderKey) return;

  const isPlaying = Array.from(el.querySelectorAll('audio, video')).some(m => !m.paused);
  if (isPlaying) return;

  _chatRenderKey = renderKey;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const isGroupChat = String(selectedChatContactId || '').endsWith('@g.us');
  // Pastel palette da identidade visual — tons que funcionam no dark
  const SENDER_COLORS = ['#f4a26a','#7dd3bc','#a78bfa','#60a5fa','#34d399','#f472b6','#fbbf24','#fb923c','#c084fc','#38bdf8'];
  function senderColor(name) {
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    return SENDER_COLORS[h % SENDER_COLORS.length];
  }
  let lastDay = '';
  el.innerHTML = msgs.map(m => {
    const d = new Date(m.timestamp);
    const dayStr = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    const sep = dayStr !== lastDay
      ? `<div class="wa-date-sep"><span>${dayStr}</span></div>`
      : '';
    lastDay = dayStr;
    const mediaHtml = buildChatMediaHtml(m);
    const timeHtml = `<span style="float:right;font-size:10px;color:#8696a0;margin-left:8px;margin-top:4px;">${formatTime(d)}${m.pending ? ' - enviando' : ''}</span>`;
    // Parse sender name in group incoming messages (stored as "Nome: texto")
    let senderHtml = '';
    let displayText = m.text || '';
    if (isGroupChat && m.direction === 'in' && m.text) {
      const colon = m.text.indexOf(': ');
      if (colon > 0 && colon < 40) {
        const name = m.text.slice(0, colon);
        displayText = m.text.slice(colon + 2);
        senderHtml = `<span style="display:block;font-size:11px;font-weight:600;margin-bottom:3px;color:${senderColor(name)};">${escapeHtml(name)}</span>`;
      }
    }
    const { quote, body } = parseQuoted(displayText);
    const quoteHtml = quote ? `<span class="msg-quote">${escapeHtml(quote)}</span>` : '';
    const textHtml = body ? `<span>${linkify(body)}</span>` : '';
    const actions = m.id && !m.pending ? `<div class="msg-actions">
      <button class="msg-reply-btn" data-msg-id="${escapeHtml(m.id)}" data-dir="${m.direction}" title="Responder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>
      <button class="msg-reaction-btn" data-msg-id="${escapeHtml(m.id)}" data-dir="${m.direction}" title="Reagir">😊</button>
    </div>` : '';
    return `${sep}<div class="chat-msg ${m.direction}">
      ${actions}
      <div class="chat-bubble">${senderHtml}${mediaHtml}${quoteHtml}${textHtml}${timeHtml}</div>
    </div>`;
  }).join('');
  wireVoiceMessages(el);
  if (wasAtBottom || msgs.length <= 15) el.scrollTop = el.scrollHeight;
}

// ─── Relatórios ───────────────────────────────
let reportsSetupDone = false;

function setupReports() {
  if (reportsSetupDone) return;
  reportsSetupDone = true;
  document.getElementById('btn-apply-report-filter')?.addEventListener('click', loadReports);
  document.getElementById('btn-clear-report-filter')?.addEventListener('click', () => {
    ['report-date-from', 'report-date-to', 'report-search'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const type = document.getElementById('report-recipient-type');
    if (type) type.value = 'all';
    loadReports();
  });
  document.getElementById('report-recipient-type')?.addEventListener('change', loadReports);
  document.getElementById('report-search')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadReports(); });
}

function getReportQuery() {
  const params = new URLSearchParams();
  const from = document.getElementById('report-date-from')?.value;
  const to = document.getElementById('report-date-to')?.value;
  const type = document.getElementById('report-recipient-type')?.value || 'all';
  const search = document.getElementById('report-search')?.value?.trim();
  if (from) params.set('from', new Date(`${from}T00:00:00`).getTime());
  if (to) params.set('to', new Date(`${to}T23:59:59.999`).getTime());
  if (type !== 'all') params.set('type', type);
  if (search) params.set('search', search);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function renderSimpleBarChart(el, rows, emptyText) {
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">${emptyText}</div>`;
    return;
  }
  const maxCount = Math.max(...rows.map(d => d.count), 1);
  el.innerHTML = rows.map(d => `
    <div class="new-contacts-bar-row">
      <div class="new-contacts-bar-label">${escapeHtml(d.day)}</div>
      <div class="new-contacts-bar-wrap"><div class="new-contacts-bar-fill" style="width:${Math.round((d.count/maxCount)*100)}%"></div></div>
      <div class="new-contacts-bar-count">${d.count}</div>
    </div>`).join('');
}

async function loadReports() {
  const qs = getReportQuery();
  let newContacts = [];

  try {
    newContacts = await (await apiFetch(`/api/metrics/new-contacts${qs}`)).json();
    renderSimpleBarChart(document.getElementById('new-contacts-chart'), newContacts, 'Nenhum lead novo no período selecionado.');
  } catch {}

  try {
    const r = await (await apiFetch(`/api/reports${qs}`)).json();
    const newLeadTotal = newContacts.reduce((sum, d) => sum + (Number(d.count) || 0), 0);

    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setText('stat-sent', r.totalSent || 0);
    setText('stat-group-sent', r.totalGroupSent || 0);
    setText('stat-contact-sent', r.totalContactSent || 0);
    setText('stat-new-leads', newLeadTotal);

    renderSimpleBarChart(document.getElementById('sent-by-day-chart'), r.sentByDay || [], 'Nenhum envio no período selecionado.');

    const recStats = document.getElementById('recipient-stats');
    if (recStats) {
      recStats.innerHTML = (r.byRecipient || []).length === 0
        ? '<div style="color:var(--text3);font-size:13px;padding:8px 0">Nenhum envio encontrado</div>'
        : r.byRecipient.map(rec => `
            <div class="recipient-row">
              <span class="recipient-row-name">
                <span class="recipient-row-type">${rec.type === 'group' ? 'Grupo' : 'Contato'}</span>
                ${escapeHtml(rec.name || rec.id || '')}
              </span>
              <span class="recipient-row-stats">
                <span>Enviados: <strong>${rec.sent}</strong></span>
                <span>Resp: <strong>${rec.rate}%</strong></span>
                ${rec.avgTime ? `<span>${formatDuration(rec.avgTime)}</span>` : ''}
              </span>
            </div>`).join('');
    }

    const recentEl = document.getElementById('recent-responses');
    if (recentEl) {
      recentEl.innerHTML = (r.recentResponses || []).length === 0
        ? '<div style="color:var(--text3);font-size:13px;padding:8px 0">Nenhuma resposta registrada</div>'
        : r.recentResponses.map(resp => `
            <div class="response-item">
              <span class="response-item-name">${escapeHtml(resp.senderName)}</span>
              <span class="response-item-btn">${escapeHtml(resp.matchedButton || resp.reply || 'Resposta')}</span>
              <span style="font-size:12px;color:var(--text2)">em ${escapeHtml(resp.recipientName)}</span>
              <span class="response-item-time">${formatDuration(resp.responseTimeMs)}</span>
            </div>`).join('');
    }
  } catch {}

  try {
    const crm = await (await apiFetch('/api/crm/report')).json();
    renderCrmReportCharts(crm);
  } catch {}
}

function renderCrmReportCharts(crm) {
  const labelColors = { 'Em andamento': '#ffd43b', 'Não respondeu': '#ff6b6b', 'Finalizado': '#69db7c', 'Sem label': '#888' };

  const labelEl = document.getElementById('crm-label-chart');
  const labels = crm.labels || {};
  const labelMax = Math.max(...Object.values(labels), 1);
  labelEl.innerHTML = Object.entries(labels).map(([lbl, count]) => `
    <div class="crm-bar-row">
      <div class="crm-bar-label">${escapeHtml(lbl)}</div>
      <div class="crm-bar-wrap"><div class="crm-bar-fill" style="width:${Math.round((count/labelMax)*100)}%;background:${labelColors[lbl]||'#aaa'}"></div></div>
      <div class="crm-bar-count" style="color:${labelColors[lbl]||'#aaa'}">${count}</div>
    </div>`).join('') || '<div style="color:var(--text3);font-size:13px;padding:8px 0">Sem dados</div>';

  const colEl = document.getElementById('crm-column-chart');
  const cols = crm.byColumn || [];
  const colMax = Math.max(...cols.map(c => c.count), 1);
  colEl.innerHTML = cols.map(col => `
    <div class="crm-bar-row">
      <div class="crm-bar-label">${escapeHtml(col.name)}</div>
      <div class="crm-bar-wrap"><div class="crm-bar-fill" style="width:${Math.round((col.count/colMax)*100)}%;background:var(--green)"></div></div>
      <div class="crm-bar-count" style="color:var(--green)">${col.count}</div>
    </div>`).join('') || '<div style="color:var(--text3);font-size:13px;padding:8px 0">Sem dados</div>';

  const checksEl = document.getElementById('crm-checks-chart');
  const checks = crm.checks || {};
  const total = crm.total || 1;
  const checkLabels = [['firstMessage','Primeira mensagem'],['followedOnInsta','Seguiu no Insta'],['commented','Comentou']];
  checksEl.innerHTML = checkLabels.map(([key, label]) => {
    const count = checks[key] || 0;
    return `<div class="crm-bar-row">
      <div class="crm-bar-label">${label}</div>
      <div class="crm-bar-wrap"><div class="crm-bar-fill" style="width:${Math.round((count/total)*100)}%;background:#74c0fc"></div></div>
      <div class="crm-bar-count" style="color:#74c0fc">${count}</div>
    </div>`;
  }).join('');
}


// ─── Tema claro/escuro ───────────────────────
function setupTheme() {
  const saved = localStorage.getItem('wa-theme') || 'light';
  applyTheme(saved);
  document.getElementById('btn-theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('theme-light') ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('wa-theme', next);
  });
}

function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
  document.getElementById('btn-theme-toggle').innerHTML = theme === 'light' ? `${icon('moon', 16)} Tema escuro` : `${icon('sun', 16)} Tema claro`;
}

// ─── Atalhos de data/hora ────────────────────
function setupQuickDates() {
  const container = document.getElementById('quick-dates');
  const pad = n => String(n).padStart(2, '0');

  function nextWeekday(targetDay, hour) {
    const now = new Date();
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    let diff = targetDay - now.getDay();
    if (diff < 0) diff += 7;
    if (diff === 0 && now >= d) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function buildOptions() {
    const now = new Date();
    const options = [];

    const today10 = new Date(); today10.setHours(10, 0, 0, 0);
    if (today10 > now) {
      options.push({ label: 'Hoje às 10h', date: today10 });
    }

    const tmr6 = new Date(); tmr6.setDate(tmr6.getDate() + 1); tmr6.setHours(6, 0, 0, 0);
    options.push({ label: 'Amanhã às 06h', date: tmr6 });

    for (const [day, abbr] of [[1, 'Seg'], [3, 'Qua'], [5, 'Sex']]) {
      const d = nextWeekday(day, 7);
      options.push({ label: `${abbr} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} · 07h`, date: d });
    }

    return options;
  }

  container.innerHTML = '';
  for (const opt of buildOptions()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-date-btn';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      document.getElementById('datetime-input').value = toLocalISO(opt.date);
    });
    container.appendChild(btn);
  }
}

// ─── Helpers ─────────────────────────────────
function showFeedback(el, msg, type) {
  el.textContent = msg; el.className = 'feedback ' + type; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function formatDate(dt) { return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }); }
function formatTime(dt) { return dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }

function formatDuration(ms) {
  if (!ms) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function toLocalISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setDatetimeMin(id) {
  const now = new Date(); now.setSeconds(0, 0);
  document.getElementById(id).min = toLocalISO(now);
}

// ══════════════════════════════════════════
// ─── Google Sheets Integration ────────────
// ══════════════════════════════════════════

function setupSheetsConfig() {
  const urlEl = document.getElementById('sheets-webhook-url');
  if (urlEl) urlEl.value = `${location.origin}/api/webhook/sheets`;

  document.getElementById('btn-copy-webhook-url').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('sheets-webhook-url').value);
    const btn = document.getElementById('btn-copy-webhook-url');
    btn.innerHTML = icon('check');
    setTimeout(() => { btn.innerHTML = icon('copy'); }, 2000);
  });

  document.getElementById('btn-save-sheets-config').addEventListener('click', saveSheetsConfig);

  const searchEl = document.getElementById('sheets-group-search');
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase();
    const results = document.getElementById('sheets-group-results');
    if (!q) { results.style.display = 'none'; return; }
    const matches = groups.filter(g => g.name.toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) { results.style.display = 'none'; return; }
    results.style.display = 'block';
    results.innerHTML = matches.map(g => `<div class="search-result-item" data-id="${g.id}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>`).join('');
    results.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        document.getElementById('sheets-group-id').value = item.dataset.id;
        document.getElementById('sheets-group-name').value = item.dataset.name;
        searchEl.value = item.dataset.name;
        results.style.display = 'none';
      });
    });
  });

  loadSheetsConfig();
  loadSheetsChannels();

  document.getElementById('btn-add-sheets-channel').addEventListener('click', () => openSheetsChannelModal());

  document.getElementById('sheets-channel-modal-close').addEventListener('click', () => {
    document.getElementById('sheets-channel-modal').style.display = 'none';
  });

  document.getElementById('btn-save-sheets-channel').addEventListener('click', saveSheetsChannel);
  document.getElementById('btn-test-sheets-channel').addEventListener('click', testSheetsChannel);

  // Group search inside channel modal
  const chSearchEl = document.getElementById('sheets-channel-group-search');
  chSearchEl.addEventListener('input', () => {
    const q = chSearchEl.value.toLowerCase();
    const results = document.getElementById('sheets-channel-group-results');
    if (!q) { results.style.display = 'none'; return; }
    const matches = groups.filter(g => g.name.toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) { results.style.display = 'none'; return; }
    results.style.display = 'block';
    results.innerHTML = matches.map(g => `<div class="search-result-item" data-id="${g.id}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>`).join('');
    results.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        document.getElementById('sheets-channel-group-id').value = item.dataset.id;
        document.getElementById('sheets-channel-group-name').value = item.dataset.name;
        chSearchEl.value = item.dataset.name;
        results.style.display = 'none';
      });
    });
  });
}

function formatSheetsConnection(connectionId) {
  if (connectionId === 'auto') return 'Automático';
  const phone = _connectionPhones[connectionId];
  if (phone) return `${CONNECTION_LABELS[connectionId]?.label || connectionId} — ${phone}`;
  return CONNECTION_LABELS[connectionId]?.label || connectionId || 'WhatsApp';
}

function renderSheetsConnectionOptions(selectEl, selected = 'web') {
  if (!selectEl) return;
  const allIds = ['web', 'web2', 'web3', 'groups', 'cloud1', 'cloud2', 'cloud3'];
  const conns = runtimeStatus.connections || {};
  // Only show connections that are actually connected/active
  const activeIds = allIds.filter(id => !!(conns[id]?.connected));
  // Always keep currently saved option visible (greyed out if disconnected)
  if (selected && allIds.includes(selected) && !activeIds.includes(selected)) {
    activeIds.push(selected);
  }
  const ids = activeIds.length ? activeIds : ['web'];
  selectEl.innerHTML = ids.map(id => {
    const isActive = !!(conns[id]?.connected);
    const label = formatSheetsConnection(id) + (isActive ? '' : ' (desconectado)');
    return `<option value="${id}"${isActive ? '' : ' style="color:var(--text2)"'}>${escapeHtml(label)}</option>`;
  }).join('');
  selectEl.value = ids.includes(selected) ? selected : ids[0];
}

async function loadSheetsChannels() {
  try {
    const channels = await apiFetch('/api/sheets/channels').then(r => r.json());
    const el = document.getElementById('sheets-channels-list');
    if (!channels.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text2);">Nenhuma planilha adicional configurada.</div>'; return; }
    el.innerHTML = channels.map(ch => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;">${escapeHtml(ch.name)}</div>
          <div style="font-size:11px;color:var(--text2);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${location.origin}/api/webhook/sheets/…/${escapeHtml(ch.id)}</div>
          <div style="font-size:11px;color:var(--accent);margin-top:3px;">Enviar via: ${escapeHtml(formatSheetsConnection(ch.connectionId || 'web'))}</div>
        </div>
        <button onclick="copySheetsChannelUrl('${escapeHtml(ch.id)}')" style="padding:3px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);cursor:pointer;font-size:11px;font-family:inherit;">Copiar URL</button>
        <button onclick="openSheetsChannelModal(${JSON.stringify(ch).replace(/"/g, '&quot;')})" style="padding:3px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg2);color:var(--text1);cursor:pointer;font-size:11px;font-family:inherit;">Editar</button>
        <button onclick="deleteSheetsChannel('${escapeHtml(ch.id)}')" style="padding:3px 8px;border-radius:5px;border:1px solid #ff6b6b33;background:transparent;color:#ff6b6b;cursor:pointer;font-size:11px;font-family:inherit;">✕</button>
      </div>`).join('');
  } catch {}
}

function copySheetsChannelUrl(channelId) {
  const clientId = (currentUser && currentUser.clientId) ? currentUser.clientId : 'vac';
  const fullUrl = `${location.origin}/api/webhook/sheets/${clientId}/${channelId}`;
  // Use prompt so user can select-all and copy even on HTTP
  prompt('Selecione tudo (Ctrl+A ou Cmd+A) e copie:', fullUrl);
}

function openSheetsChannelModal(ch = null) {
  document.getElementById('sheets-channel-id').value = ch?.id || '';
  document.getElementById('sheets-channel-modal-title').textContent = ch ? `Editar — ${ch.name}` : 'Nova planilha';
  document.getElementById('sheets-channel-name').value = ch?.name || '';
  document.getElementById('sheets-channel-secret').value = ch?.secret || '';
  renderSheetsConnectionOptions(document.getElementById('sheets-channel-connection-id'), ch?.connectionId || 'web');
  document.getElementById('sheets-channel-group-search').value = ch?.groupName || '';
  document.getElementById('sheets-channel-group-id').value = ch?.groupId || '';
  document.getElementById('sheets-channel-group-name').value = ch?.groupName || '';
  document.getElementById('sheets-channel-template').value = ch?.template || '🔔 Novo lead!\n\nNome: {nome}\nTelefone: {telefone}\nEmail: {email}';
  const qiSel = document.getElementById('sheets-channel-queue-interval');
  if (qiSel) qiSel.value = String(ch?.queueIntervalSec || 40);
  document.getElementById('sheets-channel-feedback').style.display = 'none';
  document.getElementById('sheets-channel-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('sheets-channel-name').focus(), 50);
}

async function saveSheetsChannel() {
  const fbEl = document.getElementById('sheets-channel-feedback');
  const id = document.getElementById('sheets-channel-id').value;
  const payload = {
    name: document.getElementById('sheets-channel-name').value.trim(),
    secret: document.getElementById('sheets-channel-secret').value.trim(),
    groupId: document.getElementById('sheets-channel-group-id').value,
    groupName: document.getElementById('sheets-channel-group-name').value,
    connectionId: document.getElementById('sheets-channel-connection-id').value || 'web',
    template: document.getElementById('sheets-channel-template').value.trim(),
    queueIntervalSec: parseInt(document.getElementById('sheets-channel-queue-interval')?.value || '40', 10),
  };
  if (!payload.name) { showFeedback(fbEl, 'Preencha o nome', 'error'); return; }
  if (!payload.secret) { showFeedback(fbEl, 'Preencha o token secreto', 'error'); return; }
  if (!payload.groupId) { showFeedback(fbEl, 'Selecione um grupo', 'error'); return; }
  try {
    const url = id ? `/api/sheets/channels/${id}` : '/api/sheets/channels';
    const method = id ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('sheets-channel-modal').style.display = 'none';
    await loadSheetsChannels();
  } catch(e) {
    showFeedback(fbEl, e.message || 'Erro ao salvar', 'error');
  }
}

async function testSheetsChannel() {
  const fbEl = document.getElementById('sheets-channel-feedback');
  const id = document.getElementById('sheets-channel-id').value;
  if (!id) { showFeedback(fbEl, 'Salve a integração antes de testar.', 'error'); return; }
  const btn = document.getElementById('btn-test-sheets-channel');
  btn.disabled = true; btn.textContent = '⏳ Enviando...';
  try {
    const res = await apiFetch(`/api/sheets/channels/${id}/test`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showFeedback(fbEl, '✅ Mensagem de teste enviada para o grupo!', 'success');
  } catch(e) {
    showFeedback(fbEl, '❌ ' + (e.message || 'Erro ao testar'), 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🧪 Testar';
  }
}

async function deleteSheetsChannel(id) {
  if (!confirm('Remover esta integração?')) return;
  await apiFetch(`/api/sheets/channels/${id}`, { method: 'DELETE' });
  await loadSheetsChannels();
}

async function loadSheetsConfig() {
  try {
    const cfg = await (await apiFetch('/api/config/sheets')).json();
    document.getElementById('sheets-secret').value = cfg.secret || '';
    document.getElementById('sheets-template').value = cfg.template || '';
    renderSheetsConnectionOptions(document.getElementById('sheets-connection-id'), cfg.connectionId || 'web');
    if (cfg.groupId) {
      document.getElementById('sheets-group-id').value = cfg.groupId;
      document.getElementById('sheets-group-name').value = cfg.groupName;
      document.getElementById('sheets-group-search').value = cfg.groupName;
    }
  } catch {}
}

async function saveSheetsConfig() {
  const fbEl = document.getElementById('sheets-feedback');
  const payload = {
    secret: document.getElementById('sheets-secret').value.trim(),
    groupId: document.getElementById('sheets-group-id').value,
    groupName: document.getElementById('sheets-group-name').value,
    connectionId: document.getElementById('sheets-connection-id').value || 'web',
    template: document.getElementById('sheets-template').value.trim()
  };
  if (!payload.groupId) { showFeedback(fbEl, 'Selecione um grupo na busca acima', 'error'); return; }
  if (!payload.secret) { showFeedback(fbEl, 'Preencha o token secreto', 'error'); return; }
  try {
    const res = await apiFetch('/api/config/sheets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    showFeedback(fbEl, '✓ Configuração salva!', 'success');
  } catch {
    showFeedback(fbEl, 'Erro ao salvar', 'error');
  }
}

function escapeHtml(text) {
  const d = document.createElement('div'); d.textContent = text; return d.innerHTML;
}

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  return text.split(urlRegex).map((part, i) => {
    if (i % 2 === 1) {
      const safe = escapeHtml(part);
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer" style="color:#53bdeb;word-break:break-all;">${safe}</a>`;
    }
    return escapeHtml(part);
  }).join('');
}

// ══════════════════════════════════════════
// ─── CRM ─────────────────────────────────
// ══════════════════════════════════════════

let crmColumns = [];
let crmCards = [];
let crmUnreadIds = new Set(JSON.parse(localStorage.getItem('crm-unread') || '[]'));
let crmFunnels = [];
let currentFunnelId = null;
let editingCardId = null;
let crmDraggedCardId = null;
let crmDraggedColId = null;
let crmDragStartedAt = 0;
let currentCrmLabel = null;
let _crmViewMode = localStorage.getItem('crm-view-mode') || 'board';
let funnelModalMode = 'create';

let crmDetailPolling = null;
let crmDetailContactId = null;
let editingCrmWhatsappId = null;
let _optimisticCrmMessages = [];
let _crmRenderKey = '';
let _crmDetailConnId = null;

function setupCrm() {
  document.getElementById('crm-search')?.addEventListener('input', renderCrmBoard);
  document.getElementById('btn-add-crm-column').addEventListener('click', openAddColModal);
  document.getElementById('btn-crm-duplicates')?.addEventListener('click', openCrmDuplicatesModal);
  document.getElementById('crm-duplicates-modal-close')?.addEventListener('click', () => { document.getElementById('crm-duplicates-modal').style.display = 'none'; });
  document.getElementById('btn-crm-dup-select-older')?.addEventListener('click', () => crmDupAutoSelect());
  document.getElementById('btn-crm-dup-delete')?.addEventListener('click', crmDupDeleteSelected);
  document.getElementById('add-col-modal-close').addEventListener('click', closeAddColModal);
  document.getElementById('btn-save-crm-col').addEventListener('click', saveCrmColumn);
  document.getElementById('btn-delete-crm-col').addEventListener('click', deleteCrmColumn);
  document.getElementById('btn-crm-back').addEventListener('click', showCrmBoardView);
  document.getElementById('btn-crm-panel-toggle')?.addEventListener('click', toggleCrmLeadPanel);
  document.getElementById('btn-save-crm-card').addEventListener('click', saveCrmCard);
  document.getElementById('crm-card-phone')?.addEventListener('input', updateCrmCardLinks);
  document.getElementById('crm-card-instagram')?.addEventListener('input', updateCrmCardLinks);
  document.getElementById('crm-card-site')?.addEventListener('input', updateCrmCardLinks);
  document.getElementById('btn-delete-crm-card').addEventListener('click', deleteCrmCard);
  document.getElementById('crm-detail-send').addEventListener('click', sendCrmDetailMessage);
  const crmInput = document.getElementById('crm-detail-input');
  crmInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCrmDetailMessage(); }
  });
  crmInput.addEventListener('input', () => {
    crmInput.style.height = 'auto';
    crmInput.style.height = Math.min(crmInput.scrollHeight, 140) + 'px';
  });
  setupCrmChatAttach();
  setupCrmChatMic();

  // Reaction picker + reply (event delegation on CRM message container)
  document.getElementById('crm-detail-messages')?.addEventListener('click', e => {
    const reactBtn = e.target.closest('.msg-reaction-btn');
    if (reactBtn) { e.stopPropagation(); showReactionPicker(reactBtn); return; }
    const replyBtn = e.target.closest('.msg-reply-btn');
    if (replyBtn) {
      e.stopPropagation();
      const pending = _optimisticCrmMessages.filter(m => m.contactId === crmDetailContactId);
      const m = [..._currentCrmDetailMessages, ...pending].find(x => String(x.id) === replyBtn.dataset.msgId);
      if (m) setCrmReplyTo(m.id, quoteSnippet(m), m.direction);
    }
  });

  // Reply bar (injected above the CRM chat input)
  if (!document.getElementById('crm-reply-bar')) {
    const crmReplyBar = document.createElement('div');
    crmReplyBar.className = 'chat-reply-bar';
    crmReplyBar.id = 'crm-reply-bar';
    crmReplyBar.innerHTML = `<span class="chat-reply-bar-text" id="crm-reply-bar-text"></span><button class="chat-reply-bar-close" id="crm-reply-bar-close" title="Cancelar">✕</button>`;
    document.querySelector('.crm-detail-input-area')?.insertAdjacentElement('beforebegin', crmReplyBar);
    document.getElementById('crm-reply-bar-close')?.addEventListener('click', clearCrmReplyTo);
  }

  document.querySelectorAll('#crm-label-selector .crm-label-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleCrmLabel(btn.dataset.label));
  });

  // Activity tabs
  document.querySelectorAll('.crm-act-tab').forEach(btn => {
    btn.addEventListener('click', () => crmActSwitchTab(btn.dataset.act));
  });
  document.getElementById('btn-add-comment').addEventListener('click', addCrmComment);
  document.getElementById('crm-comment-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addCrmComment(); }
  });
  document.getElementById('crm-file-input').addEventListener('change', e => {
    uploadCrmFiles(Array.from(e.target.files));
    e.target.value = '';
  });
  document.getElementById('add-col-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-col-modal')) closeAddColModal();
  });

  // Funis
  document.getElementById('crm-funnel-select').addEventListener('change', e => {
    currentFunnelId = e.target.value;
    loadCrm();
  });
  setupCrmFunnelConnectionPicker();
  document.getElementById('btn-add-funnel').addEventListener('click', () => openFunnelModal('create'));
  document.getElementById('btn-rename-funnel').addEventListener('click', () => openFunnelModal('rename'));
  document.getElementById('btn-delete-funnel').addEventListener('click', deleteFunnel);
  document.getElementById('funnel-modal-close').addEventListener('click', () => { document.getElementById('funnel-modal').style.display = 'none'; });
  document.getElementById('btn-save-funnel').addEventListener('click', saveFunnel);

  // Chat → CRM
  document.getElementById('btn-add-to-crm').addEventListener('click', openAddToCrmModal);
  document.getElementById('btn-delete-chat-conversation')?.addEventListener('click', deleteChatConversation);
  document.getElementById('add-to-crm-modal-close').addEventListener('click', () => { document.getElementById('add-to-crm-modal').style.display = 'none'; });
  document.getElementById('btn-confirm-add-to-crm').addEventListener('click', confirmAddToCrm);

  document.getElementById('atc-funnel').addEventListener('change', loadAtcColumns);

  // Contatos do celular
  document.getElementById('btn-sync-phone-contacts')?.addEventListener('click', openPhoneContactsModal);
  document.getElementById('phone-contacts-modal-close')?.addEventListener('click', () => { document.getElementById('phone-contacts-modal').style.display = 'none'; });
  document.getElementById('btn-import-phone-contacts')?.addEventListener('click', importPhoneContacts);
  document.getElementById('phone-contacts-search')?.addEventListener('input', renderPhoneContactsList);
  document.getElementById('phone-contacts-select-all')?.addEventListener('change', e => {
    document.querySelectorAll('.phone-contact-check').forEach(cb => { cb.checked = e.target.checked; });
    updatePhoneContactsCount();
  });
}

let _phoneContactsAll = [];

async function openPhoneContactsModal() {
  const modal = document.getElementById('phone-contacts-modal');
  modal.style.display = 'flex';
  document.getElementById('phone-contacts-feedback').style.display = 'none';
  document.getElementById('phone-contacts-list').innerHTML = '<div style="color:#888;text-align:center;padding:20px;">Carregando contatos do celular...</div>';
  document.getElementById('phone-contacts-search').value = '';
  document.getElementById('phone-contacts-select-all').checked = false;
  document.getElementById('btn-import-phone-contacts').disabled = true;
  try {
    const data = await apiFetch('/api/contacts');
    _phoneContactsAll = (Array.isArray(data) ? data : [])
      .filter(c => c.name || c.id)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
    renderPhoneContactsList();
  } catch (e) {
    document.getElementById('phone-contacts-list').innerHTML = `<div style="color:#ff6b6b;text-align:center;padding:20px;">${e.message}</div>`;
  }
}

function renderPhoneContactsList() {
  const q = (document.getElementById('phone-contacts-search').value || '').toLowerCase();
  const filtered = _phoneContactsAll.filter(c =>
    !q || (c.name || '').toLowerCase().includes(q) || (c.id || '').includes(q)
  );
  const list = document.getElementById('phone-contacts-list');
  if (!filtered.length) {
    list.innerHTML = '<div style="color:#888;text-align:center;padding:20px;">Nenhum contato encontrado</div>';
    document.getElementById('phone-contacts-count').textContent = '';
    document.getElementById('btn-import-phone-contacts').disabled = true;
    return;
  }
  list.innerHTML = filtered.map(c => {
    const phone = (c.id || '').replace('@s.whatsapp.net', '').replace('@lid', '');
    const display = c.name || phone;
    const sub = c.name ? `+${phone}` : '';
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;background:#1a1d2e;">
      <input type="checkbox" class="phone-contact-check" data-id="${c.id || ''}" data-name="${display.replace(/"/g, '&quot;')}" data-phone="${phone}">
      <div>
        <div style="font-size:14px;font-weight:500;">${display}</div>
        ${sub ? `<div style="font-size:12px;color:#888;">${sub}</div>` : ''}
      </div>
    </label>`;
  }).join('');
  list.querySelectorAll('.phone-contact-check').forEach(cb => cb.addEventListener('change', updatePhoneContactsCount));
  updatePhoneContactsCount();
}

function updatePhoneContactsCount() {
  const checked = document.querySelectorAll('.phone-contact-check:checked').length;
  document.getElementById('phone-contacts-count').textContent = checked ? `${checked} selecionado(s)` : '';
  document.getElementById('btn-import-phone-contacts').disabled = !checked;
}

async function importPhoneContacts() {
  const checks = document.querySelectorAll('.phone-contact-check:checked');
  if (!checks.length) return;
  const contacts = Array.from(checks).map(cb => ({ id: cb.dataset.id, name: cb.dataset.name, phone: cb.dataset.phone }));
  const fb = document.getElementById('phone-contacts-feedback');
  fb.style.display = 'none';
  document.getElementById('btn-import-phone-contacts').disabled = true;
  try {
    const res = await apiFetch('/api/contacts/import-to-crm', { method: 'POST', body: JSON.stringify({ contacts }), headers: { 'Content-Type': 'application/json' } });
    fb.style.display = 'block';
    fb.style.color = '#4caf50';
    fb.textContent = `${res.imported} importado(s)${res.skipped ? `, ${res.skipped} já existiam` : ''}.`;
    if (res.imported > 0) setTimeout(() => { loadCrm(); }, 800);
  } catch (e) {
    fb.style.display = 'block';
    fb.style.color = '#ff6b6b';
    fb.textContent = e.message;
  } finally {
    document.getElementById('btn-import-phone-contacts').disabled = false;
  }
}

// ─── Live microphone recording (shared by Chat ao vivo + CRM chat) ─────────
function setupMicRecorder({ inputArea, inputEl, sendBtn, sendMediaFn }) {
  if (!inputArea || inputArea.querySelector('.msg-mic-btn')) return;

  let mediaRecorder = null, chunks = [], stream = null, startTime = 0, timerInterval = null;

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'msg-mic-btn';
  micBtn.title = 'Gravar áudio';
  micBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

  const recBar = document.createElement('div');
  recBar.className = 'msg-recording-bar';
  recBar.innerHTML = `<button type="button" class="msg-recording-cancel" title="Cancelar">✕</button><span class="msg-recording-dot"></span><span class="msg-recording-time">0:00</span><span class="msg-recording-hint">Gravando áudio... clique em enviar</span>`;

  if (sendBtn && sendBtn.parentElement === inputArea) inputArea.insertBefore(micBtn, sendBtn);
  else inputArea.appendChild(micBtn);
  inputArea.insertBefore(recBar, micBtn);

  function updateTimer() {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(secs / 60), s = secs % 60;
    const t = recBar.querySelector('.msg-recording-time');
    if (t) t.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  function stopStreamTracks() {
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert('Não foi possível acessar o microfone: ' + e.message);
      return;
    }
    chunks = [];
    const mimeType = window.MediaRecorder?.isTypeSupported?.('audio/webm')
      ? 'audio/webm'
      : (window.MediaRecorder?.isTypeSupported?.('audio/mp4') ? 'audio/mp4' : '');
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener('dataavailable', e => { if (e.data.size > 0) chunks.push(e.data); });
    mediaRecorder.start();
    startTime = Date.now();
    micBtn.classList.add('recording');
    recBar.classList.add('open');
    if (inputEl) inputEl.style.display = 'none';
    timerInterval = setInterval(updateTimer, 500);
    updateTimer();
  }

  async function finish(send) {
    if (!mediaRecorder) return;
    clearInterval(timerInterval);
    recBar.classList.remove('open');
    micBtn.classList.remove('recording');
    if (inputEl) inputEl.style.display = '';
    const rec = mediaRecorder;
    mediaRecorder = null;
    await new Promise(resolve => {
      rec.addEventListener('stop', resolve, { once: true });
      rec.stop();
    });
    stopStreamTracks();
    const collected = chunks; chunks = [];
    if (!send || !collected.length) return;
    const mime = rec.mimeType || 'audio/webm';
    const ext = mime.includes('mp4') ? 'm4a' : 'webm';
    const blob = new Blob(collected, { type: mime });
    const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: mime });
    await sendMediaFn(file);
  }

  micBtn.addEventListener('click', () => { if (!mediaRecorder) start(); });
  recBar.querySelector('.msg-recording-cancel').addEventListener('click', () => finish(false));

  return { isRecording: () => !!mediaRecorder, finishAndSend: () => finish(true) };
}

function setupCrmChatAttach() {
  const inputArea = document.querySelector('.crm-detail-input-area');
  if (!inputArea || document.getElementById('crm-detail-file')) return;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'crm-detail-file';
  fileInput.style.display = 'none';
  fileInput.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip';
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'crm-chat-attach-btn';
  attachBtn.title = 'Anexar arquivo';
  attachBtn.innerHTML = icon('paperclip');
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) sendCrmDetailMedia(fileInput.files[0]);
    fileInput.value = '';
  });
  inputArea.insertBefore(fileInput, inputArea.firstChild);
  inputArea.insertBefore(attachBtn, inputArea.firstChild);
  setupCrmConnectionPicker();
}

function setupCrmChatMic() {
  _crmMic = setupMicRecorder({
    inputArea: document.querySelector('.crm-detail-input-area'),
    inputEl: document.getElementById('crm-detail-input'),
    sendBtn: document.getElementById('crm-detail-send'),
    sendMediaFn: sendCrmDetailMedia
  }) || _crmMic;
}

function crmConnectionChoices(includeBlank = false) {
  const items = [];
  if (includeBlank) items.push({ id: '', label: 'Conexão principal do cliente', connected: true });
  const defs = [
    ['lite', !!window._liteConnInfo?.connected, window._liteConnInfo?.phone || ''],
    ['lite2', !!window._lite2ConnInfo?.connected, window._lite2ConnInfo?.phone || ''],
    ['web', !!runtimeStatus?.connections?.web?.connected, runtimeStatus?.connections?.web?.phone || ''],
    ['web2', !!runtimeStatus?.connections?.web2?.connected, runtimeStatus?.connections?.web2?.phone || ''],
    ['web3', !!runtimeStatus?.connections?.web3?.connected, runtimeStatus?.connections?.web3?.phone || ''],
    ['cloud1', !!runtimeStatus?.connections?.cloud1?.connected, runtimeStatus?.connections?.cloud1?.displayPhone || runtimeStatus?.connections?.cloud1?.phone || ''],
    ['cloud2', !!runtimeStatus?.connections?.cloud2?.connected, runtimeStatus?.connections?.cloud2?.displayPhone || runtimeStatus?.connections?.cloud2?.phone || ''],
    ['cloud3', !!runtimeStatus?.connections?.cloud3?.connected, runtimeStatus?.connections?.cloud3?.displayPhone || runtimeStatus?.connections?.cloud3?.phone || ''],
    ['groups', !!runtimeStatus?.connections?.groups?.connected, runtimeStatus?.connections?.groups?.phone || ''],
  ];
  defs.forEach(([id, connected, phone]) => {
    if (!connected) return;
    const base = CONNECTION_LABELS[id]?.label || id;
    items.push({ id, label: `${base}${phone ? ` · ${phone}` : ''}`, connected: true });
  });
  return items;
}

function crmFunnelConnectionLabel(connectionId) {
  if (!connectionId) return 'Principal do cliente';
  const hit = crmConnectionChoices(false).find(opt => opt.id === connectionId);
  return hit?.label || (CONNECTION_LABELS[connectionId]?.label || connectionId);
}

function crmFunnelOptionLabel(funnel) {
  return funnel?.name || '';
}

function primaryConnectionPhone() {
  if (window._liteConnInfo?.connected && window._liteConnInfo?.phone) return window._liteConnInfo.phone;
  const webPhone = runtimeStatus?.connections?.web?.phone || '';
  if (webPhone) return webPhone;
  const cloudPhone = runtimeStatus?.connections?.cloud1?.displayPhone || runtimeStatus?.connections?.cloud1?.phone || '';
  return cloudPhone || '';
}

function whatsappFunnelConnectionOptions() {
  const primaryPhone = primaryConnectionPhone();
  const items = [
    {
      id: '',
      label: 'Conexão principal',
      phone: primaryPhone,
      connected: hasAnyConnectedChannel(),
      subtitle: 'Fallback padrão quando o funil não está preso a um número específico.'
    },
    ...crmConnectionChoices(false)
      .filter(opt => opt.id !== 'groups')
      .map(opt => ({
        id: opt.id,
        label: CONNECTION_LABELS[opt.id]?.label || opt.label,
        phone: opt.label.split(' · ')[1] || '',
        connected: true,
        subtitle: 'Selecione os funis que este número deve atender.'
      }))
  ];

  const seen = new Set();
  return items.filter(item => {
    const normalizedPhone = String(item.phone || '').replace(/\D/g, '');
    const dedupeKey = item.id === ''
      ? `primary:${normalizedPhone || 'none'}`
      : `${item.label}:${normalizedPhone || item.id}`;

    if (item.id === 'lite' && normalizedPhone && normalizedPhone === String(primaryPhone || '').replace(/\D/g, '')) {
      return false;
    }
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

function setupCrmFunnelConnectionPicker() {
  const wrap = document.getElementById('crm-funnel-conn-wrap');
  if (wrap) wrap.style.display = 'none';
}

async function saveCurrentFunnelConnection() {
  const funnel = crmFunnels.find(f => f.id === currentFunnelId);
  const select = document.getElementById('crm-funnel-conn-select');
  if (!funnel || !select) return;
  const chatConnectionId = select.value || null;
  await apiFetch(`/api/funnels/${funnel.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: funnel.name, chatConnectionId })
  });
  funnel.chatConnectionId = chatConnectionId;
  const funnelSel = document.getElementById('crm-funnel-select');
  if (funnelSel) funnelSel.innerHTML = crmFunnels.map(f => `<option value="${f.id}"${f.id === currentFunnelId ? ' selected' : ''}>${escapeHtml(crmFunnelOptionLabel(f))}</option>`).join('');
}

function refreshCrmFunnelConnectionPicker() {
  const wrap = document.getElementById('crm-funnel-conn-wrap');
  const select = document.getElementById('crm-funnel-conn-select');
  if (!wrap || !select) return;
  wrap.style.display = 'none';
}

function getCrmConnectionOptions(contactId) {
  return crmConnectionChoices(false);
}

function setupCrmConnectionPicker() {
  const inputArea = document.querySelector('.crm-detail-input-area');
  const input = document.getElementById('crm-detail-input');
  if (!inputArea || !input || document.getElementById('crm-detail-conn-select')) return;
  const wrap = document.createElement('div');
  wrap.id = 'crm-detail-conn-wrap';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.marginRight = '8px';
  wrap.style.flexShrink = '0';

  const select = document.createElement('select');
  select.id = 'crm-detail-conn-select';
  select.title = 'Escolher WhatsApp de envio';
  select.style.height = '38px';
  select.style.maxWidth = '200px';
  select.style.border = '1px solid var(--border)';
  select.style.borderRadius = '12px';
  select.style.background = 'var(--bg2)';
  select.style.color = 'var(--text)';
  select.style.fontSize = '12px';
  select.style.fontWeight = '600';
  select.style.padding = '0 12px';
  select.style.cursor = 'pointer';
  select.style.outline = 'none';
  select.addEventListener('change', () => {
    _crmDetailConnId = select.value || null;
    if (crmDetailContactId && _crmDetailConnId) localStorage.setItem(`crmDetailConn_${crmDetailContactId}`, _crmDetailConnId);
  });

  wrap.appendChild(select);
  inputArea.insertBefore(wrap, input);
  wrap.style.display = 'none';
}

function refreshCrmConnectionPicker() {
  const wrap = document.getElementById('crm-detail-conn-wrap');
  const select = document.getElementById('crm-detail-conn-select');
  if (!wrap || !select) return;
  wrap.style.display = 'none';
}

function buildCrmContactId(card) {
  if (card?.whatsappId && String(card.whatsappId).endsWith('@g.us')) return card.whatsappId;
  const whatsapp = String(card?.whatsapp || '').replace(/\D/g, '');
  if (whatsapp) return `${whatsapp}@c.us`;
  if (card?.whatsappId) return card.whatsappId;
  const phone = String(card?.phone || '').replace(/\D/g, '');
  if (phone) return `${phone}@c.us`;
  return null;
}

function setCrmConversationHeader(card) {
  const contactId = crmDetailContactId || '';
  const name = card?.contactName || document.getElementById('crm-card-name')?.value || 'Lead';
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const hue = [...(contactId || name || '')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const _WA_PHONE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:58%;height:58%;"><path fill="white" d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.12-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/></svg>';
  const avatarEl = document.getElementById('crm-convo-avatar');
  if (avatarEl) {
    const _crmConv = (_allConvs || []).find(c => c.contactId === contactId);
    const _picUrl = _crmConv?.profilePicUrl;
    if (_picUrl) {
      avatarEl.style.background = '#dfe2e6';
      avatarEl.innerHTML = `<img src="${escapeHtml(_picUrl)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.parentElement.style.background='#25D366';this.remove()">`;
    } else {
      avatarEl.style.background = '#25D366';
      avatarEl.innerHTML = _WA_PHONE_SVG;
    }
  }
  const nameEl = document.getElementById('crm-convo-name');
  const subEl = document.getElementById('crm-convo-sub');
  if (nameEl) nameEl.textContent = name || 'Lead';
  if (subEl) subEl.textContent = contactId ? contactId.replace('@c.us', '').replace('@g.us', ' (grupo)').replace('@lid', '').replace('@s.whatsapp.net', '') : 'sem WhatsApp vinculado';
}

function toggleCrmLeadPanel() {
  const detail = document.getElementById('crm-detail-view');
  detail?.classList.toggle('crm-panel-collapsed');
  const collapsed = detail?.classList.contains('crm-panel-collapsed');
  const btn = document.getElementById('btn-crm-panel-toggle');
  if (btn) {
    btn.title = collapsed ? 'Mostrar dados do lead' : 'Recolher dados do lead';
    btn.innerHTML = collapsed
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  }
}

function showCrmBoardView() {
  const phoneInput = document.getElementById('crm-card-phone');
  if (phoneInput) { phoneInput.disabled = false; phoneInput.placeholder = '5511999999999'; }
  stopCrmDetailPolling();
  document.getElementById('main-content')?.classList.remove('crm-chat-mode');
  document.getElementById('crm-board-view').style.display = 'flex';
  document.getElementById('crm-board-view').style.flexDirection = 'column';
  document.getElementById('crm-detail-view').style.display = 'none';
  editingCardId = null;
  crmDetailContactId = null;
  editingCrmWhatsappId = null;
  _optimisticCrmMessages = [];
  _crmRenderKey = '';
  loadCrm();
}

function setupZooghyLeadTabs() {
  const panel = document.querySelector('#crm-detail-view .crm-detail-left');
  if (!panel) return;
  const enabled = true; // CRM Kommo-style layout — habilitado para todos os clientes
  let tabs = document.getElementById('crm-zoo-tabs');
  if (!enabled) { tabs?.remove(); panel.classList.remove('zoo-tab-principal', 'zoo-tab-comments'); return; }
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'crm-zoo-tabs';
    tabs.className = 'crm-zoo-tabs';
    tabs.innerHTML = '<button type="button" class="crm-zoo-tab active" data-zt="principal">Principal</button>'
                   + '<button type="button" class="crm-zoo-tab" data-zt="comments">Coment\u00e1rios</button>';
    panel.insertBefore(tabs, panel.firstChild);
    tabs.querySelectorAll('.crm-zoo-tab').forEach(b => b.addEventListener('click', () => setZooLeadTab(b.dataset.zt)));
  }
  setZooLeadTab('principal');
}

function setZooLeadTab(which) {
  const panel = document.querySelector('#crm-detail-view .crm-detail-left');
  if (!panel) return;
  panel.classList.toggle('zoo-tab-principal', which === 'principal');
  panel.classList.toggle('zoo-tab-comments', which === 'comments');
  document.querySelectorAll('#crm-zoo-tabs .crm-zoo-tab').forEach(b => b.classList.toggle('active', b.dataset.zt === which));
}

function zooDisplayValue(def) {
  const el = document.getElementById(def.inputId);
  if (!el) return '';
  if (def.select) { const o = el.options[el.selectedIndex]; return o ? o.textContent.trim() : ''; }
  return el.value || '';
}

const ZOO_FIELD_DEFS = [
  { label: 'Nome', inputId: 'crm-card-name' },
  { label: 'Telefone', inputId: 'crm-card-phone', link: 'tel' },
  { label: 'WhatsApp', inputId: 'crm-card-whatsapp', link: 'whatsapp' },
  { label: 'Instagram', inputId: 'crm-card-instagram', link: 'instagram' },
  { label: 'Site', inputId: 'crm-card-site', link: 'site' },
  { label: 'Email', inputId: 'crm-card-email', link: 'email' },
  { label: 'Cidade', inputId: 'crm-card-cidade' },
  { label: 'Estado', inputId: 'crm-card-estado', select: true },
  { label: 'Coluna', inputId: 'crm-card-column', select: true },
];

function renderCrmLeadInfoParsed(card) {
  const enabled = true; // CRM Kommo-style layout — habilitado para todos os clientes
  document.getElementById('crm-lead-info-parsed')?.remove();
  document.getElementById('crm-zoo-contact')?.remove();
  if (!enabled) return;
  const panel = document.querySelector('#crm-detail-view .crm-detail-left');
  if (!panel) return;
  _zooCurrentCard = card;

  const emptyDash = '<span class="crm-empty">—</span>';

  // 1) Card de contato (campos padrao, editaveis por duplo clique)
  const contact = document.createElement('div');
  contact.id = 'crm-zoo-contact';
  contact.className = 'crm-lead-info';
  contact.innerHTML = '<div class="crm-lead-info-title">Contato</div>' + ZOO_FIELD_DEFS.map(d => {
    const v = zooDisplayValue(d);
    const attrs = 'data-input="' + d.inputId + '"' + (d.select ? ' data-select="1"' : '') + (d.link ? ' data-link="' + d.link + '"' : '');
    const title = d.link ? 'Clique para abrir, lapis para editar' : (d.select ? '' : '2 cliques para editar');
    const valHtml = d.link ? zooLinkValueHtml(d.link, v) : (escapeHtml(v) || emptyDash);
    return '<div class="crm-lead-info-row crm-edit-row" ' + attrs + ' title="' + title + '"><span class="crm-lead-info-k">' + escapeHtml(d.label) + '</span><span class="crm-lead-info-v">' + valHtml + '</span></div>';
  }).join('');

  // 2) Card DADOS DO LEAD (parseado das notas, editavel)
  const notes = String(card?.notes || '');
  const rows = notes.split(/\n+/).map(l => l.trim()).filter(Boolean)
    .map(l => { const m = l.match(/^([^:]{1,40}):\s*(.+)$/); return m ? { k: m[1].trim(), v: m[2].trim() } : null; })
    .filter(Boolean);
  let leadInfo = null;
  if (rows.length) {
    leadInfo = document.createElement('div');
    leadInfo.id = 'crm-lead-info-parsed';
    leadInfo.className = 'crm-lead-info';
    leadInfo.innerHTML = '<div class="crm-lead-info-title">Dados do lead</div>' + rows.map((r, i) =>
      '<div class="crm-lead-info-row crm-edit-row" data-note="' + i + '" title="2 cliques para editar"><span class="crm-lead-info-k">' + escapeHtml(r.k) + '</span><span class="crm-lead-info-v">' + escapeHtml(r.v) + '</span></div>'
    ).join('');
  }

  const tabs = document.getElementById('crm-zoo-tabs');
  const ref = tabs ? tabs.nextSibling : panel.firstChild;
  panel.insertBefore(contact, ref);
  if (leadInfo) panel.insertBefore(leadInfo, contact.nextSibling);

  contact.querySelectorAll('.crm-edit-row').forEach(row => {
    if (row.dataset.select === '1') zooMakeInlineSelect(row);
    else if (row.dataset.link) zooBindLinkRow(row);
    else row.addEventListener('dblclick', () => zooEditFieldRow(row));
  });
  if (leadInfo) leadInfo.querySelectorAll('.crm-edit-row').forEach(row => row.addEventListener('dblclick', () => zooEditNoteRow(row)));
}

function zooMakeInlineSelect(row) {
  const src = document.getElementById(row.dataset.input);
  const valSpan = row.querySelector('.crm-lead-info-v');
  if (!src || !valSpan) return;
  const sel = src.cloneNode(true);
  sel.removeAttribute('id');
  sel.className = 'crm-row-select';
  sel.value = src.value;
  sel.addEventListener('change', () => { src.value = sel.value; saveCrmCard(); });
  valSpan.replaceWith(sel);
}

let _zooCurrentCard = null;

function zooLinkHref(type, v) {
  v = (v || '').trim();
  if (!v) return '#';
  if (type === 'instagram') return 'https://instagram.com/' + v.replace(/^@/, '');
  if (type === 'phone' || type === 'whatsapp') return 'https://wa.me/' + v.replace(/\D/g, '');
  if (type === 'tel') return 'tel:+' + v.replace(/\D/g, '');
  if (type === 'email') return 'mailto:' + v.replace(/\s/g, '').replace(/;/g, ',');
  return v.startsWith('http') ? v : 'https://' + v;
}

function zooLinkValueHtml(type, value) {
  const v = (value || '').trim();
  const linkPart = v
    ? '<a href="' + zooLinkHref(type, v) + '" target="_blank" rel="noopener" class="crm-row-link" onclick="event.stopPropagation()">' + escapeHtml(v) + '</a>'
    : '<span class="crm-empty">\u2014</span>';
  return linkPart + '<button type="button" class="crm-row-edit" title="Editar">\u270E</button>';
}

function zooBindLinkRow(row) {
  const btn = row.querySelector('.crm-row-edit');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); zooEditLinkField(row); });
}

function zooEditLinkField(row) {
  if (row.querySelector('.crm-edit-input')) return;
  const src = document.getElementById(row.dataset.input);
  const valSpan = row.querySelector('.crm-lead-info-v');
  if (!src || !valSpan) return;
  const editor = document.createElement('input');
  editor.type = 'text'; editor.value = src.value || ''; editor.className = 'crm-edit-input';
  valSpan.replaceWith(editor);
  editor.focus(); editor.select();
  let done = false;
  const commit = () => { if (done) return; done = true; src.value = editor.value; saveCrmCard(); renderCrmLeadInfoParsed(_zooCurrentCard); };
  const cancel = () => { if (done) return; done = true; renderCrmLeadInfoParsed(_zooCurrentCard); };
  editor.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  editor.addEventListener('blur', commit);
}

function zooFinishEditor(editor, valueHtml) {
  const span = document.createElement('span');
  span.className = 'crm-lead-info-v';
  span.innerHTML = valueHtml || '<span class="crm-empty">—</span>';
  editor.replaceWith(span);
}

function zooEditFieldRow(row) {
  if (row.querySelector('.crm-edit-input')) return;
  const isSelect = row.dataset.select === '1';
  const src = document.getElementById(row.dataset.input);
  if (!src) return;
  const valSpan = row.querySelector('.crm-lead-info-v');
  let editor;
  if (isSelect) { editor = src.cloneNode(true); editor.removeAttribute('id'); editor.value = src.value; }
  else { editor = document.createElement('input'); editor.type = 'text'; editor.value = src.value || ''; }
  editor.className = 'crm-edit-input';
  valSpan.replaceWith(editor);
  editor.focus(); if (editor.select) editor.select();
  let done = false;
  const valFor = (el) => { if (isSelect) { const o = el.options[el.selectedIndex]; return o ? o.textContent.trim() : ''; } return el.value; };
  const commit = () => { if (done) return; done = true; src.value = editor.value; zooFinishEditor(editor, escapeHtml(valFor(editor))); saveCrmCard(); };
  const cancel = () => { if (done) return; done = true; zooFinishEditor(editor, escapeHtml(valFor(src))); };
  editor.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  if (isSelect) editor.addEventListener('change', commit);
  editor.addEventListener('blur', commit);
}

function zooEditNoteRow(row) {
  if (row.querySelector('.crm-edit-input')) return;
  const valSpan = row.querySelector('.crm-lead-info-v');
  const original = valSpan.textContent;
  const editor = document.createElement('input');
  editor.type = 'text'; editor.value = original; editor.className = 'crm-edit-input';
  valSpan.replaceWith(editor);
  editor.focus(); editor.select();
  let done = false;
  const rebuildNotes = () => {
    const ta = document.getElementById('crm-card-notes');
    if (!ta) return;
    const lines = [];
    document.querySelectorAll('#crm-lead-info-parsed .crm-edit-row').forEach(r => {
      const k = r.querySelector('.crm-lead-info-k').textContent;
      const vEl = r.querySelector('.crm-edit-input') || r.querySelector('.crm-lead-info-v');
      const v = vEl.tagName === 'INPUT' ? vEl.value : vEl.textContent;
      lines.push(k + ': ' + v);
    });
    ta.value = lines.join('\n');
  };
  const commit = () => { if (done) return; done = true; const v = editor.value; rebuildNotes(); zooFinishEditor(editor, escapeHtml(v)); saveCrmCard(); };
  const cancel = () => { if (done) return; done = true; zooFinishEditor(editor, escapeHtml(original)); };
  editor.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  editor.addEventListener('blur', commit);
}


function showCrmDetailView(card) {
  document.getElementById('main-content')?.classList.add('crm-chat-mode');
  document.getElementById('crm-detail-view').classList.remove('crm-panel-collapsed');
  const panelBtn = document.getElementById('btn-crm-panel-toggle');
  if (panelBtn) {
    panelBtn.title = 'Recolher dados do lead';
    panelBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  }
  document.getElementById('crm-board-view').style.display = 'none';
  document.getElementById('crm-detail-view').style.display = 'flex';
  document.getElementById('crm-detail-view').style.flexDirection = 'column';

  const title = card?.contactName || 'Novo Lead';
  document.getElementById('crm-detail-title').textContent = title;

  // Fill form fields
  document.getElementById('crm-card-id').value = card?.id || '';
  document.getElementById('crm-card-name').value = card?.contactName || '';
  const phoneInput = document.getElementById('crm-card-phone');
  const isGroupCard = String(card?.whatsappId || '').endsWith('@g.us');
  phoneInput.value = isGroupCard ? '' : (card?.phone || '');
  phoneInput.disabled = isGroupCard;
  phoneInput.placeholder = isGroupCard ? 'Grupo do WhatsApp' : '5511999999999';
  document.getElementById('crm-card-instagram').value = card?.instagram || '';
  document.getElementById('crm-card-site').value = card?.site || '';
  { const e=document.getElementById('crm-card-email'); if(e) e.value = card?.email || ''; }
  { const w=document.getElementById('crm-card-whatsapp'); if(w) w.value = card?.whatsapp || ''; }
  document.getElementById('crm-card-notes').value = card?.notes || '';
  const cidadeInput = document.getElementById('crm-card-cidade');
  if (cidadeInput) cidadeInput.value = card?.cidade || '';
  const estadoSel = document.getElementById('crm-card-estado');
  if (estadoSel) estadoSel.value = card?.estado || '';
  updateCrmCardLinks();
  renderCrmDetailChecks((card && card.checks) || {});
  if (typeof renderCrmDetailCustom === 'function') renderCrmDetailCustom(card);
  document.getElementById('btn-delete-crm-card').style.display = card?.id ? 'inline-flex' : 'none';
  selectCrmLabel(Array.isArray(card?.labels) ? card.labels : (card?.label || null));

  const sel = document.getElementById('crm-card-column');
  sel.innerHTML = crmColumns.map(col => `<option value="${col.id}"${col.id === card?.columnId ? ' selected' : ''}>${escapeHtml(col.name)}</option>`).join('');

  document.getElementById('crm-card-feedback').style.display = 'none';
  setupZooghyLeadTabs();
  renderCrmLeadInfoParsed(card);

  editingCrmWhatsappId = card?.whatsappId || null;
  crmDetailContactId = buildCrmContactId(card);
  _optimisticCrmMessages = [];
  setCrmConversationHeader(card);
  refreshCrmConnectionPicker();
  if (crmDetailContactId) {
    loadCrmDetailMessages();
    startCrmDetailPolling();
    setTimeout(() => document.getElementById('crm-detail-input')?.focus(), 80);
  } else {
    document.getElementById('crm-detail-messages').innerHTML = '<div class="chat-empty-area">Adicione o telefone ou grupo do WhatsApp para ver a conversa</div>';
  }

  if (card?.id) {
    loadCrmComments(card.id);
    loadCrmFiles(card.id);
    crmActSwitchTab('comments');
  } else {
    document.getElementById('crm-comments-list').innerHTML = '';
    document.getElementById('crm-files-list').innerHTML = '';
  }
}

// ── CRM Activity ─────────────────────────────────────────────────────────────

function crmActSwitchTab(tab) {
  document.querySelectorAll('.crm-act-tab').forEach(b => b.classList.toggle('active', b.dataset.act === tab));
  document.getElementById('crm-act-comments').style.display = tab === 'comments' ? '' : 'none';
  document.getElementById('crm-act-files').style.display    = tab === 'files'    ? '' : 'none';
}

async function loadCrmComments(cardId) {
  const list = document.getElementById('crm-comments-list');
  list.innerHTML = '';
  try {
    const rows = await apiFetch(`/api/crm/cards/${cardId}/comments`).then(r => r.json());
    if (!rows.length) { list.innerHTML = '<div style="font-size:12px;color:#8696a0;text-align:center;padding:10px 0;">Nenhum comentário ainda</div>'; return; }
    rows.forEach(c => list.appendChild(buildCommentEl(cardId, c)));
    list.scrollTop = list.scrollHeight;
  } catch {}
}

function buildCommentEl(cardId, c) {
  const div = document.createElement('div');
  div.className = 'crm-comment-item';
  div.dataset.id = c.id;
  div.dataset.initial = (String(c.author || 'U').trim()[0] || 'U').toUpperCase();
  const dt = new Date(c.created_at || c.createdAt).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  div.innerHTML = `
    <div class="crm-comment-author">${escapeHtml(c.author || 'Usuário')}</div>
    <div class="crm-comment-text">${escapeHtml(c.text)}</div>
    <div class="crm-comment-meta">${dt}</div>
    <button class="crm-comment-del" title="Excluir" onclick="deleteCrmComment('${cardId}','${c.id}',this.closest('.crm-comment-item'))">✕</button>
  `;
  return div;
}

async function addCrmComment() {
  const cardId = document.getElementById('crm-card-id').value;
  if (!cardId) return;
  const ta = document.getElementById('crm-comment-text');
  const text = ta.value.trim();
  if (!text) return;
  const btn = document.getElementById('btn-add-comment');
  btn.disabled = true;
  try {
    const c = await apiFetch(`/api/crm/cards/${cardId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    }).then(r => r.json());
    ta.value = '';
    const list = document.getElementById('crm-comments-list');
    const empty = list.querySelector('div[style]');
    if (empty) empty.remove();
    list.appendChild(buildCommentEl(cardId, c));
    list.scrollTop = list.scrollHeight;
  } catch {}
  btn.disabled = false;
}

async function deleteCrmComment(cardId, commentId, el) {
  if (!confirm('Excluir comentário?')) return;
  await apiFetch(`/api/crm/cards/${cardId}/comments/${commentId}`, { method: 'DELETE' }).catch(() => {});
  el?.remove();
  const list = document.getElementById('crm-comments-list');
  if (!list.querySelector('.crm-comment-item')) list.innerHTML = '<div style="font-size:12px;color:#8696a0;text-align:center;padding:10px 0;">Nenhum comentário ainda</div>';
}

async function loadCrmFiles(cardId) {
  const list = document.getElementById('crm-files-list');
  list.innerHTML = '';
  try {
    const rows = await apiFetch(`/api/crm/cards/${cardId}/files`).then(r => r.json());
    if (!rows.length) { list.innerHTML = '<div style="font-size:12px;color:#8696a0;text-align:center;padding:10px 0;">Nenhum arquivo ainda</div>'; return; }
    rows.forEach(f => list.appendChild(buildFileEl(cardId, f)));
  } catch {}
}

function buildFileEl(cardId, f) {
  const div = document.createElement('div');
  div.className = 'crm-file-item';
  div.dataset.id = f.id;
  const icon = fileIcon(f.mime || f.name);
  const size = f.size ? formatFileSize(f.size) : '';
  div.innerHTML = `
    <span class="crm-file-icon">${icon}</span>
    <div class="crm-file-info">
      <div class="crm-file-name"><a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a></div>
      ${size ? `<div class="crm-file-size">${size}</div>` : ''}
    </div>
    <button class="crm-file-del" title="Excluir" onclick="deleteCrmFile('${cardId}','${f.id}',this.closest('.crm-file-item'))">✕</button>
  `;
  return div;
}

async function uploadCrmFiles(files) {
  const cardId = document.getElementById('crm-card-id').value;
  if (!cardId || !files.length) return;
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const f = await apiFetch(`/api/crm/cards/${cardId}/files`, { method: 'POST', headers: {}, body: fd }).then(r => r.json());
      const list = document.getElementById('crm-files-list');
      const empty = list.querySelector('div[style]');
      if (empty) empty.remove();
      list.appendChild(buildFileEl(cardId, f));
    } catch {}
  }
}

async function deleteCrmFile(cardId, fileId, el) {
  if (!confirm('Excluir arquivo?')) return;
  await apiFetch(`/api/crm/cards/${cardId}/files/${fileId}`, { method: 'DELETE' }).catch(() => {});
  el?.remove();
  const list = document.getElementById('crm-files-list');
  if (!list.querySelector('.crm-file-item')) list.innerHTML = '<div style="font-size:12px;color:#8696a0;text-align:center;padding:10px 0;">Nenhum arquivo ainda</div>';
}

function fileIcon(mimeOrName) {
  const m = (mimeOrName || '').toLowerCase();
  if (m.includes('image')) return '🖼️';
  if (m.includes('pdf')) return '📄';
  if (m.includes('video')) return '🎬';
  if (m.includes('audio')) return '🎵';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z')) return '📦';
  if (m.includes('sheet') || m.includes('xlsx') || m.includes('csv')) return '📊';
  if (m.includes('doc') || m.includes('word')) return '📝';
  return '📎';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadCrm() {
  try {
    const funnels = await apiFetch('/api/funnels').then(r => r.json());
    crmFunnels = Array.isArray(funnels) ? funnels : [];
    if (crmFunnels.length > 0 && !currentFunnelId) currentFunnelId = crmFunnels[0].id;

    const sel = document.getElementById('crm-funnel-select');
    sel.innerHTML = crmFunnels.map(f => `<option value="${f.id}"${f.id === currentFunnelId ? ' selected' : ''}>${escapeHtml(crmFunnelOptionLabel(f))}</option>`).join('');
    refreshCrmFunnelConnectionPicker();

    const qs = currentFunnelId ? `?funnelId=${currentFunnelId}` : '';
    const [colRes, cardRes] = await Promise.all([
      apiFetch(`/api/crm/columns${qs}`).then(r => r.json()),
      apiFetch(`/api/crm/cards${qs}`).then(r => r.json())
    ]);
    crmColumns = Array.isArray(colRes) ? colRes : [];
    crmCards = Array.isArray(cardRes) ? cardRes : [];
    // Sync server-side unread flags into crmUnreadIds
    crmCards.forEach(c => { if (c.hasNewMessage) crmUnreadIds.add(c.id); });
    localStorage.setItem('crm-unread', JSON.stringify([...crmUnreadIds]));
    renderCrmBoard();
  } catch {}
}

function openFunnelModal(mode) {
  funnelModalMode = mode;
  const modal = document.getElementById('funnel-modal');
  document.getElementById('funnel-modal-title').textContent = mode === 'create' ? 'Novo funil' : 'Renomear funil';
  document.getElementById('funnel-modal-name').value = mode === 'rename' ? (crmFunnels.find(f => f.id === currentFunnelId)?.name || '') : '';
  document.getElementById('funnel-modal-feedback').style.display = 'none';
  modal.style.display = 'flex';
  document.getElementById('funnel-modal-name').focus();
}

async function saveFunnel() {
  const name = document.getElementById('funnel-modal-name').value.trim();
  const fbEl = document.getElementById('funnel-modal-feedback');
  if (!name) { showFeedback(fbEl, 'Digite o nome do funil', 'error'); return; }
  if (funnelModalMode === 'create') {
    const res = await apiFetch('/api/funnels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, chatConnectionId: null }) });
    const f = await res.json();
    currentFunnelId = f.id;
  } else {
    const current = crmFunnels.find(f => f.id === currentFunnelId);
    await apiFetch(`/api/funnels/${currentFunnelId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, chatConnectionId: current?.chatConnectionId || null }) });
  }
  document.getElementById('funnel-modal').style.display = 'none';
  await loadCrm();
}

async function deleteFunnel() {
  if (crmFunnels.length <= 1) { alert('Não é possível excluir o único funil.'); return; }
  if (!confirm('Excluir este funil e todos os cards dele?')) return;
  await apiFetch(`/api/funnels/${currentFunnelId}`, { method: 'DELETE' });
  currentFunnelId = null;
  await loadCrm();
}

// ─── Chat → CRM ─────────────────────────────
async function openAddToCrmModal() {
  const modal = document.getElementById('add-to-crm-modal');
  const convo = getConversationById(selectedChatContactId);
  const isGroup = String(selectedChatContactId || '').endsWith('@g.us');
  const currentName = document.getElementById('wa-convo-name')?.textContent || convo?.contactName || '';
  document.getElementById('atc-name').value = isGroup ? (currentName || 'Grupo') : cleanChatDisplayName(currentName, selectedChatContactId, '');
  document.getElementById('atc-phone').value = isGroup ? '' : extractPhoneFromWhatsappId(selectedChatContactId);
  document.getElementById('atc-phone').disabled = isGroup;
  document.getElementById('atc-phone').placeholder = isGroup ? 'Grupo do WhatsApp' : '55DDDNUMERO';
  const funnels = await apiFetch('/api/funnels').then(r => r.json());
  const atcFunnel = document.getElementById('atc-funnel');
  atcFunnel.innerHTML = funnels.map(f => `<option value="${f.id}">${escapeHtml(crmFunnelOptionLabel(f))}</option>`).join('');
  await loadAtcColumns();
  document.getElementById('atc-feedback').style.display = 'none';
  modal.style.display = 'flex';
  document.getElementById('atc-name')?.focus();
}

async function loadAtcColumns() {
  const funnelId = document.getElementById('atc-funnel').value;
  const cols = await apiFetch(`/api/crm/columns?funnelId=${funnelId}`).then(r => r.json());
  document.getElementById('atc-column').innerHTML = cols.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

async function confirmAddToCrm() {
  const fbEl = document.getElementById('atc-feedback');
  const funnelId = document.getElementById('atc-funnel').value;
  const columnId = document.getElementById('atc-column').value;
  const typedName = document.getElementById('atc-name')?.value?.trim() || '';
  const typedPhone = document.getElementById('atc-phone')?.value?.replace(/\D/g, '') || '';
  const whatsappId = selectedChatContactId || '';
  const isGroup = whatsappId.endsWith('@g.us');
  const phone = isGroup ? '' : (typedPhone || extractPhoneFromWhatsappId(whatsappId));
  const contactName = typedName || (isGroup ? (document.querySelector('.conv-item.active .conv-name')?.textContent || 'Grupo') : cleanChatDisplayName(document.querySelector('.conv-item.active .conv-name')?.textContent, whatsappId, phone || 'Contato'));
  const safeWhatsappId = isGroup ? whatsappId : (phone ? `${phone}@c.us` : whatsappId);
  const res = await apiFetch('/api/crm/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, funnelId, contactName, phone, whatsappId: safeWhatsappId })
  });
  if (!res.ok) { showFeedback(fbEl, 'Erro ao adicionar', 'error'); return; }
  showFeedback(fbEl, '✅ Adicionado ao CRM!', 'ok');
  setTimeout(() => { document.getElementById('add-to-crm-modal').style.display = 'none'; }, 1200);
}

function toggleCrmViewMode() {
  _crmViewMode = _crmViewMode === 'board' ? 'list' : 'board';
  localStorage.setItem('crm-view-mode', _crmViewMode);
  const btn = document.getElementById('btn-crm-view-toggle');
  if (btn) btn.title = _crmViewMode === 'board' ? 'Vista lista' : 'Vista kanban';
  renderCrmBoard();
}

function renderCrmList() {
  const board = document.getElementById('crm-board');
  if (!board) return;
  const searchTerm = (document.getElementById('crm-search')?.value || '').toLowerCase().trim();
  const labelColors = { 'Em andamento': '#ffd43b', 'Não respondeu': '#ff6b6b', 'Finalizado': '#69db7c' };
  let cards = crmCards.filter(c =>
    !searchTerm ||
    (c.contactName || '').toLowerCase().includes(searchTerm) ||
    (c.phone || '').includes(searchTerm) ||
    (c.notes || '').toLowerCase().includes(searchTerm) ||
    (c.cidade || '').toLowerCase().includes(searchTerm) ||
    (c.estado || '').toLowerCase().includes(searchTerm)
  );
  board.innerHTML = `<div class="crm-list-view">
    <table class="crm-list-table">
      <thead><tr>
        <th>Nome</th><th>Label</th><th>Telefone</th><th>Cidade/UF</th><th>Coluna</th><th>Anotações</th>
      </tr></thead>
      <tbody>${cards.map(card => {
        const col = crmColumns.find(c => c.id === card.columnId);
        const lbl = (Array.isArray(card.labels) ? card.labels[0] : card.label) || '';
        const lc = lbl ? (labelColors[lbl] || '#aaa') : null;
        const labelBadge = lc ? `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:${lc}22;color:${lc};border:1px solid ${lc}44;">${escapeHtml(lbl)}</span>` : '<span style="color:var(--text3)">—</span>';
        return `<tr class="crm-list-row" onclick="openCrmCardModal('${card.id}')">
          <td><strong>${escapeHtml(card.contactName || '(sem nome)')}</strong></td>
          <td>${labelBadge}</td>
          <td>${escapeHtml(card.phone || '—')}</td>
          <td style="color:var(--text2)">${escapeHtml([card.cidade, card.estado].filter(Boolean).join(' / ') || '—')}</td>
          <td style="color:var(--text2)">${escapeHtml(col?.name || '—')}</td>
          <td class="crm-list-notes">${escapeHtml(card.notes ? card.notes.slice(0, 80) + (card.notes.length > 80 ? '…' : '') : '—')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

function renderCrmBoard() {
  if (_crmViewMode === 'list') { renderCrmList(); return; }
  const board = document.getElementById('crm-board');
  if (!board) return;
  if (crmColumns.length === 0) {
    board.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><use href="#i-layers"/></svg></div><div>Nenhuma coluna ainda. Clique em "+ Nova coluna" para começar.</div></div>`;
    return;
  }
  const searchTerm = (document.getElementById('crm-search')?.value || '').toLowerCase().trim();
  board.innerHTML = crmColumns.map(col => {
    let cards = crmCards.filter(c => c.columnId === col.id);
    // Mais novo no topo
    cards = cards.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // Filtro de busca
    if (searchTerm) cards = cards.filter(c =>
      (c.contactName || '').toLowerCase().includes(searchTerm) ||
      (c.phone || '').includes(searchTerm) ||
      (c.notes || '').toLowerCase().includes(searchTerm) ||
      (c.cidade || '').toLowerCase().includes(searchTerm) ||
      (c.estado || '').toLowerCase().includes(searchTerm)
    );
    return `
      <div class="crm-column" draggable="true" data-col-id="${col.id}">
        <div class="crm-col-header" style="cursor:grab;">
          <span class="crm-col-drag" title="Arrastar coluna" style="color:var(--text3);margin-right:4px;cursor:grab;">⠿</span>
          <span class="crm-col-title">${escapeHtml(col.name)}</span>
          <span class="crm-col-count">${cards.length}</span>
          <div class="crm-col-actions">
            <button class="crm-col-btn" onclick="openEditColModal('${col.id}')" title="Editar coluna">${icon('edit')}</button>
            <button class="crm-col-btn" onclick="openAddCardModal('${col.id}')" title="Novo card">+</button>
          </div>
        </div>
        <div class="crm-cards" data-col-id="${col.id}">
          ${cards.map(card => renderCrmCardHtml(card)).join('')}
          ${cards.length === 0 ? '<div class="crm-empty-col">Arraste cards aqui ou clique em +</div>' : ''}
        </div>
      </div>`;
  }).join('');
  setupCrmCardDragAndDrop();
  setupCrmColumnDragAndDrop();
}

function setupCrmCardDragAndDrop() {
  const board = document.getElementById('crm-board');
  if (!board) return;
  board.querySelectorAll('.crm-card').forEach(cardEl => {
    cardEl.addEventListener('dragstart', e => {
      crmDraggedCardId = cardEl.dataset.cardId;
      crmDragStartedAt = Date.now();
      cardEl.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', crmDraggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      crmDraggedCardId = null;
      board.querySelectorAll('.crm-card, .crm-cards').forEach(el => el.classList.remove('is-dragging', 'is-drag-over'));
    });
  });

  board.querySelectorAll('.crm-cards').forEach(dropZone => {
    dropZone.addEventListener('dragover', e => {
      if (!crmDraggedCardId) return;
      e.preventDefault();
      dropZone.classList.add('is-drag-over');
      e.dataTransfer.dropEffect = 'move';
    });
    dropZone.addEventListener('dragleave', e => {
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('is-drag-over');
    });
    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.classList.remove('is-drag-over');
      const cardId = e.dataTransfer.getData('text/plain') || crmDraggedCardId;
      const columnId = dropZone.dataset.colId;
      await moveCrmCardToColumn(cardId, columnId);
    });
  });
}

function setupCrmColumnDragAndDrop() {
  const board = document.getElementById('crm-board');
  if (!board) return;
  board.querySelectorAll('.crm-column').forEach(colEl => {
    colEl.addEventListener('dragstart', e => {
      if (e.target.closest('.crm-card')) return; // let card drag take over
      crmDraggedColId = colEl.dataset.colId;
      crmDraggedCardId = null;
      colEl.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('crm-col', crmDraggedColId);
    });
    colEl.addEventListener('dragend', () => {
      crmDraggedColId = null;
      board.querySelectorAll('.crm-column').forEach(el => el.classList.remove('is-dragging', 'is-col-drag-over'));
    });
    colEl.addEventListener('dragover', e => {
      if (!crmDraggedColId || crmDraggedColId === colEl.dataset.colId) return;
      e.preventDefault();
      colEl.classList.add('is-col-drag-over');
      e.dataTransfer.dropEffect = 'move';
    });
    colEl.addEventListener('dragleave', e => {
      if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('is-col-drag-over');
    });
    colEl.addEventListener('drop', async e => {
      e.preventDefault();
      const srcColId = e.dataTransfer.getData('crm-col') || crmDraggedColId;
      const tgtColId = colEl.dataset.colId;
      if (!srcColId || srcColId === tgtColId) return;
      board.querySelectorAll('.crm-column').forEach(el => el.classList.remove('is-col-drag-over'));
      const srcIdx = crmColumns.findIndex(c => c.id === srcColId);
      const tgtIdx = crmColumns.findIndex(c => c.id === tgtColId);
      if (srcIdx === -1 || tgtIdx === -1) return;
      const [moved] = crmColumns.splice(srcIdx, 1);
      crmColumns.splice(tgtIdx, 0, moved);
      renderCrmBoard();
      try {
        await apiFetch('/api/crm/columns/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: crmColumns.map(c => c.id) })
        });
      } catch { await loadCrm(); }
    });
  });
}

async function moveCrmCardToColumn(cardId, columnId) {
  if (!cardId || !columnId) return;
  const card = crmCards.find(c => c.id === cardId);
  if (!card || card.columnId === columnId) return;
  const previousColumnId = card.columnId;
  card.columnId = columnId;
  renderCrmBoard();
  try {
    const res = await apiFetch(`/api/crm/cards/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, funnelId: currentFunnelId || card.funnelId })
    });
    if (!res.ok) throw new Error('Erro ao mover card');
    const saved = await res.json();
    crmCards = crmCards.map(c => c.id === cardId ? saved : c);
    renderCrmBoard();
  } catch (e) {
    card.columnId = previousColumnId;
    renderCrmBoard();
    alert(e.message || 'Erro ao mover card');
  }
}

function renderCrmCardHtml(card) {
  const labelColors = { 'Em andamento': '#ffd43b', 'Não respondeu': '#ff6b6b', 'Finalizado': '#69db7c' };
  const cardLabels = Array.isArray(card.labels) ? card.labels : (card.label ? [card.label] : []);
  const lc = cardLabels[0] ? labelColors[cardLabels[0]] || '#aaa' : null;
  const checks = card.checks || {};
  const checkCount = Object.values(checks || {}).filter(Boolean).length;
  const unreadClass = crmUnreadIds.has(card.id) ? ' crm-card-unread' : '';
  const displayName = card.contactName || '(sem nome)';
  const rawId = card.whatsappId || card.phone || card.id || '';
  const hue = [...String(rawId)].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const avatarStyle = `width:28px;height:28px;border-radius:50%;flex-shrink:0;object-fit:cover;`;
  const avatarDiv = `<div class="def-avatar" style="${avatarStyle}background:hsl(${hue},40%,38%);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;"><svg viewBox="0 0 24 24" fill="#fff" style="width:56%;height:56%;opacity:.92"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 5.33V21h16v-1.67C20 16.67 17.33 14 12 14z"/></svg></div>`;
  const avatar = card.profilePicUrl
    ? `<img src="${escapeHtml(card.profilePicUrl)}" style="${avatarStyle}background:#dfe2e6;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${avatarDiv.replace('display:flex','display:none')}`
    : avatarDiv;
  return `
    <div class="crm-card${unreadClass}" draggable="true" data-card-id="${card.id}" onclick="if (Date.now() - crmDragStartedAt > 250) openCrmCardModal('${card.id}')" title="Abrir conversa">
      ${cardLabels.length ? `<div class="crm-card-label" style="background:${lc}22;color:${lc};">${escapeHtml(cardLabels.join(', '))}</div>` : ''}
      <div class="crm-card-head">
        ${avatar}
        <div class="crm-card-name">${escapeHtml(displayName)}</div>
      </div>
      <div class="crm-card-info">
        ${card.phone ? `<span>${icon('smartphone')} ${escapeHtml(card.phone)}</span>` : ''}
        ${card.instagram ? `<span>@${escapeHtml(card.instagram.replace(/^@/, ''))}</span>` : ''}
      </div>
      ${checkCount > 0 ? `<div class="crm-card-checks">${icon('check')} ${checkCount} feitos</div>` : ''}
      ${card.notes ? `<div class="crm-card-note">${escapeHtml(card.notes.slice(0, 70))}${card.notes.length > 70 ? '…' : ''}</div>` : ''}
    </div>`;
}

// ─── Column modal ─────────────────────────
// ─── Cards duplicados ───────────────────────
let _crmDupGroups = [];

async function openCrmDuplicatesModal() {
  const modal = document.getElementById('crm-duplicates-modal');
  const list = document.getElementById('crm-duplicates-list');
  const summary = document.getElementById('crm-duplicates-summary');
  modal.style.display = 'flex';
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3);">Procurando duplicados...</div>';
  summary.textContent = '';
  try {
    _crmDupGroups = await apiFetch('/api/crm/duplicates').then(r => r.json());
  } catch (e) {
    list.innerHTML = `<div style="color:#ff6b6b;padding:20px;">Erro ao buscar duplicados: ${e.message}</div>`;
    return;
  }
  if (!_crmDupGroups.length) {
    list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text3);">Nenhum card duplicado encontrado 🎉</div>';
    summary.textContent = '';
    updateCrmDupSelectedCount();
    return;
  }
  const totalCards = _crmDupGroups.reduce((s, g) => s + g.length, 0);
  summary.textContent = `${_crmDupGroups.length} grupo${_crmDupGroups.length !== 1 ? 's' : ''} · ${totalCards} cards no total`;
  renderCrmDupList();
  crmDupAutoSelect();
}

function renderCrmDupList() {
  const list = document.getElementById('crm-duplicates-list');
  list.innerHTML = _crmDupGroups.map((group, gi) => {
    const sorted = [...group].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return `<div class="crm-lead-info" style="margin-bottom:0;">
      <div class="crm-lead-info-title">${escapeHtml(sorted[0].contactName || '(sem nome)')} — ${sorted.length} cópias</div>
      ${sorted.map((card, i) => `
        <label style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #ececee;cursor:pointer;">
          <input type="checkbox" class="crm-dup-check" data-group="${gi}" data-card-id="${card.id}">
          <span style="flex:1;font-size:12.5px;">
            <b>${escapeHtml(card.contactName || '(sem nome)')}</b>
            ${card.phone ? ` · ${escapeHtml(card.phone)}` : ''}
            ${i === 0 ? ' <span style="color:var(--accent);font-weight:600;">(mais antigo)</span>' : ''}
          </span>
          <span style="font-size:11px;color:#9a9da4;">${card.createdAt ? new Date(card.createdAt).toLocaleDateString('pt-BR') : ''}</span>
        </label>`).join('')}
    </div>`;
  }).join('');
  list.querySelectorAll('.crm-dup-check').forEach(cb => cb.addEventListener('change', updateCrmDupSelectedCount));
}

function crmDupAutoSelect() {
  renderCrmDupList();
  _crmDupGroups.forEach((group, gi) => {
    const sorted = [...group].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    sorted.slice(1).forEach(card => {
      const cb = document.querySelector(`.crm-dup-check[data-group="${gi}"][data-card-id="${card.id}"]`);
      if (cb) cb.checked = true;
    });
  });
  updateCrmDupSelectedCount();
}

function updateCrmDupSelectedCount() {
  const n = document.querySelectorAll('.crm-dup-check:checked').length;
  document.getElementById('crm-duplicates-selected-count').textContent = n ? `${n} selecionado${n !== 1 ? 's' : ''} para excluir` : '';
  document.getElementById('btn-crm-dup-delete').disabled = n === 0;
}

async function crmDupDeleteSelected() {
  const ids = [...document.querySelectorAll('.crm-dup-check:checked')].map(cb => cb.dataset.cardId);
  if (!ids.length) return;
  if (!confirm(`Excluir ${ids.length} card${ids.length !== 1 ? 's' : ''} duplicado${ids.length !== 1 ? 's' : ''}? Isso não pode ser desfeito.`)) return;
  const fb = document.getElementById('crm-duplicates-feedback');
  const btn = document.getElementById('btn-crm-dup-delete');
  btn.disabled = true;
  try {
    await Promise.all(ids.map(id => apiFetch(`/api/crm/cards/${id}`, { method: 'DELETE' })));
    showFeedback(fb, `✅ ${ids.length} card(s) excluído(s).`, 'ok');
    await loadCrm();
    await openCrmDuplicatesModal();
  } catch (e) {
    showFeedback(fb, 'Erro ao excluir: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function openAddColModal() {
  document.getElementById('add-col-modal-title').textContent = 'Nova coluna';
  document.getElementById('edit-col-id').value = '';
  document.getElementById('add-col-name').value = '';
  document.getElementById('btn-delete-crm-col').style.display = 'none';
  document.getElementById('add-col-feedback').style.display = 'none';
  document.getElementById('add-col-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('add-col-name').focus(), 50);
}

function openEditColModal(colId) {
  const col = crmColumns.find(c => c.id === colId);
  if (!col) return;
  document.getElementById('add-col-modal-title').textContent = 'Editar coluna';
  document.getElementById('edit-col-id').value = colId;
  document.getElementById('add-col-name').value = col.name;
  document.getElementById('btn-delete-crm-col').style.display = 'inline-flex';
  document.getElementById('add-col-feedback').style.display = 'none';
  document.getElementById('add-col-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('add-col-name').focus(), 50);
}

function closeAddColModal() {
  document.getElementById('add-col-modal').style.display = 'none';
}

async function saveCrmColumn() {
  const name = document.getElementById('add-col-name').value.trim();
  if (!name) return;
  const fbEl = document.getElementById('add-col-feedback');
  const id = document.getElementById('edit-col-id').value;
  try {
    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/crm/columns/${id}` : '/api/crm/columns';
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, funnelId: currentFunnelId }) });
    if (!res.ok) throw new Error();
    closeAddColModal();
    await loadCrm();
  } catch {
    showFeedback(fbEl, 'Erro ao salvar coluna', 'error');
  }
}

async function deleteCrmColumn() {
  const id = document.getElementById('edit-col-id').value;
  if (!id) return;
  if (!confirm('Excluir esta coluna? Os cards serão movidos para a primeira coluna.')) return;
  try {
    await apiFetch(`/api/crm/columns/${id}`, { method: 'DELETE' });
    closeAddColModal();
    await loadCrm();
  } catch {}
}

// ─── Card modal ───────────────────────────
function openCrmCardModal(cardId) {
  const card = crmCards.find(c => c.id === cardId);
  if (!card) return;
  if (crmUnreadIds.has(cardId)) {
    crmUnreadIds.delete(cardId);
    localStorage.setItem('crm-unread', JSON.stringify([...crmUnreadIds]));
    const el = document.querySelector(`.crm-card[data-card-id="${cardId}"]`);
    if (el) el.classList.remove('crm-card-unread');
    apiFetch(`/api/crm/cards/${cardId}/mark-read`, { method: 'POST' }).catch(() => {});
  }
  editingCardId = cardId;
  showCrmDetailView(card);
}

function openAddCardModal(columnId) {
  editingCardId = null;
  showCrmDetailView({ columnId });
  setTimeout(() => document.getElementById('crm-card-name').focus(), 50);
}

function closeCrmCardModal() {
  showCrmBoardView();
}

function getSelectedCrmLabels() {
  return [...document.querySelectorAll('#crm-label-selector .crm-label-btn.active')].map(btn => btn.dataset.label).filter(Boolean);
}

function selectCrmLabel(labels) {
  const selected = Array.isArray(labels) ? labels : (labels ? [labels] : []);
  currentCrmLabel = selected[0] || null;
  document.querySelectorAll('#crm-label-selector .crm-label-btn').forEach(btn => {
    btn.classList.toggle('active', selected.includes(btn.dataset.label));
  });
}

function toggleCrmLabel(label) {
  const selected = new Set(getSelectedCrmLabels());
  if (selected.has(label)) selected.delete(label); else selected.add(label);
  selectCrmLabel([...selected]);
}

function updateCrmCardLinks() {
  const phone = (document.getElementById('crm-card-phone')?.value || '').replace(/\D/g, '');
  const phoneLink = document.getElementById('crm-link-phone');
  if (phoneLink) { if (phone) { phoneLink.href = 'https://wa.me/' + phone; phoneLink.style.display = ''; } else phoneLink.style.display = 'none'; }

  const instaRaw = (document.getElementById('crm-card-instagram')?.value || '').trim().replace(/^@/, '');
  const instaLink = document.getElementById('crm-link-instagram');
  if (instaLink) { if (instaRaw) { instaLink.href = 'https://instagram.com/' + instaRaw; instaLink.style.display = ''; } else instaLink.style.display = 'none'; }

  const site = (document.getElementById('crm-card-site')?.value || '').trim();
  const siteLink = document.getElementById('crm-link-site');
  if (siteLink) { if (site) { siteLink.href = site.startsWith('http') ? site : 'https://' + site; siteLink.style.display = ''; } else siteLink.style.display = 'none'; }
}

async function saveCrmCard() {
  const fbEl = document.getElementById('crm-card-feedback');
  const id = editingCardId;
  const phoneValue = document.getElementById('crm-card-phone').value.trim();
  const cleanPhoneForWhatsapp = phoneValue.replace(/\D/g, '');
  const currentWhatsappDigits = String(editingCrmWhatsappId || '').replace(/\D/g, '');
  const currentWhatsappIsLid = String(editingCrmWhatsappId || '').endsWith('@lid');
  const isGroupCard = String(editingCrmWhatsappId || '').endsWith('@g.us');
  const keepCurrentWhatsappId = !!editingCrmWhatsappId && (isGroupCard || currentWhatsappIsLid || !cleanPhoneForWhatsapp || currentWhatsappDigits === cleanPhoneForWhatsapp);
  const payload = {
    contactName: document.getElementById('crm-card-name').value.trim(),
    phone: isGroupCard ? '' : phoneValue,
    whatsappId: keepCurrentWhatsappId ? editingCrmWhatsappId : (cleanPhoneForWhatsapp ? `${cleanPhoneForWhatsapp}@c.us` : null),
    instagram: document.getElementById('crm-card-instagram').value.trim(),
    site: document.getElementById('crm-card-site').value.trim(),
    email: (document.getElementById('crm-card-email')?.value || '').trim(),
    whatsapp: (document.getElementById('crm-card-whatsapp')?.value || '').trim(),
    notes: document.getElementById('crm-card-notes').value.trim(),
    cidade: (document.getElementById('crm-card-cidade')?.value || '').trim(),
    estado: (document.getElementById('crm-card-estado')?.value || '').trim(),
    label: getSelectedCrmLabels()[0] || null,
    labels: getSelectedCrmLabels(),
    columnId: document.getElementById('crm-card-column').value,
    checks: readCrmDetailChecks()
  };
  try {
    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/crm/cards/${id}` : '/api/crm/cards';
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    const saved = await res.json();
    // Stay on detail view with updated data
    editingCardId = saved.id || id;
    document.getElementById('crm-card-id').value = editingCardId;
    document.getElementById('crm-detail-title').textContent = payload.contactName || 'Lead';
    document.getElementById('btn-delete-crm-card').style.display = 'inline-flex';
    showFeedback(fbEl, '✓ Salvo', 'success');
    // Update chat if phone changed
    editingCrmWhatsappId = saved.whatsappId || payload.whatsappId || null;
    const newContactId = buildCrmContactId({ phone: payload.phone, whatsappId: editingCrmWhatsappId });
    if (newContactId && newContactId !== crmDetailContactId) {
      crmDetailContactId = newContactId;
      _optimisticCrmMessages = [];
      loadCrmDetailMessages();
      startCrmDetailPolling();
    }
    setCrmConversationHeader({ contactName: payload.contactName, phone: payload.phone, whatsappId: editingCrmWhatsappId });
    // Update local cache
    await loadCrm();
  } catch {
    showFeedback(fbEl, 'Erro ao salvar', 'error');
  }
}

async function deleteCrmCard() {
  if (!editingCardId) return;
  if (!confirm('Excluir este card?')) return;
  try {
    await apiFetch(`/api/crm/cards/${editingCardId}`, { method: 'DELETE' });
    showCrmBoardView();
  } catch {}
}

function startCrmDetailPolling() {
  stopCrmDetailPolling();
  crmDetailPolling = setInterval(() => {
    if (crmDetailContactId) loadCrmDetailMessages();
  }, 1000);
}

function stopCrmDetailPolling() {
  if (crmDetailPolling) { clearInterval(crmDetailPolling); crmDetailPolling = null; }
}

async function loadCrmDetailMessages() {
  if (!crmDetailContactId) return;
  try {
    const res = await apiFetch(`/api/chat/${encodeURIComponent(crmDetailContactId)}`);
    if (!res.ok) { showCrmDetailError(`Erro ao carregar histórico: ${res.status}`); return; }
    const msgs = await res.json();
    _currentCrmDetailMessages = Array.isArray(msgs) ? msgs : [];
    renderCrmDetailMessages(_currentCrmDetailMessages);
  } catch (e) { showCrmDetailError('Erro ao carregar histórico'); }
}

function renderCrmDetailMessages(msgs) {
  const el = document.getElementById('crm-detail-messages');
  if (!el) return;
  const pendingForConversation = _optimisticCrmMessages.filter(m => m.contactId === crmDetailContactId);
  if (pendingForConversation.length) msgs = [...(msgs || []), ...pendingForConversation];

  const renderKey = `${crmDetailContactId}:${(msgs || []).length}:${msgs?.[msgs.length - 1]?.timestamp || 0}`;

  if (!msgs || msgs.length === 0) {
    if (_crmRenderKey !== renderKey) {
      _crmRenderKey = renderKey;
      el.innerHTML = '<div class="chat-empty-area">Nenhuma mensagem ainda com este contato</div>';
    }
    return;
  }

  if (renderKey === _crmRenderKey) return;

  const isPlaying = Array.from(el.querySelectorAll('audio, video')).some(m => !m.paused);
  if (isPlaying) return;

  _crmRenderKey = renderKey;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = msgs.map(m => {
    const mediaHtml = buildChatMediaHtml(m);
    const { quote, body } = parseQuoted(m.text || '');
    const quoteHtml = quote ? `<div class="msg-quote">${escapeHtml(quote)}</div>` : '';
    const textHtml = body ? `<div>${linkify(body)}</div>` : '';
    const actions = m.id && !m.pending ? `<div class="msg-actions">
      <button class="msg-reply-btn" data-msg-id="${escapeHtml(m.id)}" data-dir="${m.direction}" title="Responder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>
      <button class="msg-reaction-btn" data-msg-id="${escapeHtml(m.id)}" data-dir="${m.direction}" title="Reagir">😊</button>
    </div>` : '';
    return `
    <div class="chat-msg ${m.direction}">
      ${actions}
      <div class="chat-bubble">${mediaHtml}${quoteHtml}${textHtml}</div>
      <div class="chat-msg-meta">${formatTime(new Date(m.timestamp))}${m.pending ? ' - enviando' : ''}</div>
    </div>`;
  }).join('');
  wireVoiceMessages(el);
  if (wasAtBottom || msgs.length <= 10) el.scrollTop = el.scrollHeight;
}

function resolveCrmDetailConnectionId(contactId) {
  const card = crmCards.find(c => c.id === editingCardId) || null;
  const funnelConn = card?.funnelId ? (crmFunnels.find(f => f.id === card.funnelId)?.chatConnectionId || null) : null;
  if (funnelConn) return funnelConn;
  const convo = typeof getConversationById === 'function' ? getConversationById(contactId) : null;
  if (convo?.connectionId) return convo.connectionId;
  if (selectedChatContactId === contactId && _activeChatConvConnection) return _activeChatConvConnection;
  if (!(String(contactId || '').endsWith('@g.us'))) {
    if (window._liteConnInfo?.connected) return 'lite';
    if (window._lite2ConnInfo?.connected) return 'lite2';
  }
  return _userDefaultConnectionId || undefined;
}

async function sendCrmDetailMessage() {
  if (_crmMic?.isRecording()) { await _crmMic.finishAndSend(); return; }
  if (!crmDetailContactId) {
    showCrmDetailError('Salve o lead com telefone ou grupo do WhatsApp antes de enviar.');
    return;
  }
  const input = document.getElementById('crm-detail-input');
  const typed = input.value.trim();
  if (!typed) return;
  const text = _crmReplyTo ? `> ${_crmReplyTo.text}\n\n${typed}` : typed;
  const btn = document.getElementById('crm-detail-send');
  const tempMsg = { id: `tmp-crm-${Date.now()}`, direction: 'out', contactId: crmDetailContactId, text, timestamp: Date.now(), pending: true };
  _optimisticCrmMessages.push(tempMsg);
  input.value = '';
  input.style.height = 'auto';
  clearCrmReplyTo();
  renderCrmDetailMessages([]);
  btn.disabled = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const connectionId = resolveCrmDetailConnectionId(crmDetailContactId);
    const res = await apiFetch(`/api/chat/${encodeURIComponent(crmDetailContactId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(connectionId ? { connectionId } : {}) }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await readApiPayload(res);
    if (!res.ok) throw new Error(data?.error || data?.message || 'Falha ao enviar');
    _optimisticCrmMessages = _optimisticCrmMessages.filter(m => m.id !== tempMsg.id);
    await loadCrmDetailMessages();
  } catch(e) {
    _optimisticCrmMessages = _optimisticCrmMessages.filter(m => m.id !== tempMsg.id);
    input.value = typed;
    const msg = e.name === 'AbortError' ? 'Tempo esgotado. O WhatsApp pode estar lento.' : e.message;
    showCrmDetailError(msg);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  }
}

async function sendCrmDetailMedia(file) {
  if (!crmDetailContactId) {
    showCrmDetailError('Salve o lead com telefone ou grupo do WhatsApp antes de enviar.');
    return;
  }
  const formData = new FormData();
  formData.append('file', file, file.name);
  const connectionId = resolveCrmDetailConnectionId(crmDetailContactId);
  if (connectionId) formData.append('connectionId', connectionId);
  const tempMsg = {
    id: `tmp-crm-file-${Date.now()}`,
    direction: 'out',
    contactId: crmDetailContactId,
    text: file.type?.startsWith('audio/') ? '' : `[arquivo: ${file.name}]`,
    mediaUrl: URL.createObjectURL(file),
    mediaType: file.type?.startsWith('audio/') ? 'audio' : (file.type?.startsWith('video/') ? 'video' : (file.type?.startsWith('image/') ? 'image' : 'document')),
    mediaName: file.name,
    timestamp: Date.now(),
    pending: true
  };
  _optimisticCrmMessages.push(tempMsg);
  await loadCrmDetailMessages();
  try {
    const res = await apiFetch(`/api/chat/${encodeURIComponent(crmDetailContactId)}/send-media`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao enviar arquivo');
    _optimisticCrmMessages = _optimisticCrmMessages.filter(m => m.id !== tempMsg.id);
    URL.revokeObjectURL(tempMsg.mediaUrl);
    await loadCrmDetailMessages();
  } catch (e) {
    _optimisticCrmMessages = _optimisticCrmMessages.filter(m => m.id !== tempMsg.id);
    URL.revokeObjectURL(tempMsg.mediaUrl);
    showCrmDetailError(e.message);
  }
}

function showCrmDetailError(msg) {
  const el = document.getElementById('crm-detail-messages');
  const err = document.createElement('div');
  err.style.cssText = 'background:#2c1515;border:1px solid #ff6b6b44;border-radius:8px;padding:8px 12px;font-size:12px;color:#ff6b6b;margin:4px 0;';
  err.textContent = '⚠️ ' + msg;
  el.appendChild(err);
  el.scrollTop = el.scrollHeight;
  setTimeout(() => err.remove(), 6000);
}

// ══════════════════════════════════════════
// ─── Contatos / Prospects ─────────────────
// ══════════════════════════════════════════

let prospects = [];

function openProspectsImportFromCrm() {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-prospects')?.classList.add('active');
  document.getElementById('main-content')?.classList.remove('chat-mode', 'crm-chat-mode');
  stopChatPolling();
  loadProspects();
}

function setupCrmImportButton() {
  document.getElementById('btn-open-prospects-from-crm')?.addEventListener('click', openProspectsImportFromCrm);
}

function setupProspects() {
  document.getElementById('btn-add-prospect-open').addEventListener('click', openAddProspectModal);
  document.getElementById('add-prospect-modal-close').addEventListener('click', closeAddProspectModal);
  document.getElementById('btn-save-prospect').addEventListener('click', saveProspect);
  document.getElementById('csv-upload').addEventListener('change', handleCsvUpload);
  document.getElementById('add-prospect-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-prospect-modal')) closeAddProspectModal();
  });
}

async function loadProspects() {
  try {
    const res = await (await apiFetch('/api/prospects')).json();
    prospects = Array.isArray(res) ? res : (res.prospects || []);
    renderProspects();
  } catch {}
}

function renderProspects() {
  const tbody = document.getElementById('prospects-tbody');
  if (!tbody) return;
  if (prospects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:24px;">Nenhum contato cadastrado</td></tr>';
    return;
  }
  tbody.innerHTML = prospects.map(p => {
    const ig = p.instagram ? p.instagram.replace(/^@/, '') : '';
    return `<tr>
      <td>${escapeHtml(p.name || '—')}</td>
      <td>${ig ? `<a href="https://instagram.com/${encodeURIComponent(ig)}" target="_blank" class="prospect-link">@${escapeHtml(ig)}</a>` : '—'}</td>
      <td>${p.site ? `<a href="${escapeHtml(p.site)}" target="_blank" class="prospect-link">${escapeHtml(p.site)}</a>` : '—'}</td>
      <td>${p.phone ? `<a href="https://wa.me/${escapeHtml(p.phone)}" target="_blank" class="prospect-link">${icon('smartphone')} ${escapeHtml(p.phone)}</a>` : '—'}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap;">
        <button class="crm-col-btn" onclick="addProspectToCrm('${p.id}')" title="Adicionar ao CRM">+ CRM</button>
        <button class="crm-col-btn" onclick="deleteProspect('${p.id}')" style="color:#ff6b6b;" title="Excluir">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function openAddProspectModal() {
  ['new-prospect-name','new-prospect-instagram','new-prospect-site','new-prospect-phone'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('add-prospect-feedback').style.display = 'none';
  document.getElementById('add-prospect-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('new-prospect-name').focus(), 50);
}

function closeAddProspectModal() {
  document.getElementById('add-prospect-modal').style.display = 'none';
}

async function saveProspect() {
  const fbEl = document.getElementById('add-prospect-feedback');
  const payload = {
    name: document.getElementById('new-prospect-name').value.trim(),
    instagram: document.getElementById('new-prospect-instagram').value.trim(),
    site: document.getElementById('new-prospect-site').value.trim(),
    phone: document.getElementById('new-prospect-phone').value.trim()
  };
  if (!payload.name) { showFeedback(fbEl, 'Preencha o nome', 'error'); return; }
  try {
    const res = await apiFetch('/api/prospects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    closeAddProspectModal();
    await loadProspects();
  } catch {
    showFeedback(fbEl, 'Erro ao salvar contato', 'error');
  }
}

async function deleteProspect(id) {
  if (!confirm('Excluir este contato?')) return;
  await apiFetch(`/api/prospects/${id}`, { method: 'DELETE' });
  await loadProspects();
}

async function addProspectToCrm(prospectId) {
  const p = prospects.find(pr => pr.id === prospectId);
  if (!p) return;
  if (crmColumns.length === 0) await loadCrm();
  editingCardId = null;
  // Switch to CRM tab and show detail view
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.nav-item[data-tab="crm"]').classList.add('active');
  document.getElementById('tab-crm').classList.add('active');
  showCrmDetailView({ contactName: p.name, phone: p.phone, instagram: p.instagram, site: p.site });
}

// ─── Fila da vez ─────────────────────────────────────────
function setupQueue() {
  document.getElementById('btn-add-consultant').addEventListener('click', addConsultant);
  document.getElementById('queue-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') addConsultant(); });
  document.getElementById('btn-test-lead').addEventListener('click', sendTestLead);
  document.getElementById('btn-pause-leads').addEventListener('click', toggleLeadsPause);
  loadQueue();
  loadLeadsPauseStatus();
}

async function loadQueue() {
  const res = await apiFetch('/api/consultants');
  const list = await res.json();
  renderQueue(list);
}

function renderQueue(list) {
  const nextEl = document.getElementById('queue-next');
  const listEl = document.getElementById('queue-list');

  const available = list.filter(c => c.available).sort((a, b) => (a.lastAssignedAt || 0) - (b.lastAssignedAt || 0));
  nextEl.innerHTML = available.length > 0 ? `${icon('user', 18)} ${escapeHtml(available[0].name)}` : '— nenhum disponível';

  if (list.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><use href="#i-users"/></svg></div><div>Nenhum consultor cadastrado</div></div>`;
    return;
  }

  listEl.innerHTML = list.map(c => {
    const lastAt = c.lastAssignedAt ? new Date(c.lastAssignedAt).toLocaleString('pt-BR') : 'Nunca';
    const statusColor = c.available ? '#69db7c' : '#ff6b6b';
    const statusLabel = c.available ? 'Disponível' : 'Indisponível';
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;">
        <div style="font-weight:600;">${escapeHtml(c.name)}</div>
        <div style="font-size:12px;color:var(--text3);">Último lead: ${lastAt}</div>
      </div>
      <span style="font-size:12px;color:${statusColor};font-weight:600;">${statusLabel}</span>
      <button onclick="setLastConsultant('${c.id}')" title="Marcar como o último que recebeu lead" style="padding:4px 10px;border-radius:6px;border:1px solid #ffd43b55;background:transparent;color:#f59f00;cursor:pointer;font-size:12px;">${icon('pin')} Último lead</button>
      <button onclick="toggleConsultant('${c.id}', ${!c.available})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text1);cursor:pointer;font-size:12px;">
        ${c.available ? 'Pausar' : 'Ativar'}
      </button>
      <button onclick="deleteConsultantById('${c.id}')" style="padding:4px 10px;border-radius:6px;border:1px solid #ff6b6b33;background:transparent;color:#ff6b6b;cursor:pointer;font-size:12px;">✕</button>
    </div>`;
  }).join('');
}

async function addConsultant() {
  const input = document.getElementById('queue-new-name');
  const fbEl = document.getElementById('queue-feedback');
  const name = input.value.trim();
  if (!name) { showFeedback(fbEl, 'Digite o nome do consultor', 'error'); return; }
  const res = await apiFetch('/api/consultants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) { showFeedback(fbEl, 'Erro ao adicionar', 'error'); return; }
  input.value = '';
  showFeedback(fbEl, 'Consultor adicionado!', 'ok');
  await loadQueue();
}

async function setLastConsultant(id) {
  await apiFetch(`/api/consultants/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lastAssignedAt: Date.now() }) });
  await loadQueue();
}

async function toggleConsultant(id, available) {
  await apiFetch(`/api/consultants/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ available }) });
  await loadQueue();
}

let leadsPaused = false;

async function loadLeadsPauseStatus() {
  try {
    const res = await apiFetch('/api/leads/status');
    const data = await res.json();
    leadsPaused = data.paused;
    updatePauseBtn();
  } catch {}
}

function updatePauseBtn() {
  const btn = document.getElementById('btn-pause-leads');
  if (leadsPaused) {
    btn.innerHTML = `${icon('play')} Retomar leads`;
    btn.style.background = 'linear-gradient(135deg,#69db7c,#2f9e44)';
  } else {
    btn.innerHTML = `${icon('pause')} Pausar leads`;
    btn.style.background = 'linear-gradient(135deg,#ff6b6b,#c92a2a)';
  }
}

async function toggleLeadsPause() {
  const fbEl = document.getElementById('pause-feedback');
  const endpoint = leadsPaused ? '/api/leads/resume' : '/api/leads/pause';
  const res = await apiFetch(endpoint, { method: 'POST' });
  const data = await res.json();
  leadsPaused = data.paused;
  updatePauseBtn();
  showFeedback(fbEl, leadsPaused ? 'Leads pausados — novos leads não serão enviados' : 'Leads retomados!', leadsPaused ? 'warn' : 'ok');
}

async function sendTestLead() {
  const btn = document.getElementById('btn-test-lead');
  const fbEl = document.getElementById('test-lead-feedback');
  btn.disabled = true;
  btn.innerHTML = 'Enviando...';
  const timeout = setTimeout(() => {
    btn.disabled = false;
    btn.innerHTML = `${icon('flask')} Enviar lead de teste`;
    showFeedback(fbEl, 'Timeout — verifique se o WhatsApp está conectado e se há um grupo configurado', 'error');
  }, 12000);
  try {
    const res = await apiFetch('/api/consultants/test-lead', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showFeedback(fbEl, data.error || 'Erro ao enviar', 'error'); return; }
    showFeedback(fbEl, `✅ Enviado! Vendedor: ${data.proximo}`, 'ok');
    await loadQueue();
  } catch {
    showFeedback(fbEl, 'Erro de conexão', 'error');
  } finally {
    clearTimeout(timeout);
    btn.disabled = false;
    btn.innerHTML = `${icon('flask')} Enviar lead de teste`;
  }
}

async function deleteConsultantById(id) {
  if (!confirm('Excluir este consultor?')) return;
  await apiFetch(`/api/consultants/${id}`, { method: 'DELETE' });
  await loadQueue();
}

async function handleCsvUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { alert('CSV vazio ou sem dados'); return; }
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const list = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return {
        name: obj.nome || obj.name || '',
        instagram: obj.instagram || '',
        site: obj.site || '',
        phone: obj.telefone || obj.phone || obj.whatsapp || ''
      };
    }).filter(p => p.name || p.phone);
    if (list.length === 0) { alert('Nenhum dado válido encontrado no CSV'); return; }
    const res = await apiFetch('/api/prospects/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ list }) });
    if (res.ok) {
      alert(`${list.length} contatos importados com sucesso`);
      await loadProspects();
    }
  } catch(err) {
    alert('Erro ao processar o CSV: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

// ─── Sidebar resize & collapse ───────────────────────────────────────────────

function setupSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const handle  = document.getElementById('sidebar-resize');
  const toggle  = document.getElementById('sidebar-toggle');
  if (!sidebar || !handle) return;

  const COLLAPSE_THRESHOLD = 80;
  const DEFAULT_WIDTH = 230;

  function setCollapsed(yes) {
    sidebar.classList.toggle('sidebar--collapsed', yes);
    sidebar.style.width = yes ? '56px' : (sidebar._expandedWidth || DEFAULT_WIDTH) + 'px';
    localStorage.setItem('sidebarCollapsed', yes ? '1' : '0');
  }

  if (localStorage.getItem('sidebarCollapsed') === '1') setCollapsed(true);

  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(56, Math.min(360, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
    if (w < COLLAPSE_THRESHOLD) {
      sidebar.classList.add('sidebar--collapsed');
    } else {
      sidebar.classList.remove('sidebar--collapsed');
      sidebar._expandedWidth = w;
    }
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const collapsed = sidebar.classList.contains('sidebar--collapsed');
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  });

  toggle?.addEventListener('click', () => {
    setCollapsed(!sidebar.classList.contains('sidebar--collapsed'));
  });

  // wrap text nodes in nav-items so we can hide them on collapse
  document.querySelectorAll('.nav-item, .btn-sidebar-action').forEach(el => {
    [...el.childNodes].forEach(node => {
      if (node.nodeType === 3 && node.textContent.trim()) {
        const span = document.createElement('span');
        span.className = node.parentElement.classList.contains('nav-item') ? 'nav-label' : 'btn-label';
        span.textContent = node.textContent;
        el.replaceChild(span, node);
      }
    });
  });
}

// ─── WorkSpace ────────────────────────────────────────────────────────────────

const WS_BADGE_COLORS = {
  // status
  'pendente':         { bg: '#f1f2f4', color: '#4b5563' },
  'in progress':      { bg: '#dcfce7', color: '#15803d' },
  'tráfego':          { bg: '#dbeafe', color: '#1d4ed8' },
  'saída':            { bg: '#fee2e2', color: '#b91c1c' },
  'concluído':        { bg: '#d1fae5', color: '#065f46' },
  // resultado
  'BOM':              { bg: '#dcfce7', color: '#15803d' },
  'ATENÇÃO':          { bg: '#fef9c3', color: '#92400e' },
  'CRÍTICO':          { bg: '#fee2e2', color: '#b91c1c' },
  'NÃO INICIOU':      { bg: '#f3f4f6', color: '#6b7280' },
  'RESCENTE':         { bg: '#ede9fe', color: '#6d28d9' },
  'PAUSADO':          { bg: '#fce7f3', color: '#9d174d' },
  // campo — verde
  'ENVIADO':          { bg: '#dcfce7', color: '#15803d' },
  'OTIMIZADO':        { bg: '#d1fae5', color: '#065f46' },
  'FEITO':            { bg: '#d1fae5', color: '#065f46' },
  'FEITO SEMANA':     { bg: '#d1fae5', color: '#065f46' },
  'FEITO HOJE':       { bg: '#bbf7d0', color: '#14532d' },
  // campo — laranja/ação
  'ENVIAR':           { bg: '#fff7ed', color: '#c2410c' },
  'FAZER':            { bg: '#fff7ed', color: '#c2410c' },
  'A FAZER':          { bg: '#fff7ed', color: '#c2410c' },
  'MARCAR':           { bg: '#fff7ed', color: '#c2410c' },
  'ENVIAR BOLETO':    { bg: '#fff7ed', color: '#c2410c' },
  'BOLETO':           { bg: '#fff7ed', color: '#c2410c' },
  // campo — amarelo
  'REVISAR':          { bg: '#fef9c3', color: '#92400e' },
  'MARCADO':          { bg: '#fef9c3', color: '#92400e' },
  // campo — vermelho
  'DESLIGADO':        { bg: '#fee2e2', color: '#b91c1c' },
  'SEM SALDO':        { bg: '#fee2e2', color: '#b91c1c' },
  // campo — azul
  'CRIAR CONTA':      { bg: '#dbeafe', color: '#1d4ed8' },
  'FEITO ATÉ TEÇA':   { bg: '#dbeafe', color: '#1d4ed8' },
  'FEITO ATÉ TERÇA':  { bg: '#dbeafe', color: '#1d4ed8' },
  'FEITO ATÉ QUARTA': { bg: '#dbeafe', color: '#1d4ed8' },
  'FEITO ATÉ QUINTA': { bg: '#dbeafe', color: '#1d4ed8' },
  'FEITO ATÉ SEXTA':  { bg: '#dbeafe', color: '#1d4ed8' },
  // campo — cinza/neutro
  'NÃO USA':          { bg: '#f3f4f6', color: '#9ca3af' },
  'NÃO TEM':          { bg: '#f3f4f6', color: '#9ca3af' },
  // campo — roxo
  'CARTÃO':           { bg: '#ede9fe', color: '#6d28d9' },
  'PIX':              { bg: '#ede9fe', color: '#6d28d9' },
};

const WS_FIELDS = {
  nome:        { type: 'text', placeholder: 'Nome do cliente' },
  status:      { opts: ['in progress', 'tráfego', 'pendente', 'saída', 'concluído'] },
  resultado:   { opts: ['BOM', 'ATENÇÃO', 'CRÍTICO', 'NÃO INICIOU', 'RESCENTE', 'PAUSADO'], nullable: true },
  google:      { opts: ['OTIMIZADO', 'REVISAR', 'DESLIGADO', 'NÃO USA', 'CRIAR CONTA', 'FEITO ATÉ TEÇA'], nullable: true },
  meta:        { opts: ['OTIMIZADO', 'REVISAR', 'DESLIGADO', 'NÃO USA', 'CRIAR CONTA', 'FEITO ATÉ TEÇA'], nullable: true },
  mensagem:    { opts: ['ENVIAR', 'ENVIADO'], nullable: true },
  relatorio:   { opts: ['ENVIAR', 'ENVIADO'], nullable: true },
  saldo:       { opts: ['CARTÃO', 'PIX', 'SEM SALDO', 'ENVIAR BOLETO', 'BOLETO'], nullable: true },
  stories:     { opts: ['FAZER', 'FEITO SEMANA', 'FEITO HOJE', 'FEITO ATÉ TERÇA', 'FEITO ATÉ QUARTA', 'FEITO ATÉ QUINTA', 'FEITO ATÉ SEXTA'], nullable: true },
  socialMedia: { opts: ['FEITO SEMANA', 'FEITO HOJE', 'FEITO ATÉ TERÇA', 'FEITO ATÉ QUARTA', 'FEITO ATÉ QUINTA', 'FEITO ATÉ SEXTA', 'A FAZER', 'NÃO TEM'], nullable: true },
  treinamento: { opts: ['MARCAR', 'MARCADO', 'FEITO'], nullable: true },
  investimento:{ type: 'text', placeholder: 'ex: 700', nullable: true },
  vencimento:  { type: 'date', nullable: true },
};

const WS_STATUS_ORDER = ['pendente', 'tráfego', 'in progress', 'saída', 'concluído'];

const WS_COL_DEFS = [
  { field: 'vencimento', label: 'VENCIMENTO' },
  { field: 'status', label: 'STATUS' },
  { field: 'resultado', label: 'RESULTADO' },
  { field: 'google', label: 'GOOGLE' },
  { field: 'meta', label: 'META' },
  { field: 'mensagem', label: 'MENSAGEM' },
  { field: 'relatorio', label: 'RELATÓRIO' },
  { field: 'saldo', label: 'SALDO' },
  { field: 'stories', label: 'STORIES' },
  { field: 'socialMedia', label: 'SOCIAL MEDIA' },
  { field: 'investimento', label: 'INVEST.' },
  { field: 'treinamento', label: 'TREINAMENTO' },
  { field: 'tags', label: 'TAGS' },
];
let _wsColOrder = (() => { try { return JSON.parse(localStorage.getItem('ws-col-order')) || null; } catch { return null; } })() || WS_COL_DEFS.map(c => c.field);
let _wsCustomCols = [];
function wsAllColDefs() { return WS_COL_DEFS.concat(_wsCustomCols); }
function wsRegisterCustomCols() {
  _wsCustomCols.forEach(cc => { if (!WS_FIELDS[cc.field]) WS_FIELDS[cc.field] = { type: 'text', placeholder: '', nullable: true, custom: true }; });
  _wsCustomCols.forEach(cc => { if (!_wsColOrder.includes(cc.field)) _wsColOrder.push(cc.field); });
  _wsColOrder = _wsColOrder.filter(f => WS_COL_DEFS.some(c => c.field === f) || _wsCustomCols.some(c => c.field === f));
}
function getWsCols() { const defs = wsAllColDefs(); return _wsColOrder.map(f => defs.find(c => c.field === f)).filter(Boolean); }
async function wsAddColumn() {
  const label = prompt('Nome da nova coluna:');
  if (!label || !label.trim()) return;
  try {
    const r = await apiFetch('/api/workspace/columns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: label.trim() }) });
    const col = await r.json();
    if (!r.ok) throw new Error(col.error || 'Erro');
    _wsCustomCols.push(col);
    wsRegisterCustomCols();
    localStorage.setItem('ws-col-order', JSON.stringify(_wsColOrder));
    wsRenderTable();
  } catch (e) { alert('Erro ao adicionar coluna: ' + e.message); }
}
async function wsDeleteColumn(field) {
  if (!confirm('Remover esta coluna? Os dados dela nas tarefas ficam ocultos.')) return;
  try { await apiFetch('/api/workspace/columns/' + encodeURIComponent(field), { method: 'DELETE' }); } catch {}
  _wsCustomCols = _wsCustomCols.filter(c => c.field !== field);
  _wsColOrder = _wsColOrder.filter(f => f !== field);
  localStorage.setItem('ws-col-order', JSON.stringify(_wsColOrder));
  wsRenderTable();
}

const WS_DEFAULT_STATUS_CONFIG = [
  { name: 'pendente',    color: '#888',    bg: '#222' },
  { name: 'in progress', color: '#4caf50', bg: '#0d2e1a' },
  { name: 'tráfego',     color: '#42a5f5', bg: '#0d1e30' },
  { name: 'saída',       color: '#ef5350', bg: '#2e0d0d' },
  { name: 'concluído',   color: '#66bb6a', bg: '#0d2214' },
];

let _wsTasks = [];
let _wsSpaces = [];
let _wsLabels = [];
let _wsStatusConfig = null; // null = use defaults
let _wsCanManage = false;
let _wsCurrentSpaceId = localStorage.getItem('ws-current-space') || '';
let _wsFilter = 'todos';
let _wsFilterAssignee = '';
let _wsMembers = [];
let _wsSelected = new Set();
let _wsNoteId = null;
let _wsLabelPickerId = null;

const DRAG_SVG = `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="2" r="1.5"/><circle cx="7.5" cy="2" r="1.5"/><circle cx="2.5" cy="7" r="1.5"/><circle cx="7.5" cy="7" r="1.5"/><circle cx="2.5" cy="12" r="1.5"/><circle cx="7.5" cy="12" r="1.5"/></svg>`;
const COMMENT_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

function wsBadge(val) {
  if (!val) return '<span class="ws-dash">—</span>';
  const c = WS_BADGE_COLORS[val] || { bg: '#f1f2f4', color: '#4b5563' };
  return `<span class="ws-badge" style="background:${c.bg};color:${c.color};">${val}</span>`;
}

function wsDateStr(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return '__hoje__';
  if (diff === 1) return '__amanha__';
  if (diff === -1) return '__ontem__';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}



// ─── Automações ───────────────────────────────────────────────────────────────

let _wsAutomations = [];
let _wsAutoEditingId = null;

async function loadWsAutomations() {
  try {
    const res = await apiFetch('/api/workspace/automations');
    if (res.ok) _wsAutomations = await res.json();
  } catch { _wsAutomations = []; }
}

function openWsAutomationsPanel() {
  loadWsAutomations().then(wsRenderAutomationsList);
  document.getElementById('ws-automations-overlay').style.display = 'block';
  const panel = document.getElementById('ws-automations-panel');
  panel.style.display = 'flex';
}

function closeWsAutomationsPanel() {
  document.getElementById('ws-automations-overlay').style.display = 'none';
  document.getElementById('ws-automations-panel').style.display = 'none';
}

const WS_TRIGGER_LABELS = {
  due_date_today:    'Data de vencimento chega hoje',
  due_date_passed:   'Data de vencimento passou (atrasado)',
  status_changes_to: 'Status muda para',
  every_weekday:     'Todo',
};
const WS_ACTION_LABELS = {
  set_status:      'Mudar status para',
  shift_due_date:  'Adiantar/recuar data de vencimento',
};
const WS_WEEKDAY_LABELS = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];

function wsRenderAutomationsList() {
  const el = document.getElementById('ws-automations-list');
  if (!el) return;
  if (!_wsAutomations.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text2);font-size:13px;">Nenhuma automação configurada.<br>Clique em <b>+ Nova Automação</b> para criar.</div>';
    return;
  }
  el.innerHTML = _wsAutomations.map(a => {
    const tType = a.trigger?.type;
    let tLabel = WS_TRIGGER_LABELS[tType] || tType || '?';
    let tVal = '';
    if (tType === 'status_changes_to' && a.trigger?.value) tVal = ` <b>${escapeHtml(a.trigger.value)}</b>`;
    if (tType === 'every_weekday' && a.trigger?.weekday !== undefined) tVal = ` <b>${WS_WEEKDAY_LABELS[a.trigger.weekday] || a.trigger.weekday}</b>`;
    const aType = a.action?.type;
    const aLabel = WS_ACTION_LABELS[aType] || aType || '?';
    let aVal = '';
    if (aType === 'set_status' && a.action?.value) aVal = ` <b>${escapeHtml(a.action.value)}</b>`;
    if (aType === 'shift_due_date') { const dir = a.action?.direction === 'backward' ? 'recuar' : 'adiantar'; aVal = ` <b>${dir} ${a.action?.days || 1} dia(s)</b>`; }
    const activeColor = a.active !== false ? '#4caf50' : '#888';
    const sIds = a.spaceIds || (a.spaceId ? [a.spaceId] : []);
    const spacesLabel = sIds.length === 0 ? 'Todos os espaços' : sIds.map(id => { const s = _wsSpaces.find(sp => sp.id === id); return s ? escapeHtml(s.name) : id; }).join(', ');
    return `<div style="background:var(--bg2);border-radius:8px;padding:12px 14px;margin-bottom:10px;display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span style="font-weight:700;font-size:13px;">${escapeHtml(a.name || 'Sem nome')}</span>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <span style="width:8px;height:8px;border-radius:50%;background:${activeColor};display:inline-block;" title="${a.active !== false ? 'Ativa' : 'Inativa'}"></span>
          <button class="btn-sidebar-action" style="padding:2px 8px;font-size:11px;" onclick="wsToggleAutomation('${a.id}')">${a.active !== false ? 'Pausar' : 'Ativar'}</button>
          <button class="btn-sidebar-action" style="padding:2px 8px;font-size:11px;" onclick="wsEditAutomation('${a.id}')">Editar</button>
          <button class="btn-sidebar-action" style="padding:2px 8px;font-size:11px;color:#ef4444;" onclick="wsDeleteAutomation('${a.id}')">&#128465;</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text2);display:flex;flex-direction:column;gap:3px;">
        <span>&#9889; <span style="color:var(--accent);">Quando:</span> ${tLabel}${tVal}</span>
        <span>&#10003; <span style="color:#4caf50;">Então:</span> ${aLabel}${aVal}</span>
        <span>&#127968; <span style="color:var(--text2);">Espaços:</span> ${spacesLabel}</span>
      </div>
    </div>`;
  }).join('');
}

function openWsAutomationBuilder(rule = null) {
  _wsAutoEditingId = rule?.id || null;
  document.getElementById('ws-auto-builder-title').textContent = rule ? 'Editar Automação' : 'Nova Automação';
  document.getElementById('ws-auto-name').value = rule?.name || '';
  document.getElementById('ws-auto-editing-id').value = rule?.id || '';

  // Populate status options
  const statuses = WS_STATUS_ORDER;
  ['ws-auto-trigger-value', 'ws-auto-action-value'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = statuses.map(s => `<option value="${s}">${s}</option>`).join('');
  });

  // Populate weekday options
  const wdSel = document.getElementById('ws-auto-trigger-weekday');
  if (wdSel) wdSel.innerHTML = WS_WEEKDAY_LABELS.map((d,i) => `<option value="${i}">${d}</option>`).join('');

  // Populate space checkboxes
  const selectedIds = rule?.spaceIds || (rule?.spaceId ? [rule.spaceId] : []);
  const spacesList = document.getElementById('ws-auto-spaces-list');
  if (spacesList) {
    spacesList.innerHTML = _wsSpaces.map(s => `
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" class="ws-auto-space-cb" value="${s.id}" ${selectedIds.includes(s.id) ? 'checked' : ''} style="accent-color:var(--accent);width:15px;height:15px;">
        <span>${escapeHtml(s.name)}</span>
      </label>`).join('');
    spacesList.querySelectorAll('.ws-auto-space-cb').forEach(cb => cb.addEventListener('change', wsAutoUpdateAllSpacesCheckbox));
  }
  const allCb = document.getElementById('ws-auto-space-all');
  const isAll = selectedIds.length === 0;
  if (allCb) allCb.checked = isAll;
  document.querySelectorAll('.ws-auto-space-cb').forEach(cb => cb.disabled = isAll);

  // Set trigger
  const trigType = document.getElementById('ws-auto-trigger-type');
  trigType.value = rule?.trigger?.type || '';
  wsAutoTriggerChanged();
  if (rule?.trigger?.value) document.getElementById('ws-auto-trigger-value').value = rule.trigger.value;
  if (rule?.trigger?.weekday !== undefined) { const w = document.getElementById('ws-auto-trigger-weekday'); if (w) w.value = rule.trigger.weekday; }

  // Set action
  const actType = document.getElementById('ws-auto-action-type');
  actType.value = rule?.action?.type || '';
  wsAutoActionChanged();
  if (rule?.action?.value) document.getElementById('ws-auto-action-value').value = rule.action.value;
  if (rule?.action?.days) { const d = document.getElementById('ws-auto-action-days'); if (d) d.value = rule.action.days; }
  if (rule?.action?.direction) { const dir = document.getElementById('ws-auto-action-direction'); if (dir) dir.value = rule.action.direction; }

  document.getElementById('ws-auto-feedback').style.display = 'none';
  document.getElementById('ws-automation-builder-overlay').style.display = 'flex';
}

function closeWsAutomationBuilder() {
  document.getElementById('ws-automation-builder-overlay').style.display = 'none';
}

function wsAutoToggleAllSpaces(checked) {
  document.querySelectorAll('.ws-auto-space-cb').forEach(cb => { cb.disabled = checked; if (checked) cb.checked = false; });
}

function wsAutoUpdateAllSpacesCheckbox() {
  const cbs = [...document.querySelectorAll('.ws-auto-space-cb')];
  const allCb = document.getElementById('ws-auto-space-all');
  if (!allCb) return;
  const anyChecked = cbs.some(cb => cb.checked);
  if (!anyChecked) { allCb.checked = true; cbs.forEach(cb => cb.disabled = true); }
  else { allCb.checked = false; cbs.forEach(cb => cb.disabled = false); }
}

function wsAutoTriggerChanged() {
  const type = document.getElementById('ws-auto-trigger-type').value;
  const extra = document.getElementById('ws-auto-trigger-extra');
  const weeklyExtra = document.getElementById('ws-auto-trigger-weekly-extra');
  extra.style.display = type === 'status_changes_to' ? 'block' : 'none';
  if (weeklyExtra) weeklyExtra.style.display = type === 'every_weekday' ? 'block' : 'none';
}

function wsAutoActionChanged() {
  const type = document.getElementById('ws-auto-action-type').value;
  const extra = document.getElementById('ws-auto-action-extra');
  const shiftExtra = document.getElementById('ws-auto-action-shift-extra');
  extra.style.display = type === 'set_status' ? 'block' : 'none';
  if (shiftExtra) shiftExtra.style.display = type === 'shift_due_date' ? 'block' : 'none';
}

async function saveWsAutomation() {
  const fb = document.getElementById('ws-auto-feedback');
  const name = document.getElementById('ws-auto-name').value.trim();
  const trigType = document.getElementById('ws-auto-trigger-type').value;
  const actType = document.getElementById('ws-auto-action-type').value;
  if (!trigType) { fb.textContent = 'Selecione um gatilho.'; fb.style.display = 'block'; return; }
  if (!actType)  { fb.textContent = 'Selecione uma ação.'; fb.style.display = 'block'; return; }

  const trigger = { type: trigType };
  if (trigType === 'status_changes_to') trigger.value = document.getElementById('ws-auto-trigger-value').value;
  if (trigType === 'every_weekday') { const w = document.getElementById('ws-auto-trigger-weekday'); trigger.weekday = w ? parseInt(w.value) : 1; }
  const action = { type: actType };
  if (actType === 'set_status') action.value = document.getElementById('ws-auto-action-value').value;
  if (actType === 'shift_due_date') {
    const daysEl = document.getElementById('ws-auto-action-days');
    const dirEl  = document.getElementById('ws-auto-action-direction');
    action.days = daysEl ? Math.max(1, parseInt(daysEl.value) || 1) : 1;
    action.direction = dirEl ? dirEl.value : 'forward';
  }
  const checkedCbs = [...document.querySelectorAll('.ws-auto-space-cb:checked')];
  const spaceIds = checkedCbs.map(cb => cb.value);

  const editingId = document.getElementById('ws-auto-editing-id').value;
  const method = editingId ? 'PUT' : 'POST';
  const url = editingId ? `/api/workspace/automations/${editingId}` : '/api/workspace/automations';
  const trigLabel = trigType === 'every_weekday' ? `Todo ${WS_WEEKDAY_LABELS[trigger.weekday] || ''}` : (WS_TRIGGER_LABELS[trigType] || trigType);
  const actLabel = actType === 'shift_due_date' ? `Adiantar ${action.days}d` : (WS_ACTION_LABELS[actType] || actType);

  try {
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name || `${trigLabel} → ${actLabel}`, trigger, action, spaceIds: spaceIds.length ? spaceIds : null, active: true }) });
    if (!res.ok) throw new Error('erro');
    closeWsAutomationBuilder();
    await loadWsAutomations();
    wsRenderAutomationsList();
  } catch {
    fb.textContent = 'Erro ao salvar. Tente novamente.';
    fb.style.display = 'block';
  }
}

async function wsDeleteAutomation(id) {
  if (!confirm('Excluir esta automação?')) return;
  await apiFetch(`/api/workspace/automations/${id}`, { method: 'DELETE' });
  await loadWsAutomations();
  wsRenderAutomationsList();
}

async function wsToggleAutomation(id) {
  const rule = _wsAutomations.find(a => a.id === id);
  if (!rule) return;
  await apiFetch(`/api/workspace/automations/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: rule.active === false }) });
  await loadWsAutomations();
  wsRenderAutomationsList();
}

function wsEditAutomation(id) {
  const rule = _wsAutomations.find(a => a.id === id);
  if (rule) openWsAutomationBuilder(rule);
}

// ─── Responsável ─────────────────────────────────────────────────────────────

function wsRenderAssigneeCell(task) {
  if (!task.responsavel) return '<span class="ws-dash">—</span>';
  const member = _wsMembers.find(m => m.id === task.responsavel);
  const label = member ? (member.name || member.username) : task.responsavel;
  const initials = label.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="ws-assignee-avatar" title="${escapeHtml(label)}">${escapeHtml(initials)}</span><span class="ws-assignee-name">${escapeHtml(label)}</span>`;
}

function wsShowAssigneePicker(e, cell) {
  e.stopPropagation();
  wsClosePicker();
  wsCloseLabelPicker();
  const id = cell.dataset.id;
  const task = _wsTasks.find(t => t.id === id);
  if (!task) return;

  const picker = document.getElementById('ws-picker');
  picker.innerHTML = '';
  _pickerCell = cell;

  const rect = cell.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  picker.style.display = 'block';
  picker.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
  if (spaceBelow > 200) { picker.style.top = (rect.bottom + 4) + 'px'; picker.style.bottom = 'auto'; }
  else { picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px'; picker.style.top = 'auto'; }

  const clr = document.createElement('button');
  clr.className = 'ws-pick-opt clr';
  clr.textContent = '— sem responsável';
  clr.addEventListener('click', () => wsSaveField(id, 'responsavel', null));
  picker.appendChild(clr);

  _wsMembers.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'ws-pick-opt' + (task.responsavel === m.id ? ' cur' : '');
    const label = m.name || m.username;
    const initials = label.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    btn.innerHTML = `<span class="ws-assignee-avatar" style="width:20px;height:20px;font-size:10px;margin-right:8px;">${escapeHtml(initials)}</span>${escapeHtml(label)}`;
    btn.addEventListener('click', () => wsSaveField(id, 'responsavel', m.id));
    picker.appendChild(btn);
  });
}

function wsRenderAssigneeFilter() {
  let wrap = document.getElementById('ws-assignee-filter-wrap');
  if (!_wsMembers.length) { if (wrap) wrap.remove(); return; }

  const bar = document.getElementById('ws-filter-bar');
  if (!bar) return;

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'ws-assignee-filter-wrap';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;';
    bar.after(wrap);
  }

  wrap.innerHTML = `<span style="font-size:11px;color:var(--text2);font-weight:600;letter-spacing:.04em;">RESPONSÁVEL:</span>` +
    `<button class="ws-tab-btn${!_wsFilterAssignee ? ' active' : ''}" data-assignee="">Todos</button>` +
    _wsMembers.map(m => {
      const label = m.name || m.username;
      const initials = label.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      return `<button class="ws-tab-btn${_wsFilterAssignee === m.id ? ' active' : ''}" data-assignee="${m.id}" title="${escapeHtml(label)}"><span class="ws-assignee-avatar" style="width:16px;height:16px;font-size:9px;margin-right:4px;">${escapeHtml(initials)}</span>${escapeHtml(label)}</button>`;
    }).join('');

  wrap.querySelectorAll('[data-assignee]').forEach(btn => {
    btn.addEventListener('click', () => {
      _wsFilterAssignee = btn.dataset.assignee;
      wsRenderAssigneeFilter();
      wsRenderTable();
    });
  });
}

function wsRenderSpaces() {
  const list = document.getElementById('ws-space-list');
  if (!list) return;
  if (!_wsSpaces.length) {
    list.innerHTML = '<div class="ws-space-empty">Nenhum espaço liberado</div>';
    return;
  }
  if (!_wsCurrentSpaceId || !_wsSpaces.some(s => s.id === _wsCurrentSpaceId)) _wsCurrentSpaceId = _wsSpaces[0].id;
  list.innerHTML = _wsSpaces.map(space => `
    <div class="ws-space-item ${space.id === _wsCurrentSpaceId ? 'active' : ''}" data-space-id="${escapeHtml(space.id)}" draggable="true" style="cursor:grab;">
      ${icon('grid', 14)}
      <span>${escapeHtml(space.name)}</span>
      ${_wsCanManage ? `<button class="ws-space-dots" data-space-id="${escapeHtml(space.id)}" title="Opções">···</button>` : ''}
    </div>`).join('');

  let _spaceDragSrc = null;

  list.querySelectorAll('.ws-space-item').forEach(item => {
    item.addEventListener('click', () => {
      _wsCurrentSpaceId = item.dataset.spaceId;
      localStorage.setItem('ws-current-space', _wsCurrentSpaceId);
      _wsSelected.clear();
      wsCloseNotes();
      wsRenderSpaces();
      loadWorkspace();
    });

    item.addEventListener('dragstart', e => {
      _spaceDragSrc = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '';
      list.querySelectorAll('.ws-space-item').forEach(i => i.classList.remove('ws-drag-above', 'ws-drag-below'));
      _spaceDragSrc = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (!_spaceDragSrc || item === _spaceDragSrc) return;
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      list.querySelectorAll('.ws-space-item').forEach(i => i.classList.remove('ws-drag-above', 'ws-drag-below'));
      item.classList.add(before ? 'ws-drag-above' : 'ws-drag-below');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('ws-drag-above', 'ws-drag-below');
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!_spaceDragSrc || item === _spaceDragSrc) return;
      const before = item.classList.contains('ws-drag-above');
      const srcId = _spaceDragSrc.dataset.spaceId;
      const tgtId = item.dataset.spaceId;
      const srcIdx = _wsSpaces.findIndex(s => s.id === srcId);
      if (srcIdx !== -1) {
        const [moved] = _wsSpaces.splice(srcIdx, 1);
        const tgtIdx = _wsSpaces.findIndex(s => s.id === tgtId);
        _wsSpaces.splice(before ? tgtIdx : tgtIdx + 1, 0, moved);
      }
      wsRenderSpaces();
      wsReorderSpaces();
    });
  });
}

async function wsReorderSpaces() {
  try {
    await apiFetch('/api/workspace/spaces/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: _wsSpaces.map(s => s.id) }),
    });
  } catch { /* silent */ }
}

async function loadWorkspaceSpaces() {
  try {
    const data = await apiFetch('/api/workspace/spaces').then(r => r.json());
    _wsSpaces = data.spaces || [];
    _wsCanManage = !!data.canManage;
    document.getElementById('ws-new-space')?.classList.toggle('hidden', !_wsCanManage);
    document.getElementById('ws-invite-user')?.classList.toggle('hidden', !_wsCanManage);
    wsRenderSpaces();
    await loadWsStatusConfig();
  } catch (e) { console.error('Erro ao carregar espaços:', e); }
}

function currentWsQuery() {
  return _wsCurrentSpaceId ? `?spaceId=${encodeURIComponent(_wsCurrentSpaceId)}` : '';
}

function wsRenderCell(task, field) {
  if (WS_FIELDS[field] && WS_FIELDS[field].custom) {
    const val = task[field];
    return `<td class="ws-editable" data-id="${task.id}" data-field="${field}">${val ? escapeHtml(val) : '<span class="ws-dash">\u2014</span>'}</td>`;
  }
  if (field === 'vencimento') {
    const venStr = wsDateStr(task.vencimento);
    const ven = venStr
      ? venStr === '__hoje__'   ? `<span style="font-size:12px;font-weight:700;color:#fb923c;">Hoje</span>`
      : venStr === '__amanha__' ? `<span style="font-size:12px;font-weight:600;color:#94a3b8;">Amanhã</span>`
      : venStr === '__ontem__'  ? `<span style="font-size:12px;font-weight:700;color:#ef4444;">Ontem</span>`
      : `<span style="font-size:12px;">${venStr}</span>`
      : '<span class="ws-dash">—</span>';
    return `<td class="ws-editable" data-id="${task.id}" data-field="vencimento">${ven}</td>`;
  }
  if (field === 'tags') {
    const tags = (task.tags || []).map(tag => `<span class="ws-tag">${tag}</span>`).join('');
    return `<td>${tags}</td>`;
  }
  if (field === 'investimento') {
    const invest = task.investimento ? `<span class="ws-invest">R$${task.investimento}</span>` : '<span class="ws-dash">—</span>';
    return `<td class="ws-editable" data-id="${task.id}" data-field="investimento">${invest}</td>`;
  }
  return `<td class="ws-editable" data-id="${task.id}" data-field="${field}">${wsBadge(task[field])}</td>`;
}

function wsRenderFilter() {
  const bar = document.getElementById('ws-filter-bar');
  if (!bar) return;
  wsRenderAssigneeFilter();
  const counts = {};
  WS_STATUS_ORDER.forEach(s => { counts[s] = _wsTasks.filter(t => t.status === s).length; });
  const total = _wsTasks.length;
  const tabs = [{ key: 'todos', label: 'Todos', count: total, color: null }, ...WS_STATUS_ORDER.map(s => ({ key: s, label: s.charAt(0).toUpperCase() + s.slice(1), count: counts[s] || 0, color: WS_BADGE_COLORS[s]?.color || null }))];
  bar.innerHTML = `<div class="ws-tab-bar">${tabs.map(t => `<button class="ws-tab-btn${_wsFilter === t.key ? ' active' : ''}" data-filter="${t.key}"${t.color ? ` style="--tab-color:${t.color}"` : ''}>${t.label}<span class="ws-tab-count">${t.count}</span></button>`).join('<span class="ws-tab-arrow">›</span>')}</div>`;
  bar.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => { _wsFilter = btn.dataset.filter; wsRenderFilter(); wsRenderTable(); });
  });
}

let _wsColWidths = (() => { try { return JSON.parse(localStorage.getItem('ws-col-widths')) || {}; } catch { return {}; } })();

function wsApplyColWidths() {
  const table = document.getElementById('workspace-table');
  if (!table) return;
  table.querySelectorAll('thead .ws-col-resize').forEach(h => {
    const field = h.dataset.field;
    const w = _wsColWidths[field];
    if (!w) return;
    const th = h.closest('th'); if (!th) return;
    const idx = th.cellIndex; const wpx = w + 'px';
    th.style.width = wpx; th.style.minWidth = wpx; th.style.maxWidth = wpx;
    table.querySelectorAll('tbody tr > td:nth-child(' + (idx + 1) + ')').forEach(td => {
      td.style.width = wpx; td.style.minWidth = wpx; td.style.maxWidth = wpx; td.style.overflow = 'hidden';
    });
  });
}

function wsStartColResize(e, field, th) {
  e.preventDefault(); e.stopPropagation();
  if (!th) return;
  const startX = e.pageX;
  const startW = th.getBoundingClientRect().width;
  const wasDraggable = th.getAttribute('draggable');
  th.setAttribute('draggable', 'false');
  document.body.classList.add('ws-col-resizing');
  function move(ev) {
    const w = Math.max(70, Math.round(startW + (ev.pageX - startX)));
    _wsColWidths[field] = w;
    wsApplyColWidths();
  }
  function up() {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('ws-col-resizing');
    if (wasDraggable !== null) th.setAttribute('draggable', wasDraggable);
    localStorage.setItem('ws-col-widths', JSON.stringify(_wsColWidths));
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function wsRenderTable() {
  const tbody = document.getElementById('workspace-tbody');
  if (!tbody) return;

  // Re-render headers with drag support
  const theadTr = document.getElementById('workspace-thead-tr');
  if (theadTr) {
    const cols = getWsCols();
    let wsDragSrcField = null;
    theadTr.innerHTML = `
      <th class="ws-cb-th"><input type="checkbox" class="ws-checkbox" id="ws-select-all" title="Selecionar todos"></th>
      <th>NOME<span class="ws-col-resize" data-field="nome"></span></th>
      <th class="ws-comments-th" style="white-space:nowrap;text-align:center;">${COMMENT_SVG} COMENTÁRIOS</th>
      <th class="ws-th-responsavel">RESPONSÁVEL</th>
      ${cols.map(c => { const isCustom = _wsCustomCols.some(cc => cc.field === c.field); const del = isCustom ? `<span class="ws-col-del" data-field="${c.field}" title="Remover coluna">\u00d7</span>` : ''; return `<th draggable="true" data-ws-col="${c.field}" style="cursor:grab;user-select:none;">${c.label}${del}<span class="ws-col-resize" data-field="${c.field}"></span></th>`; }).join('')}
      <th class="ws-addcol-th"><button id="ws-add-col-btn" class="ws-addcol-btn" title="Adicionar coluna">+</button></th>`;
    theadTr.querySelectorAll('th[data-ws-col]').forEach(th => {
      th.addEventListener('dragstart', e => { wsDragSrcField = th.dataset.wsCol; th.style.opacity = '0.5'; e.dataTransfer.effectAllowed = 'move'; });
      th.addEventListener('dragend', () => { th.style.opacity = ''; wsDragSrcField = null; theadTr.querySelectorAll('th').forEach(t => t.classList.remove('ws-th-drag-over')); });
      th.addEventListener('dragover', e => { if (!wsDragSrcField || wsDragSrcField === th.dataset.wsCol) return; e.preventDefault(); th.classList.add('ws-th-drag-over'); });
      th.addEventListener('dragleave', () => th.classList.remove('ws-th-drag-over'));
      th.addEventListener('drop', e => {
        e.preventDefault();
        th.classList.remove('ws-th-drag-over');
        const src = wsDragSrcField; const tgt = th.dataset.wsCol;
        if (!src || src === tgt) return;
        const srcIdx = _wsColOrder.indexOf(src); const tgtIdx = _wsColOrder.indexOf(tgt);
        if (srcIdx === -1 || tgtIdx === -1) return;
        _wsColOrder.splice(srcIdx, 1); _wsColOrder.splice(tgtIdx, 0, src);
        localStorage.setItem('ws-col-order', JSON.stringify(_wsColOrder));
        wsRenderTable();
      });
    });
    // Re-wire select-all
    const selAll = document.getElementById('ws-select-all');
    if (selAll) selAll.addEventListener('change', e => {
      _wsSelected.clear();
      if (e.target.checked) _wsTasks.forEach(t => _wsSelected.add(t.id));
      wsRenderTable();
    });
    const addColBtn = document.getElementById('ws-add-col-btn');
    if (addColBtn) addColBtn.addEventListener('click', wsAddColumn);
    theadTr.querySelectorAll('.ws-col-del').forEach(x => x.addEventListener('click', ev => { ev.stopPropagation(); wsDeleteColumn(x.dataset.field); }));
    theadTr.querySelectorAll('.ws-col-resize').forEach(h => {
      h.addEventListener('mousedown', e => wsStartColResize(e, h.dataset.field, h.closest('th')));
      h.addEventListener('click', e => e.stopPropagation());
      h.addEventListener('dragstart', e => { e.preventDefault(); e.stopPropagation(); });
    });
  }

  const tasks = (_wsFilter === 'todos' ? _wsTasks : _wsTasks.filter(t => t.status === _wsFilter)).filter(t => !_wsFilterAssignee || t.responsavel === _wsFilterAssignee);
  const cols = getWsCols();

  tbody.innerHTML = tasks.map(t => {
    const sel = _wsSelected.has(t.id) ? 'ws-selected' : '';
    const chk = _wsSelected.has(t.id) ? 'checked' : '';
    return `<tr data-ws-id="${t.id}" class="${sel}">
      <td class="ws-cb-td"><input type="checkbox" class="ws-checkbox ws-row-cb" ${chk} data-id="${t.id}"></td>
      <td class="ws-nome-cell"><span class="ws-drag-handle" title="Arrastar">${DRAG_SVG}</span><span class="ws-nome-text">${escapeHtml(t.nome)}</span>${wsLabelDotsHtml(t)}<button class="ws-label-btn ws-nome-edit" data-id="${t.id}" data-field="nome" title="Renomear"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-edit"/></svg></button><button class="ws-label-btn" data-id="${t.id}" title="Labels"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-tag"/></svg></button></td>
      <td style="text-align:center;"><button class="ws-comment-count-btn${(t.comments||[]).length ? ' has-comments' : ''}" data-id="${t.id}" title="Ver comentários" style="display:inline-flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;color:${(t.comments||[]).length ? 'var(--text2)' : 'var(--text3)'};font-size:12px;padding:4px 8px;border-radius:6px;">${COMMENT_SVG}${(t.comments||[]).length ? `<span>${t.comments.length}</span>` : ''}</button></td>
      <td class="ws-assignee-cell" data-id="${t.id}">${wsRenderAssigneeCell(t)}</td>
      ${cols.map(c => wsRenderCell(t, c.field)).join('')}
    </tr>`;
  }).join('');

  // Editable cells
  tbody.querySelectorAll('td.ws-editable').forEach(cell => {
    cell.addEventListener('click', e => wsShowPicker(e, cell));
  });

  // Assignee cells
  tbody.querySelectorAll('.ws-assignee-cell').forEach(cell => {
    cell.addEventListener('click', e => wsShowAssigneePicker(e, cell));
  });

  // Nome cell → notes (but not on label button, dots, drag handle, or edit button)
  tbody.querySelectorAll('.ws-nome-cell').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.target.closest('.ws-drag-handle')) return;
      if (e.target.closest('.ws-label-btn')) return;
      if (e.target.closest('.ws-label-dots')) return;
      wsOpenNotes(cell.closest('tr').dataset.wsId);
    });
  });

  // Edit nome button → inline picker
  tbody.querySelectorAll('.ws-nome-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      wsShowPicker(e, btn);
    });
  });

  // Label button or dots open label picker
  tbody.querySelectorAll('.ws-label-btn, .ws-label-dots').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const id = el.dataset.id;
      if (id) wsShowLabelPicker(e, id);
    });
  });

  // Row checkboxes
  tbody.querySelectorAll('.ws-row-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.id;
      if (cb.checked) _wsSelected.add(id); else _wsSelected.delete(id);
      cb.closest('tr').classList.toggle('ws-selected', cb.checked);
      wsUpdateSelectionBar();
    });
  });

  // Comments column — open notes panel focused on comments
  tbody.querySelectorAll('.ws-comment-count-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      wsOpenNotes(btn.dataset.id);
    });
  });

  initWsDrag(tbody);
  wsUpdateSelectionBar();
  wsApplyColWidths();
}

async function wsAddTask() {
  const nome = prompt('Nome do cliente:');
  if (nome === null) return;
  const name = nome.trim();
  if (!name) return;
  try {
    const task = await apiFetch(`/api/workspace/tasks${currentWsQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: name, status: 'pendente' }),
    });
    _wsTasks.push(task);
    wsRenderTable();
    // flash the new row
    const tr = document.querySelector(`#workspace-tbody tr[data-ws-id="${task.id}"]`);
    if (tr) { tr.classList.add('ws-row-flash'); setTimeout(() => tr.classList.remove('ws-row-flash'), 1200); }
  } catch(e) {
    alert('Erro ao criar tarefa: ' + e.message);
  }
}

// ─── Workspace label helpers ──────────────────────────────────────────────────

function wsLabelDotsHtml(task) {
  const taskLabels = Array.isArray(task.labels) ? task.labels : [];
  if (!taskLabels.length) return '';
  const dots = taskLabels.map(name => {
    const def = _wsLabels.find(l => l.name === name);
    return `<span class="ws-label-dot" style="background:${def ? def.color : '#555'};" title="${escapeHtml(name)}"></span>`;
  }).join('');
  return `<span class="ws-label-dots" data-id="${task.id}" style="cursor:pointer;">${dots}</span>`;
}

async function loadWsLabels() {
  try {
    const res = await apiFetch(`/api/workspace/labels${currentWsQuery()}`);
    _wsLabels = await res.json();
  } catch { _wsLabels = []; }
}

async function loadWsStatusConfig() {
  try {
    const res = await apiFetch(`/api/workspace/status-config${currentWsQuery()}`);
    const data = await res.json();
    _wsStatusConfig = Array.isArray(data) && data.length ? data : null;
    applyWsStatusConfig();
  } catch { _wsStatusConfig = null; }
}

function getWsStatusConfig() {
  return _wsStatusConfig || WS_DEFAULT_STATUS_CONFIG;
}

function applyWsStatusConfig() {
  const cfg = getWsStatusConfig();
  WS_FIELDS.status.opts = cfg.map(s => s.name);
  WS_STATUS_ORDER.length = 0;
  cfg.forEach(s => WS_STATUS_ORDER.push(s.name));
  cfg.forEach(s => { WS_BADGE_COLORS[s.name] = { bg: s.bg, color: s.color }; });
}

async function openWsStatusConfigModal() {
  await loadWsStatusConfig();
  const cfg = getWsStatusConfig().map(s => ({ ...s }));
  renderWsStatusConfigList(cfg);
  document.getElementById('ws-status-config-modal').style.display = 'flex';
}

const STATUS_PRESET_COLORS = [
  { color: '#888',    bg: '#222',    label: 'Cinza' },
  { color: '#4caf50', bg: '#0d2e1a', label: 'Verde' },
  { color: '#42a5f5', bg: '#0d1e30', label: 'Azul' },
  { color: '#ef5350', bg: '#2e0d0d', label: 'Vermelho' },
  { color: '#66bb6a', bg: '#0d2214', label: 'Verde claro' },
  { color: '#ffc107', bg: '#2a1e06', label: 'Amarelo' },
  { color: '#ff9800', bg: '#2a1400', label: 'Laranja' },
  { color: '#ab47bc', bg: '#1e0d2a', label: 'Roxo' },
  { color: '#26c47a', bg: '#0d2a18', label: 'Turquesa' },
];

function renderWsStatusConfigList(cfg) {
  const list = document.getElementById('ws-status-config-list');
  if (!list) return;

  list.innerHTML = cfg.map((s, i) => `
    <div class="ws-status-config-row" data-index="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);position:relative;">
      <div class="ws-color-btn-wrap" style="position:relative;flex-shrink:0;">
        <button class="ws-color-btn" data-index="${i}" title="Trocar cor"
          style="width:28px;height:28px;border-radius:50%;background:${s.color};border:2px solid ${s.bg};cursor:pointer;outline:none;flex-shrink:0;"></button>
        <div class="ws-color-dropdown" data-index="${i}" style="display:none;position:absolute;top:34px;left:0;z-index:999;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:8px;display:none;flex-wrap:wrap;gap:6px;width:140px;box-shadow:0 4px 16px rgba(0,0,0,.4);">
          ${STATUS_PRESET_COLORS.map(p => `<span data-index="${i}" data-color="${p.color}" data-bg="${p.bg}" class="ws-status-color-pick" title="${p.label}" style="width:22px;height:22px;border-radius:50%;background:${p.color};cursor:pointer;border:2px solid ${s.color === p.color ? '#fff' : 'transparent'};flex-shrink:0;"></span>`).join('')}
        </div>
      </div>
      <input class="form-input ws-status-name-input" data-index="${i}" value="${escapeHtml(s.name)}"
        style="flex:1;padding:8px 12px;font-size:15px;font-weight:500;">
      <button class="ws-status-del-btn" data-index="${i}" title="Remover"
        style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:16px;padding:4px;opacity:${cfg.length <= 1 ? '0.3' : '1'};" ${cfg.length <= 1 ? 'disabled' : ''}>✕</button>
    </div>
  `).join('');

  // Toggle color dropdown
  list.querySelectorAll('.ws-color-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = btn.dataset.index;
      list.querySelectorAll('.ws-color-dropdown').forEach(d => {
        d.style.display = d.dataset.index === idx && d.style.display === 'none' ? 'flex' : 'none';
      });
    });
  });

  // Pick color
  list.querySelectorAll('.ws-status-color-pick').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index);
      cfg[idx].color = el.dataset.color;
      cfg[idx].bg = el.dataset.bg;
      renderWsStatusConfigList(cfg);
    });
  });

  list.querySelectorAll('.ws-status-name-input').forEach(el => {
    el.addEventListener('input', () => { cfg[parseInt(el.dataset.index)].name = el.value; });
  });
  list.querySelectorAll('.ws-status-del-btn').forEach(el => {
    el.addEventListener('click', () => {
      cfg.splice(parseInt(el.dataset.index), 1);
      renderWsStatusConfigList(cfg);
    });
  });

  // Close dropdowns on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeDropdowns(e) {
      if (!e.target.closest('.ws-color-btn-wrap')) {
        list.querySelectorAll('.ws-color-dropdown').forEach(d => d.style.display = 'none');
        document.removeEventListener('click', closeDropdowns);
      }
    });
  }, 0);

  document.getElementById('ws-status-config-modal').dataset.cfg = JSON.stringify(cfg);
}

async function saveWsStatusConfig() {
  const modal = document.getElementById('ws-status-config-modal');
  const cfg = JSON.parse(modal.dataset.cfg || '[]');
  modal.querySelectorAll('.ws-status-name-input').forEach(el => {
    const idx = parseInt(el.dataset.index);
    if (cfg[idx]) cfg[idx].name = el.value.trim();
  });
  const valid = cfg.filter(s => s.name);
  if (!valid.length) return;
  try {
    const res = await apiFetch(`/api/workspace/status-config${currentWsQuery()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statuses: valid })
    });
    if (!res.ok) throw new Error('Erro ao salvar');
    _wsStatusConfig = valid;
    applyWsStatusConfig();
    modal.style.display = 'none';
    await loadWorkspace();
  } catch(e) { alert(e.message); }
}

function addWsStatusOption() {
  const modal = document.getElementById('ws-status-config-modal');
  const cfg = JSON.parse(modal.dataset.cfg || '[]');
  cfg.push({ name: 'novo status', color: '#888', bg: '#222' });
  renderWsStatusConfigList(cfg);
}

function wsCloseLabelPicker() {
  const p = document.getElementById('ws-label-picker');
  if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  _wsLabelPickerId = null;
}

function wsShowLabelPicker(e, id) {
  e.stopPropagation();
  if (_wsLabelPickerId === id) { wsCloseLabelPicker(); return; }
  wsClosePicker();
  _wsLabelPickerId = id;
  const task = _wsTasks.find(t => t.id === id);
  if (!task) return;

  const picker = document.getElementById('ws-label-picker');
  picker.innerHTML = '';

  const anchor = e.currentTarget;
  const rect = anchor.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  picker.style.display = 'block';
  picker.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
  if (spaceBelow > 200) {
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.bottom = 'auto';
  } else {
    picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    picker.style.top = 'auto';
  }

  wsRenderLabelPickerContent(picker, task);
}

function wsRenderLabelPickerContent(picker, task) {
  picker.innerHTML = '';
  const taskLabels = Array.isArray(task.labels) ? task.labels : [];

  // Search/create input
  const inputWrap = document.createElement('div');
  inputWrap.className = 'ws-lp-input-wrap';
  const inp = document.createElement('input');
  inp.className = 'ws-lp-input';
  inp.placeholder = 'Buscar ou criar label...';
  inputWrap.appendChild(inp);
  picker.appendChild(inputWrap);
  setTimeout(() => inp.focus(), 0);

  // Assigned labels section
  if (taskLabels.length) {
    const sec = document.createElement('div');
    sec.className = 'ws-lp-section';
    sec.textContent = 'Atribuídas';
    picker.appendChild(sec);
    const chips = document.createElement('div');
    chips.className = 'ws-lp-chips';
    taskLabels.forEach(name => {
      const def = _wsLabels.find(l => l.name === name);
      const chip = document.createElement('span');
      chip.className = 'ws-lp-chip';
      chip.style.background = def ? def.color : '#555';
      chip.innerHTML = `${escapeHtml(name)}<button class="ws-lp-chip-remove" title="Remover">×</button>`;
      chip.querySelector('.ws-lp-chip-remove').addEventListener('click', async () => {
        const newLabels = taskLabels.filter(l => l !== name);
        await wsSaveField(task.id, 'labels', newLabels);
        const updatedTask = _wsTasks.find(t => t.id === task.id);
        if (updatedTask) wsRenderLabelPickerContent(picker, updatedTask);
      });
      chips.appendChild(chip);
    });
    picker.appendChild(chips);
  }

  // Available labels section
  const renderList = (filter = '') => {
    let listEl = picker.querySelector('.ws-lp-list');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'ws-lp-list';
      picker.appendChild(listEl);
    }
    listEl.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const available = _wsLabels.filter(l => !taskLabels.includes(l.name) && (!f || l.name.toLowerCase().includes(f)));

    if (available.length) {
      const sec = document.createElement('div');
      sec.className = 'ws-lp-section';
      sec.textContent = 'Disponíveis';
      listEl.appendChild(sec);
      available.forEach(l => {
        const row = document.createElement('div');
        row.className = 'ws-lp-row';
        row.innerHTML = `<span class="ws-lp-dot" style="background:${l.color};"></span><span style="flex:1">${escapeHtml(l.name)}</span>`;
        const delBtn = document.createElement('button');
        delBtn.className = 'ws-lp-delete';
        delBtn.title = 'Excluir label';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm(`Excluir label "${l.name}" de todos os clientes?`)) return;
          await apiFetch(`/api/workspace/labels/${encodeURIComponent(l.name)}${currentWsQuery()}`, { method: 'DELETE' });
          await loadWsLabels();
          await loadWorkspace();
          const updatedTask = _wsTasks.find(t => t.id === task.id);
          if (updatedTask) wsRenderLabelPickerContent(picker, updatedTask);
        });
        row.appendChild(delBtn);
        row.addEventListener('click', async () => {
          const newLabels = [...taskLabels, l.name];
          await wsSaveField(task.id, 'labels', newLabels);
          const updatedTask = _wsTasks.find(t => t.id === task.id);
          if (updatedTask) wsRenderLabelPickerContent(picker, updatedTask);
        });
        listEl.appendChild(row);
      });
    }

    // Create new label option
    if (f && !_wsLabels.some(l => l.name.toLowerCase() === f)) {
      const row = document.createElement('div');
      row.className = 'ws-lp-row ws-lp-create';
      row.textContent = `+ Criar label "${filter.trim()}"`;
      row.addEventListener('click', async () => {
        const res = await apiFetch(`/api/workspace/labels${currentWsQuery()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: filter.trim() }),
        });
        if (!res.ok) return;
        const newLabel = await res.json();
        _wsLabels.push(newLabel);
        const newLabels = [...taskLabels, newLabel.name];
        await wsSaveField(task.id, 'labels', newLabels);
        const updatedTask = _wsTasks.find(t => t.id === task.id);
        if (updatedTask) wsRenderLabelPickerContent(picker, updatedTask);
      });
      listEl.appendChild(row);
    }
  };

  renderList();
  inp.addEventListener('input', () => renderList(inp.value));
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') wsCloseLabelPicker(); });
}

// ─── Inline picker ────────────────────────────────────────────────────────────

let _pickerCell = null;

function wsClosePicker() {
  const p = document.getElementById('ws-picker');
  p.style.display = 'none';
  p.style.transform = '';
  p.innerHTML = '';
  _pickerCell = null;
}

function wsShowPicker(e, cell) {
  e.stopPropagation();
  wsCloseLabelPicker();
  const id = cell.dataset.id;
  const field = cell.dataset.field;
  const def = WS_FIELDS[field];
  if (!def) return;

  const task = _wsTasks.find(t => t.id === id);
  if (!task) return;

  const picker = document.getElementById('ws-picker');
  picker.innerHTML = '';
  _pickerCell = cell;

  const rect = cell.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > 200 ? rect.bottom + 4 : rect.top - 4;
  const align = spaceBelow > 200 ? 'top' : 'bottom';

  picker.style.display = 'block';
  picker.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
  picker.style[align === 'top' ? 'top' : 'bottom'] = (align === 'top' ? top : window.innerHeight - rect.top + 4) + 'px';
  picker.style[align === 'top' ? 'bottom' : 'top'] = 'auto';

  if (def.opts) {
    if (def.nullable) {
      const clr = document.createElement('button');
      clr.className = 'ws-pick-opt clr';
      clr.textContent = '— limpar';
      clr.addEventListener('click', () => wsSaveField(id, field, null));
      picker.appendChild(clr);
    }
    def.opts.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'ws-pick-opt' + (task[field] === opt ? ' cur' : '');
      const c = WS_BADGE_COLORS[opt];
      if (c) btn.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c.bg};border:1px solid ${c.color};margin-right:8px;vertical-align:middle;"></span>${opt}`;
      else btn.textContent = opt;
      btn.addEventListener('click', () => wsSaveField(id, field, opt));
      picker.appendChild(btn);
    });
  } else if (def.type === 'text') {
    const wrap = document.createElement('div');
    wrap.className = 'ws-pick-input-wrap';
    const inp = document.createElement('input');
    inp.className = 'ws-pick-input';
    inp.placeholder = def.placeholder || '';
    inp.value = task[field] || '';
    const hint = document.createElement('span');
    hint.className = 'ws-pick-hint';
    hint.textContent = 'Enter para salvar';
    wrap.appendChild(inp);
    wrap.appendChild(hint);
    picker.appendChild(wrap);
    setTimeout(() => inp.focus(), 0);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') wsSaveField(id, field, inp.value.trim() || null);
      if (e.key === 'Escape') wsClosePicker();
    });
  } else if (def.type === 'date') {
    const wrap = document.createElement('div');
    wrap.className = 'ws-pick-input-wrap';
    const inp = document.createElement('input');
    inp.type = 'date';
    inp.className = 'ws-pick-input';
    if (task[field]) {
      const d = new Date(task[field]);
      inp.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    if (def.nullable) {
      const clr = document.createElement('button');
      clr.className = 'ws-pick-opt clr';
      clr.textContent = '— limpar data';
      clr.addEventListener('click', () => wsSaveField(id, field, null));
      picker.insertBefore(clr, picker.firstChild);
    }
    wrap.appendChild(inp);
    picker.appendChild(wrap);
    setTimeout(() => { inp.focus(); try { inp.showPicker(); } catch {} }, 0);
    inp.addEventListener('change', () => {
      const ts = inp.value ? new Date(inp.value + 'T12:00:00').getTime() : null;
      wsSaveField(id, field, ts);
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') wsClosePicker(); });
  }
}

async function wsSaveField(id, field, value) {
  wsClosePicker();
  const task = _wsTasks.find(t => t.id === id);
  if (!task) return;
  const oldVal = task[field];
  task[field] = value;
  wsRenderTable();
  try {
    const res = await apiFetch(`/api/workspace/tasks/${id}${currentWsQuery()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) throw new Error('erro');
    const updated = await res.json();
    const idx = _wsTasks.findIndex(t => t.id === id);
    if (idx !== -1) _wsTasks[idx] = updated;
    wsRenderFilter();
    wsRenderTable();
  } catch {
    task[field] = oldVal;
    wsRenderTable();
  }
}

async function loadWorkspace() {
  try {
    if (!_wsSpaces.length) await loadWorkspaceSpaces();
    const [tasksRes, membersRes] = await Promise.all([
      apiFetch(`/api/workspace/tasks${currentWsQuery()}`),
      apiFetch('/api/workspace/members'),
      loadWsLabels(),
    ]);
    _wsTasks = await tasksRes.json();
    if (membersRes.ok) _wsMembers = await membersRes.json();
    try { const colsRes = await apiFetch('/api/workspace/columns'); if (colsRes.ok) { const ct = (colsRes.headers.get('content-type')||''); if (ct.includes('json')) _wsCustomCols = await colsRes.json(); } } catch {}
    if (!Array.isArray(_wsCustomCols)) _wsCustomCols = [];
    wsRegisterCustomCols();
    wsRenderFilter();
    wsRenderTable();
  } catch(err) {
    console.error('Erro ao carregar workspace:', err);
  }
}

function setupWsSidenav() {
  const sidenav = document.getElementById('ws-sidenav');
  const handle  = document.getElementById('ws-sidenav-resize');
  if (!sidenav || !handle) return;

  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true; startX = e.clientX; startW = sidenav.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(120, Math.min(320, startW + e.clientX - startX));
    sidenav.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ─── Drag & drop reorder ─────────────────────────────────────────────────────

function initWsDrag(tbody) {
  let dragSrc = null, isDragHandleDown = false;

  tbody.addEventListener('mousedown', e => {
    isDragHandleDown = !!e.target.closest('.ws-drag-handle');
    if (isDragHandleDown) {
      const row = e.target.closest('tr');
      if (row) row.draggable = true;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragHandleDown) {
      tbody.querySelectorAll('tr').forEach(r => r.removeAttribute('draggable'));
      isDragHandleDown = false;
    }
  }, { capture: true });

  tbody.addEventListener('dragstart', e => {
    const row = e.target.closest('tr[draggable]');
    if (!row) { e.preventDefault(); return; }
    dragSrc = row;
    row.classList.add('ws-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.wsId);
  });

  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    const row = e.target.closest('tr');
    if (!row || row === dragSrc) return;
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('ws-drag-above', 'ws-drag-below'));
    const mid = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    row.classList.add(e.clientY < mid ? 'ws-drag-above' : 'ws-drag-below');
    e.dataTransfer.dropEffect = 'move';
  });

  tbody.addEventListener('dragleave', e => {
    const row = e.target.closest('tr');
    if (row) row.classList.remove('ws-drag-above', 'ws-drag-below');
  });

  tbody.addEventListener('drop', e => {
    e.preventDefault();
    const targetRow = e.target.closest('tr');
    const cleanup = () => {
      tbody.querySelectorAll('tr').forEach(r => {
        r.classList.remove('ws-drag-above', 'ws-drag-below', 'ws-dragging');
        r.removeAttribute('draggable');
      });
      dragSrc = null;
    };
    if (!targetRow || !dragSrc || targetRow === dragSrc) { cleanup(); return; }

    const insertBefore = targetRow.classList.contains('ws-drag-above');
    const srcId = dragSrc.dataset.wsId;
    const tgtId = targetRow.dataset.wsId;

    // Reorder in _wsTasks (operating on the full list, not filtered)
    const srcIdx = _wsTasks.findIndex(t => t.id === srcId);
    if (srcIdx !== -1) {
      const [moved] = _wsTasks.splice(srcIdx, 1);
      const newTgtIdx = _wsTasks.findIndex(t => t.id === tgtId);
      if (newTgtIdx !== -1) {
        _wsTasks.splice(insertBefore ? newTgtIdx : newTgtIdx + 1, 0, moved);
      } else {
        _wsTasks.push(moved);
      }
    }
    cleanup();
    wsRenderTable();
    wsReorder();
  });

  tbody.addEventListener('dragend', () => {
    tbody.querySelectorAll('tr').forEach(r => {
      r.classList.remove('ws-dragging', 'ws-drag-above', 'ws-drag-below');
      r.removeAttribute('draggable');
    });
    dragSrc = null;
  });
}

async function wsReorder() {
  try {
    await apiFetch(`/api/workspace/reorder${currentWsQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: _wsTasks.map(t => t.id) }),
    });
  } catch { /* silent */ }
}

// ─── Notes panel ─────────────────────────────────────────────────────────────

function wsFileIcon(type, name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['jpg','jpeg','png','gif','webp'].includes(ext)) return '🖼️';
  if (['mp4','mov','avi','webm'].includes(ext)) return '🎬';
  if (['doc','docx'].includes(ext)) return '📝';
  if (['xls','xlsx'].includes(ext)) return '📊';
  if (['zip','rar','7z'].includes(ext)) return '🗜️';
  return '📎';
}

function wsFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wsRenderFiles(files) {
  const list = document.getElementById('ws-files-list');
  if (!list) return;
  if (!files || !files.length) { list.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px 0;">Nenhum arquivo anexado.</div>'; return; }
  list.innerHTML = files.map((f, i) => `
    <div class="ws-file-item" data-file-idx="${i}">
      <span class="ws-file-icon">${wsFileIcon(f.type, f.name)}</span>
      <div class="ws-file-info">
        <div class="ws-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="ws-file-meta">${wsFileSize(f.size)}</div>
      </div>
      <a class="ws-file-dl" href="${escapeHtml(f.url)}" download="${escapeHtml(f.name)}" target="_blank">⬇ Baixar</a>
      <button class="ws-file-del" data-url="${escapeHtml(f.url)}" title="Remover">✕</button>
    </div>`).join('');
  list.querySelectorAll('.ws-file-del').forEach(btn => {
    btn.addEventListener('click', () => wsDeleteFile(btn.dataset.url));
  });
}

async function wsDeleteFile(url) {
  if (!_wsNoteId) return;
  const filename = url.split('/').pop();
  if (!confirm(`Remover "${filename}"?`)) return;
  try {
    await apiFetch(`/api/workspace/tasks/${_wsNoteId}/files/${encodeURIComponent(filename)}${currentWsQuery()}`, { method: 'DELETE' });
    const task = _wsTasks.find(t => t.id === _wsNoteId);
    if (task) { task.files = (task.files || []).filter(f => f.url !== url); wsRenderFiles(task.files); }
  } catch (e) { alert('Erro ao remover arquivo: ' + e.message); }
}

function wsLinkify(text) {
  if (!text) return '';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function wsFormatCommentTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function wsRenderMeta(task) {
  const meta = document.getElementById('ws-detail-meta');
  if (!meta) return;
  const chips = [];
  if (task.status) {
    const c = WS_BADGE_COLORS[task.status] || {};
    chips.push(`<span class="ws-meta-chip" data-field="status" data-id="${task.id}" style="border-color:${c.bg||'transparent'}"><span class="ws-meta-chip-label">Status</span><span class="ws-meta-chip-val" style="color:${c.color||'var(--text)'}">${escapeHtml(task.status)}</span></span>`);
  }
  if (task.vencimento) {
    const venStr = wsDateStr(task.vencimento);
    const label = venStr === '__hoje__' ? 'Hoje' : venStr === '__amanha__' ? 'Amanhã' : venStr === '__ontem__' ? 'Ontem' : (venStr || task.vencimento);
    const color = venStr === '__ontem__' ? '#ef4444' : venStr === '__hoje__' ? '#fb923c' : 'var(--text)';
    chips.push(`<span class="ws-meta-chip" data-field="vencimento" data-id="${task.id}"><span class="ws-meta-chip-label">Venc.</span><span class="ws-meta-chip-val" style="color:${color}">${escapeHtml(label)}</span></span>`);
  }
  if (task.investimento) {
    chips.push(`<span class="ws-meta-chip" data-field="investimento" data-id="${task.id}"><span class="ws-meta-chip-label">Invest.</span><span class="ws-meta-chip-val">R$${escapeHtml(task.investimento)}</span></span>`);
  }
  if (task.resultado) {
    const c = WS_BADGE_COLORS[task.resultado] || {};
    chips.push(`<span class="ws-meta-chip" data-field="resultado" data-id="${task.id}"><span class="ws-meta-chip-label">Result.</span><span class="ws-meta-chip-val" style="color:${c.color||'var(--text)'}">${escapeHtml(task.resultado)}</span></span>`);
  }
  meta.innerHTML = chips.length ? chips.join('') : '<span style="font-size:12px;color:var(--text3);">Clique nas células da tabela para editar campos.</span>';
  meta.querySelectorAll('.ws-meta-chip[data-field]').forEach(chip => {
    chip.addEventListener('click', e => wsShowPicker(e, chip));
  });
}

function wsRenderDescPreview(text) {
  const preview = document.getElementById('ws-desc-preview');
  const textarea = document.getElementById('ws-notes-textarea');
  if (!preview || !textarea) return;
  if (text) {
    preview.innerHTML = wsLinkify(text);
    preview.style.display = 'block';
    textarea.style.display = 'none';
  } else {
    preview.style.display = 'none';
    textarea.style.display = '';
  }
}

function wsRenderComments(comments) {
  const list = document.getElementById('ws-comments-list');
  if (!list) return;
  if (!comments || !comments.length) {
    list.innerHTML = '<div class="ws-comments-empty">Nenhum comentário ainda.</div>';
    return;
  }
  list.innerHTML = comments.map(c => `
    <div class="ws-comment-item" data-comment-id="${c.id}">
      <div class="ws-comment-meta">
        <span class="ws-comment-author">${escapeHtml(c.author || 'Você')}</span>
        <span class="ws-comment-time">${wsFormatCommentTime(c.createdAt)}</span>
        <button class="ws-comment-del" title="Excluir">✕</button>
      </div>
      <div class="ws-comment-text">${wsLinkify(c.text || '')}</div>
    </div>`).join('');
  list.querySelectorAll('.ws-comment-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('[data-comment-id]')?.dataset.commentId;
      if (id) wsDeleteComment(id);
    });
  });
  list.scrollTop = list.scrollHeight;
}

async function wsLoadComments(taskId) {
  try {
    const res = await apiFetch(`/api/workspace/tasks/${taskId}/comments${currentWsQuery()}`);
    const comments = await res.json();
    wsRenderComments(comments);
    const task = _wsTasks.find(t => t.id === taskId);
    if (task) task.comments = comments;
  } catch { wsRenderComments([]); }
}

async function wsAddComment() {
  if (!_wsNoteId) return;
  const ta = document.getElementById('ws-comment-text');
  const text = (ta?.value || '').trim();
  if (!text) return;
  const btn = document.getElementById('ws-add-comment');
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch(`/api/workspace/tasks/${_wsNoteId}/comments${currentWsQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const comment = await res.json();
    if (!res.ok) throw new Error(comment.error || 'Erro');
    const task = _wsTasks.find(t => t.id === _wsNoteId);
    if (task) { if (!task.comments) task.comments = []; task.comments.push(comment); wsRenderComments(task.comments); }
    if (ta) ta.value = '';
  } catch (e) { alert('Erro ao comentar: ' + e.message); }
  finally { if (btn) btn.disabled = false; }
}

async function wsDeleteComment(commentId) {
  if (!_wsNoteId) return;
  try {
    await apiFetch(`/api/workspace/tasks/${_wsNoteId}/comments/${commentId}${currentWsQuery()}`, { method: 'DELETE' });
    const task = _wsTasks.find(t => t.id === _wsNoteId);
    if (task) { task.comments = (task.comments || []).filter(c => c.id !== commentId); wsRenderComments(task.comments); }
  } catch (e) { alert('Erro ao excluir comentário: ' + e.message); }
}

function wsOpenNotes(id) {
  const task = _wsTasks.find(t => t.id === id);
  if (!task) return;
  _wsNoteId = id;
  const titleInput = document.getElementById('ws-notes-title');
  if (titleInput) titleInput.value = task.nome || '';
  const textarea = document.getElementById('ws-notes-textarea');
  if (textarea) { textarea.value = task.descricao || ''; textarea.style.display = ''; }
  const preview = document.getElementById('ws-desc-preview');
  if (preview) preview.style.display = 'none';
  document.getElementById('ws-notes-hint').textContent = 'Ctrl+S para salvar';
  document.getElementById('ws-notes-hint').className = 'ws-notes-hint';
  wsRenderMeta(task);
  wsRenderFiles(task.files || []);
  wsRenderComments(task.comments || []);
  wsLoadComments(id);
  document.getElementById('ws-notes-panel').classList.add('open');
  setTimeout(() => textarea?.focus(), 260);
}

function wsCloseNotes() {
  document.getElementById('ws-notes-panel').classList.remove('open');
  _wsNoteId = null;
}

async function wsSaveNotes() {
  if (!_wsNoteId) return;
  const titleInput = document.getElementById('ws-notes-title');
  const val = document.getElementById('ws-notes-textarea').value;
  const hint = document.getElementById('ws-notes-hint');
  const updates = { descricao: val || null };
  const newNome = (titleInput?.value || '').trim();
  if (newNome) updates.nome = newNome;
  const task = _wsTasks.find(t => t.id === _wsNoteId);
  if (task) Object.assign(task, updates);
  wsRenderTable();
  try {
    await apiFetch(`/api/workspace/tasks/${_wsNoteId}${currentWsQuery()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  } catch { /* silent */ }
  hint.textContent = '✓ Salvo';
  hint.className = 'ws-notes-hint saved';
  setTimeout(() => { hint.textContent = 'Ctrl+S para salvar'; hint.className = 'ws-notes-hint'; }, 2000);
  wsRenderDescPreview(val);
}

async function wsUploadFile(file) {
  if (!_wsNoteId) return;
  const progress = document.getElementById('ws-files-progress');
  const bar = document.getElementById('ws-files-progress-bar');
  const text = document.getElementById('ws-files-progress-text');
  progress.style.display = 'block';
  bar.style.width = '10%';
  text.textContent = `Enviando ${file.name}...`;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await apiFetch(`/api/workspace/tasks/${_wsNoteId}/files${currentWsQuery()}`, { method: 'POST', body: fd });
    bar.style.width = '90%';
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro no upload');
    bar.style.width = '100%';
    const task = _wsTasks.find(t => t.id === _wsNoteId);
    if (task) { if (!task.files) task.files = []; task.files.push(data); wsRenderFiles(task.files); }
    setTimeout(() => { progress.style.display = 'none'; bar.style.width = '0%'; }, 600);
  } catch (e) {
    progress.style.display = 'none'; bar.style.width = '0%';
    alert('Erro ao enviar arquivo: ' + e.message);
  }
}

// ─── Selection bar ────────────────────────────────────────────────────────────

function wsUpdateSelectionBar() {
  const bar = document.getElementById('ws-selection-bar');
  const count = document.getElementById('ws-sel-count');
  const selectAll = document.getElementById('ws-select-all');
  if (!bar) return;

  const n = _wsSelected.size;
  bar.classList.toggle('visible', n > 0);
  if (count) count.textContent = `${n} selecionado${n !== 1 ? 's' : ''}`;

  // Sync select-all checkbox
  if (selectAll) {
    const visible = document.querySelectorAll('#workspace-tbody .ws-row-cb');
    const checkedCount = [...visible].filter(cb => cb.checked).length;
    selectAll.checked = visible.length > 0 && checkedCount === visible.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < visible.length;
  }
}

function wsShowBulkStatusPicker(e) {
  e.stopPropagation();
  if (_wsSelected.size === 0) return;
  const picker = document.getElementById('ws-picker');
  picker.innerHTML = '';
  _pickerCell = null;
  const btn = document.getElementById('ws-sel-status');
  const rect = btn.getBoundingClientRect();
  picker.style.display = 'block';
  picker.style.left = rect.left + 'px';
  picker.style.top = (rect.top - 8) + 'px';
  picker.style.bottom = 'auto';
  picker.style.transform = 'translateY(-100%)';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:11px;color:#888;padding:6px 10px 4px;border-bottom:1px solid rgba(255,255,255,0.08);';
  title.textContent = `Alterar ${_wsSelected.size} item(s)`;
  picker.appendChild(title);
  WS_FIELDS.status.opts.forEach(opt => {
    const btn2 = document.createElement('button');
    btn2.className = 'ws-pick-opt';
    const c = WS_BADGE_COLORS[opt];
    if (c) btn2.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c.bg};border:1px solid ${c.color};margin-right:8px;vertical-align:middle;"></span>${opt}`;
    else btn2.textContent = opt;
    btn2.addEventListener('click', () => wsBulkSetStatus(opt));
    picker.appendChild(btn2);
  });
}

async function wsBulkSetStatus(status) {
  wsClosePicker();
  if (_wsSelected.size === 0) return;
  const ids = [..._wsSelected];
  ids.forEach(id => { const t = _wsTasks.find(x => x.id === id); if (t) t.status = status; });
  wsRenderFilter();
  wsRenderTable();
  try {
    await apiFetch(`/api/workspace/tasks${currentWsQuery()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, fields: { status } }),
    });
  } catch (e) { alert('Erro ao atualizar status: ' + e.message); }
}

async function wsDeleteSelected() {
  if (_wsSelected.size === 0) return;
  if (!confirm(`Excluir ${_wsSelected.size} cliente(s)? Esta ação não pode ser desfeita.`)) return;
  const ids = [..._wsSelected];
  try {
    await apiFetch(`/api/workspace/tasks${currentWsQuery()}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    _wsTasks = _wsTasks.filter(t => !ids.includes(t.id));
    _wsSelected.clear();
    wsRenderFilter();
    wsRenderTable();
  } catch(e) {
    alert('Erro ao excluir: ' + e.message);
  }
}

function openWsSpaceModal() {
  document.getElementById('ws-space-name').value = '';
  document.getElementById('ws-space-feedback').style.display = 'none';
  document.getElementById('ws-space-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('ws-space-name').focus(), 50);
}

async function saveWsSpace() {
  const fb = document.getElementById('ws-space-feedback');
  const name = document.getElementById('ws-space-name').value.trim();
  if (!name) { showFeedback(fb, 'Digite um nome', 'error'); return; }
  try {
    const res = await apiFetch('/api/workspace/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao criar');
    document.getElementById('ws-space-modal').style.display = 'none';
    _wsCurrentSpaceId = data.id;
    localStorage.setItem('ws-current-space', _wsCurrentSpaceId);
    await loadWorkspaceSpaces();
    await loadWorkspace();
  } catch (e) { showFeedback(fb, e.message, 'error'); }
}

const FEATURE_LABELS = {
  schedule: 'Novo Agendamento', broadcast: 'Disparador', pending: 'Agendados', logs: 'Histórico', reports: 'Relatórios', chat: 'Chat ao vivo', crm: 'CRM', prospects: 'Contatos', queue: 'Fila da vez', workspace: 'WorkSpace', config: 'Configurações', debug: 'Debug', templates: 'Templates'
};

async function openWsInviteModal(user = null) {
  await loadWorkspaceSpaces();
  const isEdit = !!user;
  document.getElementById('ws-invite-edit-id').value = user?.id || '';
  document.getElementById('ws-invite-modal-title').textContent = isEdit ? 'Editar permissões' : 'Convidar pessoa';
  document.getElementById('ws-invite-save-label').textContent = isEdit ? 'Salvar permissões' : 'Criar acesso';
  document.getElementById('ws-invite-name').value = user?.name || '';
  document.getElementById('ws-invite-username').value = user?.username || '';
  document.getElementById('ws-invite-password').value = '';
  document.getElementById('ws-invite-password-hint').textContent = isEdit ? '(deixe em branco para manter)' : '';
  document.getElementById('ws-invite-username-wrap').style.opacity = isEdit ? '0.5' : '1';
  document.getElementById('ws-invite-username').disabled = isEdit;
  document.getElementById('ws-invite-admin').checked = !!user?.permissions?.workspaceAdmin;
  document.getElementById('ws-invite-feedback').style.display = 'none';

  const userSpaces = user?.permissions?.workspaceSpaces || [];
  document.getElementById('ws-invite-spaces').innerHTML = _wsSpaces.map(s =>
    `<label><input type="checkbox" value="${escapeHtml(s.id)}" ${isEdit ? (userSpaces.includes(s.id) ? 'checked' : '') : (s.id === _wsCurrentSpaceId ? 'checked' : '')}> ${escapeHtml(s.name)}</label>`
  ).join('');

  const userFeatures = user?.permissions?.features || ['workspace'];
  document.getElementById('ws-invite-features').innerHTML = ALL_APP_FEATURES.map(f =>
    `<label><input type="checkbox" value="${f}" ${isEdit ? (userFeatures.includes(f) ? 'checked' : '') : (f === 'workspace' ? 'checked' : '')}> ${FEATURE_LABELS[f]}</label>`
  ).join('');

  if (!isEdit) await loadWsInvites();
  document.getElementById('ws-invite-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('ws-invite-name').focus(), 50);
}

async function loadWsInvites() {
  const el = document.getElementById('ws-invite-list');
  if (!el) return;
  try {
    const users = await apiFetch('/api/workspace/invites').then(r => r.json());
    if (!users.length) { el.innerHTML = '<div class="ws-space-empty">Nenhum convidado ainda</div>'; return; }
    el.innerHTML = users.map(u => {
      const chatConn = u.chatConnectionId || u.defaultConnectionId || null;
      const bcastConn = u.broadcastConnectionId || null;
      const connLabel = chatConn ? (CONNECTION_LABELS[chatConn] || { label: chatConn, color: '#8696a0' }) : null;
      const connPhone = chatConn ? (_connectionPhones[chatConn] || '') : '';
      const connBadge = connLabel ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:9px;font-size:10px;background:${connLabel.color};color:#fff;">${escapeHtml(connPhone || connLabel.label)}</span>` : '';
      const bcastLabel = bcastConn ? (CONNECTION_LABELS[bcastConn] || { label: bcastConn, color: '#8696a0' }) : null;
      const bcastPhone = bcastConn ? (_connectionPhones[bcastConn] || '') : '';
      const bcastBadge = bcastLabel ? `<span style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:9px;font-size:10px;background:${bcastLabel.color};color:#fff;opacity:0.8;" title="Disparo">${escapeHtml(bcastPhone || bcastLabel.label)}</span>` : '';
      return `
      <div class="ws-invite-row" data-invite-id="${escapeHtml(u.id)}">
        <div>
          <strong>${escapeHtml(u.name)}</strong>${connBadge}${bcastBadge}<br>
          <span>@${escapeHtml(u.username)}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="ws-invite-edit-btn" data-id="${escapeHtml(u.id)}">⚙ Configurar</button>
          <button class="ws-invite-del-btn" data-id="${escapeHtml(u.id)}">Remover</button>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('.ws-invite-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = users.find(x => x.id === btn.dataset.id);
        if (u) openWsInviteModal(u);
      });
    });
    el.querySelectorAll('.ws-invite-del-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteWsInvite(btn.dataset.id));
    });
  } catch { el.innerHTML = ''; }
}

async function saveWsInvite() {
  const fb = document.getElementById('ws-invite-feedback');
  const editId = document.getElementById('ws-invite-edit-id').value;
  const isEdit = !!editId;
  const payload = {
    name: document.getElementById('ws-invite-name').value.trim(),
    workspaceAdmin: document.getElementById('ws-invite-admin').checked,
    workspaceSpaces: [...document.querySelectorAll('#ws-invite-spaces input:checked')].map(i => i.value),
    features: [...document.querySelectorAll('#ws-invite-features input:checked')].map(i => i.value),
  };
  const pwd = document.getElementById('ws-invite-password').value.trim();
  if (pwd) payload.password = pwd;
  if (!isEdit) payload.username = document.getElementById('ws-invite-username').value.trim();
  if (!payload.features.includes('workspace')) payload.features.push('workspace');
  try {
    const url = isEdit ? `/api/workspace/invites/${editId}` : '/api/workspace/invites';
    const method = isEdit ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao salvar');
    showFeedback(fb, isEdit ? '✓ Permissões salvas' : '✓ Acesso criado', 'success');
    if (!isEdit) {
      document.getElementById('ws-invite-name').value = '';
      document.getElementById('ws-invite-username').value = '';
      document.getElementById('ws-invite-password').value = '';
    }
    await loadWsInvites();
  } catch(e) { showFeedback(fb, e.message, 'error'); }
}

async function deleteWsInvite(id) {
  if (!confirm('Remover este acesso?')) return;
  await apiFetch(`/api/workspace/invites/${id}`, { method: 'DELETE' });
  loadWsInvites();
}

// ─── Setup ────────────────────────────────────────────────────────────────────

function wsSetupDragScroll() {
  const wrap = document.querySelector('.ws-table-wrap');
  if (!wrap || wrap._dragScrollWired) return;
  wrap._dragScrollWired = true;
  let down = false, startX = 0, startScroll = 0, moved = false;
  const SKIP = 'input, textarea, select, button, a, [draggable="true"], .ws-drag-handle, .ws-label-btn, .ws-col-del, .ws-col-resize';
  wrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(SKIP)) return;
    down = true; moved = false; startX = e.pageX; startScroll = wrap.scrollLeft;
  });
  wrap.addEventListener('mousemove', e => {
    if (!down) return;
    const dx = e.pageX - startX;
    if (!moved && Math.abs(dx) > 4) { moved = true; wrap.classList.add('ws-drag-scrolling'); }
    if (moved) { wrap.scrollLeft = startScroll - dx; e.preventDefault(); }
  });
  const end = () => { down = false; wrap.classList.remove('ws-drag-scrolling'); };
  window.addEventListener('mouseup', end);
  window.addEventListener('mouseleave', end);
  // suprime o clique (ex.: abrir edicao) se o usuario estava arrastando
  wrap.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}

function setupWorkspace() {
  setupWsSidenav();
  wsSetupDragScroll();

  const main = document.getElementById('main-content');
  const sidenav = document.getElementById('ws-sidenav');

  document.querySelector('[data-tab="workspace"]')?.addEventListener('click', () => {
    sidenav?.classList.add('visible');
    main?.classList.add('ws-mode');
    loadWorkspaceSpaces().then(loadWorkspace);
  });

  document.querySelectorAll('.nav-item:not([data-tab="workspace"])').forEach(btn => {
    btn.addEventListener('click', () => {
      sidenav?.classList.remove('visible');
      main?.classList.remove('ws-mode');
      wsCloseNotes();
    });
  });

  document.getElementById('ws-new-space')?.addEventListener('click', openWsSpaceModal);
  document.getElementById('ws-space-modal-close')?.addEventListener('click', () => { document.getElementById('ws-space-modal').style.display = 'none'; });
  document.getElementById('btn-save-ws-space')?.addEventListener('click', saveWsSpace);
  document.getElementById('ws-invite-user')?.addEventListener('click', () => openWsInviteModal());
  document.getElementById('ws-invite-modal-close')?.addEventListener('click', () => { document.getElementById('ws-invite-modal').style.display = 'none'; });
  document.getElementById('btn-save-ws-invite')?.addEventListener('click', saveWsInvite);

  // Select all
  document.getElementById('ws-select-all')?.addEventListener('change', e => {
    const cbs = document.querySelectorAll('#workspace-tbody .ws-row-cb');
    cbs.forEach(cb => {
      cb.checked = e.target.checked;
      if (e.target.checked) _wsSelected.add(cb.dataset.id);
      else _wsSelected.delete(cb.dataset.id);
      cb.closest('tr').classList.toggle('ws-selected', cb.checked);
    });
    wsUpdateSelectionBar();
  });

  // Notes panel
  document.getElementById('ws-notes-close')?.addEventListener('click', wsCloseNotes);
  document.getElementById('ws-notes-save')?.addEventListener('click', wsSaveNotes);
  document.getElementById('ws-notes-textarea')?.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); wsSaveNotes(); }
    if (e.key === 'Escape') wsCloseNotes();
  });
  document.getElementById('ws-add-comment')?.addEventListener('click', wsAddComment);
  document.getElementById('ws-comment-text')?.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); wsAddComment(); }
  });

  // Notes textarea resize handle
  (() => {
    const handle = document.getElementById('ws-notes-resize-handle');
    const textarea = document.getElementById('ws-notes-textarea');
    if (!handle || !textarea) return;
    let startY = 0, startH = 0, dragging = false;
    const savedH = parseInt(localStorage.getItem('ws-notes-h') || '0', 10);
    if (savedH > 0) textarea.style.height = savedH + 'px';
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = textarea.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = e.clientY - startY;
      const newH = Math.max(60, Math.min(window.innerHeight * 0.7, startH + delta));
      textarea.style.height = newH + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('ws-notes-h', textarea.offsetHeight);
    });
  })();

  // File upload
  document.getElementById('ws-files-input')?.addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) await wsUploadFile(file);
  });

  // Space context menu
  const spaceMenu = document.getElementById('ws-space-menu');
  let _spaceMenuId = null;
  function closeSpaceMenu() { spaceMenu.style.display = 'none'; _spaceMenuId = null; }
  document.addEventListener('click', e => { if (!spaceMenu.contains(e.target)) closeSpaceMenu(); });
  document.getElementById('ws-space-menu-rename')?.addEventListener('click', async () => {
    const id = _spaceMenuId; closeSpaceMenu();
    if (!id) return;
    const space = _wsSpaces.find(s => s.id === id);
    const newName = prompt('Novo nome do espaço:', space?.name || '');
    if (!newName || !newName.trim()) return;
    try {
      await apiFetch(`/api/workspace/spaces/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) });
      await loadWorkspaceSpaces();
    } catch (e) { alert('Erro ao renomear: ' + e.message); }
  });
  document.getElementById('ws-space-menu-delete')?.addEventListener('click', async () => {
    const id = _spaceMenuId; closeSpaceMenu();
    if (!id) return;
    const space = _wsSpaces.find(s => s.id === id);
    if (!confirm(`Excluir o espaço "${space?.name}"? Todos os itens serão removidos.`)) return;
    try {
      await apiFetch(`/api/workspace/spaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (_wsCurrentSpaceId === id) { _wsCurrentSpaceId = ''; localStorage.removeItem('ws-current-space'); }
      await loadWorkspaceSpaces();
      await loadWorkspace();
    } catch (e) { alert('Erro ao excluir: ' + e.message); }
  });

  // Hook space dots button (delegated, since list is re-rendered)
  document.getElementById('ws-space-list')?.addEventListener('click', e => {
    const btn = e.target.closest('.ws-space-dots');
    if (!btn) return;
    e.stopPropagation();
    _spaceMenuId = btn.dataset.spaceId;
    const rect = btn.getBoundingClientRect();
    spaceMenu.style.display = 'block';
    spaceMenu.style.left = rect.right + 4 + 'px';
    spaceMenu.style.top = rect.top + 'px';
  });

  // Selection bar actions
  document.getElementById('ws-sel-close')?.addEventListener('click', () => {
    _wsSelected.clear();
    document.querySelectorAll('#workspace-tbody .ws-row-cb').forEach(cb => {
      cb.checked = false;
      cb.closest('tr').classList.remove('ws-selected');
    });
    wsUpdateSelectionBar();
  });
  document.getElementById('ws-sel-status')?.addEventListener('click', wsShowBulkStatusPicker);
  document.getElementById('ws-sel-delete')?.addEventListener('click', wsDeleteSelected);

  // Close picker on outside click
  document.addEventListener('click', e => {
    const picker = document.getElementById('ws-picker');
    if (picker && picker.style.display !== 'none' && !picker.contains(e.target) && !_pickerCell?.contains(e.target)) {
      wsClosePicker();
    }
    const labelPicker = document.getElementById('ws-label-picker');
    if (labelPicker && labelPicker.style.display !== 'none' && !labelPicker.contains(e.target) && !e.target.closest('.ws-label-btn')) {
      wsCloseLabelPicker();
    }
    // Close notes if clicking outside panel on the backdrop
    const panel = document.getElementById('ws-notes-panel');
    if (panel?.classList.contains('open') && !panel.contains(e.target)) {
      const inTable = e.target.closest('#tab-workspace');
      if (!inTable) wsCloseNotes();
    }
  });

  setupWsSearch();

  document.getElementById('ws-add-task-btn')?.addEventListener('click', wsAddTask);
}

// ─── Workspace Search / Command Palette ──────────────────────────────────────

const WS_RESET_PHRASE = 'APAGA_O_MASTER_GALO_NOVO';

function wsOpenSearch() {
  const overlay = document.getElementById('ws-search-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const inp = document.getElementById('ws-search-input');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
  wsRenderSearch('');
}

function wsCloseSearch() {
  const overlay = document.getElementById('ws-search-overlay');
  if (overlay) overlay.style.display = 'none';
}

function wsHighlight(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' + escapeHtml(text.slice(idx + query.length));
}

function wsRenderSearch(query) {
  const container = document.getElementById('ws-search-results');
  if (!container) return;

  // Reset magic phrase detection
  if (query.trim() === WS_RESET_PHRASE) {
    container.innerHTML = `
      <div class="ws-search-reset-warn">
        <p>⚠️ <strong>ATENÇÃO:</strong> isso vai apagar TODAS as tarefas do seu workspace. Um backup será criado automaticamente no servidor.</p>
        <button class="ws-search-reset-btn" id="ws-confirm-reset">CONFIRMAR RESET DO WORKSPACE</button>
      </div>`;
    document.getElementById('ws-confirm-reset')?.addEventListener('click', wsResetWorkspace);
    return;
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? _wsTasks.filter(t => t.nome?.toLowerCase().includes(q) || t.status?.toLowerCase().includes(q) || (t.tags || []).some(tag => tag.toLowerCase().includes(q)))
    : _wsTasks.slice(0, 20);

  if (!filtered.length) {
    container.innerHTML = `<div class="ws-search-empty">${q ? 'Nenhuma tarefa encontrada' : 'Nenhuma tarefa carregada'}</div>`;
    return;
  }

  container.innerHTML = (q ? '' : '<div class="ws-search-group">Tarefas recentes</div>') +
    filtered.map(t => {
      const c = WS_BADGE_COLORS[t.status] || {};
      return `<div class="ws-search-row" data-id="${t.id}">
        <span class="ws-label-dot" style="background:${c.color || '#555'};width:10px;height:10px;border-radius:50%;flex-shrink:0;"></span>
        <span class="ws-search-row-name">${wsHighlight(t.nome || '', query.trim())}</span>
        <span class="ws-badge" style="background:${c.bg || '#222'};color:${c.color || '#aaa'};font-size:10px;">${t.status || ''}</span>
      </div>`;
    }).join('');

  container.querySelectorAll('.ws-search-row').forEach(row => {
    row.addEventListener('click', () => {
      wsCloseSearch();
      // Scroll to and flash the row
      const tr = document.querySelector(`#workspace-tbody tr[data-ws-id="${row.dataset.id}"]`);
      if (tr) {
        tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        tr.classList.add('ws-row-flash');
        setTimeout(() => tr.classList.remove('ws-row-flash'), 1200);
      }
    });
  });
}

async function wsResetWorkspace() {
  const btn = document.getElementById('ws-confirm-reset');
  if (btn) { btn.disabled = true; btn.textContent = 'Apagando...'; }
  try {
    const res = await apiFetch(`/api/workspace/reset${currentWsQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrase: WS_RESET_PHRASE }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao resetar');
    wsCloseSearch();
    alert(`✓ Workspace apagado. Backup salvo no servidor: ${data.backup}`);
    await loadWorkspace();
  } catch (err) {
    alert('Erro: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'CONFIRMAR RESET DO WORKSPACE'; }
  }
}

// ─── AI Module ─────────────────────────────────────────────
let _aiConfig = null;
let _aiResultAction = null;

async function loadAiConfig() {
  if (!isAdmin) return;
  try {
    const res = await apiFetch('/api/config/ai');
    if (!res.ok) return;
    _aiConfig = await res.json();
    const keyStatus = document.getElementById('ai-key-status');
    if (keyStatus) keyStatus.textContent = _aiConfig.hasKey ? '✓ Chave configurada' : 'Nenhuma chave configurada';
    const ctx = document.getElementById('ai-business-context');
    if (ctx) ctx.value = _aiConfig.aiBusinessContext || '';
    renderAiToolbar();
  } catch {}
}

function renderAiToolbar() {
  const toolbar = document.getElementById('ai-toolbar');
  if (toolbar) toolbar.style.display = (_aiConfig?.hasKey && selectedChatContactId) ? 'flex' : 'none';
}

async function saveAiConfig() {
  const key = document.getElementById('ai-api-key')?.value?.trim();
  const ctx = document.getElementById('ai-business-context')?.value?.trim();
  const fb = document.getElementById('ai-config-feedback');
  try {
    const body = { aiBusinessContext: ctx || '' };
    if (key) body.anthropicApiKey = key;
    const res = await apiFetch('/api/config/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _aiConfig = data;
    const keyStatus = document.getElementById('ai-key-status');
    if (keyStatus) keyStatus.textContent = _aiConfig.hasKey ? '✓ Chave configurada' : 'Nenhuma chave configurada';
    const keyInput = document.getElementById('ai-api-key');
    if (keyInput) keyInput.value = '';
    if (fb) { fb.style.display = 'inline-block'; fb.textContent = '✓ Salvo!'; fb.style.color = 'var(--green)'; setTimeout(() => { fb.style.display = 'none'; }, 2500); }
  } catch (e) {
    if (fb) { fb.style.display = 'inline-block'; fb.textContent = 'Erro: ' + e.message; fb.style.color = '#ff6b6b'; }
  }
}

async function reviewConversation() {
  if (!selectedChatContactId) return;
  showAiResult('Analisando conversa...');
  try {
    const res = await apiFetch('/api/ai/review-conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: selectedChatContactId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showAiResult(data.result);
  } catch (e) { showAiResult('Erro: ' + e.message); }
}

async function suggestReply() {
  if (!selectedChatContactId) return;
  showAiResult('Elaborando sugestão...');
  try {
    const res = await apiFetch('/api/ai/suggest-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: selectedChatContactId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showAiResult(data.result, { action: 'use', label: 'Usar como resposta' });
  } catch (e) { showAiResult('Erro: ' + e.message); }
}

async function fixGrammar() {
  const input = document.getElementById('chat-input');
  const text = input?.value?.trim();
  if (!text) { alert('Digite um texto no campo de mensagem antes de corrigir.'); return; }
  showAiResult('Corrigindo...');
  try {
    const res = await apiFetch('/api/ai/fix-grammar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showAiResult(data.result, { action: 'replace', label: 'Usar texto corrigido' });
  } catch (e) { showAiResult('Erro: ' + e.message); }
}

async function toggleAiChatbot() {
  if (!selectedChatContactId) return;
  try {
    const res = await apiFetch('/api/ai/chatbot/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: selectedChatContactId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    updateAiChatbotUI(data.enabled);
  } catch (e) { alert('Erro: ' + e.message); }
}

async function loadAiChatbotStatus(contactId) {
  if (!_aiConfig?.hasKey || !contactId) return;
  try {
    const res = await apiFetch(`/api/ai/chatbot/status?contactId=${encodeURIComponent(contactId)}`);
    if (!res.ok) return;
    const data = await res.json();
    updateAiChatbotUI(data.enabled);
  } catch {}
}

function updateAiChatbotUI(enabled) {
  const toggle = document.getElementById('ai-chatbot-toggle');
  if (toggle) {
    toggle.textContent = enabled ? 'ON' : 'OFF';
    toggle.style.background = enabled ? '#1a4a28' : '#2a3942';
    toggle.style.color = enabled ? '#4caf50' : 'var(--text2)';
    toggle.style.borderColor = enabled ? '#2d6a3a' : '#444';
  }
  const banner = document.getElementById('ai-chatbot-banner');
  if (banner) banner.style.display = enabled ? 'flex' : 'none';
}

function showAiResult(text, action = null) {
  const panel = document.getElementById('ai-result-panel');
  const textEl = document.getElementById('ai-result-text');
  const actionBtn = document.getElementById('ai-result-action-btn');
  if (!panel || !textEl) return;
  _aiResultAction = action;
  textEl.textContent = text;
  if (actionBtn) {
    actionBtn.style.display = action ? 'inline-block' : 'none';
    if (action) actionBtn.textContent = action.label;
  }
  panel.style.display = 'block';
}

function closeAiResult() {
  const panel = document.getElementById('ai-result-panel');
  if (panel) panel.style.display = 'none';
  _aiResultAction = null;
}

function applyAiResultAction() {
  if (!_aiResultAction) return;
  const input = document.getElementById('chat-input');
  const textEl = document.getElementById('ai-result-text');
  if (input && textEl) {
    input.value = textEl.textContent;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    input.focus();
  }
  closeAiResult();
}

function setupWsSearch() {
  document.getElementById('ws-search-trigger')?.addEventListener('click', wsOpenSearch);

  // Cmd+K / Ctrl+K anywhere
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      const wsTab = document.getElementById('tab-workspace');
      if (wsTab?.classList.contains('active')) {
        e.preventDefault();
        wsOpenSearch();
      }
    }
    if (e.key === 'Escape') wsCloseSearch();
  });

  // Search input handler
  document.getElementById('ws-search-input')?.addEventListener('input', e => {
    wsRenderSearch(e.target.value);
  });

  // Close on overlay click (outside modal)
  document.getElementById('ws-search-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('ws-search-overlay')) wsCloseSearch();
  });

  document.querySelector('.ws-search-esc')?.addEventListener('click', wsCloseSearch);

  // Arrow key navigation in results
  document.getElementById('ws-search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { wsCloseSearch(); return; }
    const rows = [...document.querySelectorAll('.ws-search-row')];
    if (!rows.length) return;
    const active = document.querySelector('.ws-search-row.ws-sr-active');
    let idx = rows.indexOf(active);
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, rows.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); }
    else if (e.key === 'Enter' && active) { active.click(); return; }
    else return;
    rows.forEach(r => r.classList.remove('ws-sr-active'));
    rows[idx]?.classList.add('ws-sr-active');
    rows[idx]?.scrollIntoView({ block: 'nearest' });
  });
}

// ─── CRM Schedule Modal ───────────────────────────────────────────────────────

let _crmSchedUploadedFile = null;
let _crmSchedQRs = [];

function openCrmScheduleModal() {
  const card = crmCards.find(c => c.id === editingCardId);
  const name = card?.contactName || document.getElementById('crm-card-name')?.value || 'Lead';
  const phone = card?.phone || document.getElementById('crm-card-phone')?.value || '';

  document.getElementById('crm-sched-name').textContent = name;
  document.getElementById('crm-sched-phone').textContent = phone || 'Sem telefone';
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('crm-sched-avatar').textContent = initials;

  // Reset form
  document.getElementById('crm-sched-message').value = '';
  document.getElementById('crm-sched-char-count').textContent = '0';
  document.getElementById('crm-sched-datetime').value = '';
  document.getElementById('crm-sched-qr-input').value = '';
  document.getElementById('crm-sched-feedback').style.display = 'none';
  _crmSchedQRs = [];
  _crmSchedUploadedFile = null;
  _renderCrmSchedQRs();
  document.getElementById('crm-sched-file-selected').style.display = 'none';
  document.getElementById('crm-sched-file-input').value = '';

  _buildCrmSchedQuickDates();
  _buildCrmSchedConnectionSelector();
  document.getElementById('crm-schedule-modal').style.display = 'flex';
}

function _buildCrmSchedConnectionSelector() {
  const sel = document.getElementById('crm-sched-connection');
  if (!sel) return;
  const conns = runtimeStatus?.connections || {};
  const allSlots = ['web', 'web2', 'web3', 'cloud1', 'cloud2', 'cloud3'];
  sel.innerHTML = '';
  let hasAny = false;
  for (const id of allSlots) {
    const conn = conns[id];
    if (!conn) continue;
    const connected = conn.connected || conn.status === 'connected';
    const phone = _connectionPhones[id];
    const label = phone ? `${CONNECTION_LABELS[id]?.label || id} — ${phone}` : (CONNECTION_LABELS[id]?.label || id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = connected ? label : `⚠ ${label} — desconectado`;
    opt.disabled = !connected;
    sel.appendChild(opt);
    if (connected && !hasAny) { sel.value = id; hasAny = true; }
  }
  if (!hasAny) {
    const opt = document.createElement('option');
    opt.value = 'web'; opt.disabled = true;
    opt.textContent = '⚠ Nenhuma conexão ativa';
    sel.appendChild(opt);
    sel.value = 'web';
  }
}

function closeCrmScheduleModal() {
  document.getElementById('crm-schedule-modal').style.display = 'none';
}

function _buildCrmSchedQuickDates() {
  const container = document.getElementById('crm-sched-quick-dates');
  const pad = n => String(n).padStart(2, '0');

  function nextWeekday(targetDay, hour) {
    const now = new Date();
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    let diff = targetDay - now.getDay();
    if (diff < 0) diff += 7;
    if (diff === 0 && now >= d) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  const options = [];
  const tmr6 = new Date(); tmr6.setDate(tmr6.getDate() + 1); tmr6.setHours(6, 0, 0, 0);
  options.push({ label: 'Amanhã às 06h', date: tmr6 });
  for (const [day, abbr] of [[1, 'Seg'], [3, 'Qua'], [5, 'Sex']]) {
    const d = nextWeekday(day, 7);
    options.push({ label: `${abbr} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} · 07h`, date: d });
  }

  container.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-date-btn';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      document.getElementById('crm-sched-datetime').value = toLocalISO(opt.date);
    });
    container.appendChild(btn);
  }
}

function _renderCrmSchedQRs() {
  const chips = document.getElementById('crm-sched-qr-chips');
  chips.innerHTML = _crmSchedQRs.map((r, i) =>
    `<span class="quick-reply-chip">${escapeHtml(r)}<button type="button" onclick="removeCrmSchedQR(${i})">✕</button></span>`
  ).join('');
}

function addCrmSchedQR() {
  const input = document.getElementById('crm-sched-qr-input');
  const val = input.value.trim();
  if (!val || _crmSchedQRs.length >= 3) return;
  _crmSchedQRs.push(val);
  input.value = '';
  _renderCrmSchedQRs();
}

function removeCrmSchedQR(idx) {
  _crmSchedQRs.splice(idx, 1);
  _renderCrmSchedQRs();
}

async function uploadCrmSchedFile(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('document', file);
  try {
    const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _crmSchedUploadedFile = { path: data.path, name: data.name };
    document.getElementById('crm-sched-file-name').textContent = '📎 ' + data.name;
    document.getElementById('crm-sched-file-selected').style.display = 'flex';
  } catch (e) {
    alert('Erro ao enviar arquivo: ' + e.message);
  }
}

function clearCrmSchedFile() {
  _crmSchedUploadedFile = null;
  document.getElementById('crm-sched-file-input').value = '';
  document.getElementById('crm-sched-file-selected').style.display = 'none';
}

async function saveCrmSchedule() {
  const fb = document.getElementById('crm-sched-feedback');
  const message = document.getElementById('crm-sched-message').value.trim();
  const datetimeVal = document.getElementById('crm-sched-datetime').value;
  const scheduledFor = new Date(datetimeVal).getTime();

  if (!message) { showFeedback(fb, '❌ Digite uma mensagem.', 'error'); return; }
  if (!datetimeVal || isNaN(scheduledFor)) { showFeedback(fb, '❌ Escolha a data e hora.', 'error'); return; }
  if (scheduledFor <= Date.now()) { showFeedback(fb, '❌ A data deve ser no futuro.', 'error'); return; }

  const card = crmCards.find(c => c.id === editingCardId);
  if (!card) { showFeedback(fb, '❌ Card não encontrado.', 'error'); return; }

  const recipientName = card.contactName || document.getElementById('crm-card-name')?.value || 'Lead';
  const phone = String(card.phone || document.getElementById('crm-card-phone')?.value || '').replace(/\D/g, '');
  const whatsappId = editingCrmWhatsappId || '';
  const isGroup = whatsappId.endsWith('@g.us');
  const recipientId = isGroup ? whatsappId : (phone ? `${phone}@c.us` : whatsappId);
  const recipientType = isGroup ? 'group' : 'contact';

  if (!recipientId) { showFeedback(fb, '❌ Card sem telefone ou grupo configurado.', 'error'); return; }

  const btn = document.querySelector('#crm-schedule-modal .btn-primary');
  btn.disabled = true; btn.textContent = '⏳ Agendando...';

  try {
    const res = await apiFetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType,
        recipientId,
        recipientName,
        message,
        scheduledFor,
        documentPath: _crmSchedUploadedFile?.path || null,
        documentName: _crmSchedUploadedFile?.name || null,
        quickReplies: [..._crmSchedQRs],
        connectionId: document.getElementById('crm-sched-connection')?.value || null
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const dt = new Date(scheduledFor);
    showFeedback(fb, `✅ Agendado para ${formatDate(dt)} às ${formatTime(dt)}!`, 'success');
    updatePendingBadge();
    setTimeout(closeCrmScheduleModal, 2000);
  } catch (e) {
    showFeedback(fb, '❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = `<svg class="icon"><use href="#i-calendar"/></svg> Agendar Mensagem`;
  }
}

// ─── Financeiro ───────────────────────────────────────────────────────────────

let _finYear = new Date().getFullYear();
let _finMonth = new Date().getMonth() + 1; // 1-12
let _finData = null; // { month, income, expenses, distribution }

const FIN_MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function finFmt(val) {
  return Number(val || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function finMonthKey() { return `${_finYear}/${_finMonth}`; }

async function finLoad() {
  try {
    const res = await apiFetch(`/api/fin/months/${_finYear}/${_finMonth}`);
    _finData = await res.json();
    finRender();
  } catch (e) {
    console.error('Fin load error', e);
  }
}

function finRender() {
  const label = `${FIN_MONTH_NAMES[_finMonth - 1]} ${_finYear}`;
  document.getElementById('fin-month-display').textContent = label;
  document.getElementById('fin-month-label').textContent = label;
  finRenderIncome();
  finRenderExpenses('essential');
  finRenderExpenses('variable');
  finLoadDistribution();
  finRenderDist();
}

function finPrevMonth() {
  _finMonth--;
  if (_finMonth < 1) { _finMonth = 12; _finYear--; }
  finLoad();
}
function finNextMonth() {
  _finMonth++;
  if (_finMonth > 12) { _finMonth = 1; _finYear++; }
  finLoad();
}

// ── Income ──
function finRenderIncome() {
  const rows = (_finData?.income || []);
  const tbody = document.getElementById('fin-income-tbody');
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td><input class="fin-cell-input" value="${escapeHtml(r.client_name||'')}" onchange="finUpdateIncome('${r.id}','clientName',this.value)"></td>
      <td class="fin-num">
        <span class="fin-paid-pill${r.paid ? ' fin-paid-yes' : ''}"
              onclick="finPillClick('${r.id}',${r.paid?1:0},${r.to_receive||0},this,event)">
          ${finFmt(r.to_receive||0)}
        </span>
      </td>
      <td><input class="fin-cell-input" type="date" value="${r.received_date||''}" onchange="finUpdateIncome('${r.id}','receivedDate',this.value)"></td>
      <td class="fin-num"><input class="fin-cell-input fin-num-input" type="number" step="0.01" value="${r.budget||0}" onchange="finUpdateIncome('${r.id}','budget',+this.value)"></td>
      <td class="fin-center">
        <button class="fin-toggle-btn${r.next_month ? ' fin-toggle-yes' : ''}" onclick="finToggleNextMonth('${r.id}',${r.next_month?0:1})">${r.next_month?'SIM':'NÃO'}</button>
      </td>
      <td><button class="fin-del-btn" onclick="finDeleteIncome('${r.id}')">✕</button></td>
    </tr>
  `).join('');
  const totalToReceive = rows.reduce((s,r) => s + (r.to_receive||0), 0);
  const totalPaid      = rows.reduce((s,r) => s + (r.paid ? (r.to_receive||0) : 0), 0);
  const totalPending   = totalToReceive - totalPaid;
  document.getElementById('fin-total-to-receive').textContent = finFmt(totalToReceive);
  document.getElementById('fin-total-paid').textContent       = finFmt(totalPaid);
  document.getElementById('fin-total-pending').textContent    = finFmt(totalPending);
}

function finPillClick(id, paid, toReceive, el, event) {
  if (el._finTimer) { clearTimeout(el._finTimer); el._finTimer = null; }
  if (event.detail >= 2) {
    finEditPillAmount(id, toReceive, el);
  } else {
    el._finTimer = setTimeout(() => finTogglePaid(id, paid ? 0 : 1), 220);
  }
}

async function finTogglePaid(id, newPaid) {
  if (_finData) { const row = _finData.income.find(r => r.id === id); if (row) row.paid = newPaid; }
  await apiFetch(`/api/fin/income/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ paid: newPaid }) });
  finRenderIncome();
  finRenderDist();
}

function finEditPillAmount(id, toReceive, pillEl) {
  const cell = pillEl.parentElement;
  const input = document.createElement('input');
  input.type = 'number'; input.step = '0.01'; input.value = toReceive;
  input.className = 'fin-cell-input fin-num-input';
  input.style.cssText = 'width:80px;text-align:right;';
  cell.innerHTML = ''; cell.appendChild(input);
  input.focus(); input.select();
  const save = async () => {
    const val = parseFloat(input.value) || 0;
    if (_finData) { const row = _finData.income.find(r => r.id === id); if (row) row.to_receive = val; }
    await apiFetch(`/api/fin/income/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ toReceive: val }) });
    finRenderIncome(); finRenderDist();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') finRenderIncome(); });
}

async function finAddIncome() {
  await apiFetch(`/api/fin/months/${_finYear}/${_finMonth}/income`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
  await finLoad();
}
async function finUpdateIncome(id, field, value) {
  if (!_finData) return;
  const row = _finData.income.find(r => r.id === id);
  if (row) row[field === 'clientName' ? 'client_name' : field === 'toReceive' ? 'to_receive' : field === 'receivedDate' ? 'received_date' : field] = value;
  await apiFetch(`/api/fin/income/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ [field]: value }) });
  finRenderTotals();
  finRenderDist();
}
async function finToggleNextMonth(id, newVal) {
  await apiFetch(`/api/fin/income/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ nextMonth: newVal }) });
  await finLoad();
}
async function finDeleteIncome(id) {
  await apiFetch(`/api/fin/income/${id}`, { method: 'DELETE' });
  _finData.income = _finData.income.filter(r => r.id !== id);
  finRenderIncome();
  finRenderDist();
}

function finRenderTotals() {
  if (!_finData) return;
  const rows = _finData.income || [];
  const totalToReceive = rows.reduce((s,r) => s + (r.to_receive||0), 0);
  const totalPaid      = rows.reduce((s,r) => s + (r.paid ? (r.to_receive||0) : 0), 0);
  document.getElementById('fin-total-to-receive').textContent = finFmt(totalToReceive);
  document.getElementById('fin-total-paid').textContent       = finFmt(totalPaid);
  document.getElementById('fin-total-pending').textContent    = finFmt(totalToReceive - totalPaid);
}

// ── Expenses ──
function finRenderExpenses(category) {
  const rows = (_finData?.expenses || []).filter(e => e.category === category);
  const tbodyId  = category === 'essential' ? 'fin-essential-tbody'     : 'fin-variable-tbody';
  const totalId  = category === 'essential' ? 'fin-total-essential'     : 'fin-total-variable';
  const paidId   = category === 'essential' ? 'fin-total-essential-paid': 'fin-total-variable-paid';
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td><input class="fin-cell-input" value="${escapeHtml(r.name||'')}" onchange="finUpdateExpense('${r.id}','name',this.value)"></td>
      <td class="fin-num">
        <span class="fin-paid-pill${r.paid ? ' fin-paid-yes' : ''}"
              onclick="finExpPillClick('${r.id}','${category}',${r.paid?1:0},${r.amount||0},this,event)">
          ${finFmt(r.amount||0)}
        </span>
      </td>
      <td><input class="fin-cell-input fin-due-input" placeholder="dia" value="${r.due_day||''}" onchange="finUpdateExpense('${r.id}','dueDay',+this.value||0)"></td>
      <td><button class="fin-del-btn" onclick="finDeleteExpense('${r.id}','${category}')">✕</button></td>
    </tr>
  `).join('');
  const total   = rows.reduce((s,r) => s + (r.amount||0), 0);
  const paid    = rows.reduce((s,r) => s + (r.paid ? (r.amount||0) : 0), 0);
  document.getElementById(totalId).textContent = finFmt(total);
  document.getElementById(paidId).textContent  = finFmt(paid);
}

function finExpPillClick(id, category, paid, amount, el, event) {
  if (el._finTimer) { clearTimeout(el._finTimer); el._finTimer = null; }
  if (event.detail >= 2) {
    finEditExpPillAmount(id, category, amount, el);
  } else {
    el._finTimer = setTimeout(() => finToggleExpPaid(id, category, paid ? 0 : 1), 220);
  }
}

async function finToggleExpPaid(id, category, newPaid) {
  if (_finData) { const row = _finData.expenses.find(e => e.id === id); if (row) row.paid = newPaid; }
  await apiFetch(`/api/fin/expenses/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ paid: newPaid }) });
  finRenderExpenses(category);
  finRenderDist();
}

function finEditExpPillAmount(id, category, amount, pillEl) {
  const cell = pillEl.parentElement;
  const input = document.createElement('input');
  input.type = 'number'; input.step = '0.01'; input.value = amount;
  input.className = 'fin-cell-input fin-num-input';
  input.style.cssText = 'width:80px;text-align:right;';
  cell.innerHTML = ''; cell.appendChild(input);
  input.focus(); input.select();
  const save = async () => {
    const val = parseFloat(input.value) || 0;
    if (_finData) { const row = _finData.expenses.find(e => e.id === id); if (row) row.amount = val; }
    await apiFetch(`/api/fin/expenses/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ amount: val }) });
    finRenderExpenses(category); finRenderDist();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') finRenderExpenses(category); });
}

async function finAddExpense(category) {
  await apiFetch(`/api/fin/months/${_finYear}/${_finMonth}/expenses/${category}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
  await finLoad();
}
async function finUpdateExpense(id, field, value) {
  await apiFetch(`/api/fin/expenses/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ [field]: value }) });
  finRenderDistFromDOM();
}
async function finDeleteExpense(id, category) {
  await apiFetch(`/api/fin/expenses/${id}`, { method: 'DELETE' });
  _finData.expenses = _finData.expenses.filter(e => e.id !== id);
  finRenderExpenses(category);
  finRenderDist();
}

// ── Distribution ──
function finLoadDistribution() {
  const d = _finData?.distribution;
  if (!d) return;
  document.getElementById('fin-dist-p1-label').value  = d.p1_label || 'WAGNER';
  document.getElementById('fin-dist-p2-label').value  = d.p2_label || 'FRAN';
  document.getElementById('fin-dist-p1-pct').value    = d.p1_pct ?? 50;
  document.getElementById('fin-dist-p2-pct').value    = d.p2_pct ?? 50;
  document.getElementById('fin-dist-lazer-pct').value = d.lazer_pct ?? 25;
  document.getElementById('fin-dist-invest-pct').value= d.invest_pct ?? 25;
}

function finGetTotalsFromDOM() {
  // Sum paid income rows as "entrada"
  const income = _finData?.income || [];
  const entrada = income.reduce((s,r) => s + (r.paid ? (r.to_receive||0) : 0), 0);

  const expenses = _finData?.expenses || [];
  const essential = expenses.filter(e => e.category === 'essential').reduce((s,e) => s + (e.amount||0), 0);
  const variable  = expenses.filter(e => e.category === 'variable').reduce((s,e) => s + (e.amount||0), 0);
  return { entrada, essential, variable };
}

function finRenderDist() {
  const { entrada, essential } = finGetTotalsFromDOM();
  const saldoLivre = Math.max(0, entrada - essential);

  const p1Pct    = parseFloat(document.getElementById('fin-dist-p1-pct')?.value || 50) / 100;
  const p2Pct    = parseFloat(document.getElementById('fin-dist-p2-pct')?.value || 50) / 100;
  const lazerPct = parseFloat(document.getElementById('fin-dist-lazer-pct')?.value || 25) / 100;
  const invPct   = parseFloat(document.getElementById('fin-dist-invest-pct')?.value || 25) / 100;
  const p1Label  = document.getElementById('fin-dist-p1-label')?.value || 'WAGNER';
  const p2Label  = document.getElementById('fin-dist-p2-label')?.value || 'FRAN';

  const p1Val = saldoLivre * p1Pct;
  const p2Val = saldoLivre * p2Pct;

  document.getElementById('fin-dist-entrada').textContent  = finFmt(entrada);
  document.getElementById('fin-dist-essencial').textContent= finFmt(essential);
  document.getElementById('fin-dist-saldo').textContent    = finFmt(saldoLivre);
  document.getElementById('fin-dist-p1-val').textContent   = finFmt(p1Val);
  document.getElementById('fin-dist-p2-val').textContent   = finFmt(p2Val);
  document.getElementById('fin-dist-p1-sub-label').textContent = p1Label;
  document.getElementById('fin-dist-p2-sub-label').textContent = p2Label;
  document.getElementById('fin-dist-p1-lazer').textContent = finFmt(p1Val * lazerPct);
  document.getElementById('fin-dist-p2-lazer').textContent = finFmt(p2Val * lazerPct);
  document.getElementById('fin-dist-p1-invest').textContent= finFmt(p1Val * invPct);
  document.getElementById('fin-dist-p2-invest').textContent= finFmt(p2Val * invPct);
}

function finRenderDistFromDOM() {
  setTimeout(finRenderDist, 50);
}

let _finDistSaveTimer = null;
function finSaveDistribution() {
  clearTimeout(_finDistSaveTimer);
  _finDistSaveTimer = setTimeout(async () => {
    const payload = {
      p1Label:   document.getElementById('fin-dist-p1-label')?.value,
      p2Label:   document.getElementById('fin-dist-p2-label')?.value,
      p1Pct:     parseFloat(document.getElementById('fin-dist-p1-pct')?.value || 50),
      p2Pct:     parseFloat(document.getElementById('fin-dist-p2-pct')?.value || 50),
      lazerPct:  parseFloat(document.getElementById('fin-dist-lazer-pct')?.value || 25),
      investPct: parseFloat(document.getElementById('fin-dist-invest-pct')?.value || 25),
    };
    await apiFetch(`/api/fin/months/${_finYear}/${_finMonth}/distribution`, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
  }, 600);
}

function finOpenCopyModal() {
  const sel = document.getElementById('fin-copy-target');
  sel.innerHTML = '';
  // Gera opções: próximos 12 meses a partir do atual
  for (let i = 1; i <= 12; i++) {
    let m = _finMonth + i; let y = _finYear;
    if (m > 12) { m -= 12; y++; }
    const opt = document.createElement('option');
    opt.value = `${y}/${m}`;
    opt.textContent = `${FIN_MONTH_NAMES[m-1]} ${y}`;
    sel.appendChild(opt);
  }
  document.getElementById('fin-copy-feedback').style.display = 'none';
  document.getElementById('fin-copy-modal').style.display = 'flex';
}

function finCloseCopyModal() {
  document.getElementById('fin-copy-modal').style.display = 'none';
}

async function finExecuteCopy() {
  const fb = document.getElementById('fin-copy-feedback');
  const [ty, tm] = document.getElementById('fin-copy-target').value.split('/').map(Number);
  if (!_finData) return;

  const btn = document.querySelector('#fin-copy-modal .btn-primary');
  btn.disabled = true; btn.textContent = 'Copiando...';

  try {
    // Garante que o mês destino existe
    const destRes = await apiFetch(`/api/fin/months/${ty}/${tm}`);
    const destData = await destRes.json();

    // Copia income (só clientes que ainda não existem no destino)
    const existingNames = new Set((destData.income || []).map(r => r.client_name));
    for (const r of (_finData.income || [])) {
      if (existingNames.has(r.client_name)) continue;
      await apiFetch(`/api/fin/months/${ty}/${tm}/income`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ clientName: r.client_name, toReceive: r.to_receive, budget: r.budget, nextMonth: r.next_month })
      });
    }

    // Copia despesas (só itens que ainda não existem no destino)
    const existingExp = new Set((destData.expenses || []).map(e => `${e.category}:${e.name}`));
    for (const e of (_finData.expenses || [])) {
      if (existingExp.has(`${e.category}:${e.name}`)) continue;
      await apiFetch(`/api/fin/months/${ty}/${tm}/expenses/${e.category}`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: e.name, amount: e.amount, dueDay: e.due_day })
      });
    }

    // Copia distribuição (labels e %s)
    if (_finData.distribution) {
      const d = _finData.distribution;
      await apiFetch(`/api/fin/months/${ty}/${tm}/distribution`, {
        method: 'PUT', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ p1Label: d.p1_label, p1Pct: d.p1_pct, p2Label: d.p2_label, p2Pct: d.p2_pct, lazerPct: d.lazer_pct, investPct: d.invest_pct })
      });
    }

    showFeedback(fb, `✅ Copiado para ${FIN_MONTH_NAMES[tm-1]} ${ty}!`, 'success');
    setTimeout(finCloseCopyModal, 1800);
  } catch (e) {
    showFeedback(fb, '❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Copiar';
  }
}


// ===================== WhatsApp Lite (Evolution) - UI =====================
function liteIsSulsolar(){ try { return !!currentUser; } catch(e){ return false; } }
let _litePoll = null;
async function liteConnect(){
  const btn = document.getElementById('lite-connect-btn');
  if (btn){ btn.disabled = true; btn.textContent = 'Gerando QR...'; }
  try {
    const r = await apiFetch('/api/lite/connect', { method: 'POST' });
    const d = await r.json();
    if (d && d.qr){ const w = document.getElementById('lite-qr-wrap'); const img = document.getElementById('lite-qr-img'); if (img) img.src = d.qr; if (w) w.style.display = 'block'; }
    const st = document.getElementById('lite-status'); if (st) st.textContent = 'Aguardando leitura do QR...';
    liteStartPolling();
  } catch(e){ alert('Erro ao conectar Lite: ' + e.message); }
  if (btn){ btn.disabled = false; btn.textContent = 'Conectar por QR'; }
}
async function liteDisconnect(){
  if (!confirm('Desconectar o WhatsApp Lite?')) return;
  try { await apiFetch('/api/lite/disconnect', { method: 'POST' }); } catch(e){}
  liteRefreshStatus();
}
async function liteRefreshStatus(){
  if (!liteIsSulsolar()) return;
  try {
    const r = await apiFetch('/api/lite/status'); const d = await r.json();
    if (!d || !d.enabled) return;
    window._liteConnInfo = { connected: d.state === 'open', phone: d.number || '' };
    const dot = document.getElementById('lite-dot');
    const st = document.getElementById('lite-status');
    const qrw = document.getElementById('lite-qr-wrap');
    const cbtn = document.getElementById('lite-connect-btn');
    const dbtn = document.getElementById('lite-disconnect-btn');
    if (d.state === 'open'){
      if (dot) dot.style.background = 'var(--green)';
      if (st) st.innerHTML = '\u2705 Conectado' + (d.number ? (' &middot; ' + d.number) : '');
      if (qrw) qrw.style.display = 'none';
      if (cbtn) cbtn.style.display = 'none';
      if (dbtn) dbtn.style.display = 'inline-flex';
      liteStopPolling();
    } else if (d.state === 'connecting'){
      if (dot) dot.style.background = '#fbbf24';
      if (st && !st.textContent.includes('QR')) st.textContent = 'Conectando...';
      if (cbtn) cbtn.style.display = 'inline-flex';
      if (dbtn) dbtn.style.display = 'none';
    } else {
      if (dot) dot.style.background = 'var(--text3)';
      if (st) st.textContent = 'Nao conectado';
      if (qrw) qrw.style.display = 'none';
      if (cbtn) cbtn.style.display = 'inline-flex';
      if (dbtn) dbtn.style.display = 'none';
    }
  } catch(e){}
}
function liteStartPolling(){ liteStopPolling(); _litePoll = setInterval(liteRefreshStatus, 3000); }
function liteStopPolling(){ if (_litePoll){ clearInterval(_litePoll); _litePoll = null; } }
function liteInit(){ if (liteIsSulsolar()){ const c = document.getElementById('lite-chooser'); if (c) c.style.display = 'block'; liteRefreshStatus(); } }
(function(){ let n = 0; const iv = setInterval(function(){ n++; if (currentUser){ clearInterval(iv); try { liteInit(); } catch(e){} } else if (n > 60){ clearInterval(iv); } }, 800); })();
// ===================== fim WhatsApp Lite UI =====================


// ===== Menu: submenu "App" (Fila da vez / Financeiro / Debug) =====
(function(){
  function bindAppMenu(){
    const tg = document.getElementById('nav-app-toggle');
    const sm = document.getElementById('app-submenu');
    if (!tg || !sm) return false;
    if (tg._appBound) return true;
    tg._appBound = true;
    tg.addEventListener('click', function(){
      const open = sm.style.display !== 'none';
      sm.style.display = open ? 'none' : 'block';
      const ch = tg.querySelector('.nav-chevron');
      if (ch) ch.style.transform = open ? '' : 'rotate(180deg)';
    });
    // se a tab ativa for uma das de dentro, abre o submenu
    const active = document.querySelector('#app-submenu .nav-item.active');
    if (active) { sm.style.display = 'block'; const ch = tg.querySelector('.nav-chevron'); if (ch) ch.style.transform = 'rotate(180deg)'; }
    return true;
  }
  if (!bindAppMenu()) { let n = 0; const iv = setInterval(function(){ n++; if (bindAppMenu() || n > 40) clearInterval(iv); }, 500); }
})();


// fecha o dropdown de conexoes ao clicar fora
(function(){ document.addEventListener('click', function(e){ const d = document.getElementById('conn-dropdown'); if (d && d.style.display === 'block' && !(e.target.closest && e.target.closest('#chat-connection-filter'))) d.style.display = 'none'; }); window.__conn_dropdown_outside = true; })(); // conn-dropdown-outside


// ===== Painel de dados do lead embutido no Chat ao vivo (estilo Kommo) =====
(function(){
  function findCardForConv(contactId){
    const jp = String(contactId||'').replace(/@.*$/,'').replace(/\D/g,'');
    const match = (x)=>{ x=String(x||'').replace(/\D/g,''); return x && jp && (x===jp || x.endsWith(jp) || jp.endsWith(x)); };
    return (typeof crmCards!=='undefined'?crmCards:[]||[]).find(c=> c.whatsappId===contactId || match(c.whatsapp) || match(c.phone));
  }
  function ensurePanel(){
    const main = document.querySelector('#tab-chat .wa-main');
    if (!main) return null;
    if (document.getElementById('live-lead-panel')) return document.getElementById('live-lead-panel');
    main.style.position = 'relative';
    const p = document.createElement('div');
    p.id = 'live-lead-panel';
    p.innerHTML = '<div id="live-lead-body"></div>';
    main.appendChild(p);
    const t = document.createElement('button');
    t.id = 'live-lead-toggle'; t.type = 'button'; t.title = 'Dados do lead';
    t.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';
    t.onclick = function(){ main.classList.toggle('lead-open'); };
    main.appendChild(t);
    main.classList.add('lead-open');
    return p;
  }
  window.renderLiveLeadPanel = function(contactId){
    const panel = ensurePanel(); if (!panel) return;
    const body = document.getElementById('live-lead-body'); if (!body) return;
    if (!contactId || String(contactId).endsWith('@g.us')) { body.innerHTML = '<div class="lead-empty">Dados do lead indisponiveis para grupos.</div>'; return; }
    const card = findCardForConv(contactId);
    const phone = String(contactId).replace(/@.*/,'').replace(/\D/g,'');
    if (!card) { body.innerHTML = '<div class="lead-empty">Sem card no CRM ainda.<br><br><button class="btn-primary" style="padding:8px 16px;font-size:12px;" onclick="document.getElementById(\'btn-add-to-crm\') && document.getElementById(\'btn-add-to-crm\').click()">+ Adicionar ao CRM</button></div>'; return; }
    const checks = card.checks || {};
    const colOpts = (typeof crmColumns!=='undefined'?crmColumns:[]).map(c=>'<option value="'+c.id+'"'+(c.id===card.columnId?' selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
    body.innerHTML =
      '<div class="lead-title">CONTATO</div>'+
      '<div class="lead-row"><span>Nome</span><b>'+escapeHtml(card.contactName||'—')+'</b></div>'+
      '<div class="lead-row"><span>WhatsApp</span><b>'+escapeHtml(card.whatsapp||phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Telefone</span><b>'+escapeHtml(card.phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Instagram</span><b>'+escapeHtml(card.instagram||'—')+'</b></div>'+
      '<div class="lead-row"><span>Cidade</span><b>'+escapeHtml(card.cidade||'—')+'</b></div>'+
      '<div class="lead-row"><span>Coluna</span><select id="live-lead-col" onchange="liveLeadUpdate(\''+card.id+'\',{columnId:this.value})">'+colOpts+'</select></div>'+
      '<div class="lead-title" style="margin-top:16px;">CHECKLIST</div>'+
      '<label class="lead-chk"><input type="checkbox" '+(checks.firstMessage?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\'firstMessage\',this.checked)"> Primeira mensagem enviada</label>'+
      '<label class="lead-chk"><input type="checkbox" '+(checks.followedOnInsta?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\'followedOnInsta\',this.checked)"> Segui no Instagram</label>'+
      '<label class="lead-chk"><input type="checkbox" '+(checks.commented?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\'commented\',this.checked)"> Comentei no post</label>';
  };
  window.liveLeadUpdate = function(id, payload){
    apiFetch('/api/crm/cards/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
      .then(r=>r.json()).then(c=>{ if(!c||!c.id) return; const arr=(typeof crmCards!=='undefined'?crmCards:null); if(arr){ const i=arr.findIndex(x=>x.id===id); if(i>=0) arr[i]=c; } }).catch(()=>{});
  };
  window.liveLeadCheck = function(id, key, val){
    const card=(typeof crmCards!=='undefined'?crmCards:[]).find(x=>x.id===id);
    const checks=Object.assign({}, card&&card.checks); checks[key]=val;
    liveLeadUpdate(id, { checks: checks });
  };
  // engancha no selectConversation pra atualizar o painel ao abrir uma conversa
  (function hook(){
    if (typeof selectConversation === 'function' && !selectConversation.__leadHooked){
      const _orig = selectConversation;
      selectConversation = async function(){ const r = await _orig.apply(this, arguments); try{ window.renderLiveLeadPanel(arguments[0]); }catch(e){} return r; };
      selectConversation.__leadHooked = true;
    } else if (typeof selectConversation !== 'function'){ setTimeout(hook, 600); }
  })();
})();


// ===== Painel do lead (Chat ao vivo): abas Contato | Comentarios (override) =====
(function(){
  let _curCard = null, _curContact = null;
  function findCard(contactId){
    const jp = String(contactId||'').replace(/@.*$/,'').replace(/\D/g,'');
    const m = (x)=>{ x=String(x||'').replace(/\D/g,''); return x && jp && (x===jp || x.endsWith(jp) || jp.endsWith(x)); };
    return (typeof crmCards!=='undefined'?crmCards:[]).find(c=> c.whatsappId===contactId || m(c.whatsapp) || m(c.phone));
  }
  window.renderLiveLeadPanel = function(contactId){
    const main = document.querySelector('#tab-chat .wa-main');
    if (main && !document.getElementById('live-lead-panel')){
      main.style.position='relative';
      const p=document.createElement('div'); p.id='live-lead-panel'; p.innerHTML='<div id="live-lead-body"></div>'; main.appendChild(p);
      const t=document.createElement('button'); t.id='live-lead-toggle'; t.type='button'; t.title='Dados do lead';
      t.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';
      t.onclick=function(){ main.classList.toggle('lead-open'); }; main.appendChild(t); main.classList.add('lead-open');
    }
    const body=document.getElementById('live-lead-body'); if(!body) return;
    _curContact=contactId;
    if (!contactId || String(contactId).endsWith('@g.us')){ body.innerHTML='<div class="lead-empty">Dados do lead indisponiveis para grupos.</div>'; return; }
    _curCard=findCard(contactId);
    body.innerHTML =
      '<div class="lead-tabs"><button class="lead-tab active" id="lead-tab-contato" onclick="liveLeadTab(\'contato\')">Contato</button>'+
      '<button class="lead-tab" id="lead-tab-coment" onclick="liveLeadTab(\'coment\')">Comentarios</button></div>'+
      '<div id="live-lead-content"></div>';
    liveLeadTab('contato');
  };
  window.liveLeadTab = function(tab){
    const tc=document.getElementById('lead-tab-contato'), tm=document.getElementById('lead-tab-coment');
    if(tc) tc.classList.toggle('active', tab==='contato'); if(tm) tm.classList.toggle('active', tab==='coment');
    const c=document.getElementById('live-lead-content'); if(!c) return;
    if (tab==='contato') c.innerHTML = contatoHtml(); else renderComments(c);
  };
  function contatoHtml(){
    const card=_curCard; const phone=String(_curContact).replace(/@.*/,'').replace(/\D/g,'');
    if(!card) return '<div class="lead-empty">Sem card no CRM ainda.<br><br><button class="btn-primary" style="padding:8px 16px;font-size:12px;" onclick="document.getElementById(\'btn-add-to-crm\')&&document.getElementById(\'btn-add-to-crm\').click()">+ Adicionar ao CRM</button></div>';
    const ck=card.checks||{}; const cols=(typeof crmColumns!=='undefined'?crmColumns:[]).map(c=>'<option value="'+c.id+'"'+(c.id===card.columnId?' selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
    return '<div class="lead-title">CONTATO</div>'+
      '<div class="lead-row"><span>Nome</span><b>'+escapeHtml(card.contactName||'—')+'</b></div>'+
      '<div class="lead-row"><span>WhatsApp</span><b>'+escapeHtml(card.whatsapp||phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Telefone</span><b>'+escapeHtml(card.phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Instagram</span><b>'+escapeHtml(card.instagram||'—')+'</b></div>'+
      '<div class="lead-row"><span>Cidade</span><b>'+escapeHtml(card.cidade||'—')+'</b></div>'+
      '<div class="lead-row"><span>Coluna</span><select onchange="liveLeadUpdate(\''+card.id+'\',{columnId:this.value})">'+cols+'</select></div>'+
      '<div class="lead-title" style="margin-top:16px;">CHECKLIST</div>'+
      '<label class="lead-chk"><input type="checkbox" '+(ck.firstMessage?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\'firstMessage\',this.checked)"> Primeira mensagem enviada</label>'+
      '<label class="lead-chk"><input type="checkbox" '+(ck.followedOnInsta?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\'followedOnInsta\',this.checked)"> Segui no Instagram</label>'+
      '<label class="lead-chk"><input type="checkbox" '+(ck.commented?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\'commented\',this.checked)"> Comentei no post</label>';
  }
  async function renderComments(c){
    if(!_curCard){ c.innerHTML='<div class="lead-empty">Adicione o lead ao CRM para comentar.</div>'; return; }
    c.innerHTML='<div class="lead-empty" style="padding:14px;">Carregando...</div>';
    let rows=[]; try{ rows=await apiFetch('/api/crm/cards/'+_curCard.id+'/comments').then(r=>r.json()); }catch(e){}
    const list=(Array.isArray(rows)?rows:[]).map(r=>'<div class="lead-comment"><div class="lead-comment-meta">'+escapeHtml(r.author||r.user||'')+' · '+new Date(r.createdAt||r.created_at||Date.now()).toLocaleString('pt-BR')+'</div>'+escapeHtml(r.text||r.body||'')+'</div>').join('') || '<div class="lead-empty" style="padding:14px;">Nenhum comentario ainda</div>';
    c.innerHTML='<div id="lead-comments-list">'+list+'</div><textarea id="lead-comment-input" class="lead-comment-input" placeholder="Adicione um comentario..."></textarea><button class="btn-primary" style="width:100%;padding:9px;font-size:12px;margin-top:6px;" onclick="liveAddComment()">Comentar</button>';
  }
  window.liveAddComment = async function(){
    if(!_curCard) return; const ta=document.getElementById('lead-comment-input'); const txt=((ta&&ta.value)||'').trim(); if(!txt) return;
    try{ await apiFetch('/api/crm/cards/'+_curCard.id+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:txt})}); }catch(e){}
    const c=document.getElementById('live-lead-content'); if(c) renderComments(c);
  };
})();


// ===== Checklist configuravel (por conta) =====
(function(){
  const DEFAULT_CHECKLIST = [
    { key:'firstMessage', label:'Primeira mensagem enviada' },
    { key:'followedOnInsta', label:'Segui no Instagram' },
    { key:'commented', label:'Comentei no post' }
  ];
  window._crmChecklist = null;
  window.getCrmChecklist = function(){ return Array.isArray(window._crmChecklist) ? window._crmChecklist : DEFAULT_CHECKLIST; };
  window.loadCrmChecklist = async function(){
    try { const r = await apiFetch('/api/crm/checklist'); const j = await r.json(); if (Array.isArray(j)) window._crmChecklist = j; } catch(e){}
  };
  // carrega 1x quando logar
  (function(){ let n=0; const iv=setInterval(function(){ n++; if (typeof apiFetch==='function' && window.currentUser){ clearInterval(iv); window.loadCrmChecklist(); } else if (n>60) clearInterval(iv); }, 800); })();

  // ---- CRM detalhe: render + leitura ----
  window.renderCrmDetailChecks = function(checks){
    const el = document.getElementById('crm-checks-dynamic'); if (!el) return;
    checks = checks || {};
    const items = window.getCrmChecklist();
    if (!items.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px 0 2px;">Nenhum item global configurado para este cliente.</div>';
      return;
    }
    el.innerHTML = items.map(it =>
      '<label class="crm-check-item"><input type="checkbox" data-ck-key="'+escapeHtml(it.key)+'" '+(checks[it.key]?'checked':'')+'> '+escapeHtml(it.label)+'</label>'
    ).join('');
  };
  window.readCrmDetailChecks = function(){
    const out = {}; document.querySelectorAll('#crm-checks-dynamic input[data-ck-key]').forEach(i=>{ out[i.getAttribute('data-ck-key')] = i.checked; }); return out;
  };

  // ---- Modal de configuracao ----
  function slug(s){ return 'ck_' + String(s||'').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,24) + '_' + Math.random().toString(36).slice(2,5); }
  let _editItems = [];
  window.openChecklistConfig = function(){
    _editItems = window.getCrmChecklist().map(i=>({ key:i.key, label:i.label }));
    let ov = document.getElementById('checklist-cfg-overlay');
    if (!ov){ ov = document.createElement('div'); ov.id='checklist-cfg-overlay'; ov.className='cfg-overlay'; document.body.appendChild(ov); ov.addEventListener('click', e=>{ if(e.target===ov) ov.style.display='none'; }); }
    ov.style.display='flex'; drawChecklistCfg();
  };
  function drawChecklistCfg(){
    const ov = document.getElementById('checklist-cfg-overlay'); if(!ov) return;
    const rows = _editItems.map((it,idx)=>
      '<div class="cfg-row"><input class="cfg-inp" value="'+escapeHtml(it.label)+'" oninput="_clEdit('+idx+', this.value)" placeholder="Nome do item"><button class="cfg-del" title="Remover" onclick="_clDel('+idx+')">&#128465;</button></div>'
    ).join('');
    ov.innerHTML =
      '<div class="cfg-box">'+
        '<div class="cfg-head"><span>Configurar checklist</span><button class="cfg-x" onclick="document.getElementById(\'checklist-cfg-overlay\').style.display=\'none\'">&times;</button></div>'+
        '<div class="cfg-sub">Crie e organize os itens que sua equipe marca em cada lead. Isso vale para todos os leads deste cliente, em todos os funis.</div>'+
        '<div id="cfg-rows">'+rows+'</div>'+
        '<button class="cfg-add" onclick="_clAdd()">+ Adicionar item</button>'+
        '<div class="cfg-actions"><button class="cfg-cancel" onclick="document.getElementById(\'checklist-cfg-overlay\').style.display=\'none\'">Cancelar</button><button class="cfg-save" onclick="_clSave()">Salvar</button></div>'+
      '</div>';
  }
  window._clEdit = function(i,v){ if(_editItems[i]) _editItems[i].label = v; };
  window._clDel = function(i){ _editItems.splice(i,1); drawChecklistCfg(); };
  window._clAdd = function(){ _editItems.push({ key:'', label:'' }); drawChecklistCfg(); setTimeout(()=>{ const ins=document.querySelectorAll('#cfg-rows .cfg-inp'); if(ins.length) ins[ins.length-1].focus(); },30); };
  window._clSave = async function(){
    const items = _editItems.map(it=>({ key: it.key || slug(it.label), label: String(it.label||'').trim() })).filter(it=>it.label);
    try { const r = await apiFetch('/api/crm/checklist', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) }); const j = await r.json(); window._crmChecklist = (j && Array.isArray(j.items)) ? j.items : items; } catch(e){}
    document.getElementById('checklist-cfg-overlay').style.display='none';
    // re-render onde estiver visivel
    try { const card = (typeof _zooCurrentCard!=='undefined' && _zooCurrentCard) ? _zooCurrentCard : null; if (document.getElementById('crm-checks-dynamic')) window.renderCrmDetailChecks(card ? card.checks : window.readCrmDetailChecks()); } catch(e){}
    try { if (window.selectedChatContactId) window.renderLiveLeadPanel(window.selectedChatContactId); } catch(e){}
  };

  // ---- Painel do Chat ao vivo: override final (checklist dinamico + abas) ----
  let _curCard=null, _curContact=null;
  function findCard(contactId){
    const jp=String(contactId||'').replace(/@.*$/,'').replace(/\D/g,'');
    const m=(x)=>{ x=String(x||'').replace(/\D/g,''); return x&&jp&&(x===jp||x.endsWith(jp)||jp.endsWith(x)); };
    return (typeof crmCards!=='undefined'?crmCards:[]).find(c=> c.whatsappId===contactId || m(c.whatsapp) || m(c.phone));
  }
  window.renderLiveLeadPanel = function(contactId){
    const main=document.querySelector('#tab-chat .wa-main');
    if (main && !document.getElementById('live-lead-panel')){
      main.style.position='relative';
      const p=document.createElement('div'); p.id='live-lead-panel'; p.innerHTML='<div id="live-lead-body"></div>'; main.appendChild(p);
      const t=document.createElement('button'); t.id='live-lead-toggle'; t.type='button'; t.title='Dados do lead';
      t.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';
      t.onclick=function(){ main.classList.toggle('lead-open'); }; main.appendChild(t); main.classList.add('lead-open');
    }
    const body=document.getElementById('live-lead-body'); if(!body) return;
    window.selectedChatContactId = contactId; _curContact=contactId;
    if(!contactId || String(contactId).endsWith('@g.us')){ body.innerHTML='<div class="lead-empty">Dados do lead indisponiveis para grupos.</div>'; return; }
    _curCard=findCard(contactId);
    body.innerHTML='<div class="lead-tabs"><button class="lead-tab active" id="lead-tab-contato" onclick="liveLeadTab(\'contato\')">Contato</button><button class="lead-tab" id="lead-tab-coment" onclick="liveLeadTab(\'coment\')">Comentarios</button></div><div id="live-lead-content"></div>';
    window.liveLeadTab('contato');
  };
  window.liveLeadTab=function(tab){
    const tc=document.getElementById('lead-tab-contato'), tm=document.getElementById('lead-tab-coment');
    if(tc) tc.classList.toggle('active', tab==='contato'); if(tm) tm.classList.toggle('active', tab==='coment');
    const c=document.getElementById('live-lead-content'); if(!c) return;
    if(tab==='contato') c.innerHTML=contatoHtml(); else renderComments(c);
  };
  function contatoHtml(){
    const card=_curCard; const phone=String(_curContact).replace(/@.*/,'').replace(/\D/g,'');
    if(!card) return '<div class="lead-empty">Sem card no CRM ainda.<br><br><button class="btn-primary" style="padding:8px 16px;font-size:12px;" onclick="document.getElementById(\'btn-add-to-crm\')&&document.getElementById(\'btn-add-to-crm\').click()">+ Adicionar ao CRM</button></div>';
    const ck=card.checks||{}; const cols=(typeof crmColumns!=='undefined'?crmColumns:[]).map(c=>'<option value="'+c.id+'"'+(c.id===card.columnId?' selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
    const chks=window.getCrmChecklist().map(it=>'<label class="lead-chk"><input type="checkbox" '+(ck[it.key]?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\''+it.key+'\',this.checked)"> '+escapeHtml(it.label)+'</label>').join('');
    return '<div class="lead-title">CONTATO</div>'+
      '<div class="lead-row"><span>Nome</span><b>'+escapeHtml(card.contactName||'—')+'</b></div>'+
      '<div class="lead-row"><span>WhatsApp</span><b>'+escapeHtml(card.whatsapp||phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Telefone</span><b>'+escapeHtml(card.phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Instagram</span><b>'+escapeHtml(card.instagram||'—')+'</b></div>'+
      '<div class="lead-row"><span>Cidade</span><b>'+escapeHtml(card.cidade||'—')+'</b></div>'+
      '<div class="lead-row"><span>Coluna</span><select onchange="liveLeadUpdate(\''+card.id+'\',{columnId:this.value})">'+cols+'</select></div>'+
      '<div class="lead-title" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">CHECKLIST <span style="cursor:pointer;color:#999;font-weight:400;" title="Configurar padrões do cliente" onclick="openCrmDefaultsConfig()">&#9881;</span></div>'+
      chks;
  }
  async function renderComments(c){
    if(!_curCard){ c.innerHTML='<div class="lead-empty">Adicione o lead ao CRM para comentar.</div>'; return; }
    c.innerHTML='<div class="lead-empty" style="padding:14px;">Carregando...</div>';
    let rows=[]; try{ rows=await apiFetch('/api/crm/cards/'+_curCard.id+'/comments').then(r=>r.json()); }catch(e){}
    const list=(Array.isArray(rows)?rows:[]).map(r=>'<div class="lead-comment"><div class="lead-comment-meta">'+escapeHtml(r.author||r.user||'')+' &middot; '+new Date(r.createdAt||r.created_at||Date.now()).toLocaleString('pt-BR')+'</div>'+escapeHtml(r.text||r.body||'')+'</div>').join('') || '<div class="lead-empty" style="padding:14px;">Nenhum comentario ainda</div>';
    c.innerHTML='<div id="lead-comments-list">'+list+'</div><textarea id="lead-comment-input" class="lead-comment-input" placeholder="Adicione um comentario..."></textarea><button class="btn-primary" style="width:100%;padding:9px;font-size:12px;margin-top:6px;" onclick="liveAddComment()">Comentar</button>';
  }
  window.liveAddComment=async function(){
    if(!_curCard) return; const ta=document.getElementById('lead-comment-input'); const txt=((ta&&ta.value)||'').trim(); if(!txt) return;
    try{ await apiFetch('/api/crm/cards/'+_curCard.id+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:txt})}); }catch(e){}
    const c=document.getElementById('live-lead-content'); if(c) renderComments(c);
  };
})();


// ===== Campos de contato personalizaveis (por conta) =====
(function(){
  window._crmCustomFields = [];
  window.getCrmCustomFields = function(){ return Array.isArray(window._crmCustomFields) ? window._crmCustomFields : []; };
  window.loadCrmCustomFields = async function(){
    try { const r = await apiFetch('/api/crm/custom-fields'); const j = await r.json(); if (Array.isArray(j)) window._crmCustomFields = j; } catch(e){}
  };
  (function(){ let n=0; const iv=setInterval(function(){ n++; if (typeof apiFetch==='function' && window.currentUser){ clearInterval(iv); window.loadCrmCustomFields(); } else if (n>60) clearInterval(iv); }, 800); })();

  function inputType(t){ return t==='number'?'number':(t==='date'?'date':(t==='link'?'url':'text')); }

  // salva valor de campo personalizado na hora
  window.liveCustomSave = function(cardId, key, value){
    const card = (typeof crmCards!=='undefined'?crmCards:[]).find(x=>x.id===cardId);
    const cf = Object.assign({}, card && card.customFields); cf[key] = value;
    if (card) card.customFields = cf;
    apiFetch('/api/crm/cards/'+cardId, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ customFields: cf }) }).catch(()=>{});
  };

  // HTML dos campos personalizados (para o painel do chat)
  window.customFieldsHtml = function(card){
    const defs = window.getCrmCustomFields(); if (!defs.length) return '';
    const cf = (card && card.customFields) || {};
    return '<div class="lead-title" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">MAIS DADOS <span style="cursor:pointer;color:#999;font-weight:400;" title="Configurar padrões do cliente" onclick="openCrmDefaultsConfig()">&#9881;</span></div>'+
      defs.map(d=>'<div class="lead-row"><span>'+escapeHtml(d.label)+'</span><input class="lead-cf-inp" type="'+inputType(d.type)+'" value="'+escapeHtml(cf[d.key]||'')+'" onchange="liveCustomSave(\''+card.id+'\',\''+d.key+'\',this.value)"></div>').join('');
  };

  // render no detalhe do CRM (injeta container depois do Email)
  window.renderCrmDetailCustom = function(card){
    const after = document.getElementById('crm-fg-email'); if (!after) return;
    let box = document.getElementById('crm-custom-fields');
    if (!box){ box = document.createElement('div'); box.id='crm-custom-fields'; after.parentNode.insertBefore(box, after.nextSibling); }
    const defs = window.getCrmCustomFields(); const cf = (card && card.customFields) || {};
    if (!defs.length){ box.innerHTML = ''; return; }
    box.innerHTML = defs.map(d=>
      '<div class="form-group"><label class="form-label">'+escapeHtml(d.label)+'</label><input class="form-input" type="'+inputType(d.type)+'" value="'+escapeHtml(cf[d.key]||'')+'" '+(card&&card.id?('onchange="liveCustomSave(\''+card.id+'\',\''+d.key+'\',this.value)"'):'disabled')+'></div>'
    ).join('');
  };

  // ---- Modal configurar campos ----
  function slug(s){ return 'cf_' + String(s||'').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,24) + '_' + Math.random().toString(36).slice(2,5); }
  let _ed = [];
  window.openCustomFieldsConfig = function(){
    _ed = window.getCrmCustomFields().map(i=>({ key:i.key, label:i.label, type:i.type||'text' }));
    let ov = document.getElementById('customf-cfg-overlay');
    if (!ov){ ov=document.createElement('div'); ov.id='customf-cfg-overlay'; ov.className='cfg-overlay'; document.body.appendChild(ov); ov.addEventListener('click', e=>{ if(e.target===ov) ov.style.display='none'; }); }
    ov.style.display='flex'; drawCustomCfg();
  };
  window.openCrmDefaultsConfig = function(){
    let ov = document.getElementById('crm-defaults-overlay');
    if (!ov){
      ov = document.createElement('div');
      ov.id = 'crm-defaults-overlay';
      ov.className = 'cfg-overlay';
      document.body.appendChild(ov);
      ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
    }
    ov.innerHTML =
      '<div class="cfg-box" style="max-width:460px;">'+
        '<div class="cfg-head"><span>Padrões do cliente</span><button class="cfg-x" onclick="document.getElementById(\'crm-defaults-overlay\').style.display=\'none\'">&times;</button></div>'+
        '<div class="cfg-sub">Tudo que você configurar aqui vira padrão para todos os leads deste cliente, em todos os funis.</div>'+
        '<div style="display:flex;flex-direction:column;gap:10px;margin-top:14px;">'+
          '<button type="button" class="btn-sidebar-action" style="width:100%;justify-content:flex-start;padding:12px 14px;font-size:13px;border:1px solid var(--border);border-radius:12px;" onclick="document.getElementById(\'crm-defaults-overlay\').style.display=\'none\'; openChecklistConfig();"><svg class="icon"><use href=\"#i-check\"/></svg> Checklist global</button>'+
          '<button type="button" class="btn-sidebar-action" style="width:100%;justify-content:flex-start;padding:12px 14px;font-size:13px;border:1px solid var(--border);border-radius:12px;" onclick="document.getElementById(\'crm-defaults-overlay\').style.display=\'none\'; openCustomFieldsConfig();"><svg class="icon"><use href=\"#i-settings\"/></svg> Campos do contato</button>'+
        '</div>'+
      '</div>';
    ov.style.display = 'flex';
  };
  function typeSel(idx, cur){
    const opts=[['text','Texto'],['number','Numero'],['date','Data'],['link','Link']];
    return '<select class="cfg-type" onchange="_cfType('+idx+',this.value)">'+opts.map(o=>'<option value="'+o[0]+'"'+(o[0]===cur?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
  }
  function drawCustomCfg(){
    const ov=document.getElementById('customf-cfg-overlay'); if(!ov) return;
    const rows=_ed.map((it,idx)=>'<div class="cfg-row"><input class="cfg-inp" value="'+escapeHtml(it.label)+'" oninput="_cfEdit('+idx+',this.value)" placeholder="Nome do campo">'+typeSel(idx,it.type)+'<button class="cfg-del" onclick="_cfDel('+idx+')">&#128465;</button></div>').join('');
    ov.innerHTML='<div class="cfg-box"><div class="cfg-head"><span>Configurar campos do contato</span><button class="cfg-x" onclick="document.getElementById(\'customf-cfg-overlay\').style.display=\'none\'">&times;</button></div>'+
      '<div class="cfg-sub">Adicione campos extras (ex.: Empresa, Orcamento, Aniversario). Isso vale para todos os leads deste cliente, em todos os funis.</div>'+
      '<div id="cfg-rows-cf">'+rows+'</div>'+
      '<button class="cfg-add" onclick="_cfAdd()">+ Adicionar campo</button>'+
      '<div class="cfg-actions"><button class="cfg-cancel" onclick="document.getElementById(\'customf-cfg-overlay\').style.display=\'none\'">Cancelar</button><button class="cfg-save" onclick="_cfSave()">Salvar</button></div></div>';
  }
  window._cfEdit=function(i,v){ if(_ed[i]) _ed[i].label=v; };
  window._cfType=function(i,v){ if(_ed[i]) _ed[i].type=v; };
  window._cfDel=function(i){ _ed.splice(i,1); drawCustomCfg(); };
  window._cfAdd=function(){ _ed.push({key:'',label:'',type:'text'}); drawCustomCfg(); setTimeout(()=>{ const ins=document.querySelectorAll('#cfg-rows-cf .cfg-inp'); if(ins.length) ins[ins.length-1].focus(); },30); };
  window._cfSave=async function(){
    const items=_ed.map(it=>({ key: it.key || slug(it.label), label:String(it.label||'').trim(), type: it.type||'text' })).filter(it=>it.label);
    try{ const r=await apiFetch('/api/crm/custom-fields',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})}); const j=await r.json(); window._crmCustomFields=(j&&j.items)?j.items:items; }catch(e){}
    document.getElementById('customf-cfg-overlay').style.display='none';
    try{ const card=(typeof _zooCurrentCard!=='undefined'&&_zooCurrentCard)?_zooCurrentCard:null; if(document.getElementById('crm-custom-fields')) window.renderCrmDetailCustom(card); }catch(e){}
    try{ if(window.selectedChatContactId) window.renderLiveLeadPanel(window.selectedChatContactId); }catch(e){}
  };

  // ---- Painel do Chat ao vivo: override FINAL (campos fixos + custom + checklist + comentarios) ----
  let _curCard=null,_curContact=null;
  function findCard(contactId){ const jp=String(contactId||'').replace(/@.*$/,'').replace(/\D/g,''); const m=(x)=>{ x=String(x||'').replace(/\D/g,''); return x&&jp&&(x===jp||x.endsWith(jp)||jp.endsWith(x)); }; return (typeof crmCards!=='undefined'?crmCards:[]).find(c=> c.whatsappId===contactId||m(c.whatsapp)||m(c.phone)); }
  window.renderLiveLeadPanel=function(contactId){
    const main=document.querySelector('#tab-chat .wa-main');
    if(main && !document.getElementById('live-lead-panel')){ main.style.position='relative'; const p=document.createElement('div'); p.id='live-lead-panel'; p.innerHTML='<div id="live-lead-body"></div>'; main.appendChild(p); const t=document.createElement('button'); t.id='live-lead-toggle'; t.type='button'; t.title='Dados do lead'; t.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>'; t.onclick=function(){ main.classList.toggle('lead-open'); }; main.appendChild(t); main.classList.add('lead-open'); }
    const body=document.getElementById('live-lead-body'); if(!body) return;
    window.selectedChatContactId=contactId; _curContact=contactId;
    if(!contactId||String(contactId).endsWith('@g.us')){ body.innerHTML='<div class="lead-empty">Dados do lead indisponiveis para grupos.</div>'; return; }
    _curCard=findCard(contactId);
    body.innerHTML='<div class="lead-tabs"><button class="lead-tab active" id="lead-tab-contato" onclick="liveLeadTab(\'contato\')">Contato</button><button class="lead-tab" id="lead-tab-coment" onclick="liveLeadTab(\'coment\')">Comentarios</button></div><div id="live-lead-content"></div>';
    window.liveLeadTab('contato');
  };
  window.liveLeadTab=function(tab){ const tc=document.getElementById('lead-tab-contato'),tm=document.getElementById('lead-tab-coment'); if(tc)tc.classList.toggle('active',tab==='contato'); if(tm)tm.classList.toggle('active',tab==='coment'); const c=document.getElementById('live-lead-content'); if(!c)return; if(tab==='contato')c.innerHTML=contatoHtml(); else renderComments(c); };
  function contatoHtml(){
    const card=_curCard; const phone=String(_curContact).replace(/@.*/,'').replace(/\D/g,'');
    if(!card) return '<div class="lead-empty">Sem card no CRM ainda.<br><br><button class="btn-primary" style="padding:8px 16px;font-size:12px;" onclick="document.getElementById(\'btn-add-to-crm\')&&document.getElementById(\'btn-add-to-crm\').click()">+ Adicionar ao CRM</button></div>';
    const ck=card.checks||{}; const cols=(typeof crmColumns!=='undefined'?crmColumns:[]).map(c=>'<option value="'+c.id+'"'+(c.id===card.columnId?' selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
    const chks=window.getCrmChecklist().map(it=>'<label class="lead-chk"><input type="checkbox" '+(ck[it.key]?'checked':'')+' onchange="liveLeadCheck(\''+card.id+'\',\''+it.key+'\',this.checked)"> '+escapeHtml(it.label)+'</label>').join('');
    return '<div class="lead-title">CONTATO</div>'+
      '<div class="lead-row"><span>Nome</span><b>'+escapeHtml(card.contactName||'—')+'</b></div>'+
      '<div class="lead-row"><span>WhatsApp</span><b>'+escapeHtml(card.whatsapp||phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Telefone</span><b>'+escapeHtml(card.phone||'—')+'</b></div>'+
      '<div class="lead-row"><span>Instagram</span><b>'+escapeHtml(card.instagram||'—')+'</b></div>'+
      '<div class="lead-row"><span>Cidade</span><b>'+escapeHtml(card.cidade||'—')+'</b></div>'+
      '<div class="lead-row"><span>Coluna</span><select onchange="liveLeadUpdate(\''+card.id+'\',{columnId:this.value})">'+cols+'</select></div>'+
      (window.customFieldsHtml?window.customFieldsHtml(card):'')+
      '<div class="lead-title" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">CHECKLIST <span style="cursor:pointer;color:#999;font-weight:400;" title="Configurar padrões do cliente" onclick="openCrmDefaultsConfig()">&#9881;</span></div>'+chks;
  }
  async function renderComments(c){
    if(!_curCard){ c.innerHTML='<div class="lead-empty">Adicione o lead ao CRM para comentar.</div>'; return; }
    c.innerHTML='<div class="lead-empty" style="padding:14px;">Carregando...</div>';
    let rows=[]; try{ rows=await apiFetch('/api/crm/cards/'+_curCard.id+'/comments').then(r=>r.json()); }catch(e){}
    const list=(Array.isArray(rows)?rows:[]).map(r=>'<div class="lead-comment"><div class="lead-comment-meta">'+escapeHtml(r.author||r.user||'')+' &middot; '+new Date(r.createdAt||r.created_at||Date.now()).toLocaleString('pt-BR')+'</div>'+escapeHtml(r.text||r.body||'')+'</div>').join('') || '<div class="lead-empty" style="padding:14px;">Nenhum comentario ainda</div>';
    c.innerHTML='<div id="lead-comments-list">'+list+'</div><textarea id="lead-comment-input" class="lead-comment-input" placeholder="Adicione um comentario..."></textarea><button class="btn-primary" style="width:100%;padding:9px;font-size:12px;margin-top:6px;" onclick="liveAddComment()">Comentar</button>';
  }
  window.liveAddComment=async function(){ if(!_curCard)return; const ta=document.getElementById('lead-comment-input'); const txt=((ta&&ta.value)||'').trim(); if(!txt)return; try{ await apiFetch('/api/crm/cards/'+_curCard.id+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:txt})}); }catch(e){} const c=document.getElementById('live-lead-content'); if(c) renderComments(c); };
})();


// ===== WhatsApp Lite: 2 slots (override) =====
(function(){
  window._liteChooserRenderKey = '';
  window._liteStateBySlot = window._liteStateBySlot || {};
  window._liteQrBySlot = window._liteQrBySlot || {};
  function liteCard(s){
    const num = s===2 ? ' 2' : ' 1';
    return '<div class="connection-card" id="conn-lite-'+s+'" style="flex:1 1 230px;min-width:230px;">'+
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">'+
        '<span class="status-dot" id="lite-dot-'+s+'"></span>'+
        '<strong style="font-size:13px;">WhatsApp Lite'+num+'</strong>'+
        '<span style="font-size:11px;color:var(--accent);background:rgba(217,115,67,0.14);padding:2px 7px;border-radius:10px;">QR Code</span>'+
      '</div>'+
      '<div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5;">Conexao por QR (nao-oficial). Traz o lead com nome e numero. &#9888; risco de ban.</div>'+
      '<div id="lite-status-'+s+'" style="font-size:12px;color:var(--text2);margin-bottom:8px;">Nao conectado</div>'+
      '<div id="lite-qr-wrap-'+s+'" style="display:none;margin-bottom:8px;text-align:center;"><img id="lite-qr-img-'+s+'" alt="QR" style="width:200px;height:200px;border-radius:8px;border:1px solid rgba(0,0,0,0.08);"><div style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.4;">WhatsApp &rarr; Aparelhos conectados &rarr; Conectar aparelho &rarr; escaneie</div></div>'+
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">'+
        '<button class="btn-primary" id="lite-connect-'+s+'" style="padding:7px 14px;font-size:12px;" onclick="liteConnect('+s+')">Conectar por QR</button>'+
        '<button class="btn-sidebar-action" id="lite-disc-'+s+'" style="display:none;color:#ff6b6b;border-color:#ff6b6b33;padding:7px 14px;font-size:12px;" onclick="liteDisconnect('+s+')">Desconectar</button>'+
      '</div></div>';
  }
  function getLiteChooserRenderKey(){
    return 'always';
  }
  function renderChooser(force){
    const c = document.getElementById('lite-chooser'); if (!c) return;
    const renderKey = getLiteChooserRenderKey();
    if (!force && window._liteChooserRenderKey === renderKey) return false;
    window._liteChooserRenderKey = renderKey;
    const oficial = '<div class="connection-card" style="flex:1 1 230px;min-width:230px;">'+
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><strong style="font-size:13px;">WhatsApp Oficial</strong><span style="font-size:11px;color:var(--text3);background:rgba(37,211,102,0.12);padding:2px 7px;border-radius:10px;">Meta Cloud</span></div>'+
      '<div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.5;">API oficial da Meta. Mais segura, sem risco de ban. Requer aprovacao.</div>'+
      '<button class="btn-sidebar-action" style="padding:8px 14px;font-size:12px;" onclick="setConnMode(\'cloud\')">Configurar API Oficial</button></div>';
    const chooserCards = [oficial, liteCard(1), liteCard(2)];
    c.innerHTML = '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:10px;">Tipos de conexao</div>'+
      '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:stretch;">'+ chooserCards.join('') +'</div>';
    return true;
  }
  function reapplyLiteSlotUIs(){
    const state1 = window._liteStateBySlot[1] ? JSON.parse(window._liteStateBySlot[1]) : { state: 'close', number: '', qr: window._liteQrBySlot[1] || null };
    const state2 = window._liteStateBySlot[2] ? JSON.parse(window._liteStateBySlot[2]) : { state: 'close', number: '', qr: window._liteQrBySlot[2] || null };
    updateLiteSlotUI('1', state1);
    updateLiteSlotUI('2', state2);
  }
  function updateLiteSlotUI(slot, d){
    const dot=document.getElementById('lite-dot-'+slot), st=document.getElementById('lite-status-'+slot), qrw=document.getElementById('lite-qr-wrap-'+slot), img=document.getElementById('lite-qr-img-'+slot), cb=document.getElementById('lite-connect-'+slot), db=document.getElementById('lite-disc-'+slot);
    if (!st || !qrw || !cb || !db) return;
    const qrValue = d && d.qr ? d.qr : (window._liteQrBySlot[slot] || '');
    const currentSrc = img && img.src ? img.src : '';
    if (d.state==='open'){
      window._liteQrBySlot[slot] = '';
      if(dot) dot.style.background='var(--green)';
      st.innerHTML='✅ Conectado'+(d.number?(' &middot; '+d.number):'');
      qrw.style.display='none';
      if (img) img.src = '';
      cb.style.display='none';
      db.style.display='inline-flex';
      return;
    }
    if (d.state==='connecting'){
      if(dot) dot.style.background='#fbbf24';
      st.textContent = qrValue ? 'QR Code pronto para leitura' : 'Conectando...';
      if (qrValue) {
        window._liteQrBySlot[slot] = qrValue;
        if (img && currentSrc !== qrValue) img.src = qrValue;
        qrw.style.display='block';
      } else if (currentSrc || window._liteQrBySlot[slot]) {
        if (img && !currentSrc && window._liteQrBySlot[slot]) img.src = window._liteQrBySlot[slot];
        qrw.style.display='block';
      }
      cb.style.display='inline-flex';
      db.style.display='none';
      return;
    }
    window._liteQrBySlot[slot] = '';
    if(dot) dot.style.background='var(--text3)';
    st.textContent='Nao conectado';
    qrw.style.display='none';
    if (img) img.src = '';
    cb.style.display='inline-flex';
    db.style.display='none';
  }
  window.liteConnect = async function(slot){
    slot = slot || 1;
    const btn = document.getElementById('lite-connect-'+slot);
    if (btn){ btn.disabled = true; btn.textContent = 'Gerando QR...'; }
    try {
      const r = await apiFetch('/api/lite/connect', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slot: String(slot) }) });
      const d = await r.json();
      if (d && d.qr) window._liteQrBySlot[slot] = d.qr;
      renderChooser();
      updateLiteSlotUI(String(slot), { state: 'connecting', number: '', qr: d && d.qr ? d.qr : null });
      liteStartPolling();
    } catch(e){ alert('Erro ao conectar Lite: '+e.message); }
    if (btn){ btn.disabled=false; btn.textContent='Conectar por QR'; }
  };
  window.liteDisconnect = async function(slot){
    slot = slot || 1;
    if (!confirm('Desconectar este WhatsApp Lite?')) return;
    try { await apiFetch('/api/lite/disconnect', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slot: String(slot) }) }); } catch(e){}
    liteRefreshSlot(slot);
  };
  async function liteRefreshSlot(slot){
    try {
      const r = await apiFetch('/api/lite/status?slot='+slot); const d = await r.json();
      if (!d || !d.enabled) return;
      const info = { connected: d.state==='open', phone: d.number||'' };
      if (slot===2 || slot==='2') window._lite2ConnInfo = info; else window._liteConnInfo = info;
      const nextState = JSON.stringify({ connected: info.connected, phone: info.phone, state: d.state, qr: d.qr || null });
      const rerendered = document.getElementById('lite-chooser') ? renderChooser() : false;
      if (rerendered) reapplyLiteSlotUIs();
      if (window._liteStateBySlot[slot] !== nextState || d.state === 'connecting') {
        window._liteStateBySlot[slot] = nextState;
        updateLiteSlotUI(String(slot), d);
      }
    } catch(e){}
  }
  window.liteRefreshStatus = function(){ liteRefreshSlot(1); liteRefreshSlot(2); };
  window.liteStartPolling = function(){ window.liteStopPolling(); window._litePoll = setInterval(window.liteRefreshStatus, 3000); };
  window.liteStopPolling = function(){ if (window._litePoll){ clearInterval(window._litePoll); window._litePoll=null; } };
  window.liteInit = function(){
    if (!currentUser) return;
    const c=document.getElementById('lite-chooser'); if(c){ renderChooser(true); c.style.display='block'; reapplyLiteSlotUIs(); }
    window.liteRefreshStatus(); window.liteStartPolling();
  };
  (function(){ let n=0; const iv=setInterval(function(){ n++; if(currentUser){ clearInterval(iv); try{ window.liteInit(); }catch(e){} } else if(n>60) clearInterval(iv); }, 800); })();
})();


// ===================== Dashboard do cliente (virandoachave) =====================
(function(){
  let _dashData = { profile:{}, metrics:{} };
  const esc = (x)=> (typeof escapeHtml==='function'?escapeHtml(x==null?'':String(x)):String(x==null?'':x));

  function injectNavAndTab(){
    if (document.getElementById('nav-dashboard')) return true;
    const crmBtn = document.querySelector('.nav-item[data-tab="crm"]');
    const main = document.getElementById('main-content');
    if (!crmBtn || !main) return false;
    const btn = document.createElement('button');
    btn.className='nav-item'; btn.id='nav-dashboard'; btn.setAttribute('data-tab','dashboard');
    btn.innerHTML='<svg class="nav-icon"><use href="#i-bar-chart"/></svg> Dashboard';
    btn.onclick=function(){ if (typeof activateTab==='function') activateTab('dashboard'); loadDashboard(); };
    crmBtn.parentNode.insertBefore(btn, crmBtn.nextSibling);
    const tab=document.createElement('div'); tab.className='tab-content'; tab.id='tab-dashboard'; tab.innerHTML='<div id="dashboard-root"></div>';
    main.appendChild(tab);
    return true;
  }
  // força mostrar so no virandoachave (apos applyFeaturePermissions)
  if (typeof applyFeaturePermissions==='function'){
    const _afp=applyFeaturePermissions;
    applyFeaturePermissions=function(){ const r=_afp.apply(this,arguments); try{ const b=document.getElementById('nav-dashboard'); if(b) b.style.display=(currentUser&&String(currentUser.clientId)==='virandoachave')?'':'none'; }catch(e){} return r; };
  }

  window.loadDashboard = async function(){
    try{ const r=await apiFetch('/api/dashboard'); _dashData=await r.json(); }catch(e){ _dashData={profile:{},metrics:{}}; }
    renderDashboard();
  };
  function saveProfile(){ return apiFetch('/api/dashboard',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:_dashData.profile||{}})}).catch(()=>{}); }

  function renderDashboard(){
    const root=document.getElementById('dashboard-root'); if(!root) return;
    const p=_dashData.profile||{}, m=_dashData.metrics||{};
    const links=Array.isArray(p.links)?p.links:[], pws=Array.isArray(p.passwords)?p.passwords:[], goals=Array.isArray(p.goals)?p.goals:[], notes=Array.isArray(p.notes)?p.notes:[];
    const initials=(p.name||'Cliente').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
    root.innerHTML=
    '<div class="dwrap">'+
      '<div class="dhead">'+
        '<div class="dlogo" style="'+(p.logo?("background-image:url('"+p.logo+"');"):'')+'" onclick="dashPickLogo()" title="Trocar logo">'+(p.logo?'':esc(initials))+'<span class="dover"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span></div>'+
        '<div><h2>'+esc(p.name||'Nome do cliente')+'</h2><div class="dsub">'+esc(p.segmento||'Segmento · cidade')+'</div></div>'+
        '<div class="dactions"><button class="dbtn" onclick="openDashEdit()"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> Editar painel</button><button class="dbtn" style="background:#fff;color:var(--d-brand);border:1px solid var(--d-brand)" onclick="dashFormLink()">Formulário do cliente</button><span class="dpill"><span class="ddot"></span> Saúde: '+esc(p.saude||'Saudável')+'</span></div>'+
      '</div>'+
      '<div class="dgrid drow4">'+
        '<div class="dcard dstat"><div class="dlbl"><span class="dic dbi"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></span> Leads (CRM)</div><div class="dval">'+(m.leadsTotal||0)+'</div><div class="dmeta">'+(m.leads7||0)+' nos últimos 7 dias · '+(m.leadsHoje||0)+' hoje</div></div>'+
        '<div class="dcard dstat"><div class="dlbl"><span class="dic dbg"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span> Último contato</div><div class="dval" style="font-size:19px;">'+esc(p.ultimoContato||'—')+'</div><div class="dmeta">'+esc(p.ultimoContatoNota||'')+'</div></div>'+
        '<div class="dcard dstat"><div class="dlbl"><span class="dic dba"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span> Último relatório</div><div class="dval" style="font-size:18px;">'+esc(p.ultimoRelatorioData||'—')+'</div><div class="dmeta">'+(p.ultimoRelatorioUrl?('<a href="'+esc(p.ultimoRelatorioUrl)+'" target="_blank">Abrir relatório</a>'):'')+'</div></div>'+
        '<div class="dcard dstat"><div class="dlbl"><span class="dic dbp"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span> Próxima ação</div><div class="dval" style="font-size:18px;">'+esc(p.proximaAcao||'—')+'</div><div class="dmeta">'+esc(p.proximaAcaoData||'')+'</div></div>'+
      '</div>'+
      '<div class="dgrid dtwo">'+
        '<div class="dcard"><h3>Dados do cliente <span class="dedit" onclick="openDashEdit()">editar</span></h3>'+
          '<div class="dinfo"><span class="dk">Razão social</span><span class="dv">'+esc(p.razaoSocial||'—')+'</span></div>'+
          '<div class="dinfo"><span class="dk">CNPJ</span><span class="dv">'+esc(p.cnpj||'—')+'</span></div>'+
          '<div class="dinfo"><span class="dk">Responsável</span><span class="dv">'+esc(p.responsavel||'—')+'</span></div>'+
          '<div class="dinfo" style="flex-direction:column;align-items:flex-start;gap:6px"><span class="dk">Links</span><div class="dchips">'+(links.length?links.map(l=>'<a class="dchip" href="'+esc(l.url||'#')+'" target="_blank">'+esc(l.label||l.url)+'</a>').join(''):'<span class="dmuted" style="font-size:12px;">Nenhum link ainda — clique em Editar painel.</span>')+'</div></div>'+'<div class="dinfo"><span class="dk">Email financeiro</span><span class="dv">'+esc((a=>(Array.isArray(a)?a:[]).map(x=>x&&x.email).filter(Boolean).join(', ')||'—')(p.emailsFinanceiro))+'</span></div>'+'<div class="dinfo"><span class="dk">Email relatório</span><span class="dv">'+esc((a=>(Array.isArray(a)?a:[]).map(x=>x&&x.email).filter(Boolean).join(', ')||'—')(p.emailsRelatorio))+'</span></div>'+'<div class="dinfo"><span class="dk">Email geral</span><span class="dv">'+esc((a=>(Array.isArray(a)?a:[]).map(x=>x&&x.email).filter(Boolean).join(', ')||'—')(p.emailsGeral))+'</span></div>'+
        '</div>'+
        '<div class="dcard"><h3>Metas <span class="dedit" onclick="openDashEdit()">editar</span></h3>'+
          (goals.length?goals.map(g=>{ const pc=g.target?Math.min(100,Math.round((Number(g.current)/Number(g.target))*100)||0):0; return '<div class="dgoal"><div class="dtop"><b>'+esc(g.label)+'</b><span style="color:var(--d-blue);font-weight:700">'+pc+'%</span></div><div class="dbar"><i style="width:'+pc+'%;background:var(--d-blue)"></i></div><div style="font-size:11.5px;color:var(--d-ink3);margin-top:5px">'+esc(g.current||'0')+' de '+esc(g.target||'0')+'</div></div>'; }).join(''):'<div class="dmuted" style="font-size:13px;">Sem metas. Clique em Editar painel.</div>')+
        '</div>'+
      '</div>'+
      '<div class="dgrid dtwo">'+
        '<div class="dcard"><h3>Acessos &amp; senhas <span class="dedit" onclick="openDashEdit()">gerenciar</span></h3>'+
          (pws.length?pws.map((w,i)=>'<div class="dpw"><span class="dsvc">'+esc(w.service||'')+'</span><span class="dcred" id="dpw-'+i+'" data-shown="0">'+esc(w.login||'')+' · ••••••••</span><button onclick="dashTogglePw('+i+')">mostrar</button></div>').join(''):'<div class="dmuted" style="font-size:13px;">Nenhum acesso salvo.</div>')+
        '</div>'+
        '<div class="dcard"><h3>Notas &amp; histórico</h3>'+
          (notes.length?notes.slice().reverse().map(n=>'<div class="dnote"><div class="dnm">'+esc(n.date||'')+'</div>'+esc(n.text||'')+'</div>').join(''):'<div class="dmuted" style="font-size:13px;margin-bottom:8px;">Sem notas ainda.</div>')+
          '<div class="daddnote"><input id="dash-note-inp" placeholder="Escreva uma nota e tecle Enter..." onkeydown="if(event.key===\'Enter\')dashAddNote()"><button onclick="dashAddNote()">Adicionar</button></div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }

  window.dashTogglePw=function(i){
    const el=document.getElementById('dpw-'+i); if(!el) return; const w=(_dashData.profile.passwords||[])[i]||{};
    if(el.getAttribute('data-shown')==='1'){ el.textContent=esc(w.login||'')+' · ••••••••'; el.setAttribute('data-shown','0'); }
    else { el.textContent=(w.login||'')+' · '+(w.password||''); el.setAttribute('data-shown','1'); }
  };
  window.dashAddNote=function(){
    const inp=document.getElementById('dash-note-inp'); const txt=((inp&&inp.value)||'').trim(); if(!txt) return;
    _dashData.profile.notes=Array.isArray(_dashData.profile.notes)?_dashData.profile.notes:[];
    _dashData.profile.notes.push({ text:txt, date:new Date().toLocaleDateString('pt-BR')+' · você' });
    saveProfile(); renderDashboard();
  };
  window.dashPickLogo=function(){
    const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
    inp.onchange=function(){ const file=inp.files&&inp.files[0]; if(!file) return; if(file.size>800*1024){ alert('Imagem muito grande (max 800KB). Use uma menor.'); return; } const rd=new FileReader(); rd.onload=function(){ _dashData.profile.logo=rd.result; saveProfile(); renderDashboard(); }; rd.readAsDataURL(file); };
    inp.click();
  };

  // ---- Modal de edicao ----
  function rowsHtml(kind, arr, fields){
    return arr.map((it,idx)=>'<div class="derow">'+fields.map(fl=>'<input data-k="'+kind+'" data-i="'+idx+'" data-f="'+fl.k+'" placeholder="'+fl.ph+'" value="'+esc(it[fl.k]||'')+'">').join('')+'<button class="dedel" onclick="_deDel(\''+kind+'\','+idx+')">&#128465;</button></div>').join('');
  }
  let _edit=null;
  window.openDashEdit=function(){
    _edit=JSON.parse(JSON.stringify(_dashData.profile||{}));
    ['links','passwords','goals','emailsFinanceiro','emailsRelatorio','emailsGeral'].forEach(k=>{ if(!Array.isArray(_edit[k])) _edit[k]=[]; });
    let ov=document.getElementById('dash-edit-ov');
    if(!ov){ ov=document.createElement('div'); ov.id='dash-edit-ov'; document.body.appendChild(ov); ov.addEventListener('click',e=>{ if(e.target===ov) ov.style.display='none'; }); }
    ov.style.display='flex'; drawEdit();
  };
  function field(label,k,ph){ return '<label>'+label+'</label><input data-p="'+k+'" placeholder="'+(ph||'')+'" value="'+esc(_edit[k]||'')+'">'; }
  function drawEdit(){
    const ov=document.getElementById('dash-edit-ov'); if(!ov) return;
    ov.innerHTML='<div class="debox">'+
      '<h4>Editar painel do cliente</h4>'+
      '<div class="desec">Identificação</div>'+
      field('Nome do cliente','name','Ex: Arroba Banda Larga')+
      field('Segmento / cidade','segmento','Ex: Provedor de Internet · Campos/RJ')+
      field('Razão social','razaoSocial')+field('CNPJ','cnpj')+field('Responsável','responsavel','Nome · telefone')+
      '<div class="desec">Saúde do cliente</div>'+
      field('Último contato','ultimoContato','Ex: Há 2 dias')+field('Nota do contato','ultimoContatoNota','Ex: 24 jun · WhatsApp')+
      field('Data do último relatório','ultimoRelatorioData','Ex: 03 mai 2026')+field('Link do relatório','ultimoRelatorioUrl','https://...')+
      field('Próxima ação','proximaAcao','Ex: Reunião')+field('Data da próxima ação','proximaAcaoData','Ex: 30 jun · 14h')+
      '<div class="desec">Links</div><div id="de-links">'+rowsHtml('links',_edit.links,[{k:'label',ph:'Nome (ex: Instagram)'},{k:'url',ph:'https://...'}])+'</div><button class="deadd" onclick="_deAdd(\'links\')">+ adicionar link</button>'+
      '<div class="desec">Acessos &amp; senhas</div><div id="de-passwords">'+rowsHtml('passwords',_edit.passwords,[{k:'service',ph:'Serviço'},{k:'login',ph:'Login'},{k:'password',ph:'Senha'}])+'</div><button class="deadd" onclick="_deAdd(\'passwords\')">+ adicionar acesso</button>'+
      '<div class="desec">Metas</div><div id="de-goals">'+rowsHtml('goals',_edit.goals,[{k:'label',ph:'Meta (ex: Leads no mês)'},{k:'current',ph:'Atual'},{k:'target',ph:'Alvo'}])+'</div><button class="deadd" onclick="_deAdd(\'goals\')">+ adicionar meta</button>'+
      '<div class="desec">Emails do cliente</div>'+
      '<label>Email financeiro</label><div id="de-emailsFinanceiro">'+rowsHtml('emailsFinanceiro',_edit.emailsFinanceiro,[{k:'email',ph:'financeiro@cliente.com'}])+'</div><button class="deadd" onclick="_deAdd(\'emailsFinanceiro\')">+ adicionar email financeiro</button>'+
      '<label>Email relatório</label><div id="de-emailsRelatorio">'+rowsHtml('emailsRelatorio',_edit.emailsRelatorio,[{k:'email',ph:'relatorio@cliente.com'}])+'</div><button class="deadd" onclick="_deAdd(\'emailsRelatorio\')">+ adicionar email relatório</button>'+
      '<label>Email geral</label><div id="de-emailsGeral">'+rowsHtml('emailsGeral',_edit.emailsGeral,[{k:'email',ph:'contato@cliente.com'}])+'</div><button class="deadd" onclick="_deAdd(\'emailsGeral\')">+ adicionar email geral</button>'+
      '<div class="deactions"><button class="decancel" onclick="document.getElementById(\'dash-edit-ov\').style.display=\'none\'">Cancelar</button><button class="desave" onclick="saveDashEdit()">Salvar</button></div>'+
    '</div>';
  }
  function syncFromInputs(){
    const ov=document.getElementById('dash-edit-ov'); if(!ov) return;
    ov.querySelectorAll('input[data-p]').forEach(i=>{ _edit[i.getAttribute('data-p')]=i.value; });
    ['links','passwords','goals','emailsFinanceiro','emailsRelatorio','emailsGeral'].forEach(k=>{ (ov.querySelectorAll('input[data-k="'+k+'"]')).forEach(i=>{ const idx=+i.getAttribute('data-i'); const f=i.getAttribute('data-f'); if(_edit[k][idx]) _edit[k][idx][f]=i.value; }); });
  }
  window._deAdd=function(k){ syncFromInputs(); _edit[k].push({}); drawEdit(); };
  window._deDel=function(k,i){ syncFromInputs(); _edit[k].splice(i,1); drawEdit(); };
  window.saveDashEdit=function(){
    syncFromInputs();
    // mantem notas e logo que nao estao no form
    _edit.notes=_dashData.profile.notes||[]; _edit.logo=_dashData.profile.logo||'';
    _edit.links=(_edit.links||[]).filter(l=>l.url||l.label);
    _edit.passwords=(_edit.passwords||[]).filter(p=>p.service||p.login);
    _edit.goals=(_edit.goals||[]).filter(g=>g.label);
    ['emailsFinanceiro','emailsRelatorio','emailsGeral'].forEach(k=>{ _edit[k]=(_edit[k]||[]).filter(x=>x&&x.email&&x.email.trim()); });
    _dashData.profile=_edit;
    saveProfile();
    document.getElementById('dash-edit-ov').style.display='none';
    renderDashboard();
  };

  // init: injeta para virandoachave
  (function(){ let n=0; const iv=setInterval(function(){ n++; if(currentUser){ clearInterval(iv); if(String(currentUser.clientId)==='virandoachave'){ injectNavAndTab(); const b=document.getElementById('nav-dashboard'); if(b) b.style.display=''; } } else if(n>60) clearInterval(iv); }, 800); })();
})();


window.dashFormLink = async function(){
  try{
    const r = await apiFetch('/api/dashboard/form-link'); const d = await r.json();
    let ov = document.getElementById('dform-link-ov');
    if(!ov){ ov=document.createElement('div'); ov.id='dform-link-ov'; ov.className='cfg-overlay'; document.body.appendChild(ov); ov.addEventListener('click',e=>{ if(e.target===ov) ov.style.display='none'; }); }
    ov.style.display='flex';
    ov.innerHTML='<div class="cfg-box"><div class="cfg-head"><span>Formulario do cliente</span><button class="cfg-x" onclick="document.getElementById(\'dform-link-ov\').style.display=\'none\'">&times;</button></div><div class="cfg-sub">Envie este link ao cliente. Ele preenche os dados e eles caem direto no painel.</div><input class="cfg-inp" id="dform-url" readonly value="'+(d.url||'')+'" style="width:100%"><div class="cfg-actions"><button class="cfg-cancel" onclick="document.getElementById(\'dform-link-ov\').style.display=\'none\'">Fechar</button><button class="cfg-save" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById(\'dform-url\').value);this.textContent=\'Copiado!\'">Copiar link</button></div></div>';
  }catch(e){ alert('Erro ao gerar o link.'); }
};



// ─── Email (cliente IMAP/SMTP) ─────────────────
let _emailNavReady = false;
let _emailInboxHydrated = false;
let _emailPreloadStarted = false;
let _emailView = 'inbox';
let _emailConfigured = false;
let _emailTemplates = [];
let _emailClients = [];
let _emailCurrentClient = '';
function getEmailInboxCacheKey() {
  const sub = document.getElementById('email-acct-sub')?.textContent?.trim() || 'default';
  return 'vac_email_inbox_cache::' + sub.toLowerCase();
}
function readEmailInboxCache() {
  try {
    const raw = localStorage.getItem(getEmailInboxCacheKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}
function writeEmailInboxCache(msgs) {
  try { localStorage.setItem(getEmailInboxCacheKey(), JSON.stringify(Array.isArray(msgs) ? msgs : [])); } catch (e) {}
}
function emailClientsMap() {
  const out = {};
  (_emailClients || []).forEach(c => { out[c.clientId] = c; });
  return out;
}
function stripHtmlPreview(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function escapeAttr(v) {
  return escapeHtml(String(v == null ? '' : v)).replace(/"/g, '&quot;');
}
function getEmailBrandProfile(clientId) {
  const client = (emailClientsMap()[clientId || _emailCurrentClient] || {});
  return {
    name: client.name || _dashData?.profile?.name || 'Virando a Chave',
    logo: client.logo || _dashData?.profile?.logo || '',
  };
}
function defaultEmailDesigner(profile) {
  const brand = getEmailBrandProfile(profile?.clientId);
  return {
    subject: 'ULTIMAS30 acaba hoje!',
    kicker: 'Cupom para voce',
    headline: 'CUPOM PARA VOCE',
    intro: 'O cupom ULTIMAS30 esta ativo.',
    body: 'Selecione a opcao desejada e confira os produtos disponiveis com 30% de desconto.',
    highlight: 'ULTIMAS30',
    ctaLabel: 'Comprar agora',
    ctaUrl: 'https://virandoachave.gestorwagnnerpires.com.br',
    footer: `Equipe ${brand.name}`,
    logoData: brand.logo || '',
    brandName: brand.name || 'Virando a Chave',
  };
}
function renderEmailDesignerHtml(designer) {
  const d = { ...defaultEmailDesigner(), ...(designer || {}) };
  const logoBlock = d.logoData
    ? `<img src="${String(d.logoData)}" alt="${escapeHtml(d.brandName || 'Virando a Chave')}" style="max-width:220px;width:100%;display:block;margin:0 auto;">`
    : `<div style="font-size:26px;font-weight:900;color:#111111;text-align:center;">${escapeHtml(d.brandName || 'Virando a Chave')}</div>`;
  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR">',
    '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#111111;">',
    '  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">',
    '    <tr><td align="center">',
    '      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;border-radius:0;overflow:hidden;">',
    '        <tr><td style="padding:26px 28px 18px;background:#ffffff;text-align:center;">',
    `          ${logoBlock}`,
    '        </td></tr>',
    '        <tr><td style="padding:0 0 28px;background:#ffffff;">',
    '          <table width="100%" cellpadding="0" cellspacing="0">',
    '            <tr>',
    '              <td style="padding:0 28px 28px;">',
    '                <div style="background:#4c443f;border-radius:0;min-height:240px;position:relative;padding:24px;box-sizing:border-box;">',
    `                  <div style="font-size:15px;line-height:1.2;font-weight:700;color:#ffffff;max-width:180px;">30% DE<br>DESCONTO</div>`,
    `                  <div style="font-size:15px;line-height:1.2;font-weight:700;color:#ffffff;text-align:right;">CUPOM<br>${escapeHtml(d.highlight || '')}</div>`,
    '                </div>',
    '              </td>',
    '            </tr>',
    '          </table>',
    `          <div style="padding:0 48px;">`,
    `            <div style="font-size:58px;line-height:.94;font-weight:900;letter-spacing:-.05em;color:#111111;text-align:left;margin:0 0 26px;text-transform:uppercase;">${escapeHtml(d.headline || '')}</div>`,
    `            <p style="margin:0 0 22px;font-size:18px;line-height:1.55;color:#1a1a1a;">${escapeHtml(d.intro || '')}</p>`,
    `            <p style="margin:0 0 28px;font-size:18px;line-height:1.65;color:#1a1a1a;">${escapeHtml(d.body || '')}</p>`,
    `            <div style="margin:0 0 26px;font-size:58px;line-height:1;font-weight:900;letter-spacing:-.04em;color:#b7b7b7;text-transform:uppercase;">${escapeHtml(d.highlight || '')}</div>`,
    '            <div style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#505050;">Cupom valido por tempo limitado.</div>',
    `            <a href="${escapeAttr(d.ctaUrl || '#')}" style="display:inline-block;background:#000000;color:#ffffff;text-decoration:none;padding:16px 34px;border-radius:999px;font-weight:700;font-size:16px;">${escapeHtml(d.ctaLabel || 'Comprar agora')}</a>`,
    '            <div style="height:58px;"></div>',
    '            <div style="font-size:26px;line-height:1.18;font-weight:800;color:#111111;margin:0 0 26px;">Garanta seu tamanho com desconto</div>',
    '            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 40px;">',
    '              <tr>',
    '                <td align="center" style="padding:0 6px 12px;"><div style="width:58px;height:58px;line-height:58px;border-radius:999px;background:#111111;color:#ffffff;font-size:22px;font-weight:700;margin:0 auto;">PP</div></td>',
    '                <td align="center" style="padding:0 6px 12px;"><div style="width:58px;height:58px;line-height:58px;border-radius:999px;background:#111111;color:#ffffff;font-size:22px;font-weight:700;margin:0 auto;">P</div></td>',
    '                <td align="center" style="padding:0 6px 12px;"><div style="width:58px;height:58px;line-height:58px;border-radius:999px;background:#111111;color:#ffffff;font-size:22px;font-weight:700;margin:0 auto;">M</div></td>',
    '                <td align="center" style="padding:0 6px 12px;"><div style="width:58px;height:58px;line-height:58px;border-radius:999px;background:#111111;color:#ffffff;font-size:22px;font-weight:700;margin:0 auto;">G</div></td>',
    '                <td align="center" style="padding:0 6px 12px;"><div style="width:58px;height:58px;line-height:58px;border-radius:999px;background:#111111;color:#ffffff;font-size:20px;font-weight:700;margin:0 auto;">GG</div></td>',
    '              </tr>',
    '            </table>',
    '            <div style="font-size:16px;line-height:1.5;color:#111111;font-weight:700;margin:0 0 18px;">Use o mesmo login do site nos aplicativos:</div>',
    '            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 30px;">',
    '              <tr>',
    '                <td width="33.33%" valign="top" style="padding-right:12px;">',
    '                  <div style="width:72px;height:72px;border-radius:16px;background:#111111;color:#ffffff;font-size:15px;font-weight:800;line-height:72px;text-align:center;margin-bottom:14px;">APP</div>',
    '                  <div style="font-size:15px;line-height:1.65;color:#222222;">Tenha acesso a produtos, ofertas e conteudos exclusivos.</div>',
    '                </td>',
    '                <td width="33.33%" valign="top" style="padding:0 6px;">',
    '                  <div style="width:72px;height:72px;border-radius:16px;border:1px solid #111111;color:#111111;font-size:15px;font-weight:800;line-height:72px;text-align:center;margin-bottom:14px;">TREINO</div>',
    '                  <div style="font-size:15px;line-height:1.65;color:#222222;">Acesse diversas opcoes gratuitas de treino no app.</div>',
    '                </td>',
    '                <td width="33.33%" valign="top" style="padding-left:12px;">',
    '                  <div style="width:72px;height:72px;border-radius:16px;background:#111111;color:#ffffff;font-size:15px;font-weight:800;line-height:72px;text-align:center;margin-bottom:14px;">RUN</div>',
    '                  <div style="font-size:15px;line-height:1.65;color:#222222;">Encontre a motivacao que voce precisa para correr mais e melhor.</div>',
    '                </td>',
    '              </tr>',
    '            </table>',
    '            <div style="margin:0 0 34px;padding:20px 22px;border-radius:18px;background:#f1f1f1;">',
    '              <div style="font-size:18px;line-height:1.25;font-weight:800;color:#111111;margin:0 0 10px;">Troque o seu produto na loja</div>',
    '              <div style="font-size:14px;line-height:1.7;color:#666666;">Leve o produto, a etiqueta e a nota fiscal. Confira a loja mais proxima para realizar trocas e compras.</div>',
    '            </div>',
    '            <div style="font-size:58px;line-height:.96;font-weight:900;letter-spacing:-.05em;color:#111111;margin:0 0 16px;">Obrigado<br>por fazer parte<br>do time.</div>',
    '          </div>',
    '        </td></tr>',
    '        <tr><td style="padding:24px 48px 34px;background:#ffffff;border-top:1px solid #ececec;">',
    `          <div style="font-size:12px;line-height:1.8;color:#818181;">${escapeHtml(d.footer || '')}</div>`,
    '        </td></tr>',
    '      </table>',
    '    </td></tr>',
    '  </table>',
    '</body>',
    '</html>',
  ].join('');
}
function normalizeEmailTemplate(tpl) {
  const baseDesigner = defaultEmailDesigner();
  const designer = { ...baseDesigner, ...((tpl && tpl.designer && typeof tpl.designer === 'object') ? tpl.designer : {}) };
  if (!designer.logoData) designer.logoData = baseDesigner.logoData || '';
  if (!designer.brandName) designer.brandName = baseDesigner.brandName || 'Virando a Chave';
  return {
    ...tpl,
    name: tpl?.name || 'Template Virando a Chave',
    subject: tpl?.subject || designer.subject || baseDesigner.subject,
    designer,
    html: tpl?.html || renderEmailDesignerHtml(designer),
  };
}
function getFallbackEmailTemplates() {
  const designer = defaultEmailDesigner();
  return [normalizeEmailTemplate({
    id: 'tpl-nike-fallback',
    name: 'Template Nike Virando a Chave',
    subject: designer.subject,
    designer,
    html: renderEmailDesignerHtml(designer),
    updatedAt: Date.now(),
  })];
}
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}
function renderEmailInboxItems(msgs, opts) {
  const list = document.getElementById('email-list'); if (!list) return;
  const syncing = !!opts?.syncing;
  if (!Array.isArray(msgs) || !msgs.length) {
    list.innerHTML = syncing
      ? '<div class="email-empty">Sincronizando caixa de entrada…</div>'
      : '<div class="email-empty">Nenhum email.</div>';
    return;
  }
  const syncBanner = syncing ? '<div class="email-syncing">Atualizando emails…</div>' : '';
  list.innerHTML = syncBanner + msgs.map(m => `<div class="email-item ${m.seen ? '' : 'unread'}" data-uid="${m.uid}"><div class="email-item-top"><span class="email-from">${escapeHtml(m.fromName || m.from)}</span><span class="email-date">${fmtEmailDate(m.date)}</span></div><div class="email-subj">${escapeHtml(m.subject)}</div></div>`).join('');
  list.querySelectorAll('.email-item').forEach(el => el.addEventListener('click', () => openEmailMessage(el.dataset.uid, el)));
}
function setEmailViewTitle(view) {
  const titleMap = {
    inbox: 'Caixa de entrada',
    drafts: 'Com estrela',
    scheduled: 'Adiados',
    sent: 'Enviados',
    spam: 'Spam',
    trash: 'Lixeira',
    templates: 'Templates',
    settings: 'Configurações',
  };
  const el = document.getElementById('email-view-title');
  if (el) el.textContent = titleMap[view] || 'Email';
  const btn = document.getElementById('email-new-template-btn');
  if (btn) btn.style.display = view === 'templates' ? '' : 'none';
}
function activateEmailPane(id) {
  document.querySelectorAll('#tab-email .email-pane').forEach(el => el.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function closeEmailMessageView() {
  document.getElementById('email-inbox-layout')?.classList.remove('reading');
  document.querySelectorAll('#tab-email .email-item.active').forEach(x => x.classList.remove('active'));
}
function renderEmailPlaceholder(view) {
  const list = document.getElementById('email-list');
  const pane = document.getElementById('email-read');
  const labels = { drafts: 'Com estrela', scheduled: 'Adiados', sent: 'Enviados', spam: 'Spam', trash: 'Lixeira' };
  if (list) list.innerHTML = `<div class="email-empty">${labels[view] || 'Área em breve'}</div>`;
  if (pane) pane.innerHTML = `<div class="email-placeholder-view">A área de ${labels[view] || 'Email'} fica aqui dentro da nova distribuição do Email.</div>`;
}
async function switchEmailView(view) {
  _emailView = view;
  document.querySelectorAll('#tab-email [data-email-view]').forEach(el => el.classList.toggle('active', el.dataset.emailView === view));
  setEmailViewTitle(view);
  if (view === 'templates') {
    activateEmailPane('email-pane-templates');
    await loadEmailTemplates();
    return;
  }
  if (view === 'settings') {
    activateEmailPane('email-pane-settings');
    await Promise.all([loadEmailConfig(), loadEmailClients()]);
    return;
  }
  activateEmailPane('email-pane-inbox');
  closeEmailMessageView();
  if (view === 'inbox') {
    loadEmailInbox({ silent: true });
    return;
  }
  renderEmailPlaceholder(view);
}
async function updateEmailNav() {
  try {
    const r = await apiFetch('/api/email/status'); const d = await r.json();
    const nav = document.getElementById('nav-email');
    _emailConfigured = !!d.configured;
    if (nav) nav.style.display = '';
    const sub = document.getElementById('email-acct-sub');
    if (sub) sub.textContent = d.configured ? (d.user || 'Caixa de entrada') : 'Configure a caixa de email';
    if (!_emailNavReady) {
      _emailNavReady = true;
      document.getElementById('email-compose-btn')?.addEventListener('click', () => emailCompose());
      document.getElementById('email-refresh-btn')?.addEventListener('click', () => {
        if (_emailView === 'templates') return loadEmailTemplates();
        if (_emailView === 'settings') return Promise.all([loadEmailConfig(), loadEmailClients()]);
        return loadEmailInbox();
      });
      document.getElementById('email-new-template-btn')?.addEventListener('click', () => openEmailTemplateEditor());
      document.querySelectorAll('#tab-email [data-email-view]').forEach(btn => btn.addEventListener('click', () => switchEmailView(btn.dataset.emailView || 'inbox')));
      document.getElementById('email-save-config-btn')?.addEventListener('click', saveEmailConfig);
      document.getElementById('email-save-client-btn')?.addEventListener('click', saveEmailClientSettings);
      document.getElementById('email-client-select')?.addEventListener('change', e => fillEmailClientFields(e.target.value));
    }
    if (d.configured && !_emailPreloadStarted) {
      _emailPreloadStarted = true;
      const cached = readEmailInboxCache();
      if (cached.length) _emailInboxHydrated = true;
      loadEmailInbox({ silent: true });
    }
  } catch (e) {}
}
function fmtEmailDate(d) {
  try { const dt = new Date(d); const now = new Date(); const same = dt.toDateString() === now.toDateString();
    return same ? dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); } catch (e) { return ''; }
}
async function loadEmailInbox(opts) {
  const list = document.getElementById('email-list'); if (!list) return;
  if (!_emailConfigured) {
    list.innerHTML = '<div class="email-empty">Configure a caixa de email em Configurações para começar.</div>';
    const pane = document.getElementById('email-read');
    if (pane) pane.innerHTML = '<div class="email-placeholder-view">Depois da configuração, sua caixa de entrada aparece aqui.</div>';
    return;
  }
  const silent = !!opts?.silent;
  const cached = readEmailInboxCache();
  if (cached.length && !_emailInboxHydrated) {
    _emailInboxHydrated = true;
    renderEmailInboxItems(cached, { syncing: true });
  } else if (!cached.length && !silent) {
    list.innerHTML = '<div class="email-loading">Carregando emails…</div>';
  } else if (cached.length) {
    renderEmailInboxItems(cached, { syncing: true });
  }
  try {
    const r = await apiFetch('/api/email/inbox?limit=40');
    if (!r.ok) { list.innerHTML = '<div class="email-empty">Erro ao carregar a caixa.</div>'; return; }
    const msgs = await r.json();
    writeEmailInboxCache(msgs);
    _emailInboxHydrated = true;
    renderEmailInboxItems(msgs, { syncing: false });
  } catch (e) { list.innerHTML = '<div class="email-empty">Erro ao carregar a caixa.</div>'; }
}
async function openEmailMessage(uid, el) {
  const pane = document.getElementById('email-read'); if (!pane) return;
  document.getElementById('email-inbox-layout')?.classList.add('reading');
  pane.innerHTML = '<div class="email-loading">Abrindo…</div>';
  if (el) { document.querySelectorAll('.email-item.active').forEach(x => x.classList.remove('active')); el.classList.add('active'); el.classList.remove('unread'); }
  try {
    const r = await apiFetch('/api/email/message/' + encodeURIComponent(uid));
    if (!r.ok) { pane.innerHTML = '<div class="email-empty">Erro ao abrir o email.</div>'; return; }
    const m = await r.json();
    const replyTo = encodeURIComponent(m.from || '');
    const replySubj = encodeURIComponent(m.subject || '');
    pane.innerHTML = `<div class="email-head"><button class="email-back-btn" id="email-back-btn">Voltar para emails</button><div class="email-head-subj">${escapeHtml(m.subject)}</div><div class="email-head-row"><div class="email-head-meta"><b>${escapeHtml(m.from)}</b><span class="email-head-date">${fmtEmailDate(m.date)}</span></div><button class="email-reply-btn" onclick="emailReplyEnc('${replyTo}','${replySubj}')">Responder</button></div></div><div class="email-body">${m.html ? '<iframe class="email-iframe" sandbox="allow-popups allow-same-origin"></iframe>' : ('<pre class="email-text">' + escapeHtml(m.text || '') + '</pre>')}</div>`;
    pane.querySelector('#email-back-btn')?.addEventListener('click', closeEmailMessageView);
    if (m.html) { const ifr = pane.querySelector('.email-iframe'); if (ifr) ifr.srcdoc = m.html; }
  } catch (e) { pane.innerHTML = '<div class="email-empty">Erro ao abrir o email.</div>'; }
}
async function loadEmailTemplates() {
  const grid = document.getElementById('email-templates-grid'); if (!grid) return;
  grid.innerHTML = '<div class="email-loading">Carregando templates…</div>';
  try {
    const r = await withTimeout(apiFetch('/api/email/templates'), 2500);
    if (!r.ok) {
      _emailTemplates = getFallbackEmailTemplates();
      renderEmailTemplates();
      return;
    }
    const payload = await r.json();
    const arr = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.templates) ? payload.templates : []);
    _emailTemplates = (arr.length ? arr : getFallbackEmailTemplates()).map(normalizeEmailTemplate).filter(Boolean);
    renderEmailTemplates();
  } catch (e) {
    _emailTemplates = getFallbackEmailTemplates();
    renderEmailTemplates();
  }
}
function renderEmailTemplates() {
  const grid = document.getElementById('email-templates-grid'); if (!grid) return;
  if (!_emailTemplates.length) {
    _emailTemplates = getFallbackEmailTemplates();
  }
  if (!_emailTemplates.length) {
    grid.innerHTML = '<div class="email-empty">Nenhum template salvo.</div>';
    return;
  }
  grid.innerHTML = _emailTemplates.map(tpl => `
    <div class="email-template-card">
      <div class="email-template-name">${escapeHtml(tpl.name || 'Template')}</div>
      <div class="email-template-subject">Assunto: ${escapeHtml(tpl.subject || '(sem assunto)')}</div>
      <div class="email-template-preview">${escapeHtml(stripHtmlPreview(tpl.html || '')).slice(0, 220) || 'Sem conteúdo.'}</div>
      <div class="email-template-actions">
        <button class="email-template-btn" data-act="use" data-id="${escapeAttr(tpl.id)}">Usar</button>
        <button class="email-template-btn" data-act="edit" data-id="${escapeAttr(tpl.id)}">Designer</button>
        <button class="email-template-btn" data-act="delete" data-id="${escapeAttr(tpl.id)}">Excluir</button>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-act="use"]').forEach(btn => btn.addEventListener('click', () => {
    const tpl = _emailTemplates.find(x => x.id === btn.dataset.id); emailCompose('', tpl?.subject || '', tpl || null);
  }));
  grid.querySelectorAll('[data-act="edit"]').forEach(btn => btn.addEventListener('click', () => {
    const tpl = _emailTemplates.find(x => x.id === btn.dataset.id); openEmailTemplateEditor(tpl);
  }));
  grid.querySelectorAll('[data-act="delete"]').forEach(btn => btn.addEventListener('click', () => deleteEmailTemplate(btn.dataset.id)));
}
async function deleteEmailTemplate(id) {
  if (!id || !confirm('Excluir este template?')) return;
  const r = await apiFetch('/api/email/templates/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!r.ok) return alert('Não foi possível excluir o template.');
  loadEmailTemplates();
}
function openEmailTemplateEditor(tpl) {
  const current = normalizeEmailTemplate(tpl || {});
  const designer = { ...defaultEmailDesigner(), ...(current.designer || {}) };
  let ov = document.getElementById('email-template-ov');
  if (!ov) { ov = document.createElement('div'); ov.id = 'email-template-ov'; ov.className = 'cfg-overlay'; document.body.appendChild(ov); ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; }); }
  ov.style.display = 'flex';
  ov.innerHTML = '<div class="cfg-box email-designer-box"><div class="cfg-head"><span>' + (tpl ? 'Editar template' : 'Novo template') + '</span><button class="cfg-x" onclick="document.getElementById(\'email-template-ov\').style.display=\'none\'">&times;</button></div>'
    + '<div class="email-designer-grid">'
    + '<div class="email-designer-form">'
    + '<label class="cfg-lbl">Nome do template</label><input class="cfg-inp" id="et-name" value="' + escapeAttr(current.name || 'Template Virando a Chave') + '">'
    + '<label class="cfg-lbl">Assunto padrão</label><input class="cfg-inp" id="et-subj" value="' + escapeAttr(current.subject || designer.subject || '') + '">'
    + '<label class="cfg-lbl">Etiqueta superior</label><input class="cfg-inp" id="et-kicker" value="' + escapeAttr(designer.kicker || '') + '">'
    + '<label class="cfg-lbl">Título principal</label><input class="cfg-inp" id="et-headline" value="' + escapeAttr(designer.headline || '') + '">'
    + '<label class="cfg-lbl">Texto de abertura</label><textarea class="cfg-inp" id="et-intro" rows="3">' + escapeHtml(designer.intro || '') + '</textarea>'
    + '<label class="cfg-lbl">Texto complementar</label><textarea class="cfg-inp" id="et-body" rows="4">' + escapeHtml(designer.body || '') + '</textarea>'
    + '<label class="cfg-lbl">Faixa de destaque</label><input class="cfg-inp" id="et-highlight" value="' + escapeAttr(designer.highlight || '') + '">'
    + '<label class="cfg-lbl">Texto do botão</label><input class="cfg-inp" id="et-ctaLabel" value="' + escapeAttr(designer.ctaLabel || '') + '">'
    + '<label class="cfg-lbl">Link do botão</label><input class="cfg-inp" id="et-ctaUrl" value="' + escapeAttr(designer.ctaUrl || '') + '">'
    + '<label class="cfg-lbl">Rodapé</label><textarea class="cfg-inp" id="et-footer" rows="3">' + escapeHtml(designer.footer || '') + '</textarea>'
    + '<div class="cfg-actions"><button class="cfg-cancel" onclick="document.getElementById(\'email-template-ov\').style.display=\'none\'">Cancelar</button><button class="cfg-save" id="et-save">Salvar template</button></div>'
    + '</div>'
    + '<div class="email-designer-preview-wrap"><div class="email-designer-preview-title">Preview</div><iframe class="email-designer-preview" id="et-preview"></iframe></div>'
    + '</div></div>';
  const updatePreview = () => {
    const nextDesigner = {
      ...designer,
      subject: document.getElementById('et-subj').value.trim(),
      kicker: document.getElementById('et-kicker').value.trim(),
      headline: document.getElementById('et-headline').value.trim(),
      intro: document.getElementById('et-intro').value,
      body: document.getElementById('et-body').value,
      highlight: document.getElementById('et-highlight').value.trim(),
      ctaLabel: document.getElementById('et-ctaLabel').value.trim(),
      ctaUrl: document.getElementById('et-ctaUrl').value.trim(),
      footer: document.getElementById('et-footer').value,
    };
    const ifr = document.getElementById('et-preview');
    if (ifr) ifr.srcdoc = renderEmailDesignerHtml(nextDesigner);
  };
  ['et-subj','et-kicker','et-headline','et-intro','et-body','et-highlight','et-ctaLabel','et-ctaUrl','et-footer'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });
  updatePreview();
  document.getElementById('et-save').addEventListener('click', async () => {
    const nextDesigner = {
      ...designer,
      subject: document.getElementById('et-subj').value.trim(),
      kicker: document.getElementById('et-kicker').value.trim(),
      headline: document.getElementById('et-headline').value.trim(),
      intro: document.getElementById('et-intro').value,
      body: document.getElementById('et-body').value,
      highlight: document.getElementById('et-highlight').value.trim(),
      ctaLabel: document.getElementById('et-ctaLabel').value.trim(),
      ctaUrl: document.getElementById('et-ctaUrl').value.trim(),
      footer: document.getElementById('et-footer').value,
    };
    const payload = {
      id: current.id || '',
      name: document.getElementById('et-name').value.trim(),
      subject: document.getElementById('et-subj').value.trim(),
      html: renderEmailDesignerHtml(nextDesigner),
      designer: nextDesigner,
    };
    const r = await apiFetch('/api/email/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) return alert('Erro ao salvar o template.');
    document.getElementById('email-template-ov').style.display = 'none';
    loadEmailTemplates();
  });
}
async function loadEmailConfig() {
  try {
    const r = await apiFetch('/api/email/config');
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('email-cfg-user').value = d.user || '';
    document.getElementById('email-cfg-fromName').value = d.fromName || '';
    document.getElementById('email-cfg-imapHost').value = d.imapHost || '';
    document.getElementById('email-cfg-imapPort').value = d.imapPort || 993;
    document.getElementById('email-cfg-smtpHost').value = d.smtpHost || '';
    document.getElementById('email-cfg-smtpPort').value = d.smtpPort || 465;
    document.getElementById('email-cfg-pass').value = '';
  } catch (e) {}
}
async function saveEmailConfig() {
  const payload = {
    user: document.getElementById('email-cfg-user').value.trim(),
    fromName: document.getElementById('email-cfg-fromName').value.trim(),
    imapHost: document.getElementById('email-cfg-imapHost').value.trim(),
    imapPort: Number(document.getElementById('email-cfg-imapPort').value) || 993,
    smtpHost: document.getElementById('email-cfg-smtpHost').value.trim(),
    smtpPort: Number(document.getElementById('email-cfg-smtpPort').value) || 465,
    pass: document.getElementById('email-cfg-pass').value,
  };
  const r = await apiFetch('/api/email/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return alert(d.error || 'Erro ao salvar configuração do email.');
  alert('Configuração do email salva com sucesso.');
  updateEmailNav();
}
async function loadEmailClients() {
  try {
    const r = await withTimeout(apiFetch('/api/email/clients'), 2500);
    if (!r.ok) return;
    _emailClients = await r.json();
    const select = document.getElementById('email-client-select');
    if (!select) return;
    if (!_emailCurrentClient) _emailCurrentClient = (_emailClients[0] && _emailClients[0].clientId) || '';
    select.innerHTML = _emailClients.map(c => `<option value="${escapeAttr(c.clientId)}">${escapeHtml(c.name || c.clientId)}</option>`).join('');
    if (_emailCurrentClient) select.value = _emailCurrentClient;
    await fillEmailClientFields(select.value || _emailCurrentClient);
  } catch (e) {}
}
async function fillEmailClientFields(clientId) {
  if (!clientId) return;
  _emailCurrentClient = clientId;
  try {
    const r = await withTimeout(apiFetch('/api/email/client/' + encodeURIComponent(clientId)), 2500);
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('email-client-geral').value = (d.emailsGeral || []).join('\n');
    document.getElementById('email-client-relatorio').value = (d.emailsRelatorio || []).join('\n');
    document.getElementById('email-client-financeiro').value = (d.emailsFinanceiro || []).join('\n');
  } catch (e) {}
}
async function saveEmailClientSettings() {
  const clientId = document.getElementById('email-client-select').value;
  if (!clientId) return alert('Selecione um cliente.');
  const payload = {
    emailsGeral: document.getElementById('email-client-geral').value.split(/\n+/).map(v => v.trim()).filter(Boolean),
    emailsRelatorio: document.getElementById('email-client-relatorio').value.split(/\n+/).map(v => v.trim()).filter(Boolean),
    emailsFinanceiro: document.getElementById('email-client-financeiro').value.split(/\n+/).map(v => v.trim()).filter(Boolean),
  };
  const r = await apiFetch('/api/email/client/' + encodeURIComponent(clientId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return alert(d.error || 'Erro ao salvar emails do cliente.');
  alert('Emails do cliente salvos.');
  loadEmailClients();
}
function getClientRecipients(clientId, groupKey) {
  const cli = (emailClientsMap()[clientId] || {});
  const groups = cli.groups || {};
  return Array.isArray(groups[groupKey]) ? groups[groupKey] : [];
}
function renderComposePreviewHtml(body) {
  const html = String(body || '').trim();
  if (!html) return '<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;"><div style="padding:48px 24px;text-align:center;color:#6b7280;font-size:16px;">Selecione um template ou escreva sua mensagem para ver o preview.</div></body></html>';
  if (/<[a-z][\s\S]*>/i.test(html)) return html;
  return '<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;background:#ffffff;font-family:Arial,sans-serif;color:#111111;"><div style="max-width:720px;margin:0 auto;padding:32px 28px;white-space:pre-wrap;line-height:1.7;font-size:16px;">' + escapeHtml(html) + '</div></body></html>';
}
function emailReplyEnc(toEnc, subjEnc) {
  const to = decodeURIComponent(toEnc); let subj = decodeURIComponent(subjEnc);
  if (!/^re:/i.test(subj)) subj = 'Re: ' + subj;
  emailCompose(to, subj);
}
async function emailCompose(to, subject, template) {
  try {
    await Promise.race([
      (async () => {
        if (!_emailTemplates.length) try { await loadEmailTemplates(); } catch(e) {}
        if (!_emailClients.length) try { await loadEmailClients(); } catch(e) {}
      })(),
      new Promise(r => setTimeout(r, 1500))
    ]);
  } catch(e) {}
  if (!_emailTemplates.length) _emailTemplates = getFallbackEmailTemplates();
  to = to || ''; subject = subject || '';
  let ov = document.getElementById('email-compose-ov');
  if (!ov) { ov = document.createElement('div'); ov.id = 'email-compose-ov'; ov.className = 'cfg-overlay'; document.body.appendChild(ov); ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; }); }
  const firstClientId = _emailCurrentClient || ((_emailClients[0] || {}).clientId || '');
  const templatesOptions = _emailTemplates.map(tpl => `<option value="${escapeAttr(tpl.id)}">${escapeHtml(tpl.name)}</option>`).join('');
  const clientsOptions = _emailClients.map(c => `<option value="${escapeAttr(c.clientId)}">${escapeHtml(c.name || c.clientId)}</option>`).join('');
  ov.style.display = 'flex';
  ov.innerHTML = '<div class="cfg-box email-compose-box"><div class="cfg-head"><span>Novo email</span><button class="cfg-x" onclick="document.getElementById(\'email-compose-ov\').style.display=\'none\'">&times;</button></div>'
    + '<div class="email-compose-grid">'
    + '<div class="email-compose-form">'
    + '<label class="cfg-lbl">Tipo de envio</label><select class="cfg-inp" id="ec-mode"><option value="manual">Manual</option><option value="geral">Email geral do cliente</option><option value="relatorio">Email relatório do cliente</option><option value="financeiro">Email financeiro do cliente</option></select>'
    + '<div id="ec-client-wrap"><label class="cfg-lbl">Cliente</label><select class="cfg-inp" id="ec-client">' + clientsOptions + '</select></div>'
    + '<label class="cfg-lbl">Destinatários</label><input class="cfg-inp" id="ec-to" value="' + escapeAttr(to) + '" placeholder="destinatario@email.com">'
    + '<label class="cfg-lbl">Template</label><select class="cfg-inp" id="ec-template"><option value="">Sem template</option>' + templatesOptions + '</select>'
    + '<label class="cfg-lbl">Assunto</label><input class="cfg-inp" id="ec-subj" value="' + escapeAttr(subject || template?.subject || '') + '">'
    + '<label class="cfg-lbl">HTML / mensagem</label><textarea class="cfg-inp email-compose-body" id="ec-body" rows="18">' + escapeHtml(template?.html || '') + '</textarea>'
    + '<div class="cfg-actions"><button class="cfg-cancel" onclick="document.getElementById(\'email-compose-ov\').style.display=\'none\'">Cancelar</button><button class="cfg-save" id="ec-send">Enviar</button></div>'
    + '</div>'
    + '<div class="email-compose-preview-wrap"><div class="email-designer-preview-title">Preview do email</div><iframe class="email-compose-preview" id="ec-preview"></iframe></div>'
    + '</div></div>';
  const modeEl = document.getElementById('ec-mode');
  const clientEl = document.getElementById('ec-client');
  const toEl = document.getElementById('ec-to');
  const tplEl = document.getElementById('ec-template');
  const bodyEl = document.getElementById('ec-body');
  if (firstClientId) clientEl.value = firstClientId;
  if (template?.id) tplEl.value = template.id;
  const updatePreview = () => {
    const ifr = document.getElementById('ec-preview');
    if (ifr) ifr.srcdoc = renderComposePreviewHtml(bodyEl.value);
  };
  function syncRecipients() {
    const mode = modeEl.value;
    const manual = mode === 'manual';
    document.getElementById('ec-client-wrap').style.display = manual ? 'none' : '';
    toEl.readOnly = !manual;
    toEl.style.opacity = manual ? '1' : '.9';
    if (manual) return;
    const list = getClientRecipients(clientEl.value, mode);
    toEl.value = list.join(', ');
  }
  modeEl.addEventListener('change', syncRecipients);
  clientEl.addEventListener('change', syncRecipients);
  tplEl.addEventListener('change', () => {
    const tpl = _emailTemplates.find(x => x.id === tplEl.value);
    if (!tpl) { updatePreview(); return; }
    document.getElementById('ec-subj').value = tpl.subject || '';
    document.getElementById('ec-body').value = tpl.html || '';
    updatePreview();
  });
  bodyEl.addEventListener('input', updatePreview);
  syncRecipients();
  updatePreview();
  document.getElementById('ec-send').addEventListener('click', sendEmailNow);
}
async function sendEmailNow() {
  const mode = document.getElementById('ec-mode').value;
  const to = document.getElementById('ec-to').value.trim();
  const subject = document.getElementById('ec-subj').value.trim();
  const body = document.getElementById('ec-body').value;
  const clientId = document.getElementById('ec-client')?.value || _emailCurrentClient || '';
  if (!to || !subject) { alert('Preencha os destinatários e o assunto.'); return; }
  const btn = document.getElementById('ec-send'); btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const payload = {
      to,
      subject,
      body,
      html: body,
      recipientMode: mode === 'manual' ? 'manual' : 'client-group',
      recipientGroup: mode === 'manual' ? '' : mode,
      clientId,
    };
    const r = await apiFetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (r.ok && d.ok) {
      document.getElementById('email-compose-ov').style.display = 'none';
      alert('Email enviado!');
      if (_emailView === 'inbox') loadEmailInbox({ silent: true });
    }
    else { alert('Erro ao enviar: ' + (d.error || 'falha')); btn.disabled = false; btn.textContent = 'Enviar'; }
  } catch (e) { alert('Erro ao enviar o email.'); btn.disabled = false; btn.textContent = 'Enviar'; }
}
window.updateEmailNav = updateEmailNav; window.loadEmailInbox = loadEmailInbox; window.emailReplyEnc = emailReplyEnc; window.emailCompose = emailCompose; window.openEmailTemplateEditor = openEmailTemplateEditor; window.emailMarketing = function() { emailCompose(); };



// ─── Dashboard da Agência (virandoachave vê todos os clientes) ───
(function(){
  const esc = (x)=> (typeof escapeHtml==='function'?escapeHtml(x==null?'':String(x)):String(x==null?'':x));
  function emailsJoin(a){ return (Array.isArray(a)?a:[]).map(function(x){return x&&x.email;}).filter(Boolean).join(', '); }
  let _agClients = [];
  function isAgency(){ return currentUser && String(currentUser.clientId)==='virandoachave'; }

  const _origLoad = window.loadDashboard;
  window.loadDashboard = async function(){
    if (!isAgency()) return _origLoad ? _origLoad.apply(this, arguments) : null;
    const root = document.getElementById('dashboard-root'); if (!root) return;
    root.innerHTML = '<div class="ag-loading">Carregando clientes…</div>';
    try { const r = await apiFetch('/api/dashboard/agency'); _agClients = await r.json(); if(!Array.isArray(_agClients)) _agClients=[]; }
    catch(e){ _agClients = []; }
    renderAgencyGrid();
  };

  function initials(name){ return (name||'?').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase(); }

  function renderAgencyGrid(){
    const root = document.getElementById('dashboard-root'); if(!root) return;
    const cs = _agClients;
    const totLeads = cs.reduce((a,c)=>a+(c.metrics&&c.metrics.leadsTotal||0),0);
    const totHoje = cs.reduce((a,c)=>a+(c.metrics&&c.metrics.leadsHoje||0),0);
    root.innerHTML =
      '<div class="ag-wrap">'+
        '<div class="ag-top">'+
          '<div><h2 class="ag-title">Painel da Agência</h2><div class="ag-subtitle">'+cs.length+' clientes · '+totLeads+' leads no total · '+totHoje+' hoje</div></div>'+
          '<button class="ag-refresh" onclick="loadDashboard()">Atualizar</button>'+
        '</div>'+
        '<div class="ag-grid">'+
          cs.map(function(c){
            const p=c.profile||{}, m=c.metrics||{};
            const logo = p.logo ? ('<div class="ag-logo" style="background-image:url(\''+p.logo+'\')"></div>') : ('<div class="ag-logo ag-logo-ini">'+esc(initials(c.name))+'</div>');
            const saude = esc(p.saude||'—');
            const saudeClass = /saud/i.test(saude)?'ok':(/aten|risc|critic/i.test(saude)?'warn':'');
            return '<div class="ag-card" onclick="agOpenClient(\''+c.clientId+'\')">'+
              '<div class="ag-card-top">'+logo+'<div class="ag-card-id"><div class="ag-name">'+esc(c.name)+'</div><div class="ag-seg">'+esc(p.segmento||c.clientId)+'</div></div></div>'+
              '<div class="ag-metrics"><div class="ag-m"><b>'+(m.leadsTotal||0)+'</b><span>Leads</span></div><div class="ag-m"><b>'+(m.leads7||0)+'</b><span>7 dias</span></div><div class="ag-m"><b>'+(m.leadsHoje||0)+'</b><span>Hoje</span></div></div>'+
              '<div class="ag-foot"><span class="ag-health '+saudeClass+'"><span class="ag-dot"></span>'+saude+'</span><span class="ag-open">Ver painel ›</span></div>'+
            '</div>';
          }).join('')+
        '</div>'+
        (cs.length?'':'<div class="ag-empty">Nenhum cliente encontrado.</div>')+
      '</div>';
  }

  window.agOpenClient = function(id){
    const c = _agClients.find(x=>x.clientId===id); if(!c) return;
    renderAgencyClient(c);
  };

  function section(title, inner){ return '<div class="dcard ag-sec"><div class="ag-sec-h">'+esc(title)+'</div>'+inner+'</div>'; }
  function rowKV(k,v){ return '<div class="ag-kv"><span>'+esc(k)+'</span><b>'+esc(v||'—')+'</b></div>'; }

  function renderAgencyClient(c){
    const root = document.getElementById('dashboard-root'); if(!root) return;
    const p=c.profile||{}, m=c.metrics||{};
    const links=Array.isArray(p.links)?p.links:[], pws=Array.isArray(p.passwords)?p.passwords:[], goals=Array.isArray(p.goals)?p.goals:[], notes=Array.isArray(p.notes)?p.notes:[];
    const logo = p.logo ? ('<div class="dlogo" style="background-image:url(\''+p.logo+'\')"></div>') : ('<div class="dlogo">'+esc(initials(c.name))+'</div>');
    root.innerHTML =
      '<div class="ag-wrap">'+
        '<button class="ag-back" onclick="loadDashboard()">‹ Voltar aos clientes</button>'+
        '<div class="dwrap">'+
          '<div class="dhead">'+logo+
            '<div><h2>'+esc(c.name)+'</h2><div class="dsub">'+esc(p.segmento||'')+'</div></div>'+
            '<div class="dactions"><a class="dbtn" href="'+esc(c.url)+'" target="_blank" style="text-decoration:none">Abrir app do cliente ›</a><span class="dpill"><span class="ddot"></span> Saúde: '+esc(p.saude||'—')+'</span></div>'+
          '</div>'+
          '<div class="ag-stats">'+
            '<div class="dcard dstat"><div class="dlbl">Leads (CRM)</div><div class="dval">'+(m.leadsTotal||0)+'</div><div class="dmeta">'+(m.leads7||0)+' nos últimos 7 dias · '+(m.leadsHoje||0)+' hoje</div></div>'+
            '<div class="dcard dstat"><div class="dlbl">Último contato</div><div class="dval" style="font-size:18px">'+esc(p.ultimoContato||'—')+'</div><div class="dmeta">'+esc(p.ultimoContatoNota||'')+'</div></div>'+
            '<div class="dcard dstat"><div class="dlbl">Último relatório</div><div class="dval" style="font-size:17px">'+esc(p.ultimoRelatorioData||'—')+'</div><div class="dmeta">'+(p.ultimoRelatorioUrl?('<a href="'+esc(p.ultimoRelatorioUrl)+'" target="_blank">Abrir</a>'):'')+'</div></div>'+
          '</div>'+
          '<div class="ag-cols">'+
            section('Dados', rowKV('Razão social',p.razaoSocial)+rowKV('CNPJ',p.cnpj)+rowKV('Responsável',p.responsavel)+rowKV('Segmento',p.segmento))+
            section('Links', links.length?links.map(function(l){return '<div class="ag-kv"><span>'+esc(l.label||l.title||'Link')+'</span><a href="'+esc(l.url||l.value||'#')+'" target="_blank">abrir</a></div>';}).join(''):'<div class="ag-none">Sem links</div>')+section('Emails', rowKV('Financeiro', emailsJoin(p.emailsFinanceiro))+rowKV('Relatório', emailsJoin(p.emailsRelatorio))+rowKV('Geral', emailsJoin(p.emailsGeral)))+
            section('Metas', goals.length?goals.map(function(g){return '<div class="ag-goal">'+esc(typeof g==='string'?g:(g.text||g.label||''))+'</div>';}).join(''):'<div class="ag-none">Sem metas</div>')+
            section('Acessos & senhas', pws.length?pws.map(function(w){return '<div class="ag-kv"><span>'+esc(w.label||w.title||'Acesso')+'</span><b class="ag-pw">'+esc((w.user?w.user+' / ':'')+(w.password||w.value||''))+'</b></div>';}).join(''):'<div class="ag-none">Sem senhas</div>')+
            section('Notas', notes.length?notes.map(function(n){return '<div class="ag-note">'+esc(typeof n==='string'?n:(n.text||''))+'</div>';}).join(''):'<div class="ag-none">Sem notas</div>')+
          '</div>'+
        '</div>'+
      '</div>';
  }
})();



// ─── Arquivos (trabalhos aprovados) ────────────
function filesFmtBytes(n) { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }
function fileThumb(mime, url) {
  if (/^image\//.test(mime || '')) return '<div class="file-thumb" style="background-image:url(\'' + url + '\')"></div>';
  if (/^video\//.test(mime || '')) return '<div class="file-thumb file-ext file-vid">VÍDEO</div>';
  if (/pdf/.test(mime || '')) return '<div class="file-thumb file-ext file-pdf">PDF</div>';
  const ext = (url.split('.').pop() || '?').toUpperCase().slice(0, 4);
  return '<div class="file-thumb file-ext">' + escapeHtml(ext) + '</div>';
}
function filePublicUrl(item) {
  const raw = item?.publicUrl || item?.url || '';
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return window.location.origin + raw;
}
function bundleThumb(item) {
  const files = Array.isArray(item?.files) ? item.files.slice(0, 4) : [];
  if (!files.length) return '<div class="file-thumb file-ext">PASTA</div>';
  const cells = files.map((file, idx) => `<div class="file-bundle-cell${idx === 3 && (item.count || files.length) > 4 ? ' has-more' : ''}" style="background-image:url('${escapeHtml(file.url || '')}')">${idx === 3 && (item.count || files.length) > 4 ? `<span>+${(item.count || files.length) - 3}</span>` : ''}</div>`).join('');
  return `<div class="file-thumb file-bundle-thumb">${cells}</div>`;
}
async function loadFiles() {
  const grid = document.getElementById('files-grid'); if (!grid) return;
  grid.innerHTML = '<div class="files-empty">Carregando…</div>';
  try { const r = await apiFetch('/api/files'); const arr = await r.json(); renderFiles(Array.isArray(arr) ? arr : []); }
  catch (e) { grid.innerHTML = '<div class="files-empty">Erro ao carregar.</div>'; }
}
function renderFiles(arr) {
  const grid = document.getElementById('files-grid'); if (!grid) return;
  if (!arr.length) { grid.innerHTML = '<div class="files-empty">Nenhum arquivo ainda. Clique em "Enviar arquivo" para guardar os trabalhos aprovados.</div>'; return; }
  grid.innerHTML = arr.map(f => {
    const isBundle = f.type === 'bundle' && Array.isArray(f.files);
    const thumb = isBundle ? bundleThumb(f) : fileThumb(f.mime, f.url);
    const metaMain = isBundle ? `${f.count || f.files.length} imagens` : filesFmtBytes(f.size);
    const publicUrl = filePublicUrl(f);
    const openHref = isBundle ? publicUrl : escapeHtml(f.url);
    const openLabel = isBundle ? 'Abrir pasta' : 'Baixar';
    return '<div class="file-card">' + thumb +
      '<div class="file-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</div>' +
      '<div class="file-meta">' + escapeHtml(metaMain) + ' · ' + (f.date ? new Date(f.date).toLocaleDateString('pt-BR') : '') + '</div>' +
      '<div class="file-actions"><a href="' + escapeHtml(openHref) + '" target="_blank"' + (isBundle ? '' : ' download') + ' class="file-dl">' + openLabel + '</a><button class="file-copy" onclick="copyFilePublicLink(\'' + escapeAttr(publicUrl) + '\')">Copiar link</button><button class="file-del" onclick="deleteFile(\'' + f.id + '\')">Excluir</button></div></div>';
  }).join('');
}
async function uploadFiles(files) {
  const grid = document.getElementById('files-grid');
  if (grid) grid.insertAdjacentHTML('afterbegin', '<div class="files-empty" id="files-uploading">Enviando…</div>');
  const fd = new FormData();
  for (const file of files) fd.append('file', file);
  try { await apiFetch('/api/files', { method: 'POST', body: fd }); } catch (e) {}
  loadFiles();
}
async function copyFilePublicLink(url) {
  if (!url) return alert('Link público não disponível.');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else throw new Error('clipboard');
    alert('Link público copiado!');
  } catch (e) {
    prompt('Copie o link público:', url);
  }
}
async function deleteFile(id) {
  if (!confirm('Excluir este arquivo?')) return;
  try { await apiFetch('/api/files/' + id, { method: 'DELETE' }); } catch (e) {}
  loadFiles();
}
(function () {
  function setup() {
    const btn = document.getElementById('files-upload-btn'), inp = document.getElementById('files-input');
    if (btn && inp && !btn._wired) { btn._wired = 1; btn.onclick = () => inp.click(); inp.onchange = () => { if (inp.files.length) uploadFiles(inp.files); inp.value = ''; }; }
  }
  document.addEventListener('DOMContentLoaded', setup); setTimeout(setup, 1500); setTimeout(setup, 4000);
})();
window.loadFiles = loadFiles; window.deleteFile = deleteFile; window.copyFilePublicLink = copyFilePublicLink;
