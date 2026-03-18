module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { desde, hasta, canal } = req.query;
  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;
  const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
  const TN_USER    = process.env.TN_USER_ID;
  const pad = n => String(n).padStart(2, "0");

  // Determinar qué period usar en WooCommerce basado en las fechas
  function getWooPeriod(desde, hasta) {
    const hoy = new Date();
    const ahora = new Date(hoy.getTime() - 3 * 60 * 60 * 1000);
    const inicioMes = `${ahora.getUTCFullYear()}-${pad(ahora.getUTCMonth()+1)}-01`;
    const mesAnt = new Date(ahora.getUTCFullYear(), ahora.getUTCMonth()-1, 1);
    const inicioMesAnt = `${mesAnt.getFullYear()}-${pad(mesAnt.getMonth()+1)}-01`;

    if (desde === inicioMes) return "month";
    if (desde === inicioMesAnt) return "last_month";

    // Semana actual
    const inicioSemana = new Date(ahora);
    inicioSemana.setUTCDate(ahora.getUTCDate() - ahora.getUTCDay());
    const inicioSemanaStr = `${inicioSemana.getUTCFullYear()}-${pad(inicioSemana.getUTCMonth()+1)}-${pad(inicioSemana.getUTCDate())}`;
    if (desde === inicioSemanaStr) return "week";

    // Por defecto usar month
    return "month";
  }

  function toUTC(fecha, esInicio) {
    const [y, m, d] = fecha.split("-").map(Number);
    if (esInicio) return `${y}-${pad(m)}-${pad(d)}T03:00:00+0000`;
    const sig = new Date(Date.UTC(y, m-1, d+1));
    return `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth()+1)}-${pad(sig.getUTCDate())}T02:59:59+0000`;
  }

  const inicioUTC = toUTC(desde, true);
  const finUTC    = toUTC(hasta, false);
  const wooPeriod = getWooPeriod(desde, hasta);

  async function getWooTopSellers(url, key, secret, localNombre) {
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const headers = { "Authorization": `Basic ${auth}` };
    const r = await fetch(
      `${url}/wp-json/wc/v3/reports/top_sellers?period=${wooPeriod}&per_page=50`,
      { headers }
    );
    const data = await r.json();
    if (!Array.isArray(data)) return {};
    const mapa = {};
    data.forEach(item => {
      const key = String(item.product_id);
      mapa[key] = {
        nombre: item.name || "",
        cantidad: parseInt(item.quantity || 0),
        locales: [localNombre]
      };
    });
    return mapa;
  }

  async function getTNProducts() {
    const mapa = {};
    let page = 1;
    while (true) {
      const r = await fetch(
        `https://api.tiendanube.com/v1/${TN_USER}/orders?created_at_min=${inicioUTC}&created_at_max=${finUTC}&per_page=50&page=${page}&fields=id,products&payment_status=paid`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "TussyApp/1.0" } }
      );
      const orders = await r.json();
      if (!Array.isArray(orders) || orders.length === 0) break;
      orders.forEach(o => {
        (o.products || []).forEach(item => {
          const productId = String(item.product_id);
          const nombreCompleto = (item.name || "").trim();
          const nombreBase = nombreCompleto.split(" - ")[0].trim();
          if (!nombreBase) return;
          if (!mapa[productId]) mapa[productId] = { nombre: nombreBase, cantidad: 0, locales: [] };
          mapa[productId].cantidad += parseInt(item.quantity || 0);
          if (!mapa[productId].locales.includes("Tiendanube")) mapa[productId].locales.push("Tiendanube");
        });
      });
      if (orders.length < 50) break;
      page++;
    }
    return mapa;
  }

  try {
    let productos = [];

    if (canal === "online") {
      const tn = await getTNProducts();
      productos = Object.values(tn);
    } else {
      const [wooP, wooLP] = await Promise.all([
        getWooTopSellers(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, "Palermo"),
        getWooTopSellers(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, "La Plata")
      ]);
      const merged = { ...wooP };
      Object.entries(wooLP).forEach(([key, val]) => {
        if (merged[key]) {
          merged[key].cantidad += val.cantidad;
          val.locales.forEach(l => { if (!merged[key].locales.includes(l)) merged[key].locales.push(l); });
        } else {
          merged[key] = val;
        }
      });
      productos = Object.values(merged);
    }

    productos = productos
      .filter(p => p.cantidad > 0)
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 30)
      .map(p => ({ ...p, fuentes: p.locales.join(" · ") }));

    res.status(200).json({ productos, periodo: wooPeriod });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
