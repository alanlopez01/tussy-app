// Alertas comerciales — lo que hay que mirar todos los días sin tener que buscarlo.
// Reglas determinísticas sobre datos propios (ventas, costos, stock) + Meta y
// Tiendanube. La ejecuta el cron diario y la consume el endpoint action=alertas
// (la app y el agente de monitoreo leen lo mismo).
//
// Severidad: alta = plata que se está perdiendo hoy · media = decisión que conviene
// tomar esta semana · baja = para tener en el radar.

const CATEG = new Set([
  "REMERA", "BUZO", "CAMPERA", "PANTALON", "SWEATER", "JEAN", "BOXER", "GORRA", "MEDIAS",
  "PIN", "LLAVERO", "BOLSO", "MOCHILA", "CAMISETA", "SHORT", "BERMUDA", "MUSCULOSA",
  "CHOMBA", "POLO", "CAMISA", "VESTIDO", "CALZA", "PACK", "BASIC", "SHIRT", "BLACK",
  "TSSY", "TSSYA", "ARG", "CON", "SET", "OVERSIZE", "BORDADO", "BORDADA",
  // typos de carga en los locales: si no se ignoran, el producto nunca matchea con la web
  "OVERISZE", "OVERISIZE", "OVESIZE", "BASICA", "BASICO",
]);

// Palabras del modelo (lo que identifica al producto, sin la categoría)
function palabrasModelo(productoNorm) {
  return String(productoNorm).toUpperCase().split(/\s+/).filter(w => w.length >= 4 && !CATEG.has(w));
}

// La categoría (musculosa, buzo, bermuda...) es parte de la identidad: el mismo
// modelo se repite en varias prendas — "Cousing" existe como buzo y como
// musculosa. Sin esto, una musculosa que falta en la web pasa desapercibida
// porque el buzo del mismo nombre sí está.
function categoriaDe(productoNorm) {
  for (const w of String(productoNorm).toUpperCase().split(/\s+/)) {
    if (CATEG.has(w)) return w;
  }
  return null;
}
// Variantes con que Tiendanube nombra cada categoría
const SINONIMOS_CATEGORIA = {
  MUSCULOSA: ["MUSCULOSA"], BERMUDA: ["BERMUDA"], SHORT: ["SHORT", "BERMUDA"],
  REMERA: ["REMERA", "T SHIRT", "CAMISETA"], BUZO: ["BUZO"], CAMPERA: ["CAMPERA"],
  PANTALON: ["PANTALON", "JOGGING", "PANT"], JEAN: ["JEAN"], SWEATER: ["SWEATER"],
  CAMISETA: ["CAMISETA", "REMERA"], POLO: ["POLO"], CAMISA: ["CAMISA"],
  BOLSO: ["BOLSO"], MOCHILA: ["MOCHILA"], GORRA: ["GORRA", "PILUSO"],
};
function mismaCategoria(productoNorm, nombreTN) {
  const c = categoriaDe(productoNorm);
  if (!c) return true; // sin categoría reconocible, no se filtra
  const acepta = SINONIMOS_CATEGORIA[c] || [c];
  return acepta.some(x => nombreTN.includes(x));
}

const fmt = n => "$" + Math.round(Number(n)).toLocaleString("es-AR");
const fmtM = n => "$" + (Number(n) / 1e6).toFixed(1) + "M";

