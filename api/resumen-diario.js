const webpush = require('web-push');

module.exports = async function handler(req, res) {
  // maxDuration 60s para que Dragonfish tenga tiempo
  module.exports.maxDuration = 60;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, secret, tipo } = req.query;
  const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;

  // === SUBSCRIBE (save to Google Sheets) ===
  if (action === "subscribe" && req.method === "POST") {
    const { subscription, usuario } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription required" });
    }
    try {
      const params = JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys, usuario });
      const url = `${OPS_URL}?action=guardarPushSub&params=${encodeURIComponent(params)}`;
      await fetch(url, { redirect: "follow" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // === SEND RESUMEN ===
  if (secret !== process.env.PUSH_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const soloGuardar = tipo === 'saveOnly';

    if (!soloGuardar) {
      webpush.setVapidDetails(
        'mailto:alan@tussy.com.ar',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
    }

    // El cron corre ~23:59 ARG pero Vercel puede retrasarlo a 00:15-00:30 del día siguiente.
    // Siempre reportamos sobre "ayer" (el día que acaba de terminar).
    const nowUTC = new Date();
    const argMs = nowUTC.getTime() - 3 * 3600000;
    const argNow = new Date(argMs);
    const pad = n => String(n).padStart(2, '0');

    // "hoy" para el resumen diario = ayer en ARG (el día que cerró)
    // Si es llamado manualmente a las 15hs, usamos el día actual
    const horaARG = argNow.getUTCHours();
    const esAutomatico = !tipo; // sin tipo = cron diario
    const fechaReporte = (esAutomatico && horaARG < 6)
      ? new Date(argMs - 86400000) // Si es madrugada (cron retrasado), reportar día anterior
      : argNow;

    const hoy = `${fechaReporte.getUTCFullYear()}-${pad(fechaReporte.getUTCMonth()+1)}-${pad(fechaReporte.getUTCDate())}`;
    const ayerDate = new Date(fechaReporte.getTime() - 86400000);
    const ayer = `${ayerDate.getUTCFullYear()}-${pad(ayerDate.getUTCMonth()+1)}-${pad(ayerDate.getUTCDate())}`;
    const primerDiaMes = `${fechaReporte.getUTCFullYear()}-${pad(fechaReporte.getUTCMonth()+1)}-01`;

    const base = 'https://app.gestiontussy.com.ar';
    const esMensual = tipo === 'mensual';

    // Fetch with timeout helper
    const fetchT = (url, ms) => fetch(url, { signal: AbortSignal.timeout(ms) }).then(r => r.json()).catch(() => null);

    // Fetch sales + subscriptions in parallel
    const subsPromise = soloGuardar
      ? Promise.resolve({ subs: [] })
      : fetchT(`${OPS_URL}?action=getPushSubs&params=${encodeURIComponent('{}')}`, 10000).then(r => r || { subs: [] });

    let fetches;
    if (esMensual) {
      // For monthly: fetch each DF store separately so each gets its own 60s serverless function
      fetches = [
        subsPromise,
        fetchT(`${base}/api/ventas?desde=${primerDiaMes}&hasta=${hoy}`, 50000),
        fetchT(`${base}/api/dragonfish?action=ventas&desde=${primerDiaMes}&hasta=${hoy}&local=dot`, 50000),
        fetchT(`${base}/api/dragonfish?action=ventas&desde=${primerDiaMes}&hasta=${hoy}&local=abasto`, 50000),
        fetchT(`${base}/api/dragonfish?action=ventas&desde=${primerDiaMes}&hasta=${hoy}&local=cordoba`, 50000),
      ];
    } else {
      fetches = [
        subsPromise,
        fetchT(`${base}/api/ventas?desde=${hoy}&hasta=${hoy}`, 15000),
        fetchT(`${base}/api/ventas?desde=${ayer}&hasta=${ayer}`, 15000),
        fetchT(`${base}/api/dragonfish?action=ventas&desde=${hoy}&hasta=${hoy}`, 50000),
        fetchT(`${base}/api/dragonfish?action=ventas&desde=${ayer}&hasta=${ayer}`, 50000),
      ];
    }

    const results = await Promise.all(fetches);
    const subs = (results[0].subs || []);

    const locales = {};
    const wooStores = [['palermo','Palermo'],['laplata','La Plata'],['tiendanube','Online']];
    const dfStores = [['dot','Dot'],['abasto','Abasto'],['cordoba','Córdoba']];

    function addStore(src, period, stores) {
      if (!src) return;
      stores.forEach(([k, nombre]) => {
        if (src[k]) {
          if (!locales[nombre]) locales[nombre] = { hoy: 0, ayer: 0, opsHoy: 0, opsAyer: 0 };
          locales[nombre][period === 'hoy' ? 'hoy' : 'ayer'] = src[k].total || 0;
          locales[nombre][period === 'hoy' ? 'opsHoy' : 'opsAyer'] = src[k].cantidad || 0;
        }
      });
    }

    if (esMensual) {
      addStore(results[1], 'hoy', wooStores);
      // Each DF local comes as separate response: {dot: {...}} or {abasto: {...}} etc
      addStore(results[2], 'hoy', dfStores);
      addStore(results[3], 'hoy', dfStores);
      addStore(results[4], 'hoy', dfStores);
    } else {
      addStore(results[1], 'hoy', wooStores);
      addStore(results[2], 'ayer', wooStores);
      addStore(results[3], 'hoy', dfStores);
      addStore(results[4], 'ayer', dfStores);
    }

    var totalHoy = 0, totalAyer = 0, opsHoy = 0, opsAyer = 0;
    Object.values(locales).forEach(l => {
      totalHoy += l.hoy; totalAyer += l.ayer;
      opsHoy += l.opsHoy; opsAyer += l.opsAyer;
    });

    function fmt(n) { return n.toLocaleString('es-AR'); }
    var payload;

    if (esMensual) {
      const mesNombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      const mesNombre = mesNombres[fechaReporte.getUTCMonth()];
      var mejor = '', mejorTotal = 0;
      Object.entries(locales).forEach(([name, data]) => {
        if (data.hoy > mejorTotal) { mejorTotal = data.hoy; mejor = name; }
      });
      var detalle = Object.entries(locales).map(([name, data]) => `${name}: $${fmt(data.hoy)} (${data.opsHoy})`).join(' | ');
      payload = JSON.stringify({
        title: `📊 Resumen ${mesNombre} ${now.getUTCFullYear()}`,
        body: `Total: $${fmt(totalHoy)} (${opsHoy} ventas)\n${detalle}\nMejor: ${mejor}`,
        url: '/'
      });
    } else {
      var diff = totalAyer > 0 ? (((totalHoy - totalAyer) / totalAyer) * 100).toFixed(1) : '---';
      var signo = diff > 0 ? '+' : '';
      var mejor = '', mejorTotal = 0;
      Object.entries(locales).forEach(([name, data]) => {
        if (data.hoy > mejorTotal) { mejorTotal = data.hoy; mejor = name; }
      });
      var fechaFmt = `${pad(fechaReporte.getUTCDate())}/${pad(fechaReporte.getUTCMonth()+1)}`;
      var pushBody = `$${fmt(totalHoy)} (${opsHoy} ventas) | ${signo}${diff}% vs ayer | Mejor: ${mejor}`;
      payload = JSON.stringify({
        title: 'Resumen Tussy ' + fechaFmt,
        body: pushBody,
        url: '/'
      });
    }

    let sent = 0, failed = 0;
    const pushResults = [];
    const toRemove = [];

    // El push de cierre ahora lo manda /api/metricas?action=cierre (con desglose
    // por local). Este push legacy queda apagado salvo que se saque la env var.
    const legacyPushOff = process.env.LEGACY_PUSH_OFF === "1";

    if (!soloGuardar && !legacyPushOff) {
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          sent++;
          pushResults.push({ user: sub.usuario, ok: true });
        } catch (err) {
          failed++;
          pushResults.push({ user: sub.usuario, error: err.message, status: err.statusCode });
          if (err.statusCode === 410 || err.statusCode === 404) {
            toRemove.push(sub.subscription.endpoint);
          }
        }
      }

      // Clean expired subs from Google Sheets
      for (const ep of toRemove) {
        try {
          const params = JSON.stringify({ endpoint: ep });
          await fetch(`${OPS_URL}?action=eliminarPushSub&params=${encodeURIComponent(params)}`);
        } catch(e) {}
      }
    }

    // Guardar cierre del día en Google Sheets (VentasDiarias)
    // IMPORTANTE: si una API falló (results[N] === null) o un local individual
    // devolvió ok:false, enviamos null en vez de 0 para que el Apps Script preserve
    // el valor anterior y no sobrescriba con 0.
    if (!esMensual || soloGuardar) {
      try {
        const wooHoy = results[1]; // null si falló la llamada Woo+TN
        const dfHoyData = results[3]; // null si falló la llamada Dragonfish
        // Log de locales caídos para trazabilidad en Vercel logs
        [['Woo/TN', wooHoy], ['Dragonfish', dfHoyData]].forEach(([tag, src]) => {
          if (!src) { console.warn(`[resumen-diario] ${tag} API entera caída para ${hoy}`); return; }
          Object.entries(src).forEach(([k, v]) => {
            if (v && typeof v === 'object' && v.ok === false) {
              console.warn(`[resumen-diario] ${tag}.${k} fallo el ${hoy}: ${v.error || 'sin detalle'}`);
            }
          });
        });
        const safeNum = (obj, path) => {
          if (!obj) return null; // fetch entero falló: no sobrescribir
          const [k1, k2] = path.split('.');
          const local = obj[k1];
          if (!local) return null;
          // Si el local vino marcado como no confiable (ok:false), preservar valor previo
          if (local.ok === false) return null;
          const v = local[k2];
          return (v === undefined || v === null) ? null : v;
        };
        const ventaDiaria = {
          fecha: hoy,
          palermo:    safeNum(wooHoy,    'palermo.total'),
          laplata:    safeNum(wooHoy,    'laplata.total'),
          online:     safeNum(wooHoy,    'tiendanube.total'),
          dot:        safeNum(dfHoyData, 'dot.total'),
          abasto:     safeNum(dfHoyData, 'abasto.total'),
          cordoba:    safeNum(dfHoyData, 'cordoba.total'),
          opsPalermo: safeNum(wooHoy,    'palermo.cantidad'),
          opsLaPlata: safeNum(wooHoy,    'laplata.cantidad'),
          opsOnline:  safeNum(wooHoy,    'tiendanube.cantidad'),
          opsDot:     safeNum(dfHoyData, 'dot.cantidad'),
          opsAbasto:  safeNum(dfHoyData, 'abasto.cantidad'),
          opsCordoba: safeNum(dfHoyData, 'cordoba.cantidad'),
        };
        const saveParams = JSON.stringify(ventaDiaria);
        await fetch(`${OPS_URL}?action=guardarVentaDiaria&params=${encodeURIComponent(saveParams)}`, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      } catch(e) { /* no bloquear el response */ }

      // === RE-CHECK ÚLTIMOS 2 DÍAS ===
      // Para capturar transferencias confirmadas tarde, órdenes paid post-cron, o fallas de API previas.
      // Usa la lógica de merge en guardarVentaDiaria: si la API ahora falla, preserva el valor existente.
      try {
        const reFetchDays = [1, 2]; // re-procesar D-1 y D-2 atrás
        for (const daysBack of reFetchDays) {
          const rd = new Date(fechaReporte.getTime() - daysBack * 86400000);
          const fechaR = `${rd.getUTCFullYear()}-${pad(rd.getUTCMonth()+1)}-${pad(rd.getUTCDate())}`;

          const [vR, dfR] = await Promise.all([
            fetchT(`${base}/api/ventas?desde=${fechaR}&hasta=${fechaR}`, 20000),
            fetchT(`${base}/api/dragonfish?action=ventas&desde=${fechaR}&hasta=${fechaR}`, 50000)
          ]);

          const safe = (obj, path) => {
            if (!obj) return null;
            const [k1, k2] = path.split('.');
            const local = obj[k1];
            if (!local) return null;
            if (local.ok === false) return null; // no pisar si el local vino con error
            const v = local[k2];
            return (v === undefined || v === null) ? null : v;
          };

          const recheckPayload = {
            fecha: fechaR,
            palermo:    safe(vR,  'palermo.total'),
            laplata:    safe(vR,  'laplata.total'),
            online:     safe(vR,  'tiendanube.total'),
            dot:        safe(dfR, 'dot.total'),
            abasto:     safe(dfR, 'abasto.total'),
            cordoba:    safe(dfR, 'cordoba.total'),
            opsPalermo: safe(vR,  'palermo.cantidad'),
            opsLaPlata: safe(vR,  'laplata.cantidad'),
            opsOnline:  safe(vR,  'tiendanube.cantidad'),
            opsDot:     safe(dfR, 'dot.cantidad'),
            opsAbasto:  safe(dfR, 'abasto.cantidad'),
            opsCordoba: safe(dfR, 'cordoba.cantidad'),
          };
          const recheckParams = JSON.stringify(recheckPayload);
          await fetch(`${OPS_URL}?action=guardarVentaDiaria&params=${encodeURIComponent(recheckParams)}`, { redirect: 'follow', signal: AbortSignal.timeout(10000) }).catch(() => null);
        }
      } catch(e) { /* re-check es opcional, no bloquear el cron */ }
    }

    const resData = { ok: true, sent, failed, totalSubs: subs.length, pushResults, fecha: hoy, totalHoy, locales };
    if (esMensual) { resData.tipo = 'mensual'; resData.desde = primerDiaMes; }
    res.status(200).json(resData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
