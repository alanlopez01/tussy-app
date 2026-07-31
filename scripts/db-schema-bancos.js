// Tabla de movimientos bancarios (Galicia y futuros bancos).
// Uso: node scripts/db-schema-bancos.js
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function main() {
  // monto negativo = egreso, positivo = ingreso (a diferencia de egresos_mp,
  // que solo guarda salidas). El extracto trae las dos puntas.
  await sql`CREATE TABLE IF NOT EXISTS movimientos_banco (
    id text PRIMARY KEY,
    origen text NOT NULL DEFAULT 'galicia',
    fecha date NOT NULL,
    descripcion text,
    contraparte text,
    cuit bigint,
    monto numeric(14,2) NOT NULL,
    comprobante text,
    categoria text NOT NULL DEFAULT 'Otros',
    cargado_en timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS mb_fecha ON movimientos_banco (fecha)`;
  console.log("Tabla movimientos_banco creada.");
}
main();
