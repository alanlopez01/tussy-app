module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const WOO_P_URL  = process.env.WOO_PALERMO_URL;
  const WOO_P_KEY  = process.env.WOO_PALERMO_KEY;
  const WOO_P_SEC  = process.env.WOO_PALERMO_SECRET;
  const WOO_LP_URL = process.env.WOO_LAPLATA_URL;
  const WOO_LP_KEY = process.env.WOO_LAPLATA_KEY;
  const WOO_LP_SEC = process.env.WOO_LAPLATA_SECRET;
  const TN_TOKEN   = process.env.TN_ACCESS_TOKEN;
  const TN_USER    = process.env.TN_USER_ID;

  // Calcular fechas en zona horaria Argentina
  const ahora = new Date();
  const offsetARG = -3 * 60;
  const argNow = new Date(ahora.getTime() + (offsetARG - ahora.getTimezoneOffset()) * 60000);
  const pad = n => String(n).padStart(2, "0");
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  const hoy = fmtDate(argNow);
  const inicioMes = `${argNow.getFullYear()}-${pad(argNow.getMonth()+1)}-01`;

  // Mes anterior
  const mesAnt = new Date(argNow.getFullYear(), argNow.getMonth()-1, 1);
  const inicioMesAnt = `${mesAnt.getFullYear()}-${pad(mesAnt.getMonth()+1)}-01`;
  const finMesAnt = new Date(argNow.getFullYear(), argNow.getMonth(), 0);
  const finMesAntStr = fmtDate(finMesAnt);

  function toUTC(fecha, esInicio) {
    const [y, m, d] = fecha.split("-").map(Number);
    if (esInicio) return `${y}-${pad(m)}-${pad(d)}T03:00:00+0000`;
    const sig = new Date(Date.UTC(y, m-1, d+1));
    return `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth()+1)}-${pad(sig.getUTCDate())}T02:59:59+0000`;
  }

  async function getWooTotal(url, key, secret, desde, hasta) {
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");
    const headers = { "Authorization": `Basic ${auth}` };
    const r = await fetch(
      `${url}/wp-json/wc/v3/reports/sales?date_min=${desde}&date_max=${hasta}`,
      { headers }
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

  try {
    const [
      palmHoy, lpHoy, tnHoy,
      palmMes, lpMes, tnMes,
      palmAnt, lpAnt, tnAnt
    ] = await Promise.all([
      getWooTotal(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, hoy, hoy),
      getWooTotal(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, hoy, hoy),
      getTNTotal(hoy, hoy),
      getWooTotal(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, inicioMes, hoy),
      getWooTotal(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, inicioMes, hoy),
      getTNTotal(inicioMes, hoy),
      getWooTotal(WOO_P_URL, WOO_P_KEY, WOO_P_SEC, inicioMesAnt, finMesAntStr),
      getWooTotal(WOO_LP_URL, WOO_LP_KEY, WOO_LP_SEC, inicioMesAnt, finMesAntStr),
      getTNTotal(inicioMesAnt, finMesAntStr)
    ]);

    const locales = [
      { nombre: "Palermo",    hoy: palmHoy,  mes: palmMes,  ant: palmAnt  },
      { nombre: "La Plata",   hoy: lpHoy,    mes: lpMes,    ant: lpAnt    },
      { nombre: "Tiendanube", hoy: tnHoy,    mes: tnMes,    ant: tnAnt    }
    ];

    // Ordenar por mes (ranking)
    const ranking = [...locales].sort((a, b) => b.mes.total - a.mes.total);

    res.status(200).json({
      locales,
      ranking,
      totalHoy: locales.reduce((s, l) => s + l.hoy.total, 0),
      totalMes: locales.reduce((s, l) => s + l.mes.total, 0),
      totalAnt: locales.reduce((s, l) => s + l.ant.total, 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
