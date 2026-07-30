// Carga un reporte de estadísticas de Tiendanube (.xlsx) a mix_pagos y gastos_mes.
// Del listado de órdenes calcula, por mes: mix real de cuotas de PagoNube, costo
// financiero (PagoNube por cuota + transferencias) y envíos pagados por la tienda.
//
// Uso: node scripts/db-cargar-tiendanube.js <archivo.xlsx> [--publicidad 5967265] [--aplicar]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Tasas c/IVA (Config de la planilla): cobro PagoNube + recargo por cuotas
const TASA_PN = { 1: 0.064009, 2: 0.110473, 3: 0.132132, 6: 0.19481 };
// Transferencias: comisión TN 0.605% + IIBB Tucumán 0.09% + impuesto créd/déb 0.6%
const TASA_TRANSF = 0.00605 + 0.0009 + 0.006;

function leerOrdenes(archivo) {
  const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb['Listado de órdenes']
out = []
for row in ws.iter_rows(min_row=5, values_only=True):
    if row[0] is None: continue
    f = row[1]
    mes = f.strftime('%Y-%m') if hasattr(f, 'strftime') else str(f)[:7]
    out.append({'mes': mes, 'importe': row[10] or 0, 'plataforma': str(row[11] or ''),
                'cuotas': row[14], 'estado': str(row[23] or ''),
                'pago_envio': str(row[20] or ''), 'costo_envio': str(row[21] or '')})
print(json.dumps(out))
`;
  const out = execFileSync("python3", ["-c", py, archivo], { maxBuffer: 128 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

// "965.00 / 8490.00" (cliente / tienda) → 8490
function costoEnvioTienda(valor) {
  if (!valor) return 0;
  const s = String(valor);
  const partes = s.includes("/") ? s.split("/").map(p => p.trim()) : [s];
  const n = parseFloat(partes[partes.length - 1]);
  return isNaN(n) ? 0 : n;
}

async function main() {
  loadEnv();
  const archivo = process.argv[2];
  if (!archivo) { console.error("Falta el archivo .xlsx"); process.exit(1); }
  const aplicar = process.argv.includes("--aplicar");
  const iPub = process.argv.indexOf("--publicidad");
  const publicidad = iPub > 0 ? parseFloat(process.argv[iPub + 1]) : null;

  const ordenes = leerOrdenes(archivo);
  const porMes = {};
  for (const o of ordenes) {
    if (o.estado.toLowerCase().includes("ancel")) continue;
    const m = o.mes;
    if (!porMes[m]) porMes[m] = { total: 0, transf: 0, pn: {}, envios: 0, ordenes: 0 };
    const d = porMes[m];
    const imp = Number(o.importe) || 0;
    d.total += imp; d.ordenes++;
    if (o.plataforma.includes("ffline")) {
      d.transf += imp;
    } else {
      let c = parseInt(o.cuotas) || 1;
      if (!TASA_PN[c]) c = 1;
      d.pn[c] = (d.pn[c] || 0) + imp;
    }
    const pe = o.pago_envio.toLowerCase();
    if (pe.includes("tienda")) d.envios += costoEnvioTienda(o.costo_envio);
  }

  const filas = [];
  for (const [mes, d] of Object.entries(porMes).sort()) {
    const pnTotal = Object.values(d.pn).reduce((a, v) => a + v, 0);
    const costoPn = Object.entries(d.pn).reduce((a, [c, v]) => a + v * TASA_PN[c], 0);
    const costoTr = d.transf * TASA_TRANSF;
    const costo = costoPn + costoTr;
    const mix = {};
    for (const [c, v] of Object.entries(d.pn)) mix[c] = Math.round(v / pnTotal * 1000) / 10;

    console.log(`══ ${mes} ══ facturación $${Math.round(d.total).toLocaleString("es-AR")} (${d.ordenes} órdenes)`);
    console.log(`  PagoNube  $${Math.round(pnTotal).toLocaleString("es-AR")} (${(pnTotal / d.total * 100).toFixed(0)}%) → costo $${Math.round(costoPn).toLocaleString("es-AR")} = ${(costoPn / pnTotal * 100).toFixed(2)}%`);
    for (const c of Object.keys(TASA_PN)) if (d.pn[c]) console.log(`      ${c}c: $${Math.round(d.pn[c]).toLocaleString("es-AR")} (${mix[c]}% de PagoNube)`);
    console.log(`  Transfer  $${Math.round(d.transf).toLocaleString("es-AR")} (${(d.transf / d.total * 100).toFixed(0)}%) → costo $${Math.round(costoTr).toLocaleString("es-AR")}`);
    console.log(`  Envíos que paga la tienda: $${Math.round(d.envios).toLocaleString("es-AR")}`);
    if (publicidad) console.log(`  Publicidad (ingresada): $${publicidad.toLocaleString("es-AR")}`);
    console.log(`  → costo financiero ${(costo / d.total * 100).toFixed(2)}% de la venta\n`);

    filas.push({ mes, bruto: Math.round(d.total), neto: Math.round(d.total - costo), ops: d.ordenes,
                 costo_pct: costo / d.total, mix, envios: Math.round(d.envios) });
  }

  if (!aplicar) { console.log("(dry-run: corré con --aplicar)"); return; }

  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS gastos_mes (
      mes TEXT NOT NULL, local TEXT NOT NULL, concepto TEXT NOT NULL,
      monto NUMERIC NOT NULL, actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (mes, local, concepto)
    )`;
  for (const f of filas) {
    await sql`
      INSERT INTO mix_pagos (mes, local, bruto, neto, ops, costo_pct, mix)
      VALUES (${f.mes}, 'Tiendanube', ${f.bruto}, ${f.neto}, ${f.ops}, ${f.costo_pct}, ${JSON.stringify(f.mix)})
      ON CONFLICT (mes, local) DO UPDATE SET bruto = EXCLUDED.bruto, neto = EXCLUDED.neto,
        ops = EXCLUDED.ops, costo_pct = EXCLUDED.costo_pct, mix = EXCLUDED.mix, actualizado_en = now()`;
    await sql`
      INSERT INTO gastos_mes (mes, local, concepto, monto)
      VALUES (${f.mes}, 'Tiendanube', 'envios', ${f.envios})
      ON CONFLICT (mes, local, concepto) DO UPDATE SET monto = EXCLUDED.monto, actualizado_en = now()`;
    if (publicidad) {
      await sql`
        INSERT INTO gastos_mes (mes, local, concepto, monto)
        VALUES (${f.mes}, 'Tiendanube', 'publicidad', ${publicidad})
        ON CONFLICT (mes, local, concepto) DO UPDATE SET monto = EXCLUDED.monto, actualizado_en = now()`;
    }
  }
  console.log(`✅ ${filas.length} meses cargados`);
}

main().catch(e => { console.error(e); process.exit(1); });
