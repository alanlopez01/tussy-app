// Procesamiento de los reportes mensuales de MercadoPago Point y Tiendanube.
// Recibe filas ya extraídas del .xlsx (las extrae el navegador o un script) y
// devuelve lo que va a mix_pagos / gastos_mes. Lo comparten la carga desde la
// app y los scripts de terminal.

// Nombres de local en MP → nombres en nuestra base
const LOCAL_MP = {
  "Local Dot": "Dot", "Local Abasto": "Abasto", "Local Palermo": "Palermo",
  "Local La Plata": "La Plata", "Tussy Córdoba": "Córdoba",
};

// Recargo por cuotas c/IVA (para inferir el plan desde la comisión que cobró MP)
const RECARGO_MP = { 2: 0.0484, 3: 0.0726, 6: 0.1331 };

// Tasas PagoNube c/IVA por plan, y costo de cobrar por transferencia
const TASA_PN = { 1: 0.064009, 2: 0.110473, 3: 0.132132, 6: 0.19481 };
const TASA_TRANSF = 0.00605 + 0.0009 + 0.006;

// "2.508,10" → 2508.10
function num(s) {
  return Math.abs(parseFloat(String(s).replace(/\./g, "").replace(",", ".")) || 0);
}

// "Ventas desde el 1 jul 2026 hasta el 30 jul 2026" → "2026-07"
const MESES_ABREV = { ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
                      jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12" };
function mesDelPeriodo(periodo) {
  const m = String(periodo).match(/desde el \d+ (\w{3})\w* (?:de )?(\d{4})/i);
  if (!m) return null;
  const mm = MESES_ABREV[m[1].toLowerCase().slice(0, 3)];
  return mm ? `${m[2]}-${mm}` : null;
}

// ── MercadoPago Point ──
// ops: [{estado, cobro, neto, medio, local, resumen}]
function procesarMP(periodo, ops) {
  const mes = mesDelPeriodo(periodo);
  if (!mes) throw new Error(`No pude leer el período del reporte: "${String(periodo).slice(0, 80)}"`);

  const porLocal = {};
  let aprobadas = 0, ignoradas = 0;
  const localesDesconocidos = new Set();

  for (const op of ops) {
    if (String(op.estado) !== "Aprobado") { ignoradas++; continue; }
    const local = LOCAL_MP[op.local];
    if (!local) { localesDesconocidos.add(String(op.local)); continue; }
    aprobadas++;

    const cobro = Number(op.cobro) || 0;
    const neto = Number(op.neto) || 0;
    const coms = [...String(op.resumen || "").matchAll(/\(detalle de la comisión\) - \$ -([\d.,]+)/g)]
      .map(m => num(m[1]));

    let cuotas = 1;
    const medio = String(op.medio || "");
    if ((medio.includes("crédito") || medio.includes("prepaga")) && coms.length >= 2 && cobro > 0) {
      const pct = coms[1] / cobro;
      let dif = Infinity;
      for (const [c, tasa] of Object.entries(RECARGO_MP)) {
        const d = Math.abs(tasa - pct);
        if (d < dif) { dif = d; cuotas = parseInt(c); }
      }
    }

    if (!porLocal[local]) porLocal[local] = { bruto: 0, neto: 0, ops: 0, mix: {} };
    const d = porLocal[local];
    d.bruto += cobro; d.neto += neto; d.ops++;
    d.mix[cuotas] = (d.mix[cuotas] || 0) + cobro;
  }

  const filas = Object.entries(porLocal).map(([local, d]) => {
    const mixPct = {};
    for (const [c, monto] of Object.entries(d.mix)) mixPct[c] = Math.round(monto / d.bruto * 1000) / 10;
    return {
      mes, local,
      bruto: Math.round(d.bruto), neto: Math.round(d.neto), ops: d.ops,
      costo_pct: d.bruto > 0 ? (d.bruto - d.neto) / d.bruto : 0,
      mix: mixPct,
    };
  }).sort((a, b) => b.bruto - a.bruto);

  return { mes, filas, aprobadas, ignoradas, locales_desconocidos: [...localesDesconocidos] };
}

// ── Tiendanube ──
// ordenes: [{fecha (ISO o Date), importe, plataforma, cuotas, estado, pago_envio, costo_envio}]
function procesarTN(ordenes, publicidad) {
  const porMes = {};
  let canceladas = 0;

  const costoEnvioTienda = valor => {
    if (valor == null) return 0;
    const s = String(valor);
    const partes = s.includes("/") ? s.split("/").map(p => p.trim()) : [s];
    const n = parseFloat(partes[partes.length - 1]);
    return isNaN(n) ? 0 : n;
  };

  for (const o of ordenes) {
    if (String(o.estado || "").toLowerCase().includes("ancel")) { canceladas++; continue; }
    const fecha = String(o.fecha || "");
    const m = fecha.match(/(\d{4})-(\d{2})/);
    if (!m) continue;
    const mes = `${m[1]}-${m[2]}`;

    if (!porMes[mes]) porMes[mes] = { total: 0, transf: 0, pn: {}, envios: 0, ordenes: 0 };
    const d = porMes[mes];
    const imp = Number(o.importe) || 0;
    d.total += imp; d.ordenes++;

    if (String(o.plataforma || "").includes("ffline")) {
      d.transf += imp;
    } else {
      let c = parseInt(o.cuotas) || 1;
      if (!TASA_PN[c]) c = 1;
      d.pn[c] = (d.pn[c] || 0) + imp;
    }
    if (String(o.pago_envio || "").toLowerCase().includes("tienda")) d.envios += costoEnvioTienda(o.costo_envio);
  }

  const meses = Object.entries(porMes).sort().map(([mes, d]) => {
    const pnTotal = Object.values(d.pn).reduce((a, v) => a + v, 0);
    const costoPn = Object.entries(d.pn).reduce((a, [c, v]) => a + v * TASA_PN[c], 0);
    const costo = costoPn + d.transf * TASA_TRANSF;
    const mix = {};
    for (const [c, v] of Object.entries(d.pn)) mix[c] = pnTotal > 0 ? Math.round(v / pnTotal * 1000) / 10 : 0;
    return {
      mes, local: "Tiendanube",
      bruto: Math.round(d.total), neto: Math.round(d.total - costo), ops: d.ordenes,
      costo_pct: d.total > 0 ? costo / d.total : 0,
      mix, envios: Math.round(d.envios),
      publicidad: publicidad ? Math.round(Number(publicidad)) : null,
    };
  });

  return { meses, canceladas };
}

// ── Persistencia ──
async function guardarMixPagos(sql, filas) {
  for (const f of filas) {
    await sql`
      INSERT INTO mix_pagos (mes, local, bruto, neto, ops, costo_pct, mix)
      VALUES (${f.mes}, ${f.local}, ${f.bruto}, ${f.neto}, ${f.ops}, ${f.costo_pct}, ${JSON.stringify(f.mix)})
      ON CONFLICT (mes, local) DO UPDATE SET bruto = EXCLUDED.bruto, neto = EXCLUDED.neto,
        ops = EXCLUDED.ops, costo_pct = EXCLUDED.costo_pct, mix = EXCLUDED.mix, actualizado_en = now()`;
    if (f.local === "Tiendanube") {
      await sql`
        INSERT INTO gastos_mes (mes, local, concepto, monto) VALUES (${f.mes}, 'Tiendanube', 'envios', ${f.envios || 0})
        ON CONFLICT (mes, local, concepto) DO UPDATE SET monto = EXCLUDED.monto, actualizado_en = now()`;
      if (f.publicidad != null) {
        await sql`
          INSERT INTO gastos_mes (mes, local, concepto, monto) VALUES (${f.mes}, 'Tiendanube', 'publicidad', ${f.publicidad})
          ON CONFLICT (mes, local, concepto) DO UPDATE SET monto = EXCLUDED.monto, actualizado_en = now()`;
      }
    }
  }
}

module.exports = { procesarMP, procesarTN, guardarMixPagos, LOCAL_MP };
