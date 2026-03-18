const https = require("https");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const SHEET_ID = process.env.TELAS_SHEET_ID;
  const SCRIPT_URL = process.env.APPS_SCRIPT_URL;

  if (req.method === "GET") {
    const { tab } = req.query;

    if (tab === "stock-tela") {
      try {
        const url = `${SCRIPT_URL}?action=getStockTelas&params={}`;
        const r = await fetch(url, { redirect: "follow" });
        const data = await r.json();
        return res.status(200).json({ telas: data.telas || [] });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (tab === "cortes-espera" || tab === "cortes-taller") {
      try {
        const estado = tab === "cortes-espera" ? "Esperando Taller" : "En Taller";
        const url = `${SCRIPT_URL}?action=getCortes&params=${encodeURIComponent(JSON.stringify({ estado }))}`;
        const r = await fetch(url, { redirect: "follow" });
        const data = await r.json();
        return res.status(200).json({ cortes: data.cortes || [] });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (tab === "historial") {
      try {
        const url = `${SCRIPT_URL}?action=getHistorialTelas&params={}`;
        const r = await fetch(url, { redirect: "follow" });
        const data = await r.json();
        return res.status(200).json({ movimientos: data.movimientos || [] });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: "Tab no reconocido" });
  }

  if (req.method === "POST") {
    const body = req.body;
    const { accion } = body;

    if (accion === "nuevo-corte") {
      try {
        const url = `${SCRIPT_URL}?action=guardarCorte&params=${encodeURIComponent(JSON.stringify(body))}`;
        const r = await fetch(url, { redirect: "follow" });
        const data = await r.json();
        return res.status(200).json(data);
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (accion === "ingreso-tela") {
      try {
        const url = `${SCRIPT_URL}?action=guardarIngresoTela&params=${encodeURIComponent(JSON.stringify(body))}`;
        const r = await fetch(url, { redirect: "follow" });
        const data = await r.json();
        return res.status(200).json(data);
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: "Acción no reconocida" });
  }

  res.status(405).json({ error: "Método no permitido" });
}
