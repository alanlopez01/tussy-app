// Métricas desde Postgres (Neon) — la fuente de verdad nueva.
// GET /api/metricas?action=serie&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
//   → { dias: [{fecha, palermo, laplata, online, dot, abasto, cordoba, total, ops}] }
// GET /api/metricas?action=topProductos&desde=&hasta=&local=&orden=cantidad|total&limite=20
// GET /api/metricas?action=categorias / variantes — agregados por categoría / talle+color
// GET /api/metricas?action=live&local=palermo|laplata|online|dot|abasto|cordoba[&fecha=]
//   → ventas del día en vivo desde la fuente, agrupadas por operación
// GET /api/metricas?action=feed[&limite=40] — últimas operaciones de todos los locales (desde la base)
// GET /api/metricas?action=ingesta&secret=… — cron cada 5 min: ingesta del día + detección
//   de ventas nuevas + push. Lo dispara cron-job.org.
// GET /api/metricas?action=sync — (fecha, local) con errores de sincronización
const { neon } = require("@neondatabase/serverless");
const { waitUntil } = require("@vercel/functions");
const webpush = require("web-push");
const { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFDia } = require("../lib/fuentes");

const KEY_LOCAL = {
  "Palermo": "palermo", "La Plata": "laplata", "Tiendanube": "online",
  "Dot": "dot", "Abasto": "abasto", "Córdoba": "cordoba", "Cordoba": "cordoba",
};

const { normalizarProducto } = require("../lib/normalizar");

// Ventas del día en vivo por local, agrupadas por operación (no toca la base)
async function ventasLive(req, res) {
  const local = String(req.query.local || "").toLowerCase();
  const fecha = req.query.fecha || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  let r, nombre;
  if (local === "palermo" || local === "laplata") {
    const cfg = wooLocales().find(l => (local === "palermo" ? l.nombre === "Palermo" : l.nombre === "La Plata"));
    if (!cfg) return res.status(503).json({ ok: false, error: "local sin credenciales" });
    nombre = cfg.nombre;
    r = await fetchWooDia(cfg, fecha);
  } else if (local === "online") {
    nombre = "Online";
    r = await fetchTNDia(fecha);
  } else if (local === "dot" || local === "abasto" || local === "cordoba") {
    const cfg = dfLocales().find(l => l.key === local);
    if (!cfg) return res.status(503).json({ ok: false, error: "local sin credenciales" });
    nombre = cfg.nombre;
    r = await fetchDFDia(cfg, fecha);
  } else {
    return res.status(400).json({ ok: false, error: "local inválido" });
  }

  if (!r.ok) return res.status(200).json({ ok: false, local: nombre, fecha, error: r.error, operaciones: [] });

  const ops = {};
  for (const f of r.filas) {
    const id = f.orden_id || "s/n";
    if (!ops[id]) ops[id] = { orden_id: id, hora: f.hora || null, total: 0, unidades: 0, items: [] };
    ops[id].total += Number(f.total) || 0;
    if (!["ENVIO", "DESCUENTO", "AJUSTE"].includes(f.producto)) {
      ops[id].unidades += Number(f.cantidad) || 0;
      ops[id].items.push({ producto: f.producto, cantidad: f.cantidad, talle: f.talle, color: f.color });
    }
    if (f.hora && (!ops[id].hora || f.hora > ops[id].hora)) ops[id].hora = f.hora;
  }
  const operaciones = Object.values(ops)
    .map(o => ({ ...o, total: Math.round(o.total) }))
    .sort((a, b) => String(b.hora || "").localeCompare(String(a.hora || "")));

  return res.status(200).json({
    ok: true, local: nombre, fecha,
    total: operaciones.reduce((a, o) => a + o.total, 0),
    ops: operaciones.length,
    operaciones,
  });
}

// ── Ingesta cada 5 min: persiste el día en curso, detecta ventas nuevas y notifica ──

function hoyArg() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function horaArgNum() { return parseInt(new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(11, 13)); }

const NO_PRODUCTO = ["ENVIO", "DESCUENTO", "AJUSTE"];

