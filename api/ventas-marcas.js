// Endpoint unificado para ventas de Shato y Blanks (Tiendanube)
// Uso: /api/ventas-marcas?marca=shato&desde=2026-04-01&hasta=2026-04-13
//      /api/ventas-marcas?marca=blanks&desde=2026-04-01&hasta=2026-04-13

const _cache = {};
function getCache(key, ttl) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { delete _cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) { _cache[key] = { data, ts: Date.now() }; }

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { marca, desde, hasta } = req.query;

  if (!marca || !desde || !hasta) {
    return res.status(400).json({ error: "Parámetros requeridos: marca, desde, hasta" });
  }

  // Configuración por marca
  const marcas = {
    shato: {
      tiendas: [
        { key: "minorista", nombre: "Shato Minorista", userId: process.env.SHATO_MIN_TN_USER_ID, token: process.env.SHATO_MIN_TN_TOKEN },
        { key: "mayorista", nombre: "Shato Mayorista", userId: process.env.SHATO_MAY_TN_USER_ID, token: process.env.SHATO_MAY_TN_TOKEN },
      ]
    },
    blanks: {
      tiendas: [
        { key: "web", nombre: "Blanks Web", userId: process.env.BLANKS_TN_USER_ID, token: process.env.BLANKS_TN_TOKEN },
      ]
    }
  };

  const config = marcas[marca.toLowerCase()];
  if (!config) {
    return res.status(400).json({ error: "Marca no encontrada. Opciones: shato, blanks" });
  }

  const pad = n => String(n).padStart(2, "0");
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  const inicioUTC = `${desde}T03:00:00+0000`;
  const sig = new Date(Date.UTC(y2, m2 - 1, d2 + 1));
  const finUTC = `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth() + 1)}-${pad(sig.getUTCDate())}T02:59:59+0000`;

  // Cache
  const argNow = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  const todayStr = `${argNow.getUTCFullYear()}-${pad(argNow.getUTCMonth() + 1)}-${pad(argNow.getUTCDate())}`;
  const isToday = (desde === todayStr || hasta === todayStr);
  const cacheTTL = isToday ? 2 * 60 * 1000 : 10 * 60 * 1000;
  const cacheKey = `marcas_${marca}_${desde}_${hasta}`;
  const cached = getCache(cacheKey, cacheTTL);
  if (cached) return res.status(200).json(cached);

  async function getTNData(userId, token) {
    if (!userId || !token) return { total: 0, cantidad: 0, pedidos: [] };
    let page = 1, total = 0, cantidad = 0, primerPedidos = [];
    while (true) {
      const r = await fetch(
        `https://api.tiendanube.com/v1/${userId}/orders?created_at_min=${inicioUTC}&created_at_max=${finUTC}&per_page=200&page=${page}&fields=id,total,payment_status,contact_name,number&payment_status=paid`,
        { headers: { "Authentication": `bearer ${token}`, "User-Agent": "TussyApp/1.0" } }
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
    const results = await Promise.all(
      config.tiendas.map(t => getTNData(t.userId, t.token))
    );

    const response = { marca: marca.toLowerCase(), tiendas: {} };
    let totalGeneral = 0;

    config.tiendas.forEach((t, i) => {
      response.tiendas[t.key] = { nombre: t.nombre, ...results[i] };
      totalGeneral += results[i].total;
    });

    response.total = totalGeneral;
    setCache(cacheKey, response);
    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
