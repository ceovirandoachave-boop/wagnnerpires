const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Sequencia global de ids de agendamento: nunca repete, nunca anda pra tras.
let _ultimoScheduleId = 0;
function nextScheduleId() {
  const agora = Date.now();
  _ultimoScheduleId = agora > _ultimoScheduleId ? agora : _ultimoScheduleId + 1;
  return _ultimoScheduleId;
}

const dbCache = new Map();

// Antes disso ficava só 3000 mensagens NO TOTAL por cliente (todos os contatos somados) e
// apagava o resto de verdade — em cliente ativo isso significava só uns dias de histórico.
// Agora é só uma válvula de segurança (evita a tabela crescer sem limite entre uma
// passada e outra do arquivamento diário por idade) e move pra messages_archive em vez
// de descartar. Retenção "de verdade" é a archiveOldMessagesOlderThan, rodada 1x/dia.
const MESSAGES_SAFETY_CAP = 20000;
const MESSAGES_COLS = 'id,direction,contact_id,contact_name,text,media_url,media_type,media_name,schedule_id,timestamp,connection_id,wamid,delivery_status,delivery_error';

function forClient(clientId) {
  if (dbCache.has(clientId)) return dbCache.get(clientId);

  const DATA_DIR = path.join(process.env.DATA_DIR || __dirname, 'data', clientId);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const sqlite = new Database(path.join(DATA_DIR, 'db.sqlite3'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY, visitor_id TEXT, started_at INTEGER, last_at INTEGER,
      entry_path TEXT, exit_path TEXT, referrer TEXT, device TEXT, browser TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, page_views INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0, converted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_started ON web_sessions(started_at DESC);
    CREATE TABLE IF NOT EXISTS web_pageviews (
      id TEXT PRIMARY KEY, session_id TEXT, visitor_id TEXT, url TEXT, path TEXT, title TEXT,
      referrer TEXT, started_at INTEGER, last_at INTEGER, duration_ms INTEGER DEFAULT 0,
      viewport_w INTEGER, viewport_h INTEGER, document_h INTEGER, max_scroll INTEGER DEFAULT 0,
      snapshot TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_pageviews_path_time ON web_pageviews(path, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_web_pageviews_session ON web_pageviews(session_id, started_at);
    CREATE TABLE IF NOT EXISTS web_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, session_id TEXT,
      pageview_id TEXT, type TEXT, at INTEGER, x REAL, y REAL, scroll_pct INTEGER,
      target TEXT, name TEXT, value_num REAL, data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_events_type_time ON web_events(type, at DESC);
    CREATE INDEX IF NOT EXISTS idx_web_events_page ON web_events(pageview_id, at);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, recipient_type TEXT, recipient_id TEXT, recipient_name TEXT,
      message TEXT, scheduled_for INTEGER, document_path TEXT, document_name TEXT,
      quick_replies TEXT, bulk_id TEXT, retry_count INTEGER DEFAULT 0,
      last_attempt_error TEXT, last_attempt_at INTEGER, created_at INTEGER, updated_at INTEGER,
      connection_id TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY, schedule_id TEXT, recipient_type TEXT, recipient_id TEXT,
      recipient_name TEXT, message TEXT, quick_replies TEXT, document_name TEXT,
      document_path TEXT, success INTEGER, error TEXT, sent_at INTEGER, connection_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_sent_at ON logs(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_recipient ON logs(recipient_id, sent_at);

    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY, schedule_id TEXT, sender_id TEXT, sender_name TEXT,
      recipient_id TEXT, recipient_name TEXT, reply TEXT, matched_button TEXT,
      response_time_ms INTEGER, received_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_responses_received ON responses(received_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, direction TEXT, contact_id TEXT, contact_name TEXT,
      text TEXT, media_url TEXT, media_type TEXT, media_name TEXT,
      schedule_id TEXT, timestamp INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp DESC);

    -- Mensagens antigas vão pra cá em vez de serem apagadas (mesmas colunas de messages).
    CREATE TABLE IF NOT EXISTS messages_archive (
      id TEXT PRIMARY KEY, direction TEXT, contact_id TEXT, contact_name TEXT,
      text TEXT, media_url TEXT, media_type TEXT, media_name TEXT,
      schedule_id TEXT, timestamp INTEGER, connection_id TEXT, wamid TEXT,
      delivery_status TEXT, delivery_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_archive_contact ON messages_archive(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_archive_ts ON messages_archive(timestamp DESC);

    CREATE TABLE IF NOT EXISTS known_contacts (
      id TEXT PRIMARY KEY, name TEXT, first_seen_at INTEGER, last_seen_at INTEGER,
      message_count INTEGER DEFAULT 0, profile_pic_url TEXT, profile_pic_fetched_at INTEGER,
      wa_id TEXT, phone TEXT, country_code TEXT, username TEXT, phone_number_id TEXT, waba_id TEXT
    );

    CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, chat_connection_id TEXT);

    CREATE TABLE IF NOT EXISTS crm_columns (
      id TEXT PRIMARY KEY, funnel_id TEXT, name TEXT, col_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_crm_cols_funnel ON crm_columns(funnel_id);

    CREATE TABLE IF NOT EXISTS crm_cards (
      id TEXT PRIMARY KEY, column_id TEXT, funnel_id TEXT, contact_name TEXT,
      phone TEXT, whatsapp_id TEXT, instagram TEXT, site TEXT,
      label TEXT, labels TEXT, checks TEXT, notes TEXT, estado TEXT, cidade TEXT, email TEXT, whatsapp TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_crm_cards_funnel ON crm_cards(funnel_id);
    CREATE INDEX IF NOT EXISTS idx_crm_cards_col ON crm_cards(column_id);

    -- Histórico de mudança de coluna: cada linha é 1 entrada numa coluna (from pode ser
    -- NULL quando o card já nasce nela). Serve pra 2 coisas: contar quantos entraram numa
    -- coluna num período (ex: hoje) e saber de qual coluna um card veio antes da atual.
    CREATE TABLE IF NOT EXISTS crm_card_column_history (
      id TEXT PRIMARY KEY, card_id TEXT, funnel_id TEXT,
      from_column_id TEXT, to_column_id TEXT, at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cch_card ON crm_card_column_history(card_id);
    CREATE INDEX IF NOT EXISTS idx_cch_to_at ON crm_card_column_history(to_column_id, at);

    CREATE TABLE IF NOT EXISTS prospects (
      id TEXT PRIMARY KEY, name TEXT, instagram TEXT, site TEXT, phone TEXT, created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS consultants (
      id TEXT PRIMARY KEY, name TEXT, available INTEGER DEFAULT 1,
      last_assigned_at INTEGER DEFAULT 0, created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS lid_map (
      lid TEXT PRIMARY KEY, phone_jid TEXT, updated_at INTEGER
    );

    -- Ligações via WhatsApp Calling API (Cloud API oficial). 1 linha por evento
    -- (connect e terminate chegam em webhooks separados, casados depois por wacall_id).
    CREATE TABLE IF NOT EXISTS call_events (
      id TEXT PRIMARY KEY, contact_id TEXT, connection_id TEXT, wacall_id TEXT,
      event TEXT, direction TEXT, status TEXT, duration INTEGER,
      started_at INTEGER, ended_at INTEGER, at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_call_events_contact ON call_events(contact_id, at DESC);
  `);

  // Migrations (rodam depois do CREATE TABLE acima — cliente novo já tem a tabela essa altura,
  // então o ADD COLUMN funciona; antes rodava antes de criar a tabela e o ALTER falhava sempre
  // em cliente nunca usado, deixando connection_id/wamid/delivery_status/delivery_error faltando).
  try { sqlite.exec('ALTER TABLE schedules ADD COLUMN connection_id TEXT'); } catch {}
  try { sqlite.exec('ALTER TABLE schedules ADD COLUMN template_payload TEXT'); } catch {}
  try { sqlite.exec('ALTER TABLE logs ADD COLUMN connection_id TEXT'); } catch {}
  try { sqlite.exec('ALTER TABLE messages ADD COLUMN connection_id TEXT DEFAULT \'web\''); } catch {}
  try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_messages_conn ON messages(connection_id)'); } catch {}
  try { sqlite.exec('ALTER TABLE messages ADD COLUMN wamid TEXT'); } catch {}
  try { sqlite.exec('ALTER TABLE messages ADD COLUMN reaction TEXT'); } catch {}
  try { sqlite.exec('ALTER TABLE messages ADD COLUMN delivery_status TEXT'); } catch {}
  try { sqlite.exec('ALTER TABLE messages ADD COLUMN delivery_error TEXT'); } catch {}
  try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages(wamid)'); } catch {}
  // Migration: add phone to consultants (envio direto pro WhatsApp do vendedor da vez)
  try { sqlite.exec('ALTER TABLE consultants ADD COLUMN phone TEXT'); } catch {}

  // Migration: add new columns to known_contacts for existing databases
  for (const col of ['wa_id TEXT', 'phone TEXT', 'country_code TEXT', 'username TEXT', 'phone_number_id TEXT', 'waba_id TEXT',
                     'bot_paused INTEGER DEFAULT 0', 'needs_human INTEGER DEFAULT 0', 'needs_human_reason TEXT', 'bot_last_rule TEXT',
                     'bot_funnel TEXT', 'bot_step INTEGER', 'bot_step_id TEXT',
                     'bot_waiting_since INTEGER', 'bot_followup_done INTEGER DEFAULT 0', 'bot_conn TEXT',
                     'archived INTEGER DEFAULT 0', 'archived_at INTEGER', 'last_read_at INTEGER DEFAULT 0']) {
    try { sqlite.prepare(`ALTER TABLE known_contacts ADD COLUMN ${col}`).run(); } catch {}
  }
  // Migration: add has_new_message to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN has_new_message INTEGER DEFAULT 0').run(); } catch {}
  try { sqlite.prepare('ALTER TABLE funnels ADD COLUMN chat_connection_id TEXT').run(); } catch {}
  // Migration: add estado to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN estado TEXT').run(); } catch {}
  // Migration: add cidade to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN cidade TEXT').run(); } catch {}
  // Migration: add email to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN email TEXT').run(); } catch {}
  // Migration: add contato (pessoa que atende dentro da empresa) to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN contato TEXT').run(); } catch {}
  // Migration: add callback_at (lead marcado como 'chamar novamente') to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN callback_at INTEGER').run(); } catch {}
  // Migration: add callback_reason (motivo do 'chamar novamente') to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN callback_reason TEXT').run(); } catch {}
  // Migration: add whatsapp to crm_cards
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN whatsapp TEXT').run(); } catch {}
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN custom_fields TEXT').run(); } catch {}
  // Migration: dono do lead (id de login do usuario que atende)
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN owner TEXT').run(); } catch {}
  // Migration: valor do negocio (usado como valor da conversao no Meta)
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN valor REAL').run(); } catch {}
  // Migration: id do clique do anuncio Click-to-WhatsApp (amarra o lead ao anuncio)
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN ctwa_clid TEXT').run(); } catch {}
  // Migration: eventos ja reportados ao Meta, pra nao duplicar conversao
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN meta_reported TEXT').run(); } catch {}
  // Migration: identificadores do navegador vindos do site (cookies _fbc e _fbp)
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN fbc TEXT').run(); } catch {}
  try { sqlite.prepare('ALTER TABLE crm_cards ADD COLUMN fbp TEXT').run(); } catch {}

  // Migration: crm_comments and crm_files tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS crm_comments (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL, author TEXT, text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_comments_card ON crm_comments(card_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS crm_files (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL, name TEXT NOT NULL,
      url TEXT NOT NULL, mime TEXT, size INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_files_card ON crm_files(card_id, created_at DESC);
  `);
  // Migration: add paid to fin_income / fin_expenses
  try { sqlite.prepare('ALTER TABLE fin_income ADD COLUMN paid INTEGER DEFAULT 0').run(); } catch {}
  try { sqlite.prepare('ALTER TABLE fin_expenses ADD COLUMN paid INTEGER DEFAULT 0').run(); } catch {}
  try { sqlite.prepare("ALTER TABLE crm_cards ADD COLUMN idioma TEXT DEFAULT ''").run(); } catch {}
  try { sqlite.prepare("ALTER TABLE crm_cards ADD COLUMN pais TEXT DEFAULT ''").run(); } catch {}

  // Financeiro
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fin_months (
      id TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000),
      UNIQUE(year, month)
    );
    CREATE TABLE IF NOT EXISTS fin_income (
      id TEXT PRIMARY KEY,
      month_id TEXT NOT NULL,
      client_name TEXT DEFAULT '',
      to_receive REAL DEFAULT 0,
      received REAL DEFAULT 0,
      received_date TEXT DEFAULT '',
      budget REAL DEFAULT 0,
      next_month INTEGER DEFAULT 0,
      row_order INTEGER DEFAULT 0,
      FOREIGN KEY (month_id) REFERENCES fin_months(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS fin_expenses (
      id TEXT PRIMARY KEY,
      month_id TEXT NOT NULL,
      category TEXT NOT NULL,
      name TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      due_day INTEGER DEFAULT 0,
      row_order INTEGER DEFAULT 0,
      FOREIGN KEY (month_id) REFERENCES fin_months(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS fin_distribution (
      id TEXT PRIMARY KEY,
      month_id TEXT NOT NULL UNIQUE,
      entrada REAL DEFAULT 0,
      p1_label TEXT DEFAULT 'WAGNER',
      p1_pct REAL DEFAULT 50,
      p2_label TEXT DEFAULT 'FRAN',
      p2_pct REAL DEFAULT 50,
      lazer_pct REAL DEFAULT 25,
      invest_pct REAL DEFAULT 25,
      FOREIGN KEY (month_id) REFERENCES fin_months(id) ON DELETE CASCADE
    );
  `);

  const j = (v) => JSON.stringify(v);
  const p = (v) => { try { return JSON.parse(v); } catch { return v; } };
  const looksLikeIdentifier = (v) => {
    const s = String(v || '').trim();
    return !s || /@(s\.whatsapp\.net|c\.us|g\.us|lid)$/.test(s) || /^\d{10,}$/.test(s);
  };

  const normalizeReportFilters = (filters = {}) => {
    const from = Number(filters.from) || 0;
    const to = Number(filters.to) || 0;
    const type = ['group', 'contact'].includes(filters.type) ? filters.type : 'all';
    const search = String(filters.search || '').trim().toLowerCase();
    return { from, to, type, search };
  };
  const isGroupRecipient = (id, type) => String(type || '').toLowerCase() === 'group' || String(id || '').endsWith('@g.us');
  const dateBucket = (ts) => {
    const d = new Date(Number(ts) || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const displayDay = (ts) => new Date(Number(ts) || Date.now()).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const applyReportFilters = (items, filters, timestampKey = 'sentAt') => {
    const f = normalizeReportFilters(filters);
    return items.filter(item => {
      const ts = Number(item[timestampKey]) || 0;
      if (f.from && ts < f.from) return false;
      if (f.to && ts > f.to) return false;
      const isGroup = isGroupRecipient(item.recipientId, item.recipientType);
      if (f.type === 'group' && !isGroup) return false;
      if (f.type === 'contact' && isGroup) return false;
      if (f.search) {
        const haystack = `${item.recipientName || ''} ${item.recipientId || ''}`.toLowerCase();
        if (!haystack.includes(f.search)) return false;
      }
      return true;
    });
  };

  function rowToSchedule(r) {
    if (!r) return null;
    return { id: r.id, recipientType: r.recipient_type, recipientId: r.recipient_id, recipientName: r.recipient_name, message: r.message, scheduledFor: r.scheduled_for, documentPath: r.document_path, documentName: r.document_name, quickReplies: p(r.quick_replies) || [], bulkId: r.bulk_id, retryCount: r.retry_count || 0, lastAttemptError: r.last_attempt_error, lastAttemptAt: r.last_attempt_at, createdAt: r.created_at, connectionId: r.connection_id || null, templatePayload: p(r.template_payload) || null };
  }

  function rowToLog(r) {
    if (!r) return null;
    return { id: r.id, scheduleId: r.schedule_id, recipientType: r.recipient_type, recipientId: r.recipient_id, recipientName: r.recipient_name, message: r.message, quickReplies: p(r.quick_replies) || [], documentName: r.document_name, documentPath: r.document_path, success: !!r.success, error: r.error, sentAt: r.sent_at, connectionId: r.connection_id || null };
  }

  function rowToCard(r) {
    if (!r) return null;
    return { id: r.id, columnId: r.column_id, funnelId: r.funnel_id, contactName: r.contact_name, phone: r.phone, whatsappId: r.whatsapp_id, instagram: r.instagram, site: r.site, label: r.label, labels: p(r.labels) || [], checks: p(r.checks) || { firstMessage: false, followedOnInsta: false, commented: false }, notes: r.notes, estado: r.estado || '', cidade: r.cidade || '', contato: r.contato || '', callbackAt: r.callback_at || null, callbackReason: r.callback_reason || '', email: r.email || '', whatsapp: r.whatsapp || '', customFields: p(r.custom_fields) || {}, owner: r.owner || '', valor: (r.valor === null || r.valor === undefined) ? null : Number(r.valor), ctwaClid: r.ctwa_clid || '', fbc: r.fbc || '', fbp: r.fbp || '', metaReported: p(r.meta_reported) || {}, idioma: r.idioma || '', pais: r.pais || '', createdAt: r.created_at, updatedAt: r.updated_at, hasNewMessage: !!r.has_new_message };
  }

  const api = {
    getConfig() {
      const rows = sqlite.prepare('SELECT key, value FROM config').all();
      const cfg = {};
      for (const r of rows) { try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; } }
      return cfg;
    },

    updateConfig(fields) {
      const stmt = sqlite.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
      sqlite.transaction(() => { for (const [k, v] of Object.entries({ ...fields, updatedAt: Date.now() })) stmt.run(k, JSON.stringify(v)); })();
      return this.getConfig();
    },

    // ─── Schedules ────────────────────────────────────────────
    createSchedule({ recipientType, recipientId, recipientName, message, scheduledFor, documentPath, documentName, quickReplies, bulkId, connectionId, templatePayload }) {
      // Date.now() sozinho colide quando varios agendamentos nascem no mesmo milissegundo
      // (disparo em lote). Contador monotonico: continua numerico e ordenavel.
      const id = String(nextScheduleId());
      sqlite.prepare('INSERT INTO schedules (id,recipient_type,recipient_id,recipient_name,message,scheduled_for,document_path,document_name,quick_replies,bulk_id,retry_count,created_at,connection_id,template_payload) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?)').run(id, recipientType || 'group', recipientId, recipientName, message, scheduledFor, documentPath || null, documentName || null, j(quickReplies || []), bulkId || null, Date.now(), connectionId || null, templatePayload ? j(templatePayload) : null);
      return id;
    },

    getSchedules() {
      return sqlite.prepare('SELECT * FROM schedules WHERE scheduled_for > ? ORDER BY scheduled_for ASC').all(Date.now()).map(rowToSchedule);
    },

    getPendingSchedules() {
      return sqlite.prepare('SELECT * FROM schedules WHERE scheduled_for <= ? ORDER BY scheduled_for ASC').all(Date.now()).map(rowToSchedule);
    },

    getScheduleById(id) {
      return rowToSchedule(sqlite.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
    },

    getLogById(id) {
      return rowToLog(sqlite.prepare('SELECT * FROM logs WHERE id = ?').get(id));
    },

    updateSchedule(id, fields) {
      if (!sqlite.prepare('SELECT id FROM schedules WHERE id = ?').get(id)) return false;
      const colMap = { recipientType: 'recipient_type', recipientId: 'recipient_id', recipientName: 'recipient_name', scheduledFor: 'scheduled_for', documentPath: 'document_path', documentName: 'document_name', quickReplies: 'quick_replies', bulkId: 'bulk_id', retryCount: 'retry_count', connectionId: 'connection_id' };
      const sets = []; const vals = [];
      for (const [k, v] of Object.entries(fields)) { sets.push(`${colMap[k] || k} = ?`); vals.push(typeof v === 'object' && v !== null ? j(v) : v); }
      sqlite.prepare(`UPDATE schedules SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
      return true;
    },

    rescheduleAfterFailure(id, { scheduledFor, error }) {
      const r = sqlite.prepare('SELECT retry_count FROM schedules WHERE id = ?').get(id);
      if (!r) return false;
      sqlite.prepare('UPDATE schedules SET scheduled_for=?,retry_count=?,last_attempt_error=?,last_attempt_at=?,updated_at=? WHERE id=?').run(scheduledFor, (r.retry_count || 0) + 1, error || null, Date.now(), Date.now(), id);
      return true;
    },

    deleteSchedule(id) { sqlite.prepare('DELETE FROM schedules WHERE id = ?').run(id); },

    markSent(id, success, error = null) {
      const s = rowToSchedule(sqlite.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
      sqlite.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      if (s) {
        sqlite.prepare('INSERT INTO logs (id,schedule_id,recipient_type,recipient_id,recipient_name,message,quick_replies,document_name,document_path,success,error,sent_at,connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(Date.now().toString(), s.id, s.recipientType, s.recipientId, s.recipientName, s.message, j(s.quickReplies), s.documentName, s.documentPath, success ? 1 : 0, error, Date.now(), s.connectionId || null);
        sqlite.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY sent_at DESC LIMIT 200)').run();
      }
    },

    appendLog(source, success, error = null) {
      const logId = Date.now().toString();
      sqlite.prepare('INSERT INTO logs (id,schedule_id,recipient_type,recipient_id,recipient_name,message,quick_replies,document_name,document_path,success,error,sent_at,connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(logId, source.id || source.scheduleId || null, source.recipientType || 'group', source.recipientId, source.recipientName, source.message, j(source.quickReplies || []), source.documentName || null, source.documentPath || null, success ? 1 : 0, error, Date.now(), source.connectionId || null);
      sqlite.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY sent_at DESC LIMIT 200)').run();
      return rowToLog(sqlite.prepare('SELECT * FROM logs WHERE id = ?').get(logId));
    },

    getLogs() { return sqlite.prepare('SELECT * FROM logs ORDER BY sent_at DESC').all().map(rowToLog); },

    getRecentSuccessLogs(windowMs = 24 * 60 * 60 * 1000) {
      return sqlite.prepare('SELECT * FROM logs WHERE success=1 AND sent_at > ? ORDER BY sent_at DESC').all(Date.now() - windowMs).map(rowToLog);
    },

    getRecentLogsForRecipient(recipientId, withinMs = 7 * 24 * 60 * 60 * 1000) {
      return sqlite.prepare('SELECT * FROM logs WHERE success=1 AND recipient_id=? AND sent_at>=? ORDER BY sent_at DESC').all(recipientId, Date.now() - withinMs).map(rowToLog).filter(l => l.quickReplies?.length > 0);
    },

    // ─── Responses ───────────────────────────────────────────
    recordResponse({ scheduleId, senderId, senderName, recipientId, recipientName, reply, matchedButton, responseTimeMs }) {
      sqlite.prepare('INSERT INTO responses (id,schedule_id,sender_id,sender_name,recipient_id,recipient_name,reply,matched_button,response_time_ms,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(Date.now().toString(), scheduleId, senderId, senderName, recipientId, recipientName, reply, matchedButton, responseTimeMs, Date.now());
      sqlite.prepare('DELETE FROM responses WHERE id NOT IN (SELECT id FROM responses ORDER BY received_at DESC LIMIT 500)').run();
    },

    // ─── Mensagens / Chat ────────────────────────────────────
    recordMessage({ direction, contactId, contactName, text, scheduleId, mediaUrl, mediaType, mediaName, connectionId, waId, phone, countryCode, username, phoneNumberId, wabaId, wamid, deliveryStatus }) {
      if (contactId) {
        const existing = sqlite.prepare('SELECT id, name FROM known_contacts WHERE id = ?').get(contactId);
        if (!existing) {
          sqlite.prepare('INSERT INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count,wa_id,phone,country_code,username,phone_number_id,waba_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(contactId, contactName || contactId, Date.now(), Date.now(), direction === 'in' ? 1 : 0, waId||null, phone||null, countryCode||null, username||null, phoneNumberId||null, wabaId||null);
        } else {
          const sets = ['last_seen_at = ?']; const vals = [Date.now()];
          if (direction === 'in') sets.push('message_count = message_count + 1');
          if (contactName && contactName !== 'Você' && (looksLikeIdentifier(existing.name) || !looksLikeIdentifier(contactName))) { sets.push('name = ?'); vals.push(contactName); }
          if (waId)          { sets.push('wa_id = ?');          vals.push(waId); }
          if (phone)         { sets.push('phone = ?');          vals.push(phone); }
          if (countryCode)   { sets.push('country_code = ?');   vals.push(countryCode); }
          if (username)      { sets.push('username = ?');       vals.push(username); }
          if (phoneNumberId) { sets.push('phone_number_id = ?');vals.push(phoneNumberId); }
          if (wabaId)        { sets.push('waba_id = ?');        vals.push(wabaId); }
          sqlite.prepare(`UPDATE known_contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, contactId);
        }
      }
      const normalizedText = String(text || '').slice(0, 2000);
      const dup = sqlite.prepare('SELECT id FROM messages WHERE direction=? AND contact_id=? AND timestamp>? AND text=?').get(direction, contactId, Date.now() - 15000, normalizedText);
      if (dup) return;
      sqlite.prepare('INSERT INTO messages (id,direction,contact_id,contact_name,text,media_url,media_type,media_name,schedule_id,timestamp,connection_id,wamid,delivery_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, direction, contactId, contactName || contactId, normalizedText, mediaUrl || null, mediaType || null, mediaName || null, scheduleId || null, Date.now(), connectionId || 'web', wamid || null, deliveryStatus || null);
      const totalMsgs = sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n;
      if (totalMsgs > MESSAGES_SAFETY_CAP) {
        sqlite.prepare(`INSERT OR IGNORE INTO messages_archive (${MESSAGES_COLS}) SELECT ${MESSAGES_COLS} FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY timestamp DESC LIMIT ${MESSAGES_SAFETY_CAP})`).run();
        sqlite.prepare(`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY timestamp DESC LIMIT ${MESSAGES_SAFETY_CAP})`).run();
      }
    },

    // Retenção "de verdade": mensagens mais velhas que N dias saem de messages e vão pra
    // messages_archive (nunca são descartadas). Roda 1x/dia via cron em server.js.
    archiveOldMessagesOlderThan(days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      sqlite.prepare(`INSERT OR IGNORE INTO messages_archive (${MESSAGES_COLS}) SELECT ${MESSAGES_COLS} FROM messages WHERE timestamp < ?`).run(cutoff);
      const info = sqlite.prepare('DELETE FROM messages WHERE timestamp < ?').run(cutoff);
      return info.changes;
    },

    // VACUUM na MESMA conexão que o app já usa (nunca abrir um segundo handle pro mesmo
    // arquivo por fora — WAL não impede, mas dois processos disputando o mesmo VACUUM é
    // receita pra "database is locked"). PRAGMA optimize primeiro: atualiza as estatísticas
    // do planner de consultas, é barato e o próprio SQLite recomenda rodar periodicamente.
    vacuum() {
      sqlite.exec('PRAGMA optimize');
      sqlite.exec('VACUUM');
    },

    // Existe alguma mensagem com esse wamid? (de-dup do backfill da Lite)
    messageExistsByWamid(wamid) {
      if (!wamid) return false;
      return !!sqlite.prepare('SELECT 1 FROM messages WHERE wamid = ? LIMIT 1').get(wamid);
    },
    // Atualiza o status de entrega de uma mensagem enviada (correlaciona pelo wamid retornado pela Meta)
    updateMessageDeliveryByWamid(wamid, status, errorText) {
      if (!wamid) return false;
      const row = sqlite.prepare('SELECT id, delivery_status FROM messages WHERE wamid = ? ORDER BY timestamp DESC LIMIT 1').get(wamid);
      if (!row) return false;
      // Nao rebaixa status (read -> delivered nao acontece); mas failed sempre prevalece
      const rank = { sent: 1, delivered: 2, read: 3, played: 4 };
      if (status !== 'failed' && row.delivery_status && rank[row.delivery_status] >= (rank[status] || 0)) return false;
      sqlite.prepare('UPDATE messages SET delivery_status = ?, delivery_error = ? WHERE wamid = ?').run(status, errorText || null, wamid);
      return true;
    },

    saveLidMapping(lid, phoneJid) {
      sqlite.prepare('INSERT OR REPLACE INTO lid_map (lid, phone_jid, updated_at) VALUES (?,?,?)').run(lid, phoneJid, Date.now());
    },

    resolveLid(lid) {
      return sqlite.prepare('SELECT phone_jid FROM lid_map WHERE lid=?').get(lid)?.phone_jid || null;
    },

    getAllLidMappings() {
      return sqlite.prepare('SELECT lid, phone_jid, updated_at FROM lid_map ORDER BY updated_at DESC').all();
    },

    updateContactPic(contactId, profilePicUrl) {
      if (!sqlite.prepare('SELECT id FROM known_contacts WHERE id = ?').get(contactId)) sqlite.prepare('INSERT INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count) VALUES (?,?,?,?,0)').run(contactId, contactId, Date.now(), Date.now());
      sqlite.prepare('UPDATE known_contacts SET profile_pic_url=?, profile_pic_fetched_at=? WHERE id=?').run(profilePicUrl, Date.now(), contactId);
    },

    getKnownContactsWithPics() {
      return sqlite.prepare("SELECT id, phone, profile_pic_url FROM known_contacts WHERE profile_pic_url IS NOT NULL AND profile_pic_url != ''").all();
    },

    updateContactName(contactId, name) {
      const clean = String(name || '').trim();
      if (!contactId || !clean) return null;
      const existing = sqlite.prepare('SELECT id FROM known_contacts WHERE id = ?').get(contactId);
      if (!existing) sqlite.prepare('INSERT INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count) VALUES (?,?,?,?,0)').run(contactId, clean, Date.now(), Date.now());
      else sqlite.prepare('UPDATE known_contacts SET name=?, last_seen_at=? WHERE id=?').run(clean, Date.now(), contactId);
      sqlite.prepare('UPDATE messages SET contact_name=? WHERE contact_id=?').run(clean, contactId);
      return { contactId, contactName: clean };
    },

    upsertChatConversation({ contactId, contactName, text }) {
      if (!contactId) return;
      const now = Date.now();
      const name = contactName || contactId;
      const existing = sqlite.prepare('SELECT id FROM known_contacts WHERE id = ?').get(contactId);
      if (!existing) sqlite.prepare('INSERT INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count) VALUES (?,?,?,?,0)').run(contactId, name, now, now);
      else sqlite.prepare('UPDATE known_contacts SET name=?, last_seen_at=? WHERE id=?').run(name, now, contactId);

      const hasMessage = sqlite.prepare('SELECT id FROM messages WHERE contact_id=? LIMIT 1').get(contactId);
      if (!hasMessage) {
        sqlite.prepare('INSERT INTO messages (id,direction,contact_id,contact_name,text,timestamp) VALUES (?,?,?,?,?,?)').run(`${now}-${Math.random().toString(36).slice(2, 7)}`, 'system', contactId, name, text || 'Conversa sincronizada', now);
      }
    },

    getConversations(connectionId, opts) {
      const where = connectionId ? `AND m.connection_id = '${connectionId.replace(/'/g, '')}'` : '';
      const archivedOnly = !!(opts && opts.archivedOnly);
      const archivedFilter = archivedOnly ? 'AND kc.archived = 1' : 'AND (kc.archived IS NULL OR kc.archived = 0)';
      return sqlite.prepare(`
        SELECT m.contact_id, m.contact_name, m.text, m.timestamp, m.direction, m.media_type, m.connection_id,
               kc.name as kc_name, kc.profile_pic_url, kc.phone as kc_phone, kc.username as kc_username,
               kc.needs_human as kc_needs_human, kc.bot_paused as kc_bot_paused, kc.archived as kc_archived, kc.archived_at as kc_archived_at,
               (SELECT COUNT(*) FROM messages m2 WHERE m2.contact_id = m.contact_id AND m2.direction = 'in' AND m2.timestamp > COALESCE(kc.last_read_at, 0) ${where.replace(/m\./g, 'm2.')}) as unread_count
        FROM messages m
        LEFT JOIN known_contacts kc ON kc.id = m.contact_id
        WHERE m.timestamp = (SELECT MAX(timestamp) FROM messages WHERE contact_id = m.contact_id ${where})
        ${where} ${archivedFilter}
        GROUP BY m.contact_id ORDER BY m.timestamp DESC
      `).all().map(r => {
        const isIdentifier = (v) => {
          const s = String(v || '').trim();
          return !s || /@(s\.whatsapp\.net|c\.us|g\.us|lid)$/.test(s) || /^\d{10,}$/.test(s);
        };
        const stripJid = (v) => String(v || '').replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '').replace(/@g\.us$/, '');
        // Priority: kc.username > kc.name (if real) > message contact_name (if real) > kc.phone > stripped contact_id
        const kcName = r.kc_name && !isIdentifier(r.kc_name) ? r.kc_name : null;
        const msgName = r.contact_name && !isIdentifier(r.contact_name) ? r.contact_name : null;
        const rawName = r.kc_username || kcName || msgName || r.kc_phone || r.kc_name || r.contact_name || r.contact_id;
        const contactName = stripJid(rawName);
        return { contactId: r.contact_id, contactName, lastMessage: r.text || (r.media_type === 'audio' ? '[audio]' : (r.media_type ? `[${r.media_type}]` : '')), lastAt: r.timestamp, direction: r.direction, profilePicUrl: r.profile_pic_url || null, connectionId: r.connection_id || 'web', needsHuman: !!r.kc_needs_human, botPaused: !!r.kc_bot_paused, archived: !!r.kc_archived, archivedAt: r.kc_archived_at || null, unreadCount: r.unread_count || 0 };
      });
    },

    // Marca um contato (não um card do CRM) como lido — zera a contagem de não lidas
    // real usada no badge do Chat ao vivo. Cria known_contacts se ainda não existir.
    markContactRead(contactId) {
      if (!contactId) return;
      this.ensureKnownContact(contactId, contactId);
      sqlite.prepare('UPDATE known_contacts SET last_read_at = ? WHERE id = ?').run(Date.now(), contactId);
    },

    // "Marcar como não lida" (igual o WhatsApp): não zera o histórico todo, só volta o
    // ponteiro de leitura pra antes da ÚLTIMA mensagem recebida — daí o badge mostra a
    // conversa como pendente de novo, sem inflar a contagem com o histórico inteiro.
    markContactUnread(contactId) {
      if (!contactId) return;
      const lastIn = sqlite.prepare("SELECT MAX(timestamp) as t FROM messages WHERE contact_id = ? AND direction = 'in'").get(contactId);
      const ts = (lastIn && lastIn.t) ? lastIn.t - 1 : 0;
      this.ensureKnownContact(contactId, contactId);
      sqlite.prepare('UPDATE known_contacts SET last_read_at = ? WHERE id = ?').run(ts, contactId);
    },

    getArchivedContactIds() {
      return sqlite.prepare('SELECT id FROM known_contacts WHERE archived = 1').all().map(r => r.id);
    },

    getMessages(contactId) {
      const rows = contactId
        ? sqlite.prepare('SELECT * FROM messages WHERE contact_id=? ORDER BY timestamp DESC LIMIT 200').all(contactId)
        : sqlite.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 200').all();
      return rows.reverse().map(r => ({ id: r.id, direction: r.direction, contactId: r.contact_id, contactName: r.contact_name, text: r.text, mediaUrl: r.media_url, mediaType: r.media_type, mediaName: r.media_name, scheduleId: r.schedule_id, timestamp: r.timestamp, deliveryStatus: r.delivery_status || null, deliveryError: r.delivery_error || null, reaction: r.reaction || null }));
    },

    // Versão "crua" de 1 mensagem, com wamid e connection_id — getMessages() esconde esses
    // dois campos (não precisa deles pro chat renderizar), mas reagir a uma mensagem
    // precisa saber o wamid de verdade (o id interno nosso não serve pro WhatsApp) e por
    // qual canal ela chegou/saiu, pra reagir pelo mesmo canal.
    getMessageById(id) {
      const r = sqlite.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (!r) return null;
      return { id: r.id, direction: r.direction, contactId: r.contact_id, wamid: r.wamid || null, connectionId: r.connection_id || null };
    },

    // Anexa a reação na mensagem original (por wamid) — se não achar (mensagem não
    // guardada, ou reação em algo muito antigo), devolve false pra quem chamou decidir
    // se registra como uma mensagem avulsa em vez de simplesmente perder a informação.
    setMessageReaction(wamid, contactId, emoji) {
      if (!wamid) return false;
      const info = sqlite.prepare('UPDATE messages SET reaction=? WHERE wamid=? AND contact_id=?').run(emoji || null, wamid, contactId);
      return info.changes > 0;
    },

    // Conexão pela qual o CLIENTE chegou por último (última mensagem recebida).
    // Usado para responder pelo mesmo canal, evitando que Lite e API Oficial se misturem.
    getLastInboundConnection(contactId) {
      if (!contactId) return null;
      const row = sqlite.prepare("SELECT connection_id FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY timestamp DESC LIMIT 1").get(contactId);
      return row?.connection_id || null;
    },

    clearChatData() {
      sqlite.prepare('DELETE FROM messages').run();
      sqlite.prepare('DELETE FROM known_contacts').run();
    },

    deleteConversation(contactId) {
      sqlite.prepare('DELETE FROM messages WHERE contact_id = ?').run(contactId);
    },

    // Arquivar/desarquivar: some da lista principal, mas as mensagens continuam guardadas
    // (diferente de deleteConversation, que apaga tudo pra sempre).
    archiveConversation(contactId) {
      if (!contactId) return;
      if (!sqlite.prepare('SELECT id FROM known_contacts WHERE id = ?').get(contactId))
        sqlite.prepare('INSERT INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count) VALUES (?,?,?,?,0)').run(contactId, contactId, Date.now(), Date.now());
      sqlite.prepare('UPDATE known_contacts SET archived = 1, archived_at = ? WHERE id = ?').run(Date.now(), contactId);
    },
    unarchiveConversation(contactId) {
      sqlite.prepare('UPDATE known_contacts SET archived = 0, archived_at = NULL WHERE id = ?').run(contactId);
    },

    // ─── Estado do Auto Atendimento por contato ───────────────
    ensureKnownContact(contactId, name) {
      if (!contactId) return;
      if (!sqlite.prepare('SELECT id FROM known_contacts WHERE id = ?').get(contactId))
        sqlite.prepare('INSERT INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count) VALUES (?,?,?,?,0)').run(contactId, name || contactId, Date.now(), Date.now());
    },
    getContactBotState(contactId) {
      const r = sqlite.prepare('SELECT bot_paused, needs_human, needs_human_reason, bot_last_rule, bot_funnel, bot_step_id, message_count, bot_waiting_since, bot_conn FROM known_contacts WHERE id = ?').get(contactId);
      return { botPaused: !!(r && r.bot_paused), needsHuman: !!(r && r.needs_human), needsHumanReason: (r && r.needs_human_reason) || '', botLastRule: (r && r.bot_last_rule) || '', botFunnel: (r && r.bot_funnel) || '', botStepId: (r && r.bot_step_id) || '', messageCount: (r && r.message_count) || 0, botWaitingSince: (r && r.bot_waiting_since) || null, botConn: (r && r.bot_conn) || '' };
    },
    setBotFunnelStep(contactId, funnelId, stepId) {
      this.ensureKnownContact(contactId);
      sqlite.prepare('UPDATE known_contacts SET bot_funnel = ?, bot_step_id = ? WHERE id = ?').run(funnelId || null, stepId || null, contactId);
    },
    // Arma/limpa o "aguardando resposta" para o follow-up ("se não responder")
    setBotWaiting(contactId, since, conn) {
      this.ensureKnownContact(contactId);
      sqlite.prepare('UPDATE known_contacts SET bot_waiting_since = ?, bot_conn = ?, bot_followup_done = 0 WHERE id = ?').run(since || null, conn || null, contactId);
    },
    markFollowupDone(contactId) {
      sqlite.prepare('UPDATE known_contacts SET bot_followup_done = 1 WHERE id = ?').run(contactId);
    },
    // Contatos aguardando resposta do robô (candidatos a follow-up)
    listWaitingContacts() {
      return sqlite.prepare('SELECT id, bot_funnel, bot_step_id, bot_waiting_since, bot_conn FROM known_contacts WHERE bot_waiting_since IS NOT NULL AND bot_paused = 0 AND bot_followup_done = 0 AND bot_funnel IS NOT NULL').all()
        .map(r => ({ id: r.id, botFunnel: r.bot_funnel, botStepId: r.bot_step_id, botWaitingSince: r.bot_waiting_since, botConn: r.bot_conn || '' }));
    },
    setBotPaused(contactId, paused) {
      this.ensureKnownContact(contactId);
      sqlite.prepare('UPDATE known_contacts SET bot_paused = ? WHERE id = ?').run(paused ? 1 : 0, contactId);
    },
    setNeedsHuman(contactId, needs, reason) {
      this.ensureKnownContact(contactId);
      sqlite.prepare('UPDATE known_contacts SET needs_human = ?, needs_human_reason = ? WHERE id = ?').run(needs ? 1 : 0, needs ? (reason || '') : null, contactId);
    },
    setBotLastRule(contactId, ruleId) {
      this.ensureKnownContact(contactId);
      sqlite.prepare('UPDATE known_contacts SET bot_last_rule = ? WHERE id = ?').run(ruleId || null, contactId);
    },
    // Reativa o bot para o contato (limpa pausa, alerta e estado do funil)
    reactivateBot(contactId) {
      sqlite.prepare('UPDATE known_contacts SET bot_paused = 0, needs_human = 0, needs_human_reason = NULL, bot_funnel = NULL, bot_step_id = NULL, bot_waiting_since = NULL, bot_followup_done = 0, bot_conn = NULL WHERE id = ?').run(contactId);
    },
    listNeedsHuman() {
      return sqlite.prepare('SELECT id, name, needs_human_reason FROM known_contacts WHERE needs_human = 1').all()
        .map(r => ({ contactId: r.id, name: r.name, reason: r.needs_human_reason || '' }));
    },

    // Conta mensagens ENVIADAS (por nós) para um conjunto de contatos/grupos desde um timestamp.
    // Usado pelo termômetro de saúde da Área do Cliente ("contatei o cliente X vezes na semana").
    countOutboundMessagesSince(contactIds, sinceTs) {
      const ids = (Array.isArray(contactIds) ? contactIds : []).filter(Boolean);
      if (!ids.length) return { count: 0, lastAt: null };
      const ph = ids.map(() => '?').join(',');
      const row = sqlite.prepare(`SELECT COUNT(*) n, MAX(timestamp) last FROM messages WHERE direction='out' AND timestamp > ? AND contact_id IN (${ph})`).get(sinceTs, ...ids);
      return { count: (row && row.n) || 0, lastAt: (row && row.last) || null };
    },

    getNewContactsByDay(filters = {}) {
      const f = normalizeReportFilters(filters);
      const from = f.from || (Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = f.to || Date.now();
      const rows = sqlite.prepare('SELECT created_at FROM crm_cards WHERE created_at >= ? AND created_at <= ?').all(from, to);
      const byDay = {};
      for (const r of rows) {
        const iso = dateBucket(r.created_at);
        if (!byDay[iso]) byDay[iso] = { day: displayDay(r.created_at), count: 0 };
        byDay[iso].count++;
      }
      return Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([, item]) => item);
    },

    // ─── Funis ────────────────────────────────────────────────
    getFunnels() {
      let funnels = sqlite.prepare('SELECT * FROM funnels ORDER BY created_at ASC').all();
      if (funnels.length === 0) {
        const defaultId = 'default';
        sqlite.prepare('INSERT OR IGNORE INTO funnels (id,name,created_at,chat_connection_id) VALUES (?,?,?,?)').run(defaultId, 'Pipeline Principal', Date.now(), null);
        if (!sqlite.prepare('SELECT id FROM crm_columns WHERE funnel_id=?').get(defaultId)) {
          [['Novos Leads', 0], ['Em Contato', 1], ['Proposta Enviada', 2], ['Fechado', 3]].forEach(([name, order]) => {
            sqlite.prepare('INSERT OR IGNORE INTO crm_columns (id,funnel_id,name,col_order) VALUES (?,?,?,?)').run(String(order + 1), defaultId, name, order);
          });
        }
        funnels = sqlite.prepare('SELECT * FROM funnels ORDER BY created_at ASC').all();
      }
      return funnels.map(f => ({ id: f.id, name: f.name, createdAt: f.created_at, chatConnectionId: f.chat_connection_id || null }));
    },

    createFunnel(name, chatConnectionId = null) {
      const id = Date.now().toString();
      const createdAt = Date.now();
      sqlite.prepare('INSERT INTO funnels (id,name,created_at,chat_connection_id) VALUES (?,?,?,?)').run(id, name, createdAt, chatConnectionId || null);
      [['Novos Leads', 0], ['Em Contato', 1], ['Proposta Enviada', 2], ['Fechado', 3]].forEach(([n, order]) => {
        sqlite.prepare('INSERT INTO crm_columns (id,funnel_id,name,col_order) VALUES (?,?,?,?)').run(`${id}-${order}`, id, n, order);
      });
      return { id, name, createdAt, chatConnectionId: chatConnectionId || null };
    },

    updateFunnel(id, name, chatConnectionId) {
      const existing = sqlite.prepare('SELECT id FROM funnels WHERE id=?').get(id);
      if (!existing) return false;
      if (chatConnectionId === undefined) return sqlite.prepare('UPDATE funnels SET name=? WHERE id=?').run(name, id).changes > 0;
      return sqlite.prepare('UPDATE funnels SET name=?, chat_connection_id=? WHERE id=?').run(name, chatConnectionId || null, id).changes > 0;
    },

    deleteFunnel(id) {
      const colIds = sqlite.prepare('SELECT id FROM crm_columns WHERE funnel_id=?').all(id).map(c => c.id);
      if (colIds.length) sqlite.prepare(`DELETE FROM crm_cards WHERE column_id IN (${colIds.map(() => '?').join(',')})`).run(...colIds);
      sqlite.prepare('DELETE FROM crm_columns WHERE funnel_id=?').run(id);
      sqlite.prepare('DELETE FROM funnels WHERE id=?').run(id);
    },

    // ─── CRM Columns ──────────────────────────────────────────
    getCrmColumns(funnelId) {
      const rows = funnelId
        ? sqlite.prepare('SELECT * FROM crm_columns WHERE funnel_id=? ORDER BY col_order ASC').all(funnelId)
        : sqlite.prepare('SELECT * FROM crm_columns ORDER BY col_order ASC').all();
      return rows.map(r => ({ id: r.id, funnelId: r.funnel_id, name: r.name, order: r.col_order }));
    },

    createCrmColumn(name, funnelId) {
      const maxRow = sqlite.prepare('SELECT MAX(col_order) as max FROM crm_columns WHERE funnel_id=?').get(funnelId);
      const order = (maxRow?.max ?? -1) + 1;
      const id = Date.now().toString();
      sqlite.prepare('INSERT INTO crm_columns (id,funnel_id,name,col_order) VALUES (?,?,?,?)').run(id, funnelId, name, order);
      return { id, funnelId, name, order };
    },

    updateCrmColumn(id, name) { return sqlite.prepare('UPDATE crm_columns SET name=? WHERE id=?').run(name, id).changes > 0; },

    reorderCrmColumns(ids) {
      const update = sqlite.prepare('UPDATE crm_columns SET col_order=? WHERE id=?');
      sqlite.transaction(() => { ids.forEach((id, i) => update.run(i, id)); })();
    },

    deleteCrmColumn(id) {
      const col = sqlite.prepare('SELECT funnel_id FROM crm_columns WHERE id=?').get(id);
      sqlite.prepare('DELETE FROM crm_columns WHERE id=?').run(id);
      if (col) {
        const first = sqlite.prepare('SELECT id FROM crm_columns WHERE funnel_id=? ORDER BY col_order ASC LIMIT 1').get(col.funnel_id);
        if (first) sqlite.prepare('UPDATE crm_cards SET column_id=? WHERE column_id=?').run(first.id, id);
        else sqlite.prepare('UPDATE crm_cards SET column_id=NULL WHERE column_id=?').run(id);
      }
    },

    // ─── CRM Cards ────────────────────────────────────────────
    getCrmCards(funnelId) {
      const rows = funnelId
        ? sqlite.prepare('SELECT * FROM crm_cards WHERE funnel_id=?').all(funnelId)
        : sqlite.prepare('SELECT * FROM crm_cards').all();
      // enteredAt = quando o card entrou na coluna ATUAL (ultima entrada do historico).
      let enteredMap = null;
      try {
        const hist = sqlite.prepare('SELECT card_id, MAX(at) AS at FROM crm_card_column_history GROUP BY card_id').all();
        enteredMap = new Map(hist.map(h => [h.card_id, h.at]));
      } catch (e) { enteredMap = null; }
      return rows.map(r => { const c = rowToCard(r); if (enteredMap && enteredMap.has(c.id)) c.enteredAt = enteredMap.get(c.id); return c; });
    },

    // Versão enxuta pra cruzar conversa↔card (chat ao vivo): só as colunas usadas no
    // match por telefone, sem notes/customFields/checks etc. Usada pra buscar UMA VEZ
    // por requisição em vez de reconsultar a tabela inteira pra cada conversa da lista.
    getCrmCardsForMatching() {
      return sqlite.prepare('SELECT id, contact_name, phone, whatsapp, whatsapp_id, owner FROM crm_cards').all().map(r => ({
        id: r.id, contactName: r.contact_name, phone: r.phone, whatsapp: r.whatsapp, whatsappId: r.whatsapp_id, owner: r.owner,
      }));
    },

    findDuplicateCrmCards() {
      const cards = sqlite.prepare('SELECT * FROM crm_cards').all().map(rowToCard);
      const groups = new Map();
      const digits = v => String(v || '').replace(/\D/g, '');
      const norm = v => String(v || '').trim().toLowerCase();
      for (const card of cards) {
        const phoneKey = digits(card.phone) || digits(card.whatsapp) || digits(card.whatsappId);
        const nameKey = norm(card.contactName);
        if (!phoneKey && !nameKey) continue;
        const key = phoneKey ? `p:${phoneKey.slice(-9)}` : `n:${nameKey}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(card);
      }
      return [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
    },

    createCrmCard({ columnId, funnelId, contactName, phone, instagram, site, notes, label, labels, checks, whatsappId, estado, cidade, email, whatsapp }) {
      const resolvedFunnelId = funnelId || sqlite.prepare('SELECT funnel_id FROM crm_columns WHERE id=?').get(columnId)?.funnel_id || 'default';
      const id = Date.now().toString() + Math.random().toString(36).slice(2, 5);
      const now = Date.now();
      sqlite.prepare('INSERT INTO crm_cards (id,column_id,funnel_id,contact_name,phone,whatsapp_id,instagram,site,label,labels,checks,notes,estado,cidade,email,whatsapp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, columnId, resolvedFunnelId, contactName || '', String(phone || '').replace(/\D/g, ''), whatsappId || null, instagram || '', site || '', label || null, j(Array.isArray(labels) ? labels : (label ? [label] : [])), j(checks || { firstMessage: false, followedOnInsta: false, commented: false }), notes || '', estado || '', cidade || '', email || '', whatsapp || '', now, now);
      if (columnId) this.recordColumnEntry(id, resolvedFunnelId, null, columnId);
      return rowToCard(sqlite.prepare('SELECT * FROM crm_cards WHERE id=?').get(id));
    },

    // Grava 1 entrada no histórico de coluna. fromColumnId null = card nasceu direto nela.
    recordColumnEntry(cardId, funnelId, fromColumnId, toColumnId) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      sqlite.prepare('INSERT INTO crm_card_column_history (id, card_id, funnel_id, from_column_id, to_column_id, at) VALUES (?,?,?,?,?,?)').run(id, cardId, funnelId || null, fromColumnId || null, toColumnId, Date.now());
    },

    // Quantos cards entraram em cada coluna do funil num intervalo (ex: hoje) — 1 query
    // agrupada pra todas as colunas de uma vez, não uma por coluna nem uma por card.
    // Eventos de entrada numa coluna especifica, com o timestamp de cada um — usado pro
    // dashboard medir "quantas visitas foram agendadas e quanto tempo demorou ate agendar"
    // (cruza com crm_cards.created_at no server.js pra calcular o tempo de espera).
    // Ultima mensagem (qualquer direcao — enviada OU recebida) por contato, de TODAS as
    // conversas — usado pro disparo em massa poder filtrar por "ultima interacao" em vez
    // de "data que entrou na coluna" (as duas opcoes que o Wagnner pediu pra escolher).
    getLastMessageTimestamps() {
      return sqlite.prepare('SELECT contact_id as contactId, MAX(timestamp) as at FROM messages GROUP BY contact_id').all();
    },
    getColumnEntryEvents(columnId, fromTs, toTs) {
      return sqlite.prepare('SELECT card_id as cardId, at FROM crm_card_column_history WHERE to_column_id = ? AND at >= ? AND at < ? ORDER BY at ASC').all(columnId, fromTs, toTs);
    },
    // Timestamps de mensagens recebidas (inbound) num periodo — usado pro dashboard achar o
    // horario do dia que mais chega mensagem.
    getInboundMessageTimestamps(fromTs, toTs) {
      return sqlite.prepare("SELECT timestamp FROM messages WHERE direction='in' AND timestamp >= ? AND timestamp < ?").all(fromTs, toTs).map(r => r.timestamp);
    },
    getColumnEntryCounts(funnelId, fromTs, toTs) {
      const rows = sqlite.prepare('SELECT to_column_id as columnId, COUNT(*) as n FROM crm_card_column_history WHERE funnel_id = ? AND at >= ? AND at < ? GROUP BY to_column_id').all(funnelId, fromTs, toTs);
      const map = {};
      rows.forEach(r => { map[r.columnId] = r.n; });
      return map;
    },

    // De qual coluna esse card veio antes de chegar na atual (última transição registrada).
    getPreviousColumn(cardId) {
      // Desempata por rowid quando duas trocas caem no mesmo milissegundo (Date.now()
      // não é fino o suficiente pra 2 updates seguidos, ex: mover o card 2x rápido).
      const row = sqlite.prepare('SELECT from_column_id as fromColumnId, to_column_id as toColumnId, at FROM crm_card_column_history WHERE card_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(cardId);
      return (row && row.fromColumnId) ? row : null;
    },

    // Histórico completo de colunas de 1 card, já com quanto tempo ficou em cada uma
    // (calculado a partir do "at" da entrada seguinte, ou "agora" pra etapa atual).
    getCardColumnTimeline(cardId) {
      const rows = sqlite.prepare('SELECT from_column_id as fromColumnId, to_column_id as toColumnId, at FROM crm_card_column_history WHERE card_id = ? ORDER BY at ASC, rowid ASC').all(cardId);
      const now = Date.now();
      return rows.map((r, i) => ({ ...r, durationMs: (i + 1 < rows.length ? rows[i + 1].at : now) - r.at }));
    },

    recordCallEvent({ contactId, connectionId, wacallId, event, direction, status, duration, startedAt, endedAt }) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const now = Date.now();
      sqlite.prepare('INSERT INTO call_events (id,contact_id,connection_id,wacall_id,event,direction,status,duration,started_at,ended_at,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, contactId, connectionId || null, wacallId || null, event || '', direction || '', status || '', duration || null, startedAt || null, endedAt || null, now);
      return { id };
    },

    getCallEvents(contactId) {
      return sqlite.prepare('SELECT id, contact_id as contactId, connection_id as connectionId, wacall_id as wacallId, event, direction, status, duration, started_at as startedAt, ended_at as endedAt, at FROM call_events WHERE contact_id = ? ORDER BY at ASC').all(contactId);
    },

    // Resumo da conversa de 1 contato: 1ª e última mensagem, total de trocas, quantas de cada lado.
    getConversationStats(contactId) {
      const row = sqlite.prepare('SELECT MIN(timestamp) as firstAt, MAX(timestamp) as lastAt, COUNT(*) as total, SUM(CASE WHEN direction=\'in\' THEN 1 ELSE 0 END) as inCount, SUM(CASE WHEN direction=\'out\' THEN 1 ELSE 0 END) as outCount FROM messages WHERE contact_id = ?').get(contactId);
      return row || { firstAt: null, lastAt: null, total: 0, inCount: 0, outCount: 0 };
    },

    // Médias do funil num período: tempo médio (desde a criação do card) até entrar em
    // cada coluna + taxa de quantos cards do período chegaram lá, média de mensagens/duração
    // de conversa e média de ligações completas — tudo pros cards criados em [fromTs, toTs).
    getFunnelAverages(funnelId, fromTs, toTs) {
      const cards = sqlite.prepare('SELECT id, whatsapp_id as whatsappId, whatsapp, phone, created_at as createdAt FROM crm_cards WHERE funnel_id = ? AND created_at >= ? AND created_at < ?').all(funnelId, fromTs, toTs);
      const totalCards = cards.length;
      if (!totalCards) return { totalCards: 0, columns: [], conversation: null, calls: null };

      const cardIds = cards.map(c => c.id);
      const placeholders = cardIds.map(() => '?').join(',');
      const historyRows = sqlite.prepare(`SELECT card_id as cardId, to_column_id as toColumnId, MIN(at) as enteredAt FROM crm_card_column_history WHERE card_id IN (${placeholders}) GROUP BY card_id, to_column_id`).all(...cardIds);
      const createdByCard = new Map(cards.map(c => [c.id, c.createdAt]));
      const byColumn = new Map(); // columnId -> [deltaMs, ...]
      for (const r of historyRows) {
        const created = createdByCard.get(r.cardId);
        if (created == null) continue;
        const delta = r.enteredAt - created;
        if (delta < 0) continue;
        if (!byColumn.has(r.toColumnId)) byColumn.set(r.toColumnId, []);
        byColumn.get(r.toColumnId).push(delta);
      }
      const columns = [...byColumn.entries()].map(([columnId, deltas]) => ({
        columnId, reached: deltas.length, conversionRate: deltas.length / totalCards,
        avgMs: deltas.reduce((a, b) => a + b, 0) / deltas.length
      }));

      const contactIds = [...new Set(cards.map(c => c.whatsappId || (c.whatsapp || c.phone ? `${c.whatsapp || c.phone}@s.whatsapp.net` : null)).filter(Boolean))];
      let conversation = null, calls = null;
      if (contactIds.length) {
        const cph = contactIds.map(() => '?').join(',');
        const msgRows = sqlite.prepare(`SELECT contact_id as contactId, MIN(timestamp) as firstAt, MAX(timestamp) as lastAt, COUNT(*) as total FROM messages WHERE contact_id IN (${cph}) GROUP BY contact_id`).all(...contactIds);
        if (msgRows.length) {
          const withSpan = msgRows.filter(r => r.lastAt > r.firstAt);
          conversation = {
            contactsWithMessages: msgRows.length,
            avgMessages: msgRows.reduce((a, r) => a + r.total, 0) / msgRows.length,
            avgDurationMs: withSpan.length ? withSpan.reduce((a, r) => a + (r.lastAt - r.firstAt), 0) / withSpan.length : 0
          };
        }
        const callRows = sqlite.prepare(`SELECT contact_id as contactId, duration FROM call_events WHERE event='terminate' AND status != 'Failed' AND contact_id IN (${cph})`).all(...contactIds);
        if (callRows.length) {
          const contactsWithCall = new Set(callRows.map(r => r.contactId)).size;
          calls = {
            contactsWithCall, callRate: contactsWithCall / totalCards,
            avgDurationSec: callRows.reduce((a, r) => a + (r.duration || 0), 0) / callRows.length
          };
        } else {
          calls = { contactsWithCall: 0, callRate: 0, avgDurationSec: 0 };
        }
      }

      return { totalCards, columns, conversation, calls };
    },

    updateCrmCard(id, fields) {
      const existing = sqlite.prepare('SELECT * FROM crm_cards WHERE id=?').get(id);
      if (!existing) return null;
      const colMap = { columnId: 'column_id', funnelId: 'funnel_id', contactName: 'contact_name', whatsappId: 'whatsapp_id', ctwaClid: 'ctwa_clid', metaReported: 'meta_reported' };
      const sets = []; const vals = [];
      for (const [k, v] of Object.entries(fields)) {
        const col = colMap[k] || k.replace(/([A-Z])/g, '_$1').toLowerCase();
        let val = v;
        if (k === 'phone') val = String(v || '').replace(/\D/g, '');
        if (k === 'whatsappId' && !v) val = null;
        if (k === 'labels' || k === 'checks' || k === 'customFields' || k === 'metaReported') val = j(v);
        if (k === 'valor') val = (v === '' || v === null || v === undefined) ? null : Number(v);
        sets.push(`${col} = ?`); vals.push(val);
      }
      if (fields.columnId && fields.columnId !== existing.column_id) {
        this.recordColumnEntry(id, fields.funnelId || existing.funnel_id, existing.column_id, fields.columnId);
      }
      sqlite.prepare(`UPDATE crm_cards SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...vals, Date.now(), id);
      return rowToCard(sqlite.prepare('SELECT * FROM crm_cards WHERE id=?').get(id));
    },

    deleteCrmCard(id) {
      sqlite.prepare('DELETE FROM crm_cards WHERE id=?').run(id);
      sqlite.prepare('DELETE FROM crm_comments WHERE card_id=?').run(id);
      sqlite.prepare('DELETE FROM crm_files WHERE card_id=?').run(id);
    },

    getCrmComments(cardId) {
      return sqlite.prepare('SELECT * FROM crm_comments WHERE card_id=? ORDER BY created_at ASC').all(cardId);
    },
    addCrmComment(cardId, author, text) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const now = Date.now();
      sqlite.prepare('INSERT INTO crm_comments (id, card_id, author, text, created_at) VALUES (?,?,?,?,?)').run(id, cardId, author, text, now);
      return { id, cardId, author, text, createdAt: now };
    },
    deleteCrmComment(id) { sqlite.prepare('DELETE FROM crm_comments WHERE id=?').run(id); },

    getCrmFiles(cardId) {
      return sqlite.prepare('SELECT * FROM crm_files WHERE card_id=? ORDER BY created_at ASC').all(cardId);
    },
    addCrmFile(cardId, { name, url, mime, size }) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const now = Date.now();
      sqlite.prepare('INSERT INTO crm_files (id, card_id, name, url, mime, size, created_at) VALUES (?,?,?,?,?,?,?)').run(id, cardId, name, url, mime || '', size || 0, now);
      return { id, cardId, name, url, mime, size, createdAt: now };
    },
    deleteCrmFile(id) { sqlite.prepare('DELETE FROM crm_files WHERE id=?').run(id); },

    markCrmCardNewMessage(id) {
      sqlite.prepare('UPDATE crm_cards SET has_new_message=1, updated_at=? WHERE id=?').run(Date.now(), id);
    },
    clearCrmCardNewMessage(id) {
      sqlite.prepare('UPDATE crm_cards SET has_new_message=0 WHERE id=?').run(id);
    },

    recoverCrmLinks() {
      const orphans = sqlite.prepare("SELECT * FROM crm_cards WHERE (whatsapp_id IS NULL OR whatsapp_id = '') AND (phone IS NULL OR phone = '') AND contact_name != ''").all().map(rowToCard);
      let recovered = 0;
      for (const card of orphans) {
        const row = sqlite.prepare("SELECT contact_id FROM messages WHERE contact_name = ? AND contact_id NOT LIKE '%@g.us' ORDER BY timestamp DESC LIMIT 1").get(card.contactName);
        if (row?.contact_id) {
          sqlite.prepare('UPDATE crm_cards SET whatsapp_id=?, updated_at=? WHERE id=?').run(row.contact_id, Date.now(), card.id);
          recovered++;
        }
      }
      return { orphans: orphans.length, recovered };
    },

    getCrmReport() {
      const cards = sqlite.prepare('SELECT * FROM crm_cards').all().map(rowToCard);
      const cols = sqlite.prepare('SELECT * FROM crm_columns').all();
      const labels = { 'Em andamento': 0, 'Não respondeu': 0, 'Finalizado': 0, 'Sem label': 0 };
      const checks = { firstMessage: 0, followedOnInsta: 0, commented: 0 };
      const byColumn = {};
      cols.forEach(col => { byColumn[col.id] = { name: col.name, count: 0 }; });
      cards.forEach(card => {
        const lbl = card.label || 'Sem label';
        if (labels[lbl] !== undefined) labels[lbl]++; else labels['Sem label']++;
        if (card.checks?.firstMessage) checks.firstMessage++;
        if (card.checks?.followedOnInsta) checks.followedOnInsta++;
        if (card.checks?.commented) checks.commented++;
        if (byColumn[card.columnId]) byColumn[card.columnId].count++;
      });
      return { labels, checks, byColumn: Object.values(byColumn), total: cards.length };
    },

    // ─── Prospects ────────────────────────────────────────────
    getProspects() {
      return sqlite.prepare('SELECT * FROM prospects ORDER BY created_at DESC').all().map(r => ({ id: r.id, name: r.name, instagram: r.instagram, site: r.site, phone: r.phone, createdAt: r.created_at }));
    },

    createProspect({ name, instagram, site, phone }) {
      const id = Date.now().toString() + Math.random().toString(36).slice(2, 5);
      sqlite.prepare('INSERT INTO prospects (id,name,instagram,site,phone,created_at) VALUES (?,?,?,?,?,?)').run(id, name || '', instagram || '', site || '', String(phone || '').replace(/\D/g, ''), Date.now());
      return { id, name, instagram, site, phone };
    },

    bulkCreateProspects(list) {
      const insert = sqlite.prepare('INSERT INTO prospects (id,name,instagram,site,phone,created_at) VALUES (?,?,?,?,?,?)');
      return sqlite.transaction(() => {
        const now = Date.now();
        return list.map((p, i) => { const id = (now + i).toString() + Math.random().toString(36).slice(2, 5); insert.run(id, p.name || '', p.instagram || '', p.site || '', String(p.phone || '').replace(/\D/g, ''), now + i); return { id, ...p }; });
      })();
    },

    deleteProspect(id) { sqlite.prepare('DELETE FROM prospects WHERE id=?').run(id); },

    // ─── Consultores ──────────────────────────────────────────
    getConsultants() {
      return sqlite.prepare('SELECT * FROM consultants ORDER BY created_at ASC').all().map(r => ({ id: r.id, name: r.name, available: !!r.available, lastAssignedAt: r.last_assigned_at || 0, createdAt: r.created_at, phone: r.phone || '' }));
    },

    createConsultant(name, phone) {
      const id = Date.now().toString();
      sqlite.prepare('INSERT INTO consultants (id,name,available,last_assigned_at,created_at,phone) VALUES (?,?,1,0,?,?)').run(id, name, Date.now(), phone || '');
      return { id, name, available: true, lastAssignedAt: 0, createdAt: Date.now(), phone: phone || '' };
    },

    updateConsultant(id, fields) {
      const colMap = { lastAssignedAt: 'last_assigned_at' };
      const sets = []; const vals = [];
      for (const [k, v] of Object.entries(fields)) { const col = colMap[k] || k; sets.push(`${col} = ?`); vals.push(k === 'available' ? (v ? 1 : 0) : v); }
      if (!sets.length) return null;
      sqlite.prepare(`UPDATE consultants SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
      const r = sqlite.prepare('SELECT * FROM consultants WHERE id=?').get(id);
      return r ? { id: r.id, name: r.name, available: !!r.available, lastAssignedAt: r.last_assigned_at || 0, createdAt: r.created_at, phone: r.phone || '' } : null;
    },

    deleteConsultant(id) { sqlite.prepare('DELETE FROM consultants WHERE id=?').run(id); },

    assignNextConsultant() {
      const rows = sqlite.prepare('SELECT * FROM consultants WHERE available=1 ORDER BY last_assigned_at ASC, rowid ASC').all();
      if (!rows.length) return null;
      const next = rows[0];
      sqlite.prepare('UPDATE consultants SET last_assigned_at=? WHERE id=?').run(Date.now(), next.id);
      return { id: next.id, name: next.name, available: !!next.available, lastAssignedAt: next.last_assigned_at || 0, phone: next.phone || '' };
    },

    // ─── Relatório ────────────────────────────────────────────
    getReport(filters = {}) {
      const f = normalizeReportFilters(filters);
      const logs = applyReportFilters(sqlite.prepare('SELECT * FROM logs WHERE success=1 ORDER BY sent_at DESC').all().map(rowToLog), f, 'sentAt');
      const responsesRaw = sqlite.prepare('SELECT * FROM responses ORDER BY received_at DESC LIMIT 500').all().map(r => ({ id: r.id, scheduleId: r.schedule_id, senderId: r.sender_id, senderName: r.sender_name, recipientId: r.recipient_id, recipientName: r.recipient_name, reply: r.reply, matchedButton: r.matched_button, responseTimeMs: r.response_time_ms, receivedAt: r.received_at }));
      const recipientIds = new Set(logs.map(l => l.recipientId));
      const responses = responsesRaw.filter(r => {
        if (f.from && Number(r.receivedAt) < f.from) return false;
        if (f.to && Number(r.receivedAt) > f.to) return false;
        if ((f.type !== 'all' || f.search) && !recipientIds.has(r.recipientId)) return false;
        return true;
      });
      const totalSent = logs.length;
      const totalGroupSent = logs.filter(l => isGroupRecipient(l.recipientId, l.recipientType)).length;
      const totalContactSent = totalSent - totalGroupSent;
      const totalResponses = responses.length;
      const responseRate = totalSent > 0 ? Math.round((totalResponses / totalSent) * 100) : 0;
      const avgMs = responses.length > 0 ? responses.reduce((s, r) => s + (r.responseTimeMs || 0), 0) / responses.length : 0;
      const byDay = {};
      logs.forEach(l => {
        const iso = dateBucket(l.sentAt);
        if (!byDay[iso]) byDay[iso] = { day: displayDay(l.sentAt), count: 0 };
        byDay[iso].count++;
      });
      const sentByDay = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([, item]) => item);
      const byRecipient = {};
      logs.forEach(l => {
        if (!byRecipient[l.recipientId]) byRecipient[l.recipientId] = { id: l.recipientId, name: l.recipientName || l.recipientId, type: isGroupRecipient(l.recipientId, l.recipientType) ? 'group' : 'contact', sent: 0, responses: 0, totalMs: 0 };
        byRecipient[l.recipientId].sent++;
      });
      responses.forEach(r => { if (byRecipient[r.recipientId]) { byRecipient[r.recipientId].responses++; byRecipient[r.recipientId].totalMs += r.responseTimeMs || 0; } });
      const recipientList = Object.values(byRecipient).map(r => ({ ...r, rate: Math.round((r.responses / r.sent) * 100), avgTime: r.responses > 0 ? r.totalMs / r.responses : null })).sort((a, b) => b.sent - a.sent).slice(0, 100);
      return { totalSent, totalGroupSent, totalContactSent, totalResponses, responseRate, avgResponseTimeMs: avgMs, sentByDay, byRecipient: recipientList, recentResponses: responses.slice(0, 50) };
    }
  };

  // ─── Analytics de navegação / mapa de calor ─────────────────────────────────
  const heatmapApi = {
    ingestWebAnalytics(batch = {}) {
      const now = Date.now(), s = batch.session || {}, pv = batch.pageview || {};
      if (!s.id || !pv.id) return { accepted: 0 };
      const clean = v => String(v == null ? '' : v).slice(0, 1000);
      const device = clean(s.device).slice(0, 30), events = Array.isArray(batch.events) ? batch.events.slice(0, 100) : [];
      sqlite.prepare(`INSERT INTO web_sessions(id,visitor_id,started_at,last_at,entry_path,exit_path,referrer,device,browser,utm_source,utm_medium,utm_campaign,page_views,duration_ms,converted)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,0) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at,exit_path=excluded.exit_path,duration_ms=MAX(duration_ms,excluded.duration_ms)`).run(
        clean(s.id).slice(0,100), clean(s.visitorId).slice(0,100), Number(s.startedAt)||now, now, clean(pv.path).slice(0,500), clean(pv.path).slice(0,500), clean(pv.referrer).slice(0,1000), device, clean(s.browser).slice(0,50), clean(s.utmSource).slice(0,100), clean(s.utmMedium).slice(0,100), clean(s.utmCampaign).slice(0,150), Number(pv.duration)||0);
      const existed = sqlite.prepare('SELECT 1 FROM web_pageviews WHERE id=?').get(clean(pv.id).slice(0,100));
      sqlite.prepare(`INSERT INTO web_pageviews(id,session_id,visitor_id,url,path,title,referrer,started_at,last_at,duration_ms,viewport_w,viewport_h,document_h,max_scroll,snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at,duration_ms=MAX(duration_ms,excluded.duration_ms),document_h=MAX(document_h,excluded.document_h),max_scroll=MAX(max_scroll,excluded.max_scroll),snapshot=COALESCE(snapshot,excluded.snapshot)`).run(
        clean(pv.id).slice(0,100), clean(s.id).slice(0,100), clean(s.visitorId).slice(0,100), clean(pv.url), clean(pv.path).slice(0,500), clean(pv.title).slice(0,300), clean(pv.referrer), Number(pv.startedAt)||now, now, Number(pv.duration)||0, Number(pv.viewportW)||0, Number(pv.viewportH)||0, Number(pv.documentH)||0, Number(pv.maxScroll)||0, pv.snapshot ? String(pv.snapshot).slice(0,1500000) : null);
      if (!existed) sqlite.prepare('UPDATE web_sessions SET page_views=page_views+1 WHERE id=?').run(clean(s.id).slice(0,100));
      const ins = sqlite.prepare('INSERT OR IGNORE INTO web_events(event_id,session_id,pageview_id,type,at,x,y,scroll_pct,target,name,value_num,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      const tx = sqlite.transaction(() => events.forEach(ev => {
        const type = clean(ev.type).slice(0,30); if (!['click','scroll','mousemove','conversion','submit','route','resize'].includes(type)) return;
        ins.run(clean(ev.id).slice(0,100), clean(s.id).slice(0,100), clean(pv.id).slice(0,100), type, Number(ev.at)||now, Number(ev.x)||0, Number(ev.y)||0, Math.max(0,Math.min(100,Number(ev.scroll)||0)), clean(ev.target).slice(0,160), clean(ev.name).slice(0,100), Number(ev.value)||0, JSON.stringify(ev.data||{}).slice(0,2000));
        if (type === 'conversion' || type === 'submit') sqlite.prepare('UPDATE web_sessions SET converted=1 WHERE id=?').run(clean(s.id).slice(0,100));
      })); tx();
      return { accepted: events.length };
    },
    webAnalyticsReport({ from=0, to=Date.now(), path='' } = {}) {
      const args=[Number(from)||0,Number(to)||Date.now()], pathSql=path?' AND p.path=?':'', pArgs=path?[...args,path]:args;
      const summary=sqlite.prepare(`SELECT COUNT(DISTINCT s.id) sessions,COUNT(DISTINCT s.visitor_id) visitors,COALESCE(SUM(s.page_views),0) pageviews,COALESCE(AVG(s.duration_ms),0) avg_duration,COALESCE(SUM(s.converted),0) conversions FROM web_sessions s WHERE s.started_at BETWEEN ? AND ?`).get(...args);
      const pages=sqlite.prepare(`SELECT p.path,MIN(p.url) url,COUNT(*) views,COUNT(DISTINCT p.session_id) sessions,ROUND(AVG(p.duration_ms)) avg_duration,ROUND(AVG(p.max_scroll)) avg_scroll FROM web_pageviews p WHERE p.started_at BETWEEN ? AND ? GROUP BY p.path ORDER BY views DESC LIMIT 100`).all(...args);
      const clicks=sqlite.prepare(`SELECT e.x,e.y,e.target,COUNT(*) count FROM web_events e JOIN web_pageviews p ON p.id=e.pageview_id WHERE e.type='click' AND e.at BETWEEN ? AND ?${pathSql} GROUP BY ROUND(e.x,2),ROUND(e.y,2),e.target ORDER BY count DESC LIMIT 800`).all(...pArgs);
      const scroll=sqlite.prepare(`SELECT CASE WHEN max_scroll<25 THEN '0-25%' WHEN max_scroll<50 THEN '25-50%' WHEN max_scroll<75 THEN '50-75%' ELSE '75-100%' END bucket,COUNT(*) count FROM web_pageviews p WHERE p.started_at BETWEEN ? AND ?${pathSql} GROUP BY bucket`).all(...pArgs);
      const conversions=sqlite.prepare(`SELECT COALESCE(NULLIF(e.name,''),'Conversão') name,COUNT(*) count,COALESCE(SUM(e.value_num),0) value FROM web_events e JOIN web_pageviews p ON p.id=e.pageview_id WHERE e.type IN ('conversion','submit') AND e.at BETWEEN ? AND ?${pathSql} GROUP BY name ORDER BY count DESC`).all(...pArgs);
      const sources=sqlite.prepare(`SELECT COALESCE(NULLIF(utm_source,''),'Direto / referência') source,COUNT(*) sessions,SUM(converted) conversions FROM web_sessions WHERE started_at BETWEEN ? AND ? GROUP BY source ORDER BY sessions DESC LIMIT 30`).all(...args);
      const devices=sqlite.prepare(`SELECT COALESCE(NULLIF(device,''),'desktop') device,COUNT(*) count FROM web_sessions WHERE started_at BETWEEN ? AND ? GROUP BY device`).all(...args);
      const journeys=sqlite.prepare(`SELECT GROUP_CONCAT(path,' → ') journey,COUNT(*) count FROM (SELECT session_id,path FROM web_pageviews WHERE started_at BETWEEN ? AND ? ORDER BY session_id,started_at) GROUP BY session_id ORDER BY count DESC LIMIT 50`).all(...args);
      const sessions=sqlite.prepare(`SELECT s.*, (SELECT p.snapshot FROM web_pageviews p WHERE p.session_id=s.id ORDER BY p.started_at LIMIT 1) snapshot FROM web_sessions s WHERE s.started_at BETWEEN ? AND ? ORDER BY s.started_at DESC LIMIT 100`).all(...args);
      return { summary, pages, clicks, scroll, conversions, sources, devices, journeys, sessions };
    },
    webAnalyticsSession(id) {
      return { session: sqlite.prepare('SELECT * FROM web_sessions WHERE id=?').get(id), pages: sqlite.prepare('SELECT * FROM web_pageviews WHERE session_id=? ORDER BY started_at').all(id), events: sqlite.prepare('SELECT * FROM web_events WHERE session_id=? ORDER BY at LIMIT 5000').all(id) };
    },
    webAnalyticsPageSnapshot(pathname='') {
      const row = pathname ? sqlite.prepare('SELECT url,path,snapshot,viewport_w,viewport_h,document_h FROM web_pageviews WHERE path=? AND snapshot IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(pathname) : sqlite.prepare('SELECT url,path,snapshot,viewport_w,viewport_h,document_h FROM web_pageviews WHERE snapshot IS NOT NULL ORDER BY started_at DESC LIMIT 1').get();
      return row || null;
    },
    saveWebAnalyticsSnapshot(pageviewId, snapshot) {
      return sqlite.prepare('UPDATE web_pageviews SET snapshot=? WHERE id=? AND snapshot IS NULL').run(String(snapshot||'').slice(0,2000000), String(pageviewId||'').slice(0,100)).changes;
    },
    purgeWebAnalytics(days=90) { const cut=Date.now()-Math.max(7,Math.min(365,Number(days)||90))*86400000; sqlite.prepare('DELETE FROM web_events WHERE at<?').run(cut); sqlite.prepare('DELETE FROM web_pageviews WHERE started_at<?').run(cut); return sqlite.prepare('DELETE FROM web_sessions WHERE started_at<?').run(cut).changes; },
    clearWebAnalytics() { sqlite.exec('DELETE FROM web_events; DELETE FROM web_pageviews; DELETE FROM web_sessions;'); }
  };
  Object.assign(api, heatmapApi);

  // ─── Financeiro ──────────────────────────────────────────────────────────────
  const finApi = {
    listFinMonths() {
      return sqlite.prepare('SELECT * FROM fin_months ORDER BY year DESC, month DESC').all();
    },
    getOrCreateFinMonth(year, month) {
      const existing = sqlite.prepare('SELECT * FROM fin_months WHERE year=? AND month=?').get(year, month);
      if (existing) return existing;
      const id = `fin-${year}-${month}`;
      sqlite.prepare('INSERT OR IGNORE INTO fin_months (id, year, month) VALUES (?,?,?)').run(id, year, month);
      return sqlite.prepare('SELECT * FROM fin_months WHERE id=?').get(id);
    },
    getFinMonthData(monthId) {
      const income = sqlite.prepare('SELECT * FROM fin_income WHERE month_id=? ORDER BY row_order, rowid').all(monthId);
      const expenses = sqlite.prepare('SELECT * FROM fin_expenses WHERE month_id=? ORDER BY category, row_order, rowid').all(monthId);
      const dist = sqlite.prepare('SELECT * FROM fin_distribution WHERE month_id=?').get(monthId);
      return { income, expenses, distribution: dist || null };
    },
    addFinIncome(monthId, data) {
      const id = `fi-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      const maxOrder = sqlite.prepare('SELECT MAX(row_order) as m FROM fin_income WHERE month_id=?').get(monthId)?.m || 0;
      sqlite.prepare('INSERT INTO fin_income (id,month_id,client_name,to_receive,received,received_date,budget,next_month,row_order) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, monthId, data.clientName||'', data.toReceive||0, data.received||0, data.receivedDate||'', data.budget||0, data.nextMonth?1:0, maxOrder+1);
      return sqlite.prepare('SELECT * FROM fin_income WHERE id=?').get(id);
    },
    updateFinIncome(id, data) {
      const fields = [];
      const vals = [];
      if (data.clientName !== undefined) { fields.push('client_name=?'); vals.push(data.clientName); }
      if (data.toReceive !== undefined) { fields.push('to_receive=?'); vals.push(data.toReceive); }
      if (data.received !== undefined) { fields.push('received=?'); vals.push(data.received); }
      if (data.receivedDate !== undefined) { fields.push('received_date=?'); vals.push(data.receivedDate); }
      if (data.budget !== undefined) { fields.push('budget=?'); vals.push(data.budget); }
      if (data.nextMonth !== undefined) { fields.push('next_month=?'); vals.push(data.nextMonth?1:0); }
      if (data.paid !== undefined) { fields.push('paid=?'); vals.push(data.paid?1:0); }
      if (!fields.length) return;
      vals.push(id);
      sqlite.prepare(`UPDATE fin_income SET ${fields.join(',')} WHERE id=?`).run(...vals);
    },
    deleteFinIncome(id) {
      sqlite.prepare('DELETE FROM fin_income WHERE id=?').run(id);
    },
    addFinExpense(monthId, category, data) {
      const id = `fe-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      const maxOrder = sqlite.prepare('SELECT MAX(row_order) as m FROM fin_expenses WHERE month_id=? AND category=?').get(monthId, category)?.m || 0;
      sqlite.prepare('INSERT INTO fin_expenses (id,month_id,category,name,amount,due_day,row_order) VALUES (?,?,?,?,?,?,?)')
        .run(id, monthId, category, data.name||'', data.amount||0, data.dueDay||0, maxOrder+1);
      return sqlite.prepare('SELECT * FROM fin_expenses WHERE id=?').get(id);
    },
    updateFinExpense(id, data) {
      const fields = [];
      const vals = [];
      if (data.name !== undefined) { fields.push('name=?'); vals.push(data.name); }
      if (data.amount !== undefined) { fields.push('amount=?'); vals.push(data.amount); }
      if (data.dueDay !== undefined) { fields.push('due_day=?'); vals.push(data.dueDay); }
      if (data.paid !== undefined) { fields.push('paid=?'); vals.push(data.paid?1:0); }
      if (!fields.length) return;
      vals.push(id);
      sqlite.prepare(`UPDATE fin_expenses SET ${fields.join(',')} WHERE id=?`).run(...vals);
    },
    deleteFinExpense(id) {
      sqlite.prepare('DELETE FROM fin_expenses WHERE id=?').run(id);
    },
    upsertFinDistribution(monthId, data) {
      const existing = sqlite.prepare('SELECT id FROM fin_distribution WHERE month_id=?').get(monthId);
      if (existing) {
        const fields = []; const vals = [];
        for (const [k, col] of [['entrada','entrada'],['p1Label','p1_label'],['p1Pct','p1_pct'],['p2Label','p2_label'],['p2Pct','p2_pct'],['lazerPct','lazer_pct'],['investPct','invest_pct']]) {
          if (data[k] !== undefined) { fields.push(`${col}=?`); vals.push(data[k]); }
        }
        if (fields.length) { vals.push(monthId); sqlite.prepare(`UPDATE fin_distribution SET ${fields.join(',')} WHERE month_id=?`).run(...vals); }
      } else {
        const id = `fd-${Date.now()}`;
        sqlite.prepare('INSERT INTO fin_distribution (id,month_id,entrada,p1_label,p1_pct,p2_label,p2_pct,lazer_pct,invest_pct) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, monthId, data.entrada||0, data.p1Label||'WAGNER', data.p1Pct||50, data.p2Label||'FRAN', data.p2Pct||50, data.lazerPct||25, data.investPct||25);
      }
      return sqlite.prepare('SELECT * FROM fin_distribution WHERE month_id=?').get(monthId);
    },
  };
  Object.assign(api, finApi);

  dbCache.set(clientId, api);
  return api;
}

module.exports = { forClient };
