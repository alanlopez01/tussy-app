let webpush;
try { webpush = require('web-push'); } catch(e) { webpush = null; }

// In-memory push subscriptions (resets on cold start)
const subs = global.__pushSubs || (global.__pushSubs = []);

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // === SUBSCRIBE ===
  if (action === "subscribe" && req.method === "POST") {
    const { subscription, usuario } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription required" });
    }
    const idx = subs.findIndex(s => s.subscription.endpoint === subscription.endpoint);
    if (idx !== -1) subs.splice(idx, 1);
    subs.push({ subscription, usuario: usuario || "unknown", ts: Date.now() });
    return res.status(200).json({ ok: true, total: subs.length });
  }

  // === SEND RESUMEN ===
  const secret = req.query.secret || req.body?.secret;
  const pushSecret = process.env.PUSH_SECRET;
  if (!pushSecret) {
    return res.status(500).json({ error: "PUSH_SECRET not configured" });
  }
  if (secret !== pushSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  if (webpush) webpush.setVapidDetails('mailto:alan@tussy.com.ar', VAPID_PUBLIC, VAPID_PRIVATE);

  try {
    const now = new Date(Date.now() - 3 * 3600000);
    const pad = n => String(n).padStart(2, '0');
    const hoy = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
    const ayerDate = new Date(now.getTime() - 86400000);
    const ayer = `${ayerDate.getUTCFullYear()}-${pad(ayerDate.getUTCMonth()+1)}-${pad(ayerDate.getUTCDate())}`;

    const base = 'https://app.gestiontussy.com.ar';

    const [ventasHoy, ventasAyer, dfHoy, dfAyer] = await Promise.all([
      fetch(`${base}/api/ventas?desde=${hoy}&hasta=${hoy}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/ventas?desde=${ayer}&hasta=${ayer}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/dragonfish?action=ventas&desde=${hoy}&hasta=${hoy}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/dragonfish?action=ventas&desde=${ayer}&hasta=${ayer}`).then(r => r.json()).catch(() => null),
    ]);

    const locales = {};
    if (ventasHoy) {
      ['palermo', 'laplata', 'tiendanube'].forEach(k => {
        if (ventasHoy[k]) {
          var nombre = k === 'laplata' ? 'La Plata' : k === 'tiendanube' ? 'Online' : 'Palermo';
          if (!locales[nombre]) locales[nombre] = { hoy: 0, ayer: 0, opsHoy: 0, opsAyer: 0 };
          locales[nombre].hoy = ventasHoy[k].total || 0;
          locales[nombre].opsHoy = ventasHoy[k].cantidad || 0;
        }
      });
    }
    if (ventasAyer) {
      ['palermo', 'laplata', 'tiendanube'].forEach(k => {
        if (ventasAyer[k]) {
          var nombre = k === 'laplata' ? 'La Plata' : k === 'tiendanube' ? 'Online' : 'Palermo';
          if (!locales[nombre]) locales[nombre] = { hoy: 0, ayer: 0, opsHoy: 0, opsAyer: 0 };
          locales[nombre].ayer = ventasAyer[k].total || 0;
          locales[nombre].opsAyer = ventasAyer[k].cantidad || 0;
        }
      });
    }
    if (dfHoy) {
      ['dot', 'abasto', 'cordoba'].forEach(k => {
        if (dfHoy[k]) {
          var nombre = k === 'dot' ? 'Dot' : k === 'abasto' ? 'Abasto' : 'Córdoba';
          if (!locales[nombre]) locales[nombre] = { hoy: 0, ayer: 0, opsHoy: 0, opsAyer: 0 };
          locales[nombre].hoy = dfHoy[k].total || 0;
          locales[nombre].opsHoy = dfHoy[k].cantidad || 0;
        }
      });
    }
    if (dfAyer) {
      ['dot', 'abasto', 'cordoba'].forEach(k => {
        if (dfAyer[k]) {
          var nombre = k === 'dot' ? 'Dot' : k === 'abasto' ? 'Abasto' : 'Córdoba';
          if (!locales[nombre]) locales[nombre] = { hoy: 0, ayer: 0, opsHoy: 0, opsAyer: 0 };
          locales[nombre].ayer = dfAyer[k].total || 0;
          locales[nombre].opsAyer = dfAyer[k].cantidad || 0;
        }
      });
    }

    var totalHoy = 0, totalAyer = 0, opsHoy = 0, opsAyer = 0;
    Object.values(locales).forEach(l => {
      totalHoy += l.hoy; totalAyer += l.ayer;
      opsHoy += l.opsHoy; opsAyer += l.opsAyer;
    });

    var diff = totalAyer > 0 ? (((totalHoy - totalAyer) / totalAyer) * 100).toFixed(1) : '---';
    var signo = diff > 0 ? '+' : '';
    function fmt(n) { return n.toLocaleString('es-AR'); }

    var mejor = '', mejorTotal = 0;
    Object.entries(locales).forEach(([name, data]) => {
      if (data.hoy > mejorTotal) { mejorTotal = data.hoy; mejor = name; }
    });

    var fechaFmt = `${pad(now.getUTCDate())}/${pad(now.getUTCMonth()+1)}`;
    var pushBody = `$${fmt(totalHoy)} (${opsHoy} ventas) | ${signo}${diff}% vs ayer | Mejor: ${mejor}`;

    var resumenData = {
      fecha: hoy, fechaFmt, totalHoy, totalAyer, opsHoy, opsAyer,
      diff: `${signo}${diff}%`,
      ticketHoy: opsHoy > 0 ? Math.round(totalHoy / opsHoy) : 0,
      ticketAyer: opsAyer > 0 ? Math.round(totalAyer / opsAyer) : 0,
      mejor, mejorTotal, locales
    };

    global.__lastResumen = resumenData;

    let sent = 0;
    const payload = JSON.stringify({
      title: `Resumen Tussy ${fechaFmt}`,
      body: pushBody,
      url: '/?resumen=1'
    });

    if (webpush) {
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          sent++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            const idx = subs.findIndex(s => s.subscription.endpoint === sub.subscription.endpoint);
            if (idx !== -1) subs.splice(idx, 1);
          }
        }
      }
    }

    res.status(200).json({ ok: true, sent, resumen: resumenData });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack ? err.stack.split('\n').slice(0,3) : null });
  }
};
