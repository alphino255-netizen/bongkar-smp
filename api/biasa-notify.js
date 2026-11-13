/**
 * Vercel Serverless Function: notifikasi Telegram untuk bongkar GCS Games (Neo Party).
 *
 * POST /api/biasa-notify
 * Body: { type: 'pending' | 'success', royal_id, amount, nick, price, bank,
 *         account_number, account_name, phone_number, order_id,
 *         withdrawal_id, coin, nett_amount, wd_account_index }
 *         // nick = nick game hasil cek ID; price = estimasi cair (halaman polosan)
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN - token bot Telegram
 *   TELEGRAM_CHAT_ID   - chat ID tujuan notif
 *
 * PERBAIKAN 2026-11-13: field dari pengguna/pemain (nick, nama, dll.) sekarang
 * di-escape untuk Markdown Telegram. Sebelumnya nick mengandung "_" (mis.
 * NEO_3309220) membuat Telegram menolak seluruh pesan ("can't parse entities")
 * -> fungsi menjawab 502 dan notif hilang, padahal order-nya sendiri sah.
 */

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

// Escape karakter khusus Markdown (mode legacy) pada teks bebas:
// _ * ` [ — tanpa ini satu karakter saja bisa menggagalkan seluruh pesan.
function esc(v) {
  return String(v == null ? '' : v).replace(/([_*`\[])/g, '\\$1');
}

// Nilai di dalam `...` (inline code): cukup buang backtick dari nilainya.
function escCode(v) {
  return String(v == null ? '' : v).replace(/`/g, '');
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
  if (!BOT_TOKEN || !CHAT_ID) {
    return res.status(500).json({ success: false, error: 'Telegram belum dikonfigurasi.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const type = body.type || 'pending';
  const emoji = type === 'success' ? '✅' : '⏳';
  const status = type === 'success' ? 'SUKSES' : 'PENDING';

  let text = `${emoji} *BONGKAR NEO PARTY ${status}*\n\n`;
  text += `🆔 ID: ${esc(body.royal_id || '-')}\n`;
  if (body.nick) text += `🎮 Nick: ${esc(body.nick)}\n`;
  text += `💰 Jumlah: ${esc(body.amount || '-')}\n`;
  if (body.price) text += `💵 Estimasi Cair: Rp ${esc(body.price)}\n`;
  if (body.coin) text += `🪙 Koin: ${esc(body.coin)}\n`;
  if (body.nett_amount) text += `💵 Nominal: ${esc(body.nett_amount)}\n`;
  text += `🏦 Bank: ${esc(body.bank || '-')}\n`;
  text += `💳 No.Rek: ${esc(body.account_number || '-')}\n`;
  text += `✍️ Nama: ${esc(body.account_name || '-')}\n`;
  if (body.phone_number) text += `📱 No.HP: ${esc(body.phone_number)}\n`;
  if (body.wd_account_index) text += `🏧 Rek pencairan: ke-${esc(body.wd_account_index)}\n`;
  if (body.order_id) text += `\n🧾 Order: \`${escCode(body.order_id)}\``;
  if (body.withdrawal_id) text += `\n🔑 WD ID: \`${escCode(body.withdrawal_id)}\``;

  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      return res.status(502).json({ success: false, error: 'Telegram menolak pesan.' });
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(502).json({ success: false, error: 'Gagal menghubungi Telegram.' });
  }
};
