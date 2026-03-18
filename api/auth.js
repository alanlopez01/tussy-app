module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { usuario, password } = req.query;

  const USUARIOS = {
    // Admin
    alan:      { pass: process.env.PASS_ALAN,      rol: "admin",     nombre: "Alan" },
    // Socios
    fede:      { pass: process.env.PASS_FEDE,      rol: "socio",     nombre: "Federico" },
    nico:      { pass: process.env.PASS_NICO,      rol: "socio",     nombre: "Nicolas" },
    // Encargados
    benjamin:  { pass: process.env.PASS_BENJAMIN,  rol: "encargado", nombre: "Benjamin" },
    ramiro:    { pass: process.env.PASS_RAMIRO,    rol: "encargado", nombre: "Ramiro" },
    pablo:     { pass: process.env.PASS_PABLO,     rol: "encargado", nombre: "Pablo" },
    noah:      { pass: process.env.PASS_NOAH,      rol: "encargado", nombre: "Noah" },
    sebastian: { pass: process.env.PASS_SEBASTIAN, rol: "encargado", nombre: "Sebastian" },
  };

  const u = (usuario || "").toLowerCase().trim();
  const p = (password || "").trim();

  if (!u || !p) return res.status(400).json({ ok: false, error: "Completá usuario y contraseña" });

  const user = USUARIOS[u];
  if (!user || user.pass !== p) return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos" });

  res.status(200).json({ ok: true, rol: user.rol, nombre: user.nombre });
}
