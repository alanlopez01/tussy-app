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
import { execFileSync } from "child_process";
import { fondoABlanco } from "./fondo.mjs";

// MELI rechaza con 413 los archivos grandes, y de todos modos sirve a 1200 px
// de lado largo. Dejamos 2000 de techo: muy por encima de lo que muestra, pero
// sin mandar 20 MB al cuete. Esto NO es recortar: la foto es la misma.
const LADO_MAX = 2000;
const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });

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

  const dim = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", bruto]).toString();
  const w = +dim.match(/pixelWidth:\s*(\d+)/)[1], h = +dim.match(/pixelHeight:\s*(\d+)/)[1];
  if (Math.max(w, h) > LADO_MAX) {
    const e = LADO_MAX / Math.max(w, h);
    sips("--resampleHeightWidth", String(Math.round(h * e)), String(Math.round(w * e)), bruto, "--out", bruto);
  }

  const fin = path.join(dir, `f${i}.jpg`);
  const tocada = fondoABlanco(bruto, fin);
  return { file: fin, tipo: tocada === false ? "ambiente" : "mockup" };
}

// ── Qué foto es de qué color ────────────────────────────────────────────────
//
// MELI acepta de 1 a 10 fotos POR VARIACIÓN y las usa para mostrar el producto
// en el color elegido. Mandarle todas a todas hace que al elegir "negro" se vean
// fotos de la crudo, que es peor que no tener variantes.
//
// Tiendanube asocia UNA foto a cada variante (`variant.image_id`), que alcanza
// como ancla: se mide el color dominante de esa foto y después el de todas las
// demás, y cada una se queda con el color cuya ancla tiene más cerca. En el
// catálogo de Tussy las fotos vienen agrupadas por color, así que el reparto da
// parejo (probado en REMERA ZERO: 12 fotos, 6 colores, 2 por color).
//
// Se mide la zona central y se descarta el fondo casi blanco: lo que queda es
// la prenda. La mediana por canal aguanta estampas y sombras mejor que el
// promedio.
export function colorDominante(archivoJpg) {
  const bmp = archivoJpg + ".color.bmp";
  try {
    execFileSync("/usr/bin/sips", ["-s", "format", "bmp", "--resampleWidth", "100", archivoJpg, "--out", bmp], { stdio: "ignore" });
    const b = fs.readFileSync(bmp);
    const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
    const bpp = b.readUInt16LE(28) / 8, fila = Math.ceil(w * bpp / 4) * 4;
    const arriba = b.readInt32LE(22) < 0;
    const px = [];
    for (let y = Math.floor(h * 0.3); y < h * 0.7; y++) {
      for (let x = Math.floor(w * 0.3); x < w * 0.7; x++) {
        const yy = arriba ? y : h - 1 - y;
        const i = off + yy * fila + x * bpp;
        const r = b[i + 2], g = b[i + 1], bl = b[i];
        if (r > 238 && g > 238 && bl > 238) continue;   // fondo
        px.push([r, g, bl]);
      }
    }
    if (!px.length) return null;
    return [0, 1, 2].map(c => {
      const v = px.map(q => q[c]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    });
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(bmp); } catch {}
  }
}

// Reparte las fotos entre los colores. `anclas` es {color: rgb} y `fotos` es
// [{clave, rgb}]. Devuelve {color: [clave, ...]} respetando el orden recibido.
export function repartirPorColor(anclas, fotos) {
  const colores = Object.entries(anclas).filter(([, v]) => v);
  if (!colores.length) return null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const salida = Object.fromEntries(colores.map(([c]) => [c, []]));
  for (const f of fotos) {
    if (!f.rgb) continue;
    const mejor = colores.map(([c, v]) => [c, dist(f.rgb, v)]).sort((a, b) => a[1] - b[1])[0];
    salida[mejor[0]].push(f.clave);
  }
  return salida;
}
