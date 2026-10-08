// Crea en MELI las guías de talles que faltan, una por molde.
// Uso: node meli/crear-guias.mjs [--confirmar]
//
// Cada dominio pide atributos de fila distintos y no hay forma de consultarlos:
// la unica manera es mandar una grilla minima y leer que reclama. Eso hace acá
// antes de crear la buena.
import fs from "fs";
import { neon } from "@neondatabase/serverless";

for (const l of fs.readFileSync("/Users/alanlopez/Desktop/Claudito/tussy-app/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const sql = neon(process.env.DATABASE_URL);
const API = "https://api.mercadolibre.com";
const confirmar = process.argv.includes("--confirmar");

const GUIAS = JSON.parse(fs.readFileSync(new URL("./guias-talles.json", import.meta.url), "utf8"));
const FICHAS = JSON.parse(fs.readFileSync(new URL("./publicaciones.json", import.meta.url), "utf8"));

// Talles que realmente usan los productos de cada molde. La guia se arma solo
// con esos: cargar talles de mas no aporta y encima puede romper, porque
// FILTRABLE_SIZE acepta menos valores que SIZE segun la categoria (en Buzos
// rechaza XXL aunque la categoria lo liste como talle valido).
function tallesEnUso(molde) {
  const s = new Set();
  for (const f of FICHAS) if (f.size_grid === molde) for (const v of f.variaciones) if (v.SIZE) s.add(v.SIZE);
  return s;
}

// molde -> dominio de MELI y género
const DOMINIO = {
  CAMPERA_PERLE_TEJIDA: { dom: "JACKETS_AND_COATS", nombre: "Tussy Campera Tejida" },
  CAMPERA_TSSY:         { dom: "JACKETS_AND_COATS", nombre: "Tussy Campera" },
  SWEATERS_2026:        { dom: "SWEATERS_AND_CARDIGANS", nombre: "Tussy Sweater" },
  BUZO_CANGURO:         { dom: "SWEATSHIRTS_AND_HOODIES", nombre: "Tussy Buzo Canguro" },
  PANTALONES:           { dom: "PANTS", nombre: "Tussy Pantalon" },
};

// nuestras medidas -> atributos de MELI, por orden de preferencia
const MAPA = {
  GARMENT_LENGTH_FROM:         ["largo", "largo_cuerpo"],
  // "ancho_cintura" en la planilla de la campera es el ancho del cuerpo a lo
  // plano, o sea lo mismo que MELI llama ancho de pecho con otro nombre.
  GARMENT_CHEST_WIDTH_FROM:    ["ancho", "ancho_cuerpo_bajo_sisa", "sisa", "ancho_cintura"],
  GARMENT_SLEEVE_LENGTH_FROM:  ["largo_manga", "manga"],
  GARMENT_SHOULDER_WIDTH_FROM: ["copa_hombro_a_hombro", "ancho_alto_ruedo"],
  GARMENT_WAIST_WIDTH_FROM:    ["cintura", "ancho_cintura"],
  // En pantalones nuestra planilla trae un solo "ancho", que es la cintura a lo
  // plano: es la medida que MELI pide como ancho de cadera para esa categoria.
  GARMENT_HIP_WIDTH_FROM:      ["cadera", "ancho_cadera", "ancho"],
};

const [{ access_token: T }] = await sql`SELECT access_token FROM meli_cuenta WHERE id = 1`;
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };

async function postChart(body) {
  const r = await fetch(`${API}/catalog/charts`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { ok: r.ok, j: await r.json() };
}

function armar(molde, dom, nombre, atributos) {
  const G = GUIAS.moldes[molde];
  const enUso = tallesEnUso(molde);
  const rows = Object.entries(G.talles).filter(([t]) => !enUso.size || enUso.has(t)).map(([t, v]) => {
    const at = [{ id: "SIZE", values: [{ name: t }] }, { id: "FILTRABLE_SIZE", values: [{ name: t }] }];
    for (const a of atributos) {
      const campo = (MAPA[a] || []).find(c => G.medidas.includes(c));
      if (!campo) continue;
      const val = v[G.medidas.indexOf(campo)];
      if (val == null) continue;
      at.push({ id: a, values: [{ name: `${String(val).split("/")[0]} cm` }] });
    }
    return { attributes: at };
  });
  return {
    names: { MLA: nombre }, domain_id: dom, site_id: "MLA",
    measure_type: "CLOTHING_MEASURE",
    main_attribute: { attributes: [{ site_id: "MLA", id: "SIZE" }] },
    attributes: [{ id: "BRAND", values: [{ name: "Tussy" }] }, { id: "GENDER", values: [{ name: "Hombre" }] }],
    rows,
  };
}

for (const [molde, { dom, nombre }] of Object.entries(DOMINIO)) {
  if (GUIAS.moldes[molde]?.meli?.size_grid_id) { console.log(`· ${molde}: ya creada (${GUIAS.moldes[molde].meli.size_grid_id})`); continue; }

  // sonda: grilla minima para que MELI diga que le falta
  const sonda = armar(molde, dom, `sonda ${Date.now()}`, []);
  const { j } = await postChart(sonda);
  const req = [...new Set((j.errors || [])
    .filter(e => e.code === "required_row_attribute_not_found")
    .map(e => e.cell?.attribute_id).filter(x => x && x !== "FILTRABLE_SIZE"))];

  const body = armar(molde, dom, nombre, req);
  const usados = [...new Set(body.rows[0].attributes.map(a => a.id))].filter(a => !["SIZE", "FILTRABLE_SIZE"].includes(a));
  const faltan = req.filter(a => !usados.includes(a));

  if (!confirmar) {
    console.log(`\n${molde} (${dom})`);
    console.log(`  pide: ${req.join(", ") || "nada extra"}`);
    console.log(`  mapeo: ${usados.join(", ") || "ninguno"}${faltan.length ? `  ⚠ sin dato para: ${faltan.join(", ")}` : ""}`);
    console.log(`  filas: ${body.rows.length} (${Object.keys(GUIAS.moldes[molde].talles).join("/")})`);
    continue;
  }

  const { ok, j: res } = await postChart(body);
  if (!ok) {
    console.log(`✗ ${molde}: ${(res.errors || []).map(e => e.message).slice(0, 2).join(" | ") || res.message}`);
    continue;
  }
  console.log(`✓ ${molde} -> ${res.id}  (${usados.join(", ")})`);
  GUIAS.moldes[molde].meli = { size_grid_id: String(res.id), domain_id: dom };
}

if (confirmar) {
  fs.writeFileSync(new URL("./guias-talles.json", import.meta.url), JSON.stringify(GUIAS, null, 2));
  console.log("\nguias-talles.json actualizado");
}
