// Webhook del Tussy ERP: asistencias que marcan los encargados en cada local.
//
// El ERP empuja un POST por marca (o un lote). Mismo secreto compartido que el
// webhook de ventas. El empleado se matchea por nombre + local (insensible a
// mayúsculas); si no existe se crea con origen 'erp' para no perder la marca y
// que Alan lo complete después desde RRHH → Legajos.
//
// POST /api/tussy-erp/rrhh  ·  header x-tussy-erp-secret
// { "evento": "asistencia", "fecha": "2026-09-08", "local": "Palermo",
//   "empleado": "Bruni Sanabria", "estado": "tarde", "minutos_tarde": 20,
//   "motivo": null, "marcado_por": "encargado palermo" }
// o lote: { "evento": "asistencia", "asistencias": [ {fecha, local, empleado, estado, ...}, ... ] }
// Idempotente: una marca por (empleado, fecha); la última pisa a la anterior.
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);
const ESTADOS = ["presente", "tarde", "ausente", "franco", "vacaciones"];

async function procesarMarca(m) {
  const fecha = String(m.fecha || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: "fecha inválida" };
  const estado = String(m.estado || "").toLowerCase();
  if (!ESTADOS.includes(estado)) return { error: `estado inválido: ${m.estado}` };
  const nombre = String(m.empleado || "").trim();
  const local = String(m.local || "").trim();
  if (!nombre || !local) return { error: "faltan empleado o local" };

  let [emp] = await sql`
    SELECT id FROM empleados
    WHERE lower(nombre) = lower(${nombre}) AND lower(local) = lower(${local})
    LIMIT 1`;
  let creado = false;
  if (!emp) {
    // Nombre nuevo: puede ser un empleado que Alan todavía no cargó — se crea
    // para no perder la marca; queda visible en Legajos con origen 'erp'.
    [emp] = await sql`
      INSERT INTO empleados (nombre, local, origen) VALUES (${nombre}, ${local}, 'erp') RETURNING id`;
    creado = true;
  }

  await sql`
    INSERT INTO asistencias (empleado_id, fecha, estado, minutos_tarde, motivo, marcado_por, origen)
    VALUES (${emp.id}, ${fecha}, ${estado},
            ${estado === "tarde" ? parseInt(m.minutos_tarde) || null : null},
            ${m.motivo ? String(m.motivo).trim() : null},
            ${m.marcado_por ? String(m.marcado_por).trim() : null}, 'erp')
    ON CONFLICT (empleado_id, fecha) DO UPDATE SET
      estado = EXCLUDED.estado, minutos_tarde = EXCLUDED.minutos_tarde,
      motivo = EXCLUDED.motivo, marcado_por = EXCLUDED.marcado_por, origen = 'erp'`;
  return { ok: true, empleado_creado: creado ? nombre : null };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });

  const secreto = process.env.TUSSY_ERP_SECRET;
  if (!secreto || req.headers["x-tussy-erp-secret"] !== secreto) {
    return res.status(401).json({ error: "no autorizado" });
  }

  const body = req.body || {};
  if (body.evento !== "asistencia") {
    return res.status(400).json({ error: "payload inválido: se espera evento 'asistencia'" });
  }

  const marcas = Array.isArray(body.asistencias) ? body.asistencias : [body];
  if (!marcas.length) return res.status(400).json({ error: "sin asistencias" });

  try {
    const errores = [];
    const creados = [];
    let procesadas = 0;
    for (const m of marcas) {
      const r = await procesarMarca(m);
      if (r.error) errores.push({ empleado: m.empleado, error: r.error });
      else { procesadas++; if (r.empleado_creado) creados.push(r.empleado_creado); }
    }
    res.status(errores.length && !procesadas ? 400 : 200)
       .json({ ok: procesadas > 0, procesadas, empleados_creados: creados, errores });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
