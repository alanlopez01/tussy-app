const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Simple auth check
  const { secret } = req.body;
  if (secret !== process.env.PUSH_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  webpush.setVapidDetails('mailto:alan@tussy.com.ar', VAPID_PUBLIC, VAPID_PRIVATE);

  // Get subscriptions
  const subs = global.__pushSubs || [];
  if (subs.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, message: "No subscriptions" });
  }

  const { title, body, url } = req.body;
  const payload = JSON.stringify({ title, body, url });

  let sent = 0;
  let failed = 0;
  const toRemove = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        toRemove.push(sub.subscription.endpoint);
      }
    }
  }

  // Clean expired subscriptions
  for (const ep of toRemove) {
    const idx = subs.findIndex(s => s.subscription.endpoint === ep);
    if (idx !== -1) subs.splice(idx, 1);
  }

  res.status(200).json({ ok: true, sent, failed, total: subs.length });
};