async function escribirDiaLocal(sql, fecha, local, filas) {
  await sql`DELETE FROM ventas WHERE fecha = ${fecha} AND local = ${local}`;
  for (let i = 0; i < filas.length; i += 500) {
    const c = filas.slice(i, i + 500);
    await sql`
      INSERT INTO ventas (fecha, local, sistema, orden_id, hora, producto, producto_norm, sku, color, talle, cantidad, precio_unit, total)
      SELECT * FROM UNNEST(
        ${c.map(f => f.fecha)}::date[], ${c.map(f => f.local)}::text[], ${c.map(f => f.sistema)}::text[],
        ${c.map(f => f.orden_id || null)}::text[], ${c.map(f => f.hora || null)}::text[],
        ${c.map(f => f.producto)}::text[], ${c.map(f => normalizarProducto(f.producto).nombre)}::text[],
        ${c.map(f => f.sku)}::text[], ${c.map(f => f.color)}::text[],
        ${c.map(f => f.talle)}::text[], ${c.map(f => f.cantidad)}::numeric[],
        ${c.map(f => f.precio_unit)}::numeric[], ${c.map(f => f.total)}::numeric[]
      )`;
  }
}

async function marcarSync(sql, fecha, local, ok, error) {
  await sql`
    INSERT INTO sync_estado (fecha, local, estado, intentos, ultimo_error, actualizado_en)
    VALUES (${fecha}, ${local}, ${ok ? "ok" : "error"}, 1, ${error || null}, now())
    ON CONFLICT (fecha, local) DO UPDATE SET
      estado = EXCLUDED.estado, intentos = sync_estado.intentos + 1,
      ultimo_error = EXCLUDED.ultimo_error, actualizado_en = now()`;
}

function fuentesDelDia() {
  const fuentes = [];
  for (const l of wooLocales()) fuentes.push({ local: l.nombre, fn: f => fetchWooDia(l, f) });
  fuentes.push({ local: "Tiendanube", fn: f => fetchTNDia(f) });
  for (const l of dfLocales()) fuentes.push({ local: l.nombre, fn: f => fetchDFDia(l, f) });
  return fuentes;
}

async function ingesta(req, res) {
  const secret = process.env.CRON_SECRET || "tussy2026";
  if (req.query.secret !== secret) return res.status(401).json({ error: "secret inválido" });

  // cron-job.org corta a los 30s y la ingesta puede tardar más (6 fuentes, POS lentos).
  // Respondemos al instante y el trabajo sigue de fondo hasta maxDuration (waitUntil).
  // Con ?sync=1 corre en línea y devuelve el resultado completo (para debug).
  if (req.query.sync !== "1") {
    waitUntil(correrIngesta().catch(e => console.error("[ingesta] error:", e)));
    return res.status(200).json({ ok: true, encolado: true });
  }
  return res.status(200).json(await correrIngesta());
}

