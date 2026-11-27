// Rellena los comprobantes emitidos que FALTAN hacia atrás, de a un local.
//
// Existe por La Plata. Su WooCommerce vivía en localestussy.wnpower.host, se dio
// de baja el dominio y con él la base: de esa tienda no queda nada propio antes
// de marzo de 2026, ni en ventas, ni en la planilla vieja de Apps Script. Pero
// La Plata facturó desde el 11-ago-2023 y ARCA guarda cada comprobante, así que
// su historia de plata y tickets por día se puede reconstruir desde el web
// service. Lo que NO se recupera es el renglón: ARCA no guarda qué producto se
// vendió, sólo el total del comprobante.
//
// OJO CON LA FECHA. Hasta que pasó al ERP (19-ago-2026) La Plata no facturaba al
// vender: facturaba en lotes, días o semanas después. Hay meses con un solo día
// de facturación (nov-2025: 14 comprobantes) y días con 750 facturas emitidas de
// una (12-ene-2026). Así que `fecha` es cuándo se emitió el comprobante, NO
// cuándo se vendió: el total del año sirve, el del mes es un artefacto del lote y
// el del día no quiere decir nada. Desde sep-2026 el ERP factura cada venta en el
// momento (25-27 días de facturación por mes) y ahí la fecha sí es la de la venta.
//
// Y el comprobante tampoco es toda la venta: en los meses donde hay las dos
// puntas, lo facturado por La Plata es el 53% de lo vendido (en los locales va
// del 55% al 72%; Tiendanube, que factura todo, da 97%).
//
// A diferencia de lib/arca.js, que camina hacia adelante desde arca_cursor para
// traer lo nuevo, esto pide TODO lo que no está entre 1 y el último autorizado.
// No usa cursor ni lo toca: calcula el faltante contra la base en cada corrida,
// así que es idempotente, resumible y no interfiere con el cron de todos los días.
// También tapa agujeros en el medio, no sólo la cola.
//
// Uso: node scripts/arca-historico.js "La Plata" [maxPorCorrida]
//      node scripts/arca-historico.js 1902 [maxPorCorrida]
const fs = require("fs");

for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!process.env.ARCA_KEY && fs.existsSync("secrets/arca.key")) process.env.ARCA_KEY = fs.readFileSync("secrets/arca.key", "utf8");
if (!process.env.ARCA_CERT && fs.existsSync("secrets/arca.crt")) process.env.ARCA_CERT = fs.readFileSync("secrets/arca.crt", "utf8");

const { neon } = require("@neondatabase/serverless");
const arca = require("../lib/arca");

// El mismo mapeo que usa api/metricas.js para cruzar facturado contra vendido.
const PV_POR_LOCAL = {
  "Tiendanube": 33, "Córdoba": 1401, "Palermo": 1901,
  "La Plata": 1902, "Dot": 1904, "Abasto": 1905,
};
const TIPOS = [1, 2, 3, 6, 7, 8, 11, 12, 13];
const EN_PARALELO = 8;      // lo mismo que usa el barrido incremental
// Sin pausa esto le pega a ARCA unas 400 veces por minuto durante media hora. El
// barrido de todos los días trabaja en tandas de 400 por corrida justamente para
// no llegar ahí, y si ARCA frena el CUIT se cae la sincronización diaria, que
// importa más que terminar rápido. 2,4 s por tanda deja el ritmo en ~200/min.
const PAUSA_MS = 2400;
const dormir = ms => new Promise(r => setTimeout(r, ms));

const pesos = n => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");

// Neon corta conexiones de vez en cuando (ETIMEDOUT leyendo el socket). Media
// hora de trabajo no se tira por un timeout de red: mismo patrón que usa
// scripts/db-backfill.js para sus escrituras.
async function conReintentos(fn, intentos = 5) {
  let ultimo;
  for (let i = 1; i <= intentos; i++) {
    try { return await fn(); }
    catch (e) {
      ultimo = e;
      if (i < intentos) await dormir(2000 * i);
    }
  }
  throw ultimo;
}

