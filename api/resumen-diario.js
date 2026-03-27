const webpush = require('web-push');

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, secret } = req.query;
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
    webpush.setVapidDetails(
      'mailto:alan@tussy.com.ar',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const now = new Date(Date.now() - 3 * 3600000);
    const pad = n => String(n).padStart(2, '0');
    const hoy = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
    const ayerDate = new Date(now.getTime() - 86400000);
    const ayer = `${ayerDate.getUTCFullYear()}-${pad(ayerDate.getUTCMonth()+1)}-${pad(ayerDate.getUTCDate())}`;

    const base = 'https://app.gestiontussy.com.ar';

    // Fetch sales + subscriptions in parallel
    const [ventasHoy, ventasAyer, dfHoy, dfAyer, subsData] = await Promise.all([
      fetch(`${base}/api/ventas?desde=${hoy}&hasta=${hoy}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/ventas?desde=${ayer}&hasta=${ayer}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/dragonfish?action=ventas&desde=${hoy}&hasta=${hoy}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/dragonfish?action=ventas&desde=${ayer}&hasta=${ayer}`).then(r => r.json()).catch(() => null),
      fetch(`${OPS_URL}?action=getPushSubs&params=${encodeURIComponent('{}')}`).then(r => r.json()).catch(() => ({ subs: [] })),
    ]);

    const subs = subsData.subs || [];

    const locales = {};
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

    const wooStores = [['palermo','Palermo'],['laplata','La Plata'],['tiendanube','Online']];
    const dfStores = [['dot','Dot'],['abasto','Abasto'],['cordoba','Córdoba']];
    addStore(ventasHoy, 'hoy', wooStores);
    addStore(ventasAyer, 'ayer', wooStores);
    addStore(dfHoy, 'hoy', dfStores);
    addStore(dfAyer, 'ayer', dfStores);

    var totalHoy = 0, totalAyer = 0, opsHoy = 0, opsAyer = 0;
    Object.values(locales).forEach(l => {
      totalHoy += l.hoy; totalAyer += l.ayer;
      opsHoy += l.opsHoy; opsAyer += l.opsAyer;
    });

    var diff = totalAyer > 0 ? (((totalHoy - totalAyer) / totalAyer) * 100).toFixed(1) : '---';
    var signo = diff > 0 ? '+' : '';

    var mejor = '', mejorTotal = 0;
    Object.entries(locales).forEach(([name, data]) => {
      if (data.hoy > mejorTotal) { mejorTotal = data.hoy; mejor = name; }
    });

    var fechaFmt = `${pad(now.getUTCDate())}/${pad(now.getUTCMonth()+1)}`;
    function fmt(n) { return n.toLocaleString('es-AR'); }
    var pushBody = `$${fmt(totalHoy)} (${opsHoy} ventas) | ${signo}${diff}% vs ayer | Mejor: ${mejor}`;

    const payload = JSON.stringify({
      title: 'Resumen Tussy ' + fechaFmt,
      body: pushBody,
      url: '/'
    });

    let sent = 0, failed = 0;
    const pushResults = [];
    const toRemove = [];

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

    res.status(200).json({
      ok: true, sent, failed, totalSubs: subs.length, pushResults,
      fecha: hoy, fechaFmt, totalHoy, totalAyer, diff: `${signo}${diff}%`, mejor
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
