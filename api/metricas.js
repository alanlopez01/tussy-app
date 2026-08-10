// Métricas desde Postgres (Neon) — la fuente de verdad nueva.
// GET /api/metricas?action=serie&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
//   → { dias: [{fecha, palermo, laplata, online, dot, abasto, cordoba, total, ops}] }
// GET /api/metricas?action=topProductos&desde=&hasta=&local=&orden=cantidad|total&limite=20
// GET /api/metricas?action=categorias / variantes — agregados por categoría / talle+color
// GET /api/metricas?action=live&local=palermo|laplata|online|dot|abasto|cordoba[&fecha=]
//   → ventas del día en vivo desde la fuente, agrupadas por operación
// GET /api/metricas?action=feed[&limite=40] — últimas operaciones de todos los locales (desde la base)
// GET /api/cron/ingesta — cron cada 5 min: ingesta del día + detección de ventas nuevas
//   + push. Los tres crons (ingesta, cierre, semanal) los dispara Vercel según vercel.json
//   y se autentican con el header Authorization: Bearer $CRON_SECRET.
// GET /api/metricas?action=sync — (fecha, local) con errores de sincronización
const { neon } = require("@neondatabase/serverless");
const { waitUntil } = require("@vercel/functions");
const webpush = require("web-push");
const { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFDia, fetchDFRango } = require("../lib/fuentes");

const KEY_LOCAL = {
  "Palermo": "palermo", "La Plata": "laplata", "Tiendanube": "online",
  "Dot": "dot", "Abasto": "abasto", "Córdoba": "cordoba", "Cordoba": "cordoba",
};

const { normalizarProducto } = require("../lib/normalizar");
const { requerirSesion, verificarToken } = require("../lib/auth");
const { costear } = require("../lib/costeo");
const { LOCALES_SIN_STOCK, MOTIVO_SIN_STOCK } = require("../lib/stock");
const { snapshotStock } = require("../scripts/db-snapshot-stock");
const { arcaConfigurada, sincronizarEmitidos, NOMBRES_TIPO } = require("../lib/arca");
const { esCuentaPropia, CATEGORIA_PROPIA, parsearGalicia, categorizar } = require("../lib/bancos");
const { metaConfigurada, sincronizarMeta, actualizarConjuntoNewIn } = require("../lib/meta");
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

// Cobros del día (cómo se pagó): se reescriben junto con las ventas del día.
async function escribirCobrosDia(sql, fecha, local, cobros) {
  await sql`DELETE FROM cobros WHERE fecha = ${fecha} AND local = ${local}`;
  if (!cobros || !cobros.length) return;
  for (let i = 0; i < cobros.length; i += 500) {
    const c = cobros.slice(i, i + 500);
    await sql`
      INSERT INTO cobros (fecha, local, orden_id, item, medio, detalle, monto)
      SELECT * FROM UNNEST(
        ${c.map(f => f.fecha)}::date[], ${c.map(f => f.local)}::text[], ${c.map(f => f.orden_id)}::text[],
        ${c.map(f => f.item)}::int[], ${c.map(f => f.medio)}::text[],
        ${c.map(f => f.detalle || null)}::text[], ${c.map(f => f.monto)}::numeric[]
      ) ON CONFLICT (local, orden_id, item) DO NOTHING`;
  }
}

// Clientes de las órdenes de Tiendanube (para recompra/LTV); upsert idempotente
async function escribirClientesTN(sql, clientes) {
  if (!clientes || !clientes.length) return;
  for (let i = 0; i < clientes.length; i += 500) {
    const c = clientes.slice(i, i + 500);
    await sql`INSERT INTO clientes_tn (orden_id, cliente_id, fecha, total)
      SELECT * FROM UNNEST(
        ${c.map(x => x.orden_id)}::text[], ${c.map(x => x.cliente_id)}::bigint[],
        ${c.map(x => x.fecha)}::date[], ${c.map(x => x.total)}::numeric[]
      ) ON CONFLICT (orden_id) DO UPDATE SET cliente_id = EXCLUDED.cliente_id, total = EXCLUDED.total`;
  }
}

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

// Los crons corren en Vercel, que manda CRON_SECRET en el header Authorization.
// Se sigue aceptando ?secret= para poder dispararlos a mano desde una terminal.
// El literal es sólo el default de desarrollo: en producción CRON_SECRET está seteado.
function autorizarCron(req, res) {
  const secret = process.env.CRON_SECRET || "solo-para-desarrollo-local";
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  if (req.query.secret === secret) return true;
  res.status(401).json({ error: "secret inválido" });
  return false;
}

