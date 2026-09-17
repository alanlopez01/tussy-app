// Capa de inteligencia del bot: Claude con herramientas para consultar el negocio.
// Responde preguntas libres ("¿cuánto stock de Harly queda en Abasto?") y propone
// cambios de pauta, que siempre quedan pendientes de confirmación humana.
const Anthropic = require("@anthropic-ai/sdk");
const { generarAlertas } = require("./alertas");

const MODELO = "claude-opus-5";
const ACT = "act_209307700817328";
const LOCALES = ["Palermo", "La Plata", "Tiendanube", "Dot", "Abasto", "Córdoba"];

const hoyAR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const fmt = n => "$" + Math.round(Number(n)).toLocaleString("es-AR");

function sistema() {
  const hoy = hoyAR();
  const dia = new Date(hoy + "T12:00:00Z").toLocaleDateString("es-AR", { weekday: "long" });
  return `Sos el analista del negocio de Alan, dueño de Tussy (marca argentina de streetwear). Le respondés por Telegram.

Hoy es ${dia} ${hoy}.

EL NEGOCIO
· Seis unidades: cinco locales físicos (Palermo, La Plata, Dot, Abasto, Córdoba) y la tienda online (aparece como "Tiendanube"). Córdoba cierra los domingos.
· Vende remeras, buzos, camperas, pantalones, sweaters, jeans y desde agosto bolsos y mochilas. Saca "drops" de productos nuevos seguido; son exclusivos y no se reponen.
· La publicidad es toda en Meta (Instagram/Facebook). Las campañas se llaman "CV <producto>" (una por producto) o "PROS ..." (paraguas con varios anuncios adentro).
· Socios: Federico, Nicolás y Pedro. Alan maneja la operación.

CÓMO ANALIZAR
· Compará siempre contra el mismo día de la semana anterior, no contra ayer: los lunes y los domingos son flojos por naturaleza.
· No saques conclusiones de un anuncio con menos de $50.000 gastados. La muestra es demasiado chica.
· ROAS sano de la cuenta: entre 5 y 9. Abajo de 3 es problema. Frecuencia arriba de 6 es fatiga del creativo.
· Si una campaña se modificó hace menos de 4 días está reaprendiendo: sus números son ruido, decilo en vez de recomendar tocarla otra vez.
· Cuando falte un dato, decilo. Nunca inventes un número.

CÓMO ESCRIBIR
· Español rioplatense, natural, como un socio que sabe del tema. Sin jerga innecesaria.
· Breve: es un chat de celular. Tres o cuatro líneas alcanzan casi siempre. Si te piden un análisis, podés extenderte un poco más.
· Formato Telegram HTML: <b>negrita</b>, <i>itálica</i>, <code>monoespaciado</code>. NUNCA uses markdown (nada de ** o ##) ni tablas.
· Los montos en pesos argentinos con puntos de miles.

CAMBIOS EN LA PAUTA
Si Alan pide pausar una campaña o cambiar un presupuesto, usá proponer_cambio_pauta. Eso NO ejecuta nada: deja la acción esperando que él confirme con un "dale". Explicale en una línea qué va a pasar y por qué conviene (o por qué no, si no estás de acuerdo).`;
}

