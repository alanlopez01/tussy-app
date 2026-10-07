// Prepara las fotos de Tiendanube para Mercado Libre Moda.
//
// Dos cosas que hace y por qué:
// 1) Baja el ORIGINAL de Tiendanube, no el `src` del catálogo. Ese src apunta a
//    un thumbnail de 1024 px: sacándole el sufijo "-1024-1024" viene la foto
//    completa (1200x1800 y hasta 3072x4608 según el producto).
// 2) La lleva a 1200x1540 vertical, que es lo que pide MELI en Moda. Escala para
//    que entre entera y rellena con blanco: NO recorta, porque MELI exige que en
//    las fotos con modelo se vea la persona completa.
//
// Sin esto MELI las sirve a 800x1200; con esto, a 882x1200 (~10% más de ancho
// útil en la galería).
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export const ANCHO = 1200, ALTO = 1540;

export function urlOriginal(src) {
  return src.replace(/-\d+-\d+(\.[a-z]+)$/i, "$1");
}

// Color del fondo, leído de la esquina de la propia foto. MELI recorta los
// márgenes de color uniforme, así que rellenar con blanco puro no sirve: te
// devuelve la foto al recuadro de la prenda (una remera doblada da casi
// cuadrado). Rellenando con el gris exacto del estudio el canvas se respeta y
// además queda invisible.
function colorFondo(f) {
  const bmp = f + ".bmp";
  execFileSync("/usr/bin/sips", ["-s", "format", "bmp", "--resampleWidth", "32", f, "--out", bmp], { stdio: "ignore" });
  const b = fs.readFileSync(bmp);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28) / 8, fila = Math.ceil(w * bpp / 4) * 4;
  const px = (x, y) => { const i = off + y * fila + x * bpp; return [b[i + 2], b[i + 1], b[i]]; };
  const esquinas = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  fs.unlinkSync(bmp);
  const med = n => Math.round(esquinas.reduce((a, c) => a + c[n], 0) / esquinas.length);
  return [med(0), med(1), med(2)].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function medir(f) {
  const s = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", f]).toString();
  return { w: +s.match(/pixelWidth:\s*(\d+)/)[1], h: +s.match(/pixelHeight:\s*(\d+)/)[1] };
}

// Devuelve el path de un JPEG 1200x1540 listo para subir.
export async function prepararFoto(src, dir) {
  const bruto = path.join(dir, "bruto.jpg");
  let r = await fetch(urlOriginal(src));
  if (!r.ok) r = await fetch(src);               // si el original no está, el thumbnail
  if (!r.ok) throw new Error(`no se pudo bajar ${src}`);
  fs.writeFileSync(bruto, Buffer.from(await r.arrayBuffer()));

  const { w, h } = medir(bruto);
  let nw = Math.round(w * ALTO / h), nh = ALTO;
  if (nw > ANCHO) { nw = ANCHO; nh = Math.round(h * ANCHO / w); }

  const fin = path.join(dir, "meli.jpg");
  const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });
  sips("--resampleHeightWidth", String(nh), String(nw), bruto, "--out", fin);
  sips("--padToHeightWidth", String(ALTO), String(ANCHO), "--padColor", colorFondo(bruto), fin, "--out", fin);
  sips("-s", "format", "jpeg", "-s", "formatOptions", "90", fin, "--out", fin);
  return fin;
}

export function carpetaTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meli-fotos-"));
}
