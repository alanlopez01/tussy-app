// Tabla de la tela que consumió Shato, leída del sistema de producción (KALYZ).
// Es un ESPEJO: no se carga a mano y se puede borrar y volver a sincronizar.
// Uso: node scripts/db-schema-telas.js
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function main() {
  // linea_id es el id de la línea de consumo en KALYZ (produccion.cortes_telas):
  // la clave natural, así resincronizar no duplica.
  // precio null = la tela no tiene precio de transferencia cargado; monto 0 y la
  // pantalla lo dice. No se inventa un precio (misma regla que KALYZ 0271).
  await sql`CREATE TABLE IF NOT EXISTS telas_consumidas (
    linea_id        uuid PRIMARY KEY,
    fecha           date NOT NULL,
    corte           bigint,
    tela            text NOT NULL,
    cantidad        numeric(14,2) NOT NULL DEFAULT 0,
    unidad          text NOT NULL DEFAULT 'kg',
    precio          numeric(14,2),
    monto           numeric(14,2) NOT NULL DEFAULT 0,
    registrado_en   timestamptz,
    sincronizado_en timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS telas_consumidas_fecha ON telas_consumidas (fecha)`;

  const [n] = await sql`SELECT count(*)::int n FROM telas_consumidas`;
  console.log(`telas_consumidas lista (${n.n} filas).`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
