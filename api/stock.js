module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: "Ingresá al menos 2 caracteres para buscar" });
  }

  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;

  async function buscarProductos(url, key, secret, nombre) {
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const headers = { "Authorization": `Basic ${auth}` };

    // Buscar por nombre o SKU
    const [porNombre, porSKU] = await Promise.all([
      fetch(`${url}/wp-json/wc/v3/products?search=${encodeURIComponent(nombre)}&per_page=20&status=publish`, { headers }),
      fetch(`${url}/wp-json/wc/v3/products?sku=${encodeURIComponent(nombre)}&per_page=20&status=publish`, { headers })
    ]);

    const [dataNombre, dataSKU] = await Promise.all([
      porNombre.json(),
      porSKU.json()
    ]);

    // Combinar y deduplicar
    const todos = [...(Array.isArray(dataNombre) ? dataNombre : []),
                   ...(Array.isArray(dataSKU) ? dataSKU : [])];
    const vistos = new Set();
    const productos = todos.filter(p => {
      if (vistos.has(p.id)) return false;
      vistos.add(p.id);
      return true;
    });

    // Para cada producto traer sus variantes
    const resultado = await Promise.all(productos.map(async p => {
      let variantes = [];
      if (p.type === "variable") {
        const vRes = await fetch(`${url}/wp-json/wc/v3/products/${p.id}/variations?per_page=50`, { headers });
        const vData = await vRes.json();
        if (Array.isArray(vData)) {
          variantes = vData.map(v => ({
            sku: v.sku || "",
            precio: parseFloat(v.price || 0),
            stock: v.stock_quantity || 0,
            tiene_stock: v.in_stock,
            atributos: (v.attributes || []).map(a => `${a.name}: ${a.option}`).join(" / ")
          }));
        }
      } else {
        variantes = [{
          sku: p.sku || "",
          precio: parseFloat(p.price || 0),
          stock: p.stock_quantity || 0,
          tiene_stock: p.in_stock,
          atributos: "Talle único"
        }];
      }

      return {
        id: p.id,
        nombre: p.name,
        sku: p.sku || "",
        precio_base: parseFloat(p.price || 0),
        imagen: p.images && p.images[0] ? p.images[0].src : null,
        variantes
      };
    }));

    return resultado;
  }

  try {
    const [palermo, laplata] = await Promise.all([
      buscarProductos(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, q),
      buscarProductos(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, q)
    ]);

    // Consolidar por nombre de producto
    const mapa = {};

    palermo.forEach(p => {
      if (!mapa[p.nombre]) mapa[p.nombre] = { nombre: p.nombre, sku: p.sku, imagen: p.imagen, locales: {} };
      mapa[p.nombre].locales.palermo = p.variantes;
    });

    laplata.forEach(p => {
      if (!mapa[p.nombre]) mapa[p.nombre] = { nombre: p.nombre, sku: p.sku, imagen: p.imagen, locales: {} };
      mapa[p.nombre].locales.laplata = p.variantes;
    });

    res.status(200).json({
      query: q,
      resultados: Object.values(mapa)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
