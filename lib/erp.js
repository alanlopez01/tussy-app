// Lectura directa de la base del Tussy ERP (Supabase), con el usuario de SOLO
// LECTURA `orquestador_lectura`. Dos usos:
//   · el stock de Palermo y La Plata (lib/stock.js)
//   · la red de seguridad del webhook de ventas (reponerVentasFaltantes)
//
// El ERP empuja cada venta por webhook a api/tussy-erp/ventas. Si un POST se
// pierde, esa venta no vuelve a intentarse nunca y queda un agujero mudo. Leer
// la base de origen es la única forma de enterarse.
const { normalizarProducto } = require("./normalizar");

// La contraseña trae un `#`, que en una URL abre el fragmento y parte la cadena
// al medio: pg la rechaza con un escueto "Invalid URL". Lo correcto sería
// guardarla percent-encodeada, pero el valor lo pega una persona a mano y ese
// error no dice nada, así que se normaliza acá.
function cadenaConexionERP(cadena) {
  try { new URL(cadena); return cadena; } catch { /* sigue abajo */ }
  const m = cadena.match(/^(postgresql?:\/\/)([^:@/]+):(.*)@([^@]+)$/);
  if (!m) return cadena;                       // que falle con su propio mensaje
  const [, esquema, usuario, pass, resto] = m;
  return `${esquema}${usuario}:${encodeURIComponent(pass)}@${resto}`;
}

function clienteERP(env = process.env) {
  if (!env.TUSSY_ERP_DATABASE_URL) return null;
  const { Client } = require("pg");
  return new Client({
    connectionString: cadenaConexionERP(env.TUSSY_ERP_DATABASE_URL),
    ssl: { rejectUnauthorized: false },   // el pooler de Supabase presenta un certificado propio
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    query_timeout: 30000,
    application_name: "tussy-app",
  });
}

const aPesos = c => Math.round(Number(c) || 0) / 100;

// Repone las ventas del ERP que no llegaron por webhook. Sólo INSERTA: nunca
// borra ni reescribe un día, así que no puede pisar nada de lo que ya entró.
//
// Arma cada venta igual que api/tussy-erp/ventas.js —una línea por renglón y la
// diferencia contra el total cobrado como DESCUENTO/AJUSTE— para que una venta
// repuesta sea indistinguible de una que llegó sola. Los renglones de sale_items
// son precio de lista; el cobrado es sales.total.
async function reponerVentasFaltantes(sql, dias = 7) {
  const cliente = clienteERP();
  if (!cliente) return { ok: false, error: "falta TUSSY_ERP_DATABASE_URL" };
  const desde = new Date(Date.now() - 3 * 3600 * 1000 - dias * 86400000).toISOString().slice(0, 10);
  try {
    await cliente.connect();
    const { rows } = await cliente.query(`
      SELECT s.id::text sale_id, loc.name local, s.total, s.payment_method,
             (s.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text dia,
             to_char(s.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires','HH24:MI') hora,
             p.name producto, pv.sku, pv.color, pv.size talle, si.quantity, si.unit_price
        FROM public.sales s
        JOIN public.sale_items si ON si.sale_id = s.id
        JOIN public.product_variants pv ON pv.id = si.variant_id
        JOIN public.products p ON p.id = pv.product_id
        JOIN public.locations loc ON loc.id = s.location_id
       WHERE s.voided_at IS NULL
         AND (s.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $1::date
       ORDER BY s.created_at`, [desde]);

    const porVenta = new Map();
    for (const r of rows) {
      if (!porVenta.has(r.sale_id)) porVenta.set(r.sale_id, { ...r, items: [] });
      porVenta.get(r.sale_id).items.push(r);
    }
    if (!porVenta.size) return { ok: true, revisadas: 0, repuestas: 0, pesos: 0, desde };

    const presentes = new Set((await sql`
      SELECT DISTINCT orden_id FROM ventas
      WHERE sistema = 'erp' AND orden_id = ANY(${[...porVenta.keys()]})`).map(x => String(x.orden_id)));

    let repuestas = 0, pesos = 0;
    const detalle = [];
    for (const [sid, v] of porVenta) {
      if (presentes.has(sid)) continue;
      const filas = v.items.map(it => ({
        producto: String(it.producto || "SIN NOMBRE").toUpperCase(),
        sku: it.sku || null, color: it.color || null, talle: it.talle || null,
        cantidad: Number(it.quantity) || 0,
        precio_unit: aPesos(it.unit_price),
        total: aPesos(Number(it.unit_price) * Number(it.quantity)),
      }));
      const total = aPesos(v.total);
      const dif = Math.round((total - filas.reduce((a, f) => a + f.total, 0)) * 100) / 100;
      if (Math.abs(dif) >= 0.01) {
        filas.push({ producto: dif < 0 ? "DESCUENTO" : "AJUSTE", sku: null, color: null, talle: null, cantidad: 0, precio_unit: 0, total: dif });
      }
      for (const f of filas) {
        await sql`INSERT INTO ventas (fecha, local, sistema, orden_id, hora, producto, producto_norm, sku, color, talle, cantidad, precio_unit, total)
          VALUES (${v.dia}, ${v.local}, 'erp', ${sid}, ${v.hora}, ${f.producto}, ${normalizarProducto(f.producto).nombre},
                  ${f.sku}, ${f.color}, ${f.talle}, ${f.cantidad}, ${f.precio_unit}, ${f.total})`;
      }
      const medio = v.payment_method === "efectivo" ? "efectivo"
        : (v.payment_method === "tarjeta" || v.payment_method === "mixto") ? "electronico" : "otro";
      await sql`INSERT INTO cobros (fecha, local, orden_id, item, medio, detalle, monto, sistema)
        VALUES (${v.dia}, ${v.local}, ${sid}, 0, ${medio}, ${"erp " + (v.payment_method || "")}, ${total}, 'erp')
        ON CONFLICT (local, orden_id, item) DO NOTHING`;
      repuestas++; pesos += total;
      detalle.push(`${v.local} ${v.dia} ${v.hora} $${Math.round(total)}`);
    }
    return { ok: true, revisadas: porVenta.size, repuestas, pesos: Math.round(pesos), desde, detalle };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await cliente.end().catch(() => {});
  }
}

module.exports = { cadenaConexionERP, clienteERP, reponerVentasFaltantes };
