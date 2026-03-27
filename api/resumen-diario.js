const crypto = require('crypto');

// In-memory push subscriptions
const subs = global.__pushSubs || (global.__pushSubs = []);

// === Minimal Web Push implementation using Node crypto ===
function urlBase64ToBuffer(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function bufferToUrlBase64(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createVapidJwt(endpoint, vapidPublic, vapidPrivate) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header = bufferToUrlBase64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bufferToUrlBase64(Buffer.from(JSON.stringify({ aud: audience, exp: expiration, sub: 'mailto:alan@tussy.com.ar' })));
  const unsignedToken = `${header}.${payload}`;

  // Convert VAPID private key to PEM
  const privKeyBuf = urlBase64ToBuffer(vapidPrivate);
  const pkcs8Prefix = Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');
  const pkcs8 = Buffer.concat([pkcs8Prefix, privKeyBuf]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----`;

  const sign = crypto.createSign('SHA256');
  sign.update(unsignedToken);
  const sig = sign.sign(pem);

  // Convert DER signature to raw r||s format
  let offset = 3;
  const rLen = sig[offset];
  offset++;
  let r = sig.subarray(offset, offset + rLen);
  offset += rLen + 1;
  const sLen = sig[offset];
  offset++;
  let s = sig.subarray(offset, offset + sLen);
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  const rawSig = Buffer.concat([
    Buffer.alloc(32 - r.length), r,
    Buffer.alloc(32 - s.length), s
  ]);

  return `${unsignedToken}.${bufferToUrlBase64(rawSig)}`;
}

function encryptPayload(subscription, payload) {
  const clientPublicKey = urlBase64ToBuffer(subscription.keys.p256dh);
  const authSecret = urlBase64ToBuffer(subscription.keys.auth);

  // Generate local ECDH key pair
  const localKeys = crypto.createECDH('prime256v1');
  localKeys.generateKeys();
  const localPublicKey = localKeys.getPublicKey();

  // Shared secret via ECDH
  const sharedSecret = localKeys.computeSecret(clientPublicKey);

  // HKDF to derive auth info
  const authInfo = Buffer.concat([Buffer.from('Content-Encoding: auth\0'), Buffer.alloc(1)]);
  const prk = crypto.createHmac('sha256', authSecret).update(sharedSecret).digest();

  // Key info
  const keyInfo = Buffer.concat([
    Buffer.from('Content-Encoding: aes128gcm\0'),
    Buffer.from('P-256\0'),
    Buffer.from([0, 65]), clientPublicKey,
    Buffer.from([0, 65]), localPublicKey
  ]);
  const nonceInfo = Buffer.concat([
    Buffer.from('Content-Encoding: nonce\0'),
    Buffer.from('P-256\0'),
    Buffer.from([0, 65]), clientPublicKey,
    Buffer.from([0, 65]), localPublicKey
  ]);

  // IKM
  const ikm = hkdf(authSecret, sharedSecret, Buffer.from('Content-Encoding: auth\0'), 32);
  const salt = crypto.randomBytes(16);
  const derivedKey = hkdf(salt, ikm, keyInfo, 16);
  const derivedNonce = hkdf(salt, ikm, nonceInfo, 12);

  // Encrypt
  const payloadBuf = Buffer.from(payload, 'utf8');
  const paddedPayload = Buffer.concat([payloadBuf, Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', derivedKey, derivedNonce);
  const encrypted = Buffer.concat([cipher.update(paddedPayload), cipher.final(), cipher.getAuthTag()]);

  // Build aes128gcm record
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(encrypted.length + 17 + 1, 0); // Add overhead
  const header = Buffer.concat([
    salt, // 16 bytes
    recordSize, // 4 bytes
    Buffer.from([65]), // key length
    localPublicKey // 65 bytes
  ]);

  return Buffer.concat([header, encrypted]);
}

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const infoHmac = crypto.createHmac('sha256', prk);
  infoHmac.update(Buffer.concat([info, Buffer.from([1])]));
  return infoHmac.digest().subarray(0, length);
}

async function sendPushNotification(subscription, payload, vapidPublic, vapidPrivate) {
  const jwt = createVapidJwt(subscription.endpoint, vapidPublic, vapidPrivate);
  const body = encryptPayload(subscription, payload);
  const pubKey = bufferToUrlBase64(urlBase64ToBuffer(vapidPublic));

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${pubKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400'
    },
    body
  });

  const responseText = await response.text();
  if (!response.ok) {
    const err = new Error(`Push failed: ${response.status} ${responseText}`);
    err.statusCode = response.status;
    throw err;
  }
  return { status: response.status, body: responseText };
}

// === Main handler ===
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

  // === SEND RESUMEN ===
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
    function fmt(n) { return n.toLocaleString('es-AR'); }
    var pushBody = `$${fmt(totalHoy)} (${opsHoy} ventas) | ${signo}${diff}% vs ayer | Mejor: ${mejor}`;

    // Send push to all subscribers
    let sent = 0, failed = 0;
    const payload = JSON.stringify({
      title: 'Resumen Tussy ' + fechaFmt,
      body: pushBody,
      url: '/'
    });

    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const toRemove = [];

    const pushResults = [];
    for (const sub of subs) {
      try {
        const result = await sendPushNotification(sub.subscription, payload, vapidPublic, vapidPrivate);
        sent++;
        pushResults.push({ user: sub.usuario, status: result.status });
      } catch (err) {
        failed++;
        pushResults.push({ user: sub.usuario, error: err.message });
        if (err.statusCode === 410 || err.statusCode === 404) {
          toRemove.push(sub.subscription.endpoint);
        }
      }
    }
    for (const ep of toRemove) {
      const idx = subs.findIndex(s => s.subscription.endpoint === ep);
      if (idx !== -1) subs.splice(idx, 1);
    }

    res.status(200).json({
      ok: true, sent, failed, totalSubs: subs.length, pushResults,
      fecha: hoy, fechaFmt, totalHoy, totalAyer, opsHoy, opsAyer,
      diff: `${signo}${diff}%`, mejor, mejorTotal, locales
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
