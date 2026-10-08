// Vuelve a subir las fotos de una publicación ya creada, ahora en 1200x1540.
// Uso: node meli/refotos.mjs "NOMBRE EN TIENDANUBE"
import fs from "fs";
import { neon } from "@neondatabase/serverless";
import { prepararFoto, carpetaTemp } from "./fotos.mjs";

for (const l of fs.readFileSync("/Users/alanlopez/Desktop/Claudito/tussy-app/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const sql = neon(process.env.DATABASE_URL);
const API = "https://api.mercadolibre.com";
const tmp = carpetaTemp();
const nombre = process.argv[2];

const f = JSON.parse(fs.readFileSync(new URL("./publicaciones.json", import.meta.url), "utf8"))
  .find(x => x.tn_nombre === nombre);
const [pub] = await sql`SELECT item_id FROM meli_publicaciones WHERE tn_nombre = ${nombre}`;
if (!f || !pub) { console.error("no encontrado o no publicado:", nombre); process.exit(1); }

const [{ access_token: T }] = await sql`SELECT access_token FROM meli_cuenta WHERE id = 1`;
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };

const ids = [];
process.stdout.write("preparando y subiendo ");
for (const p of f.pictures) {
  const { file } = await prepararFoto(p.source, tmp, ids.length);
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(file)], { type: "image/jpeg" }), "foto.jpg");
  const r = await fetch(`${API}/pictures/items/upload`, { method: "POST", headers: { Authorization: H.Authorization }, body: fd });
  const j = await r.json();
  if (!r.ok || !j.id) throw new Error(`foto: ${j.message || JSON.stringify(j).slice(0, 120)}`);
  ids.push(j.id);
  process.stdout.write(".");
}
console.log(` ${ids.length} listas`);

const item = await (await fetch(`${API}/items/${pub.item_id}`, { headers: H })).json();
const r = await fetch(`${API}/items/${pub.item_id}`, {
  method: "PUT", headers: H,
  body: JSON.stringify({
    pictures: ids.map(id => ({ id })),
    variations: (item.variations || []).map(v => ({ id: v.id, picture_ids: ids.slice(0, 10) })),
  }),
});
const j = await r.json();
if (!r.ok) { console.error(`✗ HTTP ${r.status}`); (j.cause || []).forEach(c => console.error(`   [${c.code}] ${c.message}`)); process.exit(1); }
console.log("✓ fotos reemplazadas");
for (const p of j.pictures || []) console.log(`   ${p.size.padEnd(10)} max ${p.max_size}`);
