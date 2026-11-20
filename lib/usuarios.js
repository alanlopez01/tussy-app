// Los usuarios en un solo lugar: el login los valida y cada endpoint pregunta
// acá qué puede ver quién. Las contraseñas siguen en variables de entorno.
//
// `ve` = pantallas del admin que este usuario además puede MIRAR. Mirar no es
// tocar: escribir sigue siendo solo del admin y lo valida cada endpoint aparte.
const USUARIOS = {
  alan: { env: "PASS_ALAN", rol: "admin", nombre: "Alan",     ve: [] },
  fede: { env: "PASS_FEDE", rol: "socio", nombre: "Federico", ve: ["cajas"] },
  nico: { env: "PASS_NICO", rol: "socio", nombre: "Nicolas",  ve: [] },
};

// Valida usuario+contraseña. Devuelve la sesión a emitir, o null.
function autenticar(usuario, password) {
  const u = String(usuario || "").toLowerCase().trim();
  const p = String(password || "").trim();
  const reg = USUARIOS[u];
  if (!reg || !u || !p) return null;
  const esperada = process.env[reg.env];
  if (!esperada || esperada !== p) return null;
  return { usuario: u, rol: reg.rol, nombre: reg.nombre, ve: reg.ve };
}

// El admin ve todo. Un socio, solo lo que tenga en su lista.
function puedeVer(sesion, pantalla) {
  if (!sesion) return false;
  if (sesion.rol === "admin") return true;
  return (USUARIOS[sesion.usuario]?.ve || []).includes(pantalla);
}

// Lo que el token no lleva: la lista `ve` se busca por usuario en cada pedido,
// así cambiarla acá vale al instante sin que nadie tenga que volver a entrar.
function pantallas(sesion) {
  if (!sesion) return [];
  return USUARIOS[sesion.usuario]?.ve || [];
}

module.exports = { autenticar, puedeVer, pantallas };
