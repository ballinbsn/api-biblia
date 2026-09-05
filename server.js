import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const PINPAY_BASE = "https://api.usepinpay.com/functions/v1/api-v1";
const UTMIFY_ORDERS_URL = "https://api.utmify.com.br/api-credentials/orders";

// CORS liberado pra qualquer origem — por decisão do projeto, sem restrição de domínio.
app.use(cors());

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

// Extrai nosso order_id (SLH...) de qualquer string (description / product_name).
function extractOrderId(s) {
  const m = String(s || "").match(/\b(SLH[A-Za-z0-9]+)\b/);
  return m ? m[1] : null;
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

/* ================================================================== */
/* UTMify — envio de pedidos (rastreio de venda + conversão pro Meta).
   1 pedido é enviado em "waiting_payment" quando o Pix é gerado e
   atualizado pro status final ("paid" / "refused" / "refunded") usando
   o MESMO orderId. A UTMify só dispara Purchase pro Meta no "paid".

   O pedido fica guardado em memória por 24h, indexado pelo nosso orderId
   (SLH...). A PinPay usa IDs diferentes em cada lugar (id da criação,
   transaction_id no webhook, id na lista de transações), então indexamos
   também o id do Pix e sempre conseguimos achar o pedido pelo orderId,
   que aparece na descrição da cobrança. */
const PAID_STATUSES = new Set([
  "paid", "pago", "approved", "aprovado", "completed", "concluido", "concluída", "concluida",
  "confirmed", "confirmado", "success", "sucesso", "payed", "authorized", "settled", "captured",
]);
const ordersById = new Map(); // orderId (SLH...) -> rec
const pixToOrder = new Map(); // id do Pix (criação) -> orderId

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of ordersById) if ((v.ts || 0) < cutoff) ordersById.delete(k);
  for (const [k, oid] of pixToOrder) if (!ordersById.has(oid)) pixToOrder.delete(k);
}, 60 * 60 * 1000).unref?.();

function findRec({ orderId, pixId, description } = {}) {
  return (
    (orderId && ordersById.get(orderId)) ||
    (pixId && pixToOrder.has(pixId) && ordersById.get(pixToOrder.get(pixId))) ||
    (extractOrderId(description) && ordersById.get(extractOrderId(description))) ||
    null
  );
}

// Reconstrói o pedido a partir do metadata gravado na cobrança PinPay — pra
// quando o pedido não está mais em memória (restart/deploy no meio do checkout).
function recFromMeta(meta) {
  meta = meta || {};
  const orderId = meta.order_id || meta.external_reference;
  if (!orderId) return null;
  const rec = {
    orderId,
    createdAt: meta.created_at || utmifyDate(),
    ts: Date.now(),
    product: meta.product || "Bíblia de Estudo Para o Cotidiano da Mulher",
    amountCents: Number(meta.amount_cents) || 0,
    customer: {
      name: meta.customer_name || "",
      email: meta.customer_email || "",
      phone: onlyDigits(meta.customer_phone) || null,
      document: onlyDigits(meta.customer_cpf) || null,
      ip: meta.client_ip || null,
    },
    tracking: {
      src: meta.src || null, sck: meta.sck || null,
      utm_source: meta.utm_source || null, utm_campaign: meta.utm_campaign || null,
      utm_medium: meta.utm_medium || null, utm_content: meta.utm_content || null,
      utm_term: meta.utm_term || null,
    },
    utmifySent: new Set(),
  };
  ordersById.set(orderId, rec);
  return rec;
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
    platform: "PinPay",
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
      console.error("[utmify] pedido falhou", status, rec.orderId, r.status, await r.text().catch(() => ""));
    } else {
      console.log("[utmify] pedido enviado", status, rec.orderId);
    }
  } catch (e) {
    rec.utmifySent.delete(status);
    console.error("[utmify] exceção ao enviar pedido", e.message);
  }
}

/* ------------------------------------------------------------------ */
/* O webhook precisa do corpo "cru" (raw) pra validar o HMAC — por isso
   express.raw() e vem ANTES do express.json() global. */
