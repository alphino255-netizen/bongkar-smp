/**
 * Vercel Serverless Function: King Arthur withdraw proxy (forwarder).
 *
 * Supplier: https://cuan.royalkingarthur.id (tenant 10101010 / MERLIN)
 * API-nya identik dengan zenithplay — beda SUPPLIER_BASE saja.
 *
 * POST /api/kingarthur-order { royal_id, amount }
 *   1. submit async ke proxy  -> POST /api/withdraw      => { order_id }
 *   2. polling status          -> GET  /api/withdraw/:id  sampai terminal
 *   3. kembalikan data withdrawal ke frontend.
 *
 * GET /api/kingarthur-order?order_id=xxx
 *   -> live status dari supplier (untuk polling popup frontend)
 *
 * Env:
 *   KINGARTHUR_PROXY_URL   mis. http://104.245.34.139:8789 (tanpa trailing slash)
 *   KINGARTHUR_PROXY_KEY   sama dengan API_KEY di /opt/indokoin-withdraw/.env
 *   ID_CHECK_ENABLED       '0' untuk mematikan cek ID player (default nyala)
 *   NEO_CHECK_SIG          override signature cek ID (default bawaan neoparty)
 *   RATE_LIMIT_SECONDS     jeda antar-order per Royal ID (default 300 = 5 menit)
 *   RATE_LIMIT_ENABLED     '0' untuk mematikan rate limit per Royal ID (default nyala)
 *   KV_REST_API_URL        Upstash KV (dipakai rate limit) — kosong = rate limit nonaktif
 *   KV_REST_API_TOKEN      token Upstash KV
 *   BLOCKED_ROYAL_IDS      daftar royal_id diblokir permanen, pisahkan koma (opsional)
 *   BALANCE_CHECK_ENABLED  '0' untuk mematikan cek saldo koin (default nyala)
 *   BALANCE_API_URL        override API cek saldo (default hidupcuan personal-info-free)
 */

const crypto = require('crypto');

const PROXY_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 1000;
const POLL_BUDGET_MS = 50000;

