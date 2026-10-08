// Lleva a blanco puro el fondo de un mockup.
//
// Los mockups de Tussy están sobre un gris de estudio y la ficha de MELI es
// blanco, así que la foto se ve como un rectángulo gris pegado sobre la página.
//
// La clave está en la tolerancia. El fondo de estas fotos es EXACTAMENTE
// uniforme (247,247,247 en toda la imagen, sin degradé) y la tela más clara que
// tenemos —las remeras crudo— está a unos 20 de distancia Manhattan. Con
// tolerancia 26 el relleno se comía la prenda; ajustada al ruido real del
// fondo, las separa sin tocarla.
//
// Es relleno por contigüidad desde los bordes, no un reemplazo de color: así un
// gris que aparezca dentro de la estampa nunca se blanquea.
import fs from "fs";
import { execFileSync } from "child_process";

const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });

function leerBMP(f) {
  const b = fs.readFileSync(f);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28) / 8;
  const fila = Math.ceil(w * bpp / 4) * 4;
  return { b, off, w, h, bpp, fila, idx: (x, y) => off + y * fila + x * bpp };
}

export function fondoABlanco(entrada, salida) {
  const bmp = entrada + ".in.bmp", bmp2 = entrada + ".out.bmp";
  sips("-s", "format", "bmp", entrada, "--out", bmp);
  const { b, w, h, bpp, idx } = leerBMP(bmp);
  const limpiar = () => { for (const f of [bmp, bmp2]) try { fs.unlinkSync(f); } catch {} };
  if (bpp < 3) { limpiar(); fs.copyFileSync(entrada, salida); return false; }

  // Tono del fondo y cuánto varía: se muestrea todo el marco, no sólo las
  // esquinas, para no confundir un degradé con ruido.
  const marco = [];
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 120))) { marco.push([x, 0], [x, h - 1]); }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 120))) { marco.push([0, y], [w - 1, y]); }
  const muestras = marco.map(([x, y]) => { const i = idx(x, y); return [b[i + 2], b[i + 1], b[i]]; });
  const ref = [0, 1, 2].map(n => Math.round(muestras.reduce((a, c) => a + c[n], 0) / muestras.length));
  if (ref[0] < 215 || ref[1] < 215 || ref[2] < 215) { limpiar(); fs.copyFileSync(entrada, salida); return false; }

  const dist = p => Math.abs(p[0] - ref[0]) + Math.abs(p[1] - ref[1]) + Math.abs(p[2] - ref[2]);
  const ruido = Math.max(...muestras.map(dist));
  // Margen sobre el ruido real del fondo, pero nunca tanto como para alcanzar
  // una tela clara (las remeras crudo están a ~20).
  const tol = Math.min(14, Math.max(6, ruido + 5));

  const cerca = i => dist([b[i + 2], b[i + 1], b[i]]) <= tol;
  const visto = new Uint8Array(w * h);
  const cola = [];
  for (let x = 0; x < w; x++) cola.push(x, 0, x, h - 1);
  for (let y = 0; y < h; y++) cola.push(0, y, w - 1, y);

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
  sips("-s", "format", "jpeg", "-s", "formatOptions", "90", bmp2, "--out", salida);
  limpiar();
  return { pct: n / (w * h), tol, ruido };
}
