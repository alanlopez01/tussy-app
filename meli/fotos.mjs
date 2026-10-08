// Prepara las fotos de Tiendanube para Mercado Libre Moda.
//
// Baja el ORIGINAL (el `src` del catálogo apunta a un thumbnail de 1024 px:
// sacándole el sufijo "-1024-1024" viene la foto completa) y lo deja en el
// formato que MELI recomienda para Moda: 1200x1540 vertical.
//
// Dos tratamientos, porque las fotos son de dos tipos:
//
// - AMBIENTE (con modelo): se recorta a 1200x1540 ANCLADO ARRIBA. De un
//   original 2:3 eso saca 260 px de 1800, así que la cabeza entra holgada.
// - MOCKUP (prenda sola sobre fondo liso): primero se RECORTA AL CONTORNO de
//   la prenda y después se agranda. Sin esto la prenda queda chica y con
//   margen, que es justo lo que se veía mal. Y rellenar no sirve: MELI
//   recorta el fondo liso igual, lo probamos de tres formas distintas.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export const ANCHO = 1200, ALTO = 1540;
const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });

export function urlOriginal(src) {
  return src.replace(/-\d+-\d+(\.[a-z]+)$/i, "$1");
}

function medir(f) {
  const s = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", f]).toString();
  return { w: +s.match(/pixelWidth:\s*(\d+)/)[1], h: +s.match(/pixelHeight:\s*(\d+)/)[1] };
}

// Lee la foto en miniatura y devuelve si es mockup y, si lo es, el recuadro
// que ocupa la prenda (en proporción 0..1 sobre el original).
function analizar(f) {
  const N = 60, bmp = f + ".bmp";
  sips("-s", "format", "bmp", "--resampleWidth", String(N), f, "--out", bmp);
  const b = fs.readFileSync(bmp);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28) / 8, fila = Math.ceil(w * bpp / 4) * 4;
  const px = (x, y) => { const i = off + y * fila + x * bpp; return [b[i + 2], b[i + 1], b[i]]; };

  // ¿es mockup? el borde casi todo claro
  let n = 0, claros = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!(x < 3 || x >= w - 3 || y < 3 || y >= h - 3)) continue;
    const [r, g, bl] = px(x, y); n++;
    if (r > 228 && g > 228 && bl > 228) claros++;
  }
  const mockup = claros / n > 0.9;

  // recuadro del contenido: lo que se aparta del tono del fondo
  const fondo = px(0, 0);
  const difiere = (x, y) => {
    const p = px(x, y);
    return Math.abs(p[0] - fondo[0]) + Math.abs(p[1] - fondo[1]) + Math.abs(p[2] - fondo[2]) > 36;
  };
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (difiere(x, y)) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  fs.unlinkSync(bmp);
  const caja = x1 < 0 ? null : { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
  return { mockup, caja };
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

  const { w, h } = medir(bruto);
  const { mockup, caja } = analizar(bruto);
  const fin = path.join(dir, `f${i}.jpg`);

  if (mockup && caja) {
    // Recorte al contorno con un 3% de aire, y después agrandar: el tope de
    // MELI son 1200 px de lado largo, así que apuntamos a 1800 para caer justo
    // ahí después de que recorte el resto del fondo.
    const aire = 0.03;
    const cx0 = Math.max(0, (caja.x0 - aire) * w), cx1 = Math.min(w, (caja.x1 + aire) * w);
    const cy0 = Math.max(0, (caja.y0 - aire) * h), cy1 = Math.min(h, (caja.y1 + aire) * h);
    const cw = Math.round(cx1 - cx0), ch = Math.round(cy1 - cy0);
    sips("-c", String(ch), String(cw),
         "--cropOffset", String(Math.round(cy0)), String(Math.round(cx0)), bruto, "--out", fin);
    const esc = Math.max(1, 1800 / Math.max(cw, ch));
    if (esc > 1) sips("--resampleHeightWidth", String(Math.round(ch * esc)), String(Math.round(cw * esc)), fin, "--out", fin);
  } else {
    // Cubrir 1200x1540 y recortar anclado arriba (10% del sobrante): centrado
    // le corta la cara al modelo.
    const esc = Math.max(ANCHO / w, ALTO / h);
    const nw = Math.round(w * esc), nh = Math.round(h * esc);
    sips("--resampleHeightWidth", String(nh), String(nw), bruto, "--out", fin);
    sips("-c", String(ALTO), String(ANCHO),
         "--cropOffset", String(Math.round(Math.max(0, nh - ALTO) * 0.1)),
         String(Math.round(Math.max(0, nw - ANCHO) / 2)), fin, "--out", fin);
  }
  sips("-s", "format", "jpeg", "-s", "formatOptions", "92", fin, "--out", fin);
  return { file: fin, tipo: mockup ? "mockup" : "ambiente" };
}
