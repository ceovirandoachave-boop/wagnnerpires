# Últimas coisas — infra do whatsapp-core

> Documento de referência viva sobre a infraestrutura do SaaS (whatsapp-core, VPS 72.60.67.154).
> Atualizar sempre que mexer em algo estrutural (não em cada feature de produto — só o que afeta
> confiabilidade/operação: banco, backup, cron, processos, monitoramento).

Última atualização: 2026-08-16

## 1. Contexto

- Codebase único (`server.js` + `db.js` + `public/`) compartilhado por **15 processos PM2**, um por
  tenant, todos rodando o MESMO código, diferenciados só por `DATA_DIR`/`PORT` (via
  `ecosystem.config.js`, gerado a partir de `clients-registry.json`).
- Cada tenant tem seu próprio `db.sqlite3` (better-sqlite3, modo WAL). Vários tenants também hospedam
  **sub-clientes** dentro de si (feature "Área de Clientes" — ex: `virandoachave` hospeda hw/karol/
  lino/vnz/fran/vac/paula; `advocaciafigueiro` hospeda rodrigo/anajulia/alanzinho/etc). Cada
  sub-cliente tem seu PRÓPRIO `db.sqlite3` separado, em `<tenant>/data/<subClienteId>/db.sqlite3`.
- Motivo desse doc: antes de trocar a tecnologia do SaaS, revisamos 8 pontos de confiabilidade
  operacional (backup, monitoramento, logs, filas, queries grandes, mídia por cliente, retenção,
  VACUUM). A maioria não existia. Ficou tudo registrado aqui.

## 2. O que já existe hoje (16/08/2026)

### Retenção de mensagens — CORRIGIDO (era o achado mais crítico)
- **Antes**: cada tenant guardava só as últimas 3000 mensagens NO TOTAL (todos os contatos
  somados), apagando o resto de verdade. Pra tenants ativos isso significava só ~3 dias de
  histórico real (confirmado ao vivo: virandoachave só tinha ~3,3 dias de mensagens).
- **Agora**: `messages_archive` (mesma estrutura de `messages`) guarda tudo que sai da tabela quente.
  - Válvula de segurança: acima de 20.000 mensagens na tabela `messages`, o excedente vai pra
    archive (não é mais deletado).
  - Retenção de verdade: cron diário (`3:23` da madrugada) move pra archive tudo com mais de
    **180 dias**. Função: `archiveOldMessagesAllClients()` em `server.js`, `archiveOldMessagesOlderThan()`
    em `db.js`.
  - Nada é descartado — só sai da tabela "quente" pra uma de arquivo, no MESMO arquivo `.sqlite3`.

### Bug de ordem de migração — CORRIGIDO
- `ALTER TABLE ADD COLUMN` rodava ANTES do `CREATE TABLE IF NOT EXISTS` em `db.js`. Cliente/sub-cliente
  nunca usado antes ficava sem as colunas `connection_id`/`wamid`/`delivery_status`/`delivery_error`
  em `messages` (e sem `connection_id` em `schedules`/`logs`). Corrigido: migrações agora rodam
  depois da criação das tabelas.

### Vazamento de conexão WhatsApp entre processos — CORRIGIDO
- **Causa**: `runSendAutomationsTick()` (motor de envio/relatório semanal) chamava
  `getTenant('virandoachave')` direto, mas o `cron.schedule` que dispara essa função roda em
  TODOS os 15 processos (é o mesmo `server.js`). Isso plantava um `TenantState('virandoachave')`
  completo dentro de cada um dos outros 14 processos, e o watchdog do WhatsApp Lite (que varre
  `tenants.values()`, a cada 90s) passava a tentar gerenciar a MESMA sessão WhatsApp a partir de
  até 15 processos ao mesmo tempo — a causa provável dos restarts em massa que via em `rw`
  (175+ restarts), `rstransporte`, `phdvilaemma`.
- **Fix**: `ownClientId()` (nova função em `server.js`, mesmo padrão já usado em outros pontos do
  código) trava `runSendAutomationsTick()` pra só executar de fato no processo que É o virandoachave.
