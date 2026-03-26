/**
 * API Proxy para Dragonfish (Zoo Logic)
 * Maneja autenticación y consultas de Ventas + Stock para los locales:
 * Dot, Abasto y Córdoba
 *
 * Variables de entorno necesarias en Vercel:
 *   DF_DOT_URL        → ej: http://190.x.x.x:8008
 *   DF_ABASTO_URL     → ej: http://190.x.x.x:8008
 *   DF_CORDOBA_URL    → ej: http://190.x.x.x:8008
 *   DF_ID_CLIENTE     → código del Cliente REST API (ej: "API")
 *   DF_JWTOKEN_DOT    → token autenticado de Dot
 *   DF_JWTOKEN_ABASTO → token autenticado de Abasto
 *   DF_JWTOKEN_CORDOBA→ token autenticado de Córdoba
 *   DF_BASE_DATOS     → nombre de la base de datos (ej: "TUSSY")
 */

// Server-side cache (persists while serverless function is warm)
const _cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCache(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete _cache[key]; return null; }
  return entry.data;
}

function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { action } = req.query;

  // Configuración de locales
  const LOCALES = [
    {
      key: "dot",
      nombre: "Dot",
      url: process.env.DF_DOT_URL,
      token: process.env.DF_JWTOKEN_DOT,
      baseDatos: process.env.DF_BASE_DATOS_DOT || "DOT",
      idCliente: process.env.DF_ID_CLIENTE_DOT || process.env.DF_ID_CLIENTE || "API",
    },
    {
      key: "abasto",
      nombre: "Abasto",
      url: process.env.DF_ABASTO_URL,
      token: process.env.DF_JWTOKEN_ABASTO,
      baseDatos: process.env.DF_BASE_DATOS_ABASTO || "ABASTO",
      idCliente: process.env.DF_ID_CLIENTE_ABASTO || process.env.DF_ID_CLIENTE || "API",
    },
    {
      key: "cordoba",
      nombre: "Córdoba",
      url: process.env.DF_CORDOBA_URL,
      token: process.env.DF_JWTOKEN_CORDOBA,
      baseDatos: process.env.DF_BASE_DATOS_CORDOBA || "CORDOBA",
      idCliente: process.env.DF_ID_CLIENTE_CORDOBA || process.env.DF_ID_CLIENTE || "API",
    },
  ];

  // Verificar que haya al menos una URL configurada
  const localesConfigurados = LOCALES.filter(l => l.url && l.token);
  if (localesConfigurados.length === 0) {
    return res.status(503).json({
      error: "Dragonfish no configurado",
      mensaje: "Configurá DF_DOT_URL, DF_ABASTO_URL y DF_CORDOBA_URL en las variables de entorno de Vercel una vez que tengas el acceso remoto (IP pública o DDNS)."
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  // Usar el token directamente en cada request (v14 no requiere /Autenticar previo)
  async function autenticar(local) {
    return local.token;
  }

  function buildHeaders(sessionToken, baseDatos, idCliente) {
    const h = {
      "Content-Type": "application/json",
      "idCliente": idCliente || "API",
      "Authorization": sessionToken,
    };
    if (baseDatos) h["BaseDeDatos"] = baseDatos;
    return h;
  }

  async function dfFetch(url, token, baseDatos, path, params = {}, sessionToken, idCliente) {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = `${url}/api.Dragonfish${path}${qs ? "?" + qs : ""}`;
    const r = await fetch(fullUrl, {
      headers: buildHeaders(sessionToken || token, baseDatos, idCliente),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}`);
    return r.json();
  }

  // ─── Función: Ventas por fecha ───────────────────────────────────────────────
  // Suma el Total de todas las facturas del período para cada local.
  // Dragonfish filtra por Fecha exacta (DD/MM/YYYY) o podemos usar createdafter/modifiedafter.
  // Para un rango usamos paginación con limit=200.

  // Convierte "/Date(1763780400000-0300)/" a objeto Date
  function parseDFDate(dfDate) {
    if (!dfDate) return null;
    const match = String(dfDate).match(/\/Date\((\d+)([+-]\d+)?\)\//);
    if (!match) return null;
    return new Date(parseInt(match[1]));
  }

  // Convierte "YYYY-MM-DD" a timestamp inicio/fin del día en Argentina (UTC-3)
  function diaARG(fechaStr, esInicio) {
    const [y, m, d] = fechaStr.split("-").map(Number);
    // Argentina es UTC-3, entonces inicio del día ARG = UTC 03:00
    if (esInicio) return new Date(Date.UTC(y, m-1, d, 3, 0, 0));
    // Fin del día ARG = UTC siguiente día 02:59:59
    return new Date(Date.UTC(y, m-1, d+1, 2, 59, 59));
  }

  async function getVentasLocal(local, desde, hasta) {
    const sessionToken = await autenticar(local);

    const tsInicio = diaARG(desde, true).getTime();
    const tsFin    = diaARG(hasta || desde, false).getTime();

    let total = 0;
    let cantidad = 0;
    let ultimosPedidos = [];
    let page = 1;
    let sigue = true;

    while (sigue) {
      try {
        const data = await dfFetch(
          local.url, local.token, local.baseDatos,
          "/Facturaagrupada/",
          { limit: 50, page, sort: "-Fecha" },
          sessionToken, local.idCliente
        );

        const resultados = Array.isArray(data) ? data : (data.Resultados || []);
        if (!resultados || resultados.length === 0) break;

        let hayMasViejas = false;
        for (const f of resultados) {
          const fechaF = parseDFDate(f.Fecha);
          if (fechaF) {
            const ts = fechaF.getTime();
            if (ts < tsInicio) { hayMasViejas = true; continue; }
            if (ts > tsFin) continue;
          }
          const monto = parseFloat(f.Total || 0);
          total += monto;
          cantidad++;
          if (ultimosPedidos.length < 3) {
            ultimosPedidos.push({
              numero: f.Numero || "",
              total: monto,
              estado: `Fac ${f.Letra || ""}${f.PuntoDeVenta || ""}-${f.Numero || ""}`,
              cliente: f.ClienteDescripcion || f.Cliente || "Consumidor Final",
            });
          }
        }

        if (resultados.length < 50 || hayMasViejas) sigue = false;
        else page++;

      } catch (e) {
        return { total: Math.round(total), cantidad, pedidos: ultimosPedidos, error: `page ${page}: ${e.message}` };
      }
    }

    return { total: Math.round(total), cantidad, pedidos: ultimosPedidos };
  }

  async function getStockLocal(local, query) {
    const sessionToken = await autenticar(local);
    const data = await dfFetch(local.url, local.token, local.baseDatos, "/ConsultaStockYPrecios/", {
      query,
      limit: 50,
      stockcero: false,
    }, sessionToken, local.idCliente);

    const rows = Array.isArray(data) ? data : (data.Resultados || []);
    if (!rows.length) return [];

    // Dragonfish returns one row per Articulo+Color+Talle combination.
    // Group by Articulo code to build product → variantes structure.
    const grouped = {};
    for (const row of rows) {
      const code = row.Articulo || "";
      if (!grouped[code]) {
        grouped[code] = {
          nombre: row.ArticuloDescripcion || row.Descripcion || "",
          sku: code,
          variantes: [],
        };
      }
      const color = row.ColorDescripcion || row.Color || "";
      const talle = row.TalleDescripcion || row.Talle || "";
      const stock = parseFloat(row.Stock || 0);
      // Get price from "PUBLICO" list, fallback to row.Precio
      let precio = parseFloat(row.Precio || 0);
      if (Array.isArray(row.Precios)) {
        const pub = row.Precios.find(p => p.Lista === "PUBLICO" || p.Lista === "publico");
        if (pub && pub.Precio > 0) precio = parseFloat(pub.Precio);
      }
      grouped[code].variantes.push({
        atributos: [color, talle].filter(Boolean).join(" / ") || "Único",
        precio,
        stock,
        tiene_stock: stock > 0,
      });
    }

    return Object.values(grouped);
  }

  // ─── ROUTER ──────────────────────────────────────────────────────────────────

  try {
    // ── GET /api/dragonfish?action=ventas&desde=YYYY-MM-DD&hasta=YYYY-MM-DD ──
    if (action === "ventas") {
      const { desde, hasta } = req.query;
      if (!desde) return res.status(400).json({ error: "Falta parámetro 'desde'" });

      const cacheKey = `ventas_${desde}_${hasta}`;
      const cached = getCache(cacheKey);
      if (cached) return res.status(200).json(cached);

      const resultados = await Promise.allSettled(
        localesConfigurados.map(local => getVentasLocal(local, desde, hasta))
      );

      const respuesta = {};
      let totalGeneral = 0;

      localesConfigurados.forEach((local, i) => {
        const r = resultados[i];
        if (r.status === "fulfilled") {
          respuesta[local.key] = {
            nombre: local.nombre,
            total: r.value.total,
            cantidad: r.value.cantidad,
            pedidos: r.value.pedidos,
          };
          if (r.value.error) respuesta[local.key].error = r.value.error;
          totalGeneral += r.value.total;
        } else {
          respuesta[local.key] = {
            nombre: local.nombre,
            total: 0,
            cantidad: 0,
            pedidos: [],
            error: r.reason?.message || "Error de conexión",
          };
        }
      });

      const responseData = { ...respuesta, total: totalGeneral };
      // Solo cachear si hay datos reales (evitar cachear errores o $0)
      const tieneError = Object.values(respuesta).some(v => v.error);
      if (totalGeneral > 0 && !tieneError) setCache(cacheKey, responseData);
      return res.status(200).json(responseData);
    }

    // ── GET /api/dragonfish?action=stock&q=REMERA ──
    if (action === "stock") {
      const { q } = req.query;
      if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: "Ingresá al menos 2 caracteres" });
      }

      const resultados = await Promise.allSettled(
        localesConfigurados.map(local => getStockLocal(local, q.trim()))
      );

      // Consolidar por nombre de producto
      const mapa = {};
      localesConfigurados.forEach((local, i) => {
        const r = resultados[i];
        if (r.status !== "fulfilled") return;
        for (const prod of r.value) {
          const key = prod.nombre.toUpperCase().trim();
          if (!mapa[key]) {
            mapa[key] = {
              nombre: prod.nombre,
              sku: prod.sku,
              locales: {},
            };
          }
          mapa[key].locales[local.key] = prod.variantes;
        }
      });

      return res.status(200).json({
        query: q,
        resultados: Object.values(mapa),
      });
    }

    // ── GET /api/dragonfish?action=comparacion ──
    if (action === "comparacion") {
      const compCacheKey = "comparacion_" + new Date().toISOString().slice(0, 13); // cache per hour
      const compCached = getCache(compCacheKey);
      if (compCached) return res.status(200).json(compCached);

      // Comparación hoy + mes + mes anterior (igual que api/comparacion.js)
      const ahora = new Date();
      const arg = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
      const pad = n => String(n).padStart(2, "0");
      const fd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

      const hoy = fd(arg);
      const inicioMes = `${arg.getUTCFullYear()}-${pad(arg.getUTCMonth() + 1)}-01`;
      const diaDelMes = arg.getUTCDate();

      const mesAntYear = arg.getUTCMonth() === 0 ? arg.getUTCFullYear() - 1 : arg.getUTCFullYear();
      const mesAntMes  = arg.getUTCMonth() === 0 ? 12 : arg.getUTCMonth();
      const inicioMesAnt = `${mesAntYear}-${pad(mesAntMes)}-01`;
      const ultimoDiaMesAnt = new Date(arg.getUTCFullYear(), arg.getUTCMonth(), 0).getDate();
      const diaComp = Math.min(diaDelMes, ultimoDiaMesAnt);
      const finMesAnt = `${mesAntYear}-${pad(mesAntMes)}-${pad(diaComp)}`;

      const [resHoy, resMes, resAnt] = await Promise.all([
        Promise.allSettled(localesConfigurados.map(l => getVentasLocal(l, hoy, hoy))),
        Promise.allSettled(localesConfigurados.map(l => getVentasLocal(l, inicioMes, hoy))),
        Promise.allSettled(localesConfigurados.map(l => getVentasLocal(l, inicioMesAnt, finMesAnt))),
      ]);

      const proyectar = total => diaDelMes > 0 ? Math.round(total / diaDelMes * 30) : 0;

      const localesData = localesConfigurados.map((local, i) => {
        const hoyData  = resHoy[i].status  === "fulfilled" ? resHoy[i].value  : { total: 0, cantidad: 0 };
        const mesData  = resMes[i].status  === "fulfilled" ? resMes[i].value  : { total: 0, cantidad: 0 };
        const antData  = resAnt[i].status  === "fulfilled" ? resAnt[i].value  : { total: 0, cantidad: 0 };
        return {
          nombre: local.nombre,
          hoy:  { total: hoyData.total,  cantidad: hoyData.cantidad },
          mes:  { total: mesData.total,  cantidad: mesData.cantidad },
          ant:  { total: antData.total,  cantidad: antData.cantidad },
          proyeccion: proyectar(mesData.total),
        };
      });

      const totalHoy = localesData.reduce((s, l) => s + l.hoy.total, 0);
      const totalMes = localesData.reduce((s, l) => s + l.mes.total, 0);
      const totalAnt = localesData.reduce((s, l) => s + l.ant.total, 0);

      const compResult = {
        locales: localesData,
        ranking: [...localesData].sort((a, b) => b.mes.total - a.mes.total),
        totalHoy,
        totalMes,
        totalAnt,
        proyeccionTotal: proyectar(totalMes),
        diaDelMes,
        diasComparados: diaComp,
      };
      setCache(compCacheKey, compResult);
      return res.status(200).json(compResult);
    }

    // ── GET /api/dragonfish?action=debug&local=dot&desde=YYYY-MM-DD&hasta=YYYY-MM-DD ──
    if (action === "debug") {
      const localKey = req.query.local || "dot";
      const desde = req.query.desde || new Date().toISOString().slice(0, 10);
      const hasta = req.query.hasta || desde;
      const local = localesConfigurados.find(l => l.key === localKey);
      if (!local) return res.status(404).json({ error: `Local '${localKey}' no configurado` });
      try {
        const sessionToken = await autenticar(local);
        const data = await dfFetch(
          local.url, local.token, local.baseDatos,
          "/Facturaagrupada/",
          { limit: 5, sort: "-Fecha" },
          sessionToken,
          local.idCliente
        );
        const tsI = diaARG(desde, true).getTime();
        const tsF = diaARG(hasta, false).getTime();
        const isArray = Array.isArray(data);
        const resultados = isArray ? data : (data.Resultados || []);
        // Also run getVentasLocal to see actual result
        const ventasResult = await getVentasLocal(local, desde, hasta);
        return res.status(200).json({
          local: local.nombre,
          baseDatos: local.baseDatos,
          responseIsArray: isArray,
          responseKeys: isArray ? "array" : Object.keys(data),
          totalRegistros: data.TotalRegistros || resultados.length,
          primerosRegistros: resultados.slice(0, 5).map(f => {
            const fechaP = parseDFDate(f.Fecha);
            const ts = fechaP ? fechaP.getTime() : null;
            return {
              Numero: f.Numero,
              Fecha_raw: f.Fecha,
              Fecha_parsed: fechaP ? fechaP.toISOString() : null,
              Fecha_ts: ts,
              Total: f.Total,
              Letra: f.Letra,
              pasa_filtro: ts ? (ts >= tsI && ts <= tsF) : "no-ts",
            };
          }),
          ventasResult: ventasResult,
          debug_timestamps: {
            desde: desde,
            hasta: hasta,
            tsInicio: tsI,
            tsFin: tsF,
            tsInicio_date: new Date(tsI).toISOString(),
            tsFin_date: new Date(tsF).toISOString(),
          }
        });
      } catch(e) {
        return res.status(500).json({ error: e.message, stack: e.stack });
      }
    }

    return res.status(400).json({ error: `Acción desconocida: ${action}` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
