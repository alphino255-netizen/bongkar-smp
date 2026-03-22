export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const data = req.body;

    let text = "📥 DATA MASUK\n\n";
    for (const k in data) {
      text += `${k.toUpperCase()} : ${data[k]}\n`;
    }

    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.CHAT_ID,
        text
      })
    });

    res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error" });
  }
}
