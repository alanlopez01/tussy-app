// Genera meli/publicaciones.json: una ficha por producto lista para POST /items.
// Entrada: catalogo de Tiendanube + guias-talles.json. No toca MELI.
import fs from "fs";

const CAT = JSON.parse(fs.readFileSync("/private/tmp/claude-501/-Users-alanlopez-Desktop-Claudito/de39b6c3-4ac5-4caa-986d-aad6aa47d917/scratchpad/tn-catalogo.json", "utf8"));
const GUIAS = JSON.parse(fs.readFileSync("guias-talles.json", "utf8"));
// Qué foto es la de portada de cada producto. La calcula detectar.mjs midiendo el
// borde de cada imagen (un packshot sobre blanco da ~100% de píxeles claros ahí).
// Va cacheado porque recalcularlo baja ~250 fotos de Tiendanube.
const PORTADAS = JSON.parse(fs.readFileSync("portadas.json", "utf8"));

const TALLE = { "1": "S", "2": "M", "3": "L", "4": "XL", "xxl": "XXL" };
// Sin talle (bolsos, gorra, pines) va "Único": si no, String(undefined) dejaba
// un talle literal "UNDEFINED" en la publicación.
const norm = t => (t == null || t === "" || t === "-") ? "Único" : (TALLE[String(t)] || String(t).toUpperCase());
const sube = p => Math.ceil((p * 1.15 - 900) / 1000) * 1000 + 900;

// molde, categoria MELI y atributos por tipo de producto
const TIPOS = {
  remera:  { molde:"REMERA_OVERSIZE", cat:"MLA109042", calce:"oversize",
             attrs:{GENDER:"Hombre",GARMENT_TYPE:"Remera",SLEEVE_TYPE:"Corta",MAIN_MATERIAL:"Algodón",
                    COMPOSITION:"Algodón",T_SHIRT_COLLAR_TYPE:"Redondo",WEDGE_SHAPE:"Oversized",
                    SALE_FORMAT:"Unidad",UNITS_PER_PACK:"1",IS_SPORTIVE:"No",WITH_RECYCLED_MATERIALS:"No"} },
  remeraM: { molde:"REMERA_MUJER",    cat:"MLA109042", calce:"regular",
             attrs:{GENDER:"Mujer",GARMENT_TYPE:"Remera",SLEEVE_TYPE:"Corta",MAIN_MATERIAL:"Algodón",
                    COMPOSITION:"Algodón",T_SHIRT_COLLAR_TYPE:"Redondo",WEDGE_SHAPE:"Recto",
                    SALE_FORMAT:"Unidad",UNITS_PER_PACK:"1",IS_SPORTIVE:"No",WITH_RECYCLED_MATERIALS:"No"} },
  camperaT:{ molde:"CAMPERA_PERLE_TEJIDA", cat:"MLA109096", calce:"oversize",
             attrs:{GENDER:"Hombre",MAIN_MATERIAL:"Tejido de punto",GARMENT_TYPE:"Campera",SALE_FORMAT:"Unidad"} },
  campera: { molde:"CAMPERA_TSSY",    cat:"MLA109096", calce:"oversize",
             attrs:{GENDER:"Hombre",MAIN_MATERIAL:"Algodón",GARMENT_TYPE:"Campera",SALE_FORMAT:"Unidad"} },
  sweater: { molde:"SWEATERS_2026",   cat:"MLA109100", calce:"oversize",
             attrs:{GENDER:"Hombre",MAIN_MATERIAL:"Tejido de punto",SALE_FORMAT:"Unidad"} },
  buzo:    { molde:"BUZO_CANGURO",    cat:"MLA109085", calce:"oversize",
             attrs:{GENDER:"Hombre",MAIN_MATERIAL:"Algodón",COMPOSITION:"Algodón",SALE_FORMAT:"Unidad",IS_SPORTIVE:"No",GARMENT_TYPE:"Hoodie"} },
  // El Asimov es un conjunto deportivo con vivos, de ahi PANT_TYPE "Deportivo".
  pantalon:{ molde:"PANTALONES",      cat:"MLA109282", calce:"baggy",
             attrs:{GENDER:"Hombre",MAIN_MATERIAL:"Algodón",PANT_TYPE:"Deportivo",SALE_FORMAT:"Unidad"} },
  boxer:   { molde:"BOXER",           cat:"MLA429740", attrs:{GENDER:"Hombre",MAIN_MATERIAL:"Algodón",COMPOSITION:"Algodón",SALE_FORMAT:"Unidad",MALE_UNDERWEAR_TYPE:"Boxer"} },
  bolso:   { molde:null,              cat:"MLA432000", attrs:{GENDER:"Sin género"} },
  // Mochila, gorra, boxer y pin piden cada uno su tipo propio.
  mochila: { molde:null,              cat:"MLA120350", attrs:{GENDER:"Sin género",BACKPACK_TYPE:"Urbana"} },
  // La Scout es camuflada verde y no tiene variante de color en Tiendanube, así
  // que el COLOR que pide la categoría va a nivel publicación.
  gorra:   { molde:null,              cat:"MLA67460",  attrs:{GENDER:"Sin género",HAT_AND_CAP_TYPE:"Gorra",COLOR:"Verde"} },
  pin:     { molde:null,              cat:"MLA393903", attrs:{GENDER:"Sin género"} },
};

