// Rellena cobros.comision / comision_exacta de las ventas de MercadoLibre que
// se ingestaron antes de que fetchMeliDia capturara lo que se queda el canal.
//
// Toca SOLO esas dos columnas: no reescribe ventas ni montos. La ingesta de los
// últimos 7 días se corrige sola, así que esto es para los días anteriores.
//
// Uso: node scripts/meli-backfill-comisiones.js [desde] [hasta]
//      (default: 2026-10-20 → ayer, que es desde que existe el canal)
const fs = require("fs");
const path = require("path");
const { fetchMeliDia, diaSiguiente } = require("../lib/fuentes");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnv();
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  const ayer = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const desde = process.argv[2] || "2026-10-20";
  const hasta = process.argv[3] || ayer;

  const dias = [];
  for (let d = desde; d <= hasta; d = diaSiguiente(d)) dias.push(d);
  console.log(`MELI: comisiones de ${desde} a ${hasta} (${dias.length} días)\n`);

  let totVenta = 0, totCom = 0, totOrd = 0, sinDato = 0;
  for (const dia of dias) {
    const r = await fetchMeliDia(dia);
    if (!r.ok) { console.log(`${dia}  ERROR: ${r.error}`); continue; }
    const conCom = (r.cobros || []).filter(c => c.comision > 0);
    if (!conCom.length) { console.log(`${dia}  sin ventas`); continue; }

    for (const c of conCom) {
      await sql`UPDATE cobros SET comision = ${c.comision}, comision_exacta = ${!!c.comision_exacta}
                 WHERE local = 'MercadoLibre' AND orden_id = ${c.orden_id} AND item = ${c.item}`;
      if (!c.comision_exacta) sinDato++;
    }
    const venta = r.filas.reduce((s, x) => s + x.total, 0);
    const com = conCom.reduce((s, c) => s + c.comision, 0);
    totVenta += venta; totCom += com; totOrd += conCom.length;
    console.log(`${dia}  ${String(conCom.length).padStart(3)} órd  venta ${Math.round(venta).toLocaleString("es-AR").padStart(12)}  MELI se queda ${Math.round(com).toLocaleString("es-AR").padStart(10)}  ${(com / venta * 100).toFixed(1)}%`);
  }

  console.log(`\nTotal: ${totOrd} órdenes · venta $${Math.round(totVenta).toLocaleString("es-AR")} · se queda MELI $${Math.round(totCom).toLocaleString("es-AR")} = ${(totCom / totVenta * 100).toFixed(1)}%`);
  if (sinDato) console.log(`Ojo: ${sinDato} órdenes quedaron sin el costo de envío (comision_exacta = false).`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
