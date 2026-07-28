// Proxy para Apps Script de Operaciones
// Soporta GET (query params) y POST (body raw forwarded a Apps Script)
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!process.env.APPS_SCRIPT_URL_OPERACIONES) {
    return res.status(503).json({ error: "APPS_SCRIPT_URL_OPERACIONES no configurada en Vercel" });
  }

  const appsUrl = process.env.APPS_SCRIPT_URL_OPERACIONES;

  try {
    if (req.method === "POST") {
      // Leer body crudo y reenviar a Apps Script como POST
      // req.body puede venir como objeto (si JSON) o buffer
      let bodyToSend;
      let contentType = req.headers["content-type"] || "";

      if (typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) {
        // Vercel parsea JSON automáticamente, reconstruirlo como form-urlencoded
        // Si viene como JSON con {action, params}, mandarlo como form-urlencoded
        const params = new URLSearchParams();
        for (const k in req.body) {
          const v = req.body[k];
          params.append(k, typeof v === "string" ? v : JSON.stringify(v));
        }
        bodyToSend = params.toString();
        contentType = "application/x-www-form-urlencoded";
      } else if (typeof req.body === "string") {
        bodyToSend = req.body;
      } else {
        // Raw body (buffer o multipart/form-data)
        bodyToSend = req.body;
      }

      const r = await fetch(appsUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: bodyToSend,
        redirect: "follow"
      });
      const text = await r.text();
      try { return res.status(200).json(JSON.parse(text)); }
      catch { return res.status(200).send(text); }
    }

    // GET (comportamiento original)
    const { action, params } = req.query;
    const url = appsUrl + "?action=" + action + "&params=" + encodeURIComponent(params || "{}");
    const response = await fetch(url, { redirect: "follow" });
    const text = await response.text();
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Configurar body parsing para permitir raw bodies grandes (fotos hasta ~10MB)
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "12mb"
    }
  }
};
