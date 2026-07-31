// Tabla de cobros: cómo se pagó cada venta. Va aparte de `ventas` porque una
// misma operación puede pagarse en varios medios (parte tarjeta, parte efectivo).
// Uso: node scripts/db-schema-cobros.js
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function main() {
  // medio: 'electronico' (tarjeta/QR) | 'efectivo' | 'otro'
  // detalle guarda la etiqueta original del sistema ("ELECTRON", "Chip and Pin", …)
  await sql`CREATE TABLE IF NOT EXISTS cobros (
    fecha date NOT NULL,
    local text NOT NULL,
    orden_id text NOT NULL,
    item int NOT NULL DEFAULT 1,
    medio text NOT NULL,
    detalle text,
    monto numeric(14,2) NOT NULL,
    PRIMARY KEY (local, orden_id, item)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS cobros_fecha ON cobros (fecha)`;
  await sql`CREATE INDEX IF NOT EXISTS cobros_medio ON cobros (medio)`;
  console.log("Tabla cobros creada.");
}
main();
