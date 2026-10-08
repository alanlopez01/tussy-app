// Publica todas las fichas que todavía no están en MELI.
// Uso: node meli/publicar-todo.mjs [--confirmar] [--solo-con-stock]
//
// Va de a una llamando al mismo publicar.mjs, para que si una falla las demás
// sigan. Todas nacen pausadas y con cantidad 1.
import fs from "fs";
import { execFileSync } from "child_process";
import { neon } from "@neondatabase/serverless";

for (const l of fs.readFileSync("/Users/alanlopez/Desktop/Claudito/tussy-app/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const sql = neon(process.env.DATABASE_URL);
const confirmar = process.argv.includes("--confirmar");
const soloStock = process.argv.includes("--solo-con-stock");

const fichas = JSON.parse(fs.readFileSync(new URL("./publicaciones.json", import.meta.url), "utf8"));
const cat = JSON.parse(fs.readFileSync("/private/tmp/claude-501/-Users-alanlopez-Desktop-Claudito/de39b6c3-4ac5-4caa-986d-aad6aa47d917/scratchpad/tn-catalogo.json", "utf8"));
const yaEstan = new Set((await sql`SELECT tn_nombre FROM meli_publicaciones`).map(r => r.tn_nombre));

const tieneStock = f => {
  const p = cat.find(c => c.id === f.tn_id);
  const vs = (p?.variants || []).filter(v => v.visible !== false);
  return vs.some(v => v.stock === null || Number(v.stock) > 0);
};

let cola = fichas.filter(f => !yaEstan.has(f.tn_nombre));
if (soloStock) cola = cola.filter(tieneStock);

console.log(`pendientes: ${cola.length}  ·  ya publicadas: ${yaEstan.size}`);
if (!confirmar) { cola.forEach((f, i) => console.log(`${String(i + 1).padStart(2)}. ${f.title}`)); process.exit(0); }

const ok = [], mal = [];
for (const [i, f] of cola.entries()) {
  process.stdout.write(`[${i + 1}/${cola.length}] ${f.tn_nombre.slice(0, 32).padEnd(33)}`);
  try {
    const out = execFileSync("node", ["publicar.mjs", f.tn_nombre, "--confirmar"],
      { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8", timeout: 600000 });
    const id = out.match(/item_id: (\S+)/)?.[1];
    const est = out.match(/estado: (\S+)/)?.[1];
    console.log(`✓ ${id} ${est}`);
    ok.push(f.tn_nombre);
    if (est !== "paused") console.log(`   ⚠ QUEDO ${est}, revisar`);
  } catch (e) {
    // juntamos las dos salidas: el detalle del fallo puede venir por cualquiera
    const bruto = `${e.stdout || ""}\n${e.stderr || ""}`.trim();
    const msg = bruto.split("\n").filter(l => l.trim() && !l.startsWith("subiendo")).slice(-4).join(" | ") || e.message;
    console.log(`✗ ${msg.slice(0, 200)}`);
    mal.push({ n: f.tn_nombre, msg });
  }
}
console.log(`\nlistas: ${ok.length}  ·  fallaron: ${mal.length}`);
for (const m of mal) console.log(`  ✗ ${m.n}: ${m.msg.slice(0, 160)}`);
