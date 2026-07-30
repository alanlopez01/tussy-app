// Estima los gastos fijos de marzo, abril y mayo 2026 deflactando los de junio
// por el IPC de INDEC. Son ESTIMACIONES: quedan marcadas como tales para que se
// puedan reemplazar por los valores reales cuando estén.
//
// IPC mensual 2026 (INDEC): mar 3,4% · abr 2,6% · may 2,1% · jun 1,9%
// Para llevar un costo de junio a mayo se divide por (1 + IPC de junio), y así
// hacia atrás mes por mes.
//
// Uso: node scripts/db-estimar-fijos-historicos.js [--aplicar]
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// IPC del mes: cuánto subieron los precios DURANTE ese mes
const IPC = { "2026-04": 0.026, "2026-05": 0.021, "2026-06": 0.019 };
const BASE = "2026-06";
const MESES_A_ESTIMAR = ["2026-03", "2026-04", "2026-05"];

// Factor para llevar un costo de junio hacia atrás hasta `mes`
function factorDesdeBase(mes) {
  let f = 1;
  // De junio a mayo: dividir por el IPC de junio. De mayo a abril: por el de mayo. Etc.
  const orden = ["2026-06", "2026-05", "2026-04", "2026-03"];
  for (let i = 0; i < orden.length - 1; i++) {
    f /= 1 + (IPC[orden[i]] || 0);
    if (orden[i + 1] === mes) break;
  }
  return f;
}

async function main() {
  loadEnv();
  const aplicar = process.argv.includes("--aplicar");
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const fmt = n => "$" + Math.round(n).toLocaleString("es-AR");

  const base = await sql`
    SELECT local, concepto, monto FROM gastos_fijos WHERE vigente_desde = ${BASE}`;
  if (!base.length) { console.error(`No hay gastos con vigencia ${BASE}`); process.exit(1); }

  console.log(`Estimando gastos fijos hacia atrás desde ${BASE}, deflactando por IPC INDEC:\n`);
  const filas = [];
  for (const mes of MESES_A_ESTIMAR) {
    const f = factorDesdeBase(mes);
    const porLocal = {};
    for (const g of base) {
      const monto = Math.round(Number(g.monto) * f);
      (porLocal[g.local] = porLocal[g.local] || {})[g.concepto] = monto;
      filas.push({ mes, local: g.local, concepto: g.concepto, monto });
    }
    const total = Object.values(porLocal)
      .filter((_, i) => true)
      .reduce((a, c) => a + Object.entries(c).filter(([k]) => !k.endsWith("sin_cargas")).reduce((x, [, v]) => x + v, 0), 0);
    console.log(`  ${mes}  factor ${f.toFixed(4)}  →  estructura total ${fmt(total)}`);
  }
  const totalBase = base.filter(g => !g.concepto.endsWith("sin_cargas")).reduce((a, g) => a + Number(g.monto), 0);
  console.log(`  ${BASE}  (real)          →  estructura total ${fmt(totalBase)}`);

  if (!aplicar) { console.log("\n(dry-run: corré con --aplicar)"); return; }

  await sql`ALTER TABLE gastos_fijos ADD COLUMN IF NOT EXISTS estimado BOOLEAN NOT NULL DEFAULT false`;
  for (const f of filas) {
    await sql`
      INSERT INTO gastos_fijos (local, vigente_desde, concepto, monto, estimado)
      VALUES (${f.local}, ${f.mes}, ${f.concepto}, ${f.monto}, true)
      ON CONFLICT (local, vigente_desde, concepto)
      DO UPDATE SET monto = EXCLUDED.monto, estimado = true, actualizado_en = now()`;
  }
  console.log(`\n✅ ${filas.length} valores estimados cargados (marcados como estimados)`);
}

main().catch(e => { console.error(e); process.exit(1); });
