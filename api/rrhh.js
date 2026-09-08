// RRHH (solo admin) — legajos y asistencias.
// La asistencia diaria la marcan los encargados desde el ERP de locales
// (webhook /api/tussy-erp/rrhh); acá Alan la ve día a día y carga por excepción.
// GET  ?action=empleados[&estado=activo|baja]
// GET  ?action=asistencia&fecha=YYYY-MM-DD  → empleados activos con su marca del día
// GET  ?action=resumenMes&mes=&anio=        → tardes/ausencias/etc por empleado
// POST ?action=empleadoCrear|empleadoEditar|marcar|desmarcar
const { neon } = require("@neondatabase/serverless");
const { requerirSesion } = require("../lib/auth");

const sql = neon(process.env.DATABASE_URL);
const ESTADOS = ["presente", "tarde", "ausente", "franco", "vacaciones"];
const hoyAR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function empleados(req, res) {
  const estado = req.query.estado === "baja" ? "baja" : req.query.estado === "todos" ? null : "activo";
  const filas = await sql`
    SELECT id, nombre, local, puesto, cuil, telefono, fecha_ingreso::text, estado, notas, origen
    FROM empleados
    WHERE (${estado}::text IS NULL OR estado = ${estado})
    ORDER BY local, nombre`;
  res.status(200).json({ empleados: filas });
}

async function asistencia(req, res) {
  const fecha = String(req.query.fecha || hoyAR()).slice(0, 10);
  const filas = await sql`
    SELECT e.id, e.nombre, e.local, e.puesto,
           a.estado, a.minutos_tarde, a.motivo, a.marcado_por, a.origen AS marca_origen
    FROM empleados e
    LEFT JOIN asistencias a ON a.empleado_id = e.id AND a.fecha = ${fecha}
    WHERE e.estado = 'activo'
    ORDER BY e.local, e.nombre`;
  res.status(200).json({ fecha, empleados: filas });
}

async function resumenMes(req, res) {
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const desde = `${anio}-${String(mes).padStart(2, "0")}-01`;
  const hasta = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, "0")}-01`;
  const filas = await sql`
    SELECT e.id, e.nombre, e.local,
      COUNT(*) FILTER (WHERE a.estado = 'presente')::int presentes,
      COUNT(*) FILTER (WHERE a.estado = 'tarde')::int tardes,
      COALESCE(SUM(a.minutos_tarde) FILTER (WHERE a.estado = 'tarde'), 0)::int minutos_tarde,
      COUNT(*) FILTER (WHERE a.estado = 'ausente')::int ausentes,
      COUNT(*) FILTER (WHERE a.estado = 'franco')::int francos,
      COUNT(*) FILTER (WHERE a.estado = 'vacaciones')::int vacaciones
    FROM empleados e
    LEFT JOIN asistencias a ON a.empleado_id = e.id AND a.fecha >= ${desde} AND a.fecha < ${hasta}
    WHERE e.estado = 'activo'
    GROUP BY e.id, e.nombre, e.local
    ORDER BY e.local, e.nombre`;
  res.status(200).json({ empleados: filas });
}

async function empleadoCrear(req, res) {
  const { nombre, local, puesto, cuil, telefono, fecha_ingreso, notas } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: "falta el nombre" });
  if (!local || !String(local).trim()) return res.status(400).json({ error: "falta el local" });
  const [fila] = await sql`
    INSERT INTO empleados (nombre, local, puesto, cuil, telefono, fecha_ingreso, notas)
    VALUES (${String(nombre).trim()}, ${String(local).trim()}, ${puesto || null}, ${cuil || null},
            ${telefono || null}, ${fecha_ingreso || null}, ${notas || null})
    RETURNING id`;
  res.status(200).json({ ok: true, id: fila.id });
}

async function empleadoEditar(req, res) {
  const { id, nombre, local, puesto, cuil, telefono, fecha_ingreso, estado, notas } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  if (!nombre || !local) return res.status(400).json({ error: "faltan nombre o local" });
  const filas = await sql`
    UPDATE empleados
    SET nombre = ${String(nombre).trim()}, local = ${String(local).trim()}, puesto = ${puesto || null},
        cuil = ${cuil || null}, telefono = ${telefono || null}, fecha_ingreso = ${fecha_ingreso || null},
        estado = ${estado === "baja" ? "baja" : "activo"}, notas = ${notas || null}
    WHERE id = ${id} RETURNING id`;
  if (!filas.length) return res.status(404).json({ error: "empleado no encontrado" });
  res.status(200).json({ ok: true });
}

async function marcar(req, res, sesion) {
  const { empleado_id, fecha, estado, minutos_tarde, motivo } = req.body || {};
  if (!empleado_id) return res.status(400).json({ error: "falta empleado_id" });
  if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "estado inválido" });
  const f = String(fecha || hoyAR()).slice(0, 10);
  await sql`
    INSERT INTO asistencias (empleado_id, fecha, estado, minutos_tarde, motivo, marcado_por, origen)
    VALUES (${empleado_id}, ${f}, ${estado},
            ${estado === "tarde" ? parseInt(minutos_tarde) || null : null},
            ${motivo ? String(motivo).trim() : null}, ${sesion.usuario}, 'app')
    ON CONFLICT (empleado_id, fecha) DO UPDATE SET
      estado = EXCLUDED.estado, minutos_tarde = EXCLUDED.minutos_tarde,
      motivo = EXCLUDED.motivo, marcado_por = EXCLUDED.marcado_por, origen = 'app'`;
  res.status(200).json({ ok: true });
}

async function desmarcar(req, res) {
  const { empleado_id, fecha } = req.body || {};
  if (!empleado_id || !fecha) return res.status(400).json({ error: "faltan empleado_id o fecha" });
  await sql`DELETE FROM asistencias WHERE empleado_id = ${empleado_id} AND fecha = ${String(fecha).slice(0, 10)}`;
  res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tussy-Auth");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const sesion = requerirSesion(req, res);
  if (!sesion) return;
  // RRHH es del admin: legajos y asistencias no se muestran a los socios
  if (sesion.rol !== "admin") return res.status(403).json({ error: "solo admin" });

  const action = String(req.query.action || "");
  try {
    if (req.method === "GET") {
      if (action === "empleados") return await empleados(req, res);
      if (action === "asistencia") return await asistencia(req, res);
      if (action === "resumenMes") return await resumenMes(req, res);
    } else if (req.method === "POST") {
      if (action === "empleadoCrear") return await empleadoCrear(req, res);
      if (action === "empleadoEditar") return await empleadoEditar(req, res);
      if (action === "marcar") return await marcar(req, res, sesion);
      if (action === "desmarcar") return await desmarcar(req, res);
    }
    res.status(400).json({ error: `acción desconocida: ${action}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