async function main() {
  if (!arca.arcaConfigurada()) {
    console.error("Falta el certificado de ARCA: secrets/arca.crt y secrets/arca.key");
    process.exit(1);
  }
  const arg = process.argv[2];
  if (!arg) {
    console.error('Uso: node scripts/arca-historico.js "La Plata" [maxPorCorrida]');
    console.error("Locales: " + Object.keys(PV_POR_LOCAL).join(", "));
    process.exit(1);
  }
  const pv = /^\d+$/.test(arg) ? parseInt(arg) : PV_POR_LOCAL[arg];
  if (!pv) { console.error(`No conozco el local "${arg}"`); process.exit(1); }
  const nombre = Object.keys(PV_POR_LOCAL).find(k => PV_POR_LOCAL[k] === pv) || String(pv);
  const maxPorCorrida = parseInt(process.argv[3]) || Infinity;

  const sql = neon(process.env.DATABASE_URL);
  const auth = await arca.obtenerTicket(sql);
  console.log(`ARCA: ${nombre} (punto de venta ${pv})\n`);

  let bajados = 0, sinRespuesta = 0;

  for (const tipo of TIPOS) {
    if (bajados >= maxPorCorrida) break;

    let ultimo = 0;
    try { ultimo = await arca.ultimoAutorizado(auth, pv, tipo); } catch { continue; }
    if (!ultimo) continue;

    const presentes = new Set((await conReintentos(() => sql`
      SELECT numero FROM comprobantes_emitidos
       WHERE punto_venta = ${pv} AND tipo = ${tipo}`)).map(r => Number(r.numero)));

    const faltan = [];
    for (let n = 1; n <= ultimo; n++) if (!presentes.has(n)) faltan.push(n);
    if (!faltan.length) { console.log(`  tipo ${tipo}: completo (1..${ultimo})`); continue; }

    console.log(`  tipo ${tipo}: faltan ${faltan.length} de ${ultimo} (el más viejo que falta es el ${faltan[0]})`);
    const empezo = Date.now();

    for (let i = 0; i < faltan.length && bajados < maxPorCorrida; i += EN_PARALELO) {
      const lote = faltan.slice(i, Math.min(i + EN_PARALELO, faltan.length, i + (maxPorCorrida - bajados)));
      // En 15.000 llamadas alguna se cae: se reintenta la tanda con espera
      // creciente antes de darse por vencido. Un fallo suelto no tiene que
      // abortar media hora de trabajo.
      let comps = null, ultimoError = null;
      for (let intento = 1; intento <= 4 && comps === null; intento++) {
        try {
          comps = (await Promise.all(lote.map(n => arca.consultarComprobante(auth, pv, tipo, n)))).filter(Boolean);
        } catch (e) {
          ultimoError = e.message;
          if (intento < 4) {
            console.log(`    tanda del ${lote[0]} falló (${String(e.message).slice(0, 70)}), reintento ${intento} de 3`);
            await dormir(10000 * intento);
          }
        }
      }
      if (comps === null) {
        console.log(`    CORTADO en el ${lote[0]}: ${String(ultimoError).slice(0, 120)}`);
        console.log("    volvé a correrlo y sigue desde acá (recalcula el faltante solo)");
        return resumen(sql, pv, nombre, bajados, sinRespuesta);
      }
      sinRespuesta += lote.length - comps.length;

      // Toda la tanda en una sola sentencia: 15.000 INSERT sueltos son 15.000
      // idas y vueltas a Neon, y cada una es una oportunidad de cortarse.
      if (comps.length) {
        try {
          await conReintentos(() => sql`
            INSERT INTO comprobantes_emitidos
              (fecha, tipo, punto_venta, numero, doc_tipo, doc_nro, neto, iva, otros_tributos, total, cae, fuente)
            SELECT * FROM UNNEST(
              ${comps.map(c => c.fecha)}::date[],
              ${comps.map(c => c.tipo)}::int[],
              ${comps.map(c => c.punto_venta)}::int[],
              ${comps.map(c => c.numero)}::bigint[],
              ${comps.map(c => c.doc_tipo)}::int[],
              ${comps.map(c => c.doc_nro)}::bigint[],
              ${comps.map(c => c.neto)}::numeric[],
              ${comps.map(c => c.iva)}::numeric[],
              ${comps.map(c => c.otros_tributos)}::numeric[],
              ${comps.map(c => c.total)}::numeric[],
              ${comps.map(c => c.cae)}::text[],
              ${comps.map(() => "wsfe")}::text[]
            )
            ON CONFLICT (tipo, punto_venta, numero) DO UPDATE
              SET fecha = EXCLUDED.fecha, neto = EXCLUDED.neto, iva = EXCLUDED.iva,
                  otros_tributos = EXCLUDED.otros_tributos, total = EXCLUDED.total,
                  cae = EXCLUDED.cae, fuente = 'wsfe'`);
        } catch (e) {
          console.log(`    CORTADO escribiendo la tanda del ${lote[0]}: ${String(e.message).slice(0, 120)}`);
          console.log("    volvé a correrlo y sigue desde acá (recalcula el faltante solo)");
          return resumen(sql, pv, nombre, bajados, sinRespuesta);
        }
      }
      bajados += lote.length;

      if (bajados % 400 < EN_PARALELO) {
        const porSeg = bajados / ((Date.now() - empezo) / 1000);
        const quedan = Math.round((faltan.length - i) / porSeg / 60);
        console.log(`    ${bajados} bajados  (${porSeg.toFixed(1)}/s, ~${quedan} min para terminar este tipo)`);
      }
      await dormir(PAUSA_MS);
    }
  }

  await resumen(sql, pv, nombre, bajados, sinRespuesta);
}

async function resumen(sql, pv, nombre, bajados, sinRespuesta) {
  console.log(`\n${bajados} comprobantes pedidos` + (sinRespuesta ? `, ${sinRespuesta} sin respuesta de ARCA (números nunca emitidos)` : ""));
  const r = await conReintentos(() => sql`
    SELECT min(fecha)::text d1, max(fecha)::text d2, count(*)::int n,
           round(sum(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint facturado
      FROM comprobantes_emitidos WHERE punto_venta = ${pv}`);
  console.log(`${nombre} ahora: ${r[0].n} comprobantes, ${r[0].d1} → ${r[0].d2}, ${pesos(r[0].facturado)} facturado`);
  const anios = await conReintentos(() => sql`
    SELECT extract(year from fecha)::int anio, count(*)::int n,
           round(sum(total * CASE WHEN tipo IN (3,8,13) THEN -1 ELSE 1 END))::bigint facturado
      FROM comprobantes_emitidos WHERE punto_venta = ${pv} GROUP BY 1 ORDER BY 1`);
  for (const a of anios)
    console.log(`  ${a.anio}  ${String(a.n).padStart(6)} comprobantes  ${pesos(a.facturado).padStart(16)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
