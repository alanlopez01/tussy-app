const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `Sos el asistente de negocio de Tussy, una marca de indumentaria argentina. Tenés acceso a datos en tiempo real de ventas y stock. Respondé siempre en español, de forma clara y directa.

## EL NEGOCIO

**Tussy** es una marca de ropa de Alan, Federico y Nicolás. Vende principalmente remeras, polos, camisas y accesorios.

**Canales de venta:**
- Tiendanube (online, marca Tussy)
- Locales físicos gestionados con Dragonfish:
  - **Palermo** (Buenos Aires) - encargado Benjamin
  - **Abasto** (Buenos Aires) - encargado Ramiro
  - **Dot** (Buenos Aires) - encargado Noah, supervisor Pablo
  - **Córdoba** - encargada Analía
  - **La Plata** - encargado Sebastián
- WooCommerce (stock físico en Palermo y La Plata)

**Otras marcas del grupo:**
- **Shato**: ropa mayorista y minorista, 2 tiendas en Tiendanube
- **Blanks**: 1 tienda en Tiendanube

## TUS CAPACIDADES

Tenés herramientas para consultar datos reales:
- **buscar_stock_unificado** (PREFERIDA): busca stock por nombre normalizado en TODOS los locales desde el snapshot de Sheets. Unifica variaciones (ej: "Bermuda Scout" encuentra "Bermuda Gabardina Scout"). Devuelve total por local sin desglose de variantes.
- **buscar_stock**: búsqueda live en WC + Dragonfish con desglose por color y talle. Usar SOLO cuando el usuario pide info detallada de variantes (ej: "stock de remera diamond talle L"), porque depende de coincidencia exacta del nombre.
- **ventas_hoy**: ventas de hoy de Palermo (WC), La Plata (WC) y Tiendanube
- **ventas_hoy_dragonfish**: ventas de hoy de Dot, Abasto y Córdoba (Dragonfish)
- **ventas_mes**: ventas del mes de Palermo (WC), La Plata (WC) y Tiendanube
- **ventas_mes_dragonfish**: ventas del mes de Dot, Abasto y Córdoba (Dragonfish)
- **reporte_stock**: snapshot completo del stock guardado en Sheets
- **stock_valorizado**: valor monetario ($) del inventario por local, con precios reales. Usar cuando pregunten "stock valorizado", "cuánto vale el inventario", etc.
- **analizar_ventas_detalle**: detalle de ventas por producto/color/talle (WC + Tiendanube + Dragonfish). Los nombres se unifican automáticamente (ej: "REMERA OVERSIZE DIAMOND" y "REMERA TSSY DIAMONDS" cuentan juntos como "REMERA DIAMOND"). Los datos incluyen: producto (nombre unificado), color, talles (objeto con cantidad por talle), locales (cantidad por local), cantidad total, cambios/devoluciones, total facturado.

## INSTRUCCIONES

- Si te preguntan por stock de un producto específico, SIEMPRE usá la herramienta buscar_stock antes de responder.
- Si te preguntan por ventas de TODOS los locales, llamá SIEMPRE tanto ventas_hoy + ventas_hoy_dragonfish (o ventas_mes + ventas_mes_dragonfish) para tener datos completos.
- Dot, Abasto y Córdoba son locales físicos gestionados por Dragonfish (sistema distinto a WooCommerce).
- Cuando tengas los datos, interpretá la información y dá una respuesta útil, no sólo los números crudos.
- Si los datos no están disponibles o hay error, avisá claramente.
- Podés dar consejos de negocio basados en los datos que ves.
- En los datos de Dragonfish, cantidad negativa (-1) indica un **cambio/devolución** (el artículo ingresó al local). No lo cuentes como venta negativa — está separado en el campo "cambios" del resumen.
- Nunca inventes datos. Si no tenés información, decilo.
- Si buscar_stock devuelve un producto sin variantes en algún local, eso significa "agotado/sin stock" — NO digas "no figura este modelo" si sabés que existe (chequealo cruzando con analizar_ventas_detalle si tenés dudas). Decí "sin stock disponible" o "agotado en este local".

## FORMATO DE RESPUESTA

Respondé SIEMPRE de forma concisa. Para preguntas de ranking/análisis de ventas por producto:
1. **Total** arriba (ej: "648 remeras negras vendidas en abril")
2. **Top 5** en tabla (modelo + unidades), no más
3. **Highlights** breves (1-3 bullets): talles más vendidos, líder, tendencia
4. Ofrecé profundizar al final ("¿Querés ver por local?")

Evitá listas largas. Si el usuario quiere ver todo, lo va a pedir.`;