- **Confirmado**: depois do fix, `rw`/`rstransporte`/`phdvilaemma` pararam de subir restart (ficaram
  parados por 5+ minutos cobrindo vários ciclos de watchdog/cron, antes subiam a cada poucos minutos).
- **Efeito colateral inofensivo**: existem ~15 bancos "fantasma" de virandoachave espalhados dentro
  de outros tenants (`<tenant>/data/virandoachave/db.sqlite3`), criados antes do fix. Não crescem
  mais, não atrapalham nada, só ocupam uns KB cada. Não precisa limpar.

### Backup automático diário — NOVO
- Script: `/root/scripts/backup-sqlite-daily.sh`
- Usa `sqlite3 <origem> ".backup <destino>"` (seguro pra copiar banco em WAL sendo escrito ao
  vivo — NUNCA usar `cp` cru num banco WAL ativo, pode perder dado commitado só no `-wal`).
- Confere cada backup com `PRAGMA quick_check` antes de considerar ok.
- Retenção: apaga backups com mais de 30 dias sozinho.
- Destino: `/root/backups/sqlite-daily/AAAA-MM-DD/` (hoje: 63 arquivos, ~33MB).
- Log: `/root/backups/sqlite-daily/backup.log` e `cron.log`.
- Agendado via **crontab** (não node-cron): `10 4 * * *`.

### Monitoramento de CPU/RAM/disco — NOVO
- Script: `/root/scripts/monitor-resources.sh`
- Roda a cada 5 minutos via crontab, checa disco (`df /`), RAM (`free`) e load average.
- Limites: disco 85%, RAM 90%, load > núcleos×2.
- Alerta por **WhatsApp direto via Evolution API** (`curl` pro Evolution local, `lite2-virandoachave`,
  número `5548991206785`) — **não depende de nenhum dos 15 processos Node estarem de pé**, então
  funciona mesmo se o app inteiro cair.
- Cooldown de 1h por métrica (não fica repetindo o mesmo alerta a cada 5min) + mensagem de
  "normalizou" quando volta ao normal.
- Testado de ponta a ponta (forcei um limite baixo, confirmei disparo + cooldown + recuperação).
- Estado: `/root/scripts/.monitor-state/`.

### VACUUM/otimização — NOVO
- Método `vacuum()` em `db.js` (`PRAGMA optimize` + `VACUUM`, na MESMA conexão que o app já usa —
  nunca abrir conexão externa separada pro mesmo arquivo).
- Função `vacuumAllClients()` em `server.js`, cron semanal: domingo `4:30` da madrugada.
- Não roda automaticamente no boot (só no cron) — VACUUM reescreve o arquivo inteiro, não vale a
  pena pagar esse custo a cada restart/deploy.

### Já existia antes (confirmado, não precisou mexer)
- **Logs separados por cliente**: PM2 já dá um arquivo de log por tenant
  (`~/.pm2/logs/<tenant>-error.log`). Falta rotação (sem `pm2-logrotate`) — hoje é pouco (17MB/62
  arquivos), mas cresce sem limite. **Não implementado ainda.**
- **Uploads/mídia separados por cliente**: `uploadsDir = DATA_DIR/uploads/<clientId>`, isolamento
  real confirmado. Tem limpeza automática de mídia com +72h (`cleanupExpiredMedia`, cron a cada hora).

## 3. Avaliado e considerado NÃO urgente (não implementado de propósito)

- **Fila de verdade (Bull/BullMQ + Redis)**: avaliei e decidi não instalar. Motivos: (a) não achei
  nenhum gargalo real acontecendo hoje — envio em massa já é pautado (`BULK_BATCH_SIZE=5`,
  `BULK_REST_MS=5min`, já ligado de verdade no código), relatório semanal em PDF já é assíncrono
  por cliente (usa `await` entre clientes, não bloqueia tudo de uma vez); (b) instalar Redis é
  infra nova pra manter (backup, monitoramento, segurança dela também); (c) o SaaS vai trocar de
  tecnologia em breve — investir pesado aqui agora seria provável trabalho jogado fora.
