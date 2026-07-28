// Server-side cache (persists while serverless function is warm)
const _cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCache(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete _cache[key]; return null; }
  return entry.data;
}

function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const compCacheKey = "comparacion_" + new Date().toISOString().slice(0, 13);
  const cached = getCache(compCacheKey);
  if (cached) return res.status(200).json(cached);

  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;
  const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
  const TN_USER    = process.env.TN_USER_ID;
  const OPS_URL    = process.env.APPS_SCRIPT_URL_OPERACIONES;
  const BASE       = 'https://app.gestiontussy.com.ar';

  const ahora = new Date();
  const offsetARG = -3 * 60;
  const argNow = new Date(ahora.getTime() + (offsetARG - ahora.getTimezoneOffset()) * 60000);
  const pad = n => String(n).padStart(2, "0");
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  const hoy = fmtDate(argNow);
  const diaDelMes = argNow.getDate();
  const mesActual = `${argNow.getFullYear()}-${pad(argNow.getMonth()+1)}`;

  // Mes anterior
  const mesAntYear = argNow.getMonth() === 0 ? argNow.getFullYear()-1 : argNow.getFullYear();
  const mesAntMes  = argNow.getMonth() === 0 ? 12 : argNow.getMonth();
  const mesAnterior = `${mesAntYear}-${pad(mesAntMes)}`;
  const ultimoDiaMesAnt = new Date(argNow.getFullYear(), argNow.getMonth(), 0).getDate();
  const diaComparacion = Math.min(diaDelMes, ultimoDiaMesAnt);

  function toUTC(fecha, esInicio) {
    const [y, m, d] = fecha.split("-").map(Number);
    if (esInicio) return `${y}-${pad(m)}-${pad(d)}T03:00:00+0000`;
    const sig = new Date(Date.UTC(y, m-1, d+1));
    return `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth()+1)}-${pad(sig.getUTCDate())}T02:59:59+0000`;
  }

  async function getWooTotal(url, key, secret, desde, hasta) {
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const r = await fetch(
      `${url}/wp-json/wc/v3/reports/sales?date_min=${desde}&date_max=${hasta}`,
      { headers: { "Authorization": `Basic ${auth}` } }
    );
    const data = await r.json();
    return {
      total: Array.isArray(data) && data[0] ? parseFloat(data[0].total_sales || 0) : 0,
      cantidad: Array.isArray(data) && data[0] ? parseInt(data[0].total_orders || 0) : 0
    };
  }

  async function getTNTotal(desde, hasta) {
    const inicioUTC = toUTC(desde, true);
    const finUTC    = toUTC(hasta, false);
    let total = 0, cantidad = 0, page = 1;
    while (true) {
      const r = await fetch(
        `https://api.tiendanube.com/v1/${TN_USER}/orders?created_at_min=${inicioUTC}&created_at_max=${finUTC}&per_page=200&page=${page}&fields=id,total`,
        { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "TussyApp/1.0" } }
      );
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      total += data.reduce((s, o) => s + parseFloat(o.total || 0), 0);
      cantidad += data.length;
      if (data.length < 200) break;
      page++;
    }
    return { total, cantidad };
  }

  // Fetch de Dragonfish para HOY (un solo día, rápido)
  async function getDFHoy() {
    try {
      const r = await fetch(`${BASE}/api/dragonfish?action=ventas&desde=${hoy}&hasta=${hoy}`, { signal: AbortSignal.timeout(45000) });
      const data = await r.json();
      return {
        dot: { total: data.dot?.total || 0, cantidad: data.dot?.cantidad || 0 },
        abasto: { total: data.abasto?.total || 0, cantidad: data.abasto?.cantidad || 0 },
        cordoba: { total: data.cordoba?.total || 0, cantidad: data.cordoba?.cantidad || 0 },
      };
    } catch(e) {
      return { dot: {total:0,cantidad:0}, abasto: {total:0,cantidad:0}, cordoba: {total:0,cantidad:0} };
    }
  }

  // Fetch totales del mes desde Google Sheets (instantáneo, ya pre-calculado)
  async function getSheetsMes(mes) {
    try {
      const params = JSON.stringify({ mes });
      const url = `${OPS_URL}?action=getVentasMes&params=${encodeURIComponent(params)}`;
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      return await r.json();
    } catch(e) {
      return { dias: [], totales: { palermo:0, laplata:0, online:0, dot:0, abasto:0, cordoba:0, opsPalermo:0, opsLaPlata:0, opsOnline:0, opsDot:0, opsAbasto:0, opsCordoba:0 } };
    }
  }

  try {
    // En paralelo: WooCommerce hoy + Dragonfish hoy + Sheets mes actual + Sheets mes anterior
    const [palmHoy, lpHoy, tnHoy, dfHoy, sheetsMes, sheetsAnt] = await Promise.all([
      getWooTotal(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, hoy, hoy),
      getWooTotal(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, hoy, hoy),
      getTNTotal(hoy, hoy),
      getDFHoy(),
      getSheetsMes(mesActual),
      getSheetsMes(mesAnterior),
    ]);

    const t = sheetsMes.totales || {};
    const tAnt = sheetsAnt.totales || {};

    // Detectar si Sheets ya tiene los datos de HOY (si el cron ya corrió)
    // Si es así, NO sumar la data live de hoy para evitar doble conteo
    const sheetsTieneHoy = Array.isArray(sheetsMes.dias) && sheetsMes.dias.some(d => {
      const fecha = typeof d.fecha === 'string' ? d.fecha.substring(0, 10) : '';
      return fecha === hoy;
    });
    const liveSiNoEnSheets = (sheetsTieneHoy ? 0 : 1);

    // Mes actual = datos de Sheets (días pasados) + hoy en vivo (solo si Sheets no lo tiene)
    const proyectar = (total) => diaDelMes > 0 ? Math.round(total / diaDelMes * 30) : 0;

    const locales = [
      {
        nombre: "Palermo",
        hoy: palmHoy,
        mes: { total: (t.palermo || 0) + palmHoy.total * liveSiNoEnSheets, cantidad: (t.opsPalermo || 0) + palmHoy.cantidad * liveSiNoEnSheets },
        ant: { total: tAnt.palermo || 0, cantidad: tAnt.opsPalermo || 0 },
      },
      {
        nombre: "La Plata",
        hoy: lpHoy,
        mes: { total: (t.laplata || 0) + lpHoy.total * liveSiNoEnSheets, cantidad: (t.opsLaPlata || 0) + lpHoy.cantidad * liveSiNoEnSheets },
        ant: { total: tAnt.laplata || 0, cantidad: tAnt.opsLaPlata || 0 },
      },
      {
        nombre: "Tiendanube",
        hoy: tnHoy,
        mes: { total: (t.online || 0) + tnHoy.total * liveSiNoEnSheets, cantidad: (t.opsOnline || 0) + tnHoy.cantidad * liveSiNoEnSheets },
        ant: { total: tAnt.online || 0, cantidad: tAnt.opsOnline || 0 },
      },
      {
        nombre: "Dot",
        hoy: dfHoy.dot,
        mes: { total: (t.dot || 0) + dfHoy.dot.total * liveSiNoEnSheets, cantidad: (t.opsDot || 0) + dfHoy.dot.cantidad * liveSiNoEnSheets },
        ant: { total: tAnt.dot || 0, cantidad: tAnt.opsDot || 0 },
      },
      {
        nombre: "Abasto",
        hoy: dfHoy.abasto,
        mes: { total: (t.abasto || 0) + dfHoy.abasto.total * liveSiNoEnSheets, cantidad: (t.opsAbasto || 0) + dfHoy.abasto.cantidad * liveSiNoEnSheets },
        ant: { total: tAnt.abasto || 0, cantidad: tAnt.opsAbasto || 0 },
      },
      {
        nombre: "Córdoba",
        hoy: dfHoy.cordoba,
        mes: { total: (t.cordoba || 0) + dfHoy.cordoba.total * liveSiNoEnSheets, cantidad: (t.opsCordoba || 0) + dfHoy.cordoba.cantidad * liveSiNoEnSheets },
        ant: { total: tAnt.cordoba || 0, cantidad: tAnt.opsCordoba || 0 },
      }
    ];

    // Agregar proyección
    locales.forEach(l => { l.proyeccion = proyectar(l.mes.total); });

    const totalMes = locales.reduce((s, l) => s + l.mes.total, 0);
    const totalAnt = locales.reduce((s, l) => s + l.ant.total, 0);

    const result = {
      locales,
      ranking: [...locales].sort((a, b) => b.mes.total - a.mes.total),
      totalHoy: locales.reduce((s, l) => s + l.hoy.total, 0),
      totalMes,
      totalAnt,
      proyeccionTotal: proyectar(totalMes),
      diaDelMes,
      diasComparados: diaComparacion
    };
    setCache(compCacheKey, result);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