const TOOLS = [
  {
    name: "buscar_stock",
    description: "Busca el stock de un producto en todos los locales (Palermo y La Plata via WooCommerce). Usá esta herramienta cuando te pregunten por stock de un producto específico.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Nombre del producto o SKU a buscar. Ej: 'polo miami', 'remera lisa', 'RM-001'"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "ventas_hoy",
    description: "Obtiene las ventas del día de hoy por local (Dragonfish + Tiendanube). Incluye monto total y cantidad de tickets.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "ventas_mes",
    description: "Obtiene las ventas del mes actual por local. Incluye totales acumulados.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "ventas_hoy_dragonfish",
    description: "Obtiene las ventas de HOY de los locales Dot, Abasto y Córdoba (sistema Dragonfish). Llamar junto con ventas_hoy para tener todos los locales.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "ventas_mes_dragonfish",
    description: "Obtiene las ventas del MES ACTUAL de los locales Dot, Abasto y Córdoba (sistema Dragonfish). Llamar junto con ventas_mes para tener todos los locales.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "reporte_stock",
    description: "Obtiene el reporte completo de stock desde Google Sheets (snapshot diario). Incluye totales por local y top productos.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "buscar_stock_unificado",
    description: "Busca stock por nombre unificado (normalizado) en TODOS los locales usando el snapshot de Sheets. PREFERIR esta herramienta antes de buscar_stock cuando el usuario pregunta por stock de un modelo específico — unifica variaciones de nombre (ej: 'Bermuda Scout' encuentra 'BERMUDA GABARDINA SCOUT' en todos los locales). Devuelve cantidad total de unidades por local (Palermo, La Plata, Dot, Abasto, Córdoba).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre o parte del nombre del producto. Ej: 'bermuda scout', 'remera diamond', 'polo miami'" }
      },
      required: ["query"]
    }
  },
  {
    name: "stock_valorizado",
    description: "Calcula el VALOR MONETARIO total del inventario multiplicando stock × precio por producto. Devuelve el total en $ por cada local (Palermo, La Plata, Dot, Abasto, Córdoba), total global, cantidad de unidades y top 20 productos de mayor valorizado. Admite filtro opcional por nombre (ej: 'remera' para ver solo remeras). USÁ ESTA HERRAMIENTA cuando pregunten cosas como: 'stock valorizado', 'cuánto plata hay en mercadería', 'cuánto vale el inventario', 'valor del stock por local'. Es MUY precisa porque usa precios reales, NO estimaciones.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filtro opcional por nombre. Dejar vacío para el valorizado TOTAL." }
      }
    }
  },
  {
    name: "analizar_ventas_detalle",
    description: "Consulta el detalle de ventas guardado en Google Sheets (producto por producto, con color y talle). Usá esta herramienta para preguntas como: colores más vendidos, talles más pedidos, ranking de productos, comparación entre locales por producto específico. Datos disponibles: Palermo (WC), La Plata (WC) y Tiendanube.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "Fecha inicio en formato YYYY-MM-DD. Ej: '2026-04-01'" },
        hasta: { type: "string", description: "Fecha fin en formato YYYY-MM-DD. Si no se especifica, usa la misma que desde." },
        producto: { type: "string", description: "Filtro opcional por nombre de producto. Ej: 'remera', 'polo miami'. Dejar vacío para todos los productos." }
      },
      required: ["desde"]
    }
  }
];