const SELECCION = {
  // bloque A — los 9 ultimos
  "REMERA OVERSIZE HOMIES":"remera","REMERA OVERSIZE RAIDEN":"remera","REMERA OVERSIZE KITANA":"remera",
  "CAMPERA TEJIDA BRICKELL":"camperaT","REMERA OVERSIZE RED DEUS":"remera",
  "PANTALON BAGGY TSSY ASIMOV":"pantalon","CAMPERA TSSY ASIMOV":"campera",
  "REMERA OVERSIZE HARLY":"remera","REMERA OVERSIZE CASTLE":"remera",
  // bloque B — los 20 mas vendidos
  "REMERA OVERSIZE TAILS CON BRILLOS":"remera","REMERA TSSY DIAMONDS":"remera","BOLSO TSSY":"bolso",
  "REMERA OVERSIZE ROOTS":"remera","REMERA OVERSIZE AMBERLINE":"remera","REMERA OVERSIZE FLYING":"remera",
  "REMERA OVERSIZE FIRE FIX":"remera","REMERA OVERSIZE BLESSED TSSY":"remera","REMERA OVERSIZE GLOBAL":"remera",
  "SWEATER ATLANTIC TSSY":"sweater","CAMPERA TSSY OUTSIDER":"campera","REMERA OVERSIZE PRAYER TSSY":"remera",
  "BOLSO VALHALA":"bolso","REMERA OVERSIZE ANGELS":"remera","REMERA OVERSIZE VIRGIN TSSY":"remera",
  "REMERA OVERSIZE ECLIPSE":"remera","REMERA OVERSIZE VICECITY":"remera","CAMPERA TSSY DIZZY":"campera",
  "SWEATER WEAVES TSSY":"sweater","BUZO OVERSIZE BLUE JAYS":"buzo",
  // accesorios con stock
  "BOLSO TRAVEL":"bolso","MOCHILA TSSY":"mochila","BOLSO SQUARE":"bolso","BOLSO BELT":"bolso",
  "BOLSO CHEW":"bolso","BOLSO POCKET":"bolso","GORRA SCOUT":"gorra",
  "BOXER STRIPE":"boxer","BOXER TUSSY":"boxer","BOXER ALWAYS":"boxer","BOXER T-COM":"boxer","BOXER T-COM LINE":"boxer",
  "PIN TUSSY SY":"pin","PIN TUSSY T":"pin",
};

// --- titulo: el MISMO nombre que en la web ---
// Decisión de Alan: ganamos por posicionamiento de marca, no por keywords.
// Nada de "Algodón Hombre" al final para pescar búsquedas.
function titulo(nombre) {
  return nombre.toLowerCase()
    .replace(/\b[a-záéíóúñ]/g, c => c.toUpperCase())
    .replace(/\bPantalon\b/g, "Pantalón")
    .replace(/\bCamiseta Arg\b/g, "Camiseta ARG")
    .slice(0, 60);
}

// --- descripción ---
// Molde tomado de cómo escriben Bullbenny y King of the Kongo: abre con el calce
// y el material, después composición, medidas y cuidados. Sin keywords metidas a
// la fuerza. Solo afirmamos lo que sabemos: no inventamos detalles de confección.
const QUE_ES = {
  remera: "Remera de calce oversize en algodón.",
  remeraM: "Remera de calce regular en algodón.",
  camperaT: "Campera tejida con capucha y cierre.",
  campera: "Campera con capucha y cierre.",
  sweater: "Sweater de punto, escote redondo.",
  buzo: "Buzo canguro con capucha y bolsillo delantero.",
  pantalon: "Pantalón de calce baggy.",
  boxer: "Boxer de algodón con elástico de cintura.",
  bolso: "Bolso Tussy.", mochila: "Mochila Tussy.",
  gorra: "Gorra Tussy.", pin: "Pin metálico Tussy.",
};
const ALGODON = new Set(["remera", "remeraM", "buzo", "boxer"]);

