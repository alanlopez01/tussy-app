// Carga un reporte de estadísticas de Tiendanube (.xlsx) a mix_pagos y gastos_mes.
// Alternativa por terminal a la carga desde la app (Rentabilidad → Carga);
// el procesamiento es el mismo: lib/reportes.js.
//
// Uso: node scripts/db-cargar-tiendanube.js <archivo.xlsx> [--publicidad 5967265] [--aplicar]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { procesarTN, guardarMixPagos } = require("../lib/reportes");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function leerOrdenes(archivo) {
  const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb['Listado de órdenes']
out = []
for row in ws.iter_rows(min_row=5, values_only=True):
    if row[0] is None: continue
    f = row[1]
    fecha = f.strftime('%Y-%m-%d') if hasattr(f, 'strftime') else str(f)[:10]
    out.append({'fecha': fecha, 'importe': row[10] or 0, 'plataforma': str(row[11] or ''),
                'cuotas': row[14], 'estado': str(row[23] or ''),
                'pago_envio': str(row[20] or ''), 'costo_envio': str(row[21] or '')})
print(json.dumps(out))
`;
  const out = execFileSync("python3", ["-c", py, archivo], { maxBuffer: 128 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

async function main() {
  loadEnv();
  const archivo = process.argv[2];
  if (!archivo) { console.error("Falta el archivo .xlsx"); process.exit(1); }
  const aplicar = process.argv.includes("--aplicar");
  const iPub = process.argv.indexOf("--publicidad");
  const publicidad = iPub > 0 ? parseFloat(process.argv[iPub + 1]) : null;

  const r = procesarTN(leerOrdenes(archivo), publicidad);
  for (const m of r.meses) {
    const mixStr = Object.entries(m.mix).sort((a, b) => a[0] - b[0]).map(([c, p]) => `${c}c:${p}%`).join("  ");
    console.log(`══ ${m.mes} ══ $${m.bruto.toLocaleString("es-AR")} (${m.ops} órdenes) · costo ${(m.costo_pct * 100).toFixed(2)}% · envíos $${m.envios.toLocaleString("es-AR")}${m.publicidad ? ` · publicidad $${m.publicidad.toLocaleString("es-AR")}` : ""}`);
    console.log(`   mix PagoNube: ${mixStr}`);
  }
  console.log(`(${r.canceladas} canceladas ignoradas)`);

  if (!aplicar) { console.log("\n(dry-run: corré con --aplicar)"); return; }
  const { neon } = require("@neondatabase/serverless");
  await guardarMixPagos(neon(process.env.DATABASE_URL), r.meses);
  console.log(`\n✅ ${r.meses.length} meses cargados`);
}

main().catch(e => { console.error(e); process.exit(1); });
