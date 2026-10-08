// Prepara las fotos de Tiendanube para Mercado Libre.
//
// Hace UNA sola cosa: bajar el ORIGINAL. El `src` del catálogo apunta a un
// thumbnail de 1024 px; sacándole el sufijo "-1024-1024" viene la foto
// completa, la misma que se ve en la web.
//
// No recorta, no escala, no rellena. Lo intentamos de varias formas —cuadrado
// con relleno blanco, con el color del fondo, 1200x1540, recorte al contorno de
// la prenda— y todas se vieron peor que la foto original: el relleno queda como
// un rectángulo de otro tono sobre el blanco de MELI, y recortar el fondo de un
// mockup deja el borde del estudio marcado contra la página.
//
// La foto de la web ya está bien. MELI la escala a 1200 px de lado largo y la
// centra en su contenedor; eso es lo que queremos.
export function urlOriginal(src) {
  return src.replace(/-\d+-\d+(\.[a-z]+)$/i, "$1");
}

export async function prepararFoto(src) {
  let r = await fetch(urlOriginal(src));
  if (!r.ok) r = await fetch(src);              // si el original no está, el thumbnail
  if (!r.ok) throw new Error(`no se pudo bajar ${src}`);
  return new Blob([Buffer.from(await r.arrayBuffer())], { type: "image/jpeg" });
}