// ── 1 y 2. Costos: faltantes (crítico) y estimados por promedio (a confirmar) ──
async function alertasCostos(sql) {
  const [faltantes, estimados] = await Promise.all([
    sql`
      SELECT v.producto_norm, SUM(v.cantidad)::int u, ROUND(SUM(v.total))::bigint venta
      FROM ventas v
      LEFT JOIN LATERAL (
        SELECT costo FROM costos_producto cp
        WHERE cp.producto = v.producto_norm AND cp.vigente_desde <= v.fecha
        ORDER BY cp.vigente_desde DESC LIMIT 1
      ) c ON true
      WHERE v.fecha >= CURRENT_DATE - 30 AND v.total > 0
        AND v.producto_norm NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE')
        AND c.costo IS NULL
      GROUP BY 1 ORDER BY venta DESC`,
    sql`
      SELECT cp.producto, cp.costo::float costo, cp.origen,
             COALESCE(SUM(v.cantidad), 0)::int u,
             ROUND(COALESCE(SUM(v.total), 0))::bigint venta
      FROM costos_producto cp
      LEFT JOIN ventas v ON v.producto_norm = cp.producto
        AND v.fecha >= CURRENT_DATE - 30 AND v.total > 0
      WHERE cp.origen LIKE '%promedio%'
      GROUP BY 1, 2, 3
      HAVING COALESCE(SUM(v.cantidad), 0) >= 10
      ORDER BY venta DESC`,
  ]);

  const out = [];
  if (faltantes.length) {
    out.push({
      tipo: "costo_faltante", severidad: "alta",
      titulo: `${faltantes.length} producto${faltantes.length > 1 ? "s" : ""} sin costo cargado`,
      detalle: "Vendieron en los últimos 30 días y no tienen costo: no entran bien en rentabilidad ni en el cierre.",
      accion: "Pasame el costo de estos productos para cargarlos.",
      items: faltantes.map(f => ({
        producto: f.producto_norm, unidades: f.u, venta: Number(f.venta),
        texto: `${f.producto_norm} · ${f.u}u · ${fmtM(f.venta)}`,
      })),
    });
  }
  if (estimados.length) {
    out.push({
      tipo: "costo_estimado", severidad: "media",
      titulo: `${estimados.length} producto${estimados.length > 1 ? "s" : ""} con costo estimado`,
      detalle: "Tomaron el costo promedio de su familia porque no hay uno propio cargado. El margen que ves es aproximado.",
      accion: "Confirmame el costo real de estos para reemplazar el estimado.",
      items: estimados.map(e => ({
        producto: e.producto, unidades: e.u, costo: Math.round(e.costo), origen: e.origen,
        texto: `${e.producto} · costo estimado ${fmt(e.costo)} · ${e.u}u en 30 días`,
      })),
    });
  }
  return out;
}

// ── 3. Márgenes: productos que dejan poco por unidad ──
// mult = precio de venta promedio / costo. Bajo 2,5x el producto no banca su
// estructura (financiero + fijos + impuestos se comen el resto).
async function alertasMargenes(sql, ivaVentaPct, multMinimo = 2.5) {
  const filas = await sql`
    SELECT v.producto_norm,
           SUM(v.cantidad)::int u,
           ROUND(SUM(v.total))::bigint venta,
           ROUND(SUM(v.total) / NULLIF(SUM(v.cantidad), 0))::bigint precio,
           ROUND(AVG(c.costo))::bigint costo
    FROM ventas v
    JOIN LATERAL (
      SELECT costo FROM costos_producto cp
      WHERE cp.producto = v.producto_norm AND cp.vigente_desde <= v.fecha
      ORDER BY cp.vigente_desde DESC LIMIT 1
    ) c ON true
    WHERE v.fecha >= CURRENT_DATE - 30 AND v.total > 0
      AND v.producto_norm NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE')
    GROUP BY 1
    HAVING SUM(v.cantidad) >= 10 AND AVG(c.costo) > 0
    ORDER BY venta DESC`;

  const evaluados = filas.map(f => {
    const precio = Number(f.precio), costo = Number(f.costo);
    const neto = precio * (1 - ivaVentaPct);
    return {
      producto: f.producto_norm, unidades: f.u, venta: Number(f.venta),
      precio, costo, mult: precio / costo,
      margen_unitario: Math.round(neto - costo),
      margen_pct: (neto - costo) / neto * 100,
    };
  });

  const out = [];
  const negativos = evaluados.filter(e => e.margen_unitario <= 0);
  if (negativos.length) {
    out.push({
      tipo: "margen_negativo", severidad: "alta",
      titulo: `${negativos.length} producto${negativos.length > 1 ? "s pierden" : " pierde"} plata en cada venta`,
      detalle: "El precio neto de IVA no cubre el costo de producción.",
      accion: "Subir precio o dejar de reponer.",
      items: negativos.map(n => ({ ...n, texto: `${n.producto} · precio ${fmt(n.precio)} vs costo ${fmt(n.costo)} → ${fmt(n.margen_unitario)} por unidad` })),
    });
  }
  const bajos = evaluados.filter(e => e.margen_unitario > 0 && e.mult < multMinimo)
    .sort((a, b) => b.venta - a.venta);
  if (bajos.length) {
    out.push({
      tipo: "margen_bajo", severidad: "media",
      titulo: `${bajos.length} producto${bajos.length > 1 ? "s" : ""} por debajo de ${String(multMinimo).replace(".", ",")}x`,
      detalle: "Multiplicador precio/costo bajo: dejan poco margen para bancar financiero, fijos e impuestos.",
      accion: "Revisar lista de precios o negociar el costo.",
      items: bajos.map(b => ({ ...b, texto: `${b.producto} · ${b.mult.toFixed(1)}x · precio ${fmt(b.precio)} costo ${fmt(b.costo)} · ${b.unidades}u` })),
    });
  }
  return out;
}

