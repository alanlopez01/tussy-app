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
    SELECT id, fecha::text, tipo, categoria, detalle, monto::float, medio, usuario, origen
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
  // Más usadas primero: el selector de la carga rápida las muestra como botones
  const usadas = await sql`
    SELECT tipo, categoria, COUNT(*)::int usos FROM caja_movimientos
    WHERE marca = ${marca} GROUP BY 1, 2 ORDER BY usos DESC`;
  const out = { gasto: [], ingreso: [] };
  for (const u of usadas) {
    const lista = u.tipo === "egreso" ? out.gasto : out.ingreso;
    if (!lista.includes(u.categoria)) lista.push(u.categoria);
  }
  for (const c of seed.gasto) if (!out.gasto.includes(c)) out.gasto.push(c);
  for (const c of seed.ingreso) if (!out.ingreso.includes(c)) out.ingreso.push(c);
  res.status(200).json(out);
}

async function crear(req, res, sesion) {
  const { marca, fecha, tipo, categoria, detalle, monto, medio } = req.body || {};
  if (!["ingreso", "egreso"].includes(tipo)) return res.status(400).json({ error: "tipo inválido" });
  if (!categoria || !String(categoria).trim()) return res.status(400).json({ error: "falta la categoría" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || hoyAR()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: "fecha inválida" });

  const [fila] = await sql`
    INSERT INTO caja_movimientos (marca, fecha, tipo, categoria, detalle, monto, medio, usuario)
    VALUES (${validarMarca(marca)}, ${f}, ${tipo}, ${String(categoria).trim()},
            ${detalle ? String(detalle).trim() : null}, ${m},
            ${medio === "Transferencia" ? "Transferencia" : "Efectivo"}, ${sesion.usuario})
    RETURNING id`;
  res.status(200).json({ ok: true, id: fila.id });
}

