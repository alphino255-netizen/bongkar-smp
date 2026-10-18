/**
 * Vercel Serverless Function: KINGS withdraw proxy (forwarder).
 *
 * Supplier: https://bongkarcuan.kingshop.live (tenant 333888 / KINGS)
 * API-nya identik dengan zenithplay — beda SUPPLIER_BASE saja.
 *
 * POST /api/kings-order { royal_id, amount }
 *   1. submit async ke proxy  -> POST /api/withdraw      => { order_id }
 *   2. polling status          -> GET  /api/withdraw/:id  sampai terminal
 *   3. kembalikan data withdrawal ke frontend.
 *
 * GET /api/kings-order?order_id=xxx
 *   -> live status dari supplier (untuk polling popup frontend)
 *
 * Env:
 *   KINGS_PROXY_URL   mis. https://xxx.trycloudflare.com (tanpa trailing slash)
 *   KINGS_PROXY_KEY   sama dengan API_KEY di C:/kings (.bat)
 *   BLOCKED_IPS          daftar IP diblokir, pisahkan koma (opsional)
 *   BLOCKED_ROYAL_IDS    daftar royal_id diblokir, pisahkan koma (opsional)
 *   KV_REST_API_URL      otomatis dari Vercel KV (untuk rate-limit otomatis)
 *   KV_REST_API_TOKEN    otomatis dari Vercel KV
 *   RL_MAX_FAILS         batas gagal beruntun sebelum auto-blokir (default 5)
 *   ID_CHECK_ENABLED     '0' untuk mematikan cek ID player (default nyala)
 *   NEO_CHECK_SIG        override signature cek ID (default bawaan neoparty)
 */

const crypto = require('crypto');

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

// --- ANTI-SPAM: blokir IP / royal_id via env ---
const BLOCKED_IPS = (process.env.BLOCKED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const BLOCKED_ROYALS = (process.env.BLOCKED_ROYAL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return fwd.split(',')[0].trim();
}

// --- RATE LIMIT OTOMATIS via Vercel KV (Upstash REST, tanpa dependency) ---
// royal_id yang gagal beruntun >= RL_MAX_FAILS tanpa 1 pun sukses -> diblokir
// otomatis 24 jam. Sukses 1x me-reset hitungan. Gagal konek KV = fail-open.
const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const RL_MAX_FAILS = parseInt(process.env.RL_MAX_FAILS || '5', 10);
const RL_WINDOW_S = 3600;   // hitungan gagal kedaluwarsa 1 jam (sliding)
const RL_BLOCK_S = 86400;   // durasi blokir otomatis 24 jam

async function kv(cmd, ...args) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(
      `${KV_URL}/${cmd}/${args.map((a) => encodeURIComponent(a)).join('/')}`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } }
    );
    const j = await r.json().catch(() => null);
    return j && j.result !== undefined ? j.result : null;
  } catch (e) {
    console.log('[kv] error:', e.message);
    return null;
  }
}

async function rlRecord(royalId, success) {
  if (!royalId || !KV_URL) return;
  const pkey = `rl:pending:${royalId}`;
  if (success) {
    await kv('DEL', pkey);
    return;
  }
  const fails = await kv('INCR', pkey);
  await kv('EXPIRE', pkey, String(RL_WINDOW_S));
  if (fails !== null && Number(fails) >= RL_MAX_FAILS) {
    await kv('SET', `rl:blocked:${royalId}`, '1', 'EX', String(RL_BLOCK_S));
    console.log(`[rl] auto-block royal_id=${royalId} fails=${fails}`);
  }
}

// --- CEK ID PLAYER via endpoint neoparty (sebelum order diteruskan ke proxy) ---
// GET https://neo-ack.theneoparty.com/agent_recharge/order/info?player_id=X&product_id=1
// header Signature: MD5("player_id=X&product_id=1&signature={SIG}")
// En=0 + Data -> valid | En=656/182 -> ID tidak ada | selain itu -> fail-open (lanjut seperti biasa)
// Hasil valid di-cache 24 jam, invalid 1 jam (via KV; tanpa KV = cek live tiap order).
const ID_CHECK_ENABLED = (process.env.ID_CHECK_ENABLED || '1') !== '0';
const ID_CHECK_SIG = process.env.NEO_CHECK_SIG || '7d83ac6f236288c720d7f4f4109a0776';
const ID_CHECK_TIMEOUT_MS = 8000;

