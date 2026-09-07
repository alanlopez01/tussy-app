// Cajas en efectivo — reemplaza los Sheets "Finanzas Tussy Definitivo" y "Finanzas_Shato_v2".
// GET  ?action=resumen&marca=&mes=&anio=  → mismo shape que el getDashboard del Apps Script,
//      así Finanzas puede cambiar de fuente sin tocar la pantalla de los socios.
// GET  ?action=movimientos&marca=&mes=&anio=[&tipo=][&categoria=]
// GET  ?action=categorias&marca=  → { gasto: [...], ingreso: [...] }
// POST ?action=crear|editar|borrar  (solo admin)
const { neon } = require("@neondatabase/serverless");
const { requerirSesion } = require("../lib/auth");

const sql = neon(process.env.DATABASE_URL);

// Categorías reales de cada Excel (agosto 2026). La lista viva se completa con
// lo que exista en la base, así una categoría nueva aparece sola en el selector.
const CATEGORIAS_SEED = {
  tussy: {
    gasto: ["Sueldos", "Talleres", "Productos Terminados", "Tela", "Avios", "Flete",
            "Alquiler", "Operaciones", "Retiros Socios", "Ajuste de caja", "Otro"],
    ingreso: ["Ingreso de dinero", "Local Abasto", "Local Dot", "Local Palermo",
              "Cuenta B", "Tela"],
  },
  shato: {
    gasto: ["Sueldos", "Retiros socios", "Talleres", "Tela", "Alquiler", "Insumos DTF",
            "Insumo Estampas", "Insumos Libreria", "Almacen", "Comida", "Limpieza",
            "Envios", "Avios", "Ajuste de caja", "Otros"],
    ingreso: ["Ingreso de dinero", "Cuenta B", "Cobros", "Ajuste"],
  },
};

const hoyAR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

function validarMarca(v) {
  const m = String(v || "tussy").toLowerCase();
  return m === "shato" ? "shato" : "tussy";
}

async function resumen(req, res) {
  const marca = validarMarca(req.query.marca);
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const desde = `${anio}-${String(mes).padStart(2, "0")}-01`;
  const desdeAnt = mes === 1 ? `${anio - 1}-12-01` : `${anio}-${String(mes - 1).padStart(2, "0")}-01`;
  const hasta = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, "0")}-01`;

  const [mesRows, saldoRow, txHoy] = await Promise.all([
    sql`SELECT tipo, categoria, to_char(fecha, 'YYYY-MM') AS mes, SUM(monto)::float AS total
        FROM caja_movimientos
        WHERE marca = ${marca} AND fecha >= ${desdeAnt} AND fecha < ${hasta}
        GROUP BY 1, 2, 3`,
    sql`SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END), 0)::float AS saldo
        FROM caja_movimientos WHERE marca = ${marca}`,
    sql`SELECT id, tipo, categoria, detalle, monto::float
        FROM caja_movimientos WHERE marca = ${marca} AND fecha = ${hoyAR()}
        ORDER BY creado_en DESC LIMIT 30`,
  ]);

  const mesActual = `${anio}-${String(mes).padStart(2, "0")}`;
  const out = { totalGasto: 0, totalIngreso: 0, totalGastoAnt: 0, totalIngresoAnt: 0,
                porCatGasto: {}, porCatIngreso: {} };
  for (const r of mesRows) {
    const esActual = r.mes === mesActual;
    if (r.tipo === "egreso") {
      if (esActual) { out.totalGasto += r.total; out.porCatGasto[r.categoria] = (out.porCatGasto[r.categoria] || 0) + r.total; }
      else out.totalGastoAnt += r.total;
    } else {
      if (esActual) { out.totalIngreso += r.total; out.porCatIngreso[r.categoria] = (out.porCatIngreso[r.categoria] || 0) + r.total; }
      else out.totalIngresoAnt += r.total;
    }
  }
  out.neto = out.totalIngreso - out.totalGasto;
  out.netoAnt = out.totalIngresoAnt - out.totalGastoAnt;
  out.saldoActual = saldoRow[0].saldo;
  out.txHoy = txHoy.map(t => ({ id: t.id, desc: t.detalle || t.categoria, cat: t.categoria,
                                monto: t.tipo === "egreso" ? -t.monto : t.monto }));
  res.status(200).json(out);
}

async function movimientos(req, res) {
  const marca = validarMarca(req.query.marca);
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const desde = `${anio}-${String(mes).padStart(2, "0")}-01`;
  const hasta = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, "0")}-01`;
  const tipo = ["ingreso", "egreso"].includes(req.query.tipo) ? req.query.tipo : null;
  const categoria = req.query.categoria || null;

  const filas = await sql`
    SELECT id, fecha::text, tipo, categoria, detalle, monto::float, usuario, origen
    FROM caja_movimientos
    WHERE marca = ${marca} AND fecha >= ${desde} AND fecha < ${hasta}
      AND (${tipo}::text IS NULL OR tipo = ${tipo})
      AND (${categoria}::text IS NULL OR categoria = ${categoria})
    ORDER BY fecha DESC, creado_en DESC LIMIT 500`;
  res.status(200).json({ movimientos: filas });
}

