module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const SCRIPT_URL = process.env.TELAS_SCRIPT_URL;
  if (!SCRIPT_URL) return res.status(500).json({ error: "TELAS_SCRIPT_URL no configurada" });

  if (req.method === "GET") {
    const { tab, estado, taller, marca, desde, hasta, telaId } = req.query;
    try {
      let action, params = {};
      if (tab === "stock-tela")       { action = "getStockTelas"; params = {}; }
      else if (tab === "cortes")      { action = "getCortes"; params = { estado: estado||"", taller: taller||"", marca: marca||"" }; }
      else if (tab === "talleres")    { action = "getTalleres"; }
      else if (tab === "estadisticas"){ action = "getEstadisticas"; params = { desde: desde||"", hasta: hasta||"" }; }
      else if (tab === "historial")   { action = "getHistorial"; }
      else if (tab === "peticiones")  { action = "getPeticiones"; }
      else if (tab === "numeros")     { action = "getNumeroCortes"; }
      else if (tab === "detalle-tela"){ action = "getMovimientosTela"; params = { telaId: telaId||"" }; }
      else return res.status(400).json({ error: "Tab no reconocido: " + tab });

      const url = SCRIPT_URL + "?action=" + action + "&params=" + encodeURIComponent(JSON.stringify(params));
      const r = await fetch(url, { redirect: "follow" });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const body = req.body;
      const r = await fetch(SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Metodo no permitido" });
}
