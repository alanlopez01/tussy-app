// MercadoPago — trae los pagos con su costo financiero real por operación.
//
// El reporte mensual que se carga a mano da el promedio del local; esto da el
// detalle: cuántas cuotas tuvo cada venta y cuánto se llevó MP por ella. Con eso
// la rentabilidad de cada venta deja de ser una estimación.
//
// La comisión y la financiación son costo real. Las retenciones (IIBB/SIRCREB)
// NO lo son: son pago a cuenta de un impuesto que igual se paga, así que se
// guardan aparte y no entran en el margen.
const TOKEN = () => process.env.MP_ACCESS_TOKEN;
const mpConfigurado = () => !!TOKEN();

// Nombres de punto de venta en MP → locales nuestros
const LOCAL_MP = {
  "Local Dot": "Dot", "Local Abasto": "Abasto", "Local Palermo": "Palermo",
  "Local La Plata": "La Plata", "Tussy Córdoba": "Córdoba", "Tussy Coffe": "Tussy Coffe",
};

function normalizarLocal(nombre) {
  const n = String(nombre || "").trim();
  if (LOCAL_MP[n]) return LOCAL_MP[n];
  for (const [mp, nuestro] of Object.entries(LOCAL_MP)) {
    if (n.toLowerCase().includes(nuestro.toLowerCase())) return nuestro;
  }
  return n || null;
}

// Los fee_details de MP vienen desglosados por tipo. "financing_fee" es el
// recargo por cuotas; "mercadopago_fee" la comisión; los "tax"/"withholding"
// son retenciones.
function desglosarFees(pago) {
  let comision = 0, financiacion = 0, retenciones = 0;
  for (const f of pago.fee_details || []) {
    const monto = Math.abs(Number(f.amount) || 0);
    const t = String(f.type || "").toLowerCase();
    if (t.includes("financing")) financiacion += monto;
    else if (t.includes("tax") || t.includes("withholding") || t.includes("retention")) retenciones += monto;
    else comision += monto;
  }
  return { comision, financiacion, retenciones };
}

function medioDe(pago) {
  const tipo = String(pago.payment_type_id || "");
  if (tipo === "credit_card") return "credito";
  if (tipo === "debit_card") return "debito";
  if (tipo === "prepaid_card") return "prepaga";
  if (tipo === "account_money") return "dinero_cuenta";
  if (tipo === "bank_transfer") return "transferencia";
  return tipo || "otro";
}

// Busca pagos aprobados en un rango. La API pagina de a 50.
async function buscarPagos(desde, hasta) {
  if (!mpConfigurado()) throw new Error("Falta MP_ACCESS_TOKEN");
  const pagos = [];
  let offset = 0;
  while (offset < 5000) {
    const qs = new URLSearchParams({
      sort: "date_approved", criteria: "desc", status: "approved",
      "range": "date_approved",
      "begin_date": `${desde}T00:00:00.000-03:00`,
      "end_date": `${hasta}T23:59:59.999-03:00`,
      limit: "50", offset: String(offset),
    });
    const r = await fetch(`https://api.mercadopago.com/v1/payments/search?${qs}`, {
      headers: { Authorization: `Bearer ${TOKEN()}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => "");
      throw new Error(`MP HTTP ${r.status}: ${cuerpo.slice(0, 200)}`);
    }
    const j = await r.json();
    const lote = j.results || [];
    pagos.push(...lote);
    if (lote.length < 50) break;
    offset += 50;
  }
  return pagos;
}

// Trae los pagos del rango y los guarda. Devuelve cuántos entraron.
async function sincronizarPagos(sql, desde, hasta) {
  const pagos = await buscarPagos(desde, hasta);
  let guardados = 0;
  for (const p of pagos) {
    const { comision, financiacion, retenciones } = desglosarFees(p);
    const aprobado = p.date_approved || p.date_created;
    const fecha = new Date(new Date(aprobado).getTime() - 3 * 3600 * 1000).toISOString();
    const local = normalizarLocal(p.store_id ? p.store_id : p.description) ||
                  normalizarLocal(p.point_of_interaction?.location?.source || "");
    await sql`
      INSERT INTO pagos_mp (id, fecha, hora, local, monto, neto, comision, financiacion,
                            retenciones, medio, cuotas, estado, pos, orden_id, crudo)
      VALUES (${p.id}, ${fecha.slice(0, 10)}, ${fecha.slice(11, 16)}, ${local},
              ${Number(p.transaction_amount) || 0},
              ${Number(p.transaction_details?.net_received_amount) || null},
              ${comision}, ${financiacion}, ${retenciones}, ${medioDe(p)},
              ${Number(p.installments) || 1}, ${p.status}, ${p.pos_id ? String(p.pos_id) : null},
              ${p.external_reference || null},
              ${JSON.stringify({ store: p.store_id, desc: p.description, pos: p.pos_id })})
      ON CONFLICT (id) DO UPDATE SET
        neto = EXCLUDED.neto, comision = EXCLUDED.comision, financiacion = EXCLUDED.financiacion,
        retenciones = EXCLUDED.retenciones, estado = EXCLUDED.estado, local = EXCLUDED.local`;
    guardados++;
  }
  return { traidos: pagos.length, guardados, desde, hasta };
}

// Cruza los pagos de MP con nuestros cobros por (local, fecha, monto).
// Donde el monto es único en el día no hay ambigüedad posible; donde se repite,
// se asignan en orden y quedan marcados como aproximados.
async function cruzarConCobros(sql, desde, hasta) {
  const r = await sql`
    WITH pagos AS (
      SELECT id, fecha, local, monto,
             ROW_NUMBER() OVER (PARTITION BY fecha, local, monto ORDER BY id) rn,
             COUNT(*) OVER (PARTITION BY fecha, local, monto) repetidos
      FROM pagos_mp
      WHERE fecha BETWEEN ${desde} AND ${hasta} AND estado = 'approved' AND orden_id IS NULL
    ), cobros_e AS (
      SELECT fecha, local, orden_id, monto,
             ROW_NUMBER() OVER (PARTITION BY fecha, local, monto ORDER BY orden_id) rn
      FROM cobros
      WHERE fecha BETWEEN ${desde} AND ${hasta} AND medio <> 'efectivo'
    )
    UPDATE pagos_mp p
    SET orden_id = c.orden_id,
        crudo = jsonb_set(COALESCE(p.crudo, '{}'), '{cruce}',
                          to_jsonb(CASE WHEN pg.repetidos > 1 THEN 'aproximado' ELSE 'exacto' END))
    FROM pagos pg
    JOIN cobros_e c ON c.fecha = pg.fecha AND c.local = pg.local
                   AND ROUND(c.monto) = ROUND(pg.monto) AND c.rn = pg.rn
    WHERE p.id = pg.id
    RETURNING p.id`;
  return { cruzados: r.length };
}

module.exports = { mpConfigurado, sincronizarPagos, cruzarConCobros, buscarPagos, desglosarFees };
