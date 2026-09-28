// PM2 Ecosystem — gerenciado automaticamente pelo provisionador
// Não edite a lista de apps manualmente; use o painel admin em localhost:3000
const fs = require('fs');
const path = require('path');

let clients = [];
try {
  clients = JSON.parse(fs.readFileSync(path.join(__dirname, 'clients-registry.json'), 'utf8'));
} catch {}

module.exports = {
  apps: [
    // Provisionador — painel admin do servidor
    {
      name: 'provisioner',
      script: path.join(__dirname, 'provisioner.js'),
      cwd: __dirname,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        BASE_DOMAIN: 'seu-dominio.com.br',
        ADMIN_EMAIL: 'seu-email@exemplo.com',
        META_APP_ID: '',  // preencha com o App ID do SEU app Meta
        META_APP_SECRET: '',  // preencha com o App Secret do SEU app Meta
        WA_EMBEDDED_CONFIG_ID: '',  // preencha se for usar embedded signup
        EVOLUTION_API_KEY: '',  // preencha com a chave da SUA instancia Evolution API
        EVOLUTION_API_URL: 'http://127.0.0.1:8080',
      },
    },
    // Clientes — gerados automaticamente a partir de clients-registry.json
    ...clients.map(c => ({
      name: c.id,
      script: path.join(__dirname, 'server.js'),
      cwd: __dirname,
      max_memory_restart: '400M',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: c.port,
        DATA_DIR: c.dataDir,
      },
    })),
  ],
};
