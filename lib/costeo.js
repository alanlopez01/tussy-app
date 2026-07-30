// Costeo por familia — regla única que usan la carga masiva y la ingesta diaria.
// Los costos son por familia (prenda en crudo + estampa), así que un modelo nuevo
// hereda el costo de su familia automáticamente.

const VIGENTE_DESDE = "2026-03-01";

// Costos de producción por familia (hoja Producción, filas 5-29)
const PROD = {
  REMERA: 7932.37, MUSCULOSA: 6095.87, BUZO: 15684.8, PANTALON: 11563.26,
  BERMUDA: 7463.93, CAMPERA_GABARDINA: 20524.8, REMERA_ML: 9007.65,
  CAMPERA_CALABRIA: 9022.55, PANTALON_CALABRIA: 6378.28,
  POLO: 8355.865, POLO_MUJER: 7287.97, CAMISA: 8164.53, CHOMBA: 9315.71,
  JEAN: 28000, SWEATER: 40000, BOXER: 3000, PIN: 2500, LLAVERO: 3500,
  MEDIAS: 2650, REMERA_MUJER: 4250, PACK_REMERA: 15864.74,
  GORRA: 8500, PERFUMINA: 5200, TOTE_BAG: 3500, PANUELO: 3500,
  BUZO_KAYNE: 17684.8, BUZO_ICE_PEARLS: 17684.8,
  PANTALON_LOTUS: 23750, CAMPERA_LOTUS: 23750,
  CAMPERA_PROM: 17765.783333333333, // promedio camperas (planilla fila 67)
  CROPTOP: 4200, JOGGING: 13897.18, PANTALON_PROM: 13897.18,
};
const ESTAMPA_DEFAULT = 2000;

// Reglas específicas por modelo (prioridad sobre la categoría).
// Cada regla: test sobre el nombre normalizado → { prod, estampa, familia }
const REGLAS = [
  // Campera Tssy Dizzy = costo del buzo + $13.450 (regla de Alan)
  { test: n => n.includes("CAMPERA") && n.includes("DIZZY"), prod: PROD.BUZO + 13450, familia: "Campera Dizzy (buzo + $13.450)" },
  // Doppler = mismo costo que Lotus (regla de Alan)
  { test: n => n.includes("CAMPERA") && (n.includes("LOTUS") || n.includes("DOPPLER")), prod: PROD.CAMPERA_LOTUS, familia: "Campera Lotus/Doppler" },
  { test: n => n.includes("PANTALON") && (n.includes("LOTUS") || n.includes("DOPPLER")), prod: PROD.PANTALON_LOTUS, familia: "Pantalón Lotus/Doppler" },
  { test: n => n.includes("CAMPERA") && n.includes("CALABRIA"), prod: PROD.CAMPERA_CALABRIA, familia: "Campera Calabria" },
  // "PANT ..." es como cargan pantalón en los locales
  { test: n => /(^|\s)PANT(\s|$)/.test(n) && n.includes("CALABRIA"), prod: PROD.PANTALON_CALABRIA, familia: "Pantalón Calabria" },
  { test: n => /(^|\s)PANT(\s|$)/.test(n) && (n.includes("LOTUS") || n.includes("DOPPLER")), prod: PROD.PANTALON_LOTUS, familia: "Pantalón Lotus/Doppler" },
  { test: n => /(^|\s)PANT(\s|$)/.test(n), prod: PROD.PANTALON_PROM, familia: "Pantalón (promedio)" },
  { test: n => n.includes("PANTALON") && n.includes("CALABRIA"), prod: PROD.PANTALON_CALABRIA, familia: "Pantalón Calabria" },
  { test: n => n.includes("CAMPERA") && n.includes("GABARDINA"), prod: PROD.CAMPERA_GABARDINA, familia: "Campera Gabardina" },
  { test: n => n.includes("BUZO") && n.includes("KAYNE"), prod: PROD.BUZO_KAYNE, familia: "Buzo Kayne" },
  { test: n => n.includes("BUZO") && (n.includes("ICE PEARL") || n.includes("PEARL")), prod: PROD.BUZO_ICE_PEARLS, familia: "Buzo Ice Pearls" },
  // Camiseta Arg = mismo costo que chomba deportiva (regla de Alan)
  { test: n => n.includes("CAMISETA"), prod: PROD.CHOMBA, familia: "Camiseta Arg (=Chomba)" },
  { test: n => n.includes("REMERA") && n.includes("MUJER"), prod: PROD.REMERA_MUJER, familia: "Remera Mujer" },
  { test: n => n.includes("POLO") && n.includes("MUJER"), prod: PROD.POLO_MUJER, familia: "Polo Mujer" },
  { test: n => n.includes("PACK") && n.includes("REMERA"), prod: PROD.PACK_REMERA, estampa: 0, familia: "Pack Remera x2" },
  // Accesorios: costo ya final, la estampa/bordado está incluida
  { test: n => n.includes("GORRA") || n.includes("PILUSO"), prod: PROD.GORRA, estampa: 0, familia: "Gorra / Piluso" },
  { test: n => n.includes("PERFUMINA"), prod: PROD.PERFUMINA, estampa: 0, familia: "Perfumina" },
  { test: n => n.includes("TOTE"), prod: PROD.TOTE_BAG, estampa: 0, familia: "Tote Bag" },
  { test: n => n.includes("PANUELO") || n.includes("PAÑUELO"), prod: PROD.PANUELO, estampa: 0, familia: "Pañuelo" },
  // "BASIC SHIRT" = remera lisa, sin estampa
  { test: n => n.includes("BASIC") && n.includes("SHIRT"), prod: PROD.REMERA, estampa: 0, familia: "Remera lisa (Basic Shirt)" },
];

