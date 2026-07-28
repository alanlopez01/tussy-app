// Crea el esquema inicial en Neon Postgres.
// Uso: node scripts/db-schema.js  (lee DATABASE_URL de .env.development.local)
const fs = require("fs");
const path = require("path");

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

  await sql`
    CREATE TABLE IF NOT EXISTS ventas (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fecha DATE NOT NULL,
      local TEXT NOT NULL,
      sistema TEXT NOT NULL,
      orden_id TEXT,
      producto TEXT NOT NULL,
      sku TEXT,
      color TEXT,
      talle TEXT,
      cantidad NUMERIC NOT NULL DEFAULT 0,
      precio_unit NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas (fecha)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ventas_local_fecha ON ventas (local, fecha)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ventas_orden ON ventas (sistema, orden_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS sync_estado (
      fecha DATE NOT NULL,
      local TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      intentos INT NOT NULL DEFAULT 0,
      ultimo_error TEXT,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (fecha, local)
    )`;

  const tablas = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name`;
  console.log("Tablas creadas:", tablas.map(t => t.table_name).join(", "));
}

main().catch(e => { console.error(e); process.exit(1); });
