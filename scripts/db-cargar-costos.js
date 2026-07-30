// Carga masiva de costos desde la planilla Costos-Tussy.xlsx (hoja Producción).
// Costo cargado = costo de producción de la familia + estampa/bordado.
// La estructura (fábrica) NO se incluye acá: se prorratea a nivel canal en la fase 3,
// con las unidades reales de cada mes (en la planilla quedaba congelada en un mes).
//
// Uso: node scripts/db-cargar-costos.js            → muestra el mapeo (no toca la base)
//      node scripts/db-cargar-costos.js --aplicar  → inserta en costos_producto
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { costear, VIGENTE_DESDE } = require("../lib/costeo");

async function main() {
  loadEnv();
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const aplicar = process.argv.includes("--aplicar");

  const modelos = await sql`
    SELECT producto_norm AS producto, SUM(cantidad)::int AS unidades, ROUND(SUM(total))::bigint AS venta
    FROM ventas
    WHERE producto NOT IN ('ENVIO','DESCUENTO','AJUSTE') AND producto_norm IS NOT NULL
    GROUP BY producto_norm ORDER BY SUM(total) DESC`;

  const mapeados = [], sinMapear = [];
  for (const m of modelos) {
    const c = costear(m.producto);
    if (c) mapeados.push({ ...m, ...c, costo: Math.round(c.prod + c.estampa) });
    else sinMapear.push(m);
  }

  const ventaTotal = modelos.reduce((a, m) => a + Number(m.venta), 0);
  const ventaMapeada = mapeados.reduce((a, m) => a + Number(m.venta), 0);

  console.log(`Modelos: ${modelos.length} · mapeados: ${mapeados.length} · sin mapear: ${sinMapear.length}`);
  console.log(`Cobertura de venta: ${(ventaMapeada / ventaTotal * 100).toFixed(1)}% de $${Math.round(ventaTotal / 1e6)}M\n`);

  const porFamilia = {};
  for (const m of mapeados) {
    if (!porFamilia[m.familia]) porFamilia[m.familia] = { modelos: 0, unidades: 0, costo: m.costo };
    porFamilia[m.familia].modelos++;
    porFamilia[m.familia].unidades += m.unidades;
  }
  console.log("Familia → costo (producción + estampa) · modelos · unidades históricas:");
  for (const [f, d] of Object.entries(porFamilia).sort((a, b) => b[1].unidades - a[1].unidades)) {
    console.log(`  ${f.padEnd(32)} $${d.costo.toLocaleString("es-AR").padStart(8)} · ${String(d.modelos).padStart(3)} modelos · ${d.unidades} u.`);
  }

  console.log(`\nSIN MAPEAR (quedan "sin costo" para cargar a mano):`);
  for (const m of sinMapear.slice(0, 30)) {
    console.log(`  ${m.producto.padEnd(40)} ${String(m.unidades).padStart(5)} u. · $${Number(m.venta).toLocaleString("es-AR")}`);
  }
  if (sinMapear.length > 30) console.log(`  … y ${sinMapear.length - 30} más (menor volumen)`);

  if (!aplicar) {
    console.log(`\n(dry-run: nada se escribió — corré con --aplicar para cargar, vigencia ${VIGENTE_DESDE})`);
    return;
  }

  for (let i = 0; i < mapeados.length; i += 100) {
    const c = mapeados.slice(i, i + 100);
    await sql`
      INSERT INTO costos_producto (producto, costo, vigente_desde)
      SELECT * FROM UNNEST(${c.map(m => m.producto)}::text[], ${c.map(m => m.costo)}::numeric[], ${c.map(() => VIGENTE_DESDE)}::date[])
      ON CONFLICT (producto, vigente_desde) DO UPDATE SET costo = EXCLUDED.costo, creado_en = now()`;
  }
  console.log(`\n✅ ${mapeados.length} costos cargados con vigencia ${VIGENTE_DESDE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
