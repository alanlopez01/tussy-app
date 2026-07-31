// Fetchers de línea de venta desde las fuentes reales (Woo, Tiendanube, Dragonfish).
// Portados de apps_script_operaciones.gs para mantener paridad de números.
// Cada fetcher devuelve { ok, filas, error } — filas con shape:
//   { fecha, local, sistema, orden_id, producto, sku, color, talle, cantidad, precio_unit, total }

function diaSiguiente(fecha) {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// "HH:MM" en hora Argentina a partir de un ISO/epoch (o null)
function horaArg(fechaISOoTs) {
  if (!fechaISOoTs) return null;
  const d = typeof fechaISOoTs === "number" ? new Date(fechaISOoTs) : new Date(fechaISOoTs);
  if (isNaN(d)) return null;
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(11, 16);
}

// ─── WooCommerce (Palermo, La Plata) ────────────────────────────────────────

function wooLocales(env = process.env) {
  return [
    { nombre: "Palermo",  url: env.WOO_PALERMO_URL, key: env.WOO_PALERMO_KEY, secret: env.WOO_PALERMO_SECRET },
    { nombre: "La Plata", url: env.WOO_LAPLATA_URL, key: env.WOO_LAPLATA_KEY, secret: env.WOO_LAPLATA_SECRET },
  ].filter(l => l.url && l.key && l.secret);
}

async function fetchWooDia(local, fecha) {
  const auth = Buffer.from(`${local.key}:${local.secret}`).toString("base64");
  const filas = [];
  let page = 1;
  try {
    while (true) {
      const url = `${local.url}/wp-json/wc/v3/orders?status=completed,processing` +
        `&after=${fecha}T03:00:00Z&before=${diaSiguiente(fecha)}T02:59:59Z&per_page=100&page=${page}`;
      const r = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) return { ok: false, filas: [], error: `HTTP ${r.status} en página ${page}` };
      const orders = await r.json();
      if (!Array.isArray(orders) || orders.length === 0) break;

      for (const order of orders) {
        for (const item of order.line_items || []) {
          let color = "", talle = "";
          for (const m of item.meta_data || []) {
            const k = (m.key || "").toLowerCase();
            const v = String(m.value || "");
            if (k === "color" || k === "colour" || k === "pa_color") color = v;
            else if (k === "talle" || k === "size" || k === "pa_talle" || k === "pa_size" || k === "talla") talle = v;
            else if (k === "atributo_1" || k === "attribute_pa_color") color = color || v;
            else if (k === "atributo_2" || k === "attribute_pa_talle") talle = talle || v;
          }
          if (!color && !talle && item.name) {
            const partes = item.name.split(" - ");
            if (partes.length >= 2) talle = partes[partes.length - 1].trim();
          }
          const qty = parseInt(item.quantity || 1);
          const precioUnit = qty > 0 ? parseFloat(item.total || 0) / qty : 0;
          filas.push({
            fecha, local: local.nombre, sistema: "WooCommerce",
            orden_id: String(order.id),
            hora: horaArg(order.date_created_gmt ? order.date_created_gmt + "Z" : null),
            producto: item.name || "", sku: item.sku || "", color, talle,
            cantidad: qty, precio_unit: Math.round(precioUnit),
            total: parseFloat(item.total || 0),
          });
        }
      }
      if (orders.length < 100) break;
      page++;
    }
    return { ok: true, filas, error: null };
  } catch (e) {
    return { ok: false, filas: [], error: e.message };
  }
}

// ─── Tiendanube ─────────────────────────────────────────────────────────────

