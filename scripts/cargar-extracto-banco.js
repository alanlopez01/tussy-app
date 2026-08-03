// Carga un extracto bancario (por ahora Galicia) a movimientos_banco.
// Uso: node scripts/cargar-extracto-banco.js <archivo.csv>
// Idempotente: los movimientos repetidos no duplican.
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const { parsearGalicia } = require("../lib/bancos");

async function main() {
  const archivo = process.argv[2];
  if (!archivo) { console.error("Uso: node scripts/cargar-extracto-banco.js <archivo.csv>"); process.exit(1); }
  const { filas } = parsearGalicia(fs.readFileSync(archivo, "utf8"));
  const sql = neon(process.env.DATABASE_URL);
  let nuevas = 0;
  for (let i = 0; i < filas.length; i += 1000) {
    const lote = filas.slice(i, i + 1000);
    const a = fn => lote.map(fn);
    const r = await sql`INSERT INTO movimientos_banco
      (id, origen, fecha, descripcion, contraparte, cuit, monto, comprobante, categoria)
      SELECT * FROM unnest(
        ${a(f => f.id)}::text[], ${a(f => f.origen)}::text[], ${a(f => f.fecha)}::date[],
        ${a(f => f.descripcion)}::text[], ${a(f => f.contraparte)}::text[], ${a(f => f.cuit)}::bigint[],
        ${a(f => f.monto)}::numeric[], ${a(f => f.comprobante)}::text[], ${a(f => f.categoria)}::text[]
      ) AS x(id, origen, fecha, descripcion, contraparte, cuit, monto, comprobante, categoria)
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    nuevas += r.length;
  }
  console.log(`${nuevas} nuevos de ${filas.length} movimientos`);
}
main();
