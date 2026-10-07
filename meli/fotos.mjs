// Prepara las fotos de Tiendanube para Mercado Libre.
//
// Hace una sola cosa: bajar el ORIGINAL. El `src` del catálogo de Tiendanube
// apunta a un thumbnail de 1024 px; sacándole el sufijo "-1024-1024" viene la
// foto completa (1200x1800 en Amberline, hasta 3072x4608 en otros productos).
//
// Y una cosa que NO hace: tocar el encuadre. Probamos llevarlas a 1200x1540
// rellenando los costados, primero con blanco y después con el color del fondo
// de cada foto, y las dos salieron mal: MELI recorta el relleno uniforme, y en
// las fotos de ambiente el "color de fondo" es el del lugar donde se tomó, así
// que a una foto en un portal le quedaban bandas marrones a los costados.
//
// MELI escala a 1200 px de lado largo y centra la foto en su propio contenedor
// con un gris neutro. Eso se ve mejor que cualquier relleno que agreguemos.
export function urlOriginal(src) {
  return src.replace(/-\d+-\d+(\.[a-z]+)$/i, "$1");
}

// Devuelve el Blob listo para subir, en su proporción original.
export async function prepararFoto(src) {
  let r = await fetch(urlOriginal(src));
  if (!r.ok) r = await fetch(src);              // si el original no está, el thumbnail
  if (!r.ok) throw new Error(`no se pudo bajar ${src}`);
  return new Blob([Buffer.from(await r.arrayBuffer())], { type: "image/jpeg" });
}
