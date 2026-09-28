// Migração pontual do tenant "visao":
//  1. unifica o grupo "Simples" em "Simples Nacional"
//  2. semeia as tarefas padrão de cada grupo a partir do que os clientes já têm
//  3. inclui "Livro Caixa" no grupo Produtor Rural (padrão + clientes existentes)
//  4. aplica o padrão nos clientes que estão com zero tarefas
const Database = require('better-sqlite3');
const DB = '/root/clients/visao/data/visao/db.sqlite3';
const DRY = process.argv.includes('--dry');

const db = new Database(DB);
const read = (k) => { const r = db.prepare('SELECT value FROM config WHERE key=?').get(k); return r ? JSON.parse(r.value) : null; };
const write = (k, v) => db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));

const area = read('clientArea');
const clients = area.clients || [];
const log = [];

// ---------- 1. modelo por grupo, calculado ANTES da fusão ----------
// Threshold alto (80%) de propósito: só entra no padrão o que é realmente
// transversal ao grupo. O resto o usuário adiciona na tela de Tarefas padrão.
const THRESHOLD = 0.8;
function modeloDoGrupo(lista) {
  const freq = {}, sample = {};
  lista.forEach(c => (c.tasks || []).forEach(t => {
    const k = String(t.title || '').trim(); if (!k) return;
    freq[k] = (freq[k] || 0) + 1; if (!sample[k]) sample[k] = t;
  }));
  const comTarefas = lista.filter(c => (c.tasks || []).length).length;
  if (!comTarefas) return [];
  const min = Math.ceil(comTarefas * THRESHOLD);
  return Object.keys(freq).filter(k => freq[k] >= min)
    .sort((a, b) => freq[b] - freq[a])
    .map(k => ({
      title: k,
      responsavel: '',
      recurring: !!sample[k].recurring,
      recurrence: ['daily', 'weekly', 'biweekly', 'monthly'].includes(sample[k].recurrence) ? sample[k].recurrence : 'monthly',
      priority: '',
      notes: '',
    }));
}

// tarefas que ficaram entre 50% e 80% — não entram sozinhas, mas vale mostrar
function quaseEntrou(lista) {
  const freq = {};
  lista.forEach(c => (c.tasks || []).forEach(t => { const k = String(t.title || '').trim(); if (k) freq[k] = (freq[k] || 0) + 1; }));
  const comTarefas = lista.filter(c => (c.tasks || []).length).length;
  if (!comTarefas) return [];
  const min = Math.ceil(comTarefas * THRESHOLD);
  return Object.keys(freq).filter(k => freq[k] < min && freq[k] / comTarefas >= 0.5)
    .sort((a, b) => freq[b] - freq[a])
    .map(k => `${k} (${freq[k]}/${comTarefas})`);
}

const porGrupo = {};
clients.forEach(c => { if (c.group) (porGrupo[c.group] = porGrupo[c.group] || []).push(c); });
const templates = {};
const quase = {};
Object.keys(porGrupo).forEach(g => { templates[g] = modeloDoGrupo(porGrupo[g]); quase[g] = quaseEntrou(porGrupo[g]); });

// "Simples" está praticamente vazio — o modelo bom é o do "Simples Nacional"
delete templates['Simples'];

// ---------- 2. fusão Simples -> Simples Nacional ----------
let movidos = 0;
clients.forEach(c => { if (c.group === 'Simples') { c.group = 'Simples Nacional'; movidos++; } });
log.push(`Fusão de grupo: ${movidos} cliente(s) movidos de "Simples" para "Simples Nacional"`);

// ---------- 3. Livro Caixa no Produtor Rural ----------
const LIVRO_CAIXA = { title: 'Livro Caixa', responsavel: '', recurring: true, recurrence: 'monthly', priority: '', notes: '' };
templates['Produtor Rural'] = templates['Produtor Rural'] || [];
if (!templates['Produtor Rural'].some(x => x.title.toLowerCase() === 'livro caixa')) {
  templates['Produtor Rural'].push({ ...LIVRO_CAIXA });
  log.push('Modelo "Produtor Rural": tarefa "Livro Caixa" incluída');
}

function novaTarefa(tpl) {
  return {
    id: 'tsk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: tpl.title, status: 'fazer', resultado: '', responsavel: tpl.responsavel || '',
    due: null, startMin: null, durMin: 30, allDay: false, done: false,
    recurring: !!tpl.recurring, recurrence: tpl.recurrence || 'monthly',
    priority: tpl.priority || '', doneAt: null, doneCount: 0,
    notes: tpl.notes || '', subtasks: [], attachments: [],
  };
}

let livroAdd = 0;
clients.filter(c => c.group === 'Produtor Rural').forEach(c => {
  c.tasks = c.tasks || [];
  if (c.tasks.some(t => String(t.title || '').trim().toLowerCase() === 'livro caixa')) return;
  c.tasks.push(novaTarefa(LIVRO_CAIXA)); livroAdd++;
});
log.push(`"Livro Caixa" criada em ${livroAdd} cliente(s) do Produtor Rural`);

// ---------- 4. aplica o padrão nos clientes com zero tarefas ----------
let aplicados = 0, criadas = 0;
clients.forEach(c => {
  if (!c.group) return;
  if ((c.tasks || []).length) return;
  const tpl = templates[c.group] || [];
  if (!tpl.length) return;
  c.tasks = tpl.map(novaTarefa);
  aplicados++; criadas += c.tasks.length;
  log.push(`  ${c.name} [${c.group}] → ${c.tasks.length} tarefas`);
});
log.push(`Padrão aplicado em ${aplicados} cliente(s) vazio(s) — ${criadas} tarefas criadas`);

// ---------- resumo ----------
console.log('\n=== MODELOS POR GRUPO ===');
Object.keys(templates).sort().forEach(g => {
  console.log(`\n${g} (${templates[g].length} tarefas padrão)`);
  templates[g].forEach(x => console.log(`   - ${x.title}${x.recurring ? ' [rotina ' + x.recurrence + ']' : ''}`));
  if ((quase[g] || []).length) {
    console.log(`   ...ficou de fora (entre 50% e 80% dos clientes do grupo):`);
    quase[g].forEach(x => console.log(`       ? ${x}`));
  }
});
console.log('\n=== AÇÕES ===');
log.forEach(l => console.log(l));

const contagem = {};
clients.forEach(c => { const g = c.group || '(SEM GRUPO)'; contagem[g] = (contagem[g] || 0) + 1; });
console.log('\n=== GRUPOS DEPOIS ===');
Object.keys(contagem).sort().forEach(g => console.log(`   ${g}: ${contagem[g]}`));
console.log('\nTarefas totais:', clients.reduce((n, c) => n + (c.tasks || []).length, 0));

if (DRY) { console.log('\n*** DRY RUN — nada foi gravado ***'); process.exit(0); }
write('clientArea', { clients, avulsas: area.avulsas || [] });
write('taskTemplates', templates);
console.log('\n*** GRAVADO ***');