// ── 4. Catálogo online: vende en locales pero la web no lo tiene (caso Brickell) ──
async function alertasCatalogo(sql, productosTN) {
  if (!productosTN) return [];
  const filas = await sql`
    SELECT producto_norm,
           SUM(cantidad)::int u,
           ROUND(SUM(total))::bigint venta,
           SUM(CASE WHEN local = 'Tiendanube' THEN cantidad ELSE 0 END)::int u_online
    FROM ventas
    WHERE fecha >= CURRENT_DATE - 30 AND total > 0
      AND producto_norm NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE')
    GROUP BY 1 HAVING SUM(cantidad) >= 10
    ORDER BY SUM(total) DESC`;

  const ausentes = [], sinStock = [];
  for (const f of filas) {
    const palabras = palabrasModelo(f.producto_norm);
    if (!palabras.length) continue;
    // Un producto de TN "matchea" si su nombre contiene todas las palabras del modelo.
    // Puede haber varios (cada color se carga como producto aparte): el stock es la suma.
    const matches = productosTN.filter(p =>
      palabras.every(w => p.nombre.includes(w)) && mismaCategoria(f.producto_norm, p.nombre));
    if (!matches.length) {
      ausentes.push({ producto: f.producto_norm, unidades: f.u, venta: Number(f.venta),
        texto: `${f.producto_norm} · ${f.u}u · ${fmtM(f.venta)} · no está en la web` });
    } else if (matches.every(m => !m.publicado || m.stock === 0)) {
      const publicados = matches.filter(m => m.publicado).length;
      sinStock.push({ producto: f.producto_norm, unidades: f.u, venta: Number(f.venta),
        texto: `${f.producto_norm} · ${f.u}u en locales · web ${publicados ? "sin stock" : "despublicado"}` });
    }
  }

  const out = [];
  if (ausentes.length) {
    out.push({
      tipo: "fuera_de_catalogo", severidad: "alta",
      titulo: `${ausentes.length} producto${ausentes.length > 1 ? "s venden" : " vende"} en locales y no está${ausentes.length > 1 ? "n" : ""} en la web`,
      detalle: "Venta online que se pierde y producto que no entra al catálogo de Meta.",
      accion: "Cargarlos en Tiendanube.",
      items: ausentes,
    });
  }
  if (sinStock.length) {
    out.push({
      tipo: "sin_stock_online", severidad: "media",
      titulo: `${sinStock.length} producto${sinStock.length > 1 ? "s" : ""} con stock en locales y cero en la web`,
      detalle: "Se siguen vendiendo en los locales pero la web los muestra agotados.",
      accion: "Reponer stock online.",
      items: sinStock,
    });
  }
  return out;
}

// ── 5. Pauta: productos que venden y no tienen campaña dedicada ──
async function alertasSinPauta(sql, terminosConPauta, minUnidades = 15) {
  const [filas, primeras] = await Promise.all([
    sql`
      SELECT producto_norm, SUM(cantidad)::int u, ROUND(SUM(total))::bigint venta,
             ROUND(100.0 * SUM(CASE WHEN local = 'Tiendanube' THEN cantidad ELSE 0 END)
                   / NULLIF(SUM(cantidad), 0))::int pct_online
      FROM ventas
      WHERE fecha >= CURRENT_DATE - 30 AND total > 0
        AND producto_norm NOT IN ('ENVIO', 'DESCUENTO', 'AJUSTE')
      GROUP BY 1 HAVING SUM(cantidad) >= ${minUnidades}
      ORDER BY SUM(total) DESC LIMIT 40`,
    sql`SELECT producto_norm, MIN(fecha)::text primera FROM ventas WHERE total > 0 GROUP BY 1`,
  ]);
  const debut = Object.fromEntries(primeras.map(p => [p.producto_norm, p.primera]));
  const hace45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

  const sinPauta = [];
  for (const f of filas) {
    const palabras = palabrasModelo(f.producto_norm);
    if (!palabras.length) continue;
    const cubierto = palabras.some(w => terminosConPauta.some(t => t.includes(w) || w.includes(t)));
    if (cubierto) continue;
    const esNuevo = (debut[f.producto_norm] || "") >= hace45;
    sinPauta.push({
      producto: f.producto_norm, unidades: f.u, venta: Number(f.venta),
      pct_online: f.pct_online || 0, nuevo: esNuevo,
      texto: `${f.producto_norm} · ${f.u}u · ${fmtM(f.venta)} · ${f.pct_online || 0}% online${esNuevo ? " · DROP NUEVO" : ""}`,
    });
  }
  if (!sinPauta.length) return [];

  const nuevos = sinPauta.filter(s => s.nuevo);
  const out = [{
    tipo: "sin_pauta", severidad: "media",
    titulo: `${sinPauta.length} producto${sinPauta.length > 1 ? "s venden" : " vende"} fuerte sin pauta dedicada`,
    detalle: "Venta orgánica probada: son los mejores candidatos a campaña propia.",
    accion: "Elegir los 2-3 de mayor venta online y armarles CV.",
    items: sinPauta.slice(0, 12),
  }];
  if (nuevos.length) {
    out.push({
      tipo: "drop_sin_pauta", severidad: "alta",
      titulo: `${nuevos.length} drop${nuevos.length > 1 ? "s nuevos" : " nuevo"} sin pauta`,
      detalle: "Salieron hace menos de 45 días y ya venden solos. La ventana de lanzamiento es corta.",
      accion: "Armar campaña ya, con las fotos de la web.",
      items: nuevos,
    });
  }
  return out;
}

