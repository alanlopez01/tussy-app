export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { desde, hasta } = req.query;
  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;
  const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
  const TN_USER    = process.env.TN_USER_ID;

  async function getWooOrders(url, key, secret) {
    let page = 1, all = [];
    while (true) {
      const auth = Buffer.from(`${key}:${secret}`).toString("base64");
      const r = await fetch(
        `${url}/wp-json/wc/v3/orders?after=${desde}T00:00:00&before=${hasta}T23:59:59&per_page=100&page=${page}&status=completed,processing`,
        { headers: { "Authorization": `Basic ${auth}` } }
      );
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      all = all.concat(data);
      if (data.length < 100) break;
      page++;
    }
    return all;
  }

  async function getTNOrders() {
    let page = 1, all = [];
    while (true) {
      const r = await fetch(
        `https://api.tiendanube.com/v1/${TN_USER}/orders?created_at_min=${desde}&created_at_max=${hasta}&per_page=200&page=${page}`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "TussyApp/1.0" } }
      );
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      all = all.concat(data);
      if (data.length < 200) break;
      page++;
    }
    return all;
  }

  try {
    const [wPedidos, lpPedidos, tnPedidos] = await Promise.all([
      getWooOrders(WOO_P_URL, WOO_P_KEY, WOO_P_SEC),
      getWooOrders(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC),
      TN_TOKEN ? getTNOrders() : Promise.resolve([])
    ]);

    const formatWoo = (pedidos, nombre) => ({
      nombre,
      total: pedidos.reduce((s, o) => s + parseFloat(o.total || 0), 0),
      cantidad: pedidos.length,
      pedidos: pedidos.slice(0, 10).map(o => ({
        numero: o.number,
        total: parseFloat(o.total || 0),
        estado: o.status,
        cliente: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim()
      }))
    });

    const resultados = {
      palermo: formatWoo(wPedidos, "Local Palermo"),
      laplata: formatWoo(lpPedidos, "Local La Plata"),
      tiendanube: {
        nombre: "Tiendanube",
        total: tnPedidos.reduce((s, o) => s + parseFloat(o.total || 0), 0),
        cantidad: tnPedidos.length,
        pedidos: tnPedidos.slice(0, 10).map(o => ({
          numero: o.number,
          total: parseFloat(o.total || 0),
          estado: o.payment_status,
          cliente: o.contact_name || "Sin nombre"
        }))
      }
    };

    resultados.total = resultados.palermo.total + resultados.laplata.total + resultados.tiendanube.total;
    res.status(200).json(resultados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
