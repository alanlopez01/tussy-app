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
const { requerirSesion } = require("../lib/auth");
const { costear } = require("../lib/costeo");
const { LOCALES_SIN_STOCK, MOTIVO_SIN_STOCK } = require("../lib/stock");
const { snapshotStock } = require("../scripts/db-snapshot-stock");
const { arcaConfigurada, sincronizarEmitidos, NOMBRES_TIPO } = require("../lib/arca");
const { procesarMP, procesarTN, guardarMixPagos } = require("../lib/reportes");

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

  // Candado: si otra corrida arrancó hace menos de 3 minutos, esta se retira.
  // Evita que dos ejecuciones superpuestas detecten la misma venta como "nueva"
  // y la notifiquen dos veces. El UPDATE condicional es atómico en Postgres.
  await sql`INSERT INTO config_negocio (clave, valor, descripcion)
            VALUES ('ingesta_lock', 0, 'epoch de la última corrida de ingesta (candado anti-solapamiento)')
            ON CONFLICT (clave) DO NOTHING`;
  const lock = await sql`
    UPDATE config_negocio SET valor = EXTRACT(EPOCH FROM now())
    WHERE clave = 'ingesta_lock' AND valor < EXTRACT(EPOCH FROM now()) - 180
    RETURNING clave`;
  if (!lock.length) {
    console.log("[ingesta] salteada: hay otra corrida en curso (lock activo)");
    return { ok: true, salteada: true, motivo: "otra corrida en curso" };
  }

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

  // 4) Costear modelos nuevos: los costos son por familia, así que una prenda
  //    que aparece hoy hereda el costo de la suya sin esperar carga manual.
  const nuevos = await costearModelosNuevos(sql);

  const salida = { ok: true, fecha: hoy, resumen, eventos: eventos.length, notificadas, modelos_costeados: nuevos };
  console.log("[ingesta]", JSON.stringify(salida));
  return salida;
}

