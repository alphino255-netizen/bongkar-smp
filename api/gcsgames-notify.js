/**
 * Vercel Serverless Function: notifikasi Telegram untuk bongkar King Arthur.
 *
 * POST /api/kingarthur-notify
 * Body: { type: 'pending' | 'success', royal_id, amount, bank, account_number,
 *         account_name, order_id, withdrawal_id, coin, nett_amount,
 *         wd_account_index }   // wd_account_index = rek pencairan ke-N (dari proxy)
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN - token bot Telegram
 *   TELEGRAM_CHAT_ID   - chat ID tujuan notif
 */

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  let text = `${emoji} *BONGKAR KING ARTHUR ${status}*\n\n`;
  text += `🆔 ID: ${body.royal_id || '-'}\n`;
  text += `💰 Jumlah: ${body.amount || '-'}\n`;
  if (body.coin) text += `🪙 Koin: ${body.coin}\n`;
  if (body.nett_amount) text += `💵 Nominal: ${body.nett_amount}\n`;
  text += `🏦 Bank: ${body.bank || '-'}\n`;
  text += `💳 No.Rek: ${body.account_number || '-'}\n`;
  text += `✍️ Nama: ${body.account_name || '-'}\n`;
  if (body.wd_account_index) text += `🏧 Rek pencairan: ke-${body.wd_account_index}\n`;
  if (body.order_id) text += `\n🧾 Order: \`${body.order_id}\``;
  if (body.withdrawal_id) text += `\n🔑 WD ID: \`${body.withdrawal_id}\``;

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
