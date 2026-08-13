// Meta Marketing API: métricas diarias por campaña de todas las cuentas
// publicitarias que el usuario del sistema puede ver (solo lectura, ads_read).
// Requiere META_TOKEN en el entorno.

const GRAPH = "https://graph.facebook.com/v23.0";

function metaConfigurada() {
  return !!process.env.META_TOKEN;
}

async function graphGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: process.env.META_TOKEN });
  const r = await fetch(`${GRAPH}${path}?${qs}`, { signal: AbortSignal.timeout(45000) });
  const j = await r.json();
  if (j.error) throw new Error(`Meta ${path}: ${j.error.message}`);
  return j;
}

// Filas diarias por campaña para un rango. Pagina y sigue `paging.next`.
async function insightsDiarios(cuenta, desde, hasta) {
  const filas = [];
  let url = `${GRAPH}/${cuenta}/insights?` + new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since: desde, until: hasta }),
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
    limit: "200",
    access_token: process.env.META_TOKEN,
  });
  while (url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
    const j = await r.json();
    if (j.error) throw new Error(`Meta insights ${cuenta}: ${j.error.message}`);
    for (const c of j.data || []) {
      const acc = tipo => Number((c[tipo] || []).find(a =>
        a.action_type === "omni_purchase" || a.action_type === "purchase")?.value || 0);
      filas.push({
        fecha: c.date_start,
        campania_id: String(c.campaign_id),
        cuenta,
        campania: c.campaign_name || "",
        gasto: Number(c.spend || 0),
        impresiones: Number(c.impressions || 0),
        clicks: Number(c.clicks || 0),
        compras: Math.round(acc("actions")),
        valor_compras: acc("action_values"),
      });
    }
    url = j.paging?.next || null;
  }
  return filas;
}

// Sincroniza un rango a la base para TODAS las cuentas visibles.
// Meta re-atribuye conversiones hasta ~7 días para atrás: el upsert pisa.
async function sincronizarMeta(sql, { desde, hasta }) {
  if (!metaConfigurada()) return { ok: false, motivo: "sin META_TOKEN" };
  const cuentas = (await graphGet("/me/adaccounts", { fields: "id,name" })).data || [];
  let filas = 0;
  for (const cta of cuentas) {
    const rows = await insightsDiarios(cta.id, desde, hasta);
    for (let i = 0; i < rows.length; i += 500) {
      const c = rows.slice(i, i + 500);
      await sql`INSERT INTO meta_insights
        (fecha, campania_id, cuenta, campania, gasto, impresiones, clicks, compras, valor_compras)
        SELECT * FROM UNNEST(
          ${c.map(f => f.fecha)}::date[], ${c.map(f => f.campania_id)}::text[], ${c.map(f => f.cuenta)}::text[],
          ${c.map(f => f.campania)}::text[], ${c.map(f => f.gasto)}::numeric[],
          ${c.map(f => f.impresiones)}::bigint[], ${c.map(f => f.clicks)}::int[],
          ${c.map(f => f.compras)}::int[], ${c.map(f => f.valor_compras)}::numeric[]
        ) ON CONFLICT (fecha, campania_id) DO UPDATE SET
          gasto = EXCLUDED.gasto, impresiones = EXCLUDED.impresiones, clicks = EXCLUDED.clicks,
          compras = EXCLUDED.compras, valor_compras = EXCLUDED.valor_compras,
          campania = EXCLUDED.campania, cuenta = EXCLUDED.cuenta`;
      filas += c.length;
    }
  }
  return { ok: true, cuentas: cuentas.map(c => c.name), filas };
}

// ── Conjunto de productos "NEW IN disponible (auto)" en CATALOGO TUSSY ──
// El filtro por tipo de producto del feed no refleja las categorías de Tiendanube,
// así que el conjunto se mantiene por lista de IDs de producto (grupo de artículos).
// Cada noche se lee la categoría NEW IN de TN y se pisa el filtro: drops nuevos
// entran solos y los repuestos vuelven a pautarse (Meta ya excluye los sin stock).
const NEWIN_SET_ID = "1951727315801085";
// BOLSOS no se excluye: hay bolsos de precio pleno (ej. Bolso TSSY $70k) que sí
// deben pautarse; la exclusión es solo para merchandising barato.
const NEWIN_CATEGORIAS_EXCLUIDAS = new Set([
  "ROPA INTERIOR", "PINES", "LLAVERO", "MEDIAS", "PERFUMINAS", "PAÑUELOS",
]);

async function actualizarConjuntoNewIn() {
  if (!metaConfigurada() || !process.env.TN_ACCESS_TOKEN || !process.env.TN_USER_ID) {
    return { ok: false, motivo: "faltan credenciales Meta o Tiendanube" };
  }
  const H = {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    "User-Agent": "TussyApp (alansergio67@gmail.com)",
  };
  const base = `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}`;
  const ids = [];
  for (let page = 1; page <= 6; page++) {
    const r = await fetch(`${base}/products?per_page=100&page=${page}&published=true`, {
      headers: H, signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) break;
    const lote = await r.json();
    if (!lote.length) break;
    for (const p of lote) {
      const cats = (p.categories || []).map(c => c.name.es || c.name);
      if (cats.includes("NEW IN") && !cats.some(c => NEWIN_CATEGORIAS_EXCLUIDAS.has(c))) {
        ids.push(String(p.id));
      }
    }
    if (lote.length < 100) break;
  }
  if (!ids.length) return { ok: false, motivo: "TN devolvió 0 productos NEW IN, no piso el filtro" };
  const body = new URLSearchParams({
    filter: JSON.stringify({ retailer_product_group_id: { is_any: ids } }),
    access_token: process.env.META_TOKEN,
  });
  const r = await fetch(`${GRAPH}/${NEWIN_SET_ID}`, { method: "POST", body, signal: AbortSignal.timeout(45000) });
  const j = await r.json();
  if (j.error) throw new Error(`Meta set NEW IN: ${j.error.message}`);
  return { ok: true, productos: ids.length };
}

module.exports = { metaConfigurada, sincronizarMeta, actualizarConjuntoNewIn };