async function correrIngesta() {
  const sql = neon(process.env.DATABASE_URL);
  const hoy = hoyArg();
  const eventos = [];
  const resumen = [];

  // 1) Día en curso: todas las fuentes en paralelo
  await Promise.allSettled(fuentesDelDia().map(async ({ local, fn }) => {
    const r = await fn(hoy);
    if (!r.ok) {
      await marcarSync(sql, hoy, local, false, r.error);
      resumen.push({ local, ok: false, error: r.error });
      return;
    }
    // Detectar operaciones nuevas comparando contra lo ya guardado
    const previas = await sql`SELECT DISTINCT orden_id FROM ventas WHERE fecha = ${hoy} AND local = ${local} AND orden_id IS NOT NULL`;
    const idsPrevios = new Set(previas.map(p => p.orden_id));
    const porOrden = {};
    for (const f of r.filas) {
      const id = f.orden_id || "s/n";
      if (!porOrden[id]) porOrden[id] = { total: 0, unidades: 0, hora: f.hora || null };
      porOrden[id].total += Number(f.total) || 0;
      if (!NO_PRODUCTO.includes(f.producto)) porOrden[id].unidades += Number(f.cantidad) || 0;
    }
    const habiaBaseline = idsPrevios.size > 0;
    for (const [id, op] of Object.entries(porOrden)) {
      if (!idsPrevios.has(id) && habiaBaseline) {
        eventos.push({ local, orden_id: id, total: Math.round(op.total), unidades: op.unidades, hora: op.hora });
      }
    }
    await escribirDiaLocal(sql, hoy, local, r.filas);
    await marcarSync(sql, hoy, local, true, null);
    resumen.push({ local, ok: true, filas: r.filas.length, nuevas: habiaBaseline ? Object.keys(porOrden).filter(id => !idsPrevios.has(id)).length : 0 });
  }));

  // 2) Reintentar hasta 2 (fecha, local) pendientes de los últimos 7 días (ej. Córdoba apagada el finde)
  const pendientes = await sql`
    SELECT fecha::text, local FROM sync_estado
    WHERE estado = 'error' AND fecha >= ${hoy}::date - 7 AND fecha < ${hoy}
    ORDER BY fecha DESC LIMIT 2`;
  for (const p of pendientes) {
    const fuente = fuentesDelDia().find(f => f.local === p.local);
    if (!fuente) continue;
    const r = await fuente.fn(p.fecha);
    if (r.ok) {
      await escribirDiaLocal(sql, p.fecha, p.local, r.filas);
      await marcarSync(sql, p.fecha, p.local, true, null);
      resumen.push({ local: p.local, fecha: p.fecha, ok: true, recuperado: true, filas: r.filas.length });
    } else {
      await marcarSync(sql, p.fecha, p.local, false, r.error);
    }
  }

  // 3) Notificaciones push (9 a 23 ARG)
  let notificadas = 0;
  const hora = horaArgNum();
  if (eventos.length > 0 && hora >= 9 && hora < 23) {
    const fmt = n => "$" + Math.round(n).toLocaleString("es-AR");
    // Muchas ventas juntas (puesta al día) → una sola notificación resumen
    const payloads = eventos.length > 6
      ? [{ title: "Tussy — ventas nuevas", body: `${eventos.length} ventas · ${fmt(eventos.reduce((a, e) => a + e.total, 0))}`, url: "/pedidos" }]
      : eventos.map(e => ({
          title: `Venta ${e.local === "Tiendanube" ? "Online" : e.local}`,
          body: `${fmt(e.total)} · ${e.unidades} ${e.unidades === 1 ? "unidad" : "unidades"}${e.hora ? " · " + e.hora : ""}`,
          url: "/pedidos",
        }));
    notificadas = await enviarPush(payloads);
  }

  const salida = { ok: true, fecha: hoy, resumen, eventos: eventos.length, notificadas };
  console.log("[ingesta]", JSON.stringify(salida));
  return salida;
}

