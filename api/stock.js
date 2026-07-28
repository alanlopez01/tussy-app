// Cache en memoria mientras la funcion esta caliente
const _reporteCache = { ts: 0, data: null };
const CACHE_TTL_REPORTE = 10 * 60 * 1000; // 10 min

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { q, action } = req.query;

  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;
  const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;

  // === REPORTE DESDE SHEETS (rápido) ===
  if (action === "reporteSheets") {
    try {
      const r = await fetch(`${OPS_URL}?action=getStockSnapshot&params=${encodeURIComponent("{}")}`, { redirect: "follow" });
      const data = await r.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // === HISTORICO DESDE SHEETS ===
  if (action === "historicoSheets") {
    try {
      const dias = parseInt(req.query.dias) || 30;
      const params = JSON.stringify({ dias });
      const r = await fetch(`${OPS_URL}?action=getStockHistorico&params=${encodeURIComponent(params)}`, { redirect: "follow" });
      const data = await r.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // === REPORTE TOTAL (on-demand, puede timeout) ===
  if (action === "reporte") {
    return reporteTotal();
  }

  async function reporteTotal() {
    const fresh = req.query.fresh === "1";
    // Cache de 10 minutos (bypass con ?fresh=1)
    if (!fresh && _reporteCache.data && (Date.now() - _reporteCache.ts) < CACHE_TTL_REPORTE) {
      return res.status(200).json({ ..._reporteCache.data, cached: true });
    }

    async function traerProductosCompleto(url, key, secret, pageStart = 1, pageEnd = 20) {
      const auth = Buffer.from(`${key}:${secret}`).toString("base64");
      const headers = { "Authorization": `Basic ${auth}` };
      const productos = [];
      let page = pageStart;
      const perPage = 100;
      while (page <= pageEnd) {
        const r = await fetch(`${url}/wp-json/wc/v3/products?per_page=${perPage}&page=${page}&status=publish&_fields=id,name,type,stock_quantity,stock_status`, { headers });
        if (!r.ok) break;
        const d = await r.json();
        if (!Array.isArray(d) || d.length === 0) break;
        productos.push(...d);
        if (d.length < perPage) break;
        page++;
      }
      // Traer variantes en batches de 10 para no saturar WooCommerce
      async function traerVariantesDe(p) {
        if (p.type !== "variable") {
          p._variantes = [{ stock_quantity: p.stock_quantity, stock_status: p.stock_status }];
          return;
        }
        const variantes = [];
        let vpage = 1;
        const vMaxPages = 5;
        while (vpage <= vMaxPages) {
          let vr, vd;
          // Retry hasta 2 veces con timeout de 8s por request
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const ctrl = new AbortController();
              const tm = setTimeout(() => ctrl.abort(), 8000);
              vr = await fetch(`${url}/wp-json/wc/v3/products/${p.id}/variations?per_page=100&page=${vpage}&_fields=id,stock_quantity,stock_status`, { headers, signal: ctrl.signal });
              clearTimeout(tm);
              if (vr.ok) {
                vd = await vr.json();
                break;
              }
            } catch {}
            if (attempt === 0) await new Promise(r => setTimeout(r, 200));
          }
          if (!Array.isArray(vd) || vd.length === 0) break;
          variantes.push(...vd);
          if (vd.length < 100) break;
          vpage++;
        }
        p._variantes = variantes;
      }
      const BATCH = 30;
      for (let i = 0; i < productos.length; i += BATCH) {
        const slice = productos.slice(i, i + BATCH);
        await Promise.all(slice.map(traerVariantesDe));
      }
      return productos;
    }

    try {
      const store = (req.query.store || "all").toLowerCase();

      const agregar = (lista, locKey, mapa) => {
        for (const p of lista) {
          const key = (p.name || "").toUpperCase().trim();
          if (!mapa[key]) mapa[key] = { nombre: p.name, palermo:0, laplata:0, dot:0, abasto:0, cordoba:0 };
          const stock = (p._variantes || []).reduce((s, v) => s + (v.stock_quantity != null && v.stock_quantity > 0 ? v.stock_quantity : 0), 0);
          mapa[key][locKey] += stock;
        }
      };

      const mapa = {};
      const totales = { palermo:0, laplata:0 };
      // Paginado opcional para dividir tiendas lentas
      const pageStart = parseInt(req.query.pageStart) || 1;
      const pageEnd = parseInt(req.query.pageEnd) || 20;

      if (store === "palermo" || store === "all") {
        const palermo = await traerProductosCompleto(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, pageStart, pageEnd);
        agregar(palermo, "palermo", mapa);
      }
      if (store === "laplata" || store === "all") {
        const laplata = await traerProductosCompleto(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, pageStart, pageEnd);
        agregar(laplata, "laplata", mapa);
      }

      const productos = Object.values(mapa);
      for (const p of productos) {
        totales.palermo += p.palermo;
        totales.laplata += p.laplata;
      }
      productos.sort((a,b) => (b.palermo+b.laplata) - (a.palermo+a.laplata));

      const result = { productos, totales, cantidadProductos: productos.length, store };
      // Solo cachear cuando es "all"
      if (store === "all") {
        _reporteCache.ts = Date.now();
        _reporteCache.data = result;
      }
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // === BUSQUEDA NORMAL ===
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: "Ingresá al menos 2 caracteres para buscar" });
  }

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
            stock: v.stock_quantity != null ? v.stock_quantity : null,
            tiene_stock: v.stock_status === "instock",
            atributos: (v.attributes || []).map(a => `${a.name}: ${a.option}`).join(" / ")
          }));
        }
      } else {
        variantes = [{
          sku: p.sku || "",
          precio: parseFloat(p.price || 0),
          stock: p.stock_quantity != null ? p.stock_quantity : null,
          tiene_stock: p.stock_status === "instock",
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