async function fetchTNDia(fecha, env = process.env) {
  const token = env.TN_ACCESS_TOKEN, userId = env.TN_USER_ID;
  if (!token || !userId) return { ok: false, filas: [], error: "sin credenciales TN" };
  const filas = [];
  let page = 1;
  const inicioUTC = `${fecha}T03:00:00+0000`;
  const finUTC = `${diaSiguiente(fecha)}T02:59:59+0000`;
  try {
    while (true) {
      const url = `https://api.tiendanube.com/v1/${userId}/orders` +
        `?created_at_min=${inicioUTC}&created_at_max=${finUTC}&per_page=200&page=${page}`;
      const r = await fetch(url, {
        headers: { Authentication: `bearer ${token}`, "User-Agent": "TussyApp/1.0" },
        signal: AbortSignal.timeout(30000),
      });
      // TN devuelve 404 cuando la página está fuera de rango
      if (r.status === 404) break;
      if (!r.ok) return { ok: false, filas: [], error: `HTTP ${r.status} en página ${page}` };
      const orders = await r.json();
      if (!Array.isArray(orders) || orders.length === 0) break;

      for (const order of orders) {
        const orderStatus = String(order.status || "").toLowerCase();
        const paymentStatus = String(order.payment_status || "").toLowerCase();
        if (orderStatus === "cancelled") continue;
        if (!["paid", "partially_paid"].includes(paymentStatus)) continue;

        const ordenId = String(order.id);
        const horaOrden = horaArg(order.created_at);
        let subtotalProductos = 0;
        for (const item of order.products || []) {
          subtotalProductos += parseFloat(item.price || 0) * parseInt(item.quantity || 1);
        }
        const shipping = parseFloat(order.shipping_cost_customer || order.shipping_cost_owner || 0);
        const descuento = parseFloat(order.discount || 0) + parseFloat(order.discount_coupon || 0) + parseFloat(order.discount_gateway || 0);
        const totalOrden = parseFloat(order.total || 0);

        for (const item of order.products || []) {
          let color = "", talle = "";
          if (item.variant && item.variant.values) {
            item.variant.values.forEach((v, idx) => {
              const nombre = ((item.variant.attribute_names || [])[idx] || "").toLowerCase();
              const valor = String(v || "");
              if (nombre.includes("color") || nombre.includes("colour")) color = valor;
              else if (nombre.includes("talle") || nombre.includes("size") || nombre.includes("talla")) talle = valor;
              else if (idx === 0 && !color) color = valor;
              else if (idx === 1 && !talle) talle = valor;
            });
          }
          let nombreBase = item.name || "";
          if ((!color || !talle) && nombreBase.includes("(")) {
            const matchParen = nombreBase.match(/\(([^)]+)\)$/);
            if (matchParen) {
              const partes = matchParen[1].split(",").map(s => s.trim());
              if (!color && partes[0]) color = partes[0];
              if (!talle && partes[1]) talle = partes[1];
              nombreBase = nombreBase.replace(/\s*\([^)]+\)$/, "").trim();
            }
          }
          const qty = parseInt(item.quantity || 1);
          const precioUnit = parseFloat(item.price || 0);
          filas.push({
            fecha, local: "Tiendanube", sistema: "Tiendanube", orden_id: ordenId, hora: horaOrden,
            producto: nombreBase, sku: item.sku || "", color, talle,
            cantidad: qty, precio_unit: Math.round(precioUnit), total: Math.round(precioUnit * qty),
          });
        }

        if (shipping > 0) filas.push({ fecha, local: "Tiendanube", sistema: "Tiendanube", orden_id: ordenId, hora: horaOrden, producto: "ENVIO", sku: "", color: "", talle: "", cantidad: 1, precio_unit: Math.round(shipping), total: Math.round(shipping) });
        if (descuento > 0) filas.push({ fecha, local: "Tiendanube", sistema: "Tiendanube", orden_id: ordenId, hora: horaOrden, producto: "DESCUENTO", sku: "", color: "", talle: "", cantidad: 1, precio_unit: -Math.round(descuento), total: -Math.round(descuento) });
        const diferencia = totalOrden - (subtotalProductos + shipping - descuento);
        if (Math.abs(diferencia) > 1) filas.push({ fecha, local: "Tiendanube", sistema: "Tiendanube", orden_id: ordenId, hora: horaOrden, producto: "AJUSTE", sku: "", color: "", talle: "", cantidad: 1, precio_unit: Math.round(diferencia), total: Math.round(diferencia) });
      }
      if (orders.length < 200) break;
      page++;
    }
    return { ok: true, filas, error: null };
  } catch (e) {
    return { ok: false, filas: [], error: e.message };
  }
}

// ─── Dragonfish (Dot, Abasto, Córdoba) ──────────────────────────────────────

function dfLocales(env = process.env) {
  return [
    { key: "dot",     nombre: "Dot",     url: env.DF_DOT_URL,     token: env.DF_JWTOKEN_DOT,     baseDatos: env.DF_BASE_DATOS_DOT || "DOT",         idCliente: env.DF_ID_CLIENTE_DOT || env.DF_ID_CLIENTE || "API" },
    { key: "abasto",  nombre: "Abasto",  url: env.DF_ABASTO_URL,  token: env.DF_JWTOKEN_ABASTO,  baseDatos: env.DF_BASE_DATOS_ABASTO || "ABASTO",   idCliente: env.DF_ID_CLIENTE_ABASTO || env.DF_ID_CLIENTE || "API" },
    { key: "cordoba", nombre: "Córdoba", url: env.DF_CORDOBA_URL, token: env.DF_JWTOKEN_CORDOBA, baseDatos: env.DF_BASE_DATOS_CORDOBA || "CORDOBA", idCliente: env.DF_ID_CLIENTE_CORDOBA || env.DF_ID_CLIENTE || "API" },
  ].filter(l => l.url && l.token);
}

