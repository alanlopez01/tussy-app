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

const VIGENTE_DESDE = "2026-03-01";

// Costos de producción por familia (hoja Producción, filas 5-29)
const PROD = {
  REMERA: 7932.37, MUSCULOSA: 6095.87, BUZO: 15684.8, PANTALON: 11563.26,
  BERMUDA: 7463.93, CAMPERA_GABARDINA: 20524.8, REMERA_ML: 9007.65,
  CAMPERA_CALABRIA: 9022.55, PANTALON_CALABRIA: 6378.28,
  POLO: 8355.865, POLO_MUJER: 7287.97, CAMISA: 8164.53, CHOMBA: 9315.71,
  JEAN: 28000, SWEATER: 40000, BOXER: 3000, PIN: 2500, LLAVERO: 3500,
  MEDIAS: 2650, REMERA_MUJER: 4250, PACK_REMERA: 15864.74,
  GORRA: 8500, PERFUMINA: 5200, TOTE_BAG: 3500, PANUELO: 3500,
  BUZO_KAYNE: 17684.8, BUZO_ICE_PEARLS: 17684.8,
  PANTALON_LOTUS: 23750, CAMPERA_LOTUS: 23750,
  CAMPERA_PROM: 17765.783333333333, // promedio camperas (planilla fila 67)
  CROPTOP: 4200, JOGGING: 13897.18, PANTALON_PROM: 13897.18,
};
const ESTAMPA_DEFAULT = 2000;

// Reglas específicas por modelo (prioridad sobre la categoría).
// Cada regla: test sobre el nombre normalizado → { prod, estampa, familia }
const REGLAS = [
  // Campera Tssy Dizzy = costo del buzo + $13.450 (regla de Alan)
  { test: n => n.includes("CAMPERA") && n.includes("DIZZY"), prod: PROD.BUZO + 13450, familia: "Campera Dizzy (buzo + $13.450)" },
  // Doppler = mismo costo que Lotus (regla de Alan)
  { test: n => n.includes("CAMPERA") && (n.includes("LOTUS") || n.includes("DOPPLER")), prod: PROD.CAMPERA_LOTUS, familia: "Campera Lotus/Doppler" },
  { test: n => n.includes("PANTALON") && (n.includes("LOTUS") || n.includes("DOPPLER")), prod: PROD.PANTALON_LOTUS, familia: "Pantalón Lotus/Doppler" },
  { test: n => n.includes("CAMPERA") && n.includes("CALABRIA"), prod: PROD.CAMPERA_CALABRIA, familia: "Campera Calabria" },
  // "PANT ..." es como cargan pantalón en los locales
  { test: n => /(^|\s)PANT(\s|$)/.test(n) && n.includes("CALABRIA"), prod: PROD.PANTALON_CALABRIA, familia: "Pantalón Calabria" },
  { test: n => /(^|\s)PANT(\s|$)/.test(n) && (n.includes("LOTUS") || n.includes("DOPPLER")), prod: PROD.PANTALON_LOTUS, familia: "Pantalón Lotus/Doppler" },
  { test: n => /(^|\s)PANT(\s|$)/.test(n), prod: PROD.PANTALON_PROM, familia: "Pantalón (promedio)" },
  { test: n => n.includes("PANTALON") && n.includes("CALABRIA"), prod: PROD.PANTALON_CALABRIA, familia: "Pantalón Calabria" },
  { test: n => n.includes("CAMPERA") && n.includes("GABARDINA"), prod: PROD.CAMPERA_GABARDINA, familia: "Campera Gabardina" },
  { test: n => n.includes("BUZO") && n.includes("KAYNE"), prod: PROD.BUZO_KAYNE, familia: "Buzo Kayne" },
  { test: n => n.includes("BUZO") && (n.includes("ICE PEARL") || n.includes("PEARL")), prod: PROD.BUZO_ICE_PEARLS, familia: "Buzo Ice Pearls" },
  // Camiseta Arg = mismo costo que chomba deportiva (regla de Alan)
  { test: n => n.includes("CAMISETA"), prod: PROD.CHOMBA, familia: "Camiseta Arg (=Chomba)" },
  { test: n => n.includes("REMERA") && n.includes("MUJER"), prod: PROD.REMERA_MUJER, familia: "Remera Mujer" },
  { test: n => n.includes("POLO") && n.includes("MUJER"), prod: PROD.POLO_MUJER, familia: "Polo Mujer" },
  { test: n => n.includes("PACK") && n.includes("REMERA"), prod: PROD.PACK_REMERA, estampa: 0, familia: "Pack Remera x2" },
  // Accesorios: costo ya final, la estampa/bordado está incluida
  { test: n => n.includes("GORRA") || n.includes("PILUSO"), prod: PROD.GORRA, estampa: 0, familia: "Gorra / Piluso" },
  { test: n => n.includes("PERFUMINA"), prod: PROD.PERFUMINA, estampa: 0, familia: "Perfumina" },
  { test: n => n.includes("TOTE"), prod: PROD.TOTE_BAG, estampa: 0, familia: "Tote Bag" },
  { test: n => n.includes("PANUELO") || n.includes("PAÑUELO"), prod: PROD.PANUELO, estampa: 0, familia: "Pañuelo" },
  // "BASIC SHIRT" = remera lisa, sin estampa
  { test: n => n.includes("BASIC") && n.includes("SHIRT"), prod: PROD.REMERA, estampa: 0, familia: "Remera lisa (Basic Shirt)" },
];

