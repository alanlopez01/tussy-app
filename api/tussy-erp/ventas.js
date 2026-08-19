// Webhook del Tussy ERP (Supabase): recibe cada venta confirmada de los locales
// que migraron de WooCommerce al sistema propio (Palermo y La Plata por ahora).
//
// El ERP empuja un POST por venta en el momento del cobro. Acá se valida el
// secreto compartido, se garantiza idempotencia por sale_id y se escribe en las
// mismas tablas que la ingesta (ventas + cobros) con sistema='erp', así la venta
// aparece al instante en Pedidos y suma a todos los reportes. La ingesta de Woo
// nunca toca filas sistema='erp' (excluidas de sus DELETE de reescritura).
//
// Dinero: el ERP manda SIEMPRE centavos enteros; acá se divide por 100.
const { neon } = require("@neondatabase/serverless");
const webpush = require("web-push");
const { normalizarProducto } = require("../../lib/normalizar");

// Copia mínima del envío de push de la ingesta: ventas sueltas van a los socios
// (excepto Alan, que solo recibe pauta y resumen semanal), de 9 a 23 ARG.
async function notificarVenta(local, total, unidades, hora) {
  try {
    const h = parseInt(new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(11, 13));
    if (h < 9 || h >= 23) return;
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
    webpush.setVapidDetails("mailto:alansergio67@gmail.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const subsResp = await fetch(`${process.env.APPS_SCRIPT_URL_OPERACIONES}?action=getPushSubs&params=%7B%7D`,
      { redirect: "follow", signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
    const subs = (subsResp?.subs || []).filter(s => String(s.usuario || "").trim().toLowerCase() !== "alan");
    const fmt = n => "$" + Math.round(n).toLocaleString("es-AR");
    const payload = JSON.stringify({
      title: `Venta ${local}`,
      body: `${fmt(total)} · ${unidades} ${unidades === 1 ? "unidad" : "unidades"}${hora ? " · " + hora : ""}`,
      url: "/pedidos",
    });
    for (const sub of subs) {
      try { await webpush.sendNotification(sub.subscription, payload); } catch { /* sub vencida */ }
    }
  } catch { /* nunca bloquear la respuesta al ERP */ }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });

  const secreto = process.env.TUSSY_ERP_SECRET;
  if (!secreto || req.headers["x-tussy-erp-secret"] !== secreto) {
    return res.status(401).json({ error: "no autorizado" });
  }

  const v = req.body;
  if (!v || v.evento !== "venta_nueva" || !v.sale_id || !v.local || !Array.isArray(v.items)) {
    return res.status(400).json({ error: "payload inválido: se espera evento venta_nueva con sale_id, local e items" });
  }

  const sql = neon(process.env.DATABASE_URL);

  // Idempotencia: el mismo sale_id puede llegar de nuevo por reintentos del ERP
  const [ya] = await sql`SELECT 1 AS uno FROM ventas WHERE sistema = 'erp' AND orden_id = ${v.sale_id} LIMIT 1`;
  if (ya) return res.status(200).json({ ok: true, duplicado: true });

  const fechaIso = String(v.fecha || "");
  const fecha = fechaIso.slice(0, 10) || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const hora = /T\d\d:\d\d/.test(fechaIso) ? fechaIso.slice(11, 16) : null;
  const aPesos = c => Math.round(Number(c) || 0) / 100;

  const filas = v.items.map(it => ({
    producto: String(it.producto || "SIN NOMBRE").toUpperCase(),
    sku: it.sku != null ? String(it.sku) : null,
    color: it.color || null,
    talle: it.talle || null,
    cantidad: Number(it.cantidad) || 0,
    precio_unit: aPesos(it.precio_unitario_centavos),
    total: aPesos((Number(it.precio_unitario_centavos) || 0) * (Number(it.cantidad) || 0) - (Number(it.descuento_centavos) || 0)),
  }));
  // La suma de filas debe igualar el total del ERP: la diferencia (descuento
  // global, redondeos) entra como fila DESCUENTO/AJUSTE, igual que en Woo/TN.
  const sumaFilas = filas.reduce((a, f) => a + f.total, 0);
  const totalVenta = aPesos(v.total_centavos);
  const dif = Math.round((totalVenta - sumaFilas) * 100) / 100;
  if (Math.abs(dif) >= 0.01) {
    filas.push({ producto: dif < 0 ? "DESCUENTO" : "AJUSTE", sku: null, color: null, talle: null, cantidad: 0, precio_unit: 0, total: dif });
  }

  for (const f of filas) {
    await sql`INSERT INTO ventas (fecha, local, sistema, orden_id, hora, producto, producto_norm, sku, color, talle, cantidad, precio_unit, total)
      VALUES (${fecha}, ${v.local}, 'erp', ${v.sale_id}, ${hora}, ${f.producto}, ${normalizarProducto(f.producto).nombre},
              ${f.sku}, ${f.color}, ${f.talle}, ${f.cantidad}, ${f.precio_unit}, ${f.total})`;
  }

  // Cobro: efectivo va como efectivo; tarjeta y mixto como electrónico (el mixto
  // tiene parte tarjeta y debe facturarse); cupon/saldo quedan como otro.
  const medio = v.medio_pago === "efectivo" ? "efectivo"
    : (v.medio_pago === "tarjeta" || v.medio_pago === "mixto") ? "electronico" : "otro";
  await sql`INSERT INTO cobros (fecha, local, orden_id, item, medio, detalle, monto, sistema)
    VALUES (${fecha}, ${v.local}, ${v.sale_id}, 0, ${medio}, ${"erp " + (v.medio_pago || "")}, ${totalVenta}, 'erp')
    ON CONFLICT (local, orden_id, item) DO NOTHING`;

  const unidades = filas.reduce((a, f) => a + (["DESCUENTO", "AJUSTE", "ENVIO"].includes(f.producto) ? 0 : f.cantidad), 0);
  res.status(200).json({ ok: true, filas: filas.length, total: totalVenta });
  // La notificación sale después de responder (el ERP exige 200 en <3s)
  await notificarVenta(v.local, totalVenta, unidades, hora);
};
