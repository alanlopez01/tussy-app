// Sincroniza una publicación ya creada con lo que diga publicaciones.json.
// Uso: node meli/actualizar.mjs "NOMBRE EN TIENDANUBE"
// Sirve para corregir fichas y, más adelante, para empujar cambios de precio.
// NO toca el stock: el de MELI lo maneja Alan a mano.
import fs from "fs";
import { neon } from "@neondatabase/serverless";

for (const l of fs.readFileSync("/Users/alanlopez/Desktop/Claudito/tussy-app/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const sql = neon(process.env.DATABASE_URL);
const API = "https://api.mercadolibre.com";

const nombre = process.argv[2];
const fichas = JSON.parse(fs.readFileSync(new URL("./publicaciones.json", import.meta.url), "utf8"));
const GUIAS = JSON.parse(fs.readFileSync(new URL("./guias-talles.json", import.meta.url), "utf8"));
const f = fichas.find(x => x.tn_nombre === nombre);
if (!f) { console.error("no está en publicaciones.json:", nombre); process.exit(1); }

const [pub] = await sql`SELECT item_id FROM meli_publicaciones WHERE tn_nombre = ${nombre}`;
if (!pub) { console.error("no está publicada todavía:", nombre); process.exit(1); }

const [{ access_token: T }] = await sql`SELECT access_token FROM meli_cuenta WHERE id = 1`;
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };
const grid = f.size_grid && GUIAS.moldes[f.size_grid]?.meli;

const item = await (await fetch(`${API}/items/${pub.item_id}`, { headers: H })).json();
const idsActuales = (item.pictures || []).map(p => p.id);

const attrs = Object.entries(f.attributes)
  .filter(([id]) => !["COLOR", "SIZE"].includes(id))
  .map(([id, value_name]) => ({ id, value_name }));
attrs.push({ id: "VALUE_ADDED_TAX", value_name: "21 %" });
attrs.push({ id: "IMPORT_DUTY", value_name: "0 %" });
if (grid) attrs.push({ id: "SIZE_GRID_ID", value_name: String(grid.size_grid_id) });

const body = {
  title: f.title,
  attributes: attrs,
  // Las fotos que ya están subidas se reutilizan: solo reordenamos.
  variations: (item.variations || []).map(v => ({ id: v.id, picture_ids: idsActuales.slice(0, 10) })),
};

const r = await fetch(`${API}/items/${pub.item_id}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
const j = await r.json();
if (!r.ok) {
  console.error(`✗ ficha HTTP ${r.status}: ${j.message || j.error}`);
  for (const c of j.cause || []) console.error(`   · [${c.code}] ${c.message}`);
} else {
  console.log("✓ ficha actualizada");
  console.log("   título:", j.title);
  console.log("   guía  :", j.attributes?.find(a => a.id === "SIZE_GRID_ID")?.value_name || "-");
}

// La descripción va por su propio endpoint, no entra en el PUT del item.
const rd = await fetch(`${API}/items/${pub.item_id}/description`, {
  method: "PUT", headers: H, body: JSON.stringify({ plain_text: f.description }),
});
console.log(rd.ok ? "✓ descripción actualizada" : `✗ descripción HTTP ${rd.status}: ${(await rd.text()).slice(0, 200)}`);