async function categorias(req, res) {
  const marca = validarMarca(req.query.marca);
  const seed = CATEGORIAS_SEED[marca];
  const usadas = await sql`
    SELECT DISTINCT tipo, categoria FROM caja_movimientos WHERE marca = ${marca}`;
  const out = { gasto: [...seed.gasto], ingreso: [...seed.ingreso] };
  for (const u of usadas) {
    const lista = u.tipo === "egreso" ? out.gasto : out.ingreso;
    if (!lista.includes(u.categoria)) lista.push(u.categoria);
  }
  res.status(200).json(out);
}

async function crear(req, res, sesion) {
  const { marca, fecha, tipo, categoria, detalle, monto } = req.body || {};
  if (!["ingreso", "egreso"].includes(tipo)) return res.status(400).json({ error: "tipo inválido" });
  if (!categoria || !String(categoria).trim()) return res.status(400).json({ error: "falta la categoría" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || hoyAR()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: "fecha inválida" });

  const [fila] = await sql`
    INSERT INTO caja_movimientos (marca, fecha, tipo, categoria, detalle, monto, usuario)
    VALUES (${validarMarca(marca)}, ${f}, ${tipo}, ${String(categoria).trim()},
            ${detalle ? String(detalle).trim() : null}, ${m}, ${sesion.usuario})
    RETURNING id`;
  res.status(200).json({ ok: true, id: fila.id });
}

async function editar(req, res, sesion) {
  const { id, fecha, tipo, categoria, detalle, monto } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  if (!["ingreso", "egreso"].includes(tipo)) return res.status(400).json({ error: "tipo inválido" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: "fecha inválida" });

  const filas = await sql`
    UPDATE caja_movimientos
    SET fecha = ${f}, tipo = ${tipo}, categoria = ${String(categoria || "").trim()},
        detalle = ${detalle ? String(detalle).trim() : null}, monto = ${m}, usuario = ${sesion.usuario}
    WHERE id = ${id} RETURNING id`;
  if (!filas.length) return res.status(404).json({ error: "movimiento no encontrado" });
  res.status(200).json({ ok: true });
}

async function borrar(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  const filas = await sql`DELETE FROM caja_movimientos WHERE id = ${id} RETURNING id`;
  if (!filas.length) return res.status(404).json({ error: "movimiento no encontrado" });
  res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tussy-Auth");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const sesion = requerirSesion(req, res);
  if (!sesion) return;

  const action = String(req.query.action || "");
  try {
    if (req.method === "GET") {
      if (action === "resumen") return await resumen(req, res);
      if (action === "movimientos") return await movimientos(req, res);
      if (action === "categorias") return await categorias(req, res);
    } else if (req.method === "POST") {
      // La caja la carga solo el admin: los socios ven el resultado en Finanzas.
      if (sesion.rol !== "admin") return res.status(403).json({ error: "solo el admin puede modificar la caja" });
      if (action === "crear") return await crear(req, res, sesion);
      if (action === "editar") return await editar(req, res, sesion);
      if (action === "borrar") return await borrar(req, res);
    }
    res.status(400).json({ error: `acción desconocida: ${action}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
