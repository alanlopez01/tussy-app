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
    if (esInicio) return `${y}-${pad(m)}-${pad(d)}T03:00:00+0000`;
    const sig = new Date(Date.UTC(y, m-1, d+1));
    return `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth()+1)}-${pad(sig.getUTCDate())}T02:59:59+0000`;
  }

  const inicioUTC = toUTC(desde, true);
  const finUTC    = toUTC(hasta, false);

  async function getWooProducts(url, key, secret) {
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const headers = { "Authorization": `Basic ${auth}` };
    const mapa = {};
    let page = 1;
    while (true) {
      const r = await fetch(`${url}/wp-json/wc/v3/orders?after=${inicioUTC}&before=${finUTC}&per_page=50&page=${page}&status=completed,processing&fields=id,line_items`, { headers });
      const orders = await r.json();
      if (!Array.isArray(orders) || orders.length === 0) break;
      orders.forEach(o => {
        (o.line_items || []).forEach(item => {
          const nombre = (item.name || "").trim();
          if (!nombre) return;
          if (!mapa[nombre]) mapa[nombre] = 0;
          mapa[nombre] += parseInt(item.quantity || 0);
        });
      });
      if (orders.length < 50) break;
      page++;
    }
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
          const nombre = (item.name || "").trim();
          if (!nombre) return;
          if (!mapa[nombre]) mapa[nombre] = 0;
          mapa[nombre] += parseInt(item.quantity || 0);
        });
      });
      if (orders.length < 50) break;
      page++;
    }
    return mapa;
  }

  // Merge por coincidencia parcial
  function mergeProductos(wooP, wooLP, tn) {
    const merged = {};

    const agregarWoo = (mapa, local) => {
      Object.entries(mapa).forEach(([nombre, cant]) => {
        const key = nombre.toUpperCase();
        if (!merged[key]) merged[key] = { nombre, cantidad: 0, fuentes: [] };
        merged[key].cantidad += cant;
        if (!merged[key].fuentes.includes(local)) merged[key].fuentes.push(local);
      });
    };

    agregarWoo(wooP, "Palermo");
    agregarWoo(wooLP, "La Plata");

    // TN: buscar coincidencia parcial con WooCommerce
    Object.entries(tn).forEach(([nombre, cant]) => {
      const nombreUpper = nombre.toUpperCase();
      // Buscar si hay algún producto de WooCommerce que contenga palabras clave de TN
      let matched = false;
      const palabrasTN = nombreUpper.split(/\s+/).filter(p => p.length > 3);
      Object.keys(merged).forEach(key => {
        const matches = palabrasTN.filter(p => key.includes(p));
        if (matches.length >= 2 || (matches.length === 1 && palabrasTN.length === 1)) {
          merged[key].cantidad += cant;
          if (!merged[key].fuentes.includes("Tiendanube")) merged[key].fuentes.push("Tiendanube");
          matched = true;
        }
      });
      if (!matched) {
        if (!merged[nombreUpper]) merged[nombreUpper] = { nombre, cantidad: 0, fuentes: [] };
        merged[nombreUpper].cantidad += cant;
        if (!merged[nombreUpper].fuentes.includes("Tiendanube")) merged[nombreUpper].fuentes.push("Tiendanube");
      }
    });

    return Object.values(merged)
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 30)
      .map(p => ({ ...p, fuentes: p.fuentes.join(" · ") }));
  }

  try {
    const [wooP, wooLP, tn] = await Promise.all([
      getWooProducts(WOO_P_URL, WOO_P_KEY, WOO_P_SEC),
      getWooProducts(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC),
      TN_TOKEN ? getTNProducts() : Promise.resolve({})
    ]);
    res.status(200).json({ productos: mergeProductos(wooP, wooLP, tn) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
