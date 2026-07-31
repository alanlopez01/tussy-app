const { emitirToken } = require("../lib/auth");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Las credenciales viajan por POST: en la URL quedarían en logs de acceso.
  const { usuario, password } = req.method === "POST" ? (req.body || {}) : req.query;

  const USUARIOS = {
    alan: { pass: process.env.PASS_ALAN, rol: "admin", nombre: "Alan",     local: null },
    fede: { pass: process.env.PASS_FEDE, rol: "socio", nombre: "Federico", local: null },
    nico: { pass: process.env.PASS_NICO, rol: "socio", nombre: "Nicolas",  local: null },
  };

  const u = (usuario || "").toLowerCase().trim();
  const p = (password || "").trim();

  if (!u || !p) return res.status(400).json({ ok: false, error: "Completá usuario y contraseña" });

  const user = USUARIOS[u];
  if (!user || !user.pass || user.pass !== p) {
    return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos" });
  }

  return res.status(200).json({
    ok: true,
    rol: user.rol,
    nombre: user.nombre,
    token: emitirToken({ usuario: u, rol: user.rol, nombre: user.nombre }),
  });
};
