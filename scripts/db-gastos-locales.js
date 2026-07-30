// Crea la tabla gastos_local y carga los fijos mensuales de la planilla (Config A57:F65).
// Versionado por mes de vigencia: cuando cambien, se carga un mes nuevo y el histórico queda intacto.
// Uso: node scripts/db-gastos-locales.js [--aplicar]
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const VIGENTE_DESDE = "2026-03";

// Config A57:F65 de Costos-Tussy.xlsx
const GASTOS = [
  { local: "Abasto",   empleados: 6733320, alquiler: 17500000, flete: 200000, libreria: 150000, bolsas: 1715076 },
  { local: "Dot",      empleados: 6733320, alquiler: 11250000, flete: 200000, libreria: 150000, bolsas: 1069320 },
  { local: "Palermo",  empleados: 8400000, alquiler:  5300000, flete: 200000, libreria: 150000, bolsas: 1756740 },
  { local: "La Plata", empleados: 3960000, alquiler:  1200000, flete:      0, libreria: 150000, bolsas: 1290822 },
  { local: "Córdoba",  empleados: 4800000, alquiler:  3100000, flete: 450000, libreria: 150000, bolsas: 1708366 },
];

// Fábrica de estampado: fijo mensual que sirve a TODOS los canales.
// Se prorratea por % de venta de cada canal en el mes (no se congela por prenda).
const FABRICA = 24142645;
const PLAN_TIENDANUBE = 700000;   // Config B31
const PACKAGING_UNIDAD = 800;     // Config B32

async function main() {
  loadEnv();
  const aplicar = process.argv.includes("--aplicar");
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  console.log(`Gastos fijos mensuales por local (vigencia desde ${VIGENTE_DESDE}):\n`);
  let total = 0;
  for (const g of GASTOS) {
    const t = g.empleados + g.alquiler + g.flete + g.libreria + g.bolsas;
    total += t;
    console.log(`  ${g.local.padEnd(10)} $${t.toLocaleString("es-AR").padStart(11)}   (empleados $${g.empleados.toLocaleString("es-AR")} · alquiler $${g.alquiler.toLocaleString("es-AR")})`);
  }
  console.log(`  ${"TOTAL".padEnd(10)} $${total.toLocaleString("es-AR").padStart(11)}`);
  console.log(`\n  Fábrica de estampado (todos los canales): $${FABRICA.toLocaleString("es-AR")}/mes`);
  console.log(`  Plan Tiendanube: $${PLAN_TIENDANUBE.toLocaleString("es-AR")}/mes · Packaging web: $${PACKAGING_UNIDAD}/unidad`);

  if (!aplicar) { console.log("\n(dry-run: corré con --aplicar)"); return; }

  await sql`
    CREATE TABLE IF NOT EXISTS gastos_local (
      local TEXT NOT NULL,
      vigente_desde TEXT NOT NULL,
      empleados NUMERIC NOT NULL DEFAULT 0,
      alquiler NUMERIC NOT NULL DEFAULT 0,
      flete NUMERIC NOT NULL DEFAULT 0,
      libreria NUMERIC NOT NULL DEFAULT 0,
      bolsas NUMERIC NOT NULL DEFAULT 0,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (local, vigente_desde)
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS config_negocio (
      clave TEXT PRIMARY KEY,
      valor NUMERIC NOT NULL,
      descripcion TEXT,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  for (const g of GASTOS) {
    await sql`
      INSERT INTO gastos_local (local, vigente_desde, empleados, alquiler, flete, libreria, bolsas)
      VALUES (${g.local}, ${VIGENTE_DESDE}, ${g.empleados}, ${g.alquiler}, ${g.flete}, ${g.libreria}, ${g.bolsas})
      ON CONFLICT (local, vigente_desde) DO UPDATE SET
        empleados = EXCLUDED.empleados, alquiler = EXCLUDED.alquiler, flete = EXCLUDED.flete,
        libreria = EXCLUDED.libreria, bolsas = EXCLUDED.bolsas, actualizado_en = now()`;
  }

  const cfg = [
    ["fabrica_mensual", FABRICA, "Fábrica de estampado: fijo mensual, se prorratea por % de venta de cada canal"],
    ["plan_tiendanube", PLAN_TIENDANUBE, "Suscripción mensual de Tiendanube"],
    ["packaging_unidad", PACKAGING_UNIDAD, "Packaging por unidad vendida en web"],
    ["tn_costo_pct", 0.064009, "PagoNube 1 pago c/IVA (fallback si no hay mix del mes)"],
    ["tn_transf_pct", 0.01295, "Transferencias: comisión TN 0.605% + IIBB 0.09% + créd/déb 0.6%"],
    ["iva_neto_pct", 0.04, "IVA neto sobre ventas declaradas"],
  ];
  for (const [clave, valor, desc] of cfg) {
    await sql`
      INSERT INTO config_negocio (clave, valor, descripcion) VALUES (${clave}, ${valor}, ${desc})
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, descripcion = EXCLUDED.descripcion, actualizado_en = now()`;
  }
  console.log(`\n✅ ${GASTOS.length} locales y ${cfg.length} parámetros cargados`);
}

main().catch(e => { console.error(e); process.exit(1); });
