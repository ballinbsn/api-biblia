import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const ADEX_BASE = "https://api.adex.cash/functions/v1";
const UTMIFY_ORDERS_URL = "https://api.utmify.com.br/api-credentials/orders";

// CORS liberado pra qualquer origem — por decisão do projeto, sem restrição de domínio.
app.use(cors());
app.use(express.json());

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || null;
}

// Data no formato que a UTMify exige: "YYYY-MM-DD HH:MM:SS" em UTC.
function utmifyDate(d = new Date()) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Gera um CPF com dígitos verificadores válidos — fallback quando o front não
// mandou um CPF válido (não deveria acontecer: a tela pede e valida antes).
function genCPF() {
  const n = [];
  for (let i = 0; i < 9; i++) n.push(Math.floor(Math.random() * 9));
  for (let j = 0; j < 2; j++) {
    let s = 0;
    const w = n.length + 1;
    for (let k = 0; k < n.length; k++) s += n[k] * (w - k);
    const r = 11 - (s % 11);
    n.push(r >= 10 ? 0 : r);
  }
  return n.join("");
}

// Telefone celular BR aleatório e plausível (DDD + 9 + 8 dígitos).
function genPhone() {
  const ddds = ["11", "21", "31", "41", "51", "61", "71", "81", "85", "19", "27", "48", "62", "98"];
  const ddd = ddds[Math.floor(Math.random() * ddds.length)];
  let num = "9";
  for (let i = 0; i < 8; i++) num += Math.floor(Math.random() * 10);
  return ddd + num;
}

function adexHeaders() {
  return {
    "x-public-key": process.env.ADEX_PUBLIC_KEY || "",
    "x-secret-key": process.env.ADEX_SECRET_KEY || "",
    "Content-Type": "application/json",
  };
}

/* ================================================================== */
/* UTMify — envio de pedidos (rastreio de venda + conversão pro Meta).
   1 pedido é enviado em "waiting_payment" quando o Pix é gerado e
   atualizado pro status final ("paid" / "refused") usando o MESMO
   orderId. A UTMify só dispara Purchase pro Meta no "paid".

   A Adex não tem um campo de metadata na criação — só devolve o "id" dela
   (UUID) e ecoa "external_id" no webhook/consulta SE ele tiver sido
   aceito na criação (não documentado, mandamos mesmo assim por garantia).
   Por isso o pedido fica guardado em memória por 24h, indexado tanto pelo
   nosso orderId quanto pelo id (UUID) que a Adex devolveu na criação. */
const PAID_STATUSES = new Set(["paid", "pago", "aprovado", "approved", "completed", "concluido", "concluído"]);
const FAILED_STATUSES = new Set(["failed", "expired", "cancelled", "canceled", "expirado", "cancelado"]);
const ordersById = new Map(); // orderId (SLH...) -> rec
const pixToOrder = new Map(); // id (UUID) da Adex -> orderId

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of ordersById) if ((v.ts || 0) < cutoff) ordersById.delete(k);
  for (const [k, oid] of pixToOrder) if (!ordersById.has(oid)) pixToOrder.delete(k);
}, 60 * 60 * 1000).unref?.();

function findRec({ orderId, pixId } = {}) {
  return (orderId && ordersById.get(orderId)) || (pixId && pixToOrder.has(pixId) && ordersById.get(pixToOrder.get(pixId))) || null;
}

async function sendUtmifyOrder(rec, status, approvedDate = null) {
  if (!process.env.UTMIFY_API_TOKEN) return;
  if (!rec || !rec.orderId) return;
  rec.utmifySent = rec.utmifySent || new Set();
  if (rec.utmifySent.has(status)) return;
  rec.utmifySent.add(status);

  const t = rec.tracking || {};
  const payload = {
    orderId: rec.orderId,
    platform: "Adex",
    paymentMethod: "pix",
    status,
    createdAt: rec.createdAt || utmifyDate(),
    approvedDate: approvedDate || (status === "paid" ? utmifyDate() : null),
    refundedAt: status === "refunded" ? utmifyDate() : null,
    customer: {
      name: rec.customer?.name || "",
      email: rec.customer?.email || "",
      phone: rec.customer?.phone || null,
      document: rec.customer?.document || null,
      country: "BR",
      ip: rec.customer?.ip || null,
    },
    products: [
      {
        id: "biblia-estudo-mulher",
        name: rec.product || "Bíblia de Estudo Para o Cotidiano da Mulher",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: rec.amountCents,
      },
    ],
    trackingParameters: {
      src: t.src || null,
      sck: t.sck || null,
      utm_source: t.utm_source || null,
      utm_campaign: t.utm_campaign || null,
      utm_medium: t.utm_medium || null,
      utm_content: t.utm_content || null,
      utm_term: t.utm_term || null,
    },
    commission: {
      totalPriceInCents: rec.amountCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: rec.amountCents,
      currency: "BRL",
    },
    isTest: false,
  };

  try {
    const r = await fetch(UTMIFY_ORDERS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": process.env.UTMIFY_API_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      rec.utmifySent.delete(status);
      const errText = await r.text().catch(() => "");
      console.error("[utmify] pedido falhou", status, rec.orderId, r.status, errText);
      return { ok: false, httpStatus: r.status, body: errText };
    }
    console.log("[utmify] pedido enviado", status, rec.orderId);
    return { ok: true };
  } catch (e) {
    rec.utmifySent.delete(status);
    console.error("[utmify] exceção ao enviar pedido", e.message);
    return { ok: false, error: e.message };
  }
}

