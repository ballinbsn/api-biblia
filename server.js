import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;
const ONYXPAG_BASE = "https://api.onyxpag.com";
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

function formatCPF(digits) {
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
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

// Basic Auth exigido pela OnyxPag: base64("chave_publica:chave_privada").
function onyxpagAuthHeader() {
  const raw = `${process.env.ONYXPAG_PUBLIC_KEY || ""}:${process.env.ONYXPAG_PRIVATE_KEY || ""}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

/* ================================================================== */
/* UTMify — envio de pedidos (rastreio de venda + conversão pro Meta).
   1 pedido é enviado em "waiting_payment" quando o Pix é gerado e
   atualizado pro status final ("paid" / "refused" / "refunded") usando
   o MESMO orderId. A UTMify só dispara Purchase pro Meta no "paid".

   O pedido fica guardado em memória por 24h, indexado pelo nosso orderId
   (SLH...), que também é mandado pra OnyxPag em metadata.order_id — ela
   devolve isso como "external_ref" (na criação) ou "external_id" (no
   webhook), então sempre conseguimos religar a transação da OnyxPag ao
   nosso pedido. */
const PAID_STATUSES = new Set(["pago", "paid", "aprovado", "approved"]);
const FAILED_STATUSES = new Set(["expirado", "expired", "cancelado", "canceled", "cancelled"]);
const ordersById = new Map(); // orderId (SLH...) -> rec

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of ordersById) if ((v.ts || 0) < cutoff) ordersById.delete(k);
}, 60 * 60 * 1000).unref?.();

async function sendUtmifyOrder(rec, status, approvedDate = null) {
  if (!process.env.UTMIFY_API_TOKEN) return;
  if (!rec || !rec.orderId) return;
  rec.utmifySent = rec.utmifySent || new Set();
  if (rec.utmifySent.has(status)) return;
  rec.utmifySent.add(status);

  const t = rec.tracking || {};
  const payload = {
    orderId: rec.orderId,
    platform: "OnyxPag",
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

// Consulta a transação DIRETO na OnyxPag, com nossas próprias credenciais.
// É a única fonte de verdade sobre status de pagamento — o webhook (abaixo)
// não tem assinatura pra validar, então ele só dispara essa consulta em vez
// de ser confiado diretamente. Retorna null se não achar/erro.
async function fetchOnyxpagTransaction(transactionId) {
  const r = await fetch(`${ONYXPAG_BASE}?id=${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: onyxpagAuthHeader() },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.success || !body?.data) {
    // TEMP-DEBUG: loga o corpo pra diagnosticar por que a consulta falhou.
    console.error("[onyxpag] falha ao consultar transação", transactionId, r.status, JSON.stringify(body).slice(0, 500));
    return null;
  }
  return body.data;
}

// Depois de confirmar (via fetchOnyxpagTransaction) que uma transação está
// paga de verdade, avisa a UTMify. Reconstrói o registro pelo external_ref
// se o pedido não estiver mais em memória (restart no meio do checkout).
async function handleConfirmedStatus(tx) {
  if (!tx) return;
  const orderId = tx.external_ref || tx.external_id || null;
  let rec = orderId ? ordersById.get(orderId) : null;
  if (!rec && orderId) {
    rec = {
      orderId,
      createdAt: tx.created_at || utmifyDate(),
      ts: Date.now(),
      product: tx.items?.[0]?.title || "Bíblia de Estudo Para o Cotidiano da Mulher",
      amountCents: Math.round(parseFloat(tx.amount || "0") * 100),
      customer: {
        name: tx.customer?.name || "",
        email: tx.customer?.email || "",
        phone: onlyDigits(tx.customer?.phone) || null,
        document: onlyDigits(tx.customer?.document) || null,
        ip: null,
      },
      tracking: {},
      utmifySent: new Set(),
    };
    ordersById.set(orderId, rec);
  }
  if (!rec) {
    console.warn("[onyxpag] status confirmado sem conseguir religar ao pedido", tx.id);
    return;
  }

  const status = String(tx.status || "").toLowerCase();
  if (PAID_STATUSES.has(status)) {
    await sendUtmifyOrder(rec, "paid", utmifyDate());
  } else if (FAILED_STATUSES.has(status)) {
    await sendUtmifyOrder(rec, status.startsWith("cancel") ? "refused" : "refused");
  }
}

// Webhook da OnyxPag. ATENÇÃO: a doc da OnyxPag não define nenhuma
// assinatura/HMAC pra provar que a chamada veio mesmo dela — então NUNCA
// confiamos direto no "status" que vier no corpo. Usamos o webhook só como
// aviso pra ir conferir; quem decide é sempre a consulta autenticada acima.
app.post("/api/webhooks/onyxpag", async (req, res) => {
  res.status(200).end(); // responde rápido; processa depois

  const { event, data } = req.body || {};
  const transactionId = data?.transaction_id || data?.id || null;
  console.log("[onyxpag webhook]", event, { transactionId, external: data?.external_id });
  if (!transactionId) return;

  const tx = await fetchOnyxpagTransaction(transactionId);
  if (!tx) {
    console.warn("[onyxpag webhook] não confirmou a transação na consulta, ignorando", transactionId);
    return;
  }
  await handleConfirmedStatus(tx);
});

