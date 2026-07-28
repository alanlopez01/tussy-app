module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { action, params, target } = req.query;

  let scriptUrl;
  if (target === "shato") {
    scriptUrl = process.env.APPS_SCRIPT_URL_SHATO;
  } else {
    scriptUrl = process.env.APPS_SCRIPT_URL;
  }

  if (!scriptUrl) {
    return res.status(503).json({ error: "Apps Script URL no configurada" });
  }

  const url = scriptUrl + "?action=" + action + "&params=" + encodeURIComponent(params || "{}");

  try {
    const response = await fetch(url, { redirect: "follow" });
    const text = await response.text();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
