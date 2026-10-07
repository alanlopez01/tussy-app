import { execFileSync } from "child_process";
import fs from "fs";

// Convierte a BMP 32px con sips (macOS) y mide el % de pixeles casi blancos
// en el BORDE de la imagen. Un packshot sobre fondo blanco tiene el borde
// practicamente todo blanco; una foto con contexto, no.
export function blancuraBorde(jpg) {
  const bmp = jpg + ".bmp";
  execFileSync("/usr/bin/sips", ["-s","format","bmp","--resampleWidth","32",jpg,"--out",bmp], {stdio:"ignore"});
  const b = fs.readFileSync(bmp);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
  const bpp = b.readUInt16LE(28) / 8;
  const fila = Math.ceil(w * bpp / 4) * 4;
  let borde = 0, blancos = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const esBorde = x < 3 || x >= w - 3 || y < 3 || y >= h - 3;
    if (!esBorde) continue;
    const p = off + y * fila + x * bpp;
    const [bl, g, r] = [b[p], b[p+1], b[p+2]];
    borde++;
    if (r > 228 && g > 228 && bl > 228) blancos++;
  }
  fs.unlinkSync(bmp);
  return blancos / borde;
}