- **`crm_cards` sem paginação/arquivamento** — `SELECT * FROM crm_cards` sem LIMIT existe em vários
  lugares. Testei no banco mais cheio (sulsolar, 2690 cards): ~140ms, sem problema real hoje.
  Diferente de mensagem, arquivar um lead é decisão de negócio (é histórico de venda), não é algo
  pra eu decidir sozinho — **ficar de olho se o volume crescer muito** (10x a partir daqui já
  começaria a doer).
- **Rotação de logs do PM2** — não fiz ainda, baixo risco/baixo volume hoje (17MB total).

## 4. Achados sem ação (FYIs, não é problema, só é bom saber)

- Existem **13 pastas de tenant órfãs** sem processo PM2 ativo: `adn`, `dnarantes`, `rstransportes`
  (repara no "s" a mais vs. `rstransporte`), `wgn`, `ironfit`, `karol`, `vinicius`, `ispira` (sem
  "n", vs `inspira`), `uberfit`, `ilumina`, `teste`, `vac`, `evandro`. Parecem testes/nomes
  digitados errado numa criação que não foi pra frente. Poucos MB, não atrapalham. O usuário pediu
  pra não mexer nisso por enquanto.

## 5. Onde as coisas estão (referência rápida)

| O quê | Onde |
|---|---|
| Código da app | `/root/whatsapp-core/` (`server.js`, `db.js`, `public/`) |
| Scripts de infra | `/root/scripts/` (`backup-sqlite-daily.sh`, `monitor-resources.sh`) |
| Backups de código (meus checkpoints antes de mexer) | `/root/backups/whatsapp-core/<timestamp>_<descrição>/` |
| Backups diários dos bancos | `/root/backups/sqlite-daily/AAAA-MM-DD/` |
| Estado do monitoramento | `/root/scripts/.monitor-state/` |
| Crontab do root | `crontab -l` — hoje tem o backup (4:10) e o monitor (a cada 5min) |
| Cron dentro do app (node-cron, por processo) | `MEDIA_CLEANUP_SCHEDULE` (hora em hora), `MESSAGE_ARCHIVE_SCHEDULE` (diário 3:23), `VACUUM_SCHEDULE` (domingo 4:30) — todos no topo do `server.js` |
| Evolution API (WhatsApp Lite) | `http://127.0.0.1:8080`, key em `EVOLUTION_API_KEY` no `.env` de cada tenant (mesmo valor em todos) |
| Número pra alerta de monitoramento | `5548991206785` (Wagner), via instância `lite2-virandoachave` |

## 6. Antes de mexer de novo na infra, lembrar

- **Nunca** `cp` cru num `.sqlite3` que pode estar sendo escrito — sempre `sqlite3 .backup` ou
  parar o processo antes.
- **Nunca** abrir uma segunda conexão SQLite pro mesmo arquivo por fora do processo Node enquanto
  ele está rodando (risco de lock) — VACUUM e outras manutenções pesadas devem rodar DENTRO do
  processo, na mesma conexão que o app já usa (`t.db.<método>`), não por script externo direto no
  arquivo.
- Mudança em `server.js`/`db.js` exige restart dos 15 tenants (`pm2 restart <lista> --update-env`)
  pra valer — arquivos estáticos (`app.js`/`style.css`/`index.html`) não precisam.
- Antes de qualquer mudança de schema/write-path, testar contra uma CÓPIA de um banco real (não o
  ao vivo) — ver seção de metodologia usada nas mudanças de retenção/VACUUM acima como referência.
- `getTenant(clientId)` cria um `TenantState` completo (incluindo conexão WhatsApp) na hora, em
  QUALQUER processo que chamar — cuidado com código que roda em loop global (`cron.schedule`,
  `setInterval` no nível do módulo) chamando `getTenant()` com um clientId fixo que não é o
  "dono" do processo. Usar `ownClientId()` pra travar quando for o caso.
