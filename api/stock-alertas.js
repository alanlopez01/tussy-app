// Cache en memoria (5 min TTL)
const _cache = {};
const CACHE_TTL = 5 * 60 * 1000;
function getCache(k) { const c = _cache[k]; if (c && Date.now() - c.ts < CACHE_TTL) return c.data; return null; }
function setCache(k, d) { _cache[k] = { data: d, ts: Date.now() }; }

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const cacheKey = "stock_alertas_" + new Date().toISOString().slice(0, 13);
  const cached = getCache(cacheKey);
  if (cached) return res.status(200).json(cached);

  const stores = [
    {
      key: "palermo", nombre: "Palermo",
      url: process.env.WOO_PALERMO_URL,
      auth: Buffer.from(`${process.env.WOO_PALERMO_KEY}:${process.env.WOO_PALERMO_SECRET}`).toString("base64"),
    },
    {
      key: "laplata", nombre: "La Plata",
      url: process.env.WOO_LAPLATA_URL,
      auth: Buffer.from(`${process.env.WOO_LAPLATA_KEY}:${process.env.WOO_LAPLATA_SECRET}`).toString("base64"),
    },
  ];

  async function getOutOfStock(store) {
    const headers = { Authorization: `Basic ${store.auth}` };
    // Get out of stock products
    const r = await fetch(
      `${store.url}/wp-json/wc/v3/products?stock_status=outofstock&per_page=100&status=publish`,
      { headers }
    );
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data.map(p => ({
      id: p.id,
      nombre: p.name,
      sku: p.sku || "",
      imagen: p.images && p.images[0] ? p.images[0].src : null,
    }));
  }

  async function getLowStock(store) {
    const headers = { Authorization: `Basic ${store.auth}` };
    // Get products with low stock (stock_quantity <= 2 and > 0)
    const r = await fetch(
      `${store.url}/wp-json/wc/v3/products?stock_status=instock&per_page=100&status=publish&orderby=date&order=desc`,
      { headers }
    );
    const data = await r.json();
    if (!Array.isArray(data)) return [];

    const low = [];
    for (const p of data) {
      if (p.type === "variable") {
        // Check variations
        const vr = await fetch(
          `${store.url}/wp-json/wc/v3/products/${p.id}/variations?per_page=100`,
          { headers }
        );
        const vars = await vr.json();
        if (!Array.isArray(vars)) continue;
        const lowVars = vars.filter(v => v.stock_quantity != null && v.stock_quantity > 0 && v.stock_quantity <= 2);
        if (lowVars.length > 0) {
          low.push({
            id: p.id,
            nombre: p.name,
            sku: p.sku || "",
            variantes_bajo: lowVars.map(v => ({
              atributos: (v.attributes || []).map(a => `${a.option}`).join(" / "),
              stock: v.stock_quantity,
            })),
          });
        }
      } else {
        if (p.stock_quantity != null && p.stock_quantity > 0 && p.stock_quantity <= 2) {
          low.push({
            id: p.id,
            nombre: p.name,
            sku: p.sku || "",
            variantes_bajo: [{ atributos: "Único", stock: p.stock_quantity }],
          });
        }
      }
    }
    return low;
  }

  try {
    // Fetch out-of-stock and low-stock in parallel for both stores
    const [outPalermo, outLaPlata, lowPalermo, lowLaPlata] = await Promise.all([
      getOutOfStock(stores[0]),
      getOutOfStock(stores[1]),
      getLowStock(stores[0]),
      getLowStock(stores[1]),
    ]);

    // Cross-reference: products out of stock in one store but exist in the other
    const palermoNames = new Set(outPalermo.map(p => p.nombre.toUpperCase()));
    const laPlataNames = new Set(outLaPlata.map(p => p.nombre.toUpperCase()));

    // Transfer opportunities: out in store A, might have stock in store B
    const transferencias = [];
    outPalermo.forEach(p => {
      if (!laPlataNames.has(p.nombre.toUpperCase())) {
        transferencias.push({
          producto: p.nombre,
          sku: p.sku,
          sin_stock: "Palermo",
          posible_origen: "La Plata",
        });
      }
    });
    outLaPlata.forEach(p => {
      if (!palermoNames.has(p.nombre.toUpperCase())) {
        transferencias.push({
          producto: p.nombre,
          sku: p.sku,
          sin_stock: "La Plata",
          posible_origen: "Palermo",
        });
      }
    });

    const response = {
      palermo: {
        sin_stock: outPalermo.length,
        stock_bajo: lowPalermo.length,
        productos_sin_stock: outPalermo.slice(0, 10),
        productos_bajo: lowPalermo.slice(0, 10),
      },
      laplata: {
        sin_stock: outLaPlata.length,
        stock_bajo: lowLaPlata.length,
        productos_sin_stock: outLaPlata.slice(0, 10),
        productos_bajo: lowLaPlata.slice(0, 10),
      },
      transferencias: transferencias.slice(0, 10),
      total_sin_stock: outPalermo.length + outLaPlata.length,
      total_bajo: lowPalermo.length + lowLaPlata.length,
    };

    setCache(cacheKey, response);
    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
