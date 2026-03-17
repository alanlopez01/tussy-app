export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { action, params } = req.query;
  const url = process.env.APPS_SCRIPT_URL + "?action=" + action + "&params=" + encodeURIComponent(params || "{}");

  try {
    const response = await fetch(url, { redirect: "follow" });
    const text = await response.text();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
