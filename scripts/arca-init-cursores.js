// Posiciona el cursor de cada punto de venta / tipo en el primer comprobante
// emitido a partir de DESDE (búsqueda binaria por fecha contra el WS).
// Así el backfill trae solo la historia que nos interesa, no décadas de facturas.
// Uso: node scripts/arca-init-cursores.js [YYYY-MM-DD]
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.ARCA_KEY = process.env.ARCA_KEY || fs.readFileSync("secrets/arca.key", "utf8");
process.env.ARCA_CERT = process.env.ARCA_CERT || fs.readFileSync("secrets/arca.crt", "utf8");
const { neon } = require("@neondatabase/serverless");
const { obtenerTicket, puntosDeVenta, ultimoAutorizado, consultarComprobante } = require("../lib/arca");

const TIPOS = [1, 2, 3, 6, 7, 8, 11, 12, 13];

async function main() {
  const desde = process.argv[2] || "2026-02-01";
  const sql = neon(process.env.DATABASE_URL);
  const auth = await obtenerTicket(sql);
  for (const pv of await puntosDeVenta(auth)) {
    for (const tipo of TIPOS) {
      const ultimo = await ultimoAutorizado(auth, pv, tipo);
      if (!ultimo) continue;
      const [cur] = await sql`SELECT ultimo FROM arca_cursor WHERE punto_venta = ${pv} AND tipo = ${tipo}`;
      if (cur && Number(cur.ultimo) > 0) { console.log(`PV ${pv} tipo ${tipo}: cursor ya en ${cur.ultimo}, no toco`); continue; }
      // Binario: menor número con fecha >= desde
      let lo = 1, hi = ultimo, primero = ultimo + 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const c = await consultarComprobante(auth, pv, tipo, mid);
        if (c && c.fecha >= desde) { primero = mid; hi = mid - 1; }
        else lo = mid + 1;
      }
      await sql`INSERT INTO arca_cursor (punto_venta, tipo, ultimo) VALUES (${pv}, ${tipo}, ${primero - 1})
        ON CONFLICT (punto_venta, tipo) DO UPDATE SET ultimo = ${primero - 1}`;
      console.log(`PV ${pv} tipo ${tipo}: arranca en ${primero} (último ${ultimo}) → ${ultimo - primero + 1} por traer`);
    }
  }
  console.log("Cursores listos.");
}
main();
