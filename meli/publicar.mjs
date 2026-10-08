// Publica en Mercado Libre una de las fichas de publicaciones.json.
// Uso: node meli/publicar.mjs "NOMBRE EN TIENDANUBE" [--confirmar]
// Sin --confirmar solo imprime lo que mandaría: nunca publica por accidente.
//
// Nace PAUSADA y con cantidad 1 por variación: el stock de MELI lo carga Alan a
// mano porque no es el mismo inventario que el de la web.
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
const confirmar = process.argv.includes("--confirmar");
if (!nombre) { console.error("falta el nombre del producto"); process.exit(1); }

const fichas = JSON.parse(fs.readFileSync(new URL("./publicaciones.json", import.meta.url), "utf8"));
const GUIAS = JSON.parse(fs.readFileSync(new URL("./guias-talles.json", import.meta.url), "utf8"));
const f = fichas.find(x => x.tn_nombre === nombre);
if (!f) { console.error("no está en publicaciones.json:", nombre); process.exit(1); }
const grid = f.size_grid && GUIAS.moldes[f.size_grid]?.meli;

const [{ access_token: T }] = await sql`SELECT access_token FROM meli_cuenta WHERE id = 1`;
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };

// MELI pide entre 1 y 10 fotos POR VARIACIÓN, y ahí no acepta URLs: hay que
// subirlas antes y referenciarlas por id. Una subida por URL única.
//
// Va por multipart y no mandando {source: url}: pasándole la URL, MELI se baja
// la foto y la deja en 500x500; subiendo el archivo queda en 800x1200. En Moda
// la foto es medio ranking, así que la resolución no es un detalle.
const idPorUrl = new Map();
async function subirFotos(urls) {
  for (const url of urls) {
    if (idPorUrl.has(url)) continue;
    const { file } = await prepararFoto(url, tmp, idPorUrl.size);
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(file)], { type: "image/jpeg" }), "foto.jpg");
    const r = await fetch(`${API}/pictures/items/upload`, {
      method: "POST", headers: { Authorization: H.Authorization }, body: fd,
    });
    const j = await r.json();
    if (!r.ok || !j.id) throw new Error(`subiendo foto: ${j.message || JSON.stringify(j).slice(0, 120)}`);
    idPorUrl.set(url, j.id);
    process.stdout.write(".");
  }
}

function armarBody() {
  // Con variaciones, COLOR y SIZE van en attribute_combinations, no a nivel item.
  const itemAttrs = Object.entries(f.attributes)
    .filter(([id]) => !["COLOR", "SIZE"].includes(id))
    .map(([id, value_name]) => ({ id, value_name }));
  // Estos no figuran como `required` en /categories/{id}/attributes pero la
  // validación de negocio los exige igual. Los fuimos descubriendo publicando.
  itemAttrs.push({ id: "VALUE_ADDED_TAX", value_name: "21 %" });
  itemAttrs.push({ id: "IMPORT_DUTY", value_name: "0 %" });
  if (grid) itemAttrs.push({ id: "SIZE_GRID_ID", value_name: String(grid.size_grid_id) });

  const todas = f.pictures.map(p => idPorUrl.get(p.source)).filter(Boolean);

  return {
    title: f.title,
    category_id: f.category_id,
    price: f.price_meli,
    currency_id: "ARS",
    buying_mode: "buy_it_now",
    listing_type_id: "gold_special",          // Clásica
    condition: "new",
    status: "paused",
    description: { plain_text: f.description },
    // Arriba de $33.000 el envío gratis es obligatorio y lo paga el vendedor.
    shipping: { mode: "me2", free_shipping: f.price_meli >= 33000, local_pick_up: false },
    pictures: todas.map(id => ({ id })),
    attributes: itemAttrs,
    variations: f.variaciones.map(v => {
      const propia = v.foto && idPorUrl.get(v.foto);
      return {
        price: f.price_meli,
        available_quantity: f.available_quantity,
        attribute_combinations: [
          v.COLOR ? { id: "COLOR", value_name: v.COLOR } : null,
          v.SIZE ? { id: "SIZE", value_name: v.SIZE } : null,
        ].filter(Boolean),
        // La fila de la guía va en `attributes`, no en attribute_combinations:
        // es lo que hace que el comprador vea las medidas del talle que mira.
        attributes: grid?.filas?.[v.SIZE]
          ? [{ id: "SIZE_GRID_ROW_ID", value_name: grid.filas[v.SIZE] }] : [],
        seller_custom_field: v.sku || undefined,
        picture_ids: deLaVariacion.slice(0, 10),
      };
    }),
  };
}

if (!confirmar) {
  console.log("--- SIMULACRO. Agregá --confirmar para publicar de verdad ---");
  console.log(`${f.title}\n  ${f.variaciones.length} variaciones · ${f.pictures.length} fotos · $${f.price_meli}`);
  console.log(`  guía: ${grid ? grid.size_grid_id : "sin guía"} · envío gratis: ${f.price_meli >= 33000}`);
  console.log(`  fotos por color: ${f.variaciones.filter(v => v.foto).length}/${f.variaciones.length}`);
  process.exit(0);
}

process.stdout.write("subiendo fotos ");
await subirFotos([...new Set([...f.pictures.map(p => p.source), ...f.variaciones.map(v => v.foto).filter(Boolean)])]);
console.log(` ${idPorUrl.size} subidas`);

const r = await fetch(`${API}/items`, { method: "POST", headers: H, body: JSON.stringify(armarBody()) });
const j = await r.json();
if (!r.ok) {
  console.error(`✗ HTTP ${r.status}: ${j.message || j.error}`);
  for (const c of j.cause || []) console.error(`   · [${c.code}] ${c.message}`);
  process.exit(1);
}
// MELI IGNORA `status: "paused"` en el POST: la publicación nace activa igual.
// Hay que pausarla con un PUT inmediatamente después, si no queda a la venta.
let estado = j.status;
if (estado !== "paused") {
  const pr = await fetch(`${API}/items/${j.id}`, {
    method: "PUT", headers: H, body: JSON.stringify({ status: "paused" }),
  });
  const pj = await pr.json();
  estado = pj.status || estado;
  if (estado !== "paused") console.error("  ⚠ NO SE PUDO PAUSAR — revisala a mano ya mismo");
}
console.log("✓ publicada");
console.log("   item_id:", j.id, "| estado:", estado);
console.log("   link   :", j.permalink);
console.log("   variaciones:", (j.variations || []).length, "| fotos:", (j.pictures || []).length);

await sql`INSERT INTO meli_publicaciones (item_id, tn_id, tn_nombre, permalink, estado, precio)
  VALUES (${j.id}, ${f.tn_id}, ${f.tn_nombre}, ${j.permalink}, ${estado}, ${f.price_meli})
  ON CONFLICT (item_id) DO UPDATE SET estado = EXCLUDED.estado, precio = EXCLUDED.precio, actualizado_en = now()`;
