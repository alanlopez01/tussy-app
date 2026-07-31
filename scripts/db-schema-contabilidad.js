// Tablas del módulo Contabilidad: comprobantes ARCA, proveedores y egresos MP.
// Uso: node scripts/db-schema-contabilidad.js
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function main() {
  // Comprobantes que emite Tussy (facturas, notas de crédito/débito).
  // fuente: 'wsfe' (web service) o 'mc' (export de Mis Comprobantes).
  // tipo es el código ARCA (1=FA A, 6=FA B, 3=NC A, 8=NC B, etc.).
  await sql`CREATE TABLE IF NOT EXISTS comprobantes_emitidos (
    id serial PRIMARY KEY,
    fecha date NOT NULL,
    tipo int NOT NULL,
    punto_venta int NOT NULL,
    numero bigint NOT NULL,
    doc_tipo int,
    doc_nro bigint,
    receptor text,
    neto numeric(14,2) NOT NULL DEFAULT 0,
    iva numeric(14,2) NOT NULL DEFAULT 0,
    otros_tributos numeric(14,2) NOT NULL DEFAULT 0,
    total numeric(14,2) NOT NULL DEFAULT 0,
    cae text,
    fuente text NOT NULL DEFAULT 'mc',
    cargado_en timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tipo, punto_venta, numero)
  )`;

  // Comprobantes que recibe Tussy (compras: fábrica, alquileres, pauta, servicios)
  await sql`CREATE TABLE IF NOT EXISTS comprobantes_recibidos (
    id serial PRIMARY KEY,
    fecha date NOT NULL,
    tipo int NOT NULL,
    punto_venta int NOT NULL,
    numero bigint NOT NULL,
    cuit_emisor bigint NOT NULL,
    emisor text,
    neto numeric(14,2) NOT NULL DEFAULT 0,
    iva numeric(14,2) NOT NULL DEFAULT 0,
    otros_tributos numeric(14,2) NOT NULL DEFAULT 0,
    total numeric(14,2) NOT NULL DEFAULT 0,
    cargado_en timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cuit_emisor, tipo, punto_venta, numero)
  )`;

  // Rubro por proveedor para "en qué gastamos" (se asigna una vez, aplica a todo)
  await sql`CREATE TABLE IF NOT EXISTS proveedores (
    cuit bigint PRIMARY KEY,
    nombre text,
    rubro text NOT NULL DEFAULT 'Sin rubro'
  )`;

  // Transferencias/egresos de MercadoPago para conciliar contra facturas recibidas
  await sql`CREATE TABLE IF NOT EXISTS egresos_mp (
    id text PRIMARY KEY,
    fecha date NOT NULL,
    contraparte text,
    cuit bigint,
    monto numeric(14,2) NOT NULL,
    detalle text,
    cargado_en timestamptz NOT NULL DEFAULT now()
  )`;

  // Ticket de acceso WSAA (dura 12 h; ARCA rechaza pedir uno nuevo si hay uno vigente)
  await sql`CREATE TABLE IF NOT EXISTS arca_ta (
    servicio text PRIMARY KEY,
    token text NOT NULL,
    firma text NOT NULL,
    expira timestamptz NOT NULL
  )`;

  // Cursor del barrido incremental de emitidos por WS (por punto de venta y tipo)
  await sql`CREATE TABLE IF NOT EXISTS arca_cursor (
    punto_venta int NOT NULL,
    tipo int NOT NULL,
    ultimo bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (punto_venta, tipo)
  )`;

  await sql`CREATE INDEX IF NOT EXISTS ce_fecha ON comprobantes_emitidos (fecha)`;
  await sql`CREATE INDEX IF NOT EXISTS cr_fecha ON comprobantes_recibidos (fecha)`;
  await sql`CREATE INDEX IF NOT EXISTS cr_cuit ON comprobantes_recibidos (cuit_emisor)`;
  console.log("Tablas de contabilidad creadas.");
}
main();
