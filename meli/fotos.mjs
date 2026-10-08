// Prepara las fotos de Tiendanube para Mercado Libre.
//
// Dos cosas, y nada más:
//
// 1) Baja el ORIGINAL. El `src` del catálogo apunta a un thumbnail de 1024 px;
//    sacándole el sufijo "-1024-1024" viene la foto completa de la web.
//
// 2) En los MOCKUPS, lleva el fondo a blanco puro. Los de Tussy están sobre un
//    gris de estudio (#F7F7F7) y la ficha de MELI es blanco, así que la foto se
//    veía como un rectángulo gris pegado sobre la página. Las fotos de ambiente
//    no se tocan: `fondoABlanco` las deja pasar sola al ver que el borde no es
//    claro.
//
// NO se recorta, no se escala, no se rellena. Lo probamos de cuatro formas
// (cuadrado con blanco, cuadrado con el color del fondo, 1200x1540, recorte al
// contorno de la prenda) y todas se vieron peor que la original.
import fs from "fs";
import os from "os";
import path from "path";
import { fondoABlanco } from "./fondo.mjs";

export function urlOriginal(src) {
  return src.replace(/-\d+-\d+(\.[a-z]+)$/i, "$1");
}

export function carpetaTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meli-fotos-"));
}

export async function prepararFoto(src, dir, i = 0) {
  const bruto = path.join(dir, `b${i}.jpg`);
  let r = await fetch(urlOriginal(src));
  if (!r.ok) r = await fetch(src);
  if (!r.ok) throw new Error(`no se pudo bajar ${src}`);
  fs.writeFileSync(bruto, Buffer.from(await r.arrayBuffer()));

  const fin = path.join(dir, `f${i}.jpg`);
  const tocada = fondoABlanco(bruto, fin);
  return { file: fin, tipo: tocada === false ? "ambiente" : "mockup" };
}
