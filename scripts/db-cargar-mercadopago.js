// Carga un reporte de ventas de MercadoPago Point (.xlsx) a la tabla mix_pagos.
// De cada mes×local calcula: volumen cobrado por Point, neto acreditado, costo
// financiero real (%) y el mix de cuotas (derivado del recargo que cobra MP).
//
// Uso: node scripts/db-cargar-mercadopago.js <archivo.xlsx> [--aplicar]
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

// Nombres de local en MP → nombres en nuestra base
const LOCAL_MP = {
  "Local Dot": "Dot", "Local Abasto": "Abasto", "Local Palermo": "Palermo",
  "Local La Plata": "La Plata", "Tussy Córdoba": "Córdoba",
};

// Lee el xlsx con Python (openpyxl) y devuelve las operaciones aprobadas
function leerReporte(archivo) {
  const py = `
import openpyxl, re, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb[wb.sheetnames[0]]
periodo = str(ws.cell(2,1).value or "")
def num(s):
    return abs(float(s.replace('.','').replace(',','.')))
ops = []
for row in ws.iter_rows(min_row=5, values_only=True):
    if row[0] is None or row[2] != 'Aprobado':
        continue
    resumen = row[7] or ''
    coms = [num(m) for m in re.findall(r'\\(detalle de la comisión\\) - \\$ -([\\d.,]+)', resumen)]
    ops.append({'fecha': str(row[1] or ''), 'cobro': row[4] or 0, 'neto': row[8] or 0,
                'medio': row[12] or '', 'local': row[37] or '', 'coms': coms})
print(json.dumps({'periodo': periodo, 'ops': ops}))
`;
  const out = execFileSync("python3", ["-c", py, archivo], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

// Tasas c/IVA de recargo por cuotas (Config de la planilla)
const RECARGO = { 2: 0.0484, 3: 0.0726, 6: 0.1331 };

function cuotasDe(op) {
  if (!op.medio.includes("crédito") && !op.medio.includes("prepaga")) return 1;
  if (op.coms.length < 2 || !op.cobro) return 1;
  const pct = op.coms[1] / op.cobro;
  let mejor = 1, dif = Infinity;
  for (const [c, tasa] of Object.entries(RECARGO)) {
    const d = Math.abs(tasa - pct);
    if (d < dif) { dif = d; mejor = parseInt(c); }
  }
  return mejor;
}

// "Ventas desde el 1 jul 2026 hasta el 30 jul 2026" → "2026-07"
const MESES = { ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
                jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12" };
function mesDelPeriodo(periodo) {
  const m = periodo.match(/desde el \d+ (\w{3})\w* (\d{4})/i);
  if (!m) throw new Error(`No pude leer el período: "${periodo}"`);
  return `${m[2]}-${MESES[m[1].toLowerCase().slice(0, 3)]}`;
}

async function main() {
  loadEnv();
  const archivo = process.argv[2];
  if (!archivo) { console.error("Falta el archivo .xlsx"); process.exit(1); }
  const aplicar = process.argv.includes("--aplicar");

  const { periodo, ops } = leerReporte(archivo);
  const mes = mesDelPeriodo(periodo);
  console.log(`${periodo.split("\n")[0]}\nMes: ${mes} · operaciones aprobadas: ${ops.length}\n`);

  const porLocal = {};
  for (const op of ops) {
    const local = LOCAL_MP[op.local];
    if (!local) { console.warn(`  ⚠️ local desconocido en MP: "${op.local}"`); continue; }
    if (!porLocal[local]) porLocal[local] = { bruto: 0, neto: 0, ops: 0, mix: {} };
    const d = porLocal[local];
    d.bruto += op.cobro; d.neto += op.neto; d.ops++;
    const c = cuotasDe(op);
    d.mix[c] = (d.mix[c] || 0) + op.cobro;
  }

  console.log("Local            ops     bruto        neto      costo    mix de cuotas (% del volumen)");
  const filas = [];
  for (const [local, d] of Object.entries(porLocal).sort((a, b) => b[1].bruto - a[1].bruto)) {
    const costoPct = (d.bruto - d.neto) / d.bruto;
    const mixPct = {};
    for (const [c, monto] of Object.entries(d.mix)) mixPct[c] = Math.round(monto / d.bruto * 1000) / 10;
    const mixStr = Object.entries(mixPct).sort((a, b) => a[0] - b[0]).map(([c, p]) => `${c}c:${p}%`).join("  ");
    console.log(`${local.padEnd(12)} ${String(d.ops).padStart(5)}  $${Math.round(d.bruto).toLocaleString("es-AR").padStart(11)}  $${Math.round(d.neto).toLocaleString("es-AR").padStart(11)}  ${(costoPct * 100).toFixed(2)}%   ${mixStr}`);
    filas.push({ mes, local, bruto: Math.round(d.bruto), neto: Math.round(d.neto), ops: d.ops, costo_pct: costoPct, mix: mixPct });
  }
  const bruto = filas.reduce((a, f) => a + f.bruto, 0), neto = filas.reduce((a, f) => a + f.neto, 0);
  console.log(`\nTOTAL        ${String(ops.length).padStart(5)}  $${bruto.toLocaleString("es-AR").padStart(11)}  $${neto.toLocaleString("es-AR").padStart(11)}  ${((bruto - neto) / bruto * 100).toFixed(2)}%`);

  if (!aplicar) { console.log("\n(dry-run: nada se escribió — corré con --aplicar)"); return; }

  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS mix_pagos (
      mes TEXT NOT NULL,
      local TEXT NOT NULL,
      bruto NUMERIC NOT NULL,
      neto NUMERIC NOT NULL,
      ops INT NOT NULL,
      costo_pct NUMERIC NOT NULL,
      mix JSONB NOT NULL,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (mes, local)
    )`;
  for (const f of filas) {
    await sql`
      INSERT INTO mix_pagos (mes, local, bruto, neto, ops, costo_pct, mix)
      VALUES (${f.mes}, ${f.local}, ${f.bruto}, ${f.neto}, ${f.ops}, ${f.costo_pct}, ${JSON.stringify(f.mix)})
      ON CONFLICT (mes, local) DO UPDATE SET
        bruto = EXCLUDED.bruto, neto = EXCLUDED.neto, ops = EXCLUDED.ops,
        costo_pct = EXCLUDED.costo_pct, mix = EXCLUDED.mix, actualizado_en = now()`;
  }
  console.log(`\n✅ ${filas.length} locales cargados para ${mes}`);
}

main().catch(e => { console.error(e); process.exit(1); });
