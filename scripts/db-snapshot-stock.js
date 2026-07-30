// Toma una foto del inventario y la guarda en la tabla stock.
// Se guarda una foto por día: el histórico de fotos permite calcular el stock
// promedio del período, que es lo que necesitan la rotación y el GMROI.
//
// Uso: node scripts/db-snapshot-stock.js [--aplicar]
const fs = require("fs");
const path = require("path");
const { fuentesStock } = require("../lib/stock");
const { normalizarProducto } = require("../lib/normalizar");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function crearTabla(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS stock (
      fecha DATE NOT NULL,
      local TEXT NOT NULL,
      producto_norm TEXT NOT NULL,
      sku TEXT,
      color TEXT,
      talle TEXT,
      cantidad NUMERIC NOT NULL,
      precio NUMERIC,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_stock_fecha ON stock (fecha)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_stock_producto ON stock (producto_norm, fecha)`;
  await sql`
    CREATE TABLE IF NOT EXISTS stock_estado (
      fecha DATE NOT NULL,
      local TEXT NOT NULL,
      estado TEXT NOT NULL,
      filas INT NOT NULL DEFAULT 0,
      unidades NUMERIC NOT NULL DEFAULT 0,
      error TEXT,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (fecha, local)
    )`;
}

// Exportada para que el cron la use también
async function snapshotStock(sql, fecha) {
  await crearTabla(sql);
  const resumen = [];

  await Promise.allSettled(fuentesStock().map(async ({ local, fn }) => {
    const r = await fn();
    if (!r.ok) {
      await sql`
        INSERT INTO stock_estado (fecha, local, estado, error)
        VALUES (${fecha}, ${local}, 'error', ${r.error})
        ON CONFLICT (fecha, local) DO UPDATE SET estado='error', error=EXCLUDED.error, actualizado_en=now()`;
      resumen.push({ local, ok: false, error: r.error });
      return;
    }
    // Reescribe la foto del día para ese local (idempotente)
    await sql`DELETE FROM stock WHERE fecha = ${fecha} AND local = ${local}`;
    const filas = r.filas;
    for (let i = 0; i < filas.length; i += 500) {
      const c = filas.slice(i, i + 500);
      await sql`
        INSERT INTO stock (fecha, local, producto_norm, sku, color, talle, cantidad, precio)
        SELECT * FROM UNNEST(
          ${c.map(() => fecha)}::date[],
          ${c.map(f => f.local)}::text[],
          ${c.map(f => normalizarProducto(f.producto).nombre)}::text[],
          ${c.map(f => f.sku || null)}::text[],
          ${c.map(f => f.color || null)}::text[],
          ${c.map(f => f.talle || null)}::text[],
          ${c.map(f => f.cantidad)}::numeric[],
          ${c.map(f => f.precio)}::numeric[]
        )`;
    }
    const unidades = filas.reduce((a, f) => a + f.cantidad, 0);
    await sql`
      INSERT INTO stock_estado (fecha, local, estado, filas, unidades)
      VALUES (${fecha}, ${local}, 'ok', ${filas.length}, ${unidades})
      ON CONFLICT (fecha, local) DO UPDATE SET
        estado='ok', filas=EXCLUDED.filas, unidades=EXCLUDED.unidades, error=NULL, actualizado_en=now()`;
    resumen.push({ local, ok: true, filas: filas.length, unidades: Math.round(unidades) });
  }));

  return resumen;
}

async function main() {
  loadEnv();
  const aplicar = process.argv.includes("--aplicar");
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const fecha = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  if (!aplicar) {
    console.log("Consultando inventario (dry-run, no escribe)…\n");
    for (const { local, fn } of fuentesStock()) {
      const r = await fn();
      const u = r.filas.reduce((a, f) => a + f.cantidad, 0);
      console.log(`  ${local.padEnd(11)} ${r.ok ? "OK " : "ERR"}  ${String(r.filas.length).padStart(4)} filas · ${Math.round(u).toLocaleString("es-AR").padStart(7)} u.${r.error ? "  → " + r.error : ""}`);
    }
    console.log("\n(corré con --aplicar para guardar la foto del día)");
    return;
  }

  console.log(`Snapshot de stock ${fecha}…\n`);
  const resumen = await snapshotStock(sql, fecha);
  for (const r of resumen) {
    console.log(`  ${r.local.padEnd(11)} ${r.ok ? `${String(r.filas).padStart(4)} filas · ${r.unidades.toLocaleString("es-AR").padStart(7)} u.` : "ERROR: " + r.error}`);
  }
  const [t] = await sql`SELECT COUNT(*)::int AS filas, ROUND(SUM(cantidad))::int AS u FROM stock WHERE fecha = ${fecha}`;
  console.log(`\n✅ ${t.filas} filas · ${t.u.toLocaleString("es-AR")} unidades guardadas para ${fecha}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { snapshotStock };
