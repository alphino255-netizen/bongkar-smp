/**
 * Vercel Serverless Function: cek validitas ID game (untuk halaman polosan).
 *
 * POST /api/check-id { royal_id }
 *   -> { success: true, valid: true,  nick }   ID terdaftar di game
 *   -> { success: true, valid: false }          ID TIDAK terdaftar
 *   -> { success: true, valid: null }           cek gagal -> halaman fail-open
 *
 * Cek dilakukan server-side karena endpoint neoparty butuh header Signature
 * (MD5 dengan kunci rahasia) yang TIDAK boleh terekspos di JavaScript browser.
 *
 * GET https://neo-ack.theneoparty.com/agent_recharge/order/info?player_id=X&product_id=1
 * header Signature: MD5("player_id=X&product_id=1&signature={SIG}")
 * En=0 + Data -> valid | En=656/182 -> ID tidak ada | selain itu -> fail-open
 * Hasil valid di-cache 24 jam, invalid 1 jam (Vercel KV bila tersedia;
 * cache yang sama dengan forwarder kings-order).
 *
 * Env:
 *   KV_REST_API_URL / KV_REST_API_TOKEN  otomatis dari Vercel KV (opsional)
 *   NEO_CHECK_SIG   override signature cek ID (default bawaan neoparty)
 */

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://neoparty.web.id',
  'https://www.neoparty.web.id',
  'http://localhost:3000',
  'http://localhost:5173',
];

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

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
    return null;
  }
}

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
    console.log(`[check-id] unexpected En=${m.En} untuk ${playerId} -> fail-open`);
    return { valid: null };
  } catch (e) {
    console.log('[check-id] error:', e.message, '-> fail-open');
    return { valid: null };
  }
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const royalId = String((body && body.royal_id) || '').trim();
  if (!/^\d{3,20}$/.test(royalId)) {
    return res.status(400).json({ success: false, valid: false, error: 'Format Royal ID tidak valid.' });
  }

  const chk = await checkPlayerId(royalId);
  return res.status(200).json({
    success: true,
    valid: chk.valid,
    nick: chk.nick || null,
    cached: !!chk.cached,
  });
};