async function editar(req, res, sesion) {
  const { id, fecha, tipo, categoria, detalle, monto, medio } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  if (!["ingreso", "egreso"].includes(tipo)) return res.status(400).json({ error: "tipo inválido" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: "fecha inválida" });

  const filas = await sql`
    UPDATE caja_movimientos
    SET fecha = ${f}, tipo = ${tipo}, categoria = ${String(categoria || "").trim()},
        detalle = ${detalle ? String(detalle).trim() : null}, monto = ${m},
        medio = ${medio === "Transferencia" ? "Transferencia" : "Efectivo"}, usuario = ${sesion.usuario}
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

// ── Deuda Shato ↔ Tussy (solo admin) ──
// Ledger de préstamos cruzados que vivía en la hoja "deuda" del Excel de Shato.
// balance = prestado por Shato − prestado por Tussy (negativo: Shato le debe a Tussy).
async function deuda(req, res) {
  const [tot, movs] = await Promise.all([
    sql`SELECT COALESCE(SUM(monto) FILTER (WHERE lado='shato'),0)::float s,
               COALESCE(SUM(monto) FILTER (WHERE lado='tussy'),0)::float t
        FROM deuda_shato`,
    sql`SELECT id, fecha::text, lado, detalle, kilos::float, precio::float, monto::float, usuario, origen
        FROM deuda_shato ORDER BY fecha DESC, creado_en DESC LIMIT 300`,
  ]);
  res.status(200).json({
    prestado_shato: tot[0].s, prestado_tussy: tot[0].t,
    balance: tot[0].s - tot[0].t, movimientos: movs,
  });
}

async function deudaCrear(req, res, sesion) {
  const { fecha, lado, detalle, kilos, precio, monto } = req.body || {};
  if (!["shato", "tussy"].includes(lado)) return res.status(400).json({ error: "lado inválido" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: "fecha inválida" });
  const [fila] = await sql`
    INSERT INTO deuda_shato (fecha, lado, detalle, kilos, precio, monto, usuario)
    VALUES (${f}, ${lado}, ${detalle ? String(detalle).trim() : null},
            ${Number(kilos) || null}, ${Number(precio) || null}, ${m}, ${sesion.usuario})
    RETURNING id`;
  res.status(200).json({ ok: true, id: fila.id });
}

async function deudaEditar(req, res, sesion) {
  const { id, fecha, lado, detalle, kilos, precio, monto } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  if (!["shato", "tussy"].includes(lado)) return res.status(400).json({ error: "lado inválido" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const filas = await sql`
    UPDATE deuda_shato
    SET fecha = ${String(fecha || "").slice(0, 10)}, lado = ${lado},
        detalle = ${detalle ? String(detalle).trim() : null},
        kilos = ${Number(kilos) || null}, precio = ${Number(precio) || null},
        monto = ${m}, usuario = ${sesion.usuario}
    WHERE id = ${id} RETURNING id`;
  if (!filas.length) return res.status(404).json({ error: "movimiento no encontrado" });
  res.status(200).json({ ok: true });
}

async function deudaBorrar(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  const filas = await sql`DELETE FROM deuda_shato WHERE id = ${id} RETURNING id`;
  if (!filas.length) return res.status(404).json({ error: "movimiento no encontrado" });
  res.status(200).json({ ok: true });
}

// ── Socios (solo admin) ──
// Pozos declarados que se reparten por porcentaje + retiros/gastos/aportes por
// socio. saldo = pozo×pct − gastos + aportes − retiros. Un retiro/aporte puede
// impactar la caja de Tussy (fila linkeada vía caja_mov_id, como el Excel).
async function sociosResumen(req, res) {
  const [socios, movs] = await Promise.all([
    sql`SELECT nombre, porcentaje::float FROM socios WHERE activo ORDER BY porcentaje DESC`,
    sql`SELECT id, fecha::text, socio, tipo, descripcion, monto::float, caja_mov_id, usuario, origen
        FROM socios_movimientos ORDER BY fecha DESC, creado_en DESC`,
  ]);
  const pozoTotal = movs.filter(m => m.tipo === "pozo").reduce((a, m) => a + m.monto, 0);
  const resumen = socios.map(s => {
    const mios = movs.filter(m => m.socio === s.nombre);
    const suma = t => mios.filter(m => m.tipo === t).reduce((a, m) => a + m.monto, 0);
    const corresponde = pozoTotal * s.porcentaje;
    const retirado = suma("retiro"), gastos = suma("gasto"), aportes = suma("aporte");
    return { socio: s.nombre, porcentaje: s.porcentaje, corresponde, retirado, gastos, aportes,
             saldo: corresponde - gastos + aportes - retirado };
  });
  res.status(200).json({
    socios: resumen, pozo_total: pozoTotal,
    pozos: movs.filter(m => m.tipo === "pozo").slice(0, 40),
    movimientos: movs.slice(0, 120),
  });
}

async function socioMovCrear(req, res, sesion) {
  const { fecha, socio, tipo, descripcion, monto, impactar_caja } = req.body || {};
  if (!["pozo", "retiro", "gasto", "aporte"].includes(tipo)) return res.status(400).json({ error: "tipo inválido" });
  if (tipo !== "pozo" && !socio) return res.status(400).json({ error: "falta el socio" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return res.status(400).json({ error: "fecha inválida" });

  let cajaId = null;
  if (impactar_caja && (tipo === "retiro" || tipo === "aporte")) {
    const [c] = await sql`
      INSERT INTO caja_movimientos (marca, fecha, tipo, categoria, detalle, monto, usuario)
      VALUES ('tussy', ${f}, ${tipo === "retiro" ? "egreso" : "ingreso"},
              ${tipo === "retiro" ? "Retiros Socios" : "Aporte socio"},
              ${`${tipo === "retiro" ? "Retiro" : "Aporte"} ${socio}${descripcion ? " — " + descripcion : ""}`},
              ${m}, ${sesion.usuario})
      RETURNING id`;
    cajaId = c.id;
  }
  const [fila] = await sql`
    INSERT INTO socios_movimientos (fecha, socio, tipo, descripcion, monto, caja_mov_id, usuario)
    VALUES (${f}, ${tipo === "pozo" ? null : socio}, ${tipo},
            ${descripcion ? String(descripcion).trim() : null}, ${m}, ${cajaId}, ${sesion.usuario})
    RETURNING id`;
  res.status(200).json({ ok: true, id: fila.id, caja_mov_id: cajaId });
}

async function socioMovEditar(req, res, sesion) {
  const { id, fecha, socio, tipo, descripcion, monto } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "monto inválido" });
  const f = String(fecha || "").slice(0, 10);
  const filas = await sql`
    UPDATE socios_movimientos
    SET fecha = ${f}, socio = ${tipo === "pozo" ? null : socio || null},
        descripcion = ${descripcion ? String(descripcion).trim() : null}, monto = ${m}, usuario = ${sesion.usuario}
    WHERE id = ${id} RETURNING caja_mov_id, tipo, socio`;
  if (!filas.length) return res.status(404).json({ error: "movimiento no encontrado" });
  const fila = filas[0];
  if (fila.caja_mov_id) {
    await sql`UPDATE caja_movimientos
      SET fecha = ${f}, monto = ${m},
          detalle = ${`${fila.tipo === "retiro" ? "Retiro" : "Aporte"} ${fila.socio || socio}${descripcion ? " — " + descripcion : ""}`},
          usuario = ${sesion.usuario}
      WHERE id = ${fila.caja_mov_id}`;
  }
  res.status(200).json({ ok: true });
}

async function socioMovBorrar(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "falta id" });
  const filas = await sql`DELETE FROM socios_movimientos WHERE id = ${id} RETURNING caja_mov_id`;
  if (!filas.length) return res.status(404).json({ error: "movimiento no encontrado" });
  if (filas[0].caja_mov_id) await sql`DELETE FROM caja_movimientos WHERE id = ${filas[0].caja_mov_id}`;
  res.status(200).json({ ok: true });
}

async function sociosPct(req, res) {
  const lista = req.body?.socios;
  if (!Array.isArray(lista) || !lista.length) return res.status(400).json({ error: "faltan socios" });
  const suma = lista.reduce((a, s) => a + Number(s.porcentaje), 0);
  if (Math.abs(suma - 1) > 0.001) return res.status(400).json({ error: `los porcentajes suman ${(suma * 100).toFixed(1)}%, deben sumar 100%` });
  for (const s of lista) {
    await sql`UPDATE socios SET porcentaje = ${Number(s.porcentaje)} WHERE nombre = ${String(s.nombre)}`;
  }
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
      if (action === "deuda" || action === "socios") {
        if (sesion.rol !== "admin") return res.status(403).json({ error: "solo admin" });
        return action === "deuda" ? await deuda(req, res) : await sociosResumen(req, res);
      }
    } else if (req.method === "POST") {
      // La caja la carga solo el admin: los socios ven el resultado en Finanzas.
      if (sesion.rol !== "admin") return res.status(403).json({ error: "solo el admin puede modificar la caja" });
      if (action === "crear") return await crear(req, res, sesion);
      if (action === "editar") return await editar(req, res, sesion);
      if (action === "borrar") return await borrar(req, res);
      if (action === "deudaCrear") return await deudaCrear(req, res, sesion);
      if (action === "deudaEditar") return await deudaEditar(req, res, sesion);
      if (action === "deudaBorrar") return await deudaBorrar(req, res);
      if (action === "socioMovCrear") return await socioMovCrear(req, res, sesion);
      if (action === "socioMovEditar") return await socioMovEditar(req, res, sesion);
      if (action === "socioMovBorrar") return await socioMovBorrar(req, res);
      if (action === "sociosPct") return await sociosPct(req, res);
    }
    res.status(400).json({ error: `acción desconocida: ${action}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
