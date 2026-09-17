// Qué deja cada venta, operación por operación.
//
//   venta − IVA − mercadería − lo que se lleva MercadoPago = lo que queda
//
// La mercadería sale de costos_producto. El costo financiero es el real de la
// operación cuando el pago de MP está cruzado; si no, se estima con la tasa del
// local. Las retenciones de IIBB/SIRCREB no entran: son pago a cuenta de un
// impuesto que se paga igual, no un costo de la venta.
//
// Lo que queda es ANTES de alquileres, sueldos e impuestos del mes: es el margen
// que deja la venta para bancar esa estructura, no la ganancia final.

const RETENCION_CABA = 0.054;      // Abasto, Dot y Palermo
const RETENCION_PROVINCIA = 0.009; // La Plata y Córdoba
const LOCALES_CABA = ["Abasto", "Dot", "Palermo"];

// Tasa financiera efectiva por local: la real de MercadoPago si ya hay pagos
// sincronizados, y si no la del último reporte mensual menos las retenciones.
async function tasasPorLocal(sql) {
  const [mp, mix, cfg] = await Promise.all([
    sql`SELECT local, (SUM(comision + financiacion) / NULLIF(SUM(monto), 0))::float AS pct
        FROM pagos_mp
        WHERE estado = 'approved' AND fecha >= CURRENT_DATE - 60 AND local IS NOT NULL
        GROUP BY local HAVING SUM(monto) > 0`,
    sql`SELECT DISTINCT ON (local) local, costo_pct::float AS pct
        FROM mix_pagos ORDER BY local, mes DESC`,
    sql`SELECT valor FROM config_negocio WHERE clave = 'iva_venta_pct'`,
  ]);

  const tasas = {};
  for (const m of mix) {
    const retencion = LOCALES_CABA.includes(m.local) ? RETENCION_CABA : RETENCION_PROVINCIA;
    tasas[m.local] = { pct: Math.max(m.pct - retencion, 0), origen: "estimada" };
  }
  for (const m of mp) tasas[m.local] = { pct: m.pct, origen: "mercadopago" };

  return { tasas, ivaPct: cfg.length ? Number(cfg[0].valor) : 0.21 / 1.21 };
}

// Arma el margen de una operación ya agregada.
// fila: { total, mercaderia, financiero_real, efectivo, electronico, local, ... }
function margenDeOperacion(fila, { tasas, ivaPct }) {
  const total = Number(fila.total) || 0;
  const mercaderia = Math.round(Number(fila.mercaderia) || 0);
  const iva = Math.round(total * ivaPct);

  // Solo lo cobrado por medios electrónicos paga comisión. Si no encontramos el
  // cobro, se asume electrónico (es el caso mayoritario) para no subestimar.
  const electronico = fila.electronico != null ? Number(fila.electronico)
                    : (fila.efectivo != null ? 0 : total);
  const tasa = tasas[fila.local]?.pct || 0;
  const real = fila.financiero_real != null;
  const financiero = real ? Math.round(Number(fila.financiero_real))
                          : Math.round(electronico * tasa);

  const margen = total - iva - mercaderia - financiero;
  return {
    mercaderia, iva, financiero, margen,
    margen_pct: total ? Math.round(margen / total * 1000) / 10 : 0,
    financiero_real: real,
    cuotas: fila.cuotas || null,
    medio: fila.medio_mp || (Number(fila.efectivo || 0) > 0 && !electronico ? "efectivo" : null),
    falta_costo: !!fila.falta_costo,
  };
}

module.exports = { tasasPorLocal, margenDeOperacion };