async function ingesta(req, res) {
  if (!autorizarCron(req, res)) return;

  // La ingesta puede tardar bastante (6 fuentes, POS lentos). Respondemos al instante
  // y el trabajo sigue de fondo hasta maxDuration (waitUntil).
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
    await escribirCobrosDia(sql, hoy, local, r.cobros);
    await escribirClientesTN(sql, r.clientes);
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
      await escribirCobrosDia(sql, p.fecha, p.local, r.cobros);
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

// Re-ingesta de los últimos días: captura órdenes que se pagaron DESPUÉS del día
// en que se crearon (transferencias, pagos demorados de Tiendanube). Sin esto, la
// foto diaria de ventas queda congelada y esas órdenes se pierden para siempre.
async function reingestarUltimosDias(sql, dias = 7) {
  const resumen = [];
  const hoy = hoyArg();
  // Dragonfish: un solo sweep por local cubre todo el rango (paginar es lo caro)
  const desde = new Date(Date.now() - 3 * 3600 * 1000 - dias * 86400000).toISOString().slice(0, 10);
  const ayer = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  for (const l of dfLocales()) {
    const r = await fetchDFRango(l, desde, ayer);
    if (!r.ok) { resumen.push({ local: l.nombre, ok: false, error: r.error }); continue; }
    for (const [dia, filas] of Object.entries(r.porDia)) {
      if (dia >= hoy) continue;
      await escribirDiaLocal(sql, dia, l.nombre, filas);
      await escribirCobrosDia(sql, dia, l.nombre, (r.cobrosPorDia || {})[dia] || []);
    }
    resumen.push({ local: l.nombre, ok: true, dias: Object.keys(r.porDia).length });
  }
  // Woo y Tiendanube: día por día
  const listaDias = [];
  for (let i = 1; i <= dias; i++) {
    listaDias.push(new Date(Date.now() - 3 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10));
  }
  const fuentesWebs = [
    ...wooLocales().map(l => ({ local: l.nombre, fn: f => fetchWooDia(l, f) })),
    { local: "Tiendanube", fn: f => fetchTNDia(f) },
  ];
  for (const { local, fn } of fuentesWebs) {
    let ok = 0;
    for (const dia of listaDias) {
      const r = await fn(dia);
      if (!r.ok) continue;
      await escribirDiaLocal(sql, dia, local, r.filas);
      await escribirCobrosDia(sql, dia, local, r.cobros);
      await escribirClientesTN(sql, r.clientes);
      ok++;
    }
    resumen.push({ local, ok: true, dias: ok });
  }
  return resumen;
}

// ── Cierre del día anterior (cron diario 00:05 ARG) ──
async function cierreDiario(req, res) {
  if (!autorizarCron(req, res)) return;
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
  // Y re-ingestamos la última semana para capturar pagos que se acreditaron tarde
  waitUntil(
    reingestarUltimosDias(sql, 7)
      .then(r => console.log("[reingesta]", JSON.stringify(r)))
      .catch(e => console.error("[reingesta] error:", e))
  );
  // Métricas de Meta: última semana (la atribución cambia retroactivamente)
  if (metaConfigurada()) {
    const d7 = new Date(Date.now() - 3 * 3600 * 1000 - 7 * 86400000).toISOString().slice(0, 10);
    waitUntil(
      sincronizarMeta(sql, { desde: d7, hasta: hoyArg() })
        .then(r => console.log("[meta]", JSON.stringify(r)))
        .catch(e => console.error("[meta] error:", e))
    );
    // Y el conjunto NEW IN del catálogo de Meta se pisa con la categoría de TN
    waitUntil(
      actualizarConjuntoNewIn()
        .then(r => console.log("[newin]", JSON.stringify(r)))
        .catch(e => console.error("[newin] error:", e))
    );
  }
  return res.status(200).json({ ok: true, fecha: ayer, total, porLocal: rows, notificadas: enviadas });
}

// ── Resumen de los lunes: mes en curso desglosado (cron lunes 09:00 ARG) ──
async function resumenSemanal(req, res) {
  if (!autorizarCron(req, res)) return;
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
  // La serie termina en el último mes CERRADO (el actual se filtra igual más abajo)
  const meses = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 2 - i, 1));
    meses.push(d.toISOString().slice(0, 7));
  }
  const [resultados, ipcRows, cfgIgRows] = await Promise.all([
    Promise.all(meses.map(mes => calcularNegocio(sql, mes))),
    sql`SELECT mes, pct FROM ipc_mes`,
    sql`SELECT valor FROM config_negocio WHERE clave = 'ig_pct'`,
  ]);
  const ipc = Object.fromEntries(ipcRows.map(r => [r.mes, Number(r.pct)]));
  const igPct = Number(cfgIgRows[0]?.valor ?? 0.35);

  // Deflactor a pesos del último mes con IPC conocido: acumula la inflación de los
  // meses POSTERIORES a cada mes (venta real = venta nominal × deflactor).
  // El mes en curso queda afuera: días de venta contra la estructura del mes entero
  // dan un margen sin sentido que solo confunde.
  const mesActual = hoyArg().slice(0, 7);
  const conVenta = resultados.filter(r => r.total.venta > 0 && r.mes < mesActual);
  const deflactor = {};
  {
    let acum = 1;
    for (let i = conVenta.length - 1; i >= 0; i--) {
      deflactor[conVenta[i].mes] = acum;
      const pct = ipc[conVenta[i].mes];
      acum *= pct != null ? 1 + pct / 100 : 1;
    }
  }

  return res.status(200).json({
    ig_pct: igPct,
    meses: conVenta
      .map(r => {
        // ── Resultado "de verdad": provisiones que la caja no muestra ──
        // SAC: el aguinaldo se devenga todos los meses aunque se pague en jun/dic.
        // Provisión = sueldos/12 + las cargas de esa doceava parte. Cuando el mes trae
        // el F931 real con SAC (junio), el pico de cargas se saca para no contarlo dos veces.
        const sueldos = r.total.sueldos_totales || 0;
        const provisionSac = Math.round(sueldos / 12 + (r.total.cargas_normales || 0) / 12);
        const picoSac = Math.max(0, (r.total.cargas_usadas || 0) - (r.total.cargas_normales || 0));
        // Ganancias: provisión sobre el resultado ajustado. Es el impuesto que se
        // devenga; retenciones y anticipos ya pagados se restan al liquidar.
        const resultadoAjustado = r.total.resultado + picoSac - provisionSac;
        const provisionIg = Math.max(0, Math.round(resultadoAjustado * igPct));
        const resultadoNeto = resultadoAjustado - provisionIg;
        const defl = deflactor[r.mes] ?? 1;
        return {
          mes: r.mes,
          venta: r.total.venta,
          venta_real: Math.round(r.total.venta * defl),
          ipc_conocido: ipc[r.mes] != null,
          mercaderia: r.total.mercaderia,
          margen_bruto: r.total.margen_bruto,
          margen_bruto_pct: r.total.venta > 0 ? Math.round(r.total.margen_bruto / r.total.venta * 1000) / 10 : null,
          financiero: r.total.financiero,
          fijos: r.total.fijos,
          impuestos: r.total.impuestos,
          resultado: r.total.resultado,
          margen_pct: r.total.margen_pct,
          provision_sac: provisionSac,
          pico_sac: picoSac,
          provision_ig: provisionIg,
          resultado_neto: resultadoNeto,
          margen_neto_pct: r.total.venta > 0 ? Math.round(resultadoNeto / r.total.venta * 1000) / 10 : null,
          datos: r.datos,
          completo: r.datos.fijos,
          estimado: r.datos.fijos_estimados || !r.datos.mix_pagos,
          // Resultado de cada unidad, para ver quién mejora y quién empeora
          por_unidad: Object.fromEntries(r.unidades.map(u => [u.local, { venta: u.venta, resultado: u.resultado, margen_pct: u.margen_pct }])),
        };
      }),
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
  const [ventasPorLocal, gastosMesRows, pautaProdRows] = await Promise.all([
    sql`SELECT local, ROUND(SUM(total))::bigint AS venta, SUM(cantidad)::int AS unidades
        FROM ventas WHERE fecha BETWEEN ${desde} AND ${hasta} GROUP BY local`,
    sql`SELECT local, concepto, monto FROM gastos_mes WHERE mes = ${mes}`,
    sql`SELECT ROUND(COALESCE(SUM(monto), 0))::bigint AS p FROM egresos_mp
        WHERE to_char(fecha, 'YYYY-MM') = ${mes} AND detalle ILIKE '%faceb%'`,
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
    const pautaRealProd = Number(pautaProdRows[0]?.p || 0);
    if (pautaRealProd > 0) gv.publicidad = pautaRealProd;
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

  // Impuestos por escenario según la operatoria real: lo que se factura paga IVA
  // (21/121 del precio final, es el débito fiscal) e IIBB; el efectivo no se
  // factura, así que no paga ninguno de los dos. Online factura todo, incluso
  // las transferencias.
  const ivaVentaPct = cfg.iva_venta_pct ?? (0.21 / 1.21);
  const iibbVentaPct = cfg.iibb_pct ?? 0.0452;
  const impuestoFacturadoPct = ivaVentaPct + iibbVentaPct;

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
    const sinFactura = e.key === "efectivo";
    const impuestos = sinFactura ? 0 : Math.round(ingreso * impuestoFacturadoPct);
    // CONTRIBUCIÓN = lo que esta venta deja para pagar la estructura y generar ganancia.
    // Es la métrica de decisión: mientras sea positiva, vender conviene.
    const contribucion = costoDirecto == null ? null : ingreso - costoDirecto - impuestos;
    // Referencia (no se resta como si fuera un costo del producto): lo que en promedio
    // aporta cada prenda vendida en este punto de venta para cubrir sus fijos.
    const excedente = contribucion == null ? null : contribucion - estructuraUnidad;
    return {
      ...e, ingreso, sin_factura: sinFactura,
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
    impuesto_pct: Math.round(impuestoFacturadoPct * 1000) / 10,
    impuesto_monto: Math.round(precioLista * impuestoFacturadoPct),
    iva_venta_pct: Math.round(ivaVentaPct * 1000) / 10,
    iibb_venta_pct: Math.round(iibbVentaPct * 1000) / 10,
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

  const [mixPagos, fijos, cfgRows, gastosMes, impuestosRows, posIvaRows, pautaRows] = await Promise.all([
    sql`SELECT local, bruto, neto, costo_pct, mix FROM mix_pagos WHERE mes = ${mes}`,
    leerGastosFijos(sql, mes),
    sql`SELECT clave, valor FROM config_negocio`,
    sql`SELECT local, concepto, monto FROM gastos_mes WHERE mes = ${mes}`,
    sql`SELECT concepto, monto FROM impuestos_mes WHERE mes = ${mes}`,
    // Posición de IVA real del mes según los comprobantes de ARCA
    sql`SELECT
          COALESCE((SELECT SUM(iva * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END)
                    FROM comprobantes_emitidos WHERE to_char(fecha, 'YYYY-MM') = ${mes}), 0)
        - COALESCE((SELECT SUM(iva * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END)
                    FROM comprobantes_recibidos WHERE to_char(fecha, 'YYYY-MM') = ${mes}), 0) AS posicion,
          (SELECT COUNT(*) FROM comprobantes_emitidos WHERE to_char(fecha, 'YYYY-MM') = ${mes})::int AS emitidos,
          (SELECT COUNT(*) FROM comprobantes_recibidos WHERE to_char(fecha, 'YYYY-MM') = ${mes})::int AS recibidos`,
    // Pauta real de Meta: los pagos a Facebook del estado de cuenta de MP
    sql`SELECT ROUND(COALESCE(SUM(monto), 0))::bigint AS p FROM egresos_mp
        WHERE to_char(fecha, 'YYYY-MM') = ${mes} AND detalle ILIKE '%faceb%'`,
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
  // Publicidad online: si está el estado de cuenta de MP del mes, la pauta REAL
  // de Meta pisa el monto manual (que queda solo como respaldo)
  const pautaReal = Number(pautaRows[0]?.p || 0);
  if (pautaReal > 0) {
    if (!varPorLocal["Tiendanube"]) varPorLocal["Tiendanube"] = {};
    varPorLocal["Tiendanube"].publicidad = pautaReal;
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
  // El IVA sale de los comprobantes de ARCA: débito de lo facturado menos crédito de
  // las compras. Es lo que genera la actividad del mes y varía mucho según cuánto se
  // compró (entre 0,5% y 5,4% de la venta), así que un % fijo distorsiona el resultado.
  // Si hay un monto declarado cargado a mano en impuestos_mes, ese manda.
  const pi = posIvaRows[0] || {};
  const ivaReal = Number(pi.emitidos) > 0 && Number(pi.recibidos) > 0 ? Number(pi.posicion) : null;
  const ivaMes = impuestosReales.iva != null ? impuestosReales.iva
    : ivaReal != null ? ivaReal
    : ventaTotal * (cfg.iva_pct || 0);
  const origenIva = impuestosReales.iva != null ? "declarado"
    : ivaReal != null ? "arca"
    : "estimado";

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
  // Para las provisiones de Evolución: sueldos totales (con y sin cargas, franqueros,
  // supervisor) y cargas "normales" (sin el pico del SAC de junio/diciembre).
  const sueldosTotales = Object.values(fijos).reduce((a, f) => {
    const c = f.conceptos || {};
    for (const [k, v] of Object.entries(c)) {
      if (/sueldo|franquero|supervisor|empleado/.test(k) && !k.includes("sin_cargas")) a += Number(v) || 0;
    }
    return a;
  }, 0);
  const cargasNormales = Math.round(baseCargasTotal * (cfg.cargas_pct || 0));

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
        origen_iva: origenIva,
      },
      resultado: suma("resultado"),
      margen_pct: ventaTotal > 0 ? Math.round(suma("resultado") / ventaTotal * 1000) / 10 : null,
      sueldos_totales: Math.round(sueldosTotales),
      cargas_normales: cargasNormales,
      cargas_usadas: Math.round(cargasMes),
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

// Alta de movimientos de un extracto bancario (Galicia). El navegador manda el CSV
// crudo y el parseo ocurre acá, con la misma librería que usan los scripts.
async function cargarBanco(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { texto } = req.body || {};
  if (typeof texto !== "string" || !texto.trim()) return res.status(400).json({ error: "texto del extracto requerido" });
  if (texto.length > 8_000_000) return res.status(400).json({ error: "archivo demasiado grande" });
  let filas, saldoGal;
  try { const r = parsearGalicia(texto); filas = r.filas; saldoGal = r.saldo; }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const sql = neon(process.env.DATABASE_URL);
  if (saldoGal) {
    await sql`INSERT INTO saldos_cuenta (cuenta, fecha, saldo) VALUES ('galicia', ${saldoGal.fecha}, ${saldoGal.saldo})
      ON CONFLICT (cuenta, fecha) DO UPDATE SET saldo = ${saldoGal.saldo}`;
  }
  const validas = filas.filter(f => f.id && f.fecha && f.monto);
  let nuevas = 0;
  for (let i = 0; i < validas.length; i += 1000) {
    const lote = validas.slice(i, i + 1000);
    const a = fn => lote.map(fn);
    const r = await sql`INSERT INTO movimientos_banco
      (id, origen, fecha, descripcion, contraparte, cuit, monto, comprobante, categoria)
      SELECT * FROM unnest(
        ${a(f => String(f.id))}::text[], ${a(f => f.origen || "galicia")}::text[], ${a(f => f.fecha)}::date[],
        ${a(f => f.descripcion || null)}::text[], ${a(f => f.contraparte || null)}::text[],
        ${a(f => f.cuit ?? null)}::bigint[], ${a(f => f.monto)}::numeric[],
        ${a(f => f.comprobante || null)}::text[], ${a(f => f.categoria || "Otros")}::text[]
      ) AS x(id, origen, fecha, descripcion, contraparte, cuit, monto, comprobante, categoria)
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    nuevas += r.length;
  }
  return res.status(200).json({ ok: true, recibidas: filas.length, nuevas });
}

// ── Facturas recibidas: listado con búsqueda (por proveedor, CUIT o número) ──
async function facturasRecibidas(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const q = String(req.query.q || "").trim();
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes : hoyArg().slice(0, 7);
  let rows;
  if (q) {
    // Con búsqueda se mira TODO el historial, no solo el mes
    const like = `%${q}%`;
    const dig = q.replace(/\D/g, "");
    rows = await sql`
      SELECT fecha::text, tipo, punto_venta, numero, cuit_emisor, emisor,
             neto::numeric, iva::numeric, total::numeric
      FROM comprobantes_recibidos
      WHERE emisor ILIKE ${like}
         OR numero::text LIKE ${like}
         OR (${dig} <> '' AND cuit_emisor::text LIKE ${"%" + dig + "%"})
      ORDER BY fecha DESC LIMIT 300`;
  } else {
    rows = await sql`
      SELECT fecha::text, tipo, punto_venta, numero, cuit_emisor, emisor,
             neto::numeric, iva::numeric, total::numeric
      FROM comprobantes_recibidos
      WHERE to_char(fecha, 'YYYY-MM') = ${mes}
      ORDER BY fecha DESC, total DESC LIMIT 300`;
  }
  return res.status(200).json({
    ok: true, q: q || null, mes,
    facturas: rows.map(r => ({ ...r, cuit_emisor: Number(r.cuit_emisor), neto: Number(r.neto), iva: Number(r.iva), total: Number(r.total) })),
    nombresTipo: NOMBRES_TIPO,
  });
}

// ── Liquidación declarada: lo que la contadora determina (~día 18) queda fijo ──
async function guardarImpuestoMes(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { mes, concepto, monto, nota } = req.body || {};
  const PERMITIDOS = ["iva", "iva_pagado", "iibb", "cargas_sociales"];
  if (!/^\d{4}-\d{2}$/.test(mes || "") || !PERMITIDOS.includes(concepto)) {
    return res.status(400).json({ error: "mes y concepto válidos requeridos" });
  }
  const sql = neon(process.env.DATABASE_URL);
  if (monto == null || monto === "") {
    await sql`DELETE FROM impuestos_mes WHERE mes = ${mes} AND concepto = ${concepto}`;
  } else {
    await sql`INSERT INTO impuestos_mes (mes, concepto, monto, nota)
      VALUES (${mes}, ${concepto}, ${Number(monto)}, ${nota || "cargado desde la app"})
      ON CONFLICT (mes, concepto) DO UPDATE SET monto = ${Number(monto)}, nota = ${nota || "cargado desde la app"}, actualizado_en = now()`;
  }
  return res.status(200).json({ ok: true });
}

// ── Curva horaria: cuánto vende cada franja, por local y día de semana ──
// Para decidir horarios y franqueros con datos: promedio de venta por hora en los
// días en que el local efectivamente abrió (un domingo cerrado no promedia como $0).
async function curvaHoraria(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const hoy = hoyArg();
  // La hora está completa en todas las fuentes desde el 1/7 (antes Dragonfish no la tenía)
  const pisoDatos = "2026-07-01";
  const desde56 = new Date(Date.now() - 3 * 3600 * 1000 - 56 * 86400000).toISOString().slice(0, 10);
  const desde = desde56 > pisoDatos ? desde56 : pisoDatos;
  const [porFranja, diasPorDow] = await Promise.all([
    sql`SELECT local, EXTRACT(dow FROM fecha)::int AS dow, substr(hora, 1, 2)::int AS h,
               ROUND(SUM(total))::bigint AS venta, COUNT(DISTINCT orden_id)::int AS ops
        FROM ventas
        WHERE fecha BETWEEN ${desde} AND ${hoy} AND hora IS NOT NULL AND orden_id IS NOT NULL
        GROUP BY 1, 2, 3`,
    sql`SELECT local, EXTRACT(dow FROM fecha)::int AS dow, COUNT(DISTINCT fecha)::int AS dias
        FROM ventas
        WHERE fecha BETWEEN ${desde} AND ${hoy} AND orden_id IS NOT NULL
        GROUP BY 1, 2`,
  ]);
  return res.status(200).json({
    ok: true, desde, hasta: hoy,
    franjas: porFranja.map(r => ({ ...r, venta: Number(r.venta) })),
    dias: diasPorDow,
  });
}

// ── Proyección de cierre del mes + metas por local ──
// Con la forma de los últimos meses cerrados (qué % del mes se lleva cada día) se
// proyecta el cierre a partir de lo acumulado. La meta se carga por local.
async function proyeccionMes(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const hoy = hoyArg();
  const mes = hoy.slice(0, 7);
  const diaHoy = Number(hoy.slice(8, 10));
  // Día de referencia: el último día COMPLETO (hoy todavía está vendiendo)
  const diaRef = Math.max(1, diaHoy - 1);

  const [y, m] = mes.split("-").map(Number);
  const ultimoDiaMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const desde56 = new Date(Date.now() - 3 * 3600 * 1000 - 56 * 86400000).toISOString().slice(0, 10);

  const [acumRows, acumCompletos, promediosDow, metas] = await Promise.all([
    // Acumulado EN VIVO: incluye lo que va del día de hoy (se mueve con la ingesta)
    sql`SELECT local, ROUND(SUM(total))::bigint AS venta FROM ventas
        WHERE to_char(fecha, 'YYYY-MM') = ${mes} GROUP BY 1`,
    // Solo días completos: la base estable para proyectar
    sql`SELECT local, ROUND(SUM(total))::bigint AS venta FROM ventas
        WHERE to_char(fecha, 'YYYY-MM') = ${mes} AND fecha < ${hoy} GROUP BY 1`,
    // Venta promedio por día de SEMANA (últimas 8 semanas completas): proyectar por
    // día de semana evita el sesgo de calendario — un mes que arranca sábado+domingo
    // no debe inflar la proyección solo porque el finde vende más que el promedio.
    sql`SELECT local, EXTRACT(dow FROM fecha)::int AS dow, ROUND(SUM(total) / 8)::bigint AS prom
        FROM ventas WHERE fecha >= ${desde56} AND fecha < ${hoy}
        GROUP BY 1, 2`,
    sql`SELECT local, monto::bigint FROM metas_mes WHERE mes = ${mes}`,
  ]);

  // Días que faltan del mes (incluye hoy, que todavía no terminó)
  const diasRestantes = [];
  for (let d = Number(hoy.slice(8, 10)); d <= ultimoDiaMes; d++) {
    diasRestantes.push(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  }

  const locales = ["Palermo", "La Plata", "Tiendanube", "Dot", "Abasto", "Córdoba"];
  const filas = locales.map(local => {
    const acum = Number(acumRows.find(r => r.local === local)?.venta || 0);
    const acumCompleto = Number(acumCompletos.find(r => r.local === local)?.venta || 0);
    const promDe = dow => Number(promediosDow.find(p => p.local === local && p.dow === dow)?.prom || 0);
    const restante = diasRestantes.reduce((a, dow) => a + promDe(dow), 0);
    const proyeccion = restante > 0 || acumCompleto > 0 ? Math.round(acumCompleto + restante) : null;
    const meta = Number(metas.find(r => r.local === local)?.monto || 0) || null;
    return { local, acumulado: acum, proyeccion, meta,
             vs_meta_pct: meta && proyeccion ? Math.round(proyeccion / meta * 100) : null };
  });
  return res.status(200).json({
    ok: true, mes, dia: diaRef,
    temprano: diaRef < 4,
    locales: filas,
    total: {
      acumulado: filas.reduce((a, f) => a + f.acumulado, 0),
      proyeccion: filas.every(f => f.proyeccion == null) ? null : filas.reduce((a, f) => a + (f.proyeccion || 0), 0),
      meta: filas.some(f => f.meta) ? filas.reduce((a, f) => a + (f.meta || 0), 0) : null,
    },
  });
}

async function guardarMeta(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { mes, local, monto } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(mes || "") || !local || !(Number(monto) >= 0)) {
    return res.status(400).json({ error: "mes, local y monto requeridos" });
  }
  const sql = neon(process.env.DATABASE_URL);
  await sql`INSERT INTO metas_mes (mes, local, monto) VALUES (${mes}, ${local}, ${Number(monto)})
    ON CONFLICT (mes, local) DO UPDATE SET monto = ${Number(monto)}`;
  return res.status(200).json({ ok: true });
}

// ── Quiebres: talles que se agotan pronto, con dónde reponer ──
async function quiebres(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const hoy = hoyArg();
  const desdeVel = new Date(Date.now() - 3 * 3600 * 1000 - 21 * 86400000).toISOString().slice(0, 10);
  const filas = await sql`
    WITH stock_actual AS (
      SELECT s.local, s.producto_norm, s.talle, SUM(s.cantidad)::int AS stock
      FROM stock s
      JOIN (SELECT local, MAX(fecha) AS f FROM stock GROUP BY local) ult
        ON ult.local = s.local AND ult.f = s.fecha
      GROUP BY 1, 2, 3
    ),
    velocidad AS (
      SELECT local, producto_norm, talle, SUM(cantidad)::numeric / 21 AS vel
      FROM ventas
      WHERE fecha BETWEEN ${desdeVel} AND ${hoy}
        AND producto_norm NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE', 'CAFE GRATI')
        -- Tiendanube no tiene stock real cargado (los crudos): sin stock confiable
        -- no se puede hablar de quiebre
        AND local <> 'Tiendanube'
      GROUP BY 1, 2, 3
    )
    SELECT v.local, v.producto_norm, v.talle,
           COALESCE(sa.stock, 0) AS stock,
           ROUND(v.vel, 2) AS vel,
           CASE WHEN v.vel > 0 THEN ROUND(COALESCE(sa.stock, 0) / v.vel, 1) END AS dias,
           (SELECT json_agg(json_build_object('local', s2.local, 'stock', s2.stock))
            FROM stock_actual s2
            LEFT JOIN velocidad v2 ON v2.local = s2.local AND v2.producto_norm = s2.producto_norm AND v2.talle = s2.talle
            WHERE s2.producto_norm = v.producto_norm AND s2.talle = v.talle AND s2.local <> v.local
              AND s2.stock >= 3 AND (v2.vel IS NULL OR s2.stock / v2.vel > 21)) AS donde_hay
    FROM velocidad v
    LEFT JOIN stock_actual sa ON sa.local = v.local AND sa.producto_norm = v.producto_norm AND sa.talle = v.talle
    WHERE v.vel >= 0.15 AND (COALESCE(sa.stock, 0) / v.vel) < 7
    ORDER BY (COALESCE(sa.stock, 0) / v.vel) ASC, v.vel DESC
    LIMIT 80`;
  return res.status(200).json({
    ok: true, ventana_dias: 21,
    quiebres: filas.map(r => ({ ...r, vel: Number(r.vel), dias: r.dias != null ? Number(r.dias) : null })),
  });
}

// ── Clientes online: recompra, frecuencia, valor y costo de adquisición ──
async function clientesOnline(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const meses = await sql`
    WITH ordenes AS (
      SELECT c.*, MIN(fecha) OVER (PARTITION BY cliente_id) AS primera
      FROM clientes_tn c WHERE cliente_id IS NOT NULL
    )
    SELECT to_char(fecha, 'YYYY-MM') AS mes,
           COUNT(*)::int AS ordenes,
           COUNT(DISTINCT cliente_id)::int AS clientes,
           COUNT(DISTINCT cliente_id) FILTER (WHERE to_char(primera, 'YYYY-MM') = to_char(fecha, 'YYYY-MM'))::int AS nuevos,
           ROUND(SUM(total))::bigint AS venta,
           ROUND(SUM(total) FILTER (WHERE to_char(primera, 'YYYY-MM') <> to_char(fecha, 'YYYY-MM')))::bigint AS venta_recurrentes
    FROM ordenes GROUP BY 1 ORDER BY 1`;
  const [glob] = await sql`
    SELECT COUNT(DISTINCT cliente_id)::int AS clientes,
           COUNT(*)::int AS ordenes,
           ROUND(SUM(total))::bigint AS venta,
           COUNT(DISTINCT cliente_id) FILTER (WHERE cliente_id IN (
             SELECT cliente_id FROM clientes_tn WHERE cliente_id IS NOT NULL
             GROUP BY cliente_id HAVING COUNT(*) > 1))::int AS recompraron
    FROM clientes_tn WHERE cliente_id IS NOT NULL`;
  const pauta = await sql`
    SELECT to_char(fecha, 'YYYY-MM') AS mes, ROUND(SUM(monto))::bigint AS pauta
    FROM egresos_mp WHERE detalle ILIKE '%faceb%' GROUP BY 1`;
  // Lo que Meta dice de sí mismo, para cruzarlo contra la realidad
  const metaMes = await sql`
    SELECT to_char(fecha, 'YYYY-MM') AS mes, ROUND(SUM(gasto))::bigint AS gasto,
           SUM(compras)::int AS compras, ROUND(SUM(valor_compras))::bigint AS valor
    FROM meta_insights GROUP BY 1`;
  const mesCerrado = (() => {
    const [y, m] = hoyArg().slice(0, 7).split("-").map(Number);
    return new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 7);
  })();
  const campanias = await sql`
    SELECT campania, ROUND(SUM(gasto))::bigint AS gasto, SUM(compras)::int AS compras,
           ROUND(SUM(valor_compras))::bigint AS valor, SUM(clicks)::int AS clicks
    FROM meta_insights WHERE to_char(fecha, 'YYYY-MM') = ${mesCerrado}
    GROUP BY 1 HAVING SUM(gasto) > 0 ORDER BY 2 DESC`;
  return res.status(200).json({
    ok: true,
    meta_activa: metaConfigurada(),
    mes_campanias: mesCerrado,
    campanias: campanias.map(c => ({ ...c, gasto: Number(c.gasto), valor: Number(c.valor),
      roas_meta: Number(c.gasto) > 0 ? Math.round(Number(c.valor) / Number(c.gasto) * 10) / 10 : null })),
    meses: meses.map(r => ({ ...r, venta: Number(r.venta), venta_recurrentes: Number(r.venta_recurrentes || 0),
      pauta: Number(pauta.find(p => p.mes === r.mes)?.pauta || 0),
      meta_gasto: Number(metaMes.find(p => p.mes === r.mes)?.gasto || 0),
      meta_compras: Number(metaMes.find(p => p.mes === r.mes)?.compras || 0),
      meta_valor: Number(metaMes.find(p => p.mes === r.mes)?.valor || 0) })),
    global: { clientes: glob.clientes, ordenes: glob.ordenes, venta: Number(glob.venta),
      recompraron: glob.recompraron,
      tasa_recompra: glob.clientes ? Math.round(glob.recompraron / glob.clientes * 1000) / 10 : 0,
      ltv: glob.clientes ? Math.round(Number(glob.venta) / glob.clientes) : 0,
      frecuencia: glob.clientes ? Math.round(glob.ordenes / glob.clientes * 100) / 100 : 0 },
  });
}

// ── Flujo integral del mes: ¿dónde está la plata del resultado? ──
// Junta las tres cajas (MercadoPago, Galicia, efectivo de Finanzas) y arma el
// puente resultado → caja: cada peso del resultado o quedó en una cuenta, o se
// retiró, o se volvió stock, o está comprometido en impuestos por pagar.
async function flujoMes(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes : hoyArg().slice(0, 7);
  const [anio, nroMes] = mes.split("-").map(Number);
  const desde = `${mes}-01`;
  const hasta = `${mes}-${String(new Date(Date.UTC(anio, nroMes, 0)).getUTCDate()).padStart(2, "0")}`;

  // Caja de efectivo: el sistema de Finanzas (Sheets). Solo Tussy — Shato tiene
  // su propio target y acá no se mira.
  let finanzas = null;
  const params = encodeURIComponent(JSON.stringify({ mes: nroMes, anio }));
  // El Apps Script arranca en frío a veces: un reintento alcanza
  for (let intento = 1; intento <= 2 && !finanzas; intento++) {
    try {
      const r = await fetch(`${process.env.APPS_SCRIPT_URL}?action=getDashboard&params=${params}`, {
        redirect: "follow", signal: AbortSignal.timeout(intento === 1 ? 25000 : 40000),
      });
      finanzas = await r.json();
    } catch (e) { console.error(`[flujo] finanzas intento ${intento}:`, e.message); }
  }

  const [negocio, mpFlujo, dlocal, ingresoDinero, galicia, planes, bancarios, stockFechas, sueldosGal, saldosRows, transfRec, tnNetoRow, efectivoCobrado] = await Promise.all([
    calcularNegocio(sql, mes),
    sql`SELECT ROUND(SUM(monto) FILTER (WHERE entrada))::bigint AS entradas,
               ROUND(SUM(monto) FILTER (WHERE NOT entrada))::bigint AS salidas
        FROM egresos_mp WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT ROUND(COALESCE(SUM(monto), 0))::bigint AS t FROM egresos_mp
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND entrada AND (contraparte ILIKE '%dlocal%' OR detalle ILIKE '%dlocal%')`,
    sql`SELECT ROUND(COALESCE(SUM(monto) FILTER (WHERE entrada AND detalle ILIKE 'Liquidaci%'), 0))::bigint AS liq
        FROM egresos_mp WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT ROUND(COALESCE(SUM(monto), 0))::bigint AS delta,
               ROUND(COALESCE(SUM(monto) FILTER (WHERE monto > 0), 0))::bigint AS entradas,
               ROUND(COALESCE(SUM(-monto) FILTER (WHERE monto < 0), 0))::bigint AS salidas
        FROM movimientos_banco WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT ROUND(COALESCE(SUM(-monto), 0))::bigint AS t FROM movimientos_banco
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND monto < 0
          AND descripcion ILIKE 'Deb. Autom%' AND contraparte ILIKE '%AFIP%'`,
    sql`SELECT ROUND(COALESCE(SUM(-monto), 0))::bigint AS t FROM movimientos_banco
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND monto < 0
          AND categoria IN ('Impuestos y sellos bancarios', 'Gastos bancarios', 'Comisiones de tarjeta')`,
    sql`SELECT MIN(fecha)::text AS f1, MAX(fecha)::text AS f2 FROM stock
        WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT ROUND(COALESCE(SUM(-monto), 0))::bigint AS t FROM movimientos_banco
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND monto < 0 AND categoria = 'Sueldos'`,
    // Saldos al cierre del mes (los captura la carga de cada extracto)
    sql`SELECT DISTINCT ON (cuenta) cuenta, fecha::text, saldo::numeric FROM saldos_cuenta
        WHERE fecha <= ${hasta} ORDER BY cuenta, fecha DESC`,
    sql`SELECT ROUND(COALESCE(SUM(monto), 0))::bigint AS t FROM egresos_mp
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND entrada AND detalle ILIKE 'Transferencia recibida%'`,
    sql`SELECT neto::numeric FROM mix_pagos WHERE mes = ${mes} AND local = 'Tiendanube'`,
    sql`SELECT ROUND(COALESCE(SUM(monto), 0))::bigint AS t FROM cobros
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND medio = 'efectivo' AND local <> 'Tiendanube'`,
  ]);

  // Δ stock a costo (si el mes tiene fotos al principio y al final)
  let deltaStock = null;
  const sf = stockFechas[0];
  if (sf.f1 && sf.f2 && sf.f1 !== sf.f2 && sf.f1 <= `${mes}-03`) {
    const valorEn = async f => Number((await sql`
      SELECT ROUND(SUM(s.cantidad * (COALESCE(c.costo, 0) + COALESCE(c.estampa, 0))))::bigint AS t
      FROM stock s LEFT JOIN LATERAL (
        SELECT costo, estampa FROM costos_producto cp WHERE cp.producto = s.producto_norm
        ORDER BY vigente_desde DESC LIMIT 1) c ON true
      WHERE s.fecha = ${f} AND s.local <> 'Tiendanube'`)[0].t || 0);
    deltaStock = (await valorEn(sf.f2)) - (await valorEn(sf.f1));
  }

  const fz = finanzas && !finanzas.error ? finanzas : null;

  // Rendición de efectivo por local: cobrado (nuestros cobros, desde junio que se
  // mide el medio de pago) vs. rendido a la caja central (categorías "Local X" de
  // Finanzas, sumando cada mes hasta el elegido). La diferencia es el efectivo que
  // está en el local: pagando gastos ahí o esperando rendirse.
  const rendidoPorLocal = {};
  {
    const mesesRend = [];
    for (let d = new Date(Date.UTC(2026, 5, 15)); d.toISOString().slice(0, 7) <= mes; d.setUTCMonth(d.getUTCMonth() + 1)) {
      mesesRend.push([d.getUTCMonth() + 1, d.getUTCFullYear()]);
    }
    for (const [m2, a2] of mesesRend) {
      let dash = (m2 === nroMes && a2 === anio) ? fz : null;
      for (let intento = 1; intento <= 2 && !dash; intento++) {
        try {
          const r2 = await fetch(`${process.env.APPS_SCRIPT_URL}?action=getDashboard&params=${encodeURIComponent(JSON.stringify({ mes: m2, anio: a2 }))}`,
            { redirect: "follow", signal: AbortSignal.timeout(30000) });
          dash = await r2.json();
        } catch (e) { console.error("[flujo] rendiciones:", e.message); }
      }
      for (const [k, v] of Object.entries(dash?.porCatIngreso || {})) {
        const kk = k.toLowerCase();
        if (kk.startsWith("local ") || kk.includes("córdoba") || kk.includes("cordoba")) {
          const nombre = k.replace(/^local /i, "").trim();
          rendidoPorLocal[nombre] = (rendidoPorLocal[nombre] || 0) + Number(v);
        }
      }
    }
  }
  const [cobradoRows, declaradoRows] = await Promise.all([
    sql`SELECT local, ROUND(SUM(monto))::bigint AS t FROM cobros
        WHERE medio = 'efectivo' AND local <> 'Tiendanube' AND fecha BETWEEN '2026-06-01' AND ${hasta}
        GROUP BY local`,
    sql`SELECT DISTINCT ON (local) local, fecha::text, saldo::numeric FROM efectivo_locales
        ORDER BY local, fecha DESC`,
  ]);
  const rendiciones = ["Palermo", "La Plata", "Dot", "Abasto", "Córdoba"].map(local => {
    const cobrado = Number(cobradoRows.find(r => r.local === local)?.t || 0);
    const rendido = Math.round(rendidoPorLocal[local] || 0);
    const dec = declaradoRows.find(r => r.local === local);
    return {
      local, cobrado, rendido, pendiente: cobrado - rendido,
      declarado: dec ? Number(dec.saldo) : null, declarado_fecha: dec?.fecha || null,
    };
  });
  const retirosCaja = Number(fz?.porCatGasto?.["Retiros Socios"] || 0);
  const ingresoDineroCaja = Number(fz?.porCatIngreso?.["Ingreso de dinero"] || 0);
  // Hacerse de efectivo cuesta ~10%: por cada $90 que entran a caja salieron $100
  const costoEfectivo = ingresoDineroCaja > 0 ? Math.round(ingresoDineroCaja / 0.9 * 0.1) : 0;

  const t = negocio.total || {};
  const impuestosDevengados = Math.round((t.detalle_impuestos?.iva || 0) + (t.detalle_impuestos?.cargas_sociales || 0));
  const deltaMP = Number(mpFlujo[0].entradas || 0) - Number(mpFlujo[0].salidas || 0);
  const deltaGalicia = Number(galicia[0].delta || 0);
  const deltaCaja = fz ? Number(fz.neto || 0) : null;
  const sinEntradasMP = !Number(mpFlujo[0].entradas);

  // Puente: resultado → dónde quedó
  const lineas = [
    { clave: "resultado", label: "Resultado operativo del mes", monto: Math.round(t.resultado || 0) },
    { clave: "imp_dev", label: "Impuestos del mes que se pagan el mes siguiente (IVA + cargas)", monto: impuestosDevengados },
    { clave: "retiros", label: "Retiros de socios (caja efectivo)", monto: -retirosCaja },
    { clave: "planes", label: "Pagos de deuda vieja AFIP (planes)", monto: -Number(planes[0].t || 0) },
    { clave: "costo_efec", label: "Costo de hacerse de efectivo (~10%)", monto: -costoEfectivo },
    { clave: "bancarios", label: "Costos bancarios e imp. al débito (no están en el resultado)", monto: -Number(bancarios[0].t || 0) },
  ];
  if (deltaStock != null) lineas.push({ clave: "stock", label: "Plata que se volvió stock (Δ inventario a costo)", monto: -deltaStock });
  // Venta online que PagoNube todavía no liquidó: neta de comisión, menos lo que ya
  // entró vía dLocal y las transferencias directas de clientes
  const tnNeto = Number(tnNetoRow[0]?.neto || 0);
  const enTransito = Math.max(0, Math.round(tnNeto - Number(dlocal[0].t || 0) - Number(transfRec[0].t || 0)));
  if (enTransito > 0) lineas.push({ clave: "transito", label: "Venta de la tienda aún no liquidada por PagoNube (llega el mes siguiente)", monto: -enTransito });
  const esperado = lineas.reduce((a, l) => a + l.monto, 0);
  const observado = (deltaCaja ?? 0) + deltaMP + deltaGalicia;
  const sinUbicar = esperado - observado;

  const saldos = Object.fromEntries(saldosRows.map(r => [r.cuenta, { fecha: r.fecha, saldo: Number(r.saldo) }]));
  return res.status(200).json({
    ok: true, mes,
    saldos_cierre: {
      mp: saldos.mp || null,
      galicia: saldos.galicia || null,
      efectivo: fz ? { saldo: Number(fz.saldoActual || 0), nota: "saldo actual (vivo)" } : null,
      en_transito_tienda: enTransito,
    },
    rendiciones,
    efectivo_cruce: {
      cobrado_locales: Number(efectivoCobrado[0].t || 0),
      rendido_a_caja: fz ? Object.entries(fz.porCatIngreso || {})
        .filter(([k]) => k.toLowerCase().startsWith("local"))
        .reduce((a, [, v]) => a + Number(v), 0) : null,
    },
    cajas: {
      mp: { entradas: Number(mpFlujo[0].entradas || 0), salidas: Number(mpFlujo[0].salidas || 0), delta: deltaMP,
            liquidaciones_point: Number(ingresoDinero[0].liq || 0), dlocal: Number(dlocal[0].t || 0), sin_entradas: sinEntradasMP },
      galicia: { entradas: Number(galicia[0].entradas || 0), salidas: Number(galicia[0].salidas || 0), delta: deltaGalicia },
      efectivo: fz ? { ingresos: Number(fz.totalIngreso || 0), gastos: Number(fz.totalGasto || 0), delta: Number(fz.neto || 0),
                       saldo_actual: Number(fz.saldoActual || 0),
                       por_categoria_gasto: fz.porCatGasto || {}, por_categoria_ingreso: fz.porCatIngreso || {} } : null,
    },
    puente: { lineas, esperado, observado, sin_ubicar: sinUbicar, delta_stock: deltaStock,
              nota_stock: deltaStock == null ? "sin fotos de inventario al inicio del mes (disponible desde agosto)" : null },
    sueldos_galicia: Number(sueldosGal[0].t || 0),
  });
}

// Efectivo físico contado en un local (lo informan los socios; se compara
// contra el pendiente de rendición)
async function guardarEfectivoLocal(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { local, saldo } = req.body || {};
  if (!local || !(Number(saldo) >= 0)) return res.status(400).json({ error: "local y saldo requeridos" });
  const sql = neon(process.env.DATABASE_URL);
  const sesion = verificarToken(req.headers["x-tussy-auth"]);
  const hoy = hoyArg();
  await sql`INSERT INTO efectivo_locales (local, fecha, saldo, declarado_por)
    VALUES (${local}, ${hoy}, ${Number(saldo)}, ${sesion?.nombre || null})
    ON CONFLICT (local, fecha) DO UPDATE SET saldo = ${Number(saldo)}, declarado_por = ${sesion?.nombre || null}`;
  return res.status(200).json({ ok: true });
}

// ── Completitud: qué datos tiene un mes y hasta qué día llega cada fuente ──
// Responde la pregunta "¿puedo confiar en los números de este mes?" fuente por
// fuente: ventas por local, reportes de MP/TN, extractos, comprobantes y fijos.
async function completitud(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes : hoyArg().slice(0, 7);
  const [y, m] = mes.split("-").map(Number);
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const desde = `${mes}-01`;
  const hasta = `${mes}-${String(ultimoDia).padStart(2, "0")}`;
  const hoy = hoyArg();
  const cerrado = mes < hoy.slice(0, 7);
  // Para el mes en curso, lo esperable es tener datos hasta ayer
  const esperadoHasta = cerrado ? hasta : (hoy.slice(0, 7) === mes ? hoy : hasta);
  const dd = f => f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : null;

  const [syncErrores, mixRows, elecRows, egresosMax, bancoMax, recibidosMax, emitidosMax, fijosMes, ipcRow] = await Promise.all([
    sql`SELECT local, COUNT(*)::int n FROM sync_estado
        WHERE fecha BETWEEN ${desde} AND ${hasta} AND estado = 'error'
          AND local <> 'ARCA' GROUP BY local`,
    sql`SELECT local, bruto FROM mix_pagos WHERE mes = ${mes}`,
    sql`SELECT local, ROUND(SUM(monto) FILTER (WHERE medio = 'electronico'))::bigint elec
        FROM cobros WHERE fecha BETWEEN ${desde} AND ${hasta} GROUP BY local`,
    sql`SELECT MAX(fecha)::text u FROM egresos_mp WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT MAX(fecha)::text u FROM movimientos_banco WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT MAX(fecha)::text u FROM comprobantes_recibidos WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    sql`SELECT MAX(fecha)::text u FROM comprobantes_emitidos WHERE fecha BETWEEN ${desde} AND ${hasta}`,
    leerGastosFijos(sql, mes),
    sql`SELECT pct FROM ipc_mes WHERE mes = ${mes}`,
  ]);
  const [arcaSyncEstado] = await sql`SELECT estado, ultimo_error, actualizado_en::text act
    FROM sync_estado WHERE local = 'ARCA' ORDER BY fecha DESC LIMIT 1`;

  const items = [];

  // 1) Ventas: la ingesta marca en sync_estado los días que fallaron y no se pudieron
  // recuperar. Un día sin ventas puede ser un local cerrado (domingos): no es un hueco.
  const errores = syncErrores.map(e => `${e.local}: ${e.n} día(s) con error de ingesta`);
  items.push({
    clave: "ventas", label: "Ventas (ingesta automática)",
    estado: errores.length ? "parcial" : "ok",
    detalle: errores.length ? errores.join(" · ") : "sin días con error",
  });

  // 2) Reporte de ventas MP (costo financiero locales): cobertura vs. lo electrónico real
  const mixLocales = mixRows.filter(r => r.local !== "Tiendanube");
  if (!mixLocales.length) {
    items.push({ clave: "mix_mp", label: "Reporte de ventas MercadoPago", estado: "falta",
      detalle: "sin cargar — el costo financiero de los locales queda en $0" });
  } else {
    const brutoMix = mixLocales.reduce((a, r) => a + Number(r.bruto), 0);
    const elecLoc = elecRows.filter(r => r.local !== "Tiendanube").reduce((a, r) => a + Number(r.elec || 0), 0);
    const cobertura = elecLoc > 0 ? brutoMix / elecLoc : 1;
    items.push({
      clave: "mix_mp", label: "Reporte de ventas MercadoPago",
      estado: cobertura < 0.97 ? "parcial" : "ok",
      detalle: cobertura < 0.97
        ? `cubre el ${Math.round(cobertura * 100)}% de lo electrónico: probablemente le falten los últimos días — re-exportalo con el mes completo`
        : `cubre el ${Math.round(cobertura * 100)}% de lo cobrado electrónico`,
    });
  }

  // 3) Reporte de Tiendanube (costo financiero online)
  const mixTN = mixRows.find(r => r.local === "Tiendanube");
  const elecTN = Number(elecRows.find(r => r.local === "Tiendanube")?.elec || 0);
  if (!mixTN) {
    items.push({ clave: "mix_tn", label: "Reporte de Tiendanube", estado: "falta",
      detalle: "sin cargar — el costo financiero online usa el estimado" });
  } else {
    const cob = elecTN > 0 ? Number(mixTN.bruto) / elecTN : 1;
    items.push({ clave: "mix_tn", label: "Reporte de Tiendanube",
      estado: cob < 0.97 ? "parcial" : "ok",
      detalle: cob < 0.97 ? `cubre el ${Math.round(cob * 100)}% de la venta online: re-exportalo con el mes completo` : `cubre el ${Math.round(cob * 100)}% de la venta online` });
  }

  // 4..7) Fuentes con "cargado hasta el día X"
  const porFecha = [
    ["egresos_mp", "Estado de cuenta MercadoPago", egresosMax[0]?.u],
    ["banco", "Extracto Galicia", bancoMax[0]?.u],
    ["recibidos", "Compras ARCA (recibidos)", recibidosMax[0]?.u],
    ["emitidos", "Facturación ARCA (emitidos)", emitidosMax[0]?.u],
  ];
  for (const [clave, label, u] of porFecha) {
    // Los emitidos los trae el web service solo: si el barrido viene fallando, el
    // hueco no se tapa cargando un archivo y hay que decir por qué.
    if (clave === "emitidos" && arcaSyncEstado?.estado === "error") {
      items.push({ clave, label, estado: "falta",
        detalle: `el web service de ARCA está fallando: ${arcaSyncEstado.ultimo_error}` });
      continue;
    }
    if (!u) {
      items.push({ clave, label, estado: "falta", detalle: "sin datos este mes" });
    } else if (u < esperadoHasta) {
      const [uy, um, ud] = u.split("-").map(Number);
      const sig = new Date(Date.UTC(uy, um - 1, ud + 1)).toISOString().slice(0, 10);
      const queFalta = sig === esperadoHasta ? `el ${dd(sig)}` : `del ${dd(sig)} al ${dd(esperadoHasta)}`;
      items.push({ clave, label, estado: "parcial", detalle: `cargado hasta el ${dd(u)} — falta ${queFalta}` });
    } else {
      items.push({ clave, label, estado: "ok", detalle: `hasta el ${dd(u)}` });
    }
  }

  // 8) Costos fijos
  const hayFijos = Object.keys(fijosMes).some(k => !k.startsWith("__"));
  const estimados = Object.values(fijosMes).some(v => v.estimado);
  items.push({ clave: "fijos", label: "Costos fijos",
    estado: hayFijos ? (estimados ? "parcial" : "ok") : "falta",
    detalle: hayFijos ? (estimados ? "estimados por inflación — cargá los reales en Fijos" : "cargados") : "sin cargar" });

  // 9) IPC del mes (para la venta a pesos constantes)
  items.push({ clave: "ipc", label: "IPC del mes (INDEC)",
    estado: ipcRow.length ? "ok" : "parcial",
    detalle: ipcRow.length ? `${Number(ipcRow[0].pct)}%` : "aún no publicado — la venta real queda nominal" });

  // Confirmaciones manuales: cuando una fuente figura incompleta pero el dato es
  // correcto (ej. el banco no tuvo movimientos los últimos días del mes), un socio
  // puede darla por completa a mano. Queda registrado quién.
  const overrides = await sql`SELECT clave, confirmado_por FROM completitud_ok WHERE mes = ${mes}`;
  for (const it of items) {
    const ov = overrides.find(o => o.clave === it.clave);
    if (ov && it.estado !== "ok") {
      it.estado = "ok";
      it.confirmado = true;
      it.detalle = `${it.detalle} · dado por completo${ov.confirmado_por ? ` por ${ov.confirmado_por}` : ""}`;
    }
  }

  const faltantes = items.filter(i => i.estado !== "ok").length;
  return res.status(200).json({ ok: true, mes, cerrado, items, completos: items.length - faltantes, total: items.length });
}

// Marcar (o desmarcar) una fuente del mes como completa a mano
async function confirmarCompletitud(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { mes, clave, valor } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(mes || "") || !clave) return res.status(400).json({ error: "mes y clave requeridos" });
  const sql = neon(process.env.DATABASE_URL);
  if (valor === false) {
    await sql`DELETE FROM completitud_ok WHERE mes = ${mes} AND clave = ${clave}`;
  } else {
    const sesion = verificarToken(req.headers["x-tussy-auth"]);
    await sql`INSERT INTO completitud_ok (mes, clave, confirmado_por) VALUES (${mes}, ${clave}, ${sesion?.nombre || null})
      ON CONFLICT (mes, clave) DO NOTHING`;
  }
  return res.status(200).json({ ok: true });
}

// Tablero: posición de IVA, cruce vendido vs facturado, gastos por rubro y conciliación
async function contabilidad(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes : hoyArg().slice(0, 7);
  const desde = `${mes}-01`;
  const [anioMes, nroMes] = mes.split("-").map(Number);
  const hasta = `${mes}-${String(new Date(Date.UTC(anioMes, nroMes, 0)).getUTCDate()).padStart(2, "0")}`;

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
  // Liquidación de la contadora: posición declarada (F.2051) y pago real.
  // Cuando está cargada, ese es el número oficial del mes.
  const declaradosRows = await sql`SELECT mes, concepto, monto::numeric FROM impuestos_mes
    WHERE concepto IN ('iva', 'iva_pagado')`;
  const declaradoDe = (m, c) => {
    const r = declaradosRows.find(x => x.mes === m && x.concepto === c);
    return r ? Number(r.monto) : null;
  };

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

  // Control de facturación por local. Cada uno factura una porción distinta de lo que
  // vende (online factura todo; los locales, según su operatoria), así que en vez de
  // una regla teórica se compara cada local contra SU PROPIO ratio del mes anterior:
  // lo que hay que detectar es un cambio de comportamiento, no el nivel absoluto.
  const mesPrev = (() => {
    const [y, m] = mes.split("-").map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  })();
  // Pagos electrónicos (tarjeta/QR) según lo que registra cada sistema de venta.
  // Es la base contra la que se compara la facturación: lo electrónico se factura.
  // ARCA impacta 24-48 h después, así que la comparación del último día siempre
  // va a mostrar un desfasaje que se acomoda solo.
  const electronico = await sql`
    SELECT local,
           ROUND(SUM(monto) FILTER (WHERE medio = 'electronico'))::bigint AS electronico,
           ROUND(SUM(monto) FILTER (WHERE medio = 'efectivo'))::bigint AS efectivo,
           ROUND(SUM(monto))::bigint AS cobrado
    FROM cobros WHERE fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY 1`;
  const porLocalElec = Object.fromEntries(electronico.map(r => [r.local, r]));

  const facturacionLocal = await sql`
    WITH v AS (
      SELECT local, to_char(fecha, 'YYYY-MM') AS mes, ROUND(SUM(total))::bigint AS venta
      FROM ventas WHERE to_char(fecha, 'YYYY-MM') IN (${mes}, ${mesPrev}) GROUP BY 1, 2
    ), p AS (
      SELECT local, mes, ROUND(SUM(bruto))::bigint AS point
      FROM mix_pagos WHERE mes IN (${mes}, ${mesPrev}) GROUP BY 1, 2
    ), f AS (
      SELECT punto_venta, to_char(fecha, 'YYYY-MM') AS mes,
             ROUND(SUM(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint AS facturado
      FROM comprobantes_emitidos WHERE to_char(fecha, 'YYYY-MM') IN (${mes}, ${mesPrev}) GROUP BY 1, 2
    ), pv (punto_venta, local) AS (
      VALUES (33, 'Tiendanube'), (1901, 'Palermo'), (1902, 'La Plata'),
             (1904, 'Dot'), (1905, 'Abasto'), (1401, 'Córdoba')
    )
    SELECT pv.local, pv.punto_venta,
           COALESCE(vh.venta, 0) AS venta, COALESCE(ph.point, 0) AS point, COALESCE(fh.facturado, 0) AS facturado,
           COALESCE(va.venta, 0) AS venta_prev, COALESCE(fa.facturado, 0) AS facturado_prev
    FROM pv
    LEFT JOIN v vh ON vh.local = pv.local AND vh.mes = ${mes}
    LEFT JOIN p ph ON ph.local = pv.local AND ph.mes = ${mes}
    LEFT JOIN f fh ON fh.punto_venta = pv.punto_venta AND fh.mes = ${mes}
    LEFT JOIN v va ON va.local = pv.local AND va.mes = ${mesPrev}
    LEFT JOIN f fa ON fa.punto_venta = pv.punto_venta AND fa.mes = ${mesPrev}
    ORDER BY COALESCE(vh.venta, 0) DESC`;

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
  // Los nombres difieren entre el estado de cuenta y ARCA ("FABRIKA SA" vs
  // "FABRIKA S.A.", apellido/nombre invertidos, Ñ perdida, truncados), así que el
  // match es por palabras normalizadas; si no hay match de nombre, se busca una
  // factura por el monto exacto (pagos hechos a nombre de un tercero).
  // Se devuelve adem\u00e1s el detalle: cada transferencia con su n\u00famero de operaci\u00f3n de
  // MercadoPago (con ese n\u00famero se busca el pago en la app de MP) y cada factura que
  // se le imput\u00f3, para poder rastrear un pago puntual.
  const egresosMes = await sql`
    SELECT id, fecha::text, contraparte, cuit, ROUND(monto)::bigint AS monto, detalle
    FROM egresos_mp WHERE fecha BETWEEN ${desde} AND ${hasta} AND NOT entrada
    ORDER BY fecha DESC, monto DESC`;
  const facturasRows = await sql`
    SELECT upper(COALESCE(emisor, '')) AS nombre, fecha::text, tipo, punto_venta,
           numero, cuit_emisor, ROUND(total)::bigint AS total
    FROM comprobantes_recibidos
    WHERE fecha BETWEEN ${desde}::date - 20 AND ${hasta}::date + 20
    ORDER BY fecha`;

  const SUFIJOS = new Set(["SA", "SRL", "SAS", "SACI", "SAU", "SCA", "SH", "SOCIEDAD", "ANONIMA", "RESPONSABILIDAD", "LIMITADA"]);
  const tokens = s => new Set(String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
    .filter(w => w.length > 1 && !SUFIJOS.has(w)));

  // El rubro asignado al proveedor en Gastos manda sobre la categor\u00eda gen\u00e9rica:
  // una transferencia a IRSA es "Alquileres", no "Proveedores". Se matchea por
  // CUIT cuando est\u00e1, y si no por nombre con la misma regla que la conciliaci\u00f3n.
  const provRubro = (await sql`SELECT cuit, nombre, rubro FROM proveedores WHERE rubro <> 'Sin rubro'`)
    .map(p => ({ cuit: Number(p.cuit), rubro: p.rubro, toks: tokens(p.nombre) }));
  const rubroDe = (nombre, cuit) => {
    if (cuit) {
      const p = provRubro.find(x => x.cuit === Number(cuit));
      if (p) return p.rubro;
    }
    const toks = tokens(nombre);
    if (!toks.size) return null;
    for (const p of provRubro) {
      let inter = 0;
      for (const w of toks) if (p.toks.has(w)) inter++;
      if (inter >= 2 || (inter >= 1 && inter >= Math.min(toks.size, p.toks.size))) return p.rubro;
    }
    return null;
  };
  const GENERICAS = new Set(["Proveedores", "Otros", "D\u00e9bitos autom\u00e1ticos", "Cheques a proveedores"]);
  const refinar = (categoria, contraparte, cuit) =>
    GENERICAS.has(categoria) ? (rubroDe(contraparte, cuit) || categoria) : categoria;

  const porEmisor = new Map();
  for (const f of facturasRows) {
    const signo = [3, 8, 13].includes(f.tipo) ? -1 : 1;
    if (!porEmisor.has(f.nombre)) {
      porEmisor.set(f.nombre, { facturado: 0, toks: tokens(f.nombre), comprobantes: [] });
    }
    const g = porEmisor.get(f.nombre);
    g.facturado += signo * Number(f.total);
    g.comprobantes.push({
      fecha: f.fecha, tipo: f.tipo, punto_venta: f.punto_venta, numero: Number(f.numero),
      emisor: f.nombre, cuit: Number(f.cuit_emisor), total: signo * Number(f.total),
    });
  }
  const emisores = [...porEmisor.values()];

  const porContraparte = new Map();
  for (const m of egresosMes) {
    if (!/^Transferencia enviada/i.test(m.detalle || "") || !m.contraparte) continue;
    const nombre = m.contraparte.trim().toUpperCase();
    if (!porContraparte.has(nombre)) porContraparte.set(nombre, { nombre, cuit: null, transferido: 0, movimientos: [] });
    const g = porContraparte.get(nombre);
    g.cuit = g.cuit || (m.cuit ? Number(m.cuit) : null);
    g.transferido += Number(m.monto);
    g.movimientos.push({ id: m.id, fecha: m.fecha, monto: Number(m.monto) });
  }

  const conciliacion = [...porContraparte.values()].map(t => {
    const toks = tokens(t.nombre);
    let facturado = 0, comprobantes = [], matchNombre = false;
    for (const e of emisores) {
      let inter = 0;
      for (const w of toks) if (e.toks.has(w)) inter++;
      if (inter >= 2 || (inter >= 1 && inter >= Math.min(toks.size, e.toks.size))) {
        facturado += e.facturado;
        comprobantes = comprobantes.concat(e.comprobantes);
        matchNombre = true;
      }
    }
    let porMonto = false;
    if (!matchNombre) {
      for (const e of emisores) {
        const c = e.comprobantes.find(x => Math.abs(x.total - t.transferido) <= t.transferido * 0.005);
        if (c) { facturado = t.transferido; comprobantes = [c]; porMonto = true; break; }
      }
    }
    // La plata que va a la propia cuenta bancaria no es un gasto: es un movimiento
    // interno. No lleva factura y no puede contarse como pago sin respaldo.
    const cuentaPropia = esCuentaPropia(t.nombre, null);
    return {
      nombre: t.nombre, transferido: t.transferido, transferencias: t.movimientos.length,
      rubro: rubroDe(t.nombre, t.cuit),
      facturado, porMonto, cuentaPropia, movimientos: t.movimientos,
      comprobantes: comprobantes.sort((a, b) => a.fecha.localeCompare(b.fecha)),
    };
  }).sort((a, b) => b.transferido - a.transferido);

  // ── Flujo de fondos: qué entró a la cuenta bancaria y en qué se gastó ──
  // Cierra el circuito: cobranzas → MercadoPago → transferencia a cuenta propia →
  // desde el banco se pagan sueldos, AFIP, echeqs y proveedores.
  const bancoCategorias = await sql`
    SELECT categoria,
           ROUND(SUM(CASE WHEN monto > 0 THEN monto ELSE 0 END))::bigint AS ingresos,
           ROUND(SUM(CASE WHEN monto < 0 THEN -monto ELSE 0 END))::bigint AS egresos,
           COUNT(*)::int AS movimientos
    FROM movimientos_banco WHERE fecha BETWEEN ${desde} AND ${hasta}
    GROUP BY 1 ORDER BY 2 DESC, 3 DESC`;
  const bancoMovs = await sql`
    SELECT id, fecha::text, descripcion, contraparte, cuit, ROUND(monto)::bigint AS monto, categoria
    FROM movimientos_banco WHERE fecha BETWEEN ${desde} AND ${hasta}
    ORDER BY fecha DESC, abs(monto) DESC`;
  const [bancoTot] = await sql`
    SELECT ROUND(COALESCE(SUM(CASE WHEN monto > 0 THEN monto ELSE 0 END), 0))::bigint AS ingresos,
           ROUND(COALESCE(SUM(CASE WHEN monto < 0 THEN -monto ELSE 0 END), 0))::bigint AS egresos,
           ROUND(COALESCE(SUM(CASE WHEN monto > 0 AND categoria = ${CATEGORIA_PROPIA} THEN monto ELSE 0 END), 0))::bigint AS desde_mp
    FROM movimientos_banco WHERE fecha BETWEEN ${desde} AND ${hasta}`;

  // Egresos de TODAS las cuentas en una sola vista, con las mismas categorías, para
  // poder controlar el gasto de forma integral. Las transferencias a cuenta propia
  // se separan: no son gasto, y sumarlas contaría dos veces lo que después paga el banco.
  const porCategoria = new Map();
  const sumar = (categoria, mov) => {
    if (!porCategoria.has(categoria)) porCategoria.set(categoria, { categoria, total: 0, movimientos: [] });
    const g = porCategoria.get(categoria);
    g.total += mov.monto;
    g.movimientos.push(mov);
  };
  for (const m of egresosMes) {
    const categoria = refinar(categorizar(m.detalle, m.contraparte, m.cuit), m.contraparte, m.cuit);
    sumar(categoria, {
      id: m.id, fecha: m.fecha, origen: "MercadoPago",
      descripcion: m.detalle, contraparte: m.contraparte, monto: Number(m.monto),
    });
  }
  for (const m of bancoMovs) {
    if (Number(m.monto) >= 0) continue; // los ingresos del banco no son gasto
    sumar(refinar(m.categoria, m.contraparte, m.cuit), {
      id: m.id, fecha: m.fecha, origen: "Galicia",
      descripcion: m.descripcion, contraparte: m.contraparte, monto: -Number(m.monto),
    });
  }
  const egresosCategorias = [...porCategoria.values()]
    .map(g => ({ ...g, movimientos: g.movimientos.sort((a, b) => b.monto - a.monto) }))
    .sort((a, b) => b.total - a.total);
  const egresosPropios = porCategoria.get(CATEGORIA_PROPIA)?.total || 0;
  const egresosTotal = egresosCategorias.reduce((a, g) => a + g.total, 0) - egresosPropios;

  const [estado] = await sql`
    SELECT (SELECT COUNT(*) FROM comprobantes_emitidos)::int AS emitidos,
           (SELECT COUNT(*) FROM comprobantes_recibidos)::int AS recibidos,
           (SELECT MAX(cargado_en) FROM comprobantes_recibidos)::text AS ultima_carga_recibidos,
           (SELECT COALESCE(SUM(ultimo), 0) FROM arca_cursor)::bigint AS cursor_ws`;

  return res.status(200).json({
    ok: true, mes,
    arca: arcaConfigurada(),
    iva: iva.map(r => ({
      ...r, debito: Number(r.debito), credito: Number(r.credito),
      posicion: Number(r.debito) - Number(r.credito),
      facturado: Number(r.facturado), compras: Number(r.compras),
      declarado: declaradoDe(r.mes, "iva"),
      pagado: declaradoDe(r.mes, "iva_pagado"),
    })),
    cruce: cruce.map(r => ({ ...r, venta: Number(r.venta), facturado: Number(r.facturado) })),
    mesPrev,
    facturacionLocal: facturacionLocal.map(r => {
      const e = porLocalElec[r.local];
      const elec = e ? Number(e.electronico || 0) : null;
      return {
        local: r.local, punto_venta: r.punto_venta,
        venta: Number(r.venta), point: Number(r.point), facturado: Number(r.facturado),
        electronico: elec, efectivo: e ? Number(e.efectivo || 0) : null,
        ratio: Number(r.venta) ? Number(r.facturado) / Number(r.venta) : null,
        ratioPrev: Number(r.venta_prev) ? Number(r.facturado_prev) / Number(r.venta_prev) : null,
        // Lo que de verdad hay que controlar: electrónico vs facturado
        ratioElec: elec ? Number(r.facturado) / elec : null,
      };
    }),
    porPV: porPV.map(r => ({ ...r, total: Number(r.total) })),
    pvLocales,
    rubros: rubros.map(r => ({ ...r, total: Number(r.total) })),
    proveedores: provs.map(r => ({ ...r, cuit: Number(r.cuit), total: Number(r.total), iva: Number(r.iva) })),
    conciliacion,
    egresos: { total: egresosTotal, cuentaPropia: egresosPropios, categorias: egresosCategorias },
    movimientos: egresosMes.map(r => ({ ...r, monto: Number(r.monto) })),
    banco: {
      total: {
        ingresos: Number(bancoTot.ingresos), egresos: Number(bancoTot.egresos),
        desdeMP: Number(bancoTot.desde_mp),
      },
      categorias: bancoCategorias.map(r => ({ ...r, ingresos: Number(r.ingresos), egresos: Number(r.egresos) })),
      movimientos: bancoMovs.map(r => ({ ...r, monto: Number(r.monto), cuit: r.cuit ? Number(r.cuit) : null })),
    },
    estado,
    nombresTipo: NOMBRES_TIPO,
  });
}

// Alta de egresos de MercadoPago (transferencias a proveedores) para conciliar
async function cargarEgresos(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
  const { filas, saldo } = req.body || {};
  if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: "filas requeridas" });
  if (filas.length > 20000) return res.status(400).json({ error: "demasiadas filas en una carga" });
  const sql = neon(process.env.DATABASE_URL);
  if (saldo?.cuenta && saldo?.fecha && saldo?.saldo) {
    await sql`INSERT INTO saldos_cuenta (cuenta, fecha, saldo) VALUES (${saldo.cuenta}, ${saldo.fecha}, ${saldo.saldo})
      ON CONFLICT (cuenta, fecha) DO UPDATE SET saldo = ${saldo.saldo}`;
  }
  const validas = filas.filter(f => f.id && f.fecha && f.monto);
  let nuevas = 0;
  for (let i = 0; i < validas.length; i += 1000) {
    const lote = validas.slice(i, i + 1000);
    const col = fn => lote.map(fn);
    const r = await sql`INSERT INTO egresos_mp (id, fecha, contraparte, cuit, monto, detalle, entrada)
      SELECT * FROM unnest(
        ${col(f => String(f.id))}::text[], ${col(f => f.fecha)}::date[], ${col(f => f.contraparte || null)}::text[],
        ${col(f => f.cuit ?? null)}::bigint[], ${col(f => f.monto)}::numeric[], ${col(f => f.detalle || null)}::text[],
        ${col(f => !!f.entrada)}::boolean[]
      ) AS x(id, fecha, contraparte, cuit, monto, detalle, entrada)
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
    if (action === "completitud") return await completitud(req, res);
    if (action === "confirmarCompletitud") return await confirmarCompletitud(req, res);
    if (action === "facturasRecibidas") return await facturasRecibidas(req, res);
    if (action === "guardarImpuestoMes") return await guardarImpuestoMes(req, res);
    if (action === "flujoMes") return await flujoMes(req, res);
    if (action === "guardarEfectivoLocal") return await guardarEfectivoLocal(req, res);
    if (action === "curvaHoraria") return await curvaHoraria(req, res);
    if (action === "proyeccion") return await proyeccionMes(req, res);
    if (action === "guardarMeta") return await guardarMeta(req, res);
    if (action === "quiebres") return await quiebres(req, res);
    if (action === "clientes") return await clientesOnline(req, res);
    if (action === "cargarComprobantes") return await cargarComprobantes(req, res);
    if (action === "cargarEgresos") return await cargarEgresos(req, res);
    if (action === "cargarBanco") return await cargarBanco(req, res);
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
