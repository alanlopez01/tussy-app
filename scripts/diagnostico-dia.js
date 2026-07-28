// Diagnóstico: para un día, compara distintas formas de calcular el total
// en Dragonfish (Total de factura vs suma de items) y Tiendanube (por payment_status).
// Uso: node scripts/diagnostico-dia.js 2026-07-10
const fs = require("fs");
const path = require("path");
const { dfLocales, diaSiguiente } = require("../lib/fuentes");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.development.local");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function diagDF(local, fecha) {
  const tsInicio = new Date(`${fecha}T03:00:00Z`).getTime();
  const tsFin = new Date(`${diaSiguiente(fecha)}T02:59:59Z`).getTime();
  let sumTotalFactura = 0, sumItems = 0, facturas = 0, page = 1;
  const camposVistos = new Set();
  while (true) {
    const qs = new URLSearchParams({ limit: "50", page: String(page), sort: "-Fecha" }).toString();
    const r = await fetch(`${local.url}/api.Dragonfish/Facturaagrupada/?${qs}`, {
      headers: { "Content-Type": "application/json", idCliente: local.idCliente, Authorization: local.token, BaseDeDatos: local.baseDatos },
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    const rs = Array.isArray(data) ? data : (data.Resultados || []);
    if (!rs.length) break;
    let masViejas = false;
    for (const fac of rs) {
      const m = String(fac.Fecha || "").match(/\/Date\((\d+)/);
      if (!m) continue;
      const ts = parseInt(m[1]);
      if (ts < tsInicio) { masViejas = true; continue; }
      if (ts > tsFin) continue;
      facturas++;
      sumTotalFactura += parseFloat(fac.Total || 0);
      Object.keys(fac).forEach(k => camposVistos.add(k));
      for (const it of fac.FacturaDetalle || []) sumItems += parseFloat(it.Monto || it.Precio || 0);
    }
    if (rs.length < 50 || masViejas) break;
    page++;
  }
  return { facturas, sumTotalFactura: Math.round(sumTotalFactura), sumItems: Math.round(sumItems), campos: [...camposVistos].join(",") };
}

async function diagTN(fecha) {
  const token = process.env.TN_ACCESS_TOKEN, userId = process.env.TN_USER_ID;
  const inicioUTC = `${fecha}T03:00:00+0000`, finUTC = `${diaSiguiente(fecha)}T02:59:59+0000`;
  const porStatus = {};
  let page = 1;
  while (true) {
    const url = `https://api.tiendanube.com/v1/${userId}/orders?created_at_min=${inicioUTC}&created_at_max=${finUTC}&per_page=200&page=${page}`;
    const r = await fetch(url, { headers: { Authentication: `bearer ${token}`, "User-Agent": "TussyApp/1.0" }, signal: AbortSignal.timeout(30000) });
    if (r.status === 404) break;
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const orders = await r.json();
    if (!Array.isArray(orders) || !orders.length) break;
    for (const o of orders) {
      const st = `${o.status}/${o.payment_status}`;
      if (!porStatus[st]) porStatus[st] = { ordenes: 0, total: 0 };
      porStatus[st].ordenes++;
      porStatus[st].total += parseFloat(o.total || 0);
    }
    if (orders.length < 200) break;
    page++;
  }
  for (const k in porStatus) porStatus[k].total = Math.round(porStatus[k].total);
  return porStatus;
}

async function main() {
  loadEnv();
  const fecha = process.argv[2] || "2026-07-10";
  console.log(`Diagnóstico ${fecha}\n`);

  for (const local of dfLocales()) {
    const d = await diagDF(local, fecha);
    console.log(`DF ${local.nombre}:`, JSON.stringify(d, null, 1));
  }
  console.log("\nTiendanube por status/payment_status (sumando order.total):");
  console.log(JSON.stringify(await diagTN(fecha), null, 1));
}

main().catch(e => { console.error(e); process.exit(1); });
