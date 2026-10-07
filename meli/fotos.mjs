// Prepara las fotos de Tiendanube para Mercado Libre: 1200x1200 cuadrado.
//
// Dos tratamientos distintos, porque las fotos son de dos tipos:
//
// - MOCKUP (prenda sola sobre fondo liso): se EXTIENDE el fondo con su mismo
//   tono hasta el cuadrado. No se recorta: recortar le comería la prenda.
// - AMBIENTE (foto con modelo): se RECORTA al centro. Rellenar acá queda mal —
//   probamos con blanco y con el color de las esquinas, y a una foto sacada en
//   un portal le quedaban bandas marrones a los costados.
//
// Para distinguirlas mide el borde: un mockup sobre fondo liso claro tiene el
// borde casi todo claro, una foto de ambiente no.
//
// También baja el ORIGINAL y no el `src` del catálogo, que apunta a un
// thumbnail de 1024 px (el original va de 1200x1800 a 3072x4608).
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export const LADO = 1200;
const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });

export function urlOriginal(src) {
  return src.replace(/-\d+-\d+(\.[a-z]+)$/i, "$1");
}

function medir(f) {
  const s = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", f]).toString();
  return { w: +s.match(/pixelWidth:\s*(\d+)/)[1], h: +s.match(/pixelHeight:\s*(\d+)/)[1] };
}

// Lee el borde en miniatura: devuelve { claro: 0..1, fondo: "RRGGBB" }.
function borde(f) {
  const bmp = f + ".bmp";
  sips("-s", "format", "bmp", "--resampleWidth", "40", f, "--out", bmp);
  const b = fs.readFileSync(bmp);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28) / 8, fila = Math.ceil(w * bpp / 4) * 4;
  let n = 0, claros = 0, sum = [0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!(x < 3 || x >= w - 3 || y < 3 || y >= h - 3)) continue;
    const i = off + y * fila + x * bpp;
    const [r, g, bl] = [b[i + 2], b[i + 1], b[i]];
    n++; if (r > 228 && g > 228 && bl > 228) claros++;
    sum[0] += r; sum[1] += g; sum[2] += bl;
  }
  fs.unlinkSync(bmp);
  return {
    claro: claros / n,
    fondo: sum.map(v => Math.round(v / n).toString(16).padStart(2, "0")).join("").toUpperCase(),
  };
}

export function carpetaTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meli-fotos-"));
}

// Devuelve { file, tipo } con un JPEG de 1200x1200.
export async function prepararFoto(src, dir, i = 0) {
  const bruto = path.join(dir, `b${i}.jpg`);
  let r = await fetch(urlOriginal(src));
  if (!r.ok) r = await fetch(src);
  if (!r.ok) throw new Error(`no se pudo bajar ${src}`);
  fs.writeFileSync(bruto, Buffer.from(await r.arrayBuffer()));

  const { w, h } = medir(bruto);
  const { claro, fondo } = borde(bruto);
  const mockup = claro > 0.9;
  const fin = path.join(dir, `f${i}.jpg`);

  if (mockup) {
    // Acá NO se rellena ni se achica, aunque suene al revés de lo que se pide.
    // MELI recorta el fondo liso y sirve la foto al recuadro de la prenda: lo
    // probamos sin rellenar (1111x1063), rellenando a cuadrado achicando antes
    // (739x709) y rellenando a cuadrado sin achicar (1113x1063). Siempre recorta.
    // Entonces lo único que mueve la aguja es agrandar la prenda. El recuadro de
    // una remera apoyada es más ancho que alto, así que el que topea en 1200 es
    // el ANCHO: hay que escalar por el lado corto, no por el largo. Llevando el
    // ancho a 1800 el recorte cae justo en el tope y queda 1200x1152.
    const esc = Math.max(1, 1800 / Math.min(w, h));
    sips("--resampleHeightWidth", String(Math.round(h * esc)), String(Math.round(w * esc)), bruto, "--out", fin);
  } else {
    // Se agranda hasta cubrir el cuadrado y se recorta ANCLADO ARRIBA, no al
    // centro: un centrado sobre una foto de cuerpo entero le corta la cabeza.
    // Dejando sólo un 10% del sobrante arriba queda la cara entera y la prenda
    // más grande en cuadro, que para una publicación de remera es lo que sirve.
    const esc = LADO / Math.min(w, h);
    const nh = Math.round(h * esc), nw = Math.round(w * esc);
    sips("--resampleHeightWidth", String(nh), String(nw), bruto, "--out", fin);
    const sobraY = Math.max(0, nh - LADO), sobraX = Math.max(0, nw - LADO);
    sips("-c", String(LADO), String(LADO),
         "--cropOffset", String(Math.round(sobraY * 0.1)), String(Math.round(sobraX / 2)),
         fin, "--out", fin);
  }
  sips("-s", "format", "jpeg", "-s", "formatOptions", "92", fin, "--out", fin);
  return { file: fin, tipo: mockup ? "mockup" : "ambiente", fondo };
}
