module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!process.env.APPS_SCRIPT_URL_OPERACIONES) {
    return res.status(503).json({ error: "APPS_SCRIPT_URL_OPERACIONES no configurada en Vercel" });
  }

  const { action, params } = req.query;
  const url = process.env.APPS_SCRIPT_URL_OPERACIONES +
    "?action=" + action +
    "&params=" + encodeURIComponent(params || "{}");

  try {
    const response = await fetch(url, { redirect: "follow" });
    const text = await response.text();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