app.post("/api/webhooks/pinpay", express.raw({ type: "application/json" }), async (req, res) => {
  if (!process.env.PINPAY_WEBHOOK_SECRET) {
    console.error("[pinpay webhook] PINPAY_WEBHOOK_SECRET não configurado no ambiente");
    return res.status(500).end();
  }

  const signature = req.headers["x-webhook-signature"];
  if (!signature) return res.status(401).end();

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", process.env.PINPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  const valid =
    sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  if (!valid) {
    console.warn("[pinpay webhook] assinatura inválida, ignorando");
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).end();
  }

  res.status(200).end(); // responde rápido; processa depois

  const { event, data } = payload || {};
  // deriva o nosso orderId de onde der: metadata, external_reference, ou a
  // descrição/product_name (que contém "... - Pedido SLH...").
  const orderId =
    data?.metadata?.order_id ||
    data?.external_reference ||
    extractOrderId(data?.product_name) ||
    extractOrderId(data?.description) ||
    null;
  const pixId = data?.transaction_id || data?.id || null;
  // TEMP: aprende o formato do payload do webhook.
  console.log("[pinpay webhook] payload", JSON.stringify(payload).slice(0, 1500));

  let rec =
    findRec({ orderId, pixId, description: data?.product_name || data?.description }) ||
    recFromMeta(data?.metadata);
  if (!rec && orderId) {
    // não está mais em memória (restart) — monta o mínimo pelo payload do webhook.
    rec = {
      orderId,
      createdAt: utmifyDate(),
      ts: Date.now(),
      product: data?.product_name || "Bíblia de Estudo Para o Cotidiano da Mulher",
      amountCents: Number(data?.amount) || 0,
      customer: {
        name: data?.customer_name || "",
        email: data?.customer_email || "",
        phone: onlyDigits(data?.customer_phone) || null,
        document: onlyDigits(data?.customer_document) || null,
        ip: null,
      },
      tracking: {},
      utmifySent: new Set(),
    };
    ordersById.set(orderId, rec);
  }

  console.log("[pinpay webhook]", event, { orderId, pixId, hasRec: !!rec, amount: data?.amount });

  switch (event) {
    case "payment_approved":
      if (rec) await sendUtmifyOrder(rec, "paid", utmifyDate());
      else console.warn("[pinpay webhook] PAGO sem rec — não deu pra avisar a UTMify", { orderId, pixId });
      break;
    case "payment_failed":
      if (rec) await sendUtmifyOrder(rec, "refused");
      break;
    case "payment_refunded":
      if (rec) await sendUtmifyOrder(rec, "refunded");
      break;
    default:
      break;
  }
});
/* ------------------------------------------------------------------ */

app.use(express.json());

