const { requerirSesion } = require("../lib/auth");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tussy-Auth");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (!requerirSesion(req, res)) return;

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

  // El Apps Script de Google a veces se cuelga o devuelve error en frío:
  // dos reintentos con pausa suelen alcanzar para que la pantalla nunca lo vea.
  let ultimoError = null;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      const json = JSON.parse(text); // si Google devolvió HTML de error, esto tira y reintenta
      return res.status(200).json(json);
    } catch (err) {
      ultimoError = err.message;
      if (intento < 3) await new Promise(r => setTimeout(r, 1500 * intento));
    }
  }
  res.status(500).json({ error: ultimoError });
}
