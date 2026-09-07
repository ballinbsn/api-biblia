# Checkout backend — Bíblia de Estudo Para o Cotidiano da Mulher (Sélah)

Backend Pix dedicado deste produto: OnyxPag Hub gera a cobrança, a UTMify
recebe o pedido pra manter a atribuição de campanha (Meta só conta Purchase
quando o Pix é pago de verdade).

| Method | Route | Uso |
|---|---|---|
| POST | /api/pay | cria a cobrança Pix |
| GET | /api/pix-status?id= | consulta o status do pagamento (fonte de verdade) |
| POST | /api/webhooks/onyxpag | webhook da OnyxPag — só um aviso, sempre reconsulta antes de confiar |
| GET | /health | healthcheck |

## Sobre o webhook da OnyxPag

A OnyxPag não documenta nenhuma assinatura/HMAC pra provar que a chamada de
webhook veio mesmo dela. Por isso o `/api/webhooks/onyxpag` nunca confia
direto no `status` que vier no corpo — ele pega o `transaction_id` recebido e
faz uma consulta autenticada (`GET /api/pix-status`-equivalente, com nossas
próprias credenciais) antes de considerar qualquer coisa como paga. O
polling do front-end já faz isso naturalmente; o webhook só acelera.

## Rodar localmente

```
npm install
cp .env.example .env   # preencha com suas próprias chaves, nunca comite o .env
npm run dev
```

## Deploy

1. Repositório próprio e **privado** no GitHub (não junte com o site).
2. Railway → New Project → Deploy from repo (Nixpacks detecta Node sozinho).
3. Railway → Variables → cole as variáveis do `.env.example` com os valores reais.
4. Railway → Settings → Networking → Generate Domain.
5. Confirme com `curl https://SEU-DOMINIO/health` → `{"ok":true}`.
6. Preencha `ONYXPAG_WEBHOOK_URL` com esse domínio + `/api/webhooks/onyxpag` e salve (redeploy automático).
7. Se a OnyxPag tiver um cadastro de webhook separado no painel dela, registre essa mesma URL lá.
8. No front-end (`index.html` da Bíblia), aponte `BACKEND_URL` pra esse domínio do Railway.