// ── 6. Pauta: campañas que hay que tocar hoy ──
// Compara los últimos 3 días contra los 7 previos y marca lo que se cae.
function alertasPauta(campanas, { roasMinimo = 3, frecuenciaMaxima = 6 } = {}) {
  const out = [];
  const flojas = [], fatigadas = [], sinConversion = [];

  for (const c of campanas) {
    if (c.estado !== "ACTIVE" || c.gasto3 < 30000) continue;
    if (c.compras3 === 0) {
      sinConversion.push({ campana: c.nombre, gasto: c.gasto3,
        texto: `${c.nombre} · ${fmt(c.gasto3)} en 3 días sin una sola compra` });
    } else if (c.roas3 < roasMinimo) {
      flojas.push({ campana: c.nombre, roas: c.roas3, roas_previo: c.roas7, gasto: c.gasto3,
        texto: `${c.nombre} · ROAS ${c.roas3.toFixed(1)} (venía ${c.roas7.toFixed(1)}) · ${fmt(c.gasto3)} en 3 días` });
    }
    if (c.frecuencia3 >= frecuenciaMaxima) {
      fatigadas.push({ campana: c.nombre, frecuencia: c.frecuencia3, roas: c.roas3,
        texto: `${c.nombre} · frecuencia ${c.frecuencia3.toFixed(1)} · el público ya la vio demasiado` });
    }
  }

  if (sinConversion.length) {
    out.push({ tipo: "pauta_sin_conversion", severidad: "alta",
      titulo: `${sinConversion.length} campaña${sinConversion.length > 1 ? "s" : ""} gastando sin vender`,
      detalle: "Tres días de gasto sin una compra atribuida.", accion: "Pausar o cambiar el creativo.",
      items: sinConversion });
  }
  if (flojas.length) {
    out.push({ tipo: "pauta_roas_bajo", severidad: "media",
      titulo: `${flojas.length} campaña${flojas.length > 1 ? "s" : ""} por debajo de ${roasMinimo}x`,
      detalle: "ROAS de los últimos 3 días contra los 7 previos.", accion: "Bajar presupuesto o renovar creativo.",
      items: flojas });
  }
  if (fatigadas.length) {
    out.push({ tipo: "pauta_fatiga", severidad: "baja",
      titulo: `${fatigadas.length} campaña${fatigadas.length > 1 ? "s" : ""} con frecuencia alta`,
      detalle: "El mismo público la está viendo muchas veces: el rendimiento cae solo.",
      accion: "Renovar creativo o ampliar audiencia.", items: fatigadas });
  }
  return out;
}

