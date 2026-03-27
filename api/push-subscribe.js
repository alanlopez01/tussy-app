// Store subscriptions in memory (resets on cold start)
// For production, use a database. This works for testing.
const subs = global.__pushSubs || (global.__pushSubs = []);

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "POST") {
    const { subscription, usuario } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription required" });
    }
    // Remove existing for same endpoint
    const idx = subs.findIndex(s => s.subscription.endpoint === subscription.endpoint);
    if (idx !== -1) subs.splice(idx, 1);
    subs.push({ subscription, usuario: usuario || "unknown", ts: Date.now() });
    return res.status(200).json({ ok: true, total: subs.length });
  }

  if (req.method === "GET") {
    return res.status(200).json({ subscriptions: subs });
  }

  if (req.method === "DELETE") {
    const { endpoint } = req.body || {};
    const idx = subs.findIndex(s => s.subscription.endpoint === endpoint);
    if (idx !== -1) subs.splice(idx, 1);
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: "method not allowed" });
};
