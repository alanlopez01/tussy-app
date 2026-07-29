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
const webpush = require("web-push");
const { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFDia } = require("../lib/fuentes");

const KEY_LOCAL = {
  "Palermo": "palermo", "La Plata": "laplata", "Tiendanube": "online",
  "Dot": "dot", "Abasto": "abasto", "Córdoba": "cordoba", "Cordoba": "cordoba",
};

// ── Normalización de productos (portada de Apps Script) ──
// Unifica "REMERA OVERSIZE ECLIPSE, NEGRO" con "REMERA OVERSIZE ECLIPSE".
const CATEGORIAS = ["REMERA","REMERON","POLO","POLERA","PANTALON","PANTALONES","BUZO","CAMPERA",
  "CAMISA","BERMUDA","BERMUDAS","SHORT","SHORTS","VESTIDO","TOP","BOXER","LLAVERO",
  "MUSCULOSA","SWEATER","JEAN","JEANS","CHALECO","CARDIGAN","CHOMBA","BODY",
  "CALZA","CALZAS","FALDA","RIÑONERA","GORRA","MEDIAS","SACO"];
const IGNORAR = new Set([
  "OVERSIZE","TSSY","TSSYA","BOXY","BAGGY","MUJER","HOMBRE","UNISEX",
  "REGULAR","CLASSIC","CLASSICO","CLASICO","PREMIUM","LIMITED","EDITION","EDICION",
  "ALGODON","GABARDINA","TENCEL","LINO","POLIESTER","RUSTICO","RUSTICA","LISO","LISA",
  "SET","LINE","KIT","PACK","COLECCION","FW","SS","SPRING","SUMMER","FALL","WINTER",
  "NUEVO","NUEVA","NEW","XL","NARANJA","VIOLETA","BEIGE","GRIS","NEGRO","NEGRA",
  "BLANCO","BLANCA","AZUL","ROJO","ROJA","VERDE","AMARILLO","CELESTE","HUESO",
  "MARRON","BORDO","ROSA","LAVANDA","MELANGE","TAUPE","OLIVA","PETROLEO",
]);
const CATEGORIAS_SET = new Set(CATEGORIAS);

function normalizarProducto(nombre) {
  if (!nombre) return { nombre: "", categoria: "" };
  const n = String(nombre).replace(/\([^)]*\)/g, " ").toUpperCase()
    .replace(/[ÁÀÄÂ]/g, "A").replace(/[ÉÈËÊ]/g, "E").replace(/[ÍÌÏÎ]/g, "I")
    .replace(/[ÓÒÖÔ]/g, "O").replace(/[ÚÙÜÛ]/g, "U").replace(/Ñ/g, "N")
    .replace(/[-_\/.,;:]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ").trim();

  const palabras = n.split(" ").filter(Boolean);
  let categoria = "";
  for (const p of palabras) {
    if (CATEGORIAS_SET.has(p)) { categoria = p; break; }
  }
  const categoriaSing = categoria.replace(/ES$/, "").replace(/^REMERON$/, "REMERA");

  const modelo = [];
  for (let p of palabras) {
    if (CATEGORIAS_SET.has(p) || IGNORAR.has(p) || p.length < 2) continue;
    if (p.length > 4 && p.endsWith("S") && !p.endsWith("SS") && !p.endsWith("US")) p = p.slice(0, -1);
    modelo.push(p);
  }
  const modeloStr = modelo.join(" ");
  const nombreNorm = categoriaSing && modeloStr ? `${categoriaSing} ${modeloStr}` : (modeloStr || categoriaSing || n);
  return { nombre: nombreNorm, categoria: categoriaSing || "OTROS" };
}

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
      INSERT INTO ventas (fecha, local, sistema, orden_id, hora, producto, sku, color, talle, cantidad, precio_unit, total)
      SELECT * FROM UNNEST(
        ${c.map(f => f.fecha)}::date[], ${c.map(f => f.local)}::text[], ${c.map(f => f.sistema)}::text[],
        ${c.map(f => f.orden_id || null)}::text[], ${c.map(f => f.hora || null)}::text[],
        ${c.map(f => f.producto)}::text[], ${c.map(f => f.sku)}::text[], ${c.map(f => f.color)}::text[],
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
  if (eventos.length > 0 && hora >= 9 && hora < 23 &&
      process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      webpush.setVapidDetails("mailto:alansergio67@gmail.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      const opsUrl = process.env.APPS_SCRIPT_URL_OPERACIONES;
      const subsResp = await fetch(`${opsUrl}?action=getPushSubs&params=%7B%7D`, { redirect: "follow", signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
      const subs = subsResp?.subs || [];
      const fmt = n => "$" + Math.round(n).toLocaleString("es-AR");
      // Muchas ventas juntas (puesta al día) → una sola notificación resumen
      const payloads = eventos.length > 6
        ? [{ title: "Tussy — ventas nuevas", body: `${eventos.length} ventas · ${fmt(eventos.reduce((a, e) => a + e.total, 0))}`, url: "/pedidos" }]
        : eventos.map(e => ({
            title: `Venta ${e.local === "Tiendanube" ? "Online" : e.local}`,
            body: `${fmt(e.total)} · ${e.unidades} ${e.unidades === 1 ? "unidad" : "unidades"}${e.hora ? " · " + e.hora : ""}`,
            url: "/pedidos",
          }));
      for (const sub of subs) {
        for (const p of payloads) {
          try { await webpush.sendNotification(sub.subscription, JSON.stringify(p)); notificadas++; } catch {}
        }
      }
    } catch {}
  }

  return res.status(200).json({ ok: true, fecha: hoy, resumen, eventos: eventos.length, notificadas });
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
           (ARRAY_AGG(producto ORDER BY total DESC) FILTER (WHERE producto NOT IN ('ENVIO','DESCUENTO','AJUSTE')))[1:3] AS productos
    FROM ventas
    WHERE fecha = ${hoy} AND orden_id IS NOT NULL
    GROUP BY fecha, local, orden_id
    ORDER BY MAX(hora) DESC NULLS LAST
    LIMIT ${lim}`;
  return res.status(200).json({
    fecha: hoy,
    operaciones: rows.map(r => ({ ...r, total: Number(r.total), productos: r.productos || [] })),
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
