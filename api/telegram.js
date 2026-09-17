// Bot de Telegram — consulta y operación del negocio desde el celular.
//
// Seguridad: solo responde al chat de Alan (TELEGRAM_CHAT_ID) y solo acepta
// webhooks que traigan el secreto acordado en setWebhook. Cualquier otra cosa
// se descarta en silencio con 200 (para que Telegram no reintente).
//
// Las acciones que tocan plata (pausar una campaña, cambiar un presupuesto)
// nunca se ejecutan de una: se dejan pendientes y esperan un "dale" explícito.
const { neon } = require("@neondatabase/serverless");
const { waitUntil } = require("@vercel/functions");
const { generarAlertas } = require("../lib/alertas");
const { responderConIA, iaConfigurada } = require("../lib/agente");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_AUTORIZADO = process.env.TELEGRAM_CHAT_ID;
const ACT = "act_209307700817328";

const fmt = n => "$" + Math.round(Number(n)).toLocaleString("es-AR");
const fmtCorto = n => {
  const v = Math.round(Number(n));
  return v >= 1e6 ? "$" + (v / 1e6).toFixed(1).replace(".", ",") + "M"
       : v >= 1000 ? "$" + Math.round(v / 1000) + "k" : "$" + v;
};
const hoyAR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const diasAtras = n => new Date(Date.now() - 3 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

async function enviar(texto) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_AUTORIZADO, text: texto, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => {});
}

