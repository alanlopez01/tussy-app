// Suscripciones a notificaciones push. (El resumen diario legacy que daba nombre a
// este archivo se retiró: hoy los envíos los hace /api/metricas — ingesta, cierre y
// semanal. La ruta se conserva porque las PWA instaladas ya apuntan acá.)
const { requerirSesion } = require("../lib/auth");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tussy-Auth");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requerirSesion(req, res)) return;

  const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;
  const { action } = req.query;

  // Alta de suscripción (guarda en el Sheet de operaciones vía proxy)
  if (action === "subscribe" && req.method === "POST") {
    const { subscription, usuario } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription required" });
    }
    try {
      const params = JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys, usuario });
      await fetch(`${OPS_URL}?action=guardarPushSub&params=${encodeURIComponent(params)}`, { redirect: "follow" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(410).json({
    error: "El resumen diario legacy fue retirado; las notificaciones salen de /api/metricas",
  });
};
