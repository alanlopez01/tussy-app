// Cuenta de Mercado Libre conectada por OAuth. Una sola fila (id = 1): operamos
// siempre sobre la cuenta de vendedor de Tussy.
// El access_token dura 6 h y el refresh 6 meses, así que lo que importa guardar
// es el refresh: si se pierde, hay que volver a autorizar a mano desde el navegador.
// Uso: node scripts/db-schema-meli.js
const fs = require("fs");
for (const line of fs.readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function main() {
  await sql`CREATE TABLE IF NOT EXISTS meli_cuenta (
    id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    user_id        bigint,
    nickname       text,
    access_token   text,
    refresh_token  text,
    expira_en      timestamptz,
    scopes         text,
    -- state del flujo OAuth en curso: lo generamos al mandar al usuario a MELI
    -- y lo exigimos de vuelta en el callback, para que nadie pueda inyectar un
    -- code ajeno contra nuestro endpoint (que es público por definición).
    state_pendiente text,
    state_expira    timestamptz,
    actualizado_en timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`INSERT INTO meli_cuenta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

  // Qué publicación de MELI corresponde a cada producto de Tiendanube.
  // El stock NO se sincroniza (decisión de Alan): el de MELI se carga a mano
  // porque no es el mismo inventario que el de la web.
  await sql`CREATE TABLE IF NOT EXISTS meli_publicaciones (
    item_id      text PRIMARY KEY,
    tn_id        bigint NOT NULL,
    tn_nombre    text NOT NULL,
    permalink    text,
    estado       text,
    precio       numeric,
    publicado_en timestamptz NOT NULL DEFAULT now(),
    actualizado_en timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS meli_pub_tn ON meli_publicaciones (tn_id)`;

  const [c] = await sql`SELECT COUNT(*)::int n FROM meli_cuenta`;
  console.log("meli_cuenta OK (filas:", c.n + ")");
  console.log("meli_publicaciones OK");
}
main().catch(e => { console.error(e.message); process.exit(1); });
