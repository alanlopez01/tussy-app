// Carga a la base un export CSV de Mis Comprobantes (ARCA).
// Uso: node scripts/cargar-mis-comprobantes.js <emitidos|recibidos> <archivo.csv>
// Mismo destino que la carga desde la app; idempotente (repetidos no duplican).
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");

const num = s => {
  const t = String(s ?? "").trim();
  if (!t) return 0;
  return parseFloat(t.replace(/\./g, "").replace(",", ".")) || 0;
};

async function main() {
  const [clase, archivo] = process.argv.slice(2);
  if (!["emitidos", "recibidos"].includes(clase) || !archivo) {
    console.error("Uso: node scripts/cargar-mis-comprobantes.js <emitidos|recibidos> <archivo.csv>");
    process.exit(1);
  }
  const lineas = fs.readFileSync(archivo, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  const headers = lineas[0].split(";").map(h => h.replace(/^"|"$/g, ""));
  const col = nombre => headers.findIndex(h => h === nombre);
  const idx = {
    fecha: col("Fecha de Emisión"), tipo: col("Tipo de Comprobante"), pv: col("Punto de Venta"),
    numero: col("Número Desde"),
    doc: clase === "recibidos" ? col("Nro. Doc. Emisor") : col("Nro. Doc. Receptor"),
    nombre: clase === "recibidos" ? col("Denominación Emisor") : col("Denominación Receptor"),
    neto: col("Imp. Neto Gravado Total"), iva: col("Total IVA"),
    otros: col("Otros Tributos"), total: col("Imp. Total"),
  };
  for (const [k, v] of Object.entries(idx)) if (v < 0) { console.error(`No encontré la columna de ${k}`); process.exit(1); }

  const filas = lineas.slice(1).map(l => {
    const c = l.split(";");
    return {
      fecha: c[idx.fecha], tipo: parseInt(c[idx.tipo]), punto_venta: parseInt(c[idx.pv]) || 0,
      numero: parseInt(c[idx.numero]), doc: parseInt(String(c[idx.doc]).replace(/\D/g, "")) || null,
      nombre: String(c[idx.nombre] || "").trim() || null,
      neto: num(c[idx.neto]), iva: num(c[idx.iva]), otros: num(c[idx.otros]), total: num(c[idx.total]),
    };
  }).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha || "") && !isNaN(f.tipo) && !isNaN(f.numero) &&
                 (clase === "emitidos" || f.doc));

  const sql = neon(process.env.DATABASE_URL);
  let nuevas = 0;
  for (let i = 0; i < filas.length; i += 1000) {
    const lote = filas.slice(i, i + 1000);
    const a = fn => lote.map(fn);
    if (clase === "emitidos") {
      const r = await sql`INSERT INTO comprobantes_emitidos
        (fecha, tipo, punto_venta, numero, doc_nro, receptor, neto, iva, otros_tributos, total, fuente)
        SELECT x.*, 'mc' FROM unnest(
          ${a(f => f.fecha)}::date[], ${a(f => f.tipo)}::int[], ${a(f => f.punto_venta)}::int[], ${a(f => f.numero)}::bigint[],
          ${a(f => f.doc)}::bigint[], ${a(f => f.nombre)}::text[], ${a(f => f.neto)}::numeric[], ${a(f => f.iva)}::numeric[],
          ${a(f => f.otros)}::numeric[], ${a(f => f.total)}::numeric[]
        ) AS x(fecha, tipo, punto_venta, numero, doc_nro, receptor, neto, iva, otros_tributos, total)
        ON CONFLICT (tipo, punto_venta, numero) DO NOTHING RETURNING id`;
      nuevas += r.length;
    } else {
      const r = await sql`INSERT INTO comprobantes_recibidos
        (fecha, tipo, punto_venta, numero, cuit_emisor, emisor, neto, iva, otros_tributos, total)
        SELECT * FROM unnest(
          ${a(f => f.fecha)}::date[], ${a(f => f.tipo)}::int[], ${a(f => f.punto_venta)}::int[], ${a(f => f.numero)}::bigint[],
          ${a(f => f.doc)}::bigint[], ${a(f => f.nombre)}::text[], ${a(f => f.neto)}::numeric[], ${a(f => f.iva)}::numeric[],
          ${a(f => f.otros)}::numeric[], ${a(f => f.total)}::numeric[]
        ) AS x(fecha, tipo, punto_venta, numero, cuit_emisor, emisor, neto, iva, otros_tributos, total)
        ON CONFLICT (cuit_emisor, tipo, punto_venta, numero) DO NOTHING RETURNING id`;
      nuevas += r.length;
      await sql`INSERT INTO proveedores (cuit, nombre)
        SELECT DISTINCT ON (cuit) * FROM unnest(${a(f => f.doc)}::bigint[], ${a(f => f.nombre)}::text[]) AS x(cuit, nombre)
        ON CONFLICT (cuit) DO UPDATE SET nombre = COALESCE(proveedores.nombre, EXCLUDED.nombre)`;
    }
  }
  console.log(`${clase}: ${nuevas} nuevas de ${filas.length} filas válidas`);
}
main();