const HERRAMIENTAS = [
  {
    name: "consultar_ventas",
    description: "Ventas de un período. Devuelve totales y el desglose por local o por producto. Para comparar períodos, llamala una vez por cada uno.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "Fecha inicial YYYY-MM-DD (incluida)" },
        hasta: { type: "string", description: "Fecha final YYYY-MM-DD (incluida)" },
        agrupar_por: { type: "string", enum: ["local", "producto", "dia"], description: "Cómo desglosar. Por defecto local." },
        local: { type: "string", description: `Filtrar por un local: ${LOCALES.join(", ")}` },
        producto: { type: "string", description: "Filtrar por producto (busca coincidencia parcial, ej: 'harly')" },
      },
      required: ["desde", "hasta"],
    },
  },
  {
    name: "consultar_stock",
    description: "Stock actual por producto, talle y color en los locales físicos. La foto se toma cada madrugada.",
    input_schema: {
      type: "object",
      properties: {
        producto: { type: "string", description: "Nombre o parte del nombre, ej: 'harly'" },
        local: { type: "string", description: `Un local: ${LOCALES.filter(l => l !== "Tiendanube").join(", ")}` },
      },
      required: ["producto"],
    },
  },
  {
    name: "consultar_pauta",
    description: "Campañas de Meta con gasto, compras, valor, ROAS y frecuencia de los últimos N días. Opcionalmente el detalle anuncio por anuncio.",
    input_schema: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Cuántos días hacia atrás (por defecto 3)" },
        detalle_anuncios: { type: "boolean", description: "Incluir el desglose por anuncio de cada campaña" },
      },
    },
  },
  {
    name: "analizar_producto",
    description: "Ficha completa de un producto: precio de venta, costo, margen, unidades vendidas, reparto entre locales y online, y si tiene campaña propia.",
    input_schema: {
      type: "object",
      properties: { producto: { type: "string", description: "Nombre o parte del nombre" } },
      required: ["producto"],
    },
  },
  {
    name: "consultar_alertas",
    description: "Revisión automática del negocio: productos sin costo o con costo estimado, márgenes bajos, productos que venden en locales pero no están en la web, y productos sin pauta.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "proponer_cambio_pauta",
    description: "Deja preparado un cambio en una campaña para que Alan lo confirme. No ejecuta nada por sí solo.",
    input_schema: {
      type: "object",
      properties: {
        accion: { type: "string", enum: ["pausar", "activar", "presupuesto"] },
        campana: { type: "string", description: "Nombre o parte del nombre de la campaña" },
        monto_diario: { type: "number", description: "Solo para 'presupuesto': el nuevo monto en pesos por día" },
      },
      required: ["accion", "campana"],
    },
  },
];

// ── Ejecución de herramientas ──
async function metaGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`https://graph.facebook.com/v23.0/${path}${sep}access_token=${process.env.META_TOKEN}`,
    { signal: AbortSignal.timeout(25000) }).then(r => r.json());
}