// Categorías generales (orden de la planilla: la primera que matchea gana)
const CATEGORIAS = [
  { clave: "JEAN", prod: PROD.JEAN, familia: "Jean" },
  // Todos los sweaters = Sweater Jacquard (regla de Alan)
  { clave: "SWEATER", prod: PROD.SWEATER, familia: "Sweater (=Jacquard)" },
  { clave: "POLO", prod: PROD.POLO, familia: "Polo (promedio)" },
  { clave: "CAMISA", prod: PROD.CAMISA, familia: "Camisa" },
  { clave: "BUZO", prod: PROD.BUZO, familia: "Buzo" },
  { clave: "CAMPERA", prod: PROD.CAMPERA_PROM, familia: "Campera (promedio)" },
  { clave: "JOGGING", prod: PROD.JOGGING, familia: "Jogging" },
  { clave: "PANTALON", prod: PROD.PANTALON_PROM, familia: "Pantalón (promedio)" },
  { clave: "BERMUDA", prod: PROD.BERMUDA, familia: "Bermuda" },
  { clave: "MUSCULOSA", prod: PROD.MUSCULOSA, familia: "Musculosa" },
  { clave: "CHOMBA", prod: PROD.CHOMBA, familia: "Chomba" },
  { clave: "BOXER", prod: PROD.BOXER, estampa: 650, familia: "Boxer" },
  { clave: "PIN", prod: PROD.PIN, estampa: 0, familia: "Pin" },
  { clave: "LLAVERO", prod: PROD.LLAVERO, estampa: 0, familia: "Llavero" },
  { clave: "MEDIAS", prod: PROD.MEDIAS, estampa: 650, familia: "Medias" },
  { clave: "CROPTOP", prod: PROD.CROPTOP, estampa: 0, familia: "Croptop" },
  { clave: "REMERA", prod: PROD.REMERA, familia: "Remera" },
  { clave: "T SHIRT", prod: PROD.REMERA, familia: "Remera (t-shirt)" },
];

function costear(nombre) {
  for (const r of REGLAS) {
    if (r.test(nombre)) {
      return { familia: r.familia, prod: r.prod, estampa: r.estampa ?? ESTAMPA_DEFAULT };
    }
  }
  for (const c of CATEGORIAS) {
    if (nombre.includes(c.clave)) {
      return { familia: c.familia, prod: c.prod, estampa: c.estampa ?? ESTAMPA_DEFAULT };
    }
  }
  return null;
}

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
