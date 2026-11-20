const { emitirToken, verificarToken } = require("../lib/auth");
const { autenticar, pantallas } = require("../lib/usuarios");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tussy-Auth");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // ?action=sesion → quién soy, según el token. La app lo pide al abrir para
  // refrescar lo que puede ver: si cambian los permisos, valen en el próximo
  // F5 y nadie tiene que volver a loguearse.
  if (req.query.action === "sesion") {
    const s = verificarToken(req.headers["x-tussy-auth"]);
    if (!s) return res.status(401).json({ ok: false, error: "sesión inválida o vencida" });
    return res.status(200).json({ ok: true, usuario: s.usuario, rol: s.rol, nombre: s.nombre, ve: pantallas(s) });
  }

  // Las credenciales viajan por POST: en la URL quedarían en logs de acceso.
  const { usuario, password } = req.method === "POST" ? (req.body || {}) : req.query;

  if (!usuario || !password) return res.status(400).json({ ok: false, error: "Completá usuario y contraseña" });

  const user = autenticar(usuario, password);
  if (!user) return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos" });

  return res.status(200).json({
    ok: true,
    usuario: user.usuario,
    rol: user.rol,
    nombre: user.nombre,
    ve: user.ve,
    token: emitirToken({ usuario: user.usuario, rol: user.rol, nombre: user.nombre }),
  });
};
