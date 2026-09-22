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

const LIMITE = 50;

async function paginaPagos(desde, hasta, offset) {
  const qs = new URLSearchParams({
    sort: "date_approved", criteria: "asc", range: "date_approved",
    begin_date: desde, end_date: hasta, limit: String(LIMITE), offset: String(offset),
  });
  const r = await fetch(`https://api.mercadopago.com/v1/payments/search?${qs}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` }, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`MP HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json()).results || [];
}

// La búsqueda de MercadoPago no se puede pedir de a un día entero: devuelve
// páginas cortas cuando todavía quedan pagos, y su `paging.total` cambia de una
// llamada a otra (el 19-sep informaba 155, después 104, y los pagos reales eran
// 153). Así que se pide hora por hora y se repite la pasada hasta que una vuelta
// completa no agregue ninguno nuevo; los repetidos se descartan por id. Las
// horas que nunca devolvieron nada salen de la lista y no se vuelven a pedir.
async function buscarPagosDia(dia, { maxPasadas = 6 } = {}) {
  const vistos = new Map();
  let ventanas = [];
  for (let h = 0; h < 24; h++) {
    const dd = String(h).padStart(2, "0");
    const hh = String(h + 1).padStart(2, "0");
    ventanas.push([`${dia}T${dd}:00:00.000-03:00`,
                   h === 23 ? `${dia}T23:59:59.999-03:00` : `${dia}T${hh}:00:00.000-03:00`]);
  }
  for (let pasada = 0; pasada < maxPasadas; pasada++) {
    const antes = vistos.size;
    const conPagos = [];
    for (const [desde, hasta] of ventanas) {
      let hubo = false;
      for (let offset = 0; offset < 1000; offset += LIMITE) {
        const lote = await paginaPagos(desde, hasta, offset);
        for (const p of lote) vistos.set(p.id, p);
        if (lote.length) hubo = true;
        if (lote.length < LIMITE) break;
      }
      if (hubo) conPagos.push([desde, hasta]);
    }
    ventanas = conPagos;
    if (vistos.size === antes || !ventanas.length) break;
  }
  return [...vistos.values()];
}

// Un pago de la web se puede pedir por número de pedido, que es exacto. Es la
// red de seguridad de la búsqueda por fecha: si una venta online quedó sin su
// pago cruzado, se va a buscar de a una y se termina de cerrar.
async function buscarPagosDeOrdenes(ordenes) {
  const pagos = [];
  for (const orden of ordenes) {
    const r = await fetch(
      `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(orden)}`,
      { headers: { Authorization: `Bearer ${TOKEN()}` }, signal: AbortSignal.timeout(20000) },
    ).catch(() => null);
    if (!r || !r.ok) continue;
    const j = await r.json().catch(() => ({}));
    for (const p of j.results || []) if (p.status === "approved") pagos.push(p);
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

// Guarda un pago si es una venta. Devuelve true si lo guardó.
async function guardarPago(sql, p, stores) {
  const tipo = p.point_of_interaction?.type;
  // En checkout la referencia es el número de pedido de Tiendanube: cruce exacto.
  // En Point viene "Venta presencial", que no sirve para identificar el ticket.
  const refOrden = /^\d+$/.test(String(p.external_reference || "")) ? String(p.external_reference) : null;
  // Parte de los cobros de la web llegan con point_of_interaction UNSPECIFIED en
  // lugar de CHECKOUT (depende del flujo con que haya pagado el cliente). Se
  // aceptan igual cuando traen el número de pedido: eso los identifica como
  // venta online sin ambigüedad. Descartarlos dejaba la mitad de las ventas de
  // la web con la comisión estimada en vez de la real.
  const online = tipo === "CHECKOUT" || (tipo === "UNSPECIFIED" && refOrden);
  if (!TIPOS_VENTA.has(tipo) && !online) return false;

  const { comision, financiacion, retenciones } = desglosarFees(p);
  const iso = new Date(new Date(p.date_approved || p.date_created).getTime() - 3 * 3600 * 1000).toISOString();
  // No todo checkout es la tienda: también entran cobros por link de pago
  // (mayoristas, cobros sueltos). Solo los que traen número de pedido son
  // ventas online; el resto queda sin local para no ensuciar las tasas.
  const referencia = online ? refOrden : null;
  const local = online ? (refOrden ? "Tiendanube" : null) : (stores[String(p.store_id)] || null);

  // Si MercadoPago todavía no informó el neto, va null: Number(undefined) es NaN
  // y NaN en una columna numeric rompe cualquier promedio posterior.
  const neto = Number(p.transaction_details?.net_received_amount);

  await sql`
    INSERT INTO pagos_mp (id, fecha, hora, local, monto, neto, comision, financiacion,
                          retenciones, medio, cuotas, estado, pos, orden_id, crudo)
    VALUES (${p.id}, ${iso.slice(0, 10)}, ${iso.slice(11, 16)}, ${local},
            ${Number(p.transaction_amount) || 0},
            ${Number.isFinite(neto) ? neto : null},
            ${comision}, ${financiacion}, ${retenciones}, ${medioDe(p)},
            ${Number(p.installments) || 1}, ${p.status}, ${p.pos_id ? String(p.pos_id) : null},
            ${referencia},
            ${JSON.stringify({ tipo, store: p.store_id, cruce: referencia ? "referencia" : null })})
    ON CONFLICT (id) DO UPDATE SET
      neto = EXCLUDED.neto, comision = EXCLUDED.comision, financiacion = EXCLUDED.financiacion,
      retenciones = EXCLUDED.retenciones, estado = EXCLUDED.estado, local = EXCLUDED.local,
      orden_id = COALESCE(pagos_mp.orden_id, EXCLUDED.orden_id)`;
  return true;
}

// Trae los pagos del rango y guarda solo las ventas.
async function sincronizarPagos(sql, desde, hasta) {
  const [pagos, stores] = await Promise.all([buscarPagos(desde, hasta), mapaDeSucursales()]);
  let guardados = 0, descartados = 0;
  for (const p of pagos) {
    if (await guardarPago(sql, p, stores)) guardados++;
    else descartados++;
  }
  const rescatados = await completarPagosOnline(sql, desde, hasta, stores);
  return { traidos: pagos.length, guardados, descartados, rescatados, desde, hasta };
}

// Ventas de la web que quedaron sin su pago: se piden a MercadoPago de a una por
// número de pedido. Cierra lo que la búsqueda por fecha no haya traído.
async function completarPagosOnline(sql, desde, hasta, stores) {
  const huerfanas = await sql`
    SELECT DISTINCT c.orden_id
    FROM cobros c
    WHERE c.local = 'Tiendanube' AND c.fecha BETWEEN ${desde} AND ${hasta}
      AND c.medio <> 'efectivo'
      -- transferencia bancaria y pedidos en $0 no pasan por MercadoPago
      AND COALESCE(c.gateway, '') NOT IN ('offline', 'free')
      AND NOT EXISTS (SELECT 1 FROM pagos_mp p
                      WHERE p.orden_id = c.orden_id AND p.local = 'Tiendanube' AND p.estado = 'approved')
    LIMIT 200`;
  if (!huerfanas.length) return 0;
  const pagos = await buscarPagosDeOrdenes(huerfanas.map(h => h.orden_id));
  let n = 0;
  for (const p of pagos) if (await guardarPago(sql, p, stores)) n++;
  return n;
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

module.exports = { mpConfigurado, sincronizarPagos, cruzarConCobros, buscarPagos, buscarPagosDia, desglosarFees };