// Categorías generales (orden de la planilla: la primera que matchea gana)
const CATEGORIAS = [
  // Denim: no pasa por la fábrica de estampado
  { clave: "JEAN", prod: PROD.JEAN, estampa: 0, familia: "Jean (denim)" },
  // Todos los sweaters = Sweater Jacquard (regla de Alan)
  { clave: "SWEATER", prod: PROD.SWEATER, familia: "Sweater (=Jacquard)" },
  { clave: "POLO", prod: PROD.POLO, familia: "Polo (promedio)" },
  { clave: "CAMISA", prod: PROD.CAMISA, familia: "Camisa" },
  { clave: "BUZO", prod: PROD.BUZO, familia: "Buzo" },
  { clave: "CAMPERA", prod: PROD.CAMPERA_PROM, familia: "Campera (promedio)" },
  { clave: "JOGGING", prod: PROD.JOGGING, familia: "Jogging" },
  { clave: "PANTALON", prod: PROD.PANTALON_PROM, familia: "Pantalón (promedio)" },
  { clave: "BERMUDA", prod: PROD.BERMUDA, familia: "Bermuda" },
  { clave: "MUSCULOSA", prod: PROD.MUSCULOSA, familia: "Musculosa" },
  { clave: "CHOMBA", prod: PROD.CHOMBA, familia: "Chomba" },
  { clave: "BOXER", prod: PROD.BOXER, estampa: 650, familia: "Boxer" },
  { clave: "PIN", prod: PROD.PIN, estampa: 0, familia: "Pin" },
  { clave: "LLAVERO", prod: PROD.LLAVERO, estampa: 0, familia: "Llavero" },
  { clave: "MEDIAS", prod: PROD.MEDIAS, estampa: 650, familia: "Medias" },
  { clave: "CROPTOP", prod: PROD.CROPTOP, estampa: 0, familia: "Croptop" },
  { clave: "REMERA", prod: PROD.REMERA, familia: "Remera" },
  { clave: "T SHIRT", prod: PROD.REMERA, familia: "Remera (t-shirt)" },
];

function costear(nombre) {
  for (const r of REGLAS) {
    if (r.test(nombre)) {
      return { familia: r.familia, prod: r.prod, estampa: r.estampa ?? ESTAMPA_DEFAULT };
    }
  }
  for (const c of CATEGORIAS) {
    if (nombre.includes(c.clave)) {
      return { familia: c.familia, prod: c.prod, estampa: c.estampa ?? ESTAMPA_DEFAULT };
    }
  }
  return null;
}


module.exports = { costear, PROD, ESTAMPA_DEFAULT, VIGENTE_DESDE };
