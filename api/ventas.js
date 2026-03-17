export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { canal, desde, hasta } = req.query;
  const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
  const TN_USER    = process.env.TN_USER_ID;
  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;

  try {
    const resultados = {};

    // ── TIENDANUBE ──
    if (!canal || canal === "tiendanube") {
      const tnUrl = `https://api.tiendanube.com/v1/${TN_USER}/orders?created_at_min=${desde}&created_at_max=${hasta}&per_page=200`;
      const tnRes = await fetch(tnUrl, {
        headers: {
          "Authentication": `bearer ${TN_TOKEN}`,
          "User-Agent": "TussyApp/1.0"
        }
      });
      const tnData = await tnRes.json();
      const pedidos = Array.isArray(tnData) ? tnData : [];
      resultados.tiendanube = {
        nombre: "Tiendanube",
        total: pedidos.reduce((s, o) => s + parseFloat(o.total || 0), 0),
        cantidad: pedidos.length,
        pedidos: pedidos.slice(0, 5).map(o => ({
          numero: o.number,
          total: parseFloat(o.total || 0),
          estado: o.payment_status,
          cliente: o.contact_name || "Sin nombre"
        }))
      };
    }

    // ── WOOCOMMERCE PALERMO ──
    if (!canal || canal === "palermo") {
      const auth = Buffer.from(`${WOO_P_KEY}:${WOO_P_SEC}`).toString("base64");
      const wUrl = `${WOO_P_URL}/wp-json/wc/v3/orders?after=${desde}T00:00:00&before=${hasta}T23:59:59&per_page=100&status=completed,processing`;
      const wRes = await fetch(wUrl, { headers: { "Authorization": `Basic ${auth}` } });
      const wData = await wRes.json();
      const pedidos = Array.isArray(wData) ? wData : [];
      resultados.palermo = {
        nombre: "Local Palermo",
        total: pedidos.reduce((s, o) => s + parseFloat(o.total || 0), 0),
        cantidad: pedidos.length,
        pedidos: pedidos.slice(0, 5).map(o => ({
          numero: o.number,
          total: parseFloat(o.total || 0),
          estado: o.status,
          cliente: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim()
        }))
      };
    }

    // ── WOOCOMMERCE LA PLATA ──
    if (!canal || canal === "laplata") {
      const auth = Buffer.from(`${WOO_LP_KEY}:${WOO_LP_SEC}`).toString("base64");
      const wUrl = `${WOO_LP_URL}/wp-json/wc/v3/orders?after=${desde}T00:00:00&before=${hasta}T23:59:59&per_page=100&status=completed,processing`;
      const wRes = await fetch(wUrl, { headers: { "Authorization": `Basic ${auth}` } });
      const wData = await wRes.json();
      const pedidos = Array.isArray(wData) ? wData : [];
      resultados.laplata = {
        nombre: "Local La Plata",
        total: pedidos.reduce((s, o) => s + parseFloat(o.total || 0), 0),
        cantidad: pedidos.length,
        pedidos: pedidos.slice(0, 5).map(o => ({
          numero: o.number,
          total: parseFloat(o.total || 0),
          estado: o.status,
          cliente: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim()
        }))
      };
    }

    // ── TOTAL CONSOLIDADO ──
    resultados.total = Object.values(resultados).reduce((s, c) => s + (c.total || 0), 0);

    res.status(200).json(resultados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
