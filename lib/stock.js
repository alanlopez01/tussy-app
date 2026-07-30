// Fetchers de inventario. Devuelven { ok, filas, error } con shape:
//   { local, sku, producto, color, talle, cantidad, precio }
//
// Cobertura real de cada fuente:
//   · Dragonfish (Dot, Abasto, Córdoba) → cantidades exactas por artículo/color/talle.
//     Son los únicos con inventario real y por eso los únicos que entran al análisis.
//   · Tiendanube (Online)               → NO USABLE: la tienda vende sobre prendas en
//     crudo que se estampan a demanda, así que su "stock" no representa unidades
//     físicas de ese modelo. Se sigue consultando (queda guardado aparte) pero no
//     alimenta rotación ni GMROI.
//   · WooCommerce (Palermo, La Plata)   → cantidades exactas, pero a nivel VARIACIÓN
//     (el producto padre siempre informa manage_stock=false).
const { dfLocales, wooLocales } = require("./fuentes");

// Por encima de esto, la cantidad es un marcador de "stock ilimitado", no stock real
const STOCK_ILIMITADO = 1000;

// ── Dragonfish ──
async function fetchStockDF(local) {
  const filas = [];
  let page = 1;
  const limit = 200, maxPages = 40;
  try {
    while (page <= maxPages) {
      const qs = new URLSearchParams({ query: "", limit: String(limit), page: String(page), stockcero: "false" });
      let r = null, lastErr = null;
      for (let intento = 1; intento <= 3; intento++) {
        try {
          r = await fetch(`${local.url}/api.Dragonfish/ConsultaStockYPrecios/?${qs}`, {
            headers: {
              "Content-Type": "application/json",
              "idCliente": local.idCliente,
              "Authorization": local.token,
              "BaseDeDatos": local.baseDatos,
            },
            signal: AbortSignal.timeout(45000),
          });
          if (r.ok) break;
          lastErr = `HTTP ${r.status}`; r = null;
        } catch (e) { lastErr = e.message; r = null; }
        if (intento < 3) await new Promise(res => setTimeout(res, 2000 * intento));
      }
      if (!r) return { ok: false, filas, error: `${lastErr} en página ${page}` };

      const data = await r.json();
      const rows = Array.isArray(data) ? data : (data.Resultados || []);
      if (!rows.length) break;
      for (const row of rows) {
        const cantidad = parseFloat(row.Stock || 0);
        if (!(cantidad > 0)) continue;
        let precio = parseFloat(row.Precio || 0);
        if (Array.isArray(row.Precios)) {
          const pub = row.Precios.find(p => /publico/i.test(p.Lista || ""));
          if (pub && parseFloat(pub.Precio) > 0) precio = parseFloat(pub.Precio);
        }
        filas.push({
          local: local.nombre,
          sku: row.Articulo || "",
          producto: row.ArticuloDescripcion || row.Descripcion || "",
          color: row.ColorDescripcion || row.Color || "",
          talle: row.TalleDescripcion || row.Talle || "",
          cantidad,
          precio: Math.round(precio) || null,
        });
      }
      if (rows.length < limit) break;
      page++;
    }
    return { ok: true, filas, error: null };
  } catch (e) {
    return { ok: false, filas, error: e.message };
  }
}

// ── Tiendanube ──
async function fetchStockTN(env = process.env) {
  const token = env.TN_ACCESS_TOKEN, userId = env.TN_USER_ID;
  if (!token || !userId) return { ok: false, filas: [], error: "sin credenciales TN" };
  const filas = [];
  let page = 1;
  try {
    while (page <= 20) {
      const r = await fetch(`https://api.tiendanube.com/v1/${userId}/products?per_page=200&page=${page}`, {
        headers: { Authentication: `bearer ${token}`, "User-Agent": "TussyApp/1.0" },
        signal: AbortSignal.timeout(45000),
      });
      if (r.status === 404) break;
      if (!r.ok) return { ok: false, filas, error: `HTTP ${r.status} en página ${page}` };
      const productos = await r.json();
      if (!Array.isArray(productos) || !productos.length) break;

      for (const p of productos) {
        const nombre = typeof p.name === "object" ? (p.name.es || Object.values(p.name)[0] || "") : (p.name || "");
        for (const v of p.variants || []) {
          // Tiendanube usa números enormes (9999, 9965) como "stock ilimitado" en
          // las variantes que no controla. El stock real nunca pasa de 100 por
          // variante, así que todo lo que supere el umbral es un marcador, no stock.
          const cantidad = v.stock == null ? 0 : Number(v.stock);
          if (!(cantidad > 0) || cantidad >= STOCK_ILIMITADO) continue;
          const vals = (v.values || []).map(x => (typeof x === "object" ? (x.es || Object.values(x)[0]) : x));
          filas.push({
            local: "Tiendanube",
            sku: v.sku || "",
            producto: nombre,
            color: vals[0] || "",
            talle: vals[1] || "",
            cantidad,
            precio: v.price ? Math.round(parseFloat(v.price)) : null,
          });
        }
      }
      if (productos.length < 200) break;
      page++;
    }
    return { ok: true, filas, error: null };
  } catch (e) {
    return { ok: false, filas, error: e.message };
  }
}

