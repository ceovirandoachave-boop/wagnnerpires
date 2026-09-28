#!/bin/bash
# setup-client.sh — cria a estrutura de diretórios para um novo cliente
# Uso: ./setup-client.sh <nome-do-cliente> <porta>
# Exemplo: ./setup-client.sh sulsolar 3002

set -e

CLIENT=${1:?Informe o nome do cliente. Ex: ./setup-client.sh sulsolar 3002}
PORT=${2:?Informe a porta. Ex: ./setup-client.sh sulsolar 3002}

CORE=/root/whatsapp-core
CLIENT_DIR=/root/clients/$CLIENT

echo "→ Criando estrutura para cliente: $CLIENT (porta $PORT)"

# Diretórios de dados
mkdir -p $CLIENT_DIR/data
mkdir -p $CLIENT_DIR/baileys_auth
mkdir -p $CLIENT_DIR/uploads

# .env do cliente — edite depois para adicionar tokens, senhas, etc.
if [ ! -f $CLIENT_DIR/.env ]; then
cat > $CLIENT_DIR/.env << EOF
# Configurações do cliente $CLIENT
JWT_SECRET=$(openssl rand -hex 32)
WA_VERIFY_TOKEN=$(openssl rand -hex 16)
EOF
  echo "  ✓ .env criado"
fi

# clients.json — cria usuário admin padrão (troque a senha depois!)
if [ ! -f $CLIENT_DIR/clients.json ]; then
cat > $CLIENT_DIR/clients.json << EOF
[
  {
    "id": "$CLIENT",
    "username": "admin",
    "password": "mudar123",
    "admin": true,
    "name": "$CLIENT"
  }
]
EOF
  echo "  ✓ clients.json criado (usuário: admin / senha: mudar123)"
fi

# Adiciona o cliente ao ecosystem.config.js
echo ""
echo "  ✓ Diretório pronto: $CLIENT_DIR"
echo ""
echo "  Próximos passos:"
echo "  1. Adicione o bloco abaixo em /root/whatsapp-core/ecosystem.config.js:"
echo ""
echo "  {"
echo "    name: '$CLIENT',"
echo "    script: '/root/whatsapp-core/server.js',"
echo "    cwd: '/root/whatsapp-core',"
echo "    max_memory_restart: '400M',"
echo "    restart_delay: 3000,"
echo "    env: {"
echo "      NODE_ENV: 'production',"
echo "      PORT: $PORT,"
echo "      DATA_DIR: '$CLIENT_DIR',"
echo "    },"
echo "  },"
echo ""
echo "  2. Configure o nginx para rotear $CLIENT.seudominio.com.br → localhost:$PORT"
echo "  3. pm2 startOrRestart /root/whatsapp-core/ecosystem.config.js"
echo "  4. pm2 save"
