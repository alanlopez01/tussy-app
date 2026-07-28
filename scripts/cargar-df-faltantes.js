/**
 * Segunda pasada: cargar solo Dragonfish para los días que faltaron (1-16 de Marzo)
 * Y actualizar la hoja combinando con los datos WooCommerce ya guardados.
 */

const BASE = 'https://tussy-app.vercel.app';

async function fetchJSON(url, timeout = 55000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function cargarDia(fecha) {
  console.log(`\n📅 ${fecha}...`);

  // Fetch WooCommerce and Dragonfish SEQUENTIALLY to avoid concurrency limits
  const woo = await fetchJSON(`${BASE}/api/ventas?desde=${fecha}&hasta=${fecha}`, 30000);

  // Wait a bit then fetch DF
  await new Promise(r => setTimeout(r, 1000));
  const df = await fetchJSON(`${BASE}/api/dragonfish?action=ventas&desde=${fecha}&hasta=${fecha}`, 55000);

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

  console.log(`  DOT:$${data.dot.toLocaleString()} | AB:$${data.abasto.toLocaleString()} | CBA:$${data.cordoba.toLocaleString()}`);

  if (data.dot === 0 && data.abasto === 0 && data.cordoba === 0) {
    console.log(`  ⚠️ Dragonfish sin datos, saltando...`);
    return null;
  }

  // Save to Google Sheets
  const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;
  const params = JSON.stringify(data);
  const saveUrl = `${OPS_URL}?action=guardarVentaDiaria&params=${encodeURIComponent(params)}`;
  try {
    const r = await fetch(saveUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const result = await r.json();
    console.log(`  ✅ Actualizado: ${result.ok ? 'OK' : result.error}`);
  } catch (e) {
    console.log(`  ❌ Error: ${e.message}`);
  }

  return data;
}

async function main() {
  // Load env
  const envFile = require('child_process').execSync('cat .env.local 2>/dev/null || echo ""', { encoding: 'utf8', cwd: process.cwd() });
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) process.env[m[1]] = m[2];
  }

  console.log('🔄 Segunda pasada: Dragonfish para días 1-16 de Marzo');

  for (let day = 1; day <= 16; day++) {
    const fecha = `2026-03-${String(day).padStart(2,'0')}`;
    await cargarDia(fecha);
    // More delay between requests to let DF breathe
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n🎉 ¡Segunda pasada completa!');
}

main().catch(console.error);
