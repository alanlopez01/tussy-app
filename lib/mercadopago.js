// MercadoPago — trae los pagos con su costo financiero real por operación.
//
// Desde el 17-sep-2026 todo el cobro electrónico pasa por acá: Point en los
// locales y Checkout dentro de Tiendanube. El reporte mensual daba el promedio
// del local; esto da el detalle de cada venta: cuántas cuotas tuvo y cuánto se
// llevó MP por ella.
//
// Qué es venta y qué no: la cuenta de MP también registra los consumos con la
// tarjeta de débito de MercadoPago (la suscripción de Tiendanube, herramientas)
// y las transferencias entre cuentas. Nada de eso es una venta, así que solo se
// guardan las operaciones de punto de venta (INSTORE/POINT) y de checkout online.
//
// La comisión y la financiación son costo real. Las retenciones de IIBB/SIRCREB
// no lo son —son pago a cuenta de un impuesto que se paga igual—, así que se
// guardan aparte y no entran en el margen. MP no las desglosa en fee_details:
// son la diferencia entre lo que quedó neto y lo que descontaron de comisiones.
const TOKEN = () => process.env.MP_ACCESS_TOKEN;
const mpConfigurado = () => !!TOKEN();

const TIPOS_VENTA = new Set(["INSTORE", "POINT", "CHECKOUT"]);

// Sucursal de MP → local nuestro. Se resuelve contra la API y se cachea.
const NOMBRE_LOCAL = {
  "Local Palermo": "Palermo", "Local La Plata": "La Plata", "Local Dot": "Dot",
  "Local Abasto": "Abasto", "Tussy Córdoba": "Córdoba", "Tussy Coffe": "Tussy Coffe",
};
let cacheStores = null;

async function mapaDeSucursales() {
  if (cacheStores) return cacheStores;
  const h = { Authorization: `Bearer ${TOKEN()}` };
  const me = await fetch("https://api.mercadopago.com/users/me", { headers: h, signal: AbortSignal.timeout(20000) }).then(r => r.json());
  const st = await fetch(`https://api.mercadopago.com/users/${me.id}/stores/search?limit=50`, { headers: h, signal: AbortSignal.timeout(20000) }).then(r => r.json());
  cacheStores = {};
  for (const s of st.results || []) cacheStores[String(s.id)] = NOMBRE_LOCAL[s.name] || s.name;
  return cacheStores;
}

function desglosarFees(pago) {
  let comision = 0, financiacion = 0;
  for (const f of pago.fee_details || []) {
    const monto = Math.abs(Number(f.amount) || 0);
    if (String(f.type || "").toLowerCase().includes("financing")) financiacion += monto;
    else comision += monto;
  }
  // Lo que falta entre el bruto y el neto, después de comisiones, son retenciones.
  const bruto = Number(pago.transaction_amount) || 0;
  const neto = Number(pago.transaction_details?.net_received_amount);
  const retenciones = Number.isFinite(neto)
    ? Math.max(Math.round((bruto - neto - comision - financiacion) * 100) / 100, 0)
    : 0;
  return { comision, financiacion, retenciones };
}

function medioDe(pago) {
  const tipo = String(pago.payment_type_id || "");
  return { credit_card: "credito", debit_card: "debito", prepaid_card: "prepaga",
           account_money: "dinero_cuenta", bank_transfer: "transferencia",
           digital_currency: "credito_mp", ticket: "efectivo" }[tipo] || tipo || "otro";
}

