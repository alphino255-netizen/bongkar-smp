import formidable from "formidable";
import fs from "fs";

export const config = {
    api: {
        bodyParser: false
    }
};

export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).json({
            ok: false,
            error: "Method Not Allowed"
        });
    }

    try {

        const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
        const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
            return res.status(500).json({
                ok: false,
                error: "Telegram environment variable belum tersedia"
            });
        }

        const form = formidable({
            multiples: false
        });

        const [fields, files] = await new Promise((resolve, reject) => {

            form.parse(req, (err, fields, files) => {

                if (err) {
                    reject(err);
                    return;
                }

                resolve([fields, files]);
            });

        });

        const photo = Array.isArray(files.photo)
            ? files.photo[0]
            : files.photo;

        if (!photo) {
            return res.status(400).json({
                ok: false,
                error: "Foto tidak ditemukan"
            });
        }

        const caption = Array.isArray(fields.caption)
            ? fields.caption[0]
            : fields.caption || "";

        const telegramForm = new FormData();

        telegramForm.append(
            "chat_id",
            TELEGRAM_CHAT_ID
        );

        telegramForm.append(
            "photo",
            new Blob([
                fs.readFileSync(photo.filepath)
            ], {
                type: photo.mimetype || "image/jpeg"
            }),
            photo.originalFilename || "bukti.jpg"
        );

        telegramForm.append(
            "caption",
            caption
        );

        telegramForm.append(
            "parse_mode",
            "Markdown"
        );

        const telegramResponse = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`,
            {
                method: "POST",
                body: telegramForm
            }
        );

        const result = await telegramResponse.json();

        if (!telegramResponse.ok || !result.ok) {

            console.error("Telegram error:", result);

            return res.status(500).json({
                ok: false,
                error: result.description || "Telegram API gagal"
            });
        }

        return res.status(200).json({
            ok: true
        });

    } catch (error) {

        console.error("BONGKAR ERROR:", error);

        return res.status(500).json({
            ok: false,
            error: error.message || "Internal Server Error"
        });
    }
}
