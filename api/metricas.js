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

    if (action === "topProductos") {
      if (!desde || !hasta) return res.status(400).json({ error: "Faltan desde/hasta" });
      const lim = Math.min(parseInt(limite || 20), 100);
      const localFiltro = local || null;
      const rows = await sql`
        SELECT producto,
               SUM(cantidad)::int AS cantidad,
               ROUND(SUM(total))::bigint AS total,
               COUNT(DISTINCT orden_id)::int AS ops
        FROM ventas
        WHERE fecha BETWEEN ${desde} AND ${hasta}
          AND producto NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE')
          AND (${localFiltro}::text IS NULL OR local = ${localFiltro})
        GROUP BY producto
        ORDER BY SUM(cantidad) DESC
        LIMIT ${lim}`;
      return res.status(200).json({ productos: rows.map(r => ({ ...r, total: Number(r.total) })) });
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

    return res.status(400).json({ error: "action inválida (serie | topProductos | sync)" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