// ── Envío de push a todas las suscripciones guardadas ──
async function enviarPush(payloads) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return 0;
  let enviadas = 0;
  try {
    webpush.setVapidDetails("mailto:alansergio67@gmail.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const opsUrl = process.env.APPS_SCRIPT_URL_OPERACIONES;
    const subsResp = await fetch(`${opsUrl}?action=getPushSubs&params=%7B%7D`, { redirect: "follow", signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
    const subs = subsResp?.subs || [];
    for (const sub of subs) {
      for (const p of payloads) {
        try { await webpush.sendNotification(sub.subscription, JSON.stringify(p)); enviadas++; } catch { /* sub vencida */ }
      }
    }
  } catch { /* no bloquear */ }
  return enviadas;
}

// Totales por local para un rango, desde la base
async function totalesRango(sql, desde, hasta) {
  const rows = await sql`
    SELECT local, ROUND(SUM(total))::bigint AS total
    FROM ventas WHERE fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY local ORDER BY SUM(total) DESC`;
  const total = rows.reduce((a, r) => a + Number(r.total), 0);
  return { rows, total };
}

const CORTO_LOCAL = { "Palermo": "Pal", "La Plata": "LP", "Tiendanube": "Online", "Dot": "Dot", "Abasto": "Ab", "Córdoba": "Cba", "Cordoba": "Cba" };
function fmtCortoPesos(n) {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toLocaleString("es-AR", { maximumFractionDigits: 1 }) + "M";
  if (Math.abs(v) >= 1e3) return "$" + Math.round(v / 1e3) + "mil";
  return "$" + v;
}

// ── Cierre del día anterior (cron diario 00:05 ARG via cron-job.org) ──
async function cierreDiario(req, res) {
  const secret = process.env.CRON_SECRET || "tussy2026";
  if (req.query.secret !== secret) return res.status(401).json({ error: "secret inválido" });
  const sql = neon(process.env.DATABASE_URL);
  const ayer = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const { rows, total } = await totalesRango(sql, ayer, ayer);
  const [d, m] = [ayer.slice(8, 10), ayer.slice(5, 7)];
  const desglose = rows.map(r => `${CORTO_LOCAL[r.local] || r.local} ${fmtCortoPesos(r.total)}`).join(" · ");
  const enviadas = await enviarPush([{
    title: `Cierre ${d}/${m} — Total ${fmtCortoPesos(total)}`,
    body: desglose || "Sin ventas registradas",
    url: "/",
  }]);
  return res.status(200).json({ ok: true, fecha: ayer, total, porLocal: rows, notificadas: enviadas });
}

// ── Resumen de los lunes: mes en curso desglosado (cron lunes 09:00 ARG) ──
async function resumenSemanal(req, res) {
  const secret = process.env.CRON_SECRET || "tussy2026";
  if (req.query.secret !== secret) return res.status(401).json({ error: "secret inválido" });
  const sql = neon(process.env.DATABASE_URL);
  const hoy = hoyArg();
  const desde = hoy.slice(0, 8) + "01";
  const ayer = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const hasta = ayer >= desde ? ayer : hoy;
  const { rows, total } = await totalesRango(sql, desde, hasta);
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const mesNombre = MESES[parseInt(hoy.slice(5, 7)) - 1];
  const desglose = rows.map(r => `${CORTO_LOCAL[r.local] || r.local} ${fmtCortoPesos(r.total)}`).join(" · ");
  const enviadas = await enviarPush([{
    title: `Mes de ${mesNombre}: ${fmtCortoPesos(total)} facturados`,
    body: desglose || "Sin ventas registradas",
    url: "/",
  }]);
  return res.status(200).json({ ok: true, desde, hasta, total, porLocal: rows, notificadas: enviadas });
}

// ── Rentabilidad: costos por modelo (versionados) y márgenes ──

// Lista de modelos vendidos (últimos 90 días) con su costo vigente, para la pantalla de carga
async function modelosCostos(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    WITH vendidos AS (
      SELECT producto_norm, SUM(cantidad)::int AS unidades_90d
      FROM ventas
      WHERE fecha >= CURRENT_DATE - 90 AND producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
        AND producto_norm IS NOT NULL
      GROUP BY producto_norm
    )
    SELECT v.producto_norm AS producto, v.unidades_90d,
           c.costo::numeric AS costo, c.vigente_desde::text AS vigente_desde
    FROM vendidos v
    LEFT JOIN LATERAL (
      SELECT costo, vigente_desde FROM costos_producto cp
      WHERE cp.producto = v.producto_norm
      ORDER BY vigente_desde DESC LIMIT 1
    ) c ON true
    ORDER BY v.unidades_90d DESC`;
  return res.status(200).json({
    modelos: rows.map(r => ({ ...r, costo: r.costo == null ? null : Number(r.costo) })),
  });
}

// Guardar un costo con fecha de vigencia (upsert)
async function guardarCosto(req, res) {
  const { producto, costo, desde } = req.query;
  if (!producto || costo == null || isNaN(parseFloat(costo))) {
    return res.status(400).json({ error: "Faltan producto/costo" });
  }
  const vigente = desde || hoyArg();
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    INSERT INTO costos_producto (producto, costo, vigente_desde)
    VALUES (${producto.toUpperCase().trim()}, ${parseFloat(costo)}, ${vigente})
    ON CONFLICT (producto, vigente_desde) DO UPDATE SET costo = EXCLUDED.costo, creado_en = now()`;
  return res.status(200).json({ ok: true, producto, costo: parseFloat(costo), vigente_desde: vigente });
}

// Margen por modelo: cada venta se cruza contra el costo vigente en SU fecha
async function rentabilidadProductos(req, res) {
  const { desde, hasta, local } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: "Faltan desde/hasta" });
  const localFiltro = local || null;
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT v.producto_norm AS producto,
           SUM(v.cantidad)::int AS unidades,
           ROUND(SUM(v.total))::bigint AS venta,
           ROUND(SUM(CASE WHEN c.costo IS NOT NULL THEN v.cantidad * c.costo ELSE 0 END))::bigint AS costo_total,
           SUM(CASE WHEN c.costo IS NULL THEN v.cantidad ELSE 0 END)::int AS unidades_sin_costo
    FROM ventas v
    LEFT JOIN LATERAL (
      SELECT costo FROM costos_producto cp
      WHERE cp.producto = v.producto_norm AND cp.vigente_desde <= v.fecha
      ORDER BY cp.vigente_desde DESC LIMIT 1
    ) c ON true
    WHERE v.fecha BETWEEN ${desde} AND ${hasta}
      AND v.producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
      AND v.producto_norm IS NOT NULL
      AND (${localFiltro}::text IS NULL OR v.local = ${localFiltro})
    GROUP BY v.producto_norm
    ORDER BY SUM(v.total) DESC`;
  const modelos = rows.map(r => {
    const venta = Number(r.venta), costo = Number(r.costo_total);
    const completo = r.unidades_sin_costo === 0;
    return {
      producto: r.producto, unidades: r.unidades, venta,
      costo: completo ? costo : null,
      margen: completo ? venta - costo : null,
      margen_pct: completo && venta > 0 ? Math.round(((venta - costo) / venta) * 1000) / 10 : null,
      unidades_sin_costo: r.unidades_sin_costo,
    };
  });
  const conCosto = modelos.filter(m => m.margen != null);
  return res.status(200).json({
    modelos,
    totales: {
      venta: modelos.reduce((a, m) => a + m.venta, 0),
      venta_con_costo: conCosto.reduce((a, m) => a + m.venta, 0),
      margen: conCosto.reduce((a, m) => a + m.margen, 0),
      modelos_sin_costo: modelos.length - conCosto.length,
    },
  });
}

// ── Rentabilidad por unidad de negocio (mes cerrado o en curso) ──
// Cascada por local: venta − mercadería − costo financiero − fijos − fábrica prorrateada
async function rentabilidadNegocio(req, res) {
  const mes = req.query.mes || hoyArg().slice(0, 7);
  const desde = `${mes}-01`;
  const [y, m] = mes.split("-").map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const hasta = `${mes}-${String(ultimo).padStart(2, "0")}`;
  const sql = neon(process.env.DATABASE_URL);

  // Venta y costo de mercadería por local (costo vigente a la fecha de cada venta).
  // La VENTA suma todas las líneas —incluidas ENVIO/DESCUENTO/AJUSTE, que son parte
  // de lo que efectivamente pagó el cliente—; las unidades y la mercadería cuentan
  // solo productos reales.
  const ES_PRODUCTO = sql`v.producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')`;
  const ventas = await sql`
    SELECT v.local,
           ROUND(SUM(v.total))::bigint AS venta,
           SUM(CASE WHEN ${ES_PRODUCTO} THEN v.cantidad ELSE 0 END)::int AS unidades,
           ROUND(SUM(CASE WHEN ${ES_PRODUCTO} AND c.costo IS NOT NULL THEN v.cantidad * c.costo ELSE 0 END))::bigint AS mercaderia,
           SUM(CASE WHEN ${ES_PRODUCTO} AND c.costo IS NULL THEN v.cantidad ELSE 0 END)::int AS unidades_sin_costo
    FROM ventas v
    LEFT JOIN LATERAL (
      SELECT costo FROM costos_producto cp
      WHERE cp.producto = v.producto_norm AND cp.vigente_desde <= v.fecha
      ORDER BY cp.vigente_desde DESC LIMIT 1
    ) c ON true
    WHERE v.fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY v.local`;

  const [mixPagos, gastos, cfgRows, gastosMes] = await Promise.all([
    sql`SELECT local, bruto, neto, costo_pct, mix FROM mix_pagos WHERE mes = ${mes}`,
    sql`SELECT DISTINCT ON (local) local, empleados, alquiler, flete, libreria, bolsas
        FROM gastos_local WHERE vigente_desde <= ${mes} ORDER BY local, vigente_desde DESC`,
    sql`SELECT clave, valor FROM config_negocio`,
    sql`SELECT local, concepto, monto FROM gastos_mes WHERE mes = ${mes}`,
  ]);
  const cfg = Object.fromEntries(cfgRows.map(r => [r.clave, Number(r.valor)]));
  const mixPorLocal = Object.fromEntries(mixPagos.map(r => [r.local, r]));
  const gastosPorLocal = Object.fromEntries(gastos.map(r => [r.local, r]));
  // Gastos variables cargados por mes (publicidad, envíos): { local: { concepto: monto } }
  const varPorLocal = {};
  for (const g of gastosMes) {
    if (!varPorLocal[g.local]) varPorLocal[g.local] = {};
    varPorLocal[g.local][g.concepto] = Number(g.monto);
  }

  const ventaTotal = ventas.reduce((a, v) => a + Number(v.venta), 0);
  const fabricaMes = cfg.fabrica_mensual || 0;

  const unidades = ventas.map(v => {
    const local = v.local;
    const venta = Number(v.venta);
    const mercaderia = Number(v.mercaderia);
    const esWeb = local === "Tiendanube";

    // Costo financiero
    let financiero = 0, detalleFin = null;
    const mpWeb = mixPorLocal["Tiendanube"];
    if (esWeb && mpWeb) {
      // Web con reporte cargado: mix real de cuotas de PagoNube + transferencias
      financiero = Math.round(venta * Number(mpWeb.costo_pct));
      detalleFin = { tipo: "web", pct_real: Math.round(Number(mpWeb.costo_pct) * 10000) / 100, mix: mpWeb.mix };
    } else if (esWeb) {
      // Sin reporte del mes: tasa configurada como aproximación
      financiero = Math.round(venta * ((cfg.tn_costo_pct || 0) + (cfg.iva_neto_pct || 0)));
      detalleFin = { tipo: "web_estimado", pct: (cfg.tn_costo_pct || 0) + (cfg.iva_neto_pct || 0) };
    } else {
      // Locales: solo la parte cobrada por MP Point tiene costo.
      // El resto (efectivo/transferencia) ya viene neto del descuento en el precio registrado.
      const mp = mixPorLocal[local];
      if (mp) {
        const brutoPoint = Math.min(Number(mp.bruto), venta);
        financiero = Math.round(brutoPoint * Number(mp.costo_pct));
        detalleFin = {
          tipo: "point", bruto_point: Math.round(brutoPoint),
          pct_point: Math.round(Number(mp.costo_pct) * 10000) / 100,
          share_point: venta > 0 ? Math.round(brutoPoint / venta * 1000) / 10 : 0,
          mix: mp.mix,
        };
      }
    }

    // Fijos del local
    const g = gastosPorLocal[local];
    const fijos = g ? Number(g.empleados) + Number(g.alquiler) + Number(g.flete) + Number(g.libreria) + Number(g.bolsas) : 0;

    // Web suma su plan y packaging; más los gastos variables cargados del mes
    const extrasWeb = esWeb ? (cfg.plan_tiendanube || 0) + (cfg.packaging_unidad || 0) * v.unidades : 0;
    const gv = varPorLocal[local] || {};
    const publicidad = gv.publicidad || 0;
    const envios = gv.envios || 0;

    // Fábrica prorrateada por participación en la venta del mes
    const share = ventaTotal > 0 ? venta / ventaTotal : 0;
    const fabrica = Math.round(fabricaMes * share);

    const margenBruto = venta - mercaderia;
    const contribucion = margenBruto - financiero - publicidad - envios;
    const resultado = contribucion - fijos - extrasWeb - fabrica;

    return {
      local, venta, unidades: v.unidades, unidades_sin_costo: v.unidades_sin_costo,
      mercaderia, margen_bruto: margenBruto,
      financiero, detalle_financiero: detalleFin,
      publicidad, envios,
      contribucion, fijos: Math.round(fijos + extrasWeb), fabrica,
      resultado,
      margen_pct: venta > 0 ? Math.round(resultado / venta * 1000) / 10 : null,
      share_venta: Math.round(share * 1000) / 10,
    };
  }).sort((a, b) => b.venta - a.venta);

  const suma = k => unidades.reduce((a, u) => a + u[k], 0);
  return res.status(200).json({
    mes, desde, hasta,
    unidades,
    total: {
      venta: ventaTotal, mercaderia: suma("mercaderia"), margen_bruto: suma("margen_bruto"),
      financiero: suma("financiero"), publicidad: suma("publicidad"), envios: suma("envios"),
      contribucion: suma("contribucion"),
      fijos: suma("fijos"), fabrica: suma("fabrica"), resultado: suma("resultado"),
      margen_pct: ventaTotal > 0 ? Math.round(suma("resultado") / ventaTotal * 1000) / 10 : null,
    },
    faltan_datos: {
      mix_pagos: unidades.filter(u => u.local !== "Tiendanube" && !u.detalle_financiero).map(u => u.local),
      unidades_sin_costo: suma("unidades_sin_costo"),
    },
  });
}

