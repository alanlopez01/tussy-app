// Ventas del día en vivo, por local, agrupadas por operación.
// GET /api/ventas-live?local=palermo|laplata|online|dot|abasto|cordoba[&fecha=YYYY-MM-DD]
//   → { ok, local, fecha, total, ops, operaciones: [{orden_id, hora, total, unidades, items:[...]}] }
const { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFDia } = require("../lib/fuentes");

function hoyArg() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const local = String(req.query.local || "").toLowerCase();
  const fecha = req.query.fecha || hoyArg();

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

  // Agrupar líneas por operación
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
};
