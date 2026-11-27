// Carga la venta mensual de La Plata de 2024 y 2025, que no se puede obtener de
// ninguna fuente automática.
//
// La Plata vendía por un WooCommerce en localestussy.wnpower.host. Se dio de baja
// el dominio y wnpower confirmó en nov-2026 que borró la base: no hay backup. En
// los sistemas propios no quedó nada anterior a mar-2026 (ni en `ventas`, ni en
// las planillas viejas de Apps Script, ni en disco). Lo único recuperable por API
// fue la facturación de ARCA, que es la mitad de la venta porque el resto se
// cobra en efectivo y no se factura.
//
// Estos números los consiguió Alan por fuera del sistema en nov-2026: venta y
// unidades por mes, sin detalle de producto. Van escritos acá y no sólo en la
// base porque son irrecuperables: si se pierde la base, se pierden.
//
// Se cargan con la misma forma que los dos meses de 2026 que ya estaban cargados
// a mano (sistema 'manual', un renglón por mes, producto "VENTA SIN DETALLE").
// Es idempotente: borra los manuales de La Plata del rango y los vuelve a poner.
//
// Nada los pisa: el backfill borra por (fecha, local) antes de escribir, pero
// FUENTE_DESDE marca a La Plata desde 2026-08-19, así que nunca procesa estos días.
//
// Uso: node scripts/cargar-venta-historica-laplata.js [--escribir]
//      Sin --escribir sólo muestra lo que haría.
const fs = require("fs");

for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");

// mes 1..12 -> [pesos vendidos, unidades]
const VENTA = {
  2024: [
    [23644120, 1297], [25479669, 1313], [36901995, 1596], [41825653, 1608],
    [46303130, 1452], [58125735, 1814], [63014005, 1618], [54077265, 1417],
    [48657370, 1326], [48536740, 1473], [55212730, 1727], [147525750, 4663],
  ],
  2025: [
    [49456800, 1611], [43299670, 1387], [60540540, 1654], [73799290, 1886],
    [80431535, 2174], [65135205, 1518], [78689850, 1724], [69207210, 1770],
    [54627430, 1404], [59269810, 1636], [58375980, 1725], [127865170, 4219],
  ],
};
// Totales declarados en la planilla de origen, para que el script valide contra
// ellos en vez de confiar en que la transcripción mes a mes esté bien.
const TOTALES = { 2024: [649304162, 21304], 2025: [820698490, 22708] };

const pesos = n => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");
const ultimoDia = (a, m) => new Date(Date.UTC(m === 12 ? a + 1 : a, m === 12 ? 0 : m, 0))
  .toISOString().slice(0, 10);

async function main() {
  const escribir = process.argv.includes("--escribir");

  // Antes de tocar nada: la transcripción suma lo que dice la planilla?
  for (const [anio, filas] of Object.entries(VENTA)) {
    const sp = filas.reduce((a, f) => a + f[0], 0);
    const su = filas.reduce((a, f) => a + f[1], 0);
    const [tp, tu] = TOTALES[anio];
    if (sp !== tp || su !== tu) {
      console.error(`${anio}: la transcripción no cuadra con el total de la planilla.`);
      console.error(`  pesos: ${pesos(sp)} contra ${pesos(tp)}   unidades: ${su} contra ${tu}`);
      process.exit(1);
    }
    console.log(`${anio}: ${pesos(sp)} en ${su.toLocaleString("es-AR")} unidades  ✓ cuadra con la planilla`);
  }

  const sql = neon(process.env.DATABASE_URL);
  const filas = [];
  for (const [anio, meses] of Object.entries(VENTA)) {
    meses.forEach(([total, unidades], i) => {
      const mes = i + 1;
      filas.push({
        fecha: ultimoDia(Number(anio), mes),
        orden_id: `total-${anio}-${String(mes).padStart(2, "0")}`,
        cantidad: unidades,
        precio_unit: Math.round(total / unidades),
        total,
      });
    });
  }

  console.log(`\n${filas.length} renglones, uno por mes:`);
  for (const f of filas)
    console.log(`  ${f.fecha}  ${pesos(f.total).padStart(14)}  ${String(f.cantidad).padStart(5)} u  ${pesos(f.precio_unit).padStart(9)}/u`);

  if (!escribir) {
    console.log("\n(simulacro: volvé a correrlo con --escribir para cargarlo)");
    return;
  }

  const borradas = await sql`
    DELETE FROM ventas
     WHERE local = 'La Plata' AND sistema = 'manual'
       AND fecha >= '2024-01-01' AND fecha < '2026-01-01'`;
  for (const f of filas) {
    await sql`
      INSERT INTO ventas (fecha, local, sistema, orden_id, producto, producto_norm,
                          cantidad, precio_unit, total)
      VALUES (${f.fecha}, 'La Plata', 'manual', ${f.orden_id},
              'VENTA SIN DETALLE', 'VENTA SIN DETALLE',
              ${f.cantidad}, ${f.precio_unit}, ${f.total})`;
  }

  const r = await sql`
    SELECT extract(year from fecha)::int anio, count(*)::int n,
           round(sum(total))::bigint total, sum(cantidad)::int unidades
      FROM ventas WHERE local = 'La Plata' AND sistema = 'manual'
     GROUP BY 1 ORDER BY 1`;
  console.log("\nCargado. Renglones manuales de La Plata en la base:");
  for (const x of r)
    console.log(`  ${x.anio}  ${x.n} meses  ${pesos(x.total).padStart(14)}  ${Number(x.unidades).toLocaleString("es-AR")} unidades`);
}

main().catch(e => { console.error(e); process.exit(1); });