async function ejecutar(nombre, args, sql, ctx) {
  if (nombre === "consultar_ventas") {
    const { desde, hasta, agrupar_por = "local", local, producto } = args;
    const filas = await sql`
      SELECT
        CASE WHEN ${agrupar_por} = 'local' THEN local
             WHEN ${agrupar_por} = 'producto' THEN producto_norm
             ELSE fecha::text END AS clave,
        ROUND(SUM(total))::bigint total, SUM(cantidad)::int unidades
      FROM ventas
      WHERE fecha BETWEEN ${desde} AND ${hasta} AND total > 0
        AND producto_norm NOT IN ('ENVIO','DESCUENTO','AJUSTE')
        AND (${local || null}::text IS NULL OR local = ${local || null})
        AND (${producto || null}::text IS NULL OR producto_norm ILIKE '%' || ${producto || null} || '%')
      GROUP BY 1 ORDER BY total DESC LIMIT 40`;
    const total = filas.reduce((a, f) => a + Number(f.total), 0);
    return { periodo: `${desde} a ${hasta}`, total, unidades: filas.reduce((a, f) => a + f.unidades, 0),
             desglose: filas.map(f => ({ [agrupar_por]: f.clave, total: Number(f.total), unidades: f.unidades })) };
  }

  if (nombre === "consultar_stock") {
    const { producto, local } = args;
    const filas = await sql`
      SELECT local, producto_norm, talle, color, SUM(cantidad)::int cantidad
      FROM stock
      WHERE fecha = (SELECT MAX(fecha) FROM stock)
        AND producto_norm ILIKE '%' || ${producto} || '%'
        AND (${local || null}::text IS NULL OR local = ${local || null})
      GROUP BY 1,2,3,4 HAVING SUM(cantidad) > 0
      ORDER BY local, producto_norm, talle LIMIT 120`;
    if (!filas.length) return { sin_datos: `No hay stock de "${producto}"${local ? " en " + local : ""} en la última foto.` };
    const porLocal = {};
    for (const f of filas) porLocal[f.local] = (porLocal[f.local] || 0) + f.cantidad;
    return { total: filas.reduce((a, f) => a + f.cantidad, 0), por_local: porLocal,
             detalle: filas.map(f => ({ local: f.local, producto: f.producto_norm, talle: f.talle, color: f.color, cantidad: f.cantidad })) };
  }

  if (nombre === "consultar_pauta") {
    const dias = args.dias || 3;
    const desde = new Date(Date.now() - 3 * 3600 * 1000 - dias * 86400000).toISOString().slice(0, 10);
    const hasta = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    const rango = encodeURIComponent(JSON.stringify({ since: desde, until: hasta }));
    const campos = `name,effective_status,daily_budget,insights.time_range(${rango}){spend,frequency,actions,action_values}`;
    const j = await metaGet(`${ACT}/campaigns?fields=${campos}&limit=100`);
    if (j.error) return { error: j.error.message };
    const resumir = (c) => {
      const i = c.insights?.data?.[0];
      const gasto = Number(i?.spend || 0);
      const valor = Number(i?.action_values?.find(a => a.action_type === "purchase")?.value || 0);
      return {
        campana: c.name, estado: c.effective_status,
        presupuesto_diario: c.daily_budget ? Number(c.daily_budget) / 100 : null,
        gasto: Math.round(gasto), compras: Number(i?.actions?.find(a => a.action_type === "purchase")?.value || 0),
        valor_ventas: Math.round(valor), roas: gasto ? Math.round(valor / gasto * 10) / 10 : 0,
        frecuencia: i?.frequency ? Math.round(Number(i.frequency) * 10) / 10 : null,
      };
    };
    const campanas = j.data.map(resumir).filter(c => c.gasto > 0 || c.estado === "ACTIVE");
    const out = { periodo: `${desde} a ${hasta}`, campanas: campanas.sort((a, b) => b.gasto - a.gasto) };
    if (args.detalle_anuncios) {
      const ads = await metaGet(`${ACT}/ads?fields=name,effective_status,campaign{name},insights.time_range(${rango}){spend,actions,action_values}&limit=200`);
      out.anuncios = (ads.data || []).map(a => {
        const i = a.insights?.data?.[0];
        const gasto = Number(i?.spend || 0);
        if (!gasto) return null;
        const valor = Number(i?.action_values?.find(x => x.action_type === "purchase")?.value || 0);
        return { campana: a.campaign?.name, anuncio: a.name, estado: a.effective_status,
                 gasto: Math.round(gasto), roas: Math.round(valor / gasto * 10) / 10,
                 compras: Number(i?.actions?.find(x => x.action_type === "purchase")?.value || 0) };
      }).filter(Boolean);
    }
    return out;
  }

  if (nombre === "analizar_producto") {
    const q = args.producto;
    const [ventas] = await sql`
      SELECT producto_norm, SUM(cantidad)::int unidades, ROUND(SUM(total))::bigint venta,
             ROUND(SUM(total)/NULLIF(SUM(cantidad),0))::bigint precio_promedio,
             MIN(fecha)::text primera_venta,
             ROUND(100.0*SUM(CASE WHEN local='Tiendanube' THEN cantidad ELSE 0 END)/NULLIF(SUM(cantidad),0))::int pct_online
      FROM ventas WHERE producto_norm ILIKE '%' || ${q} || '%' AND total > 0
        AND fecha >= CURRENT_DATE - 60
      GROUP BY 1 ORDER BY venta DESC LIMIT 1`;
    if (!ventas) return { sin_datos: `No encontré ventas de "${q}" en los últimos 60 días.` };
    const [costo] = await sql`
      SELECT costo::float costo, origen FROM costos_producto
      WHERE producto = ${ventas.producto_norm} ORDER BY vigente_desde DESC LIMIT 1`;
    const [stock] = await sql`
      SELECT SUM(cantidad)::int total FROM stock
      WHERE fecha = (SELECT MAX(fecha) FROM stock) AND producto_norm = ${ventas.producto_norm}`;
    const out = {
      producto: ventas.producto_norm, ultimos_60_dias: true,
      unidades: ventas.unidades, venta_total: Number(ventas.venta),
      precio_promedio: Number(ventas.precio_promedio), primera_venta: ventas.primera_venta,
      pct_online: ventas.pct_online, stock_en_locales: stock?.total || 0,
    };
    if (costo) {
      const neto = Number(ventas.precio_promedio) * (1 - 0.21 / 1.21);
      out.costo = Math.round(costo.costo);
      out.costo_es_estimado = /promedio/.test(costo.origen || "");
      out.margen_unitario = Math.round(neto - costo.costo);
      out.multiplicador = Math.round(Number(ventas.precio_promedio) / costo.costo * 10) / 10;
    }
    const j = await metaGet(`${ACT}/campaigns?fields=name,effective_status&limit=100`);
    const modelo = ventas.producto_norm.split(/\s+/).filter(w => w.length >= 4);
    out.campanas = (j.data || []).filter(c => c.effective_status === "ACTIVE" &&
      modelo.some(w => c.name.toUpperCase().includes(w))).map(c => c.name);
    return out;
  }

  if (nombre === "consultar_alertas") {
    const r = await generarAlertas(sql);
    return { resumen: r.resumen, alertas: r.alertas.map(a => ({
      severidad: a.severidad, titulo: a.titulo, accion: a.accion,
      items: a.items.slice(0, 10).map(i => i.texto) })) };
  }

  if (nombre === "proponer_cambio_pauta") {
    const { accion, campana, monto_diario } = args;
    const j = await metaGet(`${ACT}/campaigns?fields=name,effective_status,daily_budget,adsets{id,daily_budget,status}&limit=100`);
    const matches = (j.data || []).filter(c => c.name.toUpperCase().includes(String(campana).toUpperCase()));
    if (!matches.length) return { error: `No encontré ninguna campaña que contenga "${campana}".` };
    if (matches.length > 1) return { ambiguo: matches.map(c => c.name) };
    const c = matches[0];
    let presupuestoActual = c.daily_budget ? Number(c.daily_budget) / 100 : null;
    let objetivo = c.id, nivel = "campaña";
    if (!presupuestoActual && c.adsets?.data?.length) {
      const a = c.adsets.data.find(x => x.status === "ACTIVE") || c.adsets.data[0];
      if (a) { presupuestoActual = Number(a.daily_budget || 0) / 100; objetivo = a.id; nivel = "conjunto"; }
    }
    if (accion === "presupuesto") {
      if (!monto_diario || monto_diario <= 0) return { error: "Falta el monto diario." };
      if (presupuestoActual && monto_diario > presupuestoActual * 2) {
        return { rechazado: `El cambio es de más del doble (${fmt(presupuestoActual)} → ${fmt(monto_diario)}). Por seguridad no lo propongo: hacelo en dos pasos.` };
      }
    }
    ctx.pendiente = accion === "presupuesto"
      ? { tipo: "presupuesto", id: objetivo, nivel, nombre: c.name, monto: monto_diario }
      : { tipo: accion === "pausar" ? "pausar" : "activar", id: c.id, nombre: c.name };
    return { preparado: true, campana: c.name, accion,
             presupuesto_actual: presupuestoActual, presupuesto_nuevo: monto_diario || null,
             estado_actual: c.effective_status,
             nota: "Queda esperando que Alan confirme con 'dale'. No se ejecutó nada todavía." };
  }

  return { error: `Herramienta desconocida: ${nombre}` };
}

