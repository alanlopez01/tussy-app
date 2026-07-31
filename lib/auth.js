// Tokens de sesión firmados (HMAC). Sin estado en el server: el token lleva
// usuario y rol, y la firma garantiza que lo emitió este backend.
// Rotar AUTH_SECRET invalida todas las sesiones al instante.
const crypto = require("crypto");

function secreto() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET no configurada");
  return s;
}

function firmar(payload) {
  return crypto.createHmac("sha256", secreto()).update(payload).digest("base64url");
}

// → "base64url(usuario|rol|nombre).firma"
function emitirToken({ usuario, rol, nombre }) {
  const payload = Buffer.from(`${usuario}|${rol}|${nombre}`, "utf8").toString("base64url");
  return `${payload}.${firmar(payload)}`;
}

// → { usuario, rol, nombre } o null si el token es inválido
function verificarToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, firma] = token.split(".");
  if (!payload || !firma) return null;
  const esperada = firmar(payload);
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [usuario, rol, nombre] = Buffer.from(payload, "base64url").toString("utf8").split("|");
  if (!usuario || !rol) return null;
  return { usuario, rol, nombre };
}

// Guard para handlers: devuelve la sesión o corta con 401
function requerirSesion(req, res) {
  const sesion = verificarToken(req.headers["x-tussy-auth"]);
  if (!sesion) {
    res.status(401).json({ error: "sesión inválida o vencida" });
    return null;
  }
  return sesion;
}

module.exports = { emitirToken, verificarToken, requerirSesion };
