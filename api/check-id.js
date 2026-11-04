/**
 * Vercel Serverless Function: cek validitas ID game (untuk halaman polosan).
 *
 * POST /api/check-id { royal_id }
 *   -> { success: true, valid: true,  nick }   ID terdaftar di game
 *   -> { success: true, valid: false }          ID TIDAK terdaftar
 *   -> { success: true, valid: null }           cek gagal -> halaman fail-open
 *
 * Sekalian deteksi KOIN (chip) pemain dari hidupcuan personal-info-free
 * (respons membawa field tambahan, cek validitas di atas tidak berubah):
 *   coin          saldo koin mentah (null bila tidak diketahui)
 *   coin_label    format Indonesia ringkas, mis. '750M' / '1,52B'
 *   coin_status   'ok'      koin DI ATAS 500M -> boleh proses bongkar
 *                 'low'     koin <= 500M -> halaman BLOKIR
 *                 'invalid' API menjawab tuntas tapi pemain tidak ditemukan
 *                           (data null / LoadPlayerDataFailed) -> BLOKIR
 *                 'unknown' gangguan transport/HTTP saja -> fail-open
 *   min_coin      500000000 (ambang tetap, tidak tergantung jumlah bongkar)
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

// --- Deteksi koin (chip) via hidupcuan personal-info-free ---
// Aturan fiqry: koin DI ATAS 500M baru boleh proses bongkar.
const MIN_COIN = 500000000;
const BALANCE_API_URL = process.env.BALANCE_API_URL || 'https://api.hidupcuan.org/api/neo/personal-info-free';
const BALANCE_TIMEOUT_MS = 6000;

// Angka koin mentah -> format Indonesia ringkas: 1520000000 -> '1,52B'
function formatCoin(raw) {
  const v = Number(raw);
  if (!isFinite(v)) return '';
  const trim = (num, dec) => {
    let s = num.toFixed(dec);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s.replace('.', ',');
  };
  if (v >= 1e12) return trim(v / 1e12, 2) + 'T';
  if (v >= 1e9) return trim(v / 1e9, 2) + 'B';
  if (v >= 1e6) return trim(v / 1e6, 1) + 'M';
  return String(Math.trunc(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

async function checkCoin(playerId) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(BALANCE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        // Endpoint hanya merespons ID numerik (string -> data null).
        body: JSON.stringify({ id: Number(playerId) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const m = await upstream.json().catch(() => null);
    if (!upstream.ok || !m) {
      // Gangguan transport/HTTP (5xx, body bukan JSON) -> tidak tahu -> fail-open.
      console.log('[check-id] cek koin HTTP ' + upstream.status + ' -> fail-open');
      return { coin_status: 'unknown', coin: null, coin_label: null, nick: null };
    }
    // API menjawab tuntas (HTTP 200 + JSON). Pemain ditemukan HANYA bila
    // data.Coin ada; selain itu (data null / payload En+Msg) = tidak
    // ditemukan -> invalid, BUKAN fail-open (terbukti live 2026-10-29).
    const coinRaw = (m.data && typeof m.data.Coin !== 'undefined') ? m.data.Coin : undefined;
    if (typeof coinRaw === 'undefined') {
      return { coin_status: 'invalid', coin: null, coin_label: null, nick: null };
    }
    const coin = Number(coinRaw);
    if (!isFinite(coin)) {
      console.log('[check-id] Coin bukan angka -> fail-open');
      return { coin_status: 'unknown', coin: null, coin_label: null, nick: null };
    }
    return {
      coin_status: coin > MIN_COIN ? 'ok' : 'low',
      coin,
      coin_label: formatCoin(coin),
      nick: m.data.Nick || null,
    };
  } catch (e) {
    console.log('[check-id] cek koin error:', e.message, '-> fail-open');
    return { coin_status: 'unknown', coin: null, coin_label: null, nick: null };
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

  const [chk, coinChk] = await Promise.all([
    checkPlayerId(royalId),
    checkCoin(royalId),
  ]);
  return res.status(200).json({
    success: true,
    valid: chk.valid,
    nick: chk.nick || coinChk.nick || null,
    cached: !!chk.cached,
    coin: coinChk.coin,
    coin_label: coinChk.coin_label,
    coin_status: coinChk.coin_status,
    min_coin: MIN_COIN,
  });
};
