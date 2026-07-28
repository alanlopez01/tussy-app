// Cliente de las APIs. En dev, vite proxya /api a producción.

export async function getJSON(url, timeoutMs = 50000) {
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

// Serie diaria desde Postgres
export function getSerie(desde, hasta) {
  return getJSON(`/api/metricas?action=serie&desde=${desde}&hasta=${hasta}`);
}

// Top productos desde Postgres
export function getTopProductos(desde, hasta, local) {
  const l = local ? `&local=${encodeURIComponent(local)}` : "";
  return getJSON(`/api/metricas?action=topProductos&desde=${desde}&hasta=${hasta}${l}`);
}

// Ventas de HOY en vivo (desde las fuentes, hasta que el cron llene el día en curso)
export async function getHoyVivo() {
  const hoy = hoyISO();
  const [woo, df] = await Promise.allSettled([
    getJSON(`/api/ventas?desde=${hoy}&hasta=${hoy}`, 30000),
    getJSON(`/api/dragonfish?action=ventas&desde=${hoy}&hasta=${hoy}`, 55000),
  ]);
  return {
    woo: woo.status === "fulfilled" ? woo.value : null,
    df: df.status === "fulfilled" ? df.value : null,
  };
}

export const LOCALES = [
  { key: "palermo", nombre: "Palermo",  color: "var(--color-s-palermo)" },
  { key: "laplata", nombre: "La Plata", color: "var(--color-s-laplata)" },
  { key: "online",  nombre: "Online",   color: "var(--color-s-online)" },
  { key: "dot",     nombre: "Dot",      color: "var(--color-s-dot)" },
  { key: "abasto",  nombre: "Abasto",   color: "var(--color-s-abasto)" },
  { key: "cordoba", nombre: "Córdoba",  color: "var(--color-s-cordoba)" },
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
