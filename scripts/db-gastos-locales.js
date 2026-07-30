// Gastos fijos mensuales por local y de la fábrica.
// Esquema clave-valor: (local, vigente_desde, concepto, monto) — permite agregar
// conceptos nuevos sin migrar la tabla. Versionado por mes: al cargar un mes nuevo,
// los meses anteriores conservan sus valores y el histórico no se altera.
//
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

// Costos vigentes informados por Alan (30/07/2026). Sin cambios entre junio y julio.
const VIGENTE_DESDE = "2026-06";

const GASTOS = {
  "Palermo": { alquiler: 6285405, sueldos: 4895309, franqueros: 500000, impuestos_varios: 1200000 },
  // La Plata paga el alquiler en dos partes: efectivo $681.000 + transferencia $865.218
  "La Plata": { alquiler: 681000 + 865218, sueldos: 1171177, franqueros: 1600000, impuestos_varios: 1100000 },
  "Dot": { alquiler: 13442560, sueldos: 4224409 },
  "Abasto": { alquiler: 19067304, sueldos: 5068466 },
  "Córdoba": { alquiler: 3716949, sueldos: 4520000 },
};

// Gastos de la red de locales: se prorratean entre los 5 según su venta del mes
const COMPARTIDOS = { supervisor: 2000000, limpieza: 200000 };

// Fábrica de estampado: fijo mensual, se prorratea entre TODOS los canales por venta
const FABRICA = { empleados: 20083000, alquiler: 3200000, servicios: 280000, limpieza: 150000, flete: 2000000 };

const ETIQUETAS = {
  alquiler: "Alquiler", sueldos: "Sueldos", franqueros: "Franqueros",
  impuestos_varios: "Impuestos y varios", empleados: "Empleados", servicios: "Servicios",
  limpieza: "Limpieza", flete: "Flete", supervisor: "Supervisor",
};

async function main() {
  loadEnv();
  const aplicar = process.argv.includes("--aplicar");
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const fmt = n => "$" + Math.round(n).toLocaleString("es-AR");

  console.log(`Gastos fijos vigentes desde ${VIGENTE_DESDE}:\n`);
  let totalLocales = 0;
  for (const [local, conceptos] of Object.entries(GASTOS)) {
    const t = Object.values(conceptos).reduce((a, v) => a + v, 0);
    totalLocales += t;
    const detalle = Object.entries(conceptos).map(([k, v]) => `${ETIQUETAS[k]} ${fmt(v)}`).join(" · ");
    console.log(`  ${local.padEnd(10)} ${fmt(t).padStart(13)}   ${detalle}`);
  }
  const compartidos = Object.values(COMPARTIDOS).reduce((a, v) => a + v, 0);
  const fabrica = Object.values(FABRICA).reduce((a, v) => a + v, 0);
  console.log(`  ${"".padEnd(10)} ${"".padStart(13)}`);
  console.log(`  Subtotal locales:     ${fmt(totalLocales)}`);
  console.log(`  Compartidos (supervisor + limpieza, prorrateado entre locales): ${fmt(compartidos)}`);
  console.log(`  Fábrica (prorrateada entre todos los canales): ${fmt(fabrica)}`);
  console.log(`  TOTAL ESTRUCTURA:     ${fmt(totalLocales + compartidos + fabrica)}`);

  if (!aplicar) { console.log("\n(dry-run: corré con --aplicar)"); return; }

  await sql`
    CREATE TABLE IF NOT EXISTS gastos_fijos (
      local TEXT NOT NULL,
      vigente_desde TEXT NOT NULL,
      concepto TEXT NOT NULL,
      monto NUMERIC NOT NULL,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (local, vigente_desde, concepto)
    )`;

  const escribir = async (local, conceptos) => {
    for (const [concepto, monto] of Object.entries(conceptos)) {
      await sql`
        INSERT INTO gastos_fijos (local, vigente_desde, concepto, monto)
        VALUES (${local}, ${VIGENTE_DESDE}, ${concepto}, ${monto})
        ON CONFLICT (local, vigente_desde, concepto)
        DO UPDATE SET monto = EXCLUDED.monto, actualizado_en = now()`;
    }
  };
  for (const [local, conceptos] of Object.entries(GASTOS)) await escribir(local, conceptos);
  await escribir("__compartidos__", COMPARTIDOS);
  await escribir("__fabrica__", FABRICA);

  // La estructura vieja (columnas fijas) queda obsoleta
  await sql`DROP TABLE IF EXISTS gastos_local`;

  console.log(`\n✅ ${Object.keys(GASTOS).length} locales + compartidos + fábrica cargados con vigencia ${VIGENTE_DESDE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