async function checkPlayerId(playerId) {
  const cpos = await kv('GET', `idcheck:${playerId}`);
  if (cpos === '1') return { valid: true, cached: true };
  const cneg = await kv('GET', `idcheckneg:${playerId}`);
  if (cneg === '1') return { valid: false, cached: true };
  try {
    const sig = crypto.createHash('md5')
      .update(`player_id=${playerId}&product_id=1&signature=${ID_CHECK_SIG}`)
      .digest('hex');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ID_CHECK_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(
        `https://neo-ack.theneoparty.com/agent_recharge/order/info` +
        `?player_id=${encodeURIComponent(playerId)}&product_id=1`,
        { headers: { 'Accept': 'application/json', 'Signature': sig }, signal: ctrl.signal }
      );
    } finally {
      clearTimeout(t);
    }
    const m = await res.json().catch(() => null);
    if (!m || typeof m.En === 'undefined') return { valid: null };
    if (m.En === 0 && m.Data) {
      await kv('SET', `idcheck:${playerId}`, '1', 'EX', '86400');
      return { valid: true, nick: (m.Data && m.Data.player_nick) || null };
    }
    if (m.En === 656 || m.En === 182) {
      await kv('SET', `idcheckneg:${playerId}`, '1', 'EX', '3600');
      return { valid: false };
    }
    console.log(`[idcheck] unexpected En=${m.En} untuk ${playerId} -> fail-open`);
    return { valid: null };
  } catch (e) {
    console.log('[idcheck] error:', e.message, '-> fail-open');
    return { valid: null };
  }
}

// Field bank/akun server-side (dari .env proxy) TIDAK boleh bocor ke browser.
// Frontend hanya butuh: coin, nominal, fee, expires_at, withdrawal_id,
// tenant_royal_id/tenant_username (tujuan kirim coin).
const SENSITIVE_KEYS = ['account_name', 'account_number', 'bank_name', 'bank_code'];
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_KEYS.includes(k)) continue;
    out[k] = sanitize(obj[k]);
  }
  return out;
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- ANTI-SPAM: tolak IP terblokir ---
  const ip = clientIp(req);
  console.log(`[order] ${req.method} ip=${ip}`);
  if (ip && BLOCKED_IPS.includes(ip)) {
    return res.status(403).json({ success: false, error: 'Coba lagi nanti.' });
  }

  const PROXY_URL = (process.env.KINGS_PROXY_URL || '').replace(/\/$/, '');
  const PROXY_KEY = process.env.KINGS_PROXY_KEY || '';
  if (!PROXY_URL || !PROXY_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Proxy belum dikonfigurasi (KINGS_PROXY_URL / KINGS_PROXY_KEY).',
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
        withdrawal: sanitize(order.result || null),
        live: sanitize(live),
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
  // --- ANTI-SPAM: tolak royal_id terblokir ---
  if (BLOCKED_ROYALS.includes(royalId)) {
    return res.status(403).json({ success: false, error: 'Coba lagi nanti.' });
  }
  // --- ANTI-SPAM OTOMATIS: tolak royal_id yang kena auto-blokir ---
  const autoBlocked = await kv('GET', `rl:blocked:${royalId}`);
  if (autoBlocked) {
    return res.status(403).json({ success: false, error: 'Tereteksi spam, Akses diblokir sementara.' });
  }
  if (!/^([1-9]|10|20)B$/.test(amount)) {
    return res.status(400).json({ success: false, error: 'Jumlah tidak valid (1B-10B, 20B).' });
  }

  // --- CEK ID PLAYER: tolak ID yang tidak terdaftar di game ---
  if (ID_CHECK_ENABLED) {
    const chk = await checkPlayerId(royalId);
    if (chk.valid === false) {
      await rlRecord(royalId, false); // ID invalid ikut hitung auto-blokir spam
      return res.status(400).json({ success: false, error: 'Error, ID akun anda tidak valid' });
    }
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

    const ok = !!(order && order.status === 'SUCCESS' && order.result);
    await rlRecord(royalId, ok); // sukses -> reset; gagal -> hitung + auto-blokir

    if (ok) {
      return res.status(200).json({ success: true, order_id: orderId, withdrawal: sanitize(order.result) });
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
