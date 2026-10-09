/**
 * Vercel Serverless Function: Indokoin withdraw proxy (forwarder).
 *
 * Supplier: https://cuan.indokoinstore.com (tenant 444666 / INDOKOIN)
 * API-nya identik dengan zenithplay — beda SUPPLIER_BASE saja.
 *
 * POST /api/indokoin-order { royal_id, amount }
 *   1. submit async ke proxy  -> POST /api/withdraw      => { order_id }
 *   2. polling status          -> GET  /api/withdraw/:id  sampai terminal
 *   3. kembalikan data withdrawal ke frontend.
 *
 * GET /api/indokoin-order?order_id=xxx
 *   -> live status dari supplier (untuk polling popup frontend)
 *
 * Env:
 *   INDOKOIN_PROXY_URL   mis. http://104.245.34.139:8789 (tanpa trailing slash)
 *   INDOKOIN_PROXY_KEY   sama dengan API_KEY di /opt/indokoin-withdraw/.env
 */

const PROXY_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 1000;
const POLL_BUDGET_MS = 50000;

const ALLOWED_ORIGINS = [
  'https://neoparty.web.id',
  'http://localhost:3000',
  'http://localhost:5173',
];

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function proxyFetch(proxyUrl, proxyKey, path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const r = await fetch(`${proxyUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': proxyKey,
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const PROXY_URL = (process.env.INDOKOIN_PROXY_URL || '').replace(/\/$/, '');
  const PROXY_KEY = process.env.INDOKOIN_PROXY_KEY || '';
  if (!PROXY_URL || !PROXY_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Proxy belum dikonfigurasi (INDOKOIN_PROXY_URL / INDOKOIN_PROXY_KEY).',
    });
  }

  // ---- GET: live status untuk polling popup ----
  if (req.method === 'GET') {
    const orderId = String((req.query && req.query.order_id) || '').trim();
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'order_id wajib.' });
    }
    try {
      const g = await proxyFetch(PROXY_URL, PROXY_KEY,
        `/api/withdraw/${encodeURIComponent(orderId)}`);
      const order = g.data && g.data.order;
      if (!order) {
        return res.status(404).json({ success: false, error: 'order tidak ditemukan.' });
      }
      let live = null;
      if (order.status === 'SUCCESS' && order.result && order.result.withdrawal_id) {
        const s = await proxyFetch(PROXY_URL, PROXY_KEY,
          `/api/withdraw/${encodeURIComponent(orderId)}/status`);
        live = s.data && s.data.live;
      }
      return res.status(200).json({
        success: true,
        order_status: order.status,
        withdrawal: order.result || null,
        live,
      });
    } catch (e) {
      return res.status(502).json({ success: false, error: 'Proxy tidak merespon.' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const royalId = String((body && body.royal_id) || '').trim();
  const amount = String((body && body.amount) || '').trim().toUpperCase();
  if (!/^\d{3,20}$/.test(royalId)) {
    return res.status(400).json({ success: false, error: 'Format Royal ID tidak valid.' });
  }
  if (!/^([1-9]|10|20)B$/.test(amount)) {
    return res.status(400).json({ success: false, error: 'Jumlah tidak valid (1B-10B, 20B).' });
  }

  try {
    const sub = await proxyFetch(PROXY_URL, PROXY_KEY, '/api/withdraw', {
      method: 'POST',
      body: JSON.stringify({ royal_id: royalId, amount }),
    });
    const orderId = sub.data && sub.data.order_id;
    if (!orderId) {
      return res.status(502).json({
        success: false,
        error: (sub.data && sub.data.error) || 'Gagal membuat penarikan di proxy.',
      });
    }

    const deadline = Date.now() + POLL_BUDGET_MS;
    let order = null;
    while (Date.now() < deadline) {
      const g = await proxyFetch(PROXY_URL, PROXY_KEY,
        `/api/withdraw/${encodeURIComponent(orderId)}`);
      order = g.data && g.data.order;
      if (order && ['SUCCESS', 'FAILED', 'MANUAL_VERIFICATION_REQUIRED',
                    'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(order.status)) {
        break;
      }
      order = order || { status: 'PROCESSING' };
      await sleep(POLL_INTERVAL_MS);
    }

    if (order && order.status === 'SUCCESS' && order.result) {
      return res.status(200).json({ success: true, order_id: orderId, withdrawal: order.result });
    }
    if (order && order.status === 'MANUAL_VERIFICATION_REQUIRED') {
      return res.status(502).json({
        success: false, order_id: orderId,
        error: 'Supplier butuh verifikasi manual. Coba lagi beberapa saat.',
      });
    }
    if (order && ['FAILED', 'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(order.status)) {
      return res.status(502).json({
        success: false, order_id: orderId,
        error: order.error || 'Gagal membuat penarikan.',
      });
    }
    return res.status(202).json({
      success: false, pending: true, order_id: orderId,
      error: 'Penarikan masih diproses. Tunggu sebentar lalu coba lagi.',
    });
  } catch (e) {
    return res.status(502).json({
      success: false,
      error: 'Tidak bisa menghubungi proxy withdraw. Pastikan service proxy jalan.',
    });
  }
};