// ── WooCommerce (Palermo, La Plata) ──
// El stock vive en las VARIACIONES, no en el producto padre: en los productos
// variables el padre trae manage_stock=false y cada variación lleva su propio
// stock_quantity. Se consultan solo los productos con stock (stock_status=instock),
// que son unas pocas decenas, y se piden sus variaciones con concurrencia acotada.
async function fetchStockWoo(local) {
  const auth = Buffer.from(`${local.key}:${local.secret}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };
  const filas = [];

  async function traer(url) {
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
        if (r.ok) return r.json();
        if (intento === 3) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        if (intento === 3) throw e;
      }
      await new Promise(res => setTimeout(res, 1500 * intento));
    }
  }

  try {
    // 1) Productos con stock
    const productos = [];
    for (let page = 1; page <= 15; page++) {
      const lote = await traer(`${local.url}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish&stock_status=instock`);
      if (!Array.isArray(lote) || !lote.length) break;
      productos.push(...lote);
      if (lote.length < 100) break;
    }

    // 2) Variaciones, de a tandas para no saturar el sitio
    const CONCURRENCIA = 6;
    for (let i = 0; i < productos.length; i += CONCURRENCIA) {
      const tanda = productos.slice(i, i + CONCURRENCIA);
      await Promise.all(tanda.map(async p => {
        if (p.type !== "variable") {
          // Producto simple: el stock está en el padre
          const cantidad = p.manage_stock === true && p.stock_quantity != null ? Number(p.stock_quantity) : 0;
          if (cantidad > 0) {
            filas.push({
              local: local.nombre, sku: p.sku || "", producto: p.name || "",
              color: "", talle: "", cantidad,
              precio: p.price ? Math.round(parseFloat(p.price)) : null,
            });
          }
          return;
        }
        const variaciones = await traer(`${local.url}/wp-json/wc/v3/products/${p.id}/variations?per_page=100`);
        if (!Array.isArray(variaciones)) return;
        for (const v of variaciones) {
          const cantidad = v.stock_quantity == null ? 0 : Number(v.stock_quantity);
          if (!(cantidad > 0) || cantidad >= STOCK_ILIMITADO) continue;
          const attrs = (v.attributes || []).map(a => a.option).filter(Boolean);
          filas.push({
            local: local.nombre, sku: v.sku || p.sku || "", producto: p.name || "",
            color: attrs[0] || "", talle: attrs[1] || "",
            cantidad,
            precio: v.price ? Math.round(parseFloat(v.price)) : null,
          });
        }
      }));
    }
    return { ok: true, filas, error: null, productos_revisados: productos.length };
  } catch (e) {
    return { ok: false, filas, error: e.message };
  }
}

// Los cinco locales físicos tienen inventario real. Online queda afuera.
function fuentesStock(env = process.env) {
  return [
    ...dfLocales(env).map(l => ({ local: l.nombre, fn: () => fetchStockDF(l) })),
    ...wooLocales(env).map(l => ({ local: l.nombre, fn: () => fetchStockWoo(l) })),
  ];
}

// Solo la web queda fuera del análisis de inventario
const LOCALES_SIN_STOCK = ["Tiendanube"];
const MOTIVO_SIN_STOCK = {
  "Tiendanube": "vende sobre prendas en crudo estampadas a demanda",
};

module.exports = { fetchStockDF, fetchStockTN, fetchStockWoo, fuentesStock, LOCALES_SIN_STOCK, MOTIVO_SIN_STOCK };