// ── Meta ──
async function metaGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`https://graph.facebook.com/v23.0/${path}${sep}access_token=${process.env.META_TOKEN}`,
    { signal: AbortSignal.timeout(25000) }).then(r => r.json());
}
async function metaPost(id, body) {
  return fetch(`https://graph.facebook.com/v23.0/${id}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, access_token: process.env.META_TOKEN }),
  }).then(r => r.json());
}

async function campanasConMetricas(dias = 3) {
  const rango = encodeURIComponent(JSON.stringify({ since: diasAtras(dias), until: diasAtras(1) }));
  const j = await metaGet(`${ACT}/campaigns?fields=name,effective_status,daily_budget,` +
    `adsets{id,daily_budget,status},insights.time_range(${rango}){spend,actions,action_values}&limit=100`);
  if (j.error || !j.data) return [];
  return j.data.map(c => {
    const ins = c.insights?.data?.[0];
    const gasto = Number(ins?.spend || 0);
    const valor = Number(ins?.action_values?.find(a => a.action_type === "purchase")?.value || 0);
    let presupuesto = c.daily_budget ? Number(c.daily_budget) / 100 : 0;
    let adsetId = null;
    if (!presupuesto && c.adsets?.data?.length) {
      const a = c.adsets.data.find(x => x.status === "ACTIVE") || c.adsets.data[0];
      if (a) { presupuesto = Number(a.daily_budget || 0) / 100; adsetId = a.id; }
    }
    return {
      id: c.id, nombre: c.name, estado: c.effective_status, presupuesto, adsetId,
      gasto, valor, roas: gasto ? valor / gasto : 0,
      compras: Number(ins?.actions?.find(a => a.action_type === "purchase")?.value || 0),
    };
  });
}

// Busca una campaña por texto libre ("tails", "cv kayne"). Devuelve
// { campana } si hay una sola, o { opciones } si el texto es ambiguo.
function buscarCampana(campanas, texto) {
  const q = String(texto || "").trim().toUpperCase();
  if (!q) return { opciones: [] };
  const matches = campanas.filter(c => c.nombre.toUpperCase().includes(q));
  if (matches.length === 1) return { campana: matches[0] };
  const exacta = matches.find(c => c.nombre.toUpperCase() === q);
  if (exacta) return { campana: exacta };
  return { opciones: matches };
}

// ── Acciones pendientes de confirmación ──
async function guardarPendiente(sql, accion) {
  await sql`DELETE FROM telegram_pendiente`;
  await sql`INSERT INTO telegram_pendiente (accion) VALUES (${JSON.stringify(accion)})`;
}
async function leerPendiente(sql) {
  const [f] = await sql`SELECT accion, creado_en FROM telegram_pendiente
    WHERE creado_en > now() - interval '10 minutes' ORDER BY creado_en DESC LIMIT 1`;
  return f ? f.accion : null;
}
const limpiarPendiente = sql => sql`DELETE FROM telegram_pendiente`;

// ── Comandos ──
async function cmdVentas(sql, dia, etiqueta) {
  const filas = await sql`
    SELECT local, ROUND(SUM(total))::bigint total, SUM(cantidad)::int u
    FROM ventas WHERE fecha = ${dia} AND total > 0
      AND producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE')
    GROUP BY local ORDER BY total DESC`;
  if (!filas.length) return `Sin ventas registradas ${etiqueta}.`;
  const total = filas.reduce((a, f) => a + Number(f.total), 0);
  const unidades = filas.reduce((a, f) => a + f.u, 0);
  const detalle = filas.map(f => `· ${f.local}: <b>${fmtCorto(f.total)}</b> (${f.u}u)`).join("\n");
  return `<b>Ventas ${etiqueta} — ${fmt(total)}</b>\n${unidades} unidades\n\n${detalle}`;
}

async function cmdPauta() {
  const campanas = (await campanasConMetricas(3)).filter(c => c.estado === "ACTIVE" && c.gasto > 0);
  if (!campanas.length) return "No pude traer las métricas de Meta.";
  campanas.sort((a, b) => b.gasto - a.gasto);
  const gasto = campanas.reduce((a, c) => a + c.gasto, 0);
  const valor = campanas.reduce((a, c) => a + c.valor, 0);
  const lineas = campanas.map(c => {
    const señal = c.roas >= 6 ? "🟢" : c.roas >= 3 ? "🟡" : "🔴";
    return `${señal} <b>${c.nombre}</b>\n   ${c.roas.toFixed(1)}x · ${fmtCorto(c.gasto)} gastado · ${c.compras} ventas`;
  }).join("\n");
  return `<b>Pauta · últimos 3 días</b>\nROAS general ${(valor / gasto).toFixed(1)}x — ${fmtCorto(gasto)} → ${fmtCorto(valor)}\n\n${lineas}`;
}

async function cmdAlertas(sql) {
  const r = await generarAlertas(sql);
  if (!r.alertas.length) return "✓ Todo en orden, nada para revisar.";
  const bloques = r.alertas.slice(0, 5).map(a => {
    const icono = a.severidad === "alta" ? "🔴" : a.severidad === "media" ? "🟡" : "⚪";
    const items = a.items.slice(0, 4).map(i => `   · ${i.texto}`).join("\n");
    const resto = a.items.length > 4 ? `\n   … y ${a.items.length - 4} más` : "";
    return `${icono} <b>${a.titulo}</b>\n${items}${resto}`;
  }).join("\n\n");
  return `<b>Alertas</b>\n\n${bloques}`;
}

async function cmdPausar(sql, arg) {
  if (!arg) return "Decime qué pausar. Ejemplo: <code>/pausar tails</code>";
  const campanas = await campanasConMetricas(3);
  const { campana, opciones } = buscarCampana(campanas, arg);
  if (!campana) {
    if (!opciones.length) return `No encontré ninguna campaña con "${arg}".`;
    return `¿Cuál de estas?\n${opciones.map(o => `· ${o.nombre}`).join("\n")}`;
  }
  if (campana.estado !== "ACTIVE") return `<b>${campana.nombre}</b> ya está pausada.`;
  await guardarPendiente(sql, { tipo: "pausar", id: campana.id, nombre: campana.nombre });
  return `¿Pauso <b>${campana.nombre}</b>?\n${fmtCorto(campana.presupuesto)}/día · ROAS ${campana.roas.toFixed(1)}x en 3 días\n\nRespondé <b>dale</b> para confirmar.`;
}

async function cmdPresupuesto(sql, arg) {
  const m = String(arg || "").match(/^(.*?)\s+([\d.]+)\s*k?$/i);
  if (!m) return "Formato: <code>/presupuesto kayne 80</code> (en miles por día).";
  const [, texto, montoRaw] = m;
  const miles = Number(montoRaw.replace(/\./g, ""));
  if (!Number.isFinite(miles) || miles <= 0) return "El monto no se entiende.";
  const campanas = await campanasConMetricas(3);
  const { campana, opciones } = buscarCampana(campanas, texto);
  if (!campana) {
    if (!opciones.length) return `No encontré ninguna campaña con "${texto}".`;
    return `¿Cuál de estas?\n${opciones.map(o => `· ${o.nombre}`).join("\n")}`;
  }
  const nuevo = miles * 1000;
  const actual = campana.presupuesto;
  if (actual && nuevo > actual * 2) {
    return `Ese cambio es muy grande (${fmtCorto(actual)} → ${fmtCorto(nuevo)}, más del doble).\nSubilo por partes o hacelo desde el panel.`;
  }
  await guardarPendiente(sql, {
    tipo: "presupuesto", id: campana.adsetId || campana.id, nivel: campana.adsetId ? "conjunto" : "campaña",
    nombre: campana.nombre, monto: nuevo,
  });
  return `¿Cambio el presupuesto de <b>${campana.nombre}</b>?\n${fmtCorto(actual)} → <b>${fmtCorto(nuevo)}</b> por día\n\nRespondé <b>dale</b> para confirmar.`;
}

async function ejecutarPendiente(sql, accion) {
  if (accion.tipo === "pausar") {
    const r = await metaPost(accion.id, { status: "PAUSED" });
    await limpiarPendiente(sql);
    return r.success ? `✓ <b>${accion.nombre}</b> pausada.` : `No pude pausarla: ${r.error?.message || "error"}`;
  }
  if (accion.tipo === "activar") {
    const r = await metaPost(accion.id, { status: "ACTIVE" });
    await limpiarPendiente(sql);
    return r.success ? `✓ <b>${accion.nombre}</b> activada.` : `No pude activarla: ${r.error?.message || "error"}`;
  }
  if (accion.tipo === "presupuesto") {
    const r = await metaPost(accion.id, { daily_budget: String(Math.round(accion.monto * 100)) });
    await limpiarPendiente(sql);
    return r.success ? `✓ <b>${accion.nombre}</b> quedó en ${fmtCorto(accion.monto)}/día.` : `No pude cambiarlo: ${r.error?.message || "error"}`;
  }
  await limpiarPendiente(sql);
  return "No sé qué hacer con eso.";
}

const AYUDA = `<b>Qué puedo hacer</b>

<code>/hoy</code> — ventas de hoy por local
<code>/ayer</code> — ventas de ayer
<code>/pauta</code> — cómo vienen las campañas
<code>/alertas</code> — qué hay para revisar

<code>/pausar tails</code> — pausa una campaña
<code>/presupuesto kayne 80</code> — cambia el presupuesto diario (en miles)

Las dos últimas te piden confirmación antes de tocar nada: respondé <b>dale</b>.

<b>O escribime de una</b> — sin comandos:
<i>"¿cuánto stock de harly queda en abasto?"</i>
<i>"¿cómo viene el mes contra agosto?"</i>
<i>"¿qué campaña está rindiendo peor?"</i>

<code>/reset</code> — olvidar la charla anterior`;

async function responder(sql, texto) {
  const t = String(texto || "").trim();
  const bajo = t.toLowerCase();

  // Confirmación de una acción pendiente
  if (/^(dale|si|sí|ok|confirmo|confirmado|hacelo|listo)$/i.test(bajo)) {
    const pendiente = await leerPendiente(sql);
    if (!pendiente) return "No tengo nada pendiente para confirmar.";
    return ejecutarPendiente(sql, pendiente);
  }
  if (/^(no|cancela|cancelar|dejalo)$/i.test(bajo)) {
    await limpiarPendiente(sql);
    return "Listo, no toco nada.";
  }

  const [cmd, ...resto] = t.split(/\s+/);
  const arg = resto.join(" ");
  switch (cmd.toLowerCase().replace(/@.*$/, "")) {
    case "/hoy": return cmdVentas(sql, hoyAR(), "de hoy");
    case "/ayer": return cmdVentas(sql, diasAtras(1), "de ayer");
    case "/pauta": return cmdPauta();
    case "/alertas": return cmdAlertas(sql);
    case "/pausar": return cmdPausar(sql, arg);
    case "/presupuesto": return cmdPresupuesto(sql, arg);
    case "/start":
    case "/ayuda":
    case "/help": return AYUDA;
    case "/reset":
      await sql`DELETE FROM telegram_historial`;
      return "Listo, arrancamos de cero.";
  }

  // No es un comando: va al analista. Si no hay API key configurada, se avisa.
  if (!iaConfigurada()) {
    return `No entendí "${t}".\n\n${AYUDA}`;
  }
  const historial = await leerHistorial(sql);
  const r = await responderConIA(sql, t, historial);
  if (r.pendiente) await guardarPendiente(sql, r.pendiente);
  if (r.messages) await guardarHistorial(sql, r.messages);
  return r.texto;
}

// Historial de la charla: da contexto entre mensajes ("¿y en Abasto?").
// Se corta solo a la media hora de silencio para no arrastrar contexto viejo.
async function leerHistorial(sql) {
  const [f] = await sql`SELECT mensajes FROM telegram_historial
    WHERE actualizado_en > now() - interval '30 minutes' ORDER BY id DESC LIMIT 1`;
  return f?.mensajes || [];
}
async function guardarHistorial(sql, messages) {
  // Solo los últimos turnos, y recortando los resultados de herramientas
  // (son grandes y ya no aportan una vez respondida la pregunta).
  const limpios = messages
    .filter(m => typeof m.content === "string" || !m.content.some?.(b => b.type === "tool_result" || b.type === "tool_use"))
    .slice(-8);
  await sql`DELETE FROM telegram_historial`;
  await sql`INSERT INTO telegram_historial (mensajes) VALUES (${JSON.stringify(limpios)})`;
}

module.exports = async function handler(req, res) {
  // Siempre 200: si Telegram recibe otra cosa, reintenta en loop.
  if (req.method !== "POST") return res.status(200).json({ ok: true });
  if (process.env.TELEGRAM_WEBHOOK_SECRET &&
      req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(200).json({ ok: true });
  }
  const msg = req.body?.message || req.body?.edited_message;
  if (!msg?.text) return res.status(200).json({ ok: true });
  if (String(msg.chat?.id) !== String(CHAT_AUTORIZADO)) return res.status(200).json({ ok: true });

  // El trabajo pesado va después de responderle a Telegram.
  waitUntil((async () => {
    const sql = neon(process.env.DATABASE_URL);
    try {
      await enviar(await responder(sql, msg.text));
    } catch (e) {
      await enviar(`Se me rompió algo: ${e.message}`);
    }
  })());
  return res.status(200).json({ ok: true });
};
