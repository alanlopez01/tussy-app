// Migración del bloque Rentabilidad:
//  1) columna ventas.producto_norm (modelo normalizado) + índices
//  2) tabla costos_producto (costo unitario versionado por fecha de vigencia)
//  3) backfill de producto_norm para todo el histórico
// Idempotente: se puede correr más de una vez.
// Uso: node scripts/db-migrar-rentabilidad.js
const fs = require("fs");
const path = require("path");
const { normalizarProducto } = require("../lib/normalizar");

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

  await sql`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS producto_norm TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ventas_producto_norm ON ventas (producto_norm)`;
  await sql`
    CREATE TABLE IF NOT EXISTS costos_producto (
      producto TEXT NOT NULL,
      costo NUMERIC NOT NULL,
      vigente_desde DATE NOT NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (producto, vigente_desde)
    )`;
  console.log("Esquema listo (producto_norm + costos_producto)");

  // Backfill de producto_norm: mapear cada nombre crudo distinto a su modelo
  const pendientes = await sql`
    SELECT DISTINCT producto FROM ventas WHERE producto_norm IS NULL`;
  console.log(`Nombres crudos a normalizar: ${pendientes.length}`);

  for (let i = 0; i < pendientes.length; i += 100) {
    const chunk = pendientes.slice(i, i + 100);
    const crudos = chunk.map(r => r.producto);
    const norms = chunk.map(r => normalizarProducto(r.producto).nombre);
    await sql`
      UPDATE ventas AS v SET producto_norm = m.norm
      FROM (SELECT * FROM UNNEST(${crudos}::text[], ${norms}::text[]) AS t(crudo, norm)) AS m
      WHERE v.producto = m.crudo AND v.producto_norm IS NULL`;
    console.log(`  ${Math.min(i + 100, pendientes.length)}/${pendientes.length}`);
  }

  const [{ sin }] = await sql`SELECT COUNT(*)::int AS sin FROM ventas WHERE producto_norm IS NULL`;
  const [{ modelos }] = await sql`SELECT COUNT(DISTINCT producto_norm)::int AS modelos FROM ventas WHERE producto NOT IN ('ENVIO','DESCUENTO','AJUSTE')`;
  console.log(`\nListo. Filas sin normalizar: ${sin} · Modelos distintos: ${modelos}`);
}

main().catch(e => { console.error(e); process.exit(1); });