// Cria a cobrança Pix pro pedido
app.post("/api/pay", async (req, res) => {
  if (!process.env.PINPAY_TOKEN) {
    console.error("[pinpay] PINPAY_TOKEN não configurado no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const { product, amountReais, customer, address, tracking, checkoutUrl } = req.body || {};

  const amount = Math.round(Number(amountReais) * 100);
  if (!Number.isInteger(amount) || amount < 100) return res.status(400).json({ error: "amount_invalid" });
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

  const enderecoResumo =
    `${address.rua || ""}, ${address.numero || "s/n"}` +
    (address.complemento ? ` - ${address.complemento}` : "") +
    (address.bairro ? ` - ${address.bairro}` : "") +
    `, ${address.cidade}/${address.uf} - CEP ${onlyDigits(address.cep)}`;

  try {
    const r = await fetch(`${PINPAY_BASE}/pix`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.PINPAY_TOKEN,
        "Content-Type": "application/json",
        "Idempotency-Key": orderId,
      },
      body: JSON.stringify({
        amount,
        description: `${product} - Pedido ${orderId}`,
        customer: { name, email, document: { type: "CPF", number: cpf }, phone },
        expires_in: 900,
        webhook_url: process.env.PINPAY_WEBHOOK_URL,
        metadata: {
          external_reference: orderId,
          order_id: orderId,
          checkout_url: checkoutUrl || "",
          created_at: createdAt,
          product,
          amount_cents: String(amount),
          endereco: enderecoResumo,
          customer_name: name,
          customer_email: email,
          customer_phone: phone,
          customer_cpf: cpf,
          client_ip: ip || "",
          src: t.src || "",
          sck: t.sck || "",
          utm_source: t.utm_source || "",
          utm_campaign: t.utm_campaign || "",
          utm_medium: t.utm_medium || "",
          utm_content: t.utm_content || "",
          utm_term: t.utm_term || "",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error("[pinpay] falha ao criar cobrança", r.status, err);
      // TEMP-DEBUG: expõe o erro real da PinPay na resposta pra diagnosticar
      // o 502 na primeira ativação. Remover assim que confirmarmos a causa.
      return res.status(502).json({ error: "gateway_error", debug: { status: r.status, body: err } });
    }

    const pix = await r.json();
    const pixId = pix.id || pix.transaction_id || pix.pix?.id || null;
    // TEMP: aprende o formato de id que a PinPay devolve na criação.
    console.log("[pinpay] cobrança criada", { orderId, pixId, keys: Object.keys(pix || {}) });

    const rec = {
      orderId,
      createdAt,
      ts: Date.now(),
      product,
      amountCents: amount,
      customer: { name, email, phone, document: cpf, ip },
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
    if (pixId) pixToOrder.set(pixId, orderId);

    sendUtmifyOrder(rec, "waiting_payment").catch(() => {});

    return res.status(201).json({
      pix_id: pixId,
      qr_code: pix.pix?.qr_code,
      qr_code_url: pix.pix?.qr_code_url,
      expires_at: pix.pix?.expires_at,
      order_id: orderId,
    });
  } catch (e) {
    console.error("[pinpay] exceção ao criar cobrança", e);
    return res.status(500).json({ error: "internal" });
  }
});

// O frontend consulta esse endpoint a cada poucos segundos.
// Aceita ?id=<pix id> e/ou ?oid=<order id SLH...>.
app.get("/api/pix-status", async (req, res) => {
  if (!process.env.PINPAY_TOKEN) {
    console.error("[pinpay] PINPAY_TOKEN não configurado no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const id = typeof req.query?.id === "string" ? req.query.id : "";
  const oid = typeof req.query?.oid === "string" ? req.query.oid : "";
  if (!/^[A-Za-z0-9_-]+$/.test(id || oid || "")) return res.status(400).json({ error: "id_invalid" });

  try {
    const r = await fetch(`${PINPAY_BASE}/transactions?limit=50`, {
      headers: { Authorization: "Bearer " + process.env.PINPAY_TOKEN },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error("[pinpay] falha ao consultar status", r.status, JSON.stringify(err));
      return res.status(502).json({ error: "gateway_error" });
    }

    const list = await r.json();
    const items = list.data || list.transactions || (Array.isArray(list) ? list : []);
    const tx = items.find((x) => {
      const cands = [x.id, x.transaction_id, x.external_reference, x.metadata?.order_id, x.pix?.id].map(String);
      const desc = String(x.description || x.product_name || "");
      return (
        (id && cands.includes(id)) ||
        (oid && (cands.includes(oid) || desc.includes(oid))) ||
        (id && desc.includes(id))
      );
    });

    if (!tx) return res.status(200).json({ status: "pending", expires_at: null });

    const status = String(tx.status || "").toLowerCase();
    if (PAID_STATUSES.has(status)) {
      const rec =
        findRec({
          orderId: oid || tx.metadata?.order_id || tx.external_reference,
          pixId: id || tx.id,
          description: tx.description || tx.product_name,
        }) || recFromMeta(tx.metadata);
      if (rec) sendUtmifyOrder(rec, "paid", utmifyDate()).catch(() => {});
      else console.warn("[pinpay] pago no polling mas sem rec", { id, oid, txKeys: Object.keys(tx || {}) });
    }

    return res.status(200).json({ status: tx.status, expires_at: tx.pix?.expires_at ?? null });
  } catch (e) {
    console.error("[pinpay] exceção ao consultar status", e);
    return res.status(500).json({ error: "internal" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend Pix do checkout Sélah (Bíblia de Estudo Para o Cotidiano da Mulher) rodando na porta ${PORT}`);
  if (!process.env.PINPAY_TOKEN) console.warn("⚠️  PINPAY_TOKEN não configurado.");
  if (!process.env.UTMIFY_API_TOKEN) console.warn("⚠️  UTMIFY_API_TOKEN não configurado — vendas não vão pra UTMify.");
});
