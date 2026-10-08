// Lleva el fondo de un mockup a blanco puro.
//
// Los mockups de Tussy están sobre un gris de estudio (#F7F7F7) y la ficha de
// MELI es blanco puro, así que la foto se ve como un rectángulo gris pegado
// sobre la página. Esto lo funde.
//
// No es un reemplazo de color a secas: eso le comería los claros a la remera
// blanca. Es un relleno por contigüidad desde los bordes — solo se vuelve
// blanco el fondo que toca el marco, nunca un píxel encerrado dentro de la
// prenda.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });

export function fondoABlanco(entrada, salida, tol = 26) {
  const bmp = entrada + ".in.bmp", bmp2 = entrada + ".out.bmp";
  sips("-s", "format", "bmp", entrada, "--out", bmp);
  const b = fs.readFileSync(bmp);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18), hRaw = b.readInt32LE(22), h = Math.abs(hRaw);
  const bpp = b.readUInt16LE(28) / 8;
  if (bpp < 3) { fs.copyFileSync(entrada, salida); return false; }
  const fila = Math.ceil(w * bpp / 4) * 4;
  const idx = (x, y) => off + y * fila + x * bpp;

  // tono de referencia: promedio de las cuatro esquinas
  const esq = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const i = idx(x, y); return [b[i + 2], b[i + 1], b[i]];
  });
  const ref = [0, 1, 2].map(n => esq.reduce((a, c) => a + c[n], 0) / 4);
  // si el borde ya es oscuro no es un mockup: no tocar
  if (ref[0] < 215 || ref[1] < 215 || ref[2] < 215) { fs.copyFileSync(entrada, salida); return false; }

  const cerca = i => Math.abs(b[i + 2] - ref[0]) + Math.abs(b[i + 1] - ref[1]) + Math.abs(b[i] - ref[2]) <= tol;
  const visto = new Uint8Array(w * h);
  const cola = [];
  for (let x = 0; x < w; x++) { cola.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { cola.push(0, y, w - 1, y); }

  let n = 0;
  while (cola.length) {
    const y = cola.pop(), x = cola.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (visto[k]) continue;
    const i = idx(x, y);
    if (!cerca(i)) continue;
    visto[k] = 1; n++;
    b[i] = 255; b[i + 1] = 255; b[i + 2] = 255;
    cola.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  fs.writeFileSync(bmp2, b);
  sips("-s", "format", "jpeg", "-s", "formatOptions", "95", bmp2, "--out", salida);
  fs.unlinkSync(bmp); fs.unlinkSync(bmp2);
  return n / (w * h);
}