async function ejecutarHerramienta(nombre, input, baseUrl) {
  try {
    if (nombre === "buscar_stock") {
      // Consultar WooCommerce y Dragonfish en paralelo (igual que la app)
      const [resWoo, resDf] = await Promise.allSettled([
        fetch(`${baseUrl}/api/stock?q=${encodeURIComponent(input.query)}`, { redirect: "follow" }).then(r => r.json()),
        fetch(`${baseUrl}/api/dragonfish?action=stock&q=${encodeURIComponent(input.query)}`, { redirect: "follow" }).then(r => r.json())
      ]);

      const dataWoo = resWoo.status === "fulfilled" ? resWoo.value : { resultados: [] };
      const dataDf  = resDf.status  === "fulfilled" ? resDf.value  : { resultados: [] };

      const wooResultados = (dataWoo.resultados || []).map(p => ({
        nombre: p.nombre,
        locales: {
          palermo: (p.locales?.palermo || []).map(v => ({ talle: v.atributos, stock: v.stock })),
          laplata: (p.locales?.laplata || []).map(v => ({ talle: v.atributos, stock: v.stock }))
        }
      }));

      const dfResultados = (dataDf.resultados || []).map(p => ({
        nombre: p.nombre,
        locales: {
          dot:     (p.locales?.dot     || []).map(v => ({ talle: v.atributos, stock: v.stock })),
          abasto:  (p.locales?.abasto  || []).map(v => ({ talle: v.atributos, stock: v.stock })),
          cordoba: (p.locales?.cordoba || []).map(v => ({ talle: v.atributos, stock: v.stock }))
        }
      }));

      if (wooResultados.length === 0 && dfResultados.length === 0) {
        return { mensaje: `No se encontraron productos con "${input.query}"` };
      }

      return {
        woocommerce: wooResultados,   // Palermo y La Plata
        dragonfish:  dfResultados     // Dot, Abasto, Córdoba
      };
    }

    if (nombre === "ventas_hoy") {
      // Usar timezone Argentina (UTC-3)
      const now = new Date();
      const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const hoy = ar.toISOString().split("T")[0];
      const r = await fetch(`${baseUrl}/api/ventas?desde=${hoy}&hasta=${hoy}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "ventas_mes") {
      const now = new Date();
      const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const anio = ar.getFullYear();
      const mes = String(ar.getMonth() + 1).padStart(2, "0");
      const desde = `${anio}-${mes}-01`;
      const hasta = ar.toISOString().split("T")[0];
      const r = await fetch(`${baseUrl}/api/ventas?desde=${desde}&hasta=${hasta}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "ventas_hoy_dragonfish") {
      const now = new Date();
      const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const hoy = ar.toISOString().split("T")[0];
      const r = await fetch(`${baseUrl}/api/dragonfish?action=ventas&desde=${hoy}&hasta=${hoy}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "ventas_mes_dragonfish") {
      const now = new Date();
      const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const anio = ar.getFullYear();
      const mes = String(ar.getMonth() + 1).padStart(2, "0");
      const desde = `${anio}-${mes}-01`;
      const hasta = ar.toISOString().split("T")[0];
      const r = await fetch(`${baseUrl}/api/dragonfish?action=ventas&desde=${desde}&hasta=${hasta}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "reporte_stock") {
      const r = await fetch(`${baseUrl}/api/stock?action=reporteSheets`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "buscar_stock_unificado") {
      const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;
      const r = await fetch(`${OPS_URL}?action=buscarStockUnificado&params=${encodeURIComponent(JSON.stringify({ query: input.query }))}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "stock_valorizado") {
      const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;
      const p = { query: input.query || "" };
      const r = await fetch(`${OPS_URL}?action=getStockValorizado&params=${encodeURIComponent(JSON.stringify(p))}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    if (nombre === "analizar_ventas_detalle") {
      const OPS_URL = process.env.APPS_SCRIPT_URL_OPERACIONES;
      const p = { desde: input.desde };
      if (input.hasta) p.hasta = input.hasta;
      if (input.producto) p.producto = input.producto;
      const r = await fetch(`${OPS_URL}?action=getVentasDetalle&params=${encodeURIComponent(JSON.stringify(p))}`, { redirect: "follow" });
      const data = await r.json();
      return data;
    }

    return { error: `Herramienta desconocida: ${nombre}` };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key no configurada" });

  const { messages, rol } = req.body || {};

  if (!["admin", "socio"].includes(rol)) {
    return res.status(403).json({ error: "Sin acceso" });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Mensajes inválidos" });
  }

  // URL base siempre apunta al dominio de producción
  const baseUrl = "https://tussy-app.vercel.app";

  // Fecha actual en Argentina
  const now = new Date();
  const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const hoyStr = ar.toISOString().split("T")[0];
  const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const fechaTexto = `hoy es ${ar.getUTCDate()} de ${meses[ar.getUTCMonth()]} de ${ar.getUTCFullYear()} (${hoyStr})`;
  const systemConFecha = `FECHA ACTUAL: ${fechaTexto}. Cuando el usuario diga "este mes" usá el mes ${meses[ar.getUTCMonth()]} (${ar.getUTCFullYear()}-${String(ar.getUTCMonth()+1).padStart(2,"0")}).\n\n${SYSTEM_PROMPT}`;

  try {
    let conversacion = [...messages];
    let respuestaFinal = null;

    // Agentic loop: hasta 5 rondas de tool use
    for (let ronda = 0; ronda < 5; ronda++) {
      const body = {
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemConFecha,
        tools: TOOLS,
        messages: conversacion
      };

      const r = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });

      const responseText = await r.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch(e) {
        return res.status(500).json({ error: "Respuesta no-JSON de Anthropic: " + responseText.substring(0, 300) });
      }

      if (!r.ok) {
        return res.status(500).json({ error: "Anthropic " + r.status + ": " + (data.error?.message || JSON.stringify(data).substring(0, 300)) });
      }

      // Si terminó de responder
      if (data.stop_reason === "end_turn") {
        const texto = data.content?.find(c => c.type === "text")?.text || "";
        respuestaFinal = texto;
        break;
      }

      // Si quiere usar herramientas
      if (data.stop_reason === "tool_use") {
        // Agregar el mensaje del asistente con tool_use
        conversacion.push({ role: "assistant", content: data.content });

        // Ejecutar cada herramienta solicitada
        const toolResults = [];
        for (const block of data.content) {
          if (block.type !== "tool_use") continue;
          const resultado = await ejecutarHerramienta(block.name, block.input, baseUrl);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(resultado)
          });
        }

        // Agregar resultados al contexto
        conversacion.push({ role: "user", content: toolResults });
        continue;
      }

      // Otro stop_reason inesperado
      respuestaFinal = data.content?.find(c => c.type === "text")?.text || "Sin respuesta";
      break;
    }

    if (!respuestaFinal) {
      respuestaFinal = "No pude obtener una respuesta completa. Intentá de nuevo.";
    }

    return res.status(200).json({ respuesta: respuestaFinal });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