function descripcion(nombre, tipo, colores, talles) {
  const T = TIPOS[tipo];
  const l = [QUE_ES[tipo], ""];

  if (ALGODON.has(tipo)) {
    l.push("Tejido 100% algodón, desarrollado por Tussy. Es un algodón similar a un 16.1: tiene cuerpo y caída, y no se deforma con el uso.", "");
  }
  if (colores.length > 1) l.push(`Colores: ${colores.join(", ")}.`);
  if (talles.length > 1) l.push(`Talles: ${talles.join(" / ")}.`);
  if (colores.length > 1 || talles.length > 1) l.push("");

  const g = T.molde && GUIAS.moldes[T.molde];
  if (g) {
    const campos = g.medidas.filter(c => c !== "copa");
    l.push("MEDIDAS APROXIMADAS (prenda apoyada, en cm)");
    l.push(["Talle", ...campos.map(c => c.replace(/_/g, " "))].join(" · "));
    for (const [t, v] of Object.entries(g.talles)) {
      if (talles.length && !talles.includes(t)) continue;
      l.push([t, ...g.medidas.map((c, i) => campos.includes(c) ? v[i] : null).filter(x => x !== null)].join(" · "));
    }
    l.push("");
  }

  if (ALGODON.has(tipo) || ["camperaT", "sweater", "campera", "pantalon"].includes(tipo)) {
    l.push("CUIDADOS");
    l.push("Lavar con agua fría del lado del revés. No usar lavandina. No secar a máquina. No planchar sobre la estampa.", "");
  }

  l.push("Tussy es una marca argentina de streetwear. Producto original, con etiqueta y packaging de la marca.");
  l.push("Despachamos dentro de las 24 h hábiles de acreditado el pago.");
  return l.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const salida = [];
for (const [nombre, tipo] of Object.entries(SELECCION)) {
  const p = CAT.find(x => x.name.es === nombre);
  if (!p) { console.log("NO ENCONTRADO:", nombre); continue; }
  const vs = (p.variants || []).filter(v => v.visible !== false);
  // Un color entra si ALGUNA de sus variantes tiene stock; si entra, van TODOS sus talles
  // (la curva se publica completa: el stock real lo carga Alan a mano en MELI).
  const coloresVivos = new Set(vs.filter(v => v.stock === null || Number(v.stock) > 0)
    .map(v => v.values?.[0]?.es || "-"));
  const base = coloresVivos.size
    ? vs.filter(v => coloresVivos.has(v.values?.[0]?.es || "-"))
    : vs;                                              // sin ningun color vivo, se crean todos
  const colores = [...new Set(base.map(v => v.values?.[0]?.es).filter(x => x && x !== "-"))];
  const talles = [...new Set(base.map(v => norm(v.values?.[1]?.es)).filter(x => x && x !== "-"))];
  const precioTN = Math.max(...vs.map(v => Number(v.price)).filter(x => x > 0));
  const T = TIPOS[tipo];
  salida.push({
    tn_id: p.id, tn_nombre: nombre, tipo,
    title: titulo(nombre),
    category_id: T.cat,
    size_grid: T.molde,
    price_tn: precioTN,
    price_meli: sube(precioTN),
    status: "paused",
    available_quantity: 1,
    attributes: { BRAND: "Tussy", MODEL: nombre, ...T.attrs },
    variaciones: base.map(v => ({
      sku: (v.sku || "").trim() || null,
      COLOR: v.values?.[0]?.es || null,
      SIZE: norm(v.values?.[1]?.es),
      peso_kg: Number(v.weight) || null,
      // MELI exige 1..10 fotos POR variación. Tiendanube asocia una foto a cada
      // variante con image_id: cuando está, le damos a cada color su foto; cuando
      // no (27 de 43 productos), la variación se queda con todas las del producto.
      foto: (p.images || []).find(i => i.id === v.image_id)?.src || null,
    })),
    description: descripcion(nombre, tipo, colores, talles),
    pictures: (() => {
      const imgs = (p.images || []).sort((a, b) => a.position - b.position);
      const i = PORTADAS[p.id]?.portada;
      // la de contexto primero: MELI pondera mucho la portada y una foto de
      // ambiente convierte bastante mejor que un packshot sobre fondo blanco
      const orden = i != null ? [imgs[i], ...imgs.filter((_, n) => n !== i)] : imgs;
      return orden.filter(Boolean).map(x => ({ source: x.src }));
    })(),
    portada_contexto: PORTADAS[p.id]?.portada != null ? PORTADAS[p.id].portada + 1 : null,
  });
}
fs.writeFileSync("publicaciones.json", JSON.stringify(salida, null, 2));
console.log("publicaciones armadas:", salida.length);
console.log("variaciones totales:", salida.reduce((a, x) => a + x.variaciones.length, 0));
console.log("titulos de mas de 60 caracteres:", salida.filter(x => x.title.length > 60).length);
console.log("sin SKU en alguna variante:", salida.filter(x => x.variaciones.some(v => !v.sku)).map(x => x.tn_nombre).join(", ") || "ninguno");
