// Rehace las fotos de todas las publicaciones con el pipeline actual.
// Uso: node meli/refotos-todas.mjs
import fs from "fs";
import { execFileSync } from "child_process";
import { neon } from "@neondatabase/serverless";
for (const l of fs.readFileSync("/Users/alanlopez/Desktop/Claudito/tussy-app/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const sql = neon(process.env.DATABASE_URL);
const nombres = (await sql`SELECT tn_nombre FROM meli_publicaciones ORDER BY tn_nombre`).map(r => r.tn_nombre);
let ok = 0, mal = [];
for (const [i, n] of nombres.entries()) {
  process.stdout.write(`[${i + 1}/${nombres.length}] ${n.slice(0, 32).padEnd(33)}`);
  try {
    execFileSync("node", ["refotos.mjs", n], { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8", timeout: 900000 });
    console.log("✓"); ok++;
  } catch (e) {
    const m = `${e.stdout || ""}${e.stderr || ""}`.split("\n").filter(l => l.trim()).slice(-2).join(" | ");
    console.log(`✗ ${m.slice(0, 120)}`); mal.push(n);
  }
}
console.log(`\nrehechas: ${ok} · fallaron: ${mal.length}${mal.length ? " (" + mal.join(", ") + ")" : ""}`);
