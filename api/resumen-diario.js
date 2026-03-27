// In-memory push subscriptions
const subs = global.__pushSubs || (global.__pushSubs = []);

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, secret } = req.query;

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

  // === GET RESUMEN ===
  if (secret !== process.env.PUSH_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

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

    res.status(200).json({
      ok: true,
      fecha: hoy, fechaFmt, totalHoy, totalAyer, opsHoy, opsAyer,
      diff: `${signo}${diff}%`,
      ticketHoy: opsHoy > 0 ? Math.round(totalHoy / opsHoy) : 0,
      ticketAyer: opsAyer > 0 ? Math.round(totalAyer / opsAyer) : 0,
      mejor, mejorTotal, locales,
      subs: subs.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
