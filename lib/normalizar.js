// Normalización de nombres de producto — unifica variantes en un modelo.
// Única fuente de verdad: la usan la ingesta, las métricas y los scripts.
const CATEGORIAS = ["REMERA","REMERON","POLO","POLERA","PANTALON","PANTALONES","BUZO","CAMPERA",
  "CAMISA","BERMUDA","BERMUDAS","SHORT","SHORTS","VESTIDO","TOP","BOXER","LLAVERO",
  "MUSCULOSA","SWEATER","JEAN","JEANS","CHALECO","CARDIGAN","CHOMBA","BODY",
  "CALZA","CALZAS","FALDA","RIÑONERA","GORRA","MEDIAS","SACO"];
const IGNORAR = new Set([
  "OVERSIZE","TSSY","TSSYA","BOXY","BAGGY","MUJER","HOMBRE","UNISEX",
  "REGULAR","CLASSIC","CLASSICO","CLASICO","PREMIUM","LIMITED","EDITION","EDICION",
  "ALGODON","GABARDINA","TENCEL","LINO","POLIESTER","RUSTICO","RUSTICA","LISO","LISA",
  "SET","LINE","KIT","PACK","COLECCION","FW","SS","SPRING","SUMMER","FALL","WINTER",
  "NUEVO","NUEVA","NEW","XL","NARANJA","VIOLETA","BEIGE","GRIS","NEGRO","NEGRA",
  "BLANCO","BLANCA","AZUL","ROJO","ROJA","VERDE","AMARILLO","CELESTE","HUESO",
  "MARRON","BORDO","ROSA","LAVANDA","MELANGE","TAUPE","OLIVA","PETROLEO",
]);
const CATEGORIAS_SET = new Set(CATEGORIAS);

function normalizarProducto(nombre) {
  if (!nombre) return { nombre: "", categoria: "" };
  const n = String(nombre).replace(/\([^)]*\)/g, " ").toUpperCase()
    .replace(/[ÁÀÄÂ]/g, "A").replace(/[ÉÈËÊ]/g, "E").replace(/[ÍÌÏÎ]/g, "I")
    .replace(/[ÓÒÖÔ]/g, "O").replace(/[ÚÙÜÛ]/g, "U").replace(/Ñ/g, "N")
    .replace(/[-_\/.,;:]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ").trim();

  const palabras = n.split(" ").filter(Boolean);
  let categoria = "";
  for (const p of palabras) {
    if (CATEGORIAS_SET.has(p)) { categoria = p; break; }
  }
  const categoriaSing = categoria.replace(/ES$/, "").replace(/^REMERON$/, "REMERA");

  const modelo = [];
  for (let p of palabras) {
    if (CATEGORIAS_SET.has(p) || IGNORAR.has(p) || p.length < 2) continue;
    if (p.length > 4 && p.endsWith("S") && !p.endsWith("SS") && !p.endsWith("US")) p = p.slice(0, -1);
    modelo.push(p);
  }
  const modeloStr = modelo.join(" ");
  const nombreNorm = categoriaSing && modeloStr ? `${categoriaSing} ${modeloStr}` : (modeloStr || categoriaSing || n);
  return { nombre: nombreNorm, categoria: categoriaSing || "OTROS" };
}

module.exports = { normalizarProducto };
