// Webhook del Tussy ERP: la recaudación de los locales que el dueño ya contó.
//
// En el ERP, cuando un local entrega los sobres de sus días cerrados, el dueño
// los cuenta día por día. Al terminar de contar el último día, el ERP empuja
// acá lo que REALMENTE entró, y se escribe como un ingreso de Cajas.
//
// Va a la categoría del local ("Local Palermo"), que es la que ya se usaba
// cuando esto se cargaba a mano, así el histórico no se parte en dos. El
// detalle lleva los días que trajo ese sobre.
//
// POST /api/tussy-erp/sobres  ·  header x-tussy-erp-secret
// { "evento": "sobres_recibidos", "op_id": "<uuid>", "local": "Palermo",
//   "fecha": "2026-11-25", "monto_centavos": 271425000,
//   "detalle": "18/11, 19/11, 20/11, 21/11, 22/11, 24/11" }
//
// IDEMPOTENTE Y CORREGIBLE por `origen = 'erp-sobre-<op_id>'`: si el dueño
// corrige el conteo de un día después de haber cerrado la entrega, el ERP
// vuelve a empujar y acá se ACTUALIZA la misma fila en vez de sumar otra. Sin
// esto, un reintento duplicaría plata en la caja.
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });

  const secreto = process.env.TUSSY_ERP_SECRET;
  if (!secreto || req.headers["x-tussy-erp-secret"] !== secreto) {
    return res.status(401).json({ error: "no autorizado" });
  }

  const v = req.body || {};
  if (v.evento !== "sobres_recibidos" || !v.op_id || !v.local) {
    return res.status(400).json({ error: "payload inválido: se espera evento sobres_recibidos con op_id y local" });
  }

  // El ERP manda SIEMPRE centavos enteros; acá se divide por 100 (igual que el
  // webhook de ventas).
  const centavos = Number(v.monto_centavos);
  if (!Number.isInteger(centavos) || centavos <= 0) {
    return res.status(400).json({ error: "monto_centavos inválido" });
  }
  const monto = centavos / 100;

  const fecha = String(v.fecha || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: "fecha inválida" });

  // "Local Palermo", "Local Abasto"… las categorías de ingreso que ya existen.
  const categoria = `Local ${String(v.local).trim()}`;
  const detalle = String(v.detalle || "").trim() || null;
  const origen = `erp-sobre-${v.op_id}`;

  const [ya] = await sql`SELECT id FROM caja_movimientos WHERE origen = ${origen} LIMIT 1`;
  if (ya) {
    await sql`
      UPDATE caja_movimientos
         SET fecha = ${fecha}, categoria = ${categoria}, detalle = ${detalle}, monto = ${monto}
       WHERE id = ${ya.id}`;
    return res.status(200).json({ ok: true, id: ya.id, actualizado: true });
  }

  const [fila] = await sql`
    INSERT INTO caja_movimientos (marca, fecha, tipo, categoria, detalle, monto, medio, usuario, origen)
    VALUES ('tussy', ${fecha}, 'ingreso', ${categoria}, ${detalle}, ${monto},
            'Efectivo', 'Tussy ERP', ${origen})
    RETURNING id`;
  res.status(200).json({ ok: true, id: fila.id, creado: true });
};
