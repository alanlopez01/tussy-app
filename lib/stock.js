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
//     (el producto padre siempre informa manage_stock=false). Quedó como fuente
//     histórica: desde el pase al ERP esos dos locales salen de ahí.
//   · Tussy ERP (Palermo, La Plata)     → cantidades exactas por variante, leídas
//     directo de la base. Es la fuente real de esos dos locales desde el
//     19-ago-2026.
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

// ── Tussy ERP (Palermo y La Plata) ──
//
// Esos dos locales dejaron WooCommerce el 19-ago-2026 y su inventario real vive
// en el ERP (Supabase). Se lee directo de la base con un usuario de SOLO LECTURA
// (orquestador_lectura), que tiene SELECT sobre inventory, product_variants,
// products y locations y nada más.
//
// El local se identifica por `code` y no por `name`: el esquema del ERP define
// code como slug inmutable, mientras que name se puede editar desde la UI.
const ERP_CODE_POR_LOCAL = {
  "Palermo": "palermo",
  "La Plata": "la-plata",
};

// La contraseña del ERP trae un `#`, que en una URL abre el fragmento y parte la
// cadena al medio: pg la rechaza con un escueto "Invalid URL". Lo correcto sería
// guardarla percent-encodeada, pero el valor lo pega una persona a mano y ese
// error no dice nada, así que se normaliza acá.
function cadenaConexionERP(cadena) {
  try { new URL(cadena); return cadena; } catch { /* sigue abajo */ }
  const m = cadena.match(/^(postgresql?:\/\/)([^:@/]+):(.*)@([^@]+)$/);
  if (!m) return cadena;                       // que falle con su propio mensaje
  const [, esquema, usuario, pass, resto] = m;
  return `${esquema}${usuario}:${encodeURIComponent(pass)}@${resto}`;
}

async function fetchStockERP(local, env = process.env) {
  const nombre = typeof local === "string" ? local : local.nombre;
  const code = ERP_CODE_POR_LOCAL[nombre];
  if (!code) return { ok: false, filas: [], error: `no hay mapeo de "${nombre}" a un local del ERP` };
  if (!env.TUSSY_ERP_DATABASE_URL) return { ok: false, filas: [], error: "falta TUSSY_ERP_DATABASE_URL" };

  const { Client } = require("pg");
  const client = new Client({
    connectionString: cadenaConexionERP(env.TUSSY_ERP_DATABASE_URL),
    ssl: { rejectUnauthorized: false },   // el pooler de Supabase presenta un certificado propio
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    query_timeout: 30000,
    application_name: "tussy-app/stock",
  });

  try {
    await client.connect();
    // Una sola consulta. El precio es integer en CENTAVOS y product_variants.price
    // puede venir NULL, en cuyo caso manda products.base_price (lo dice el esquema).
    const { rows } = await client.query(
      `SELECT pv.sku,
              p.name                           AS producto,
              pv.color,
              pv.size                          AS talle,
              i.quantity                       AS cantidad,
              COALESCE(pv.price, p.base_price) AS precio_centavos
         FROM public.inventory       i
         JOIN public.product_variants pv ON pv.id  = i.variant_id
         JOIN public.products         p  ON p.id   = pv.product_id
         JOIN public.locations        loc ON loc.id = i.location_id
        WHERE loc.code = $1
          AND i.quantity > 0
        ORDER BY p.name, pv.size, pv.color`,
      [code]
    );
    const filas = rows.map(r => ({
      local: nombre,
      sku: r.sku || "",
      producto: r.producto || "",
      color: r.color || "",
      talle: r.talle || "",
      cantidad: Number(r.cantidad),
      // A pesos, que es la unidad del resto de la tabla stock.
      precio: r.precio_centavos == null ? null : Math.round(Number(r.precio_centavos) / 100),
    }));
    return { ok: true, filas, error: null };
  } catch (e) {
    return { ok: false, filas: [], error: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}

// Los cinco locales físicos tienen inventario real. Online queda afuera.
function fuentesStock(env = process.env) {
  const conERP = Boolean(env.TUSSY_ERP_DATABASE_URL);
  const delERP = Object.keys(ERP_CODE_POR_LOCAL);
  return [
    ...dfLocales(env).map(l => ({ local: l.nombre, fn: () => fetchStockDF(l) })),
    // Con el ERP configurado, Palermo y La Plata salen de ahí y se los saca de
    // Woo, para que el mismo local no entre dos veces. Sin la variable, todo
    // sigue como antes.
    ...wooLocales(env)
      .filter(l => !(conERP && delERP.includes(l.nombre)))
      .map(l => ({ local: l.nombre, fn: () => fetchStockWoo(l) })),
    ...(conERP ? delERP.map(nombre => ({ local: nombre, fn: () => fetchStockERP(nombre, env) })) : []),
  ];
}

// Solo la web queda fuera del análisis de inventario
const LOCALES_SIN_STOCK = ["Tiendanube"];
const MOTIVO_SIN_STOCK = {
  "Tiendanube": "vende sobre prendas en crudo estampadas a demanda",
};

module.exports = { fetchStockDF, fetchStockTN, fetchStockWoo, fetchStockERP, fuentesStock, LOCALES_SIN_STOCK, MOTIVO_SIN_STOCK };
