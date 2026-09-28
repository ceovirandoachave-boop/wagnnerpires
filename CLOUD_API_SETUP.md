# WhatsApp Cloud API Setup

## 1. Crie um arquivo `.env`

Na raiz de `whatsapp-scheduler`, crie:

```env
WA_PROVIDER=cloud
WA_CLOUD_API_VERSION=v22.0
WA_PHONE_NUMBER_ID=SEU_PHONE_NUMBER_ID
WA_ACCESS_TOKEN=SEU_ACCESS_TOKEN
WA_VERIFY_TOKEN=SEU_TOKEN_DE_VERIFICACAO
```

## 2. Reinicie o servidor

```bash
bash start.sh
```

## 3. Configure o webhook no Meta

Use a URL publica do seu servidor apontando para:

```text
https://SEU-DOMINIO/webhook
```

O token de verificacao deve ser exatamente o valor de `WA_VERIFY_TOKEN`.

## 4. Observacoes importantes

- No modo Cloud API, o dashboard envia para **numeros individuais**.
- Os botoes interativos oficiais funcionam pela Cloud API e as respostas voltam via webhook.
- Mensagens livres e interativas dependem da janela de conversa de 24h. Fora dela, voce precisa de template aprovado.
- Se anexar documento com botoes, o sistema envia o documento primeiro e os botoes em seguida.
