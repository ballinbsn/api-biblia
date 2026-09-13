# Checkout backend — Bíblia de Estudo Para o Cotidiano da Mulher (Sélah)

Backend Pix dedicado deste produto: Adex gera a cobrança, a UTMify recebe o
pedido pra manter a atribuição de campanha (Meta só conta Purchase quando o
Pix é pago de verdade).

| Method | Route | Uso |
|---|---|---|
| POST | /api/pay | cria a cobrança Pix |
| GET | /api/pix-status?id= | consulta o status do pagamento (fonte de verdade) |
| POST | /api/webhooks/adex | webhook da Adex — valida assinatura HMAC e sempre reconsulta antes de confiar |
| GET | /health | healthcheck |

## Sobre o webhook da Adex

Diferente de outros gateways que já usamos, a Adex documenta uma assinatura
`x-webhook-signature: sha256=<hex>` (HMAC-SHA256 com a `ADEX_SECRET_KEY`), e
`/api/webhooks/adex` valida ela. Mesmo assim, o webhook nunca decide sozinho:
ele só dispara uma consulta autenticada (`GET /api/pix-status`-equivalente)
pra confirmar o status antes de avisar a UTMify — o polling do front-end faz
a mesma coisa; o webhook só acelera.

## Atenção: valor em reais vs. centavos

A doc da Adex se contradiz sobre o formato do campo `amount`: a tabela de
parâmetros diz "centavos", mas o exemplo de requisição/resposta usa reais
decimal (`100.00` = R$100). O código já segue o exemplo (reais decimal) —
**confirme com uma cobrança real** decodificando o campo 54 do EMV do
`pix.qrCode` antes de considerar isso resolvido (mesma técnica usada com a
OnyxPag, ver o skill `onyxpag-utmify-checkout` → `verify-emv-amount.md`, o
método vale pra qualquer gateway Pix).

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
6. Preencha `ADEX_WEBHOOK_URL` com esse domínio + `/api/webhooks/adex` e salve (redeploy automático).
7. Se a Adex tiver um cadastro de webhook separado no painel dela, registre essa mesma URL lá.
8. No front-end (`index.html` da Bíblia), aponte `BACKEND_URL` pra esse domínio do Railway.