// ── Loop principal ──
// Devuelve { texto, pendiente }. `pendiente` != null cuando el modelo dejó
// preparado un cambio de pauta para confirmar.
async function responderConIA(sql, pregunta, historial = []) {
  const client = new Anthropic();
  const ctx = { pendiente: null };
  const messages = [...historial, { role: "user", content: pregunta }];

  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await client.messages.create({
      model: MODELO,
      max_tokens: 8000,
      output_config: { effort: "medium" },
      system: sistema(),
      tools: HERRAMIENTAS,
      messages,
    });

    if (r.stop_reason === "refusal") {
      return { texto: "No puedo responder eso.", pendiente: null };
    }

    const usos = r.content.filter(b => b.type === "tool_use");
    if (!usos.length) {
      const texto = r.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return { texto: texto || "No se me ocurrió nada para contestar.", pendiente: ctx.pendiente, messages: [...messages, { role: "assistant", content: r.content }] };
    }

    messages.push({ role: "assistant", content: r.content });
    const resultados = [];
    for (const u of usos) {
      let salida;
      try {
        salida = await ejecutar(u.name, u.input, sql, ctx);
      } catch (e) {
        salida = { error: e.message };
      }
      resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(salida) });
    }
    messages.push({ role: "user", content: resultados });
  }
  return { texto: "Me colgué dando vueltas con los datos. Probá preguntarme algo más puntual.", pendiente: ctx.pendiente };
}

const iaConfigurada = () => !!process.env.ANTHROPIC_API_KEY;

module.exports = { responderConIA, iaConfigurada };
