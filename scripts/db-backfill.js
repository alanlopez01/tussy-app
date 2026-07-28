// Backfill: carga el histórico de ventas a Postgres DESDE LAS FUENTES REALES
// (WooCommerce, Tiendanube, Dragonfish) — no desde el Sheet, que tiene errores.
// Idempotente: borra e inserta por (fecha, local), se puede re-correr.
// Registra el resultado de cada (fecha, local) en sync_estado.
//
// Uso: node scripts/db-backfill.js [desde] [hasta]   (default: 2026-03-01 → ayer)
const fs = require("fs");
const path = require("path");
const { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFRango, diaSiguiente } = require("../lib/fuentes");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Reintentos para escrituras a Neon (timeouts transitorios de red)
async function conReintentos(fn, intentos = 4) {
  let ultimoError;
  for (let i = 1; i <= intentos; i++) {
    try { return await fn(); }
    catch (e) {
      ultimoError = e;
      if (i < intentos) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw ultimoError;
}

async function guardarDiaLocal(sql, fecha, local, filas) {
  await sql`DELETE FROM ventas WHERE fecha = ${fecha} AND local = ${local}`;
  for (let i = 0; i < filas.length; i += 500) {
    const c = filas.slice(i, i + 500);
    await sql`
      INSERT INTO ventas (fecha, local, sistema, orden_id, hora, producto, sku, color, talle, cantidad, precio_unit, total)
      SELECT * FROM UNNEST(
        ${c.map(f => f.fecha)}::date[],
        ${c.map(f => f.local)}::text[],
        ${c.map(f => f.sistema)}::text[],
        ${c.map(f => f.orden_id || null)}::text[],
        ${c.map(f => f.hora || null)}::text[],
        ${c.map(f => f.producto)}::text[],
        ${c.map(f => f.sku)}::text[],
        ${c.map(f => f.color)}::text[],
        ${c.map(f => f.talle)}::text[],
        ${c.map(f => f.cantidad)}::numeric[],
        ${c.map(f => f.precio_unit)}::numeric[],
        ${c.map(f => f.total)}::numeric[]
      )`;
  }
}

async function marcarSync(sql, fecha, local, ok, error) {
  await sql`
    INSERT INTO sync_estado (fecha, local, estado, intentos, ultimo_error, actualizado_en)
    VALUES (${fecha}, ${local}, ${ok ? "ok" : "error"}, 1, ${error}, now())
    ON CONFLICT (fecha, local) DO UPDATE SET
      estado = EXCLUDED.estado,
      intentos = sync_estado.intentos + 1,
      ultimo_error = EXCLUDED.ultimo_error,
      actualizado_en = now()`;
}

function listaDias(desde, hasta) {
  const dias = [];
  for (let d = desde; d <= hasta; d = diaSiguiente(d)) dias.push(d);
  return dias;
}

async function main() {
  loadEnv();
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const desde = process.argv[2] || "2026-03-01";
  const hasta = process.argv[3] || listaDias("2026-01-01", hoy).slice(-2)[0]; // ayer
  const dias = listaDias(desde, hasta);
  console.log(`Backfill desde fuentes reales: ${desde} → ${hasta} (${dias.length} días)\n`);

  // Reanudación: saltear (fecha, local) que ya están ok en sync_estado.
  // Con "force" como 3er argumento se recargan igual (ej. para poblar columnas nuevas).
  const force = process.argv[4] === "force";
  const yaOk = force ? new Set() : new Set(
    (await conReintentos(() => sql`SELECT fecha::text, local FROM sync_estado WHERE estado = 'ok' AND fecha BETWEEN ${desde} AND ${hasta}`))
      .map(r => `${r.fecha}|${r.local}`)
  );
  if (yaOk.size) console.log(`(reanudando: ${yaOk.size} fecha×local ya cargados se saltean)\n`);
  if (force) console.log("(force: se recargan todos los días del rango)\n");

  // ── Woo + TN: por día (filtro server-side por fecha) ──
  for (const dia of dias) {
    const fuentes = [
      ...wooLocales().map(l => ({ nombre: l.nombre, fn: () => fetchWooDia(l, dia) })),
      { nombre: "Tiendanube", fn: () => fetchTNDia(dia) },
    ].filter(f => !yaOk.has(`${dia}|${f.nombre}`));
    if (!fuentes.length) continue;

    const resultados = await Promise.all(fuentes.map(f => f.fn().then(r => ({ local: f.nombre, ...r }))));
    const linea = [];
    for (const r of resultados) {
      try {
        if (r.ok) {
          await conReintentos(() => guardarDiaLocal(sql, dia, r.local, r.filas));
          linea.push(`${r.local}:${r.filas.length}`);
        } else {
          linea.push(`${r.local}:ERROR(${r.error})`);
        }
        await conReintentos(() => marcarSync(sql, dia, r.local, r.ok, r.error));
      } catch (e) {
        linea.push(`${r.local}:DB-ERROR(${e.message})`);
      }
    }
    console.log(`  ${dia}  ${linea.join("  ")}`);
  }

  // ── Dragonfish: un sweep por local (pagina de hoy hacia atrás) ──
  for (const local of dfLocales()) {
    const diasFaltantes = dias.filter(d => !yaOk.has(`${d}|${local.nombre}`));
    if (!diasFaltantes.length) { console.log(`\nDragonfish ${local.nombre}: ya completo, salteado`); continue; }
    const desdeL = diasFaltantes[0], hastaL = diasFaltantes[diasFaltantes.length - 1];
    console.log(`\nDragonfish ${local.nombre}: sweep ${desdeL} → ${hastaL} (${diasFaltantes.length} días faltantes)...`);
    const r = await fetchDFRango(local, desdeL, hastaL);
    if (!r.ok && Object.keys(r.porDia).length === 0) {
      console.log(`  ERROR total: ${r.error}`);
      try { for (const dia of diasFaltantes) await conReintentos(() => marcarSync(sql, dia, local.nombre, false, r.error)); } catch {}
      continue;
    }
    // El sweep va de hoy hacia atrás. Si terminó ok, los días sin facturas son 0 real.
    // Si se cortó a mitad de camino, solo son confiables los días MÁS NUEVOS que el
    // día más viejo alcanzado — el resto queda en error para reintentar.
    const diasConData = Object.keys(r.porDia).sort();
    const limiteConfiable = r.ok ? null : (diasConData[0] || hastaL);
    let escritos = 0;
    for (const dia of diasFaltantes) {
      try {
        const confiable = r.ok || dia > limiteConfiable;
        if (confiable) {
          await conReintentos(() => guardarDiaLocal(sql, dia, local.nombre, r.porDia[dia] || []));
          await conReintentos(() => marcarSync(sql, dia, local.nombre, true, null));
          escritos++;
        } else {
          await conReintentos(() => marcarSync(sql, dia, local.nombre, false, `sweep cortado: ${r.error}`));
        }
      } catch (e) {
        console.log(`  DB-ERROR ${dia}: ${e.message}`);
      }
    }
    const totalFilas = Object.values(r.porDia).reduce((a, f) => a + f.length, 0);
    console.log(`  ${totalFilas} filas, ${escritos}/${diasFaltantes.length} días escritos${r.ok ? "" : ` (sweep cortado en ${limiteConfiable}: ${r.error})`}`);
  }

  // ── Resumen ──
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM ventas`;
  console.log(`\nFilas totales en ventas: ${count}`);
  console.log("\nTotales por local, últimos 5 días (comparar contra VentasDiarias):");
  const check = await sql`
    SELECT fecha::text, local, ROUND(SUM(total))::bigint AS total, COUNT(DISTINCT orden_id)::int AS ops
    FROM ventas WHERE fecha >= ${hasta}::date - 4
    GROUP BY fecha, local ORDER BY fecha DESC, local`;
  for (const r of check) console.log(`  ${r.fecha}  ${r.local.padEnd(12)} $${Number(r.total).toLocaleString("es-AR").padStart(12)}  (${r.ops} ops)`);

  const errores = await sql`SELECT fecha::text, local, ultimo_error FROM sync_estado WHERE estado = 'error' ORDER BY fecha`;
  if (errores.length) {
    console.log(`\n⚠️ ${errores.length} (fecha, local) con error — reintentables corriendo de nuevo el script:`);
    for (const e of errores.slice(0, 20)) console.log(`  ${e.fecha} ${e.local}: ${e.ultimo_error}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
