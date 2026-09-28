#!/bin/bash

# Define o diretório atual como base
cd "$(dirname "$0")"

echo "---------------------------------------------------"
echo "🚀 INICIANDO WHATSAPP SCHEDULER (PROJETO VAC)"
echo "---------------------------------------------------"
echo "✅ Proteção contra repouso ativada (Caffeinate)"
echo "✅ Sessão persistente ativada"
echo "✅ Dashboard abrindo em instantes..."
echo "---------------------------------------------------"

# Abre o navegador na dashboard
sleep 2
open "http://localhost:3000"

# Inicia o servidor com o script start.sh que já contém a lógica de estabilidade
bash start.sh