// Cria a cobrança Pix pro pedido
app.post("/api/pay", async (req, res) => {
  if (!process.env.ONYXPAG_PUBLIC_KEY || !process.env.ONYXPAG_PRIVATE_KEY) {
    console.error("[onyxpag] ONYXPAG_PUBLIC_KEY/ONYXPAG_PRIVATE_KEY não configurados no ambiente");
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
  // source_url é obrigatório pra OnyxPag — precisa ser a página real do
  // checkout, nunca um valor fixo. Sem isso nem tenta chamar a API.
  const sourceUrl = String(checkoutUrl || "").trim();
  if (!/^https?:\/\//i.test(sourceUrl)) return res.status(400).json({ error: "source_url_invalid" });

  const orderId = "SLH" + Date.now() + Math.random().toString(36).slice(2, 7);
  const createdAt = utmifyDate();
  const ip = clientIp(req);
  const t = tracking || {};

  try {
    const r = await fetch(ONYXPAG_BASE, {
      method: "POST",
      headers: {
        Authorization: onyxpagAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Valor total em REAIS (decimal) — a OnyxPag usa esse formato aqui,
        // diferente de items[].unitPrice logo abaixo, que é em CENTAVOS.
        amount: Number((amountCents / 100).toFixed(2)),
        payment_method: "pix",
        source_url: sourceUrl,
        source_label: product,
        description: `${product} - Pedido ${orderId}`,
        items: [
          {
            title: product,
            unitPrice: amountCents,
            quantity: 1,
            tangible: true,
          },
        ],
        customer: {
          name,
          email,
          document: formatCPF(cpf),
          phone,
        },
        postbackUrl: process.env.ONYXPAG_WEBHOOK_URL,
        metadata: {
          order_id: orderId,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body?.success || !body?.data) {
      console.error("[onyxpag] falha ao criar cobrança", r.status, JSON.stringify(body).slice(0, 800));
      return res.status(502).json({ error: "gateway_error" });
    }

    const pix = body.data;
    console.log("[onyxpag] cobrança criada", { orderId, transactionId: pix.id, status: pix.status });

    // Endereço de entrega fica só com a gente — a OnyxPag não pede isso pra
    // processar o Pix, mas precisamos guardar pra despachar o livro depois.
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

    sendUtmifyOrder(rec, "waiting_payment").catch(() => {});

    return res.status(201).json({
      pix_id: pix.id,
      qr_code: pix.pix_code,
      qr_code_image: pix.pix_qr_code || null,
      expires_at: pix.expires_at,
      order_id: orderId,
    });
  } catch (e) {
    console.error("[onyxpag] exceção ao criar cobrança", e);
    return res.status(500).json({ error: "internal" });
  }
});

// O frontend consulta esse endpoint a cada poucos segundos. É a fonte de
// verdade principal (webhook sem assinatura só complementa, nunca decide
// sozinho). Aceita ?id=<transaction id>.
app.get("/api/pix-status", async (req, res) => {
  if (!process.env.ONYXPAG_PUBLIC_KEY || !process.env.ONYXPAG_PRIVATE_KEY) {
    console.error("[onyxpag] ONYXPAG_PUBLIC_KEY/ONYXPAG_PRIVATE_KEY não configurados no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const id = typeof req.query?.id === "string" ? req.query.id : "";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "id_invalid" });

  try {
    const r = await fetch(`${ONYXPAG_BASE}?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: onyxpagAuthHeader() },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.success || !body?.data) {
      // TEMP-DEBUG: devolve o erro real pra diagnosticar a consulta de status.
      return res.status(200).json({ status: "pending", expires_at: null, debug: { httpStatus: r.status, body } });
    }

    const tx = body.data;
    await handleConfirmedStatus(tx);

    return res.status(200).json({ status: tx.status, expires_at: tx.expires_at ?? null });
  } catch (e) {
    console.error("[onyxpag] exceção ao consultar status", e);
    return res.status(500).json({ error: "internal" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend Pix do checkout Sélah (Bíblia de Estudo Para o Cotidiano da Mulher) rodando na porta ${PORT}`);
  if (!process.env.ONYXPAG_PUBLIC_KEY || !process.env.ONYXPAG_PRIVATE_KEY) {
    console.warn("⚠️  ONYXPAG_PUBLIC_KEY / ONYXPAG_PRIVATE_KEY não configurados.");
  }
  if (!process.env.UTMIFY_API_TOKEN) console.warn("⚠️  UTMIFY_API_TOKEN não configurado — vendas não vão pra UTMify.");
});