// ── Fuentes externas ──
async function traerProductosTN(env = process.env) {
  const token = env.TN_ACCESS_TOKEN, userId = env.TN_USER_ID;
  if (!token || !userId) return null;
  const productos = [];
  for (let page = 1; page <= 15; page++) {
    const r = await fetch(`https://api.tiendanube.com/v1/${userId}/products?per_page=200&page=${page}&fields=id,name,variants,published`, {
      headers: { Authentication: `bearer ${token}`, "User-Agent": "TussyApp (alerta)" },
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!r || !r.ok) break;
    const lote = await r.json();
    if (!Array.isArray(lote) || !lote.length) break;
    for (const p of lote) {
      // stock null = infinito (fábrica a demanda): cuenta como disponible
      const stock = (p.variants || []).reduce((a, v) => a + (v.stock === null ? 9999 : Number(v.stock) || 0), 0);
      productos.push({ id: p.id, nombre: String(p.name?.es || "").toUpperCase(), stock, publicado: p.published });
    }
    if (lote.length < 200) break;
  }
  return productos.length ? productos : null;
}

// Campañas con métricas de 3 y 7 días + términos que ya tienen pauta dedicada
async function traerPautaMeta(env = process.env) {
  const T = env.META_TOKEN;
  if (!T) return { campanas: [], terminos: [] };
  const rango = (dias) => encodeURIComponent(JSON.stringify({
    since: new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10),
    until: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
  }));
  const url = `https://graph.facebook.com/v23.0/act_209307700817328/campaigns` +
    `?fields=name,effective_status,daily_budget,` +
    `ult3:insights.time_range(${rango(3)}){spend,frequency,actions,action_values},` +
    `ult10:insights.time_range(${rango(10)}){spend,actions,action_values}` +
    `&limit=100&access_token=${T}`;
  const j = await fetch(url, { signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => null);
  if (!j || j.error || !j.data) return { campanas: [], terminos: [] };

  const valor = (ins, tipo) => Number(ins?.actions?.find(a => a.action_type === tipo)?.value || 0);
  const monto = (ins) => Number(ins?.action_values?.find(a => a.action_type === "purchase")?.value || 0);

  const campanas = j.data.map(c => {
    const i3 = c.ult3?.data?.[0], i10 = c.ult10?.data?.[0];
    const g3 = Number(i3?.spend || 0), g10 = Number(i10?.spend || 0);
    const v3 = monto(i3), v10 = monto(i10);
    return {
      nombre: c.name, estado: c.effective_status,
      presupuesto: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      gasto3: g3, compras3: valor(i3, "purchase"), valor3: v3, roas3: g3 ? v3 / g3 : 0,
      frecuencia3: Number(i3?.frequency || 0),
      // "previo" = los 10 días completos, como referencia de tendencia
      roas7: g10 ? v10 / g10 : 0,
    };
  });

  // Términos cubiertos por pauta dedicada activa. Mira campañas Y anuncios: un
  // producto puede tener su ad propio dentro de una campaña paraguas (Best Sellers).
  const terminos = new Set();
  const sumarTerminos = (nombre) => {
    const n = nombre.toUpperCase();
    if (n.includes("CATALOGO") || n.includes("RETARGETING")) return;
    for (const w of n.replace(/[^A-ZÁÉÍÓÚÑ ]/g, " ").split(/\s+/)) {
      if (w.length >= 4 && !CATEG.has(w)) terminos.add(w);
    }
  };
  for (const c of j.data) if (c.effective_status === "ACTIVE") sumarTerminos(c.name);

  const ads = await fetch(`https://graph.facebook.com/v23.0/act_209307700817328/ads` +
    `?fields=name,effective_status&limit=250&access_token=${T}`,
    { signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => null);
  for (const a of ads?.data || []) if (a.effective_status === "ACTIVE") sumarTerminos(a.name);

  return { campanas, terminos: [...terminos] };
}

// ── Orquestador ──
async function generarAlertas(sql, env = process.env) {
  const [cfgRows, tn, meta] = await Promise.all([
    sql`SELECT clave, valor FROM config_negocio WHERE clave = 'iva_venta_pct'`,
    traerProductosTN(env).catch(() => null),
    traerPautaMeta(env).catch(() => ({ campanas: [], terminos: [] })),
  ]);
  const ivaVentaPct = cfgRows.length ? Number(cfgRows[0].valor) : 0.21 / 1.21;

  const grupos = await Promise.all([
    alertasCostos(sql),
    alertasMargenes(sql, ivaVentaPct),
    alertasCatalogo(sql, tn),
    alertasSinPauta(sql, meta.terminos),
  ]);
  const alertas = [...grupos.flat(), ...alertasPauta(meta.campanas)];

  const orden = { alta: 0, media: 1, baja: 2 };
  alertas.sort((a, b) => orden[a.severidad] - orden[b.severidad]);

  return {
    generado: new Date().toISOString(),
    fuentes: { tiendanube: !!tn, meta: meta.campanas.length > 0 },
    resumen: {
      total: alertas.length,
      alta: alertas.filter(a => a.severidad === "alta").length,
      media: alertas.filter(a => a.severidad === "media").length,
      baja: alertas.filter(a => a.severidad === "baja").length,
    },
    alertas,
  };
}

module.exports = { generarAlertas, alertasPauta, palabrasModelo };
