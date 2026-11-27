// Respaldo CRUDO de las fuentes viejas de venta, tal como las devuelve su API,
// antes de que se apaguen. No normaliza, no interpreta, no toca la base: guarda
// el JSON de origen para poder reconstruir cualquier cosa después.
//
// Esto existe porque La Plata ya se perdió: se dio de baja el dominio de wnpower
// y con él su base de WooCommerce, y de esa tienda no queda nada más que lo que
// alcanzó a entrar a ventas. Dragonfish se da de baja en nov-2026, así que su
// historia (Dot desde jul-2025, Abasto desde nov-2025, Córdoba desde dic-2025)
// sólo existe mientras los servidores de los locales sigan contestando.
//
// Uso: node scripts/respaldo-fuentes.js dragonfish [local]
//      node scripts/respaldo-fuentes.js woo [local]
//      node scripts/respaldo-fuentes.js tiendanube [desde] [hasta]
//
// Escribe en respaldos/<fuente>/<local>.ndjson (una factura/orden por línea) y
// lleva un cursor al lado, así que se puede cortar y volver a correr sin perder
// ni duplicar lo ya bajado.
const fs = require("fs");
const path = require("path");
const { wooLocales, dfLocales, diaSiguiente } = require("../lib/fuentes");

const RAIZ = path.join(__dirname, "..", "respaldos");

function loadEnv() {
  const p = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function destino(fuente, nombre) {
  const dir = path.join(RAIZ, fuente);
  fs.mkdirSync(dir, { recursive: true });
  const slug = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { datos: path.join(dir, `${slug}.ndjson`), cursor: path.join(dir, `${slug}.cursor`) };
}

const leerCursor = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const escribirCursor = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
const dormir = ms => new Promise(r => setTimeout(r, ms));

// ─── Dragonfish ────────────────────────────────────────────────────────────
// La API pagina y ordena, no filtra. Ascendente desde la página 1 baja toda la
// historia en orden, y el cursor es simplemente la última página completa.
async function paginaDF(local, page) {
  const qs = new URLSearchParams({ limit: "50", page: String(page), sort: "Fecha" });
  let ultimo = null;
  // Las páginas profundas tardan más: el server recorre todo hasta el offset.
  // Pasada la 150 los 60 s no alcanzan y el barrido se corta cada pocas páginas,
  // así que a partir de ahí se espera más y se reintenta más veces.
  const espera = page > 150 ? 120000 : 60000;
  for (let intento = 1; intento <= 7; intento++) {
    try {
      const r = await fetch(`${local.url}/api.Dragonfish/Facturaagrupada/?${qs}`, {
        headers: {
          "Content-Type": "application/json", idCliente: local.idCliente,
          Authorization: local.token, BaseDeDatos: local.baseDatos,
        },
        signal: AbortSignal.timeout(espera),
      });
      // 404 al pasarse del final: la API no tiene una página vacía, tira 404.
      if (r.status === 404) return { ok: true, filas: [], fin: true };
      if (r.ok) {
        const d = await r.json();
        return { ok: true, filas: Array.isArray(d) ? d : (d.Resultados || []), fin: false };
      }
      ultimo = `HTTP ${r.status}`;
    } catch (e) { ultimo = e.message; }
    if (intento < 7) await dormir(3000 * intento);
  }
  return { ok: false, filas: [], error: ultimo };
}

async function respaldarDF(soloLocal) {
  for (const local of dfLocales()) {
    if (soloLocal && local.nombre.toLowerCase() !== soloLocal.toLowerCase()) continue;
    const { datos, cursor } = destino("dragonfish", local.nombre);
    const estado = leerCursor(cursor) || { pagina: 0, facturas: 0 };
    console.log(`\n=== Dragonfish ${local.nombre} (base ${local.baseDatos}) ===`);
    if (estado.pagina) console.log(`  retomo en la pagina ${estado.pagina + 1} (${estado.facturas} facturas ya bajadas)`);
    const salida = fs.createWriteStream(datos, { flags: "a" });
    let page = estado.pagina + 1, vacias = 0;
    while (true) {
      const r = await paginaDF(local, page);
      if (!r.ok) { console.log(`  CORTADO en la pagina ${page}: ${r.error} — volve a correrlo y sigue de aca`); break; }
      if (r.fin || !r.filas.length) { console.log(`  fin de la historia en la pagina ${page}`); break; }
      for (const fac of r.filas) salida.write(JSON.stringify(fac) + "\n");
      estado.pagina = page; estado.facturas += r.filas.length;
      escribirCursor(cursor, estado);
      if (page % 20 === 0) console.log(`  pagina ${page}: ${estado.facturas} facturas`);
      if (r.filas.length < 50) { console.log(`  ultima pagina (${r.filas.length} facturas)`); break; }
      page++;
      if (page > 20000) { console.log("  cortafuegos: 20000 paginas"); break; }
    }
    await new Promise(res => salida.end(res));
    const mb = (fs.statSync(datos).size / 1048576).toFixed(1);
    console.log(`  ${estado.facturas} facturas en ${datos} (${mb} MB)`);
  }
}

// ─── WooCommerce ───────────────────────────────────────────────────────────
// Sí filtra por fecha, así que el cursor es el día: baja mes por mes.
async function respaldarWoo(soloLocal) {
  for (const local of wooLocales()) {
    if (soloLocal && local.nombre.toLowerCase() !== soloLocal.toLowerCase()) continue;
    const { datos, cursor } = destino("woo", local.nombre);
    const estado = leerCursor(cursor) || { hasta: null, ordenes: 0 };
    const auth = Buffer.from(`${local.key}:${local.secret}`).toString("base64");
    const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    let mes = estado.hasta ? estado.hasta.slice(0, 7) : "2023-01";
    console.log(`\n=== Woo ${local.nombre} ===`);
    if (estado.hasta) console.log(`  retomo en ${mes} (${estado.ordenes} ordenes ya bajadas)`);
    const salida = fs.createWriteStream(datos, { flags: "a" });
    while (mes <= hoy.slice(0, 7)) {
      const [y, m] = mes.split("-").map(Number);
      const desde = `${mes}-01`;
      const hasta = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString().slice(0, 10);
      let page = 1, delMes = 0, falla = null;
      while (true) {
        const url = `${local.url}/wp-json/wc/v3/orders?status=any&after=${desde}T00:00:00Z` +
                    `&before=${hasta}T00:00:00Z&per_page=100&page=${page}&orderby=date&order=asc`;
        let r = null;
        for (let i = 1; i <= 4; i++) {
          try {
            const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(60000) });
            if (resp.ok) { r = await resp.json(); break; }
            falla = `HTTP ${resp.status}`;
          } catch (e) { falla = e.message; }
          if (i < 4) await dormir(2000 * i);
        }
        if (r === null) break;
        falla = null;
        if (!r.length) break;
        for (const o of r) salida.write(JSON.stringify(o) + "\n");
        delMes += r.length;
        if (r.length < 100) break;
        page++;
      }
      if (falla) { console.log(`  CORTADO en ${mes}: ${falla} — volve a correrlo`); break; }
      estado.hasta = desde; estado.ordenes += delMes;
      escribirCursor(cursor, estado);
      if (delMes) console.log(`  ${mes}: ${delMes} ordenes`);
      mes = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
    await new Promise(res => salida.end(res));
    const mb = (fs.statSync(datos).size / 1048576).toFixed(1);
    console.log(`  ${estado.ordenes} ordenes en ${datos} (${mb} MB)`);
  }
}

