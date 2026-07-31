// Carga un reporte de ventas de MercadoPago Point (.xlsx) a mix_pagos.
// Alternativa por terminal a la carga desde la app (Rentabilidad → Carga);
// el procesamiento es el mismo: lib/reportes.js.
//
// Uso: node scripts/db-cargar-mercadopago.js <archivo.xlsx> [--aplicar]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { procesarMP, guardarMixPagos } = require("../lib/reportes");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function leerReporte(archivo) {
  const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb[wb.sheetnames[0]]
periodo = str(ws.cell(2,1).value or "")
ops = []
for row in ws.iter_rows(min_row=5, values_only=True):
    if row[0] is None: continue
    ops.append({'estado': str(row[2] or ''), 'cobro': row[4] or 0, 'neto': row[8] or 0,
                'medio': str(row[12] or ''), 'local': str(row[37] or ''), 'resumen': str(row[7] or '')})
print(json.dumps({'periodo': periodo, 'ops': ops}))
`;
  const out = execFileSync("python3", ["-c", py, archivo], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

async function main() {
  loadEnv();
  const archivo = process.argv[2];
  if (!archivo) { console.error("Falta el archivo .xlsx"); process.exit(1); }
  const aplicar = process.argv.includes("--aplicar");

  const { periodo, ops } = leerReporte(archivo);
  const r = procesarMP(periodo, ops);
  console.log(`Mes ${r.mes} · ${r.aprobadas} operaciones aprobadas\n`);
  for (const f of r.filas) {
    const mixStr = Object.entries(f.mix).sort((a, b) => a[0] - b[0]).map(([c, p]) => `${c}c:${p}%`).join("  ");
    console.log(`  ${f.local.padEnd(10)} $${f.bruto.toLocaleString("es-AR").padStart(12)} → $${f.neto.toLocaleString("es-AR").padStart(12)}  ${(f.costo_pct * 100).toFixed(2)}%   ${mixStr}`);
  }
  if (r.locales_desconocidos.length) console.log(`\n⚠️ locales desconocidos: ${r.locales_desconocidos.join(", ")}`);

  if (!aplicar) { console.log("\n(dry-run: corré con --aplicar)"); return; }
  const { neon } = require("@neondatabase/serverless");
  await guardarMixPagos(neon(process.env.DATABASE_URL), r.filas);
  console.log(`\n✅ ${r.filas.length} locales cargados para ${r.mes}`);
}

main().catch(e => { console.error(e); process.exit(1); });
