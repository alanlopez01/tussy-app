// Trae del sistema de producción (KALYZ) la tela que consumió Shato desde el
// último cargo a mano de la Deuda Shato, y la deja en telas_consumidas.
// El cierre de las 00:05 hace lo mismo todas las noches; esto es para correrlo
// a mano y ver el detalle.
//
// Uso: node scripts/sincronizar-telas.js
const fs = require("fs");
const { sincronizarTelas, limiteCargaManual } = require("../lib/telas");

for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const pesos = n => "$" + Math.round(n).toLocaleString("es-AR");

async function main() {
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  const limite = await limiteCargaManual(sql);
  console.log(`Último cargo de tela a mano en la app: ${limite || "ninguno"}.`);
  console.log(`Se piden los cortes posteriores a esa fecha.`);

  const r = await sincronizarTelas(sql);
  if (!r.ok) {
    if (r.saltado) {
      console.error("Falta KALYZ_DATABASE_URL.");
    } else if (r.sinPermiso) {
      console.error("\nKALYZ no deja leer el consumo de tela todavía.");
      console.error(`Dijo: ${r.error}`);
      console.error("\nFalta correr en KALYZ docs/kalyz-permiso-telas.sql: crea la vista");
      console.error("core.v_tela_de_shato y le da SELECT a tussy_app_lectura (como la 0313).");
    } else {
      console.error(`Error: ${r.error}`);
    }
    process.exit(1);
  }

  console.log(`\nKALYZ devolvió ${r.leidas} consumos (por la ${r.via}); ${r.nuevas} eran nuevos, ${r.borradas} se dieron de baja.`);

  const [t] = await sql`SELECT count(*)::int n, sum(monto)::float monto, min(fecha)::text d, max(fecha)::text h,
                               count(*) FILTER (WHERE precio IS NULL)::int sin_precio
                          FROM telas_consumidas`;
  console.log(`Ahora: ${t.n} consumos del ${t.d} al ${t.h} por ${pesos(t.monto || 0)}.`);
  if (t.sin_precio) console.log(`Ojo: ${t.sin_precio} sin precio de transferencia, valen cero hasta que se les ponga precio.`);

  const meses = await sql`SELECT to_char(fecha,'YYYY-MM') mes, count(*)::int n,
                                 sum(cantidad)::float cant, sum(monto)::float monto
                            FROM telas_consumidas GROUP BY 1 ORDER BY 1`;
  for (const m of meses) console.log(`  ${m.mes}  ${m.n} consumos · ${m.cant.toLocaleString("es-AR")} · ${pesos(m.monto)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
