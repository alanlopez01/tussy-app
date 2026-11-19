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
  gorra:   { molde:null,              cat:"MLA67460",  attrs:{GENDER:"Sin género",HAT_AND_CAP_TYPE:"Gorra"} },
  pin:     { molde:null,              cat:"MLA393903", attrs:{GENDER:"Sin género"} },
};

// Atributos que dependen del producto y no del tipo. Las gorras no tienen
// variante de color en Tiendanube —son una sola variante sin valores— pero MELI
// exige COLOR en la categoría y con lista cerrada, así que va acá, uno por uno.
// El COLOR estaba fijo en el tipo "gorra" porque la primera fue la Scout, que es
// camuflada verde; dejarlo ahí hacía que toda gorra nueva naciera verde.
// Las bicolores (SIX blanca con líneas azules, OCEAN azul y beige) van con el
// tono dominante: MELI acepta un solo valor.
const ATRIBUTOS_POR_PRODUCTO = {
  "BUZO OVERSIZE BORDADO SY": { WITH_EMBROIDERY: "Sí" },
  "GORRA SCOUT":          { COLOR: "Verde" },       // camuflada, visera curva: queda como gorra genérica
  "GORRA TUSSY SIX":      { COLOR: "Blanco", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Rayas" },
  "GORRA TUSSY PRINCE":   { COLOR: "Crema", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },       // hueso
  "GORRA TUSSY SERPENT":  { COLOR: "Verde", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },
  "GORRA TUSSY OCEAN":    { COLOR: "Azul oscuro", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },
  "GORRA TSSY GLORY":     { COLOR: "Beige", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },
  "GORRA TUSSY EMPEROR":  { COLOR: "Negro", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },
  "GORRA TUSSY ROYAL":    { COLOR: "Negro", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },
  "GORRA TUSSY WILDFIRE": { COLOR: "Negro", HAT_AND_CAP_TYPE: "Snapback", WITH_ADJUSTABLE_CLOSURE: "Sí", FABRIC_DESIGN: "Lisa" },
};

// Títulos propios. El generado de "titulo()" sale corto —"Gorra Tussy Six", 15
// de los 60 caracteres que deja MELI— y el resto del espacio es justamente
// donde se busca. Las palabras salen de los atributos reales de la categoría
// (snapback, visera plana, paneles), no de adjetivos tipo "premium" o "alta
// calidad", que no se buscan y MELI lee como relleno.
const TITULO_POR_PRODUCTO = {
  "GORRA TUSSY SIX":      "Gorra Tussy Six Snapback Visera Plana 6 Paneles Rayas",
  "GORRA TUSSY OCEAN":    "Gorra Tussy Ocean Snapback Visera Plana 6 Paneles Bordada",
  "GORRA TUSSY EMPEROR":  "Gorra Tussy Emperor Snapback Visera Plana 6 Paneles Negra",
  "GORRA TUSSY ROYAL":    "Gorra Tussy Royal Snapback Visera Plana 6 Paneles Bordada",
  "GORRA TUSSY WILDFIRE": "Gorra Tussy Wildfire Snapback Visera Plana 6 Paneles Negra",
  "GORRA TUSSY PRINCE":   "Gorra Tussy Prince Snapback Visera Plana 6 Paneles Bordada",
  "GORRA TUSSY SERPENT":  "Gorra Tussy Serpent Snapback Visera Plana 6 Paneles Verde",
  "GORRA TSSY GLORY":     "Gorra Tssy Glory Snapback Visera Plana 6 Paneles Bordada",
};

const SELECCION = {
  // bloque E — tanda 23-oct-2026: remeras y buzos con video
  "REMERA OVERSIZE ZERO":"remera","REMERA OVERSIZE YAT":"remera","REMERA OVERSIZE RABB":"remera",
  "REMERA OVERSIZE COUSING":"remera","REMERA OVERSIZE ALWAYS":"remera","REMERA OVERSIZE STICK":"remera",
  "REMERA OVERSIZE TENNISCLB":"remera","REMERA OVERSIZE CUSTARD":"remera","REMERA OVERSIZE ICE":"remera",
  "REMERA OVERSIZE CATENA":"remera","REMERA OVERSIZE VICE":"remera","REMERA OVERSIZE WORLDTRIBE":"remera",
  "REMERA OVERSIZE EVOLUTION":"remera","REMERA OVERSIZE GODNESS TSSY":"remera",
  "BUZO OVERSIZE BUSSY":"buzo","BUZO OVERSIZE 001/94":"buzo","BUZO OVERSIZE CLOSING":"buzo",
  "BUZO OVERSIZE WORLDTRIBE":"buzo","BUZO OVERSIZE COUSING":"buzo","BUZO CANGURO OVERSIZE LIMITED":"buzo",
  "BUZO OVERSIZE STAY":"buzo","BUZO OVERSIZE T-COM":"buzo","BUZO OVERSIZE TOAD":"buzo",
  "BUZO OVERSIZE VICE":"buzo",
  // Estos dos tienen video y stock ilimitado en negro. Quedaron afuera de la
  // primera pasada por un error de criterio: en Tiendanube `stock: null` es
  // "sin control de stock", no cero.
  "BUZO OVERSIZE BORDADO SY":"buzo","BUZO OVERSIZE CLOUD":"buzo",
  // bloque D — gorras nuevas (23-oct-2026)
  "GORRA TUSSY SIX":"gorra","GORRA TUSSY OCEAN":"gorra","GORRA TUSSY EMPEROR":"gorra",
  "GORRA TUSSY ROYAL":"gorra","GORRA TUSSY WILDFIRE":"gorra","GORRA TUSSY PRINCE":"gorra",
  "GORRA TUSSY SERPENT":"gorra","GORRA TSSY GLORY":"gorra",
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

// MELI deja 60 caracteres de título y un "Remera Oversize Zero" usa 20: los 40
// que sobran son donde la gente busca.
//
// El patrón sale de las publicaciones de Tussy que VENDIERON (Eclipse, Global,
// Homies, Kitana, Roots): las cinco tienen ventas y las cinco llevan el mismo
// sufijo. Lo puso Alan a mano y funcionó, así que las nuevas lo copian en vez
// de inventar palabras clave.
const SUFIJO_TITULO = "Hombre Unisex Valley Mixed";
const BASE_TITULO = {
  remera:  n => `Remera Oversize Tussy ${n}`,
  remeraM: n => `Remera Tussy ${n}`,
  buzo:    n => `Buzo Oversize Tussy ${n}`,
};

// Nombres que en Tiendanube están abreviados y en el título se leen como un
// error de tipeo (y encima pierden la palabra que la gente busca).
const MODELO_LEGIBLE = { "Tennisclb": "Tennis Club", "T-com": "T-Com", "Gg": "GG" };

function tituloConClaves(nombre, tipo) {
  const base = BASE_TITULO[tipo];
  if (!base) return titulo(nombre);
  // El modelo es lo que queda sacándole al nombre las palabras genéricas, que
  // ya van en el prefijo: "REMERA OVERSIZE ZERO" -> "Zero".
  const modelo = titulo(nombre)
    .replace(/\b(Remera|Buzo|Canguro|Oversize|Tussy|Tssy)\b/g, "")
    .replace(/\s+/g, " ").trim();
  const t = base(MODELO_LEGIBLE[modelo] || modelo).replace(/\s+/g, " ").trim();
  const completo = `${t} ${SUFIJO_TITULO}`;
  return completo.length <= 60 ? completo : t.slice(0, 60).trim();
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

  // El calce es lo que más se pregunta y lo que más devoluciones genera: una
  // remera oversize le queda enorme a quien esperaba un calce regular. Decirlo
  // arriba, con una acción concreta, ahorra la consulta y el cambio.
  if (T.calce) {
    const COMO_CAE = {
      oversize: "Oversize: hombro caído y cuerpo amplio, pensado para que quede suelto. Si lo preferís más ajustado al cuerpo, pedí un talle menos.",
      regular:  "Calce regular: sigue la línea del cuerpo, sin quedar ajustado.",
      baggy:    "Calce baggy: holgado de cadera a botamanga. Si lo preferís menos ancho, pedí un talle menos.",
    };
    if (COMO_CAE[T.calce]) l.push("CALCE", COMO_CAE[T.calce], "");
  }

  if (colores.length > 1) l.push(`Colores: ${colores.join(", ")}.`);
  if (talles.length > 1) l.push(`Talles: ${talles.join(" / ")}.`);
  if (colores.length > 1 || talles.length > 1) l.push("");

  const g = T.molde && GUIAS.moldes[T.molde];
  if (g) {
    const campos = g.medidas.filter(c => c !== "copa");
    l.push("MEDIDAS DE LA PRENDA (apoyada, en cm)");
    l.push(["Talle", ...campos.map(c => c.replace(/_/g, " "))].join(" · "));
    for (const [t, v] of Object.entries(g.talles)) {
      if (talles.length && !talles.includes(t)) continue;
      l.push([t, ...g.medidas.map((c, i) => campos.includes(c) ? v[i] : null).filter(x => x !== null)].join(" · "));
    }
    // Sin esto la tabla no sirve: el comprador no sabe contra qué compararla.
    l.push("Para elegir: agarrá una prenda tuya que te quede como te gusta, apoyala y medila igual. Comparala con esta tabla.");
    l.push("");
    l.push(T.attrs.GENDER === "Mujer"
      ? "La modelo de las fotos usa talle S y mide 1,68 m."
      : "El modelo de las fotos usa talle M y mide 1,78 m.");
    l.push("");
  }

  if (ALGODON.has(tipo)) {
    l.push("TELA");
    l.push("100% algodón desarrollado por Tussy, similar a un 16.1: tiene cuerpo y caída, y no se deforma con el uso.", "");
  }

  if (ALGODON.has(tipo) || ["camperaT", "sweater", "campera", "pantalon"].includes(tipo)) {
    l.push("CUIDADOS");
    l.push("Lavar con agua fría del lado del revés. No usar lavandina. No secar a máquina. No planchar sobre la estampa.", "");
  }

  l.push("TUSSY");
  l.push("Marca argentina de streetwear. Producto original, con etiqueta y packaging de la marca.");
  l.push("Despachamos dentro de las 24 h hábiles de acreditado el pago.");
  return l.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


// Tanda del 23-oct-2026. A diferencia de las anteriores —que salieron con la
// curva de colores completa y cantidad 1— estas se publican acotadas: sólo
// negro y crudo, con 5 unidades por variación.
//
// "Crudo" no existe como color en Tiendanube: según el producto aparece como
// Hueso o como Blanco, nunca los dos en el mismo. Por eso se aceptan ambos.
//
// La regla va por producto y no en el molde general a propósito: aplicada
// global reescribiría las 43 fichas ya publicadas, que tienen todos sus colores.
const ES_NEGRO = c => /^negro$/i.test(String(c || "").trim());
const ES_CRUDO = c => /^(hueso|blanco)$/i.test(String(c || "").trim());
const TANDA_ACOTADA = new Set([
  "REMERA OVERSIZE ZERO", "REMERA OVERSIZE YAT", "REMERA OVERSIZE RABB",
  "REMERA OVERSIZE COUSING", "REMERA OVERSIZE ALWAYS", "REMERA OVERSIZE STICK",
  "REMERA OVERSIZE TENNISCLB", "REMERA OVERSIZE CUSTARD", "REMERA OVERSIZE ICE",
  "REMERA OVERSIZE CATENA", "REMERA OVERSIZE VICE", "REMERA OVERSIZE WORLDTRIBE",
  "REMERA OVERSIZE EVOLUTION", "REMERA OVERSIZE GODNESS TSSY",
  "BUZO OVERSIZE BUSSY", "BUZO OVERSIZE 001/94", "BUZO OVERSIZE CLOSING",
  "BUZO OVERSIZE WORLDTRIBE", "BUZO OVERSIZE COUSING", "BUZO CANGURO OVERSIZE LIMITED",
  "BUZO OVERSIZE STAY", "BUZO OVERSIZE T-COM", "BUZO OVERSIZE TOAD", "BUZO OVERSIZE VICE",
  "BUZO OVERSIZE BORDADO SY", "BUZO OVERSIZE CLOUD",
]);
const CANTIDAD_TANDA = 5;

const salida = [];
for (const [nombre, tipo] of Object.entries(SELECCION)) {
  const p = CAT.find(x => x.name.es === nombre);
  if (!p) { console.log("NO ENCONTRADO:", nombre); continue; }
  const vs = (p.variants || []).filter(v => v.visible !== false);
  // Un color entra si ALGUNA de sus variantes tiene stock; si entra, van TODOS sus talles
  // (la curva se publica completa: el stock real lo carga Alan a mano en MELI).
  const coloresVivos = new Set(vs.filter(v => v.stock === null || Number(v.stock) > 0)
    .map(v => v.values?.[0]?.es || "-"));
  let base = coloresVivos.size
    ? vs.filter(v => coloresVivos.has(v.values?.[0]?.es || "-"))
    : vs;                                              // sin ningun color vivo, se crean todos
  if (TANDA_ACOTADA.has(nombre)) {
    base = vs.filter(v => {
      const c = v.values?.[0]?.es;
      if (!ES_NEGRO(c) && !ES_CRUDO(c)) return false;
      const t = norm(v.values?.[1]?.es);
      // Los extremos de la curva no se publican en esta tanda.
      if (t === "XS" || t === "XXL") return false;
      // Y en los buzos tampoco el S del crudo.
      if (tipo === "buzo" && ES_CRUDO(c) && t === "S") return false;
      return true;
    });
  }
  const colores = [...new Set(base.map(v => v.values?.[0]?.es).filter(x => x && x !== "-"))];
  // Ordenados como talles, no como vengan las variantes: "M / L / XL / S" se lee
  // como un error de carga.
  const ORDEN_TALLE = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
  const talles = [...new Set(base.map(v => norm(v.values?.[1]?.es)).filter(x => x && x !== "-"))]
    .sort((a, b) => {
      const ia = ORDEN_TALLE.indexOf(a), ib = ORDEN_TALLE.indexOf(b);
      if (ia === -1 && ib === -1) return String(a).localeCompare(String(b), "es", { numeric: true });
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  const precioTN = Math.max(...vs.map(v => Number(v.price)).filter(x => x > 0));
  const T = TIPOS[tipo];
  salida.push({
    tn_id: p.id, tn_nombre: nombre, tipo,
    title: TITULO_POR_PRODUCTO[nombre] || tituloConClaves(nombre, tipo),
    category_id: T.cat,
    size_grid: T.molde,
    price_tn: precioTN,
    price_meli: sube(precioTN),
    status: "paused",
    available_quantity: TANDA_ACOTADA.has(nombre) ? CANTIDAD_TANDA : 1,
    attributes: { BRAND: "Tussy", MODEL: nombre, ...T.attrs, ...(ATRIBUTOS_POR_PRODUCTO[nombre] || {}) },
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
    // Una foto ancla por CADA color del producto, no sólo por los que se
    // publican. Sin los colores descartados, sus fotos se reparten entre los
    // publicados por cercanía y terminan mostrando la prenda equivocada: en
    // REMERA ZERO, las de la azul y la marrón caían en "Negro".
    anclas_color: Object.fromEntries(
      [...new Set(vs.map(v => v.values?.[0]?.es).filter(Boolean))].map(c => {
        const v = vs.find(x => x.values?.[0]?.es === c && x.image_id);
        const img = v && (p.images || []).find(i => i.id === v.image_id);
        return [c, img ? img.src : null];
      }).filter(([, src]) => src)
    ),
  });
}
fs.writeFileSync("publicaciones.json", JSON.stringify(salida, null, 2));
console.log("publicaciones armadas:", salida.length);
console.log("variaciones totales:", salida.reduce((a, x) => a + x.variaciones.length, 0));
console.log("titulos de mas de 60 caracteres:", salida.filter(x => x.title.length > 60).length);
console.log("sin SKU en alguna variante:", salida.filter(x => x.variaciones.some(v => !v.sku)).map(x => x.tn_nombre).join(", ") || "ninguno");