// Día ARG de un timestamp epoch-ms (ARG = UTC-3)
function diaArgDeTs(ts) {
  return new Date(ts - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function filasDeFactura(fac, fecha, localNombre, ts) {
  const ordenId = `${fac.Letra || ""}${fac.PuntoDeVenta || ""}-${fac.Numero || ""}`;
  // La hora real está en InformacionAdicional.HoraAltaFW ("14:49:14", hora local);
  // el campo Fecha viene siempre a medianoche.
  const horaFW = fac.InformacionAdicional && fac.InformacionAdicional.HoraAltaFW;
  const hora = (horaFW && /^\d{2}:\d{2}/.test(horaFW)) ? horaFW.slice(0, 5) : (ts ? horaArg(ts) : null);
  const filas = (fac.FacturaDetalle || []).map(item => ({
    fecha, local: localNombre, sistema: "Dragonfish", orden_id: ordenId, hora,
    producto: item.ArticuloDetalle || "", sku: item.Articulo || "",
    color: item.ColorDetalle || "", talle: item.Talle || "",
    cantidad: parseInt(item.Cantidad || 1),
    precio_unit: Math.round(parseFloat(item.Precio || 0)),
    total: Math.round(parseFloat(item.Monto || item.Precio || 0)),
  }));
  // Los items vienen a precio pleno; el Total de la factura ya tiene aplicados
  // descuentos/recargos a nivel comprobante. Agregamos una línea por la
  // diferencia para que la suma de líneas == facturación real (fac.Total).
  const totalFactura = parseFloat(fac.Total || 0);
  const sumItems = filas.reduce((a, f) => a + f.total, 0);
  const diff = Math.round(totalFactura - sumItems);
  if (Math.abs(diff) > 1) {
    filas.push({
      fecha, local: localNombre, sistema: "Dragonfish", orden_id: ordenId, hora,
      producto: diff < 0 ? "DESCUENTO" : "AJUSTE", sku: "", color: "", talle: "",
      cantidad: 1, precio_unit: diff, total: diff,
    });
  }
  return filas;
}

// Recorre Facturaagrupada de más nueva a más vieja, agrupando por día ARG,
// hasta pasar `desde`. Devuelve { ok, porDia: {fecha: filas[]}, error }.
// Un solo sweep sirve para un rango completo (eficiente para backfill).
async function fetchDFRango(local, desde, hasta) {
  const tsInicio = new Date(`${desde}T03:00:00Z`).getTime();
  const tsFin = new Date(`${diaSiguiente(hasta)}T02:59:59Z`).getTime();
  const porDia = {};
  let page = 1;
  try {
    while (true) {
      const qs = new URLSearchParams({ limit: "50", page: String(page), sort: "-Fecha" }).toString();
      // Reintentos por página: los servers de los locales son lentos y a veces cortan
      let r = null, lastErr = null;
      for (let intento = 1; intento <= 3; intento++) {
        try {
          r = await fetch(`${local.url}/api.Dragonfish/Facturaagrupada/?${qs}`, {
            headers: {
              "Content-Type": "application/json",
              "idCliente": local.idCliente,
              "Authorization": local.token,
              "BaseDeDatos": local.baseDatos,
            },
            signal: AbortSignal.timeout(45000),
          });
          if (r.ok) break;
          lastErr = `HTTP ${r.status}`;
          r = null;
        } catch (e) {
          lastErr = e.message;
          r = null;
        }
        if (intento < 3) await new Promise(res => setTimeout(res, 3000 * intento));
      }
      if (!r) return { ok: false, porDia, error: `${lastErr} en página ${page} (3 intentos)` };
      const data = await r.json();
      const resultados = Array.isArray(data) ? data : (data.Resultados || []);
      if (!resultados || resultados.length === 0) break;

      let hayMasViejas = false;
      for (const fac of resultados) {
        const m = String(fac.Fecha || "").match(/\/Date\((\d+)/);
        if (!m) continue;
        const ts = parseInt(m[1]);
        if (ts < tsInicio) { hayMasViejas = true; continue; }
        if (ts > tsFin) continue;
        const dia = diaArgDeTs(ts);
        if (!porDia[dia]) porDia[dia] = [];
        porDia[dia].push(...filasDeFactura(fac, dia, local.nombre, ts));
      }
      if (resultados.length < 50 || hayMasViejas) break;
      page++;
    }
    return { ok: true, porDia, error: null };
  } catch (e) {
    return { ok: false, porDia, error: e.message };
  }
}

// Un solo día (para el cron de ingesta)
async function fetchDFDia(local, fecha) {
  const r = await fetchDFRango(local, fecha, fecha);
  return { ok: r.ok, filas: r.porDia[fecha] || [], error: r.error };
}

module.exports = { wooLocales, dfLocales, fetchWooDia, fetchTNDia, fetchDFDia, fetchDFRango, diaSiguiente };