// Consulta a transação DIRETO na Adex, com nossas próprias credenciais.
// IMPORTANTE (documentado por eles): o parâmetro é o UUID que a Adex
// devolveu na criação (campo "id"), NUNCA o nosso orderId — mandar o
// orderId aqui dá erro 22P02 (invalid input syntax for type uuid).
async function fetchAdexTransaction(transactionId) {
  const r = await fetch(`${ADEX_BASE}/pix-receive?transaction_id=${encodeURIComponent(transactionId)}`, {
    headers: adexHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.transaction) {
    console.error("[adex] falha ao consultar transação", transactionId, r.status, JSON.stringify(body).slice(0, 500));
    return null;
  }
  return body.transaction;
}

// Depois de confirmar (via fetchAdexTransaction) que uma transação está
// paga de verdade, avisa a UTMify.
async function handleConfirmedStatus(tx) {
  if (!tx) return;
  const rec = findRec({ orderId: tx.external_id, pixId: tx.id });
  if (!rec) {
    console.warn("[adex] status confirmado sem conseguir religar ao pedido", tx.id, tx.external_id);
    return;
  }

  const status = String(tx.status || "").toLowerCase();
  if (PAID_STATUSES.has(status)) {
    await sendUtmifyOrder(rec, "paid", utmifyDate());
  } else if (FAILED_STATUSES.has(status)) {
    await sendUtmifyOrder(rec, "refused");
  }
}

// Webhook da Adex. Ao contrário de outros gateways que já usamos, a Adex
// DOCUMENTA uma assinatura HMAC-SHA256 (header "x-webhook-signature:
// sha256=<hex>", calculada com a secret key sobre JSON.stringify(body)) —
// validamos igual ao exemplo oficial deles. Mesmo assim, só usamos o
// webhook como aviso; quem decide o status final é sempre a consulta
// autenticada, igual fazíamos com os gateways sem assinatura nenhuma.
app.post("/api/webhooks/adex", async (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  if (signature && process.env.ADEX_SECRET_KEY) {
    const provided = String(signature).replace(/^sha256=/, "");
    const expected = crypto
      .createHmac("sha256", process.env.ADEX_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest("hex");
    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) {
      console.warn("[adex webhook] assinatura inválida, ignorando");
      return res.status(401).end();
    }
  }

  res.status(200).end(); // responde rápido; processa depois

  const { event, data } = req.body || {};
  const transactionId = data?.transaction_id || null;
  console.log("[adex webhook]", event, { transactionId, external: data?.external_id });
  if (!transactionId) return;

  const tx = await fetchAdexTransaction(transactionId);
  if (!tx) {
    console.warn("[adex webhook] não confirmou a transação na consulta, ignorando", transactionId);
    return;
  }
  await handleConfirmedStatus(tx);
});

// Cria a cobrança Pix pro pedido
app.post("/api/pay", async (req, res) => {
  if (!process.env.ADEX_PUBLIC_KEY || !process.env.ADEX_SECRET_KEY) {
    console.error("[adex] ADEX_PUBLIC_KEY/ADEX_SECRET_KEY não configurados no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const { product, amountReais, customer, address, tracking, checkoutUrl } = req.body || {};

  const amountCents = Math.round(Number(amountReais) * 100);
  if (!Number.isInteger(amountCents) || amountCents < 100) return res.status(400).json({ error: "amount_invalid" });
  if (!product || typeof product !== "string") return res.status(400).json({ error: "product_invalid" });

  let cpf = onlyDigits(customer?.cpf);
  if (cpf.length !== 11) cpf = genCPF();
  let phone = onlyDigits(customer?.phone);
  if (phone.length < 10 || phone.length > 11) phone = genPhone();
  const email = String(customer?.email || "").trim();
  const name = String(customer?.name || "").trim();
  if (!name || name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "customer_invalid" });
  }
  if (!address?.cep || !address?.cidade || !address?.uf) {
    return res.status(400).json({ error: "address_invalid" });
  }

  const orderId = "SLH" + Date.now() + Math.random().toString(36).slice(2, 7);
  const createdAt = utmifyDate();
  const ip = clientIp(req);
  const t = tracking || {};
  const amountReaisNum = Number((amountCents / 100).toFixed(2));

  try {
    const r = await fetch(`${ADEX_BASE}/pix-receive`, {
      method: "POST",
      headers: adexHeaders(),
      body: JSON.stringify({
        // A doc da Adex se contradiz: a tabela de parâmetros diz "amount em
        // centavos", mas o EXEMPLO de requisição e a resposta usam reais
        // decimal (amount: 100.00 = R$100). Seguimos o exemplo/resposta —
        // CONFIRME com uma cobrança real + verify-emv-amount.md antes de ir
        // pra produção, exatamente como fizemos com a OnyxPag.
        amount: amountReaisNum,
        paymentMethod: "pix",
        customer: {
          name,
          email,
          phone,
          document: { number: cpf, type: "cpf" },
          // Obrigatório quando algum item tem tangible:true.
          address: {
            zip: onlyDigits(address.cep),
            street: address.rua || "",
            number: address.numero || "s/n",
            complement: address.complemento || "",
            neighborhood: address.bairro || "",
            city: address.cidade,
            state: address.uf,
          },
        },
        items: [
          {
            title: product,
            unitPrice: amountReaisNum,
            quantity: 1,
            tangible: true,
          },
        ],
        postbackUrl: process.env.ADEX_WEBHOOK_URL,
        // Não documentado na tabela de parâmetros de criação, mas a doc de
        // polling/webhook claramente espera poder religar por external_id —
        // mandamos por garantia; se a Adex ignorar, sobra o pixToOrder local.
        external_id: orderId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const charge = await r.json().catch(() => ({}));
    if (!r.ok || !charge?.id) {
      console.error("[adex] falha ao criar cobrança", r.status, JSON.stringify(charge).slice(0, 800));
      // TEMP-DEBUG: expõe o erro real da Adex pra diagnosticar o 502.
      return res.status(502).json({ error: "gateway_error", debug: { status: r.status, body: charge } });
    }

    console.log("[adex] cobrança criada", { orderId, transactionId: charge.id, status: charge.status });

    // Endereço de entrega fica só com a gente — usado pra despachar o livro.
    const enderecoResumo =
      `${address.rua || ""}, ${address.numero || "s/n"}` +
      (address.complemento ? ` - ${address.complemento}` : "") +
      (address.bairro ? ` - ${address.bairro}` : "") +
      `, ${address.cidade}/${address.uf} - CEP ${onlyDigits(address.cep)}`;

    const rec = {
      orderId,
      createdAt,
      ts: Date.now(),
      product,
      amountCents,
      customer: { name, email, phone, document: cpf, ip },
      endereco: enderecoResumo,
      tracking: {
        src: t.src || null,
        sck: t.sck || null,
        utm_source: t.utm_source || null,
        utm_campaign: t.utm_campaign || null,
        utm_medium: t.utm_medium || null,
        utm_content: t.utm_content || null,
        utm_term: t.utm_term || null,
      },
      utmifySent: new Set(),
    };
    ordersById.set(orderId, rec);
    pixToOrder.set(charge.id, orderId);

    sendUtmifyOrder(rec, "waiting_payment").catch(() => {});

    return res.status(201).json({
      pix_id: charge.id,
      qr_code: charge.pix?.qrCode || null,
      qr_code_image: null, // a Adex não devolve imagem pronta, só o EMV copia-e-cola
      expires_at: charge.pix?.expirationDate || null,
      order_id: orderId,
    });
  } catch (e) {
    console.error("[adex] exceção ao criar cobrança", e);
    return res.status(500).json({ error: "internal" });
  }
});

// O frontend consulta esse endpoint a cada poucos segundos. É a fonte de
// verdade principal. Aceita ?id=<id que a Adex devolveu na criação>.
app.get("/api/pix-status", async (req, res) => {
  if (!process.env.ADEX_PUBLIC_KEY || !process.env.ADEX_SECRET_KEY) {
    console.error("[adex] ADEX_PUBLIC_KEY/ADEX_SECRET_KEY não configurados no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const id = typeof req.query?.id === "string" ? req.query.id : "";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "id_invalid" });

  try {
    const tx = await fetchAdexTransaction(id);
    if (!tx) return res.status(200).json({ status: "pending", expires_at: null });

    await handleConfirmedStatus(tx);

    return res.status(200).json({ status: tx.status, expires_at: tx.expires_at ?? null });
  } catch (e) {
    console.error("[adex] exceção ao consultar status", e);
    return res.status(500).json({ error: "internal" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend Pix do checkout Sélah (Bíblia de Estudo Para o Cotidiano da Mulher) rodando na porta ${PORT}`);
  if (!process.env.ADEX_PUBLIC_KEY || !process.env.ADEX_SECRET_KEY) {
    console.warn("⚠️  ADEX_PUBLIC_KEY / ADEX_SECRET_KEY não configurados.");
  }
  if (!process.env.UTMIFY_API_TOKEN) console.warn("⚠️  UTMIFY_API_TOKEN não configurado — vendas não vão pra UTMify.");
});
