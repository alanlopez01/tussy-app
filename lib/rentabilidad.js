// Qué deja cada venta, con todo lo que se lleva vender.
//
//   venta − mercadería − IVA − IIBB − impuesto al cheque − comisiones = lo que queda
//
// Criterios, para que coincida con el cierre mensual de Rentabilidad:
//
// · IVA: no es el porcentaje del precio a secas. El débito fiscal de la venta se
//   compensa con el crédito fiscal de la mercadería, así que lo que esta venta
//   genera de IVA es sobre el valor que agrega: precio − costo. (La posición que
//   se paga a fin de mes es todavía menor, porque también descuenta el crédito de
//   alquileres, pauta y servicios; ese crédito es de la estructura, no de la venta,
//   y la estructura no está en este cálculo.)
// · IIBB: alícuota efectiva sobre la venta, directamente atribuible.
// · Impuesto al cheque (Ley 25.413): 0,6% de lo que entra al banco. Se aplica solo
//   a los cobros por transferencia bancaria, que son los que caen directo en la
//   cuenta. El dinero que queda en MercadoPago no lo paga en el momento de la
//   venta (lo paga después, si se pasa al banco: eso es una decisión financiera,
//   no un costo de la venta). El efectivo no lo paga nunca.
// · Comisiones de MercadoPago: el costo real de la operación (incluye el recargo
//   por cuotas). Las retenciones de IIBB/SIRCREB no se suman: son pago a cuenta
//   del IIBB que ya está contado arriba. Una transferencia bancaria no paga
//   comisión de MP: no pasa por MP.
//
// Lo que queda es ANTES de alquileres, sueldos y pauta: es lo que deja la venta
// para bancar esa estructura.

const RET_CABA = 0.054, RET_PROV = 0.009;
const LOCALES_CABA = ["Abasto", "Dot", "Palermo"];
// El checkout online pasó de PagoNube a MercadoPago el 17-sep-2026. Antes de esa
// fecha las ventas de la web pagaban la comisión de PagoNube, bastante más cara.
const CORTE_CHECKOUT_MP = "2026-09-17";

async function contextoRentabilidad(sql) {
  const [mp, mix, cfgRows, ivaReal, chequeReal] = await Promise.all([
    sql`SELECT local, (SUM(comision + financiacion) / NULLIF(SUM(monto), 0))::float AS pct
        FROM pagos_mp
        WHERE estado = 'approved' AND fecha >= CURRENT_DATE - 60 AND local IS NOT NULL
        GROUP BY local HAVING SUM(monto) > 0`,
    sql`SELECT DISTINCT ON (local) local, costo_pct::float AS pct
        FROM mix_pagos ORDER BY local, mes DESC`,
    sql`SELECT clave, valor FROM config_negocio`,
    sql`SELECT 1`,
    // Impuesto al cheque: lo que efectivamente debitó el banco sobre la venta
    sql`SELECT SUM(ABS(m.monto))::float AS cheque,
               (SELECT SUM(total)::float FROM ventas v
                WHERE v.fecha BETWEEN MIN(m.fecha) AND MAX(m.fecha) AND v.total > 0) AS venta
        FROM movimientos_banco m
        WHERE m.descripcion ILIKE '%25413%' AND m.fecha >= CURRENT_DATE - 90`,
  ]);

  const cfg = Object.fromEntries(cfgRows.map(c => [c.clave, Number(c.valor)]));

  const tasas = {};
  for (const m of mix) {
    const ret = LOCALES_CABA.includes(m.local) ? RET_CABA : RET_PROV;
    tasas[m.local] = { pct: Math.max(m.pct - ret, 0), origen: "estimada" };
  }
  for (const m of mp) tasas[m.local] = { pct: m.pct, origen: "mercadopago" };

  const cheque = chequeReal[0];
  // Tasa de PagoNube para las ventas online anteriores al cambio de checkout.
  const tasaOnlineVieja = mix.find(m => m.local === "Tiendanube")?.pct || null;
  // Alícuota de IVA de la venta. La indumentaria va al 10,5%, que es lo que la
  // app usa para los escenarios de producto (impuesto_producto_pct).
  const alicuota = cfg.impuesto_producto_pct || 0.21;
  return {
    tasas,
    alicuotaIva: alicuota,
    ivaOrigen: `${String(alicuota * 100).replace(".", ",")}% sobre el valor agregado`,
    iibbPct: cfg.iibb_pct || 0.0452,
    chequePct: cfg.imp_cheque_pct || 0.006,
    tasaOnlineVieja, corteCheckoutMp: CORTE_CHECKOUT_MP,
  };
}

// Arma el desglose de una operación ya agregada.
function margenDeOperacion(fila, ctx) {
  const total = Number(fila.total) || 0;
  const mercaderia = Math.round(Number(fila.mercaderia) || 0);
  // Débito de la venta menos el crédito de la mercadería: el IVA del valor agregado.
  const a = ctx.alicuotaIva;
  const iva = Math.max(Math.round(total * (a / (1 + a)) - mercaderia * a), 0);
  const iibb = Math.round(total * ctx.iibbPct);

  // Cada medio tiene su costo: la tarjeta y el QR pagan comisión de MP; la
  // transferencia no pasa por MP pero cae en el banco y paga impuesto al cheque;
  // el efectivo no paga nada de esto.
  const efectivo = Number(fila.efectivo || 0);
  const transferencia = Number(fila.transferencia || 0);
  const porMp = fila.electronico != null
    ? Math.max(Number(fila.electronico) - transferencia, 0)
    : (fila.efectivo != null ? 0 : total);

  const cheque = Math.round(transferencia * ctx.chequePct);
  const real = fila.financiero_real != null;
  // Las ventas online previas al cambio de checkout cobraron por PagoNube.
  const esOnlineViejo = fila.local === "Tiendanube" && ctx.tasaOnlineVieja
    && String(fila.fecha || "") < ctx.corteCheckoutMp;
  const tasa = esOnlineViejo ? ctx.tasaOnlineVieja : (ctx.tasas[fila.local]?.pct || 0);
  const comisiones = real ? Math.round(Number(fila.financiero_real))
                          : Math.round(porMp * tasa);

  const impuestos = iva + iibb + cheque;
  const margen = total - mercaderia - impuestos - comisiones;
  return {
    mercaderia, iva, iibb, cheque, impuestos, comisiones,
    // se mantiene el nombre viejo para no romper lo que ya lo consume
    financiero: comisiones,
    margen,
    margen_pct: total ? Math.round(margen / total * 1000) / 10 : 0,
    financiero_real: real,
    cuotas: fila.cuotas || null,
    medio: fila.medio_mp
      || (transferencia > 0 && !porMp ? "transferencia" : null)
      || (efectivo > 0 && !porMp && !transferencia ? "efectivo" : null),
    falta_costo: !!fila.falta_costo,
  };
}

// Compatibilidad con el nombre anterior
const tasasPorLocal = contextoRentabilidad;

module.exports = { contextoRentabilidad, tasasPorLocal, margenDeOperacion };
