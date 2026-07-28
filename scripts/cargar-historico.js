/**
 * Script para cargar datos históricos de ventas diarias en Google Sheets.
 * Recorre cada día del mes y graba totales por local.
 *
 * Uso: node scripts/cargar-historico.js
 *
 * Requiere variables de entorno (las lee de Vercel via .env):
 *   APPS_SCRIPT_URL_OPERACIONES
 */

const BASE = 'https://tussy-app.vercel.app';

async function fetchJSON(url, timeout = 30000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function cargarDia(fecha) {
  console.log(`\n📅 ${fecha}...`);

  // Fetch WooCommerce + Dragonfish in parallel
  const [woo, df] = await Promise.all([
    fetchJSON(`${BASE}/api/ventas?desde=${fecha}&hasta=${fecha}`, 30000),
    fetchJSON(`${BASE}/api/dragonfish?action=ventas&desde=${fecha}&hasta=${fecha}`, 55000),
  ]);

  const data = {
    fecha,
    palermo: woo?.palermo?.total || 0,
    laplata: woo?.laplata?.total || 0,
    online: woo?.tiendanube?.total || 0,
    dot: df?.dot?.total || 0,
    abasto: df?.abasto?.total || 0,
    cordoba: df?.cordoba?.total || 0,
    opsPalermo: woo?.palermo?.cantidad || 0,
    opsLaPlata: woo?.laplata?.cantidad || 0,
    opsOnline: woo?.tiendanube?.cantidad || 0,
    opsDot: df?.dot?.cantidad || 0,
    opsAbasto: df?.abasto?.cantidad || 0,
    opsCordoba: df?.cordoba?.cantidad || 0,
  };

  const total = data.palermo + data.laplata + data.online + data.dot + data.abasto + data.cordoba;
  const ops = data.opsPalermo + data.opsLaPlata + data.opsOnline + data.opsDot + data.opsAbasto + data.opsCordoba;
  console.log(`  💰 Total: $${total.toLocaleString('es-AR')} (${ops} ventas)`);
  console.log(`  🏪 PAL:$${data.palermo.toLocaleString()} | LP:$${data.laplata.toLocaleString()} | ON:$${data.online.toLocaleString()} | DOT:$${data.dot.toLocaleString()} | AB:$${data.abasto.toLocaleString()} | CBA:$${data.cordoba.toLocaleString()}`);

  // Save to Google Sheets
  const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;
  if (!OPS_URL) {
    console.log('  ⚠️ APPS_SCRIPT_URL_OPERACIONES no configurada, no se guarda');
    return data;
  }

  const params = JSON.stringify(data);
  const saveUrl = `${OPS_URL}?action=guardarVentaDiaria&params=${encodeURIComponent(params)}`;
  try {
    const r = await fetch(saveUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const result = await r.json();
    console.log(`  ✅ Guardado en Sheets: ${result.ok ? 'OK' : result.error}`);
  } catch (e) {
    console.log(`  ❌ Error guardando: ${e.message}`);
  }

  return data;
}

async function main() {
  // Load env from Vercel
  const envFile = require('child_process').execSync('npx vercel env pull --yes .env.local 2>/dev/null; cat .env.local 2>/dev/null || echo ""', { encoding: 'utf8', cwd: process.cwd() });
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) process.env[m[1]] = m[2];
  }

  const year = 2026;
  const month = 3; // March
  const today = 27; // Up to today

  console.log(`🚀 Cargando datos de ${year}-${String(month).padStart(2,'0')}-01 al ${year}-${String(month).padStart(2,'0')}-${today}`);
  console.log(`📡 Apps Script URL: ${process.env.APPS_SCRIPT_URL_OPERACIONES ? 'OK' : 'NO CONFIGURADA'}`);

  for (let day = 1; day <= today; day++) {
    const fecha = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    await cargarDia(fecha);
    // Small delay to not overwhelm APIs
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n🎉 ¡Listo! Todos los días cargados.');
}

main().catch(console.error);
