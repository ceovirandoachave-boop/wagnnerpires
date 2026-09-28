// Migra dados do db.json para SQLite. Rodar uma única vez no servidor.
// Uso: node migrate-to-sqlite.js

const fs = require('fs');
const path = require('path');
const { forClient } = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) { console.log('Nenhum dado para migrar.'); process.exit(0); }

const clients = fs.readdirSync(DATA_DIR).filter(d => fs.statSync(path.join(DATA_DIR, d)).isDirectory());

for (const clientId of clients) {
  const jsonPath = path.join(DATA_DIR, clientId, 'db.json');
  if (!fs.existsSync(jsonPath)) { console.log(`[${clientId}] Sem db.json, pulando.`); continue; }

  let raw;
  try { raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { console.error(`[${clientId}] Erro ao ler JSON:`, e.message); continue; }

  const sqlitePath = path.join(DATA_DIR, clientId, 'db.sqlite3');
  if (fs.existsSync(sqlitePath)) { console.log(`[${clientId}] SQLite já existe, pulando.`); continue; }

  console.log(`[${clientId}] Migrando...`);
  const db = forClient(clientId);

  // Config
  if (raw.config && Object.keys(raw.config).length > 0) {
    db.updateConfig(raw.config);
    console.log(`  config: OK`);
  }

  // Schedules
  for (const s of (raw.schedules || [])) {
    try { db.createSchedule({ recipientType: s.recipientType, recipientId: s.recipientId, recipientName: s.recipientName, message: s.message, scheduledFor: s.scheduledFor, documentPath: s.documentPath, documentName: s.documentName, quickReplies: s.quickReplies, bulkId: s.bulkId }); } catch {}
  }
  console.log(`  schedules: ${(raw.schedules||[]).length}`);

  // Logs
  const Database = require('better-sqlite3');
  const sqlite = new Database(path.join(DATA_DIR, clientId, 'db.sqlite3'));
  const insertLog = sqlite.prepare('INSERT OR IGNORE INTO logs (id,schedule_id,recipient_type,recipient_id,recipient_name,message,quick_replies,document_name,document_path,success,error,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  sqlite.transaction(() => {
    for (const l of (raw.logs || [])) insertLog.run(l.id || Date.now().toString(), l.scheduleId||null, l.recipientType||'group', l.recipientId, l.recipientName, l.message, JSON.stringify(l.quickReplies||[]), l.documentName||null, l.documentPath||null, l.success?1:0, l.error||null, l.sentAt);
  })();
  console.log(`  logs: ${(raw.logs||[]).length}`);

  // Responses
  const insertResp = sqlite.prepare('INSERT OR IGNORE INTO responses (id,schedule_id,sender_id,sender_name,recipient_id,recipient_name,reply,matched_button,response_time_ms,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  sqlite.transaction(() => {
    for (const r of (raw.responses||[])) insertResp.run(r.id||Date.now().toString(), r.scheduleId, r.senderId, r.senderName, r.recipientId, r.recipientName, r.reply, r.matchedButton, r.responseTimeMs, r.receivedAt);
  })();
  console.log(`  responses: ${(raw.responses||[]).length}`);

  // Known contacts
  const insertContact = sqlite.prepare('INSERT OR IGNORE INTO known_contacts (id,name,first_seen_at,last_seen_at,message_count,profile_pic_url) VALUES (?,?,?,?,?,?)');
  sqlite.transaction(() => {
    for (const c of Object.values(raw.knownContacts||{})) insertContact.run(c.id, c.name||c.id, c.firstSeenAt||Date.now(), c.lastSeenAt||Date.now(), c.messageCount||0, c.profilePicUrl||null);
  })();
  console.log(`  contacts: ${Object.keys(raw.knownContacts||{}).length}`);

  // Messages
  const insertMsg = sqlite.prepare('INSERT OR IGNORE INTO messages (id,direction,contact_id,contact_name,text,media_url,media_type,media_name,schedule_id,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)');
  sqlite.transaction(() => {
    for (const m of (raw.messages||[])) insertMsg.run(m.id, m.direction, m.contactId, m.contactName, m.text||'', m.mediaUrl||null, m.mediaType||null, m.mediaName||null, m.scheduleId||null, m.timestamp);
  })();
  console.log(`  messages: ${(raw.messages||[]).length}`);

  // Funnels
  const insertFunnel = sqlite.prepare('INSERT OR IGNORE INTO funnels (id,name,created_at) VALUES (?,?,?)');
  sqlite.transaction(() => { for (const f of (raw.funnels||[])) insertFunnel.run(f.id, f.name, f.createdAt||Date.now()); })();

  // CRM Columns
  const insertCol = sqlite.prepare('INSERT OR IGNORE INTO crm_columns (id,funnel_id,name,col_order) VALUES (?,?,?,?)');
  sqlite.transaction(() => { for (const c of (raw.crmColumns||[])) insertCol.run(c.id, c.funnelId||'default', c.name, c.order||0); })();

  // CRM Cards
  const insertCard = sqlite.prepare('INSERT OR IGNORE INTO crm_cards (id,column_id,funnel_id,contact_name,phone,whatsapp_id,instagram,site,label,labels,checks,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  sqlite.transaction(() => {
    for (const c of (raw.crmCards||[])) insertCard.run(c.id, c.columnId, c.funnelId||'default', c.contactName||'', c.phone||'', c.whatsappId||null, c.instagram||'', c.site||'', c.label||null, JSON.stringify(c.labels||[]), JSON.stringify(c.checks||{}), c.notes||'', c.createdAt||Date.now(), c.updatedAt||Date.now());
  })();
  console.log(`  CRM cards: ${(raw.crmCards||[]).length}`);

  // Prospects
  const insertProspect = sqlite.prepare('INSERT OR IGNORE INTO prospects (id,name,instagram,site,phone,created_at) VALUES (?,?,?,?,?,?)');
  sqlite.transaction(() => { for (const p of (raw.prospects||[])) insertProspect.run(p.id, p.name||'', p.instagram||'', p.site||'', p.phone||'', p.createdAt||Date.now()); })();
  console.log(`  prospects: ${(raw.prospects||[]).length}`);

  // Consultants
  const insertConsultant = sqlite.prepare('INSERT OR IGNORE INTO consultants (id,name,available,last_assigned_at,created_at) VALUES (?,?,?,?,?)');
  sqlite.transaction(() => { for (const c of (raw.consultants||[])) insertConsultant.run(c.id, c.name, c.available?1:0, c.lastAssignedAt||0, c.createdAt||Date.now()); })();
  console.log(`  consultants: ${(raw.consultants||[]).length}`);

  sqlite.close();
  console.log(`[${clientId}] Migração concluída!\n`);
}

console.log('Migração completa. Reinicie o servidor com: pm2 restart all');
