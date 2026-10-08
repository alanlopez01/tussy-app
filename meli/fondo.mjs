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

// Rango sano de relleno. Un mockup normal tiene 55-75% de fondo; si el relleno
// se pasa de ahi es que se filtro dentro de la prenda, que es lo que pasaba con
// las remeras crudo (Red Deus quedaba al 82%, con la tela quemada a blanco).
const MIN_OK = 0.35, MAX_OK = 0.78;

// Prueba tolerancias de mayor a menor y se queda con la primera que de un
// relleno sano. Si ninguna lo logra, devuelve la foto original sin tocar:
// mejor un fondo gris que una prenda quemada.
export function fondoABlanco(entrada, salida, tolerancias = [26, 18, 12, 8]) {
  for (const tol of tolerancias) {
    const pct = rellenar(entrada, salida, tol);
    if (pct === false) return false;        // no es mockup
    if (pct === null) continue;             // se filtro al centro, probar mas fino
    if (pct >= MIN_OK && pct <= MAX_OK) return pct;
  }
  fs.copyFileSync(entrada, salida);
  return false;
}

export function rellenar(entrada, salida, tol) {
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

  // Si la prenda es casi tan clara como el fondo, no hay forma segura de
  // separarlas: el relleno termina comiendose la tela. Pasa con las remeras
  // crudo. En ese caso se deja la foto como esta — un fondo gris no molesta,
  // una prenda lavada si.
  //
  // Se mide el brillo de la franja de tela lisa justo adentro del contorno,
  // evitando el centro, que suele ser la estampa y enganaria la medicion.
  {
    const m = [];
    for (let y = Math.round(h * 0.18); y < h * 0.34; y++)
      for (let x = Math.round(w * 0.20); x < w * 0.80; x++) {
        const i = idx(x, y);
        if (!cerca(i)) m.push((b[i] + b[i + 1] + b[i + 2]) / 3);
      }
    if (m.length > 50) {
      m.sort((a, c) => a - c);
      const mediana = m[Math.floor(m.length / 2)];
      const fondoBrillo = (ref[0] + ref[1] + ref[2]) / 3;
      if (fondoBrillo - mediana < 28) { fs.unlinkSync(bmp); fs.copyFileSync(entrada, salida); return false; }
    }
  }
  const visto = new Uint8Array(w * h);
  const cola = [];
  for (let x = 0; x < w; x++) { cola.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { cola.push(0, y, w - 1, y); }

  // Si el relleno llega al centro de la foto es que se filtro dentro de la
  // prenda: en un mockup el centro es siempre el producto. Es mucho mas fiable
  // que mirar el porcentaje total, que con las remeras crudo daba "sano" aunque
  // la tela estuviera comida.
  const cx0 = Math.round(w * 0.35), cx1 = Math.round(w * 0.65);
  const cy0 = Math.round(h * 0.35), cy1 = Math.round(h * 0.65);
  let invadioCentro = false;

  let n = 0;
  while (cola.length) {
    const y = cola.pop(), x = cola.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (visto[k]) continue;
    const i = idx(x, y);
    if (!cerca(i)) continue;
    visto[k] = 1; n++;
    if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) invadioCentro = true;
    b[i] = 255; b[i + 1] = 255; b[i + 2] = 255;
    cola.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  fs.unlinkSync(bmp);
  if (invadioCentro) return null;   // se filtro dentro de la prenda
  fs.writeFileSync(bmp2, b);
  sips("-s", "format", "jpeg", "-s", "formatOptions", "88", bmp2, "--out", salida);
  fs.unlinkSync(bmp2);
  return n / (w * h);
}