// Se busca día por día: con un rango largo la paginación por offset devuelve
// resultados incompletos (en 30 días traía 2.500 de 4.047 pagos reales).
async function buscarPagosDia(dia) {
  const pagos = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const qs = new URLSearchParams({
      sort: "date_approved", criteria: "asc", status: "approved", range: "date_approved",
      begin_date: `${dia}T00:00:00.000-03:00`, end_date: `${dia}T23:59:59.999-03:00`,
      limit: "50", offset: String(offset),
    });
    const r = await fetch(`https://api.mercadopago.com/v1/payments/search?${qs}`, {
      headers: { Authorization: `Bearer ${TOKEN()}` }, signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`MP HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const j = await r.json();
    const lote = j.results || [];
    pagos.push(...lote);
    if (lote.length < 50 || pagos.length >= (j.paging?.total ?? 0)) break;
  }
  return pagos;
}

async function buscarPagos(desde, hasta) {
  if (!mpConfigurado()) throw new Error("Falta MP_ACCESS_TOKEN");
  const pagos = [];
  const fin = new Date(`${hasta}T12:00:00Z`);
  for (let d = new Date(`${desde}T12:00:00Z`); d <= fin; d.setUTCDate(d.getUTCDate() + 1)) {
    pagos.push(...await buscarPagosDia(d.toISOString().slice(0, 10)));
  }
  return pagos;
}

// Trae los pagos del rango y guarda solo las ventas.
async function sincronizarPagos(sql, desde, hasta) {
  const [pagos, stores] = await Promise.all([buscarPagos(desde, hasta), mapaDeSucursales()]);
  let guardados = 0, descartados = 0;

  for (const p of pagos) {
    const tipo = p.point_of_interaction?.type;
    if (!TIPOS_VENTA.has(tipo)) { descartados++; continue; }

    const { comision, financiacion, retenciones } = desglosarFees(p);
    const iso = new Date(new Date(p.date_approved || p.date_created).getTime() - 3 * 3600 * 1000).toISOString();
    // En checkout la referencia es el número de pedido de Tiendanube: cruce exacto.
    // En Point viene "Venta presencial", que no sirve para identificar el ticket.
    const referencia = tipo === "CHECKOUT" && /^\d+$/.test(String(p.external_reference || ""))
      ? String(p.external_reference) : null;
    // No todo checkout es la tienda: también entran cobros por link de pago
    // (mayoristas, cobros sueltos). Solo los que traen número de pedido son
    // ventas online; el resto queda sin local para no ensuciar las tasas.
    const local = tipo === "CHECKOUT" ? (referencia ? "Tiendanube" : null)
                                      : (stores[String(p.store_id)] || null);

    await sql`
      INSERT INTO pagos_mp (id, fecha, hora, local, monto, neto, comision, financiacion,
                            retenciones, medio, cuotas, estado, pos, orden_id, crudo)
      VALUES (${p.id}, ${iso.slice(0, 10)}, ${iso.slice(11, 16)}, ${local},
              ${Number(p.transaction_amount) || 0},
              ${Number(p.transaction_details?.net_received_amount) ?? null},
              ${comision}, ${financiacion}, ${retenciones}, ${medioDe(p)},
              ${Number(p.installments) || 1}, ${p.status}, ${p.pos_id ? String(p.pos_id) : null},
              ${referencia},
              ${JSON.stringify({ tipo, store: p.store_id, cruce: referencia ? "referencia" : null })})
      ON CONFLICT (id) DO UPDATE SET
        neto = EXCLUDED.neto, comision = EXCLUDED.comision, financiacion = EXCLUDED.financiacion,
        retenciones = EXCLUDED.retenciones, estado = EXCLUDED.estado, local = EXCLUDED.local,
        orden_id = COALESCE(pagos_mp.orden_id, EXCLUDED.orden_id)`;
    guardados++;
  }
  return { traidos: pagos.length, guardados, descartados, desde, hasta };
}

// Los pagos de Point no traen el número de ticket, así que se cruzan por
// local + fecha + monto. Donde el monto es único en el día el cruce es
// inequívoco; donde se repite, se asignan en orden y quedan marcados.
async function cruzarConCobros(sql, desde, hasta) {
  const r = await sql`
    WITH pagos AS (
      SELECT id, fecha, local, monto,
             ROW_NUMBER() OVER (PARTITION BY fecha, local, ROUND(monto) ORDER BY id) rn,
             COUNT(*) OVER (PARTITION BY fecha, local, ROUND(monto)) repetidos
      FROM pagos_mp
      WHERE fecha BETWEEN ${desde} AND ${hasta} AND estado = 'approved' AND orden_id IS NULL
    ), cobros_e AS (
      SELECT fecha, local, orden_id, monto,
             ROW_NUMBER() OVER (PARTITION BY fecha, local, ROUND(monto) ORDER BY orden_id) rn
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