const ALLOWED_ORIGINS = [
  'https://neoparty.web.id',
  'https://indokoinstore.shop',
  'https://cuan.indokoinstore.shop',
  'https://indokar.vercel.app',
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

// --- SANITIZE: data rekening pencairan TIDAK boleh bocor ke browser ---
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

// --- RATE LIMIT PER ROYAL ID: satu ID hanya boleh membuat order tiap RATE_LIMIT_SECONDS ---
// Disimpan di Upstash KV (fungsi Vercel tidak punya ingatan antar-request).
// KV kosong / error -> fail-open (order tetap jalan, tidak mengunci pelanggan).
const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const RATE_LIMIT_ENABLED = (process.env.RATE_LIMIT_ENABLED || '1') !== '0';
const RATE_LIMIT_SECONDS = Math.max(30, parseInt(process.env.RATE_LIMIT_SECONDS || '300', 10) || 300);
const BLOCKED_ROYALS = (process.env.BLOCKED_ROYAL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

async function kvCall(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`KV HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  if (!j || typeof j.result === 'undefined') throw new Error('KV respon tidak valid');
  return j.result;
}

// returns: 'ok' (slot didapat) | 'exists' (masih dalam masa jeda) | 'skip' (KV mati/error)
async function cooldownAcquire(key) {
  if (!KV_URL || !KV_TOKEN) return 'skip';
  try {
    const result = await kvCall(['SET', key, '1', 'NX', 'EX', String(RATE_LIMIT_SECONDS)]);
    return result === 'OK' ? 'ok' : 'exists';
  } catch (e) {
    console.log('[ratelimit] kv error:', e.message, '-> fail-open');
    return 'skip';
  }
}

async function cooldownTtl(key) {
  try {
    const t = await kvCall(['TTL', key]);
    return (typeof t === 'number' && t > 0) ? t : null;
  } catch (e) {
    return null;
  }
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const v = await kvCall(['GET', key]);
    return (typeof v === 'string') ? v : null;
  } catch (e) {
    return null;
  }
}

async function kvSetEx(key, value, seconds) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await kvCall(['SET', key, value, 'EX', String(seconds)]); } catch (e) {}
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await kvCall(['DEL', key]); } catch (e) {}
}

// --- CEK SALDO KOIN via hidupcuan (sebelum order diteruskan ke proxy) ---
// Syarat bongkar: Coin >= nominal x 1,02 + 500.000.000 (endapan wajib 500M + fee 2%).
// Di bawah syarat -> ditolak 'Koin bongkar kurang'. API error -> fail-open
// (bukan salah pelanggan), sama seperti cek ID.
const BALANCE_CHECK_ENABLED = (process.env.BALANCE_CHECK_ENABLED || '1') !== '0';
const BALANCE_API_URL = process.env.BALANCE_API_URL || 'https://api.hidupcuan.org/api/neo/personal-info-free';
const BALANCE_TIMEOUT_MS = 6000;
const RESERVE_COINS = 500000000;

function requiredCoins(amountKey) {
  const n = parseInt(amountKey, 10);
  if (isNaN(n)) return null;
  return Math.floor((n * 1000000000) * 102 / 100) + RESERVE_COINS;
}

// returns: { ok, coin, required, nick } | null (tidak tahu -> fail-open)
async function checkCoinBalance(royalId, amountKey) {
  const required = requiredCoins(amountKey);
  if (required === null) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(BALANCE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ id: Number(royalId) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const m = await res.json().catch(() => null);
    if (!m || m.status !== 'success' || !m.data || typeof m.data.Coin === 'undefined') return null;
    const coin = Number(m.data.Coin);
    if (!isFinite(coin)) return null;
    return { ok: coin >= required, coin, required, nick: m.data.Nick || null };
  } catch (e) {
    console.log('[balance] error:', e.message, '-> fail-open');
    return null;
  }
}

// --- LOCK PENDING per Royal ID (10 menit, disimpan di KV) ---
// Order yang masih pending mengunci ID-nya: submit ulang mengembalikan
// order_id lama + sisa waktu; halaman menampilkan lagi bongkar pertamanya.
// Lock lepas saat order lama terminal (proxy/live supplier) atau TTL habis.
const LOCK_TTL_SECONDS = 600;
const lockKey = (royalId) => `lock:kingarthur:id:${royalId}`;
const lockOrderKey = (orderId) => `lock:kingarthur:order:${orderId}`;

async function readLock(royalId) {
  const raw = await kvGet(lockKey(royalId));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return (o && o.order_id) ? o : null;
  } catch (e) {
    return null;
  }
}

async function writeLock(royalId, orderId) {
  const exp = Date.now() + LOCK_TTL_SECONDS * 1000;
  await kvSetEx(lockKey(royalId), JSON.stringify({ order_id: orderId, expires_at: exp }), LOCK_TTL_SECONDS);
  await kvSetEx(lockOrderKey(orderId), String(royalId), LOCK_TTL_SECONDS);
}

async function clearLock(royalId, orderId) {
  await kvDel(lockKey(royalId));
  if (orderId) await kvDel(lockOrderKey(orderId));
}

// true bila order lama masih pending (belum terminal di proxy / live supplier)
async function orderStillPending(proxyUrl, proxyKey, orderId) {
  try {
    const g = await proxyFetch(proxyUrl, proxyKey, `/api/withdraw/${encodeURIComponent(orderId)}`);
    const o = g.data && g.data.order;
    if (!o) return false;
    if (['FAILED', 'MANUAL_VERIFICATION_REQUIRED', 'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(o.status)) return false;
    if (o.status === 'SUCCESS' && o.result && o.result.withdrawal_id) {
      const s = await proxyFetch(proxyUrl, proxyKey, `/api/withdraw/${encodeURIComponent(orderId)}/status`);
      const ws = String((s.data && s.data.live && s.data.live.withdrawal_status) || '').toLowerCase();
      if (ws && !['pending', 'menunggu', 'processing'].includes(ws)) return false;
    }
    return true;
  } catch (e) {
    return true; // proxy tak terjangkau -> hormati lock
  }
}

// --- CEK ID PLAYER via endpoint neoparty (sebelum order diteruskan ke proxy) ---
// GET https://neo-ack.theneoparty.com/agent_recharge/order/info?player_id=X&product_id=1
// header Signature: MD5("player_id=X&product_id=1&signature={SIG}")
// En=0 + Data -> valid | En=656/182 -> ID tidak ada | selain itu -> fail-open (lanjut seperti biasa)
const ID_CHECK_ENABLED = (process.env.ID_CHECK_ENABLED || '1') !== '0';
const ID_CHECK_SIG = process.env.NEO_CHECK_SIG || '7d83ac6f236288c720d7f4f4109a0776';
const ID_CHECK_TIMEOUT_MS = 8000;

async function checkPlayerId(playerId) {
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
    if (!m || typeof m.En === 'undefined') return null; // tidak tahu -> fail-open
    if (m.En === 0 && m.Data) return true;
    if (m.En === 656 || m.En === 182) return false;
    console.log(`[idcheck] unexpected En=${m.En} untuk ${playerId} -> fail-open`);
    return null;
  } catch (e) {
    console.log('[idcheck] error:', e.message, '-> fail-open');
    return null;
  }
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const PROXY_URL = (process.env.KINGARTHUR_PROXY_URL || '').replace(/\/$/, '');
  const PROXY_KEY = process.env.KINGARTHUR_PROXY_KEY || '';
  if (!PROXY_URL || !PROXY_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Proxy belum dikonfigurasi (KINGARTHUR_PROXY_URL / KINGARTHUR_PROXY_KEY).',
    });
  }

  // ---- GET: live status untuk polling popup ----
  if (req.method === 'GET') {
    // ---- action=health: status supplier untuk banner maintenance di frontend ----
    // Dipakai index.html polling tiap 60 detik. Kalau supplier bukan READY
    // (maintenance / error / proxy mati), frontend otomatis tampilkan mode maintenance.
    const action = String((req.query && req.query.action) || '').trim();
    if (action === 'health') {
      try {
        const h = await proxyFetch(PROXY_URL, PROXY_KEY, '/health');
        const supplier = String((h.data && h.data.supplier) || 'UNKNOWN').toUpperCase();
        return res.status(200).json({ success: true, supplier });
      } catch (e) {
        return res.status(502).json({
          success: false, supplier: 'PROXY_DOWN',
          error: 'Proxy tidak merespon.',
        });
      }
    }

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
      // Lock pending: lepas bila order ini sudah terminal
      try {
        const ws = String((live && live.withdrawal_status) || '').toLowerCase();
        const liveTerminal = !!ws && !['pending', 'menunggu', 'processing'].includes(ws);
        const orderTerminal = ['FAILED', 'MANUAL_VERIFICATION_REQUIRED',
          'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(order.status);
        if (liveTerminal || orderTerminal) {
          const rid = await kvGet(lockOrderKey(orderId));
          if (rid) await clearLock(rid, orderId);
        }
      } catch (e) { /* abaikan — jangan ganggu respon polling */ }
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
  if (!/^([1-9]|10|20)B$/.test(amount)) {
    return res.status(400).json({ success: false, error: 'Jumlah tidak valid (1B-10B, 20B).' });
  }

  // --- BLOCKED ROYAL ID: daftar manual dari env BLOCKED_ROYAL_IDS ---
  if (BLOCKED_ROYALS.includes(royalId)) {
    return res.status(403).json({ success: false, error: 'Coba lagi nanti.' });
  }

  // --- LOCK PENDING: ID dengan bongkar pending tidak bisa bongkar lagi ---
  const existingLock = await readLock(royalId);
  if (existingLock) {
    const remaining = Math.floor((existingLock.expires_at - Date.now()) / 1000);
    if (remaining > 0 && (await orderStillPending(PROXY_URL, PROXY_KEY, existingLock.order_id))) {
      return res.status(200).json({
        success: false, locked: true, order_id: existingLock.order_id,
        remaining_seconds: remaining,
        error: 'Bongkar sebelumnya masih pending.',
      });
    }
    await clearLock(royalId, existingLock.order_id);
  }

  // --- CEK SALDO KOIN: saldo harus >= nominal x 1,02 + 500M ---
  if (BALANCE_CHECK_ENABLED) {
    const bal = await checkCoinBalance(royalId, amount);
    if (bal && !bal.ok) {
      return res.status(400).json({
        success: false, error: 'Koin bongkar kurang',
        coin: bal.coin, required_coin: bal.required,
      });
    }
  }

  // --- CEK ID PLAYER: tolak ID yang tidak terdaftar di game ---
  if (ID_CHECK_ENABLED) {
    const chk = await checkPlayerId(royalId);
    if (chk === false) {
      return res.status(400).json({ success: false, error: 'Error, ID akun anda tidak valid' });
    }
  }

  // --- RATE LIMIT PER ROYAL ID: cegah order beruntun dari ID yang sama ---
  // Hanya pembuatan order (POST) yang dibatasi; polling GET tidak kena.
  if (RATE_LIMIT_ENABLED) {
    const cdKey = `cd:kingarthur:id:${royalId}`;
    if ((await cooldownAcquire(cdKey)) === 'exists') {
      const ttl = await cooldownTtl(cdKey);
      const sisa = ttl
        ? (ttl >= 90 ? `±${Math.ceil(ttl / 60)} menit` : `${ttl} detik`)
        : 'beberapa menit';
      return res.status(429).json({
        success: false,
        error: `Terlalu cepat. ID ini baru saja membuat order — coba lagi dalam ${sisa}.`,
      });
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
        error: (sub.data && sub.data.error) || 'Tunggu sebentar lalu coba lagi.',
      });
    }
    // kunci ID ini selama ordernya pending (10 menit)
    await writeLock(royalId, orderId);

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
      return res.status(200).json({ success: true, order_id: orderId, withdrawal: sanitize(order.result) });
    }
    if (order && order.status === 'MANUAL_VERIFICATION_REQUIRED') {
      await clearLock(royalId, orderId);
      return res.status(502).json({
        success: false, order_id: orderId,
        error: 'Coba lagi beberapa saat.',
      });
    }
    if (order && ['FAILED', 'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(order.status)) {
      await clearLock(royalId, orderId);
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
      error: 'Tunggu sebentar lalu coba lagi..',
    });
  }
};
