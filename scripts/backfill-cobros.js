// Trae de las fuentes cómo se pagó cada venta de un rango y lo guarda en `cobros`.
// Uso: node scripts/backfill-cobros.js 2026-07-01 2026-07-31
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFRango } = require("../lib/fuentes");

const sql = neon(process.env.DATABASE_URL);

async function guardar(cobros) {
  if (!cobros.length) return 0;
  let n = 0;
  for (let i = 0; i < cobros.length; i += 500) {
    const c = cobros.slice(i, i + 500);
    const r = await sql`
      INSERT INTO cobros (fecha, local, orden_id, item, medio, detalle, monto)
      SELECT * FROM UNNEST(
        ${c.map(f => f.fecha)}::date[], ${c.map(f => f.local)}::text[], ${c.map(f => f.orden_id)}::text[],
        ${c.map(f => f.item)}::int[], ${c.map(f => f.medio)}::text[],
        ${c.map(f => f.detalle || null)}::text[], ${c.map(f => f.monto)}::numeric[]
      ) ON CONFLICT (local, orden_id, item) DO UPDATE
        SET medio = EXCLUDED.medio, detalle = EXCLUDED.detalle, monto = EXCLUDED.monto, fecha = EXCLUDED.fecha
      RETURNING orden_id`;
    n += r.length;
  }
  return n;
}

function* dias(desde, hasta) {
  const d = new Date(`${desde}T12:00:00Z`), fin = new Date(`${hasta}T12:00:00Z`);
  while (d <= fin) { yield d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
}

async function main() {
  const [desde, hasta] = process.argv.slice(2);
  if (!desde || !hasta) { console.error("Uso: node scripts/backfill-cobros.js <desde> <hasta>"); process.exit(1); }

  // Dragonfish: un solo sweep por local cubre todo el rango
  for (const local of dfLocales()) {
    const r = await fetchDFRango(local, desde, hasta);
    if (!r.ok) { console.log(`${local.nombre}: ERROR ${r.error}`); continue; }
    const todos = Object.values(r.cobrosPorDia || {}).flat();
    console.log(`${local.nombre}: ${await guardar(todos)} cobros`);
  }

  // Woo y Tiendanube: día por día
  for (const local of wooLocales()) {
    let total = 0;
    for (const dia of dias(desde, hasta)) {
      const r = await fetchWooDia(local, dia);
      if (r.ok) total += await guardar(r.cobros || []);
    }
    console.log(`${local.nombre}: ${total} cobros`);
  }
  let tn = 0;
  for (const dia of dias(desde, hasta)) {
    const r = await fetchTNDia(dia);
    if (r.ok) tn += await guardar(r.cobros || []);
  }
  console.log(`Tiendanube: ${tn} cobros`);
}
main();
