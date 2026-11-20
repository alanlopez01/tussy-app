// Trae de KALYZ los comprobantes RECIBIDOS de Tussy y los deja en la base.
// El cierre de las 00:05 hace lo mismo con los últimos 45 días; esto es para
// recuperar un período largo (por ejemplo, todo lo que falta desde el 29-sep,
// que fue la última carga a mano).
//
// Uso: node scripts/sincronizar-recibidos.js [desde]      (default: 2026-01-01)
const fs = require("fs");
const path = require("path");
const { sincronizarRecibidos } = require("../lib/kalyz");

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
  const desde = process.argv[2] || "2026-01-01";

  const antes = await sql`SELECT count(*)::int n, max(fecha) ult FROM comprobantes_recibidos`;
  console.log(`Antes: ${antes[0].n} comprobantes, el último del ${String(antes[0].ult).slice(0, 15)}`);

  const r = await sincronizarRecibidos(sql, desde);
  if (!r.ok) {
    console.error(r.saltado
      ? "Falta KALYZ_DATABASE_URL: es el usuario de solo lectura sobre core.comprobantes_recibidos."
      : `Error: ${r.error}`);
    process.exit(1);
  }

  const despues = await sql`SELECT count(*)::int n, max(fecha) ult FROM comprobantes_recibidos`;
  console.log(`KALYZ devolvió ${r.leidos} desde ${desde}; ${r.nuevos} eran nuevos.`);
  console.log(`Ahora: ${despues[0].n} comprobantes, el último del ${String(despues[0].ult).slice(0, 15)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