// Asigna costo de familia a los modelos vendidos que todavía no tienen ninguno.
// Solo crea el costo inicial: si ya existe uno cargado a mano, no lo toca.
async function costearModelosNuevos(sql) {
  const sinCosto = await sql`
    SELECT DISTINCT v.producto_norm AS producto, MIN(v.fecha)::text AS primera_venta
    FROM ventas v
    WHERE v.producto_norm IS NOT NULL
      AND v.producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
      AND NOT EXISTS (SELECT 1 FROM costos_producto cp WHERE cp.producto = v.producto_norm)
    GROUP BY v.producto_norm`;
  if (!sinCosto.length) return [];

  const asignados = [];
  for (const m of sinCosto) {
    const c = costear(m.producto);
    if (!c) continue; // sin familia reconocible: queda para carga manual
    const costo = Math.round(c.prod + c.estampa);
    await sql`
      INSERT INTO costos_producto (producto, costo, vigente_desde, origen)
      VALUES (${m.producto}, ${costo}, ${m.primera_venta}, ${"auto:" + c.familia})
      ON CONFLICT (producto, vigente_desde) DO NOTHING`;
    asignados.push({ producto: m.producto, costo, familia: c.familia });
  }
  if (asignados.length) console.log("[costeo-auto]", JSON.stringify(asignados));
  return asignados;
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
  // Aprovechamos el cierre para dejar la foto de inventario del día. El histórico
  // de fotos es lo que después permite calcular rotación sobre stock promedio.
  waitUntil(
    snapshotStock(sql, hoyArg())
      .then(r => console.log("[stock]", JSON.stringify(r)))
      .catch(e => console.error("[stock] error:", e))
  );
  // Y traemos del web service de ARCA los comprobantes emitidos del día
  // (si el certificado todavía no está cargado, sincronizarEmitidos se retira solo)
  waitUntil(
    sincronizarEmitidos(sql, { maxComprobantes: 2000 })
      .then(r => console.log("[arca]", JSON.stringify(r)))
      .catch(e => console.error("[arca] error:", e))
  );
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
           c.costo::numeric AS costo, c.vigente_desde::text AS vigente_desde, c.origen
    FROM vendidos v
    LEFT JOIN LATERAL (
      SELECT costo, vigente_desde, origen FROM costos_producto cp
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
  // conFabrica=1 suma la fábrica prorrateada por unidad al costo de cada modelo
  const conFabrica = req.query.conFabrica === "1";
  const sql = neon(process.env.DATABASE_URL);
  const fab = conFabrica ? await fabricaPorUnidad(sql, desde.slice(0, 7)) : { porUnidad: 0 };
  const rows = await sql`
    SELECT v.producto_norm AS producto,
           SUM(v.cantidad)::int AS unidades,
           ROUND(SUM(v.total))::bigint AS venta,
           ROUND(SUM(CASE WHEN c.costo IS NOT NULL THEN v.cantidad * c.costo ELSE 0 END))::bigint AS costo_total,
           SUM(CASE WHEN c.costo IS NULL THEN v.cantidad ELSE 0 END)::int AS unidades_sin_costo,
           ROUND(MAX(c.costo))::bigint AS costo_unitario
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
    const venta = Number(r.venta);
    const costo = Number(r.costo_total) + Math.round(fab.porUnidad * r.unidades);
    const completo = r.unidades_sin_costo === 0;
    return {
      producto: r.producto, unidades: r.unidades, venta,
      costo_unitario: r.costo_unitario == null ? null : Number(r.costo_unitario) + Math.round(fab.porUnidad),
      precio_promedio: r.unidades > 0 ? Math.round(venta / r.unidades) : null,
      costo: completo ? costo : null,
      margen: completo ? venta - costo : null,
      margen_pct: completo && venta > 0 ? Math.round(((venta - costo) / venta) * 1000) / 10 : null,
      unidades_sin_costo: r.unidades_sin_costo,
    };
  });
  // Orden: por facturación (default) o por contribución total — el que más plata aporta
  if (req.query.orden === "margen") {
    modelos.sort((a, b) => (b.margen ?? -Infinity) - (a.margen ?? -Infinity));
  }

  const conCosto = modelos.filter(m => m.margen != null);
  return res.status(200).json({
    modelos,
    con_fabrica: conFabrica,
    fabrica_por_unidad: Math.round(fab.porUnidad),
    totales: {
      venta: modelos.reduce((a, m) => a + m.venta, 0),
      venta_con_costo: conCosto.reduce((a, m) => a + m.venta, 0),
      margen: conCosto.reduce((a, m) => a + m.margen, 0),
      modelos_sin_costo: modelos.length - conCosto.length,
    },
  });
}

// ── Inventario: rotación, GMROI y capital inmovilizado ──
// Rotación anualizada = unidades vendidas en el período ÷ stock actual × (365/días).
// GMROI = margen bruto generado ÷ capital invertido en ese stock. Dice cuántos pesos
// de ganancia produce cada peso puesto en mercadería: es LA métrica de retail.
async function inventario(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const dias = Math.min(parseInt(req.query.dias || 90), 365);
  const localFiltro = req.query.local || null;

  const [ultima] = await sql`SELECT MAX(fecha)::text AS fecha FROM stock`;
  if (!ultima?.fecha) return res.status(200).json({ sin_datos: true });
  const fechaStock = ultima.fecha;

  // Las ventas se limitan a los locales que tienen inventario cargado: comparar
  // ventas de seis locales contra el stock de cuatro infla la rotación y el GMROI.
  const conStockRows = await sql`SELECT DISTINCT local FROM stock WHERE fecha = ${fechaStock}`;
  const localesConStock = conStockRows.map(r => r.local);

  const rows = await sql`
    WITH s AS (
      SELECT producto_norm, SUM(cantidad) AS unidades,
             -- Valor a precio de lista: lo que entraría si se vendiera todo
             SUM(cantidad * COALESCE(precio, 0)) AS valor_venta,
             MAX(precio) AS precio_unitario
      FROM stock
      WHERE fecha = ${fechaStock}
        AND (${localFiltro}::text IS NULL OR local = ${localFiltro})
      GROUP BY producto_norm
    ),
    v AS (
      SELECT ve.producto_norm,
             SUM(ve.cantidad) AS vendidas,
             SUM(ve.total) AS venta,
             SUM(ve.cantidad * COALESCE(c.costo, 0)) AS costo
      FROM ventas ve
      LEFT JOIN LATERAL (
        SELECT costo FROM costos_producto cp
        WHERE cp.producto = ve.producto_norm AND cp.vigente_desde <= ve.fecha
        ORDER BY cp.vigente_desde DESC LIMIT 1) c ON true
      WHERE ve.fecha >= ${fechaStock}::date - ${dias}::int
        AND ve.producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
        AND ve.local = ANY(${localesConStock}::text[])
        AND (${localFiltro}::text IS NULL OR ve.local = ${localFiltro})
      GROUP BY ve.producto_norm
    ),
    -- Antigüedad del modelo: desde cuándo se vende. Un producto que entró hace una
    -- semana no puede medirse contra una ventana de 90 días.
    edad AS (
      SELECT producto_norm, MIN(fecha) AS primera_venta
      FROM ventas
      WHERE producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
      GROUP BY producto_norm
    )
    SELECT COALESCE(s.producto_norm, v.producto_norm) AS producto,
           COALESCE(s.unidades, 0)::numeric AS stock,
           ROUND(COALESCE(s.valor_venta, 0))::bigint AS valor_venta,
           ROUND(COALESCE(s.precio_unitario, 0))::bigint AS precio_unitario,
           COALESCE(v.vendidas, 0)::numeric AS vendidas,
           ROUND(COALESCE(v.venta, 0))::bigint AS venta,
           ROUND(COALESCE(v.costo, 0))::bigint AS costo_vendido,
           (${fechaStock}::date - e.primera_venta)::int AS dias_desde_lanzamiento,
           (SELECT ROUND(costo)::bigint FROM costos_producto cp
            WHERE cp.producto = COALESCE(s.producto_norm, v.producto_norm)
            ORDER BY vigente_desde DESC LIMIT 1) AS costo_unitario
    FROM s FULL OUTER JOIN v ON v.producto_norm = s.producto_norm
    LEFT JOIN edad e ON e.producto_norm = COALESCE(s.producto_norm, v.producto_norm)
    WHERE COALESCE(s.unidades, 0) > 0 OR COALESCE(v.vendidas, 0) > 0`;

  const DIAS_NUEVO = 30; // por debajo de esto, el modelo todavía no tiene historia
  const factorVentana = 365 / dias; // para los totales, que sí cubren toda la ventana
  const modelos = rows.map(r => {
    const stock = Number(r.stock), vendidas = Number(r.vendidas);
    const venta = Number(r.venta), costoVendido = Number(r.costo_vendido);
    const costoUnit = r.costo_unitario == null ? null : Number(r.costo_unitario);
    const capital = costoUnit != null ? Math.round(stock * costoUnit) : null;
    const margen = venta - costoVendido;

    // Días en que el modelo estuvo realmente a la venta dentro de la ventana:
    // si entró hace 7 días, su ritmo se mide sobre 7 días, no sobre 90.
    const edad = r.dias_desde_lanzamiento;
    const diasEfectivos = Math.max(1, Math.min(dias, edad == null ? dias : edad + 1));
    const esNuevo = edad != null && edad < DIAS_NUEVO;
    const factorAnual = 365 / diasEfectivos;
    const ritmoDiario = vendidas / diasEfectivos;

    // Si el snapshot no trajo precio (Dragonfish a veces manda 0), se estima con el
    // precio promedio al que se vendió el modelo en la ventana
    const precioUnit = Number(r.precio_unitario) > 0
      ? Number(r.precio_unitario)
      : (vendidas > 0 ? Math.round(venta / vendidas) : null);
    const valorVenta = Number(r.valor_venta) > 0
      ? Number(r.valor_venta)
      : (precioUnit != null ? Math.round(stock * precioUnit) : null);

    return {
      producto: r.producto, stock, vendidas, venta, margen,
      costo_unitario: costoUnit,
      precio_unitario: precioUnit,
      capital_inmovilizado: capital,
      valor_venta: valorVenta,
      dias_desde_lanzamiento: edad,
      dias_medidos: diasEfectivos,
      es_nuevo: esNuevo,
      rotacion: stock > 0 ? Math.round(vendidas / stock * factorAnual * 10) / 10 : null,
      dias_inventario: ritmoDiario > 0 ? Math.round(stock / ritmoDiario) : null,
      gmroi: capital > 0 ? Math.round(margen * factorAnual / capital * 100) / 100 : null,
      // Un modelo nuevo sin ventas todavía no es capital muerto: no tuvo tiempo
      sin_movimiento: vendidas === 0 && stock > 0 && !esNuevo,
    };
  });

  const conStock = modelos.filter(m => m.stock > 0);
  // Dos problemas distintos: lo que no se vendió nunca, y lo que se vende muy lento
  const sinVentas = conStock.filter(m => m.sin_movimiento);
  // Los recién lanzados quedan fuera del diagnóstico de rotación lenta
  const lentos = conStock.filter(m => !m.sin_movimiento && !m.es_nuevo && m.dias_inventario != null && m.dias_inventario > 180);
  const nuevos = conStock.filter(m => m.es_nuevo);
  const capitalTotal = conStock.reduce((a, m) => a + (m.capital_inmovilizado || 0), 0);
  const valorVentaTotal = conStock.reduce((a, m) => a + (m.valor_venta || 0), 0);
  const margenTotal = modelos.reduce((a, m) => a + m.margen, 0);

  const estados = await sql`SELECT local, estado, filas, ROUND(unidades)::int AS unidades, error FROM stock_estado WHERE fecha = ${fechaStock}`;

  return res.status(200).json({
    fecha_stock: fechaStock, dias, local: localFiltro,
    total: {
      unidades: Math.round(conStock.reduce((a, m) => a + m.stock, 0)),
      modelos: conStock.length,
      capital: capitalTotal,
      // Lo que entraría si se vendiera todo el stock a precio de lista
      valor_venta: valorVentaTotal,
      margen_potencial: valorVentaTotal - capitalTotal,
      gmroi: capitalTotal > 0 ? Math.round(margenTotal * factorVentana / capitalTotal * 100) / 100 : null,
      rotacion: capitalTotal > 0
        ? Math.round(modelos.reduce((a, m) => a + m.vendidas, 0) / conStock.reduce((a, m) => a + m.stock, 0) * factorVentana * 10) / 10
        : null,
      capital_sin_ventas: sinVentas.reduce((a, m) => a + (m.capital_inmovilizado || 0), 0),
      modelos_sin_ventas: sinVentas.length,
      capital_lento: lentos.reduce((a, m) => a + (m.capital_inmovilizado || 0), 0),
      modelos_lentos: lentos.length,
      capital_nuevo: nuevos.reduce((a, m) => a + (m.capital_inmovilizado || 0), 0),
      modelos_nuevos: nuevos.length,
      // El mismo corte, pero valuado a lo que se dejaría de facturar
      venta_sin_ventas: sinVentas.reduce((a, m) => a + (m.valor_venta || 0), 0),
      venta_lento: lentos.reduce((a, m) => a + (m.valor_venta || 0), 0),
    },
    locales_con_stock: localesConStock,
    modelos: modelos.sort((a, b) => (b.capital_inmovilizado || 0) - (a.capital_inmovilizado || 0)),
    fuentes: estados,
    locales_sin_stock: LOCALES_SIN_STOCK,
    motivo_sin_stock: MOTIVO_SIN_STOCK,
  });
}

// ── Oportunidades de traslado entre locales ──
// Busca modelos parados en un local que en otro se venden bien. La idea no es
// mirar el stock global sino dónde está puesto: la misma prenda puede ser capital
// muerto en Abasto y estar faltando en Dot.
async function traslados(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const dias = Math.min(parseInt(req.query.dias || 60), 180);
  const [ultima] = await sql`SELECT MAX(fecha)::text AS fecha FROM stock`;
  if (!ultima?.fecha) return res.status(200).json({ sin_datos: true });
  const fechaStock = ultima.fecha;

  const [stockRows, ventasRows, edadRows] = await Promise.all([
    sql`SELECT local, producto_norm AS producto, SUM(cantidad)::numeric AS stock
        FROM stock WHERE fecha = ${fechaStock} GROUP BY local, producto_norm`,
    sql`SELECT local, producto_norm AS producto, SUM(cantidad)::numeric AS vendidas
        FROM ventas
        WHERE fecha >= ${fechaStock}::date - ${dias}::int
          AND producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
        GROUP BY local, producto_norm`,
    // Antigüedad de cada modelo: no se sugiere mover lo que recién entró
    sql`SELECT producto_norm AS producto, (${fechaStock}::date - MIN(fecha))::int AS edad
        FROM ventas WHERE producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')
        GROUP BY producto_norm`,
  ]);
  const edadDe = Object.fromEntries(edadRows.map(r => [r.producto, r.edad]));
  const DIAS_NUEVO = 30;
  const costos = await sql`
    SELECT DISTINCT ON (producto) producto, costo::numeric AS costo
    FROM costos_producto ORDER BY producto, vigente_desde DESC`;
  const costoDe = Object.fromEntries(costos.map(c => [c.producto, Number(c.costo)]));

  // producto → local → { stock, vendidas }
  const mapa = {};
  for (const r of stockRows) {
    (mapa[r.producto] = mapa[r.producto] || {})[r.local] = { stock: Number(r.stock), vendidas: 0 };
  }
  for (const r of ventasRows) {
    const p = (mapa[r.producto] = mapa[r.producto] || {});
    p[r.local] = { stock: p[r.local]?.stock || 0, vendidas: Number(r.vendidas) };
  }

  const localesConStock = [...new Set(stockRows.map(r => r.local))];
  const sugerencias = [];

  for (const [producto, porLocal] of Object.entries(mapa)) {
    const edad = edadDe[producto];
    // Un modelo recién lanzado todavía no tuvo tiempo de venderse: no se mueve
    if (edad != null && edad < DIAS_NUEVO) continue;
    // El ritmo se mide sobre los días que el modelo estuvo realmente a la venta
    const diasEfectivos = Math.max(1, Math.min(dias, edad == null ? dias : edad + 1));

    // Origen: tiene stock y casi no lo vende
    const origenes = localesConStock
      .map(l => ({ local: l, ...(porLocal[l] || { stock: 0, vendidas: 0 }) }))
      .filter(x => x.stock >= 3)
      .map(x => ({ ...x, ritmo: x.vendidas / diasEfectivos, diasInv: x.vendidas > 0 ? x.stock / (x.vendidas / diasEfectivos) : Infinity }))
      .filter(x => x.diasInv > 120)
      .sort((a, b) => b.diasInv - a.diasInv);
    if (!origenes.length) continue;

    // Destino: un local FÍSICO que lo vende bien. Online queda afuera: despacha
    // desde depósito, no es un punto de venta que reciba mercadería.
    // Palermo y La Plata sí cuentan como destino aunque no veamos su stock:
    // sabemos que venden el modelo, que es lo que importa para decidir el envío.
    const destinos = Object.entries(porLocal)
      .filter(([l]) => l !== "Tiendanube")
      .map(([l, x]) => ({
        local: l,
        stock: localesConStock.includes(l) ? x.stock : null,
        vendidas: x.vendidas,
        ritmo: x.vendidas / diasEfectivos,
        diasInv: localesConStock.includes(l)
          ? (x.vendidas > 0 ? x.stock / (x.vendidas / diasEfectivos) : Infinity)
          : null,
      }))
      .filter(x => x.vendidas >= 3 && (x.diasInv == null || x.diasInv < 45))
      .sort((a, b) => b.ritmo - a.ritmo);
    if (!destinos.length) continue;

    const origen = origenes[0], destino = destinos[0];
    if (origen.local === destino.local) continue;

    // Cuántas unidades mover: lo que el destino vendería en 60 días, sin dejar al
    // origen sin nada (le queda para 60 días de su propio ritmo) y sin pasarse.
    const necesitaDestino = Math.ceil(destino.ritmo * 60 - (destino.stock ?? 0));
    const puedeCeder = Math.floor(origen.stock - origen.ritmo * 60);
    const mover = Math.max(0, Math.min(necesitaDestino, puedeCeder, origen.stock));
    if (mover < 3) continue;

    const costo = costoDe[producto] || 0;
    sugerencias.push({
      producto, dias_desde_lanzamiento: edad,
      desde: origen.local, stock_origen: origen.stock, vendidas_origen: origen.vendidas,
      dias_inventario_origen: origen.diasInv === Infinity ? null : Math.round(origen.diasInv),
      hacia: destino.local, stock_destino: destino.stock, vendidas_destino: destino.vendidas,
      dias_inventario_destino: destino.diasInv === Infinity ? null : (destino.diasInv == null ? null : Math.round(destino.diasInv)),
      mover,
      capital_liberado: Math.round(mover * costo),
    });
  }

  sugerencias.sort((a, b) => b.capital_liberado - a.capital_liberado);
  return res.status(200).json({
    fecha_stock: fechaStock, dias,
    locales_con_stock: localesConStock,
    sugerencias,
    total: {
      movimientos: sugerencias.length,
      unidades: sugerencias.reduce((a, s) => a + s.mover, 0),
      capital: sugerencias.reduce((a, s) => a + s.capital_liberado, 0),
    },
  });
}

// ── Evolución mensual: la misma cascada, mes a mes ──
async function evolucion(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const n = Math.min(parseInt(req.query.meses || 6), 12);
  const hoy = hoyArg();
  const [y, m] = hoy.slice(0, 7).split("-").map(Number);
  const meses = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    meses.push(d.toISOString().slice(0, 7));
  }
  const resultados = await Promise.all(meses.map(mes => calcularNegocio(sql, mes)));
  return res.status(200).json({
    meses: resultados
      .filter(r => r.total.venta > 0)
      .map(r => ({
        mes: r.mes,
        venta: r.total.venta,
        mercaderia: r.total.mercaderia,
        margen_bruto: r.total.margen_bruto,
        margen_bruto_pct: r.total.venta > 0 ? Math.round(r.total.margen_bruto / r.total.venta * 1000) / 10 : null,
        financiero: r.total.financiero,
        fijos: r.total.fijos,
        impuestos: r.total.impuestos,
        resultado: r.total.resultado,
        margen_pct: r.total.margen_pct,
        datos: r.datos,
        completo: r.datos.fijos,
        estimado: r.datos.fijos_estimados || !r.datos.mix_pagos,
        // Resultado de cada unidad, para ver quién mejora y quién empeora
        por_unidad: Object.fromEntries(r.unidades.map(u => [u.local, { venta: u.venta, resultado: u.resultado, margen_pct: u.margen_pct }])),
      })),
  });
}

// ── Carga de reportes mensuales desde la app ──
// El navegador lee el .xlsx con SheetJS, extrae solo las columnas necesarias y
// las manda acá. El procesamiento (mismo que los scripts) corre del lado server.
async function cargarReporte(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { tipo, periodo, filas, publicidad } = req.body || {};
  if (!tipo || !Array.isArray(filas) || !filas.length) {
    return res.status(400).json({ error: "Faltan tipo/filas" });
  }
  const sql = neon(process.env.DATABASE_URL);

  if (tipo === "mp") {
    const r = procesarMP(periodo, filas);
    if (!r.filas.length) return res.status(400).json({ error: "No encontré operaciones aprobadas de locales conocidos" });
    await guardarMixPagos(sql, r.filas);
    return res.status(200).json({ ok: true, tipo, mes: r.mes, cargado: r.filas, aprobadas: r.aprobadas, locales_desconocidos: r.locales_desconocidos });
  }

  if (tipo === "tn") {
    const r = procesarTN(filas, publicidad);
    if (!r.meses.length) return res.status(400).json({ error: "No encontré órdenes válidas en el reporte" });
    await guardarMixPagos(sql, r.meses);
    return res.status(200).json({ ok: true, tipo, cargado: r.meses, canceladas: r.canceladas });
  }

  return res.status(400).json({ error: "tipo inválido (mp | tn)" });
}

// ── Gastos fijos: listar y editar desde la app (esquema clave-valor, versionado) ──

// Devuelve, para cada local, los conceptos vigentes al mes pedido
async function leerGastosFijos(sql, mes) {
  const rows = await sql`
    SELECT DISTINCT ON (local, concepto) local, concepto, monto, vigente_desde,
           COALESCE(estimado, false) AS estimado
    FROM gastos_fijos WHERE vigente_desde <= ${mes}
    ORDER BY local, concepto, vigente_desde DESC`;
  const porLocal = {};
  for (const r of rows) {
    if (!porLocal[r.local]) porLocal[r.local] = { conceptos: {}, vigente_desde: r.vigente_desde, total: 0, estimado: false };
    porLocal[r.local].conceptos[r.concepto] = Number(r.monto);
    porLocal[r.local].total += Number(r.monto);
    if (r.estimado) porLocal[r.local].estimado = true;
    if (r.vigente_desde > porLocal[r.local].vigente_desde) porLocal[r.local].vigente_desde = r.vigente_desde;
  }
  return porLocal;
}

async function gastosLocales(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const mes = req.query.mes || hoyArg().slice(0, 7);
  const porLocal = await leerGastosFijos(sql, mes);
  return res.status(200).json({
    mes,
    locales: Object.entries(porLocal).map(([local, d]) => ({ local, ...d }))
      .sort((a, b) => a.local.localeCompare(b.local)),
  });
}

// Guarda todos los conceptos de un local con vigencia en el mes elegido.
// conceptos llega como JSON: {"alquiler":6285405,"sueldos":4895309,...}
async function guardarGastoLocal(req, res) {
  const { local, mes, conceptos } = req.query;
  if (!local || !mes || !conceptos) return res.status(400).json({ error: "Faltan local/mes/conceptos" });
  let parsed;
  try { parsed = JSON.parse(conceptos); } catch { return res.status(400).json({ error: "conceptos inválido" }); }
  const sql = neon(process.env.DATABASE_URL);
  for (const [concepto, monto] of Object.entries(parsed)) {
    const v = parseFloat(monto);
    if (isNaN(v)) continue;
    await sql`
      INSERT INTO gastos_fijos (local, vigente_desde, concepto, monto)
      VALUES (${local}, ${mes}, ${concepto}, ${v})
      ON CONFLICT (local, vigente_desde, concepto)
      DO UPDATE SET monto = EXCLUDED.monto, actualizado_en = now()`;
  }
  return res.status(200).json({ ok: true, local, mes, conceptos: Object.keys(parsed).length });
}

// ── Costo de fábrica por prenda ESTAMPADA de un mes ──
// La fábrica de estampado es un costo de producción, no de estructura del local:
// se reparte por unidad producida y solo entre las prendas que pasan por ella
// (los accesorios de reventa —pins, gorras, llaveros— no llevan estampa).
async function fabricaPorUnidad(sql, mes) {
  const desde = `${mes}-01`;
  const [y, m] = mes.split("-").map(Number);
  const hasta = `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const [[u], fijos] = await Promise.all([
    sql`SELECT SUM(CASE WHEN cp.estampa > 0 THEN v.cantidad ELSE 0 END)::int AS unidades
        FROM ventas v
        LEFT JOIN LATERAL (
          SELECT estampa FROM costos_producto c
          WHERE c.producto = v.producto_norm AND c.vigente_desde <= v.fecha
          ORDER BY c.vigente_desde DESC LIMIT 1) cp ON true
        WHERE v.fecha BETWEEN ${desde} AND ${hasta}
          AND v.producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')`,
    leerGastosFijos(sql, mes),
  ]);
  const fabricaMes = fijos["__fabrica__"]?.total || 0;
  const unidades = u?.unidades || 0;
  return { fabricaMes, unidades, porUnidad: unidades > 0 ? fabricaMes / unidades : 0 };
}

// ── Rentabilidad de UN producto según cómo lo paguen ──
// Para cada medio de pago: cuánto entra, cuánto queda después de mercadería,
// fábrica y costo financiero. Responde "¿este producto deja plata?"
async function rentabilidadProducto(req, res) {
  const producto = req.query.producto;
  if (!producto) return res.status(400).json({ error: "Falta producto" });
  const mes = req.query.mes || hoyArg().slice(0, 7);
  const desde = `${mes}-01`;
  const [y, m] = mes.split("-").map(Number);
  const hasta = `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const sql = neon(process.env.DATABASE_URL);

  const localFiltro = req.query.local || null;
  const [datos, cfgRows, fab, fijos] = await Promise.all([
    // El precio de lista es el precio al que más unidades se vendieron (moda), no el
    // promedio: el promedio lo arrastran hacia abajo las ventas con descuento y los canjes.
    sql`WITH v AS (
          SELECT * FROM ventas
          WHERE fecha BETWEEN ${desde} AND ${hasta} AND producto_norm = ${producto}
            AND (${localFiltro}::text IS NULL OR local = ${localFiltro})
        ),
        moda AS (
          SELECT precio_unit FROM v WHERE precio_unit > 0
          GROUP BY precio_unit ORDER BY SUM(cantidad) DESC, precio_unit DESC LIMIT 1
        )
        SELECT SUM(v.cantidad)::int AS unidades,
               (SELECT ROUND(precio_unit)::bigint FROM moda) AS precio_lista,
               ROUND(SUM(v.precio_unit * v.cantidad) / NULLIF(SUM(v.cantidad),0))::bigint AS precio_promedio,
               ROUND(SUM(v.total) / NULLIF(SUM(v.cantidad),0))::bigint AS precio_cobrado,
               ROUND(MAX(c.costo))::bigint AS costo,
               MAX(c.estampa)::numeric AS estampa
        FROM v
        LEFT JOIN LATERAL (
          SELECT costo, estampa FROM costos_producto cp
          WHERE cp.producto = v.producto_norm AND cp.vigente_desde <= v.fecha
          ORDER BY cp.vigente_desde DESC LIMIT 1) c ON true`,
    sql`SELECT clave, valor FROM config_negocio`,
    fabricaPorUnidad(sql, mes),
    leerGastosFijos(sql, mes),
  ]);

  const d = datos[0];
  if (!d || !d.unidades) return res.status(200).json({ producto, mes, sin_datos: true });
  const cfg = Object.fromEntries(cfgRows.map(r => [r.clave, Number(r.valor)]));

  const precioLista = Number(d.precio_lista || d.precio_promedio);
  const precioPromedio = Number(d.precio_promedio);
  const costoMerc = d.costo == null ? null : Number(d.costo);
  // La fábrica solo pesa sobre las prendas que pasan por ella
  const llevaEstampa = Number(d.estampa || 0) > 0;
  const costoFabrica = llevaEstampa ? Math.round(fab.porUnidad) : 0;
  const costoDirecto = costoMerc == null ? null : costoMerc + costoFabrica;

  // Estructura del punto de venta. OJO: se usa solo como REFERENCIA, no se resta del
  // producto. Los fijos no cambian si vendés una prenda más o una menos; restarlos por
  // producto genera el "death spiral": el producto parece perder plata, lo sacás, los
  // fijos se reparten entre menos unidades y el siguiente producto parece perder, etc.
  // La decisión correcta se toma sobre la CONTRIBUCIÓN (lo que deja para pagar fijos).
  const esOnline = localFiltro === "Tiendanube";
  const [ventasPorLocal, gastosMesRows] = await Promise.all([
    sql`SELECT local, ROUND(SUM(total))::bigint AS venta, SUM(cantidad)::int AS unidades
        FROM ventas WHERE fecha BETWEEN ${desde} AND ${hasta} GROUP BY local`,
    sql`SELECT local, concepto, monto FROM gastos_mes WHERE mes = ${mes}`,
  ]);
  const ventaDe = l => Number(ventasPorLocal.find(v => v.local === l)?.venta || 0);
  const ventaLocales = ventasPorLocal.filter(v => v.local !== "Tiendanube")
    .reduce((a, v) => a + Number(v.venta), 0);
  const compartidos = fijos["__compartidos__"]?.total || 0;

  let estructuraPct = 0, estructuraDetalle = "", estructuraUnidad = 0, unidadesPV = 0;
  if (esOnline) {
    // Online: publicidad, envíos, plan y packaging sobre su propia venta
    const gv = {};
    for (const g of gastosMesRows) if (g.local === "Tiendanube") gv[g.concepto] = Number(g.monto);
    const uOnline = ventasPorLocal.find(v => v.local === "Tiendanube")?.unidades || 0;
    const costoOnline = (gv.publicidad || 0) + (gv.envios || 0)
      + (cfg.plan_tiendanube || 0) + (cfg.packaging_unidad || 0) * uOnline;
    const vOnline = ventaDe("Tiendanube");
    estructuraPct = vOnline > 0 ? costoOnline / vOnline : 0;
    unidadesPV = uOnline;
    estructuraUnidad = uOnline > 0 ? Math.round(costoOnline / uOnline) : 0;
    estructuraDetalle = "publicidad, envíos, plan y packaging";
  } else if (localFiltro) {
    // Un local puntual: sus fijos propios + su parte de los compartidos
    const propios = fijos[localFiltro]?.total || 0;
    const vLocal = ventaDe(localFiltro);
    const suCompartido = ventaLocales > 0 ? compartidos * (vLocal / ventaLocales) : 0;
    estructuraPct = vLocal > 0 ? (propios + suCompartido) / vLocal : 0;
    unidadesPV = ventasPorLocal.find(v => v.local === localFiltro)?.unidades || 0;
    estructuraUnidad = unidadesPV > 0 ? Math.round((propios + suCompartido) / unidadesPV) : 0;
    estructuraDetalle = "alquiler, sueldos y compartidos del local";
  } else {
    // Todos los locales físicos juntos
    const fijosLocales = Object.entries(fijos)
      .filter(([k]) => !k.startsWith("__"))
      .reduce((a, [, v]) => a + v.total, 0) + compartidos;
    estructuraPct = ventaLocales > 0 ? fijosLocales / ventaLocales : 0;
    unidadesPV = ventasPorLocal.filter(v => v.local !== "Tiendanube").reduce((a, v) => a + v.unidades, 0);
    estructuraUnidad = unidadesPV > 0 ? Math.round(fijosLocales / unidadesPV) : 0;
    estructuraDetalle = "promedio de los locales físicos";
  }

  const impuestoPct = cfg.impuesto_producto_pct ?? 0.105;

  // Online no cobra en efectivo: su descuento equivalente es el 10% por transferencia
  const escenariosBase = esOnline
    ? [
        { key: "transferencia", label: "Transferencia (10% desc.)", tasa: null, desc: 0.10 },
        { key: "credito1", label: "PagoNube 1 pago",  tasa: cfg.tn_costo_pct ?? 0.064009 },
        { key: "credito3", label: "PagoNube 3 cuotas", tasa: 0.132132 },
        { key: "credito6", label: "PagoNube 6 cuotas", tasa: 0.19481 },
      ]
    : [
        { key: "efectivo", label: "Efectivo (15% desc.)", tasa: null, desc: cfg.efectivo_desc ?? 0.15 },
        { key: "debito",   label: "Débito",               tasa: cfg.tasa_debito },
        { key: "credito1", label: "Crédito 1 cuota",      tasa: cfg.tasa_credito_1 },
        { key: "credito2", label: "Crédito 2 cuotas",     tasa: cfg.tasa_credito_2 },
        { key: "credito3", label: "Crédito 3 cuotas",     tasa: cfg.tasa_credito_3 },
        { key: "credito6", label: "Crédito 6 cuotas",     tasa: cfg.tasa_credito_6 },
      ];

  const escenarios = escenariosBase.map(e => ({
    ...e,
    ingreso: precioLista * (1 - (e.desc ?? e.tasa ?? 0)),
  })).map(e => {
    const ingreso = Math.round(e.ingreso);
    const impuestos = Math.round(ingreso * impuestoPct);
    // CONTRIBUCIÓN = lo que esta venta deja para pagar la estructura y generar ganancia.
    // Es la métrica de decisión: mientras sea positiva, vender conviene.
    const contribucion = costoDirecto == null ? null : ingreso - costoDirecto - impuestos;
    // Referencia (no se resta como si fuera un costo del producto): lo que en promedio
    // aporta cada prenda vendida en este punto de venta para cubrir sus fijos.
    const excedente = contribucion == null ? null : contribucion - estructuraUnidad;
    return {
      ...e, ingreso,
      costo_financiero: Math.round(precioLista - ingreso),
      impuestos, contribucion,
      margen_contribucion: contribucion != null && ingreso > 0 ? Math.round(contribucion / ingreso * 1000) / 10 : null,
      excedente,
    };
  });

  return res.status(200).json({
    producto, mes, unidades: d.unidades,
    precio_lista: precioLista,
    precio_promedio: precioPromedio,
    // Cuánto se está resignando por promos y descuentos frente al precio de lista
    descuento_efectivo_pct: precioLista > 0
      ? Math.round((1 - precioPromedio / precioLista) * 1000) / 10 : 0,
    precio_cobrado_promedio: Number(d.precio_cobrado),
    costo_mercaderia: costoMerc,
    costo_fabrica: costoFabrica,
    lleva_estampa: llevaEstampa,
    costo_directo: costoDirecto,
    local: localFiltro,
    estructura_pct: Math.round(estructuraPct * 1000) / 10,
    // Referencia: lo que necesita aportar en promedio cada prenda de este punto de venta
    estructura_unidad: estructuraUnidad,
    unidades_punto_venta: unidadesPV,
    estructura_detalle: estructuraDetalle,
    impuesto_pct: Math.round(impuestoPct * 1000) / 10,
    impuesto_monto: Math.round(precioLista * impuestoPct),
    escenarios,
  });
}

// ── Rentabilidad por unidad de negocio (mes cerrado o en curso) ──
// Cascada por local: venta − mercadería (incluye fábrica) − financiero − fijos − impuestos.
// La fábrica de estampado es costo de producción: viaja dentro de la mercadería, por
// unidad estampada, no como un gasto de estructura del local.
async function rentabilidadNegocio(req, res) {
  const mes = req.query.mes || hoyArg().slice(0, 7);
  return res.status(200).json(await calcularNegocio(neon(process.env.DATABASE_URL), mes));
}

// Cascada completa de un mes. La usan el endpoint mensual y la vista de evolución.
async function calcularNegocio(sql, mes) {
  const desde = `${mes}-01`;
  const [y, m] = mes.split("-").map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const hasta = `${mes}-${String(ultimo).padStart(2, "0")}`;

  // Venta y costo de mercadería por local (costo vigente a la fecha de cada venta).
  // La VENTA suma todas las líneas —incluidas ENVIO/DESCUENTO/AJUSTE, que son parte
  // de lo que efectivamente pagó el cliente—; las unidades y la mercadería cuentan
  // solo productos reales.
  const ES_PRODUCTO = sql`v.producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE','CAFE GRATI')`;
  const ventas = await sql`
    SELECT v.local,
           ROUND(SUM(v.total))::bigint AS venta,
           SUM(CASE WHEN ${ES_PRODUCTO} THEN v.cantidad ELSE 0 END)::int AS unidades,
           SUM(CASE WHEN ${ES_PRODUCTO} AND c.estampa > 0 THEN v.cantidad ELSE 0 END)::int AS unidades_estampadas,
           ROUND(SUM(CASE WHEN ${ES_PRODUCTO} AND c.costo IS NOT NULL THEN v.cantidad * c.costo ELSE 0 END))::bigint AS mercaderia,
           SUM(CASE WHEN ${ES_PRODUCTO} AND c.costo IS NULL THEN v.cantidad ELSE 0 END)::int AS unidades_sin_costo
    FROM ventas v
    LEFT JOIN LATERAL (
      SELECT costo, estampa FROM costos_producto cp
      WHERE cp.producto = v.producto_norm AND cp.vigente_desde <= v.fecha
      ORDER BY cp.vigente_desde DESC LIMIT 1
    ) c ON true
    WHERE v.fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY v.local`;
  // Fábrica por prenda estampada del mes: entra en la mercadería de cada unidad
  const totalEstampadas = ventas.reduce((a, v) => a + (v.unidades_estampadas || 0), 0);

  const [mixPagos, fijos, cfgRows, gastosMes, impuestosRows] = await Promise.all([
    sql`SELECT local, bruto, neto, costo_pct, mix FROM mix_pagos WHERE mes = ${mes}`,
    leerGastosFijos(sql, mes),
    sql`SELECT clave, valor FROM config_negocio`,
    sql`SELECT local, concepto, monto FROM gastos_mes WHERE mes = ${mes}`,
    sql`SELECT concepto, monto FROM impuestos_mes WHERE mes = ${mes}`,
  ]);
  const impuestosReales = Object.fromEntries(impuestosRows.map(r => [r.concepto, Number(r.monto)]));
  const cfg = Object.fromEntries(cfgRows.map(r => [r.clave, Number(r.valor)]));
  const mixPorLocal = Object.fromEntries(mixPagos.map(r => [r.local, r]));
  // Fijos propios de cada local + bolsas de gastos compartidos y fábrica
  const fijosPropios = local => (fijos[local]?.total || 0);
  const compartidosTotal = fijos["__compartidos__"]?.total || 0;
  const fabricaMesReal = fijos["__fabrica__"]?.total || cfg.fabrica_mensual || 0;
  // Gastos variables cargados por mes (publicidad, envíos): { local: { concepto: monto } }
  const varPorLocal = {};
  for (const g of gastosMes) {
    if (!varPorLocal[g.local]) varPorLocal[g.local] = {};
    varPorLocal[g.local][g.concepto] = Number(g.monto);
  }

  const ventaTotal = ventas.reduce((a, v) => a + Number(v.venta), 0);
  // Los compartidos (supervisor, limpieza) se reparten solo entre los locales físicos
  const ventaLocales = ventas.filter(v => v.local !== "Tiendanube").reduce((a, v) => a + Number(v.venta), 0);

  // ── Impuestos ──
  // IIBB: alícuota efectiva sobre la venta de cada unidad (directamente atribuible).
  // IVA: monto neto declarado del mes (o % de fallback), prorrateado por venta.
  // Cargas sociales: monto real del F931 (o % sobre sueldos), repartido según el
  // peso de los sueldos de cada local en la nómina total.
  const iibbPct = cfg.iibb_pct || 0;
  const ivaMes = impuestosReales.iva != null ? impuestosReales.iva : ventaTotal * (cfg.iva_pct || 0);

  // Base de cargas: sueldos que efectivamente tributan. Se descuentan los montos
  // marcados como sin cargas; franqueros y fábrica no tributan (la fábrica no tiene F931).
  const baseCargasDe = local => {
    const c = fijos[local]?.conceptos || {};
    return Math.max(0, (c.sueldos || 0) - (c.sueldos_sin_cargas || 0));
  };
  const cCompartidos = fijos["__compartidos__"]?.conceptos || {};
  const baseCompartidos = Math.max(0, (cCompartidos.supervisor || 0) - (cCompartidos.supervisor_sin_cargas || 0));
  const baseLocales = ventas.filter(v => v.local !== "Tiendanube").reduce((a, v) => a + baseCargasDe(v.local), 0);
  const baseCargasTotal = baseLocales + baseCompartidos;
  const cargasMes = impuestosReales.cargas_sociales != null
    ? impuestosReales.cargas_sociales
    : baseCargasTotal * (cfg.cargas_pct || 0);

  const fabricaPorPrenda = totalEstampadas > 0 ? fabricaMesReal / totalEstampadas : 0;

  const unidades = ventas.map(v => {
    const local = v.local;
    const venta = Number(v.venta);
    // La fábrica va dentro de la mercadería, repartida por prenda estampada
    const fabricaEnMercaderia = Math.round(fabricaPorPrenda * (v.unidades_estampadas || 0));
    const mercaderia = Number(v.mercaderia) + fabricaEnMercaderia;
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

    // Fijos propios + parte de los compartidos de la red de locales
    const propios = fijosPropios(local);
    const compartidos = esWeb || ventaLocales === 0 ? 0 : Math.round(compartidosTotal * (venta / ventaLocales));
    const fijosLocal = propios + compartidos;

    // Web suma su plan y packaging; más los gastos variables cargados del mes
    const extrasWeb = esWeb ? (cfg.plan_tiendanube || 0) + (cfg.packaging_unidad || 0) * v.unidades : 0;
    const gv = varPorLocal[local] || {};
    const publicidad = gv.publicidad || 0;
    const envios = gv.envios || 0;

    const share = ventaTotal > 0 ? venta / ventaTotal : 0;

    // Impuestos de esta unidad
    const iibb = Math.round(venta * iibbPct);
    const iva = Math.round(ivaMes * share);
    // Cada local carga lo suyo más su parte del supervisor (repartido por venta)
    const cargas = esWeb || baseCargasTotal === 0 ? 0 : Math.round(
      cargasMes * (
        (baseCargasDe(local) + (ventaLocales > 0 ? baseCompartidos * (venta / ventaLocales) : 0)) / baseCargasTotal
      ));
    const impuestos = iibb + iva + cargas;

    const margenBruto = venta - mercaderia;
    const contribucion = margenBruto - financiero - publicidad - envios;
    const resultado = contribucion - fijosLocal - extrasWeb - impuestos;

    return {
      local, venta, unidades: v.unidades, unidades_sin_costo: v.unidades_sin_costo,
      mercaderia, fabrica_en_mercaderia: fabricaEnMercaderia,
      unidades_estampadas: v.unidades_estampadas,
      margen_bruto: margenBruto,
      financiero, detalle_financiero: detalleFin,
      publicidad, envios,
      // Punto de equilibrio: cuánto necesita vender para cubrir sus fijos.
      // Los fijos NO se restan de la contribución; se comparan contra ella.
      equilibrio: (() => {
        const fijosTotales = Math.round(fijosLocal + extrasWeb);
        if (contribucion <= 0 || fijosTotales <= 0) return null;
        const cobertura = contribucion / fijosTotales;            // veces que los cubre
        const contribUnidad = v.unidades > 0 ? contribucion / v.unidades : 0;
        return {
          unidades: contribUnidad > 0 ? Math.ceil(fijosTotales / contribUnidad) : null,
          venta: Math.round(venta / cobertura),                    // facturación de equilibrio
          cobertura: Math.round(cobertura * 100) / 100,
          margen_seguridad: Math.round((1 - 1 / cobertura) * 1000) / 10, // % que puede caer
        };
      })(),
      contribucion, fijos: Math.round(fijosLocal + extrasWeb),
      detalle_fijos: { propios, compartidos, extras_web: extrasWeb, conceptos: fijos[local]?.conceptos || {} },
      impuestos, detalle_impuestos: { iibb, iva, cargas_sociales: cargas },
      resultado,
      margen_pct: venta > 0 ? Math.round(resultado / venta * 1000) / 10 : null,
      share_venta: Math.round(share * 1000) / 10,
    };
  }).sort((a, b) => b.venta - a.venta);

  const suma = k => unidades.reduce((a, u) => a + u[k], 0);
  return {
    mes, desde, hasta,
    unidades,
    total: {
      venta: ventaTotal, mercaderia: suma("mercaderia"), margen_bruto: suma("margen_bruto"),
      financiero: suma("financiero"), publicidad: suma("publicidad"), envios: suma("envios"),
      contribucion: suma("contribucion"),
      fijos: suma("fijos"), fabrica_en_mercaderia: suma("fabrica_en_mercaderia"),
      impuestos: suma("impuestos"),
      detalle_impuestos: {
        iibb: unidades.reduce((a, u) => a + u.detalle_impuestos.iibb, 0),
        iva: unidades.reduce((a, u) => a + u.detalle_impuestos.iva, 0),
        cargas_sociales: unidades.reduce((a, u) => a + u.detalle_impuestos.cargas_sociales, 0),
      },
      resultado: suma("resultado"),
      margen_pct: ventaTotal > 0 ? Math.round(suma("resultado") / ventaTotal * 1000) / 10 : null,
    },
    faltan_datos: {
      mix_pagos: unidades.filter(u => u.local !== "Tiendanube" && !u.detalle_financiero).map(u => u.local),
      unidades_sin_costo: suma("unidades_sin_costo"),
    },
    // Qué información real tiene este mes. Un mes sin fijos cargados muestra un
    // margen irreal (no se le restó la estructura) y no es comparable con los demás.
    datos: {
      fijos: Object.keys(fijos).some(k => !k.startsWith("__")),
      fijos_estimados: Object.values(fijos).some(v => v.estimado),
      mix_pagos: mixPagos.length > 0,
      impuestos_reales: Object.keys(impuestosReales).length > 0,
    },
  };
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

// ── Contabilidad: comprobantes ARCA, posición de IVA, gastos y conciliación ──

// Las notas de crédito restan (tipos 3, 8 y 13 = NC A/B/C)
const SIGNO_CBTE = "CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END";

// Alta masiva desde el export de Mis Comprobantes (emitidos o recibidos).
// El parseo del xlsx/csv se hace en el navegador; acá llegan filas ya normalizadas.
async function cargarComprobantes(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { clase, filas } = req.body || {};
  if (!["emitidos", "recibidos"].includes(clase) || !Array.isArray(filas) || !filas.length) {
    return res.status(400).json({ error: "clase (emitidos|recibidos) y filas requeridas" });
  }
  if (filas.length > 20000) return res.status(400).json({ error: "demasiadas filas en una carga" });
  const sql = neon(process.env.DATABASE_URL);
  const validas = filas.filter(f => f.fecha && f.tipo != null && f.numero != null &&
    (clase === "emitidos" || f.cuit_emisor));
  let nuevas = 0;
  // En lotes vía unnest: un viaje a la base por cada 1000 filas
  for (let i = 0; i < validas.length; i += 1000) {
    const lote = validas.slice(i, i + 1000);
    const col = fn => lote.map(fn);
    if (clase === "emitidos") {
      const r = await sql`INSERT INTO comprobantes_emitidos
        (fecha, tipo, punto_venta, numero, doc_tipo, doc_nro, receptor, neto, iva, otros_tributos, total, cae, fuente)
        SELECT x.*, 'mc' FROM unnest(
          ${col(f => f.fecha)}::date[], ${col(f => f.tipo)}::int[], ${col(f => f.punto_venta || 0)}::int[],
          ${col(f => f.numero)}::bigint[], ${col(f => f.doc_tipo ?? null)}::int[], ${col(f => f.doc_nro ?? null)}::bigint[],
          ${col(f => f.receptor || null)}::text[], ${col(f => f.neto || 0)}::numeric[], ${col(f => f.iva || 0)}::numeric[],
          ${col(f => f.otros_tributos || 0)}::numeric[], ${col(f => f.total || 0)}::numeric[], ${col(f => f.cae || null)}::text[]
        ) AS x(fecha, tipo, punto_venta, numero, doc_tipo, doc_nro, receptor, neto, iva, otros_tributos, total, cae)
        ON CONFLICT (tipo, punto_venta, numero) DO NOTHING RETURNING id`;
      nuevas += r.length;
    } else {
      const r = await sql`INSERT INTO comprobantes_recibidos
        (fecha, tipo, punto_venta, numero, cuit_emisor, emisor, neto, iva, otros_tributos, total)
        SELECT * FROM unnest(
          ${col(f => f.fecha)}::date[], ${col(f => f.tipo)}::int[], ${col(f => f.punto_venta || 0)}::int[],
          ${col(f => f.numero)}::bigint[], ${col(f => f.cuit_emisor)}::bigint[], ${col(f => f.emisor || null)}::text[],
          ${col(f => f.neto || 0)}::numeric[], ${col(f => f.iva || 0)}::numeric[],
          ${col(f => f.otros_tributos || 0)}::numeric[], ${col(f => f.total || 0)}::numeric[]
        ) AS x(fecha, tipo, punto_venta, numero, cuit_emisor, emisor, neto, iva, otros_tributos, total)
        ON CONFLICT (cuit_emisor, tipo, punto_venta, numero) DO NOTHING RETURNING id`;
      nuevas += r.length;
      await sql`INSERT INTO proveedores (cuit, nombre)
        SELECT DISTINCT ON (cuit) * FROM unnest(${col(f => f.cuit_emisor)}::bigint[], ${col(f => f.emisor || null)}::text[]) AS x(cuit, nombre)
        ON CONFLICT (cuit) DO UPDATE SET nombre = COALESCE(proveedores.nombre, EXCLUDED.nombre)`;
    }
  }
  return res.status(200).json({ ok: true, clase, recibidas: filas.length, nuevas });
}

// Asignar rubro a un proveedor (aplica a todas sus facturas, pasadas y futuras)
async function rubroProveedor(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { cuit, rubro } = req.body || {};
  if (!cuit || !rubro) return res.status(400).json({ error: "cuit y rubro requeridos" });
  const sql = neon(process.env.DATABASE_URL);
  await sql`INSERT INTO proveedores (cuit, rubro) VALUES (${cuit}, ${rubro})
    ON CONFLICT (cuit) DO UPDATE SET rubro = ${rubro}`;
  return res.status(200).json({ ok: true });
}

// Disparo manual del barrido WSFE (el automático corre con el cierre diario)
async function arcaSync(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const r = await sincronizarEmitidos(sql, { maxComprobantes: 800 });
  return res.status(200).json(r);
}

// Tablero: posición de IVA, cruce vendido vs facturado, gastos por rubro y conciliación
async function contabilidad(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes : hoyArg().slice(0, 7);
  const desde = `${mes}-01`;
  const hasta = `${mes}-31`;

  // Posición de IVA de los últimos 6 meses (débito emitidos − crédito recibidos)
  const iva = await sql`
    WITH deb AS (
      SELECT to_char(fecha, 'YYYY-MM') AS mes,
             ROUND(SUM(iva * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS debito,
             ROUND(SUM(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS facturado
      FROM comprobantes_emitidos GROUP BY 1
    ), cred AS (
      SELECT to_char(fecha, 'YYYY-MM') AS mes,
             ROUND(SUM(iva * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS credito,
             ROUND(SUM(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS compras
      FROM comprobantes_recibidos GROUP BY 1
    )
    SELECT COALESCE(d.mes, c.mes) AS mes,
           COALESCE(d.debito, 0) AS debito, COALESCE(c.credito, 0) AS credito,
           COALESCE(d.facturado, 0) AS facturado, COALESCE(c.compras, 0) AS compras
    FROM deb d FULL OUTER JOIN cred c ON d.mes = c.mes
    ORDER BY 1 DESC LIMIT 6`;

  // Cruce diario del mes: venta según los sistemas vs total facturado en ARCA
  const cruce = await sql`
    WITH v AS (
      SELECT fecha, ROUND(SUM(total))::bigint AS venta FROM ventas
      WHERE fecha BETWEEN ${desde} AND ${hasta} GROUP BY 1
    ), f AS (
      SELECT fecha, ROUND(SUM(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS facturado
      FROM comprobantes_emitidos WHERE fecha BETWEEN ${desde} AND ${hasta} GROUP BY 1
    )
    SELECT COALESCE(v.fecha, f.fecha)::text AS fecha,
           COALESCE(v.venta, 0) AS venta, COALESCE(f.facturado, 0) AS facturado
    FROM v FULL OUTER JOIN f ON v.fecha = f.fecha ORDER BY 1`;

  // Facturación del mes por punto de venta
  const porPV = await sql`
    SELECT punto_venta, COUNT(*)::int AS comprobantes,
           ROUND(SUM(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS total
    FROM comprobantes_emitidos WHERE fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY 1 ORDER BY total DESC`;

  // Lo que corresponde facturar según la operatoria del negocio: online se factura
  // todo; en los locales, lo cobrado con tarjeta (electron/chip&pin = bruto de MP
  // Point del mes, que viene del reporte que se sube en Rentabilidad → Carga).
  const [esperado] = await sql`
    SELECT
      (SELECT ROUND(COALESCE(SUM(total), 0))::bigint FROM ventas
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND local = 'Tiendanube') AS venta_online,
      (SELECT ROUND(COALESCE(SUM(bruto), 0))::bigint FROM mix_pagos
        WHERE mes = ${mes} AND local <> 'Tiendanube') AS tarjetas_locales`;

  // Pista de qué punto de venta es cada local Dragonfish (sale del prefijo del orden_id)
  const pvLocales = await sql`
    SELECT local, split_part(regexp_replace(orden_id, '^[A-Z]+', ''), '-', 1) AS pv, COUNT(*)::int AS n
    FROM ventas
    WHERE sistema = 'Dragonfish' AND fecha BETWEEN ${desde} AND ${hasta} AND orden_id ~ '^[A-Z]+[0-9]+-'
    GROUP BY 1, 2 ORDER BY n DESC`;

  // Gastos del mes por rubro y por proveedor
  const rubros = await sql`
    SELECT COALESCE(p.rubro, 'Sin rubro') AS rubro,
           ROUND(SUM(c.total * CASE WHEN c.tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS total,
           COUNT(*)::int AS comprobantes
    FROM comprobantes_recibidos c LEFT JOIN proveedores p ON p.cuit = c.cuit_emisor
    WHERE c.fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY 1 ORDER BY total DESC`;
  const provs = await sql`
    SELECT c.cuit_emisor AS cuit, COALESCE(p.nombre, MAX(c.emisor)) AS nombre,
           COALESCE(p.rubro, 'Sin rubro') AS rubro,
           ROUND(SUM(c.total * CASE WHEN c.tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS total,
           ROUND(SUM(c.iva * CASE WHEN c.tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS iva,
           COUNT(*)::int AS comprobantes
    FROM comprobantes_recibidos c LEFT JOIN proveedores p ON p.cuit = c.cuit_emisor
    WHERE c.fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY 1, p.nombre, p.rubro ORDER BY total DESC LIMIT 60`;

  // Conciliación de transferencias a proveedores. Los pagos suelen ser parciales,
  // así que no se matchea factura por factura: se agrupa POR PROVEEDOR y se compara
  // total transferido vs. total facturado por él (ventana del mes ±20 días).
  // El nombre del estado de cuenta viene truncado ("Martinez Analia Dor"), por eso
  // el join es por prefijo.
  const conciliacion = await sql`
    WITH trf AS (
      SELECT upper(trim(contraparte)) AS nombre,
             ROUND(SUM(monto))::bigint AS transferido,
             COUNT(*)::int AS transferencias
      FROM egresos_mp
      WHERE fecha BETWEEN ${desde} AND ${hasta}
        AND detalle ILIKE 'Transferencia enviada%' AND contraparte IS NOT NULL
      GROUP BY 1
    )
    SELECT t.nombre, t.transferido, t.transferencias,
           COALESCE((
             SELECT ROUND(SUM(c.total * CASE WHEN c.tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint
             FROM comprobantes_recibidos c
             WHERE upper(c.emisor) LIKE t.nombre || '%'
               AND c.fecha BETWEEN ${desde}::date - 20 AND ${hasta}::date + 20
           ), 0) AS facturado
    FROM trf t ORDER BY t.transferido DESC`;

  // Otros egresos del mes (pauta, servicios, envíos) para tener el gasto por canal
  const otrosEgresos = await sql`
    SELECT CASE
             WHEN detalle ILIKE '%faceb%' THEN 'Publicidad Meta'
             WHEN detalle ILIKE 'Pago de impuestos%' THEN 'Impuestos al débito'
             WHEN detalle ILIKE 'Pago Envío%' OR detalle ILIKE '%MiCorreo%' OR detalle ILIKE '%dhl%' THEN 'Envíos'
             WHEN detalle ILIKE 'Compra Mercado%' THEN 'Compras ML'
             ELSE 'Servicios y otros'
           END AS canal,
           ROUND(SUM(monto))::bigint AS total, COUNT(*)::int AS pagos
    FROM egresos_mp
    WHERE fecha BETWEEN ${desde} AND ${hasta} AND detalle NOT ILIKE 'Transferencia%'
    GROUP BY 1 ORDER BY total DESC`;

  const [estado] = await sql`
    SELECT (SELECT COUNT(*) FROM comprobantes_emitidos)::int AS emitidos,
           (SELECT COUNT(*) FROM comprobantes_recibidos)::int AS recibidos,
           (SELECT MAX(cargado_en) FROM comprobantes_recibidos)::text AS ultima_carga_recibidos,
           (SELECT COALESCE(SUM(ultimo), 0) FROM arca_cursor)::bigint AS cursor_ws`;

  return res.status(200).json({
    ok: true, mes,
    arca: arcaConfigurada(),
    iva: iva.map(r => ({ ...r, debito: Number(r.debito), credito: Number(r.credito), posicion: Number(r.debito) - Number(r.credito), facturado: Number(r.facturado), compras: Number(r.compras) })),
    cruce: cruce.map(r => ({ ...r, venta: Number(r.venta), facturado: Number(r.facturado) })),
    esperado: { ventaOnline: Number(esperado.venta_online), tarjetasLocales: Number(esperado.tarjetas_locales) },
    porPV: porPV.map(r => ({ ...r, total: Number(r.total) })),
    pvLocales,
    rubros: rubros.map(r => ({ ...r, total: Number(r.total) })),
    proveedores: provs.map(r => ({ ...r, cuit: Number(r.cuit), total: Number(r.total), iva: Number(r.iva) })),
    conciliacion: conciliacion.map(r => ({ ...r, transferido: Number(r.transferido), facturado: Number(r.facturado) })),
    otrosEgresos: otrosEgresos.map(r => ({ ...r, total: Number(r.total) })),
    estado,
    nombresTipo: NOMBRES_TIPO,
  });
}

// Alta de egresos de MercadoPago (transferencias a proveedores) para conciliar
async function cargarEgresos(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { filas } = req.body || {};
  if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: "filas requeridas" });
  if (filas.length > 20000) return res.status(400).json({ error: "demasiadas filas en una carga" });
  const sql = neon(process.env.DATABASE_URL);
  const validas = filas.filter(f => f.id && f.fecha && f.monto);
  let nuevas = 0;
  for (let i = 0; i < validas.length; i += 1000) {
    const lote = validas.slice(i, i + 1000);
    const col = fn => lote.map(fn);
    const r = await sql`INSERT INTO egresos_mp (id, fecha, contraparte, cuit, monto, detalle)
      SELECT * FROM unnest(
        ${col(f => String(f.id))}::text[], ${col(f => f.fecha)}::date[], ${col(f => f.contraparte || null)}::text[],
        ${col(f => f.cuit ?? null)}::bigint[], ${col(f => f.monto)}::numeric[], ${col(f => f.detalle || null)}::text[]
      ) AS x(id, fecha, contraparte, cuit, monto, detalle)
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    nuevas += r.length;
  }
  return res.status(200).json({ ok: true, recibidas: filas.length, nuevas });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tussy-Auth");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { action, desde, hasta, local, limite } = req.query;

  // Las acciones del cron se autentican con su secret; todo lo demás requiere
  // la sesión firmada que emite /api/auth al loguearse.
  const ACCIONES_CRON = ["ingesta", "cierre", "semanal"];
  if (!ACCIONES_CRON.includes(action)) {
    if (!requerirSesion(req, res)) return;
  }

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
    if (action === "rentabilidadProducto") return await rentabilidadProducto(req, res);
    if (action === "evolucion") return await evolucion(req, res);
    if (action === "inventario") return await inventario(req, res);
    if (action === "traslados") return await traslados(req, res);
    if (action === "cargarReporte") return await cargarReporte(req, res);
    if (action === "gastosLocales") return await gastosLocales(req, res);
    if (action === "guardarGastoLocal") return await guardarGastoLocal(req, res);
    if (action === "contabilidad") return await contabilidad(req, res);
    if (action === "cargarComprobantes") return await cargarComprobantes(req, res);
    if (action === "cargarEgresos") return await cargarEgresos(req, res);
    if (action === "rubroProveedor") return await rubroProveedor(req, res);
    if (action === "arcaSync") return await arcaSync(req, res);

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
