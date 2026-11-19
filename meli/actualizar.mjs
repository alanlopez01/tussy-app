// Sincroniza una publicación ya creada con lo que diga publicaciones.json.
// Uso: node meli/actualizar.mjs "NOMBRE EN TIENDANUBE"
// Sirve para corregir fichas y, más adelante, para empujar cambios de precio.
// NO toca el stock: el de MELI lo maneja Alan a mano.
import fs from "fs";
import { prepararFoto, carpetaTemp, colorDominante, repartirPorColor } from "./fotos.mjs";
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

// Mismo criterio que publicar.mjs: el GENDER del ítem tiene que ser el de la
// guía de talles o el PUT falla con `invalid.fashion_grid.attributes.values`.
// Las guías de Tussy no son todas iguales (remera y buzo son "Sin género",
// pantalón y boxer "Hombre"), así que se lee de la grilla y no del molde.
let generoGrilla = null;
if (grid) {
  const ch = await (await fetch(`${API}/catalog/charts/${grid.size_grid_id}`, { headers: H })).json();
  const g = (ch.attributes || []).find(a => a.id === "GENDER");
  generoGrilla = g?.values?.[0]?.name || g?.value_name || null;
}

const item = await (await fetch(`${API}/items/${pub.item_id}`, { headers: H })).json();
const idsActuales = (item.pictures || []).map(p => p.id);

const attrs = Object.entries(f.attributes)
  .filter(([id]) => !["COLOR", "SIZE"].includes(id))
  .map(([id, value_name]) => ({ id, value_name }));
attrs.push({ id: "VALUE_ADDED_TAX", value_name: "21 %" });
attrs.push({ id: "IMPORT_DUTY", value_name: "0 %" });
// AGE_GROUP figura read_only y hidden en la categoría, pero la validación de
// negocio lo exige igual. No se descubre leyendo los atributos: sólo fallando.
if (grid) attrs.push({ id: "AGE_GROUP", value_name: "Adultos" });
if (generoGrilla) {
  const i = attrs.findIndex(a => a.id === "GENDER");
  if (i >= 0) attrs[i].value_name = generoGrilla; else attrs.push({ id: "GENDER", value_name: generoGrilla });
}
if (grid) attrs.push({ id: "SIZE_GRID_ID", value_name: String(grid.size_grid_id) });

const tuvoVentas = Number(item.sold_quantity || 0) > 0;
// Reparto de fotos por color. MELI usa las fotos de la variación para mostrar
// el producto en el color elegido: si van todas a todas, al elegir "negro" se
// ven las de la crudo. Se clasifican midiendo el color dominante, usando como
// ancla la foto que Tiendanube asocia a cada variante.
let fotosPorColor = null;
const coloresDeFicha = [...new Set(f.variaciones.map(v => v.COLOR).filter(Boolean))];
if (coloresDeFicha.length > 1 && f.variaciones.some(v => v.foto)) {
  const tmp = carpetaTemp();
  process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  try {
    const rgbDe = new Map();
    const medir = async (url, i) => {
      if (rgbDe.has(url)) return rgbDe.get(url);
      const { file } = await prepararFoto(url, tmp, i);
      const rgb = colorDominante(file);
      rgbDe.set(url, rgb);
      return rgb;
    };
    // Se clasifica contra TODOS los colores del producto, no sólo los que se
    // publican: si no, las fotos de un color descartado caen en el publicado
    // más parecido y muestran la prenda equivocada.
    const anclas = {};
    for (const [c, src] of Object.entries(f.anclas_color || {})) {
      anclas[c] = await medir(src, rgbDe.size);
    }
    for (const c of coloresDeFicha) {
      if (anclas[c]) continue;
      const v = f.variaciones.find(x => x.COLOR === c && x.foto);
      if (v) anclas[c] = await medir(v.foto, rgbDe.size);
    }
    // El orden de item.pictures es el de f.pictures: publicar.mjs las sube así.
    const fotos = [];
    for (let i = 0; i < idsActuales.length && i < f.pictures.length; i++) {
      fotos.push({ clave: idsActuales[i], rgb: await medir(f.pictures[i].source, rgbDe.size) });
    }
    fotosPorColor = repartirPorColor(anclas, fotos);
  } catch (e) {
    console.error("   (no se pudo repartir las fotos por color:", e.message + ")");
  }
}

const body = {
  // MELI no deja cambiar el título de una publicación con ventas. Mandarlo
  // igual hace fallar el PUT entero y con él los atributos, que sí se pueden.
  ...(tuvoVentas ? {} : { title: f.title }),
  attributes: attrs,
  // Las fotos que ya están subidas se reutilizan: solo reordenamos.
  variations: (item.variations || []).map(v => {
    const color = (v.attribute_combinations || []).find(a => a.id === "COLOR")?.value_name;
    const propias = fotosPorColor?.[color];
    // Si un color quedó sin fotos propias, mejor todas que ninguna: MELI exige
    // al menos una por variación.
    const ids = propias && propias.length ? propias : idsActuales;
    return { id: v.id, picture_ids: ids.slice(0, 10) };
  }),
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
