// Trae el cliente de cada orden histórica de Tiendanube a clientes_tn.
// Uso: node scripts/backfill-clientes-tn.js 2026-02-01 2026-07-31
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const { fetchTNDia } = require("../lib/fuentes");

const sql = neon(process.env.DATABASE_URL);

async function main() {
  const [desde, hasta] = process.argv.slice(2);
  if (!desde || !hasta) { console.error("Uso: node scripts/backfill-clientes-tn.js <desde> <hasta>"); process.exit(1); }
  const d = new Date(`${desde}T12:00:00Z`), fin = new Date(`${hasta}T12:00:00Z`);
  let total = 0;
  while (d <= fin) {
    const dia = d.toISOString().slice(0, 10);
    const r = await fetchTNDia(dia);
    if (r.ok && r.clientes?.length) {
      const c = r.clientes;
      await sql`INSERT INTO clientes_tn (orden_id, cliente_id, fecha, total)
        SELECT * FROM UNNEST(
          ${c.map(x => x.orden_id)}::text[], ${c.map(x => x.cliente_id)}::bigint[],
          ${c.map(x => x.fecha)}::date[], ${c.map(x => x.total)}::numeric[]
        ) ON CONFLICT (orden_id) DO UPDATE SET cliente_id = EXCLUDED.cliente_id`;
      total += c.length;
    } else if (!r.ok) {
      console.log(dia, "ERROR", r.error);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  console.log(`clientes_tn: ${total} órdenes cargadas`);
}
main();
