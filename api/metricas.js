// Métricas desde Postgres (Neon) — la fuente de verdad nueva.
// GET /api/metricas?action=serie&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
//   → { dias: [{fecha, palermo, laplata, online, dot, abasto, cordoba, total, ops}] }
// GET /api/metricas?action=topProductos&desde=&hasta=&local=(opcional)&limite=20
//   → { productos: [{producto, cantidad, total, ops}] }
// GET /api/metricas?action=sync&desde=&hasta=
//   → { pendientes: [{fecha, local, estado, intentos, ultimo_error}] }
const { neon } = require("@neondatabase/serverless");

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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "DATABASE_URL no configurada" });
  }
  const sql = neon(process.env.DATABASE_URL);
  const { action, desde, hasta, local, limite } = req.query;

  try {
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

    return res.status(400).json({ error: "action inválida (serie | topProductos | categorias | variantes | sync)" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
