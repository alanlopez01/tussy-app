// Trae TODOS los comprobantes emitidos históricos desde el web service de ARCA.
// Corre en tandas resumibles (el cursor queda en la base): se puede cortar y retomar.
// Uso: node scripts/arca-backfill.js
// Requiere ARCA_CERT y ARCA_KEY (los toma de secrets/ si no están en el entorno).
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!process.env.ARCA_KEY && fs.existsSync("secrets/arca.key")) {
  process.env.ARCA_KEY = fs.readFileSync("secrets/arca.key", "utf8");
}
if (!process.env.ARCA_CERT && fs.existsSync("secrets/arca.crt")) {
  process.env.ARCA_CERT = fs.readFileSync("secrets/arca.crt", "utf8");
}
const { neon } = require("@neondatabase/serverless");
const { sincronizarEmitidos, arcaConfigurada } = require("../lib/arca");

async function main() {
  if (!arcaConfigurada()) {
    console.error("Falta el certificado: guardalo en secrets/arca.crt (la clave ya está en secrets/arca.key).");
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  let total = 0;
  for (let tanda = 1; ; tanda++) {
    const r = await sincronizarEmitidos(sql, { maxComprobantes: 400 });
    if (!r.ok) { console.error("Error:", r.motivo); process.exit(1); }
    total += r.cargados;
    console.log(`tanda ${tanda}: +${r.cargados} (total ${total}) · pendientes ${r.pendientes} · PVs ${r.puntos.join(",")}`);
    if (!r.pendientes && !r.cargados) break;
  }
  console.log("Backfill completo.");
}
main();
