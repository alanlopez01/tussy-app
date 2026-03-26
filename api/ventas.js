// Server-side cache (persists while serverless function is warm)
const _cache = {};

function getCache(key, ttl) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { delete _cache[key]; return null; }
  return entry.data;
}

function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

module.exports = async function handler(req, res) {
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

  const pad = n => String(n).padStart(2, "0");

  function toUTC(fecha, esInicio) {
    const [y, m, d] = fecha.split("-").map(Number);
    if (esInicio) {
      return `${y}-${pad(m)}-${pad(d)}T03:00:00+0000`;
    } else {
      const sig = new Date(Date.UTC(y, m-1, d+1));
      return `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth()+1)}-${pad(sig.getUTCDate())}T02:59:59+0000`;
    }
  }

  // Determine TTL: 2 min for today, 10 min for historical
  const argNow = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  const todayStr = `${argNow.getUTCFullYear()}-${pad(argNow.getUTCMonth()+1)}-${pad(argNow.getUTCDate())}`;
  const isToday = (desde === todayStr || hasta === todayStr);
  const cacheTTL = isToday ? 2 * 60 * 1000 : 10 * 60 * 1000;

  const cacheKey = `ventas_${desde}_${hasta}`;
  const cached = getCache(cacheKey, cacheTTL);
  if (cached) return res.status(200).json(cached);

  const inicioUTC = toUTC(desde, true);
  const finUTC    = toUTC(hasta, false);

  async function getWooData(url, key, secret) {
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const headers = { "Authorization": `Basic ${auth}` };
    const [reportRes, ordersRes] = await Promise.all([
      fetch(`${url}/wp-json/wc/v3/reports/sales?date_min=${desde}&date_max=${hasta}`, { headers }),
      fetch(`${url}/wp-json/wc/v3/orders?after=${inicioUTC}&before=${finUTC}&per_page=3&status=completed,processing&orderby=date&order=desc`, { headers })
    ]);
    const report = await reportRes.json();
    const orders = await ordersRes.json();
    return {
      total: Array.isArray(report) && report[0] ? parseFloat(report[0].total_sales || 0) : 0,
      cantidad: Array.isArray(report) && report[0] ? parseInt(report[0].total_orders || 0) : 0,
      pedidos: Array.isArray(orders) ? orders.map(o => ({
        numero: o.number,
        total: parseFloat(o.total || 0),
        estado: o.status,
        cliente: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim()
      })) : []
    };
  }

  async function getTNData() {
    let page = 1, total = 0, cantidad = 0, primerPedidos = [];
    while (true) {
      const r = await fetch(
        `https://api.tiendanube.com/v1/${TN_USER}/orders?created_at_min=${inicioUTC}&created_at_max=${finUTC}&per_page=200&page=${page}&fields=id,total,payment_status,contact_name,number&payment_status=paid`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "TussyApp/1.0" } }
      );
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      total += data.reduce((s, o) => s + parseFloat(o.total || 0), 0);
      cantidad += data.length;
      if (page === 1) primerPedidos = data.slice(0, 3);
      if (data.length < 200) break;
      page++;
    }
    return {
      total, cantidad,
      pedidos: primerPedidos.map(o => ({
        numero: o.number,
        total: parseFloat(o.total || 0),
        estado: o.payment_status,
        cliente: o.contact_name || "Sin nombre"
      }))
    };
  }

  try {
    const [palermo, laplata, tn] = await Promise.all([
      getWooData(WOO_P_URL, WOO_P_KEY, WOO_P_SEC),
      getWooData(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC),
      TN_TOKEN ? getTNData() : Promise.resolve({ total: 0, cantidad: 0, pedidos: [] })
    ]);
    const responseData = {
      palermo:    { nombre: "Local Palermo",  ...palermo },
      laplata:    { nombre: "Local La Plata", ...laplata },
      tiendanube: { nombre: "Tiendanube",     ...tn },
      total: palermo.total + laplata.total + tn.total
    };
    setCache(cacheKey, responseData);
    res.status(200).json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
