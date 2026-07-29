// Cliente de las APIs. En dev, vite proxya /api a producción.

export async function getJSON(url, timeoutMs = 55000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function hoyISO() {
  // Día en Argentina (UTC-3)
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function diasAtras(n) {
  return new Date(Date.now() - 3 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

export function primerDiaMes() {
  return hoyISO().slice(0, 8) + "01";
}

export function mesAnteriorRango() {
  // Primer día del mes pasado y "mismas fechas": hasta el mismo día del mes que hoy
  const hoy = hoyISO();
  const [y, m, d] = hoy.split("-").map(Number);
  const pm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const ultimoDiaPm = new Date(Date.UTC(pm.y, pm.m, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, "0");
  return {
    desde: `${pm.y}-${pad(pm.m)}-01`,
    hastaMismasFechas: `${pm.y}-${pad(pm.m)}-${pad(Math.min(d, ultimoDiaPm))}`,
    hasta: `${pm.y}-${pad(pm.m)}-${pad(ultimoDiaPm)}`,
  };
}

// Rangos predefinidos para los filtros de fecha
export function rangoDe(key) {
  const hoy = hoyISO();
  switch (key) {
    case "hoy": return { desde: hoy, hasta: hoy };
    case "ayer": return { desde: diasAtras(1), hasta: diasAtras(1) };
    case "7d": return { desde: diasAtras(6), hasta: hoy };
    case "30d": return { desde: diasAtras(29), hasta: hoy };
    case "mes": return { desde: primerDiaMes(), hasta: hoy };
    case "mesPasado": { const r = mesAnteriorRango(); return { desde: r.desde, hasta: r.hasta }; }
    default: return { desde: primerDiaMes(), hasta: hoy };
  }
}

// ── Base Postgres ──
export function getSerie(desde, hasta) {
  return getJSON(`/api/metricas?action=serie&desde=${desde}&hasta=${hasta}`);
}

export function getTopProductos(desde, hasta, { local, orden, limite } = {}) {
  const qs = new URLSearchParams({ action: "topProductos", desde, hasta });
  if (local) qs.set("local", local);
  if (orden) qs.set("orden", orden);
  if (limite) qs.set("limite", limite);
  return getJSON(`/api/metricas?${qs}`);
}

export function getCategorias(desde, hasta, local) {
  const qs = new URLSearchParams({ action: "categorias", desde, hasta });
  if (local) qs.set("local", local);
  return getJSON(`/api/metricas?${qs}`);
}

export function getVariantes(desde, hasta, local) {
  const qs = new URLSearchParams({ action: "variantes", desde, hasta });
  if (local) qs.set("local", local);
  return getJSON(`/api/metricas?${qs}`);
}

// ── Finanzas (Google Sheet, como siempre) ──
export function getDashboardFinanzas(mes, anio, marca = "tussy") {
  const target = marca === "shato" ? "&target=shato" : "";
  const params = encodeURIComponent(JSON.stringify({ mes, anio }));
  return getJSON(`/api/proxy?action=getDashboard&params=${params}${target}`, 30000);
}

export const LOCALES = [
  { key: "palermo", nombre: "Palermo",  db: "Palermo",    color: "var(--color-s-palermo)" },
  { key: "laplata", nombre: "La Plata", db: "La Plata",   color: "var(--color-s-laplata)" },
  { key: "online",  nombre: "Online",   db: "Tiendanube", color: "var(--color-s-online)" },
  { key: "dot",     nombre: "Dot",      db: "Dot",        color: "var(--color-s-dot)" },
  { key: "abasto",  nombre: "Abasto",   db: "Abasto",     color: "var(--color-s-abasto)" },
  { key: "cordoba", nombre: "Córdoba",  db: "Córdoba",    color: "var(--color-s-cordoba)" },
];

export function fmtPesos(n) {
  return "$" + Math.round(n || 0).toLocaleString("es-AR");
}

export function fmtPesosCorto(n) {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toLocaleString("es-AR", { maximumFractionDigits: 1 }) + " M";
  if (Math.abs(v) >= 1e3) return "$" + Math.round(v / 1e3).toLocaleString("es-AR") + " mil";
  return "$" + v.toLocaleString("es-AR");
}
