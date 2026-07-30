// Fetchers de inventario. Devuelven { ok, filas, error } con shape:
//   { local, sku, producto, color, talle, cantidad, precio }
//
// Cobertura real de cada fuente:
//   · Dragonfish (Dot, Abasto, Córdoba) → cantidades exactas por artículo/color/talle
//   · Tiendanube (Online)               → cantidades exactas por variante
//   · WooCommerce (Palermo, La Plata)   → NO USABLE: casi ningún producto tiene
//     "gestión de inventario" activada (0,4% Palermo, 1,6% La Plata), así que
//     solo informan si hay o no hay. Quedan fuera del snapshot; para incluirlos
//     habría que activar el control de stock en WooCommerce.
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

// ── WooCommerce (parcial) ──
// Solo los productos con manage_stock activo informan cantidad. Devolvemos también
// cuántos productos del catálogo la informan, para poder mostrar la cobertura real.
async function fetchStockWoo(local) {
  const auth = Buffer.from(`${local.key}:${local.secret}`).toString("base64");
  const filas = [];
  let page = 1, totalProductos = 0, conCantidad = 0;
  try {
    while (page <= 15) {
      const r = await fetch(`${local.url}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) return { ok: false, filas, error: `HTTP ${r.status} en página ${page}` };
      const productos = await r.json();
      if (!Array.isArray(productos) || !productos.length) break;

      for (const p of productos) {
        totalProductos++;
        if (p.manage_stock !== true || p.stock_quantity == null) continue;
        const cantidad = Number(p.stock_quantity);
        if (!(cantidad > 0)) continue;
        conCantidad++;
        filas.push({
          local: local.nombre,
          sku: p.sku || "",
          producto: p.name || "",
          color: "", talle: "",
          cantidad,
          precio: p.price ? Math.round(parseFloat(p.price)) : null,
        });
      }
      if (productos.length < 100) break;
      page++;
    }
    return {
      ok: true, filas, error: null,
      cobertura: totalProductos > 0 ? Math.round(conCantidad / totalProductos * 1000) / 10 : 0,
    };
  } catch (e) {
    return { ok: false, filas, error: e.message };
  }
}

// Fuentes con inventario confiable. WooCommerce queda afuera a propósito
// (ver nota arriba): incluirlo daría un stock casi vacío para Palermo y La Plata
// y ensuciaría los cálculos de rotación.
function fuentesStock(env = process.env) {
  const fuentes = [];
  for (const l of dfLocales(env)) fuentes.push({ local: l.nombre, fn: () => fetchStockDF(l) });
  fuentes.push({ local: "Tiendanube", fn: () => fetchStockTN(env) });
  return fuentes;
}

// Locales sin datos de inventario, para poder avisarlo en la app
const LOCALES_SIN_STOCK = ["Palermo", "La Plata"];

module.exports = { fetchStockDF, fetchStockTN, fetchStockWoo, fuentesStock, LOCALES_SIN_STOCK };
