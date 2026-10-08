// Mercado Libre — conexión OAuth y estado de la cuenta.
// GET ?action=estado    → si estamos conectados y hasta cuándo (requiere sesión)
// GET ?action=auth      → redirige a MELI para autorizar (requiere sesión admin)
// GET ?action=callback  → vuelve MELI con ?code=&state=  (público: lo llama el navegador)
//
// El access_token dura 6 h; el refresh, 6 meses. `tokenValido()` renueva solo
// cuando faltan menos de 10 minutos, así ninguna otra parte del sistema se tiene
// que acordar de refrescar.
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requerirSesion } = require("../lib/auth");

const sql = neon(process.env.DATABASE_URL);
const API = "https://api.mercadolibre.com";
const AUTH = "https://auth.mercadolibre.com.ar/authorization";
const REDIRECT = "https://tussy-app.vercel.app/api/meli/callback";

const configurada = () => !!(process.env.MELI_CLIENT_ID && process.env.MELI_CLIENT_SECRET);

async function cuenta() {
  const [c] = await sql`SELECT * FROM meli_cuenta WHERE id = 1`;
  return c || null;
}

// Canjea un code o un refresh_token por tokens nuevos y los guarda.
async function guardarTokens(params) {
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.MELI_CLIENT_ID,
      client_secret: process.env.MELI_CLIENT_SECRET,
      ...params,
    }),
  });
  const j = await r.json();
  if (!r.ok || j.error) {
    throw new Error(`MELI oauth: ${j.message || j.error_description || j.error || r.status}`);
  }
  // expires_in viene en segundos (6 h). Guardamos el instante exacto de vencimiento.
  const expira = new Date(Date.now() + Number(j.expires_in || 21600) * 1000);
  await sql`UPDATE meli_cuenta SET
    user_id = ${j.user_id || null},
    access_token = ${j.access_token},
    refresh_token = ${j.refresh_token || null},
    expira_en = ${expira.toISOString()},
    scopes = ${j.scope || null},
    actualizado_en = now()
    WHERE id = 1`;
  return j;
}

// Devuelve un access_token usable, refrescando si está por vencer.
// Es la única puerta: ningún otro módulo debería leer access_token directo.
async function tokenValido() {
  const c = await cuenta();
  if (!c || !c.refresh_token) throw new Error("Mercado Libre no está conectado todavía");
  const margen = 10 * 60 * 1000;
  if (c.access_token && c.expira_en && new Date(c.expira_en).getTime() - Date.now() > margen) {
    return c.access_token;
  }
  const j = await guardarTokens({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  return j.access_token;
}

// Renueva el token si está por vencer. Lo llama un cron cada 4 h para que la
// conexión no se caiga sola: el refresh dura 6 meses, pero si nadie lo usa
// durante ese tiempo hay que volver a autorizar a mano desde el navegador.
// Es público porque lo invoca el cron de Vercel, que no manda sesión. No
// devuelve nada sensible y `tokenValido` no hace nada si al token le queda
// más de 10 minutos, así que llamarlo de más es inofensivo.
async function refrescar(req, res) {
  try {
    await tokenValido();
    const c = await cuenta();
    res.json({ ok: true, vence_en_min: Math.round((new Date(c.expira_en) - Date.now()) / 60000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function estado(req, res) {
  if (!requerirSesion(req, res)) return;
  if (!configurada()) return res.json({ conectada: false, motivo: "faltan MELI_CLIENT_ID / MELI_CLIENT_SECRET" });
  const c = await cuenta();
  if (!c || !c.refresh_token) return res.json({ conectada: false, motivo: "falta autorizar la cuenta" });
  const vence = c.expira_en ? new Date(c.expira_en) : null;
  res.json({
    conectada: true,
    user_id: c.user_id,
    nickname: c.nickname,
    scopes: c.scopes,
    access_token_vence_en_min: vence ? Math.round((vence - Date.now()) / 60000) : null,
    actualizado_en: c.actualizado_en,
  });
}

// Manda al usuario a MELI a autorizar. El `state` es de un solo uso y vive 10 min.
async function auth(req, res) {
  const sesion = requerirSesion(req, res);
  if (!sesion) return;
  if (sesion.rol !== "admin") return res.status(403).json({ error: "solo admin" });
  if (!configurada()) return res.status(500).json({ error: "faltan las credenciales de MELI en el entorno" });

  const state = crypto.randomBytes(24).toString("hex");
  await sql`UPDATE meli_cuenta SET state_pendiente = ${state},
    state_expira = now() + interval '10 minutes' WHERE id = 1`;

  const url = `${AUTH}?` + new URLSearchParams({
    response_type: "code",
    client_id: process.env.MELI_CLIENT_ID,
    redirect_uri: REDIRECT,
    state,
  });
  res.json({ url });
}

// MELI redirige acá después de que el vendedor acepta. Es público, así que lo
// primero es verificar el state; recién después tocamos nada.
async function callback(req, res) {
  const pagina = (titulo, detalle, ok) => res.setHeader("Content-Type", "text/html; charset=utf-8").status(ok ? 200 : 400).end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${titulo}</title>
     <body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6">
     <h1 style="font-size:1.4rem">${ok ? "✓" : "✗"} ${titulo}</h1><p>${detalle}</p>
     ${ok ? '<p><a href="/">Volver a la app</a></p>' : ""}</body>`);

  const { code, state, error, error_description } = req.query;
  if (error) return pagina("Mercado Libre rechazó la autorización", error_description || error, false);
  if (!code || !state) return pagina("Faltan datos", "La respuesta de Mercado Libre vino incompleta.", false);

  const c = await cuenta();
  if (!c?.state_pendiente || c.state_pendiente !== state) {
    return pagina("Pedido inválido", "El código de seguridad no coincide. Volvé a empezar la conexión desde la app.", false);
  }
  if (!c.state_expira || new Date(c.state_expira) < new Date()) {
    return pagina("El pedido venció", "Pasaron más de 10 minutos. Volvé a empezar la conexión desde la app.", false);
  }
  // De un solo uso: lo quemamos antes de canjear el code.
  await sql`UPDATE meli_cuenta SET state_pendiente = NULL, state_expira = NULL WHERE id = 1`;

  try {
    const j = await guardarTokens({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    let nick = null;
    try {
      const u = await (await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
      nick = u.nickname || null;
      await sql`UPDATE meli_cuenta SET nickname = ${nick} WHERE id = 1`;
    } catch { /* el nickname es cosmético: si falla, la conexión ya quedó hecha */ }
    return pagina("Mercado Libre conectado",
      `Quedó vinculada la cuenta <b>${nick || j.user_id}</b>. Ya podés cerrar esta pestaña.`, true);
  } catch (e) {
    return pagina("No se pudo completar la conexión", e.message, false);
  }
}

module.exports = async (req, res) => {
  const action = req.query.action || "estado";
  try {
    if (action === "estado") return await estado(req, res);
    if (action === "auth") return await auth(req, res);
    if (action === "callback") return await callback(req, res);
    if (action === "refrescar") return await refrescar(req, res);
    res.status(400).json({ error: `acción desconocida: ${action}` });
  } catch (e) {
    console.error("meli:", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};
module.exports.tokenValido = tokenValido;
