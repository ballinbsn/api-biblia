# Checkout backend — Bíblia de Estudo Para o Cotidiano da Mulher (Sélah)

Backend Pix dedicado deste produto: PinPay gera a cobrança, a UTMify recebe o
pedido pra manter a atribuição de campanha (Meta só conta Purchase quando o
Pix é pago de verdade).

| Method | Route | Uso |
|---|---|---|
| POST | /api/pay | cria a cobrança Pix |
| GET | /api/pix-status?id= | consulta o status do pagamento |
| POST | /api/webhooks/pinpay | webhook da PinPay (validado por HMAC) |
| GET | /health | healthcheck |

## Rodar localmente

```
npm install
cp .env.example .env   # preencha com suas próprias chaves, nunca comite o .env
npm run dev
```

## Deploy

1. Repositório próprio e **privado** no GitHub (não junte com o site).
2. Railway → New Project → Deploy from repo (Nixpacks detecta Node sozinho).
3. Railway → Variables → cole as 5 variáveis do `.env.example` com os valores reais.
4. Railway → Settings → Networking → Generate Domain.
5. Confirme com `curl https://SEU-DOMINIO/health` → `{"ok":true}`.
6. Preencha `PINPAY_WEBHOOK_URL` com esse domínio + `/api/webhooks/pinpay` e salve (redeploy automático).
7. No painel da PinPay → Webhooks → cadastre essa mesma URL com o secret que está em `PINPAY_WEBHOOK_SECRET`.
8. Desative qualquer integração nativa PinPay↔UTMify — esse backend é a única fonte, senão toda venda é contada em dobro.
9. No front-end (`index.html` da Bíblia), aponte `BACKEND_URL` pra esse domínio do Railway.