// ─── Tiendanube ────────────────────────────────────────────────────────────
async function respaldarTN(desde, hasta) {
  const { datos, cursor } = destino("tiendanube", "Tiendanube");
  const estado = leerCursor(cursor) || { hasta: null, ordenes: 0 };
  const arranque = estado.hasta || desde;
  console.log(`\n=== Tiendanube ===`);
  if (estado.hasta) console.log(`  retomo en ${arranque} (${estado.ordenes} ordenes ya bajadas)`);
  const salida = fs.createWriteStream(datos, { flags: "a" });
  let mes = arranque.slice(0, 7);
  while (mes <= hasta.slice(0, 7)) {
    const [y, m] = mes.split("-").map(Number);
    const d1 = `${mes}-01`;
    const d2 = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString().slice(0, 10);
    let page = 1, delMes = 0, falla = null;
    while (true) {
      const url = `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/orders` +
                  `?created_at_min=${d1}T00:00:00-03:00&created_at_max=${d2}T00:00:00-03:00&per_page=200&page=${page}`;
      let r = null;
      for (let i = 1; i <= 4; i++) {
        try {
          const resp = await fetch(url, {
            headers: { Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`, "User-Agent": "tussy-app" },
            signal: AbortSignal.timeout(60000),
          });
          if (resp.ok) { r = await resp.json(); break; }
          if (resp.status === 404) { r = []; break; }
          falla = `HTTP ${resp.status}`;
          if (resp.status === 429) await dormir(20000);
        } catch (e) { falla = e.message; }
        if (i < 4) await dormir(2000 * i);
      }
      if (r === null) break;
      falla = null;
      if (!r.length) break;
      for (const o of r) salida.write(JSON.stringify(o) + "\n");
      delMes += r.length;
      if (r.length < 200) break;
      page++;
    }
    if (falla) { console.log(`  CORTADO en ${mes}: ${falla} — volve a correrlo`); break; }
    estado.hasta = d1; estado.ordenes += delMes;
    escribirCursor(cursor, estado);
    if (delMes) console.log(`  ${mes}: ${delMes} ordenes`);
    mes = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  await new Promise(res => salida.end(res));
  const mb = (fs.statSync(datos).size / 1048576).toFixed(1);
  console.log(`  ${estado.ordenes} ordenes en ${datos} (${mb} MB)`);
}

async function main() {
  loadEnv();
  const fuente = (process.argv[2] || "").toLowerCase();
  if (fuente === "dragonfish") return respaldarDF(process.argv[3]);
  if (fuente === "woo") return respaldarWoo(process.argv[3]);
  if (fuente === "tiendanube") return respaldarTN(process.argv[3] || "2024-01-01", process.argv[4] || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10));
  console.log("Uso: node scripts/respaldo-fuentes.js dragonfish|woo|tiendanube [...]");
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