// ── Feed: todas las operaciones de HOY (día argentino), desde la base ──
async function feed(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const lim = Math.min(parseInt(req.query.limite || 100), 300);
  const hoy = hoyArg();
  const rows = await sql`
    SELECT fecha::text, local, orden_id,
           MAX(hora) AS hora,
           ROUND(SUM(total))::bigint AS total,
           SUM(CASE WHEN producto NOT IN ('ENVIO','DESCUENTO','AJUSTE') THEN cantidad ELSE 0 END)::int AS unidades,
           JSON_AGG(JSON_BUILD_OBJECT('producto', producto, 'cantidad', cantidad, 'talle', talle, 'color', color, 'total', ROUND(total))
                    ORDER BY total DESC)
             FILTER (WHERE producto NOT IN ('ENVIO','DESCUENTO','AJUSTE')) AS items
    FROM ventas
    WHERE fecha = ${hoy} AND orden_id IS NOT NULL
    GROUP BY fecha, local, orden_id
    ORDER BY MAX(hora) DESC NULLS LAST
    LIMIT ${lim}`;
  return res.status(200).json({
    fecha: hoy,
    operaciones: rows.map(r => ({ ...r, total: Number(r.total), items: r.items || [] })),
  });
}

// ── Operaciones por local y rango (desde la base) — usado por Ventas "Este mes" ──
async function operaciones(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const { desde, hasta } = req.query;
  const local = req.query.local;
  if (!desde || !hasta || !local) return res.status(400).json({ error: "Faltan local/desde/hasta" });
  const lim = Math.min(parseInt(req.query.limite || 60), 300);

  const [tot] = await sql`
    SELECT ROUND(SUM(total))::bigint AS total, COUNT(DISTINCT orden_id)::int AS ops
    FROM ventas WHERE fecha BETWEEN ${desde} AND ${hasta} AND local = ${local}`;
  const rows = await sql`
    SELECT fecha::text, orden_id,
           MAX(hora) AS hora,
           ROUND(SUM(total))::bigint AS total,
           SUM(CASE WHEN producto NOT IN ('ENVIO','DESCUENTO','AJUSTE') THEN cantidad ELSE 0 END)::int AS unidades,
           (ARRAY_AGG(producto ORDER BY total DESC) FILTER (WHERE producto NOT IN ('ENVIO','DESCUENTO','AJUSTE')))[1:4] AS productos
    FROM ventas
    WHERE fecha BETWEEN ${desde} AND ${hasta} AND local = ${local} AND orden_id IS NOT NULL
    GROUP BY fecha, orden_id
    ORDER BY fecha DESC, MAX(hora) DESC NULLS LAST
    LIMIT ${lim}`;
  return res.status(200).json({
    ok: true, local, desde, hasta,
    total: Number(tot?.total || 0), ops: tot?.ops || 0,
    operaciones: rows.map(r => ({ ...r, total: Number(r.total), productos: r.productos || [] })),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { action, desde, hasta, local, limite } = req.query;

  try {
    if (action === "live") return await ventasLive(req, res);
    if (action === "ingesta") return await ingesta(req, res);
    if (action === "feed") return await feed(req, res);
    if (action === "operaciones") return await operaciones(req, res);
    if (action === "cierre") return await cierreDiario(req, res);
    if (action === "semanal") return await resumenSemanal(req, res);
    if (action === "modelosCostos") return await modelosCostos(req, res);
    if (action === "guardarCosto") return await guardarCosto(req, res);
    if (action === "rentabilidadProductos") return await rentabilidadProductos(req, res);
    if (action === "rentabilidadNegocio") return await rentabilidadNegocio(req, res);

    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ error: "DATABASE_URL no configurada" });
    }
    const sql = neon(process.env.DATABASE_URL);
    if (action === "serie") {
      if (!desde || !hasta) return res.status(400).json({ error: "Faltan desde/hasta" });
      const rows = await sql`
        SELECT fecha::text, local,
               ROUND(SUM(total))::bigint AS total,
               COUNT(DISTINCT orden_id)::int AS ops
        FROM ventas
        WHERE fecha BETWEEN ${desde} AND ${hasta}
        GROUP BY fecha, local
        ORDER BY fecha`;
      const porDia = {};
      for (const r of rows) {
        if (!porDia[r.fecha]) porDia[r.fecha] = { fecha: r.fecha, palermo: 0, laplata: 0, online: 0, dot: 0, abasto: 0, cordoba: 0, total: 0, ops: 0 };
        const k = KEY_LOCAL[r.local];
        if (k) porDia[r.fecha][k] = Number(r.total);
        porDia[r.fecha].total += Number(r.total);
        porDia[r.fecha].ops += r.ops;
      }
      return res.status(200).json({ dias: Object.values(porDia) });
    }

    if (action === "topProductos" || action === "categorias" || action === "variantes") {
      if (!desde || !hasta) return res.status(400).json({ error: "Faltan desde/hasta" });
      const localFiltro = local || null;
      const rows = await sql`
        SELECT producto, talle, color,
               SUM(cantidad)::int AS cantidad,
               ROUND(SUM(total))::bigint AS total
        FROM ventas
        WHERE fecha BETWEEN ${desde} AND ${hasta}
          AND producto NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE')
          AND (${localFiltro}::text IS NULL OR local = ${localFiltro})
        GROUP BY producto, talle, color`;

      if (action === "topProductos") {
        const lim = Math.min(parseInt(limite || 20), 100);
        const orden = req.query.orden === "total" ? "total" : "cantidad";
        const agg = {};
        for (const r of rows) {
          const { nombre } = normalizarProducto(r.producto);
          if (!agg[nombre]) agg[nombre] = { producto: nombre, cantidad: 0, total: 0 };
          agg[nombre].cantidad += r.cantidad;
          agg[nombre].total += Number(r.total);
        }
        const productos = Object.values(agg).sort((a, b) => b[orden] - a[orden]).slice(0, lim);
        return res.status(200).json({ productos });
      }

      if (action === "categorias") {
        const agg = {};
        for (const r of rows) {
          const { categoria } = normalizarProducto(r.producto);
          if (!agg[categoria]) agg[categoria] = { categoria, cantidad: 0, total: 0 };
          agg[categoria].cantidad += r.cantidad;
          agg[categoria].total += Number(r.total);
        }
        return res.status(200).json({ categorias: Object.values(agg).sort((a, b) => b.total - a.total) });
      }

      // variantes: talles y colores más vendidos
      const talles = {}, colores = {};
      const normTalle = t => String(t || "").toUpperCase().trim();
      const normColor = c => String(c || "").toUpperCase().trim();
      for (const r of rows) {
        const t = normTalle(r.talle), c = normColor(r.color);
        if (t) {
          if (!talles[t]) talles[t] = { valor: t, cantidad: 0, total: 0 };
          talles[t].cantidad += r.cantidad; talles[t].total += Number(r.total);
        }
        if (c) {
          if (!colores[c]) colores[c] = { valor: c, cantidad: 0, total: 0 };
          colores[c].cantidad += r.cantidad; colores[c].total += Number(r.total);
        }
      }
      return res.status(200).json({
        talles: Object.values(talles).sort((a, b) => b.cantidad - a.cantidad).slice(0, 12),
        colores: Object.values(colores).sort((a, b) => b.cantidad - a.cantidad).slice(0, 12),
      });
    }

    if (action === "sync") {
      const rows = await sql`
        SELECT fecha::text, local, estado, intentos, ultimo_error
        FROM sync_estado
        WHERE estado != 'ok'
          AND (${desde || null}::date IS NULL OR fecha >= ${desde || null})
        ORDER BY fecha DESC LIMIT 100`;
      return res.status(200).json({ pendientes: rows });
    }

    return res.status(400).json({ error: "action inválida (serie | topProductos | categorias | variantes | live | sync)" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
