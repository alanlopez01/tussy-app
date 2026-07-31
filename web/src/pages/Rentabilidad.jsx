import { useCallback, useEffect, useMemo, useState } from "react";
import { getJSON, rangoDe, hoyISO, fmtPesos, fmtPesosCorto, LOCALES } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, StatTile, Paginacion } from "../components/ui.jsx";
import Carga from "./Carga.jsx";

const PERIODOS = [
  { key: "mes", label: "Este mes" },
  { key: "mesPasado", label: "Mes pasado" },
  { key: "7d", label: "Últimos 7 días" },
];
const POR_PAGINA = 15;
const inputCls = "rounded-md border border-borde bg-surface-1 px-2 py-1.5 text-[13px] text-ink w-28 tabular-nums";

function colorMargen(pct) {
  if (pct == null) return "text-ink-3";
  if (pct < 0) return "text-bad";
  if (pct < 30) return "text-warn";
  return "text-ok";
}

// ── Detalle de un producto: cuánto deja según cómo lo paguen ──
function DetalleProducto({ producto, mes, onCerrar }) {
  const [d, setD] = useState(null);
  const [local, setLocal] = useState("Tiendanube");

  useEffect(() => {
    setD(null);
    const l = local ? `&local=${encodeURIComponent(local)}` : "";
    getJSON(`/api/metricas?action=rentabilidadProducto&producto=${encodeURIComponent(producto)}&mes=${mes}${l}`, 25000)
      .then(setD).catch(() => setD({ error: true }));
  }, [producto, mes, local]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <button className="absolute inset-0 bg-black/50" onClick={onCerrar} aria-label="Cerrar" />
      <div className="relative bg-surface-1 rounded-t-2xl sm:rounded-lg w-full sm:max-w-2xl max-h-[88vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-[16px] font-bold text-ink">{producto}</h3>
            <p className="text-[11px] text-ink-3">Rentabilidad por medio de pago · {mes}</p>
          </div>
          <button onClick={onCerrar} className="text-ink-3 text-2xl leading-none px-1">×</button>
        </div>

        {/* Punto de venta: cada local tiene su propia estructura y formas de cobro */}
        <div className="mb-4">
          <Chips
            opciones={LOCALES.map(l => ({ value: l.db, label: l.nombre, color: l.color }))}
            valor={local}
            onChange={setLocal}
          />
        </div>

        {!d ? <Spinner /> : d.error || d.sin_datos ? (
          <p className="text-[13px] text-ink-3 py-8 text-center">
            Sin ventas de este modelo{local ? ` en ${local}` : ""} en el mes.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
              {[["Precio de lista", fmtPesos(d.precio_lista),
                 d.descuento_efectivo_pct > 0 ? `real ${fmtPesos(d.precio_promedio)} (−${d.descuento_efectivo_pct}%)` : null],
                ["Costo mercadería", d.costo_mercaderia != null ? fmtPesos(d.costo_mercaderia) : "—", null],
                ["Fábrica / unidad", d.lleva_estampa ? fmtPesos(d.costo_fabrica) : "—",
                 d.lleva_estampa ? null : "no lleva estampa"],
                ["Costo impositivo", fmtPesos(d.impuesto_monto), `${d.impuesto_pct}% de la venta`],
                ["Estructura por prenda", fmtPesos(d.estructura_unidad),
                 `promedio del punto de venta · ${d.estructura_detalle}`]].map(([l, v, extra]) => (
                <div key={l} className="bg-surface rounded-md px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">{l}</div>
                  <div className="text-[14px] font-bold text-ink tabular-nums">{v}</div>
                  {extra && <div className="text-[10px] text-ink-3 tabular-nums">{extra}</div>}
                </div>
              ))}
            </div>

            {/* Mobile: una fila por escenario, en dos líneas */}
            <div className="sm:hidden divide-y divide-borde">
              {d.escenarios.map(e => (
                <div key={e.key} className="py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] font-semibold text-ink">
                      {e.label}
                      {e.tasa != null && <span className="text-ink-3 font-normal"> · {(e.tasa * 100).toFixed(1)}%</span>}
                    </span>
                    <span className={`text-[14px] font-bold tabular-nums ${e.contribucion >= 0 ? "text-ok" : "text-bad"}`}>
                      {e.contribucion != null ? fmtPesos(e.contribucion) : "—"}
                    </span>
                  </div>
                  <div className="text-[11px] text-ink-3 tabular-nums mt-0.5">
                    entra {fmtPesos(e.ingreso)} · impuestos −{fmtPesos(e.impuestos)} ·{" "}
                    <span className={e.excedente >= 0 ? "text-ok" : "text-warn"}>
                      {e.excedente >= 0 ? "+" : ""}{fmtPesos(e.excedente)} vs. promedio del local
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[12px] min-w-[520px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                    <th className="text-left py-2 font-semibold">Forma de pago</th>
                    <th className="text-right py-2 font-semibold">Entra</th>
                    <th className="text-right py-2 font-semibold">Costo fin.</th>
                    <th className="text-right py-2 font-semibold">Impuestos</th>
                    <th className="text-right py-2 font-semibold">Contribución</th>
                    <th className="text-right py-2 font-semibold">vs. promedio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {d.escenarios.map(e => (
                    <tr key={e.key}>
                      <td className="py-2 pr-3 font-medium text-ink">
                        {e.label}
                        {e.tasa != null && <span className="text-ink-3 font-normal"> · {(e.tasa * 100).toFixed(1)}%</span>}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{fmtPesos(e.ingreso)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3">−{fmtPesos(e.costo_financiero)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3">−{fmtPesos(e.impuestos)}</td>
                      <td className={`py-2 text-right tabular-nums font-bold ${e.contribucion >= 0 ? "text-ok" : "text-bad"}`}>
                        {e.contribucion != null ? `${fmtPesos(e.contribucion)} (${e.margen_contribucion}%)` : "—"}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${e.excedente >= 0 ? "text-ok" : "text-warn"}`}>
                        {e.excedente >= 0 ? "+" : ""}{fmtPesos(e.excedente)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-3 mt-3">
              <strong>Contribución</strong> = lo que entra − mercadería − fábrica − impuestos. Es lo que esa venta
              deja para pagar la estructura: mientras sea positiva, vender conviene. La columna
              <strong> vs. promedio</strong> la compara contra lo que aporta en promedio cada prenda de este punto
              de venta ({fmtPesos(d.estructura_unidad)}); si da negativa, el producto rinde por debajo del promedio
              —no que pierda plata.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab: Márgenes por modelo ──
function Margenes() {
  const [rango, setRango] = useState({ key: "mes", ...rangoDe("mes") });
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [conFabrica, setConFabrica] = useState(true);
  const [detalle, setDetalle] = useState(null);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON(`/api/metricas?action=rentabilidadProductos&desde=${rango.desde}&hasta=${rango.hasta}&conFabrica=${conFabrica ? 1 : 0}`, 30000)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setCargando(false));
  }, [rango, conFabrica]);

  useEffect(() => { setData(null); setPagina(1); cargar(); }, [cargar]);

  const t = data?.totales;
  const margenPct = t && t.venta_con_costo > 0 ? (t.margen / t.venta_con_costo) * 100 : null;
  const totalPaginas = data ? Math.ceil(data.modelos.length / POR_PAGINA) : 0;
  const paginaModelos = data ? data.modelos.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips opciones={PERIODOS.map(p => ({ value: p.key, label: p.label }))} valor={rango.key}
               onChange={k => setRango({ key: k, ...rangoDe(k) })} />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
            <input type="checkbox" checked={conFabrica} onChange={e => setConFabrica(e.target.checked)} />
            Incluir fábrica
            {data?.fabrica_por_unidad > 0 && conFabrica && (
              <span className="text-ink-3 font-normal">({fmtPesos(data.fabrica_por_unidad)}/u)</span>
            )}
          </label>
          <BotonActualizar onClick={cargar} cargando={cargando} />
        </div>
      </div>

      {!data ? <Spinner /> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Venta del período" value={fmtPesosCorto(t.venta)} />
            <StatTile label="Margen bruto (modelos con costo)" value={fmtPesosCorto(t.margen)}
                      sub={margenPct != null ? `${margenPct.toFixed(1)}% sobre ${fmtPesosCorto(t.venta_con_costo)} con costo` : ""} />
            <StatTile label="Modelos sin costo cargado" value={t.modelos_sin_costo}
                      sub={t.modelos_sin_costo > 0 ? "cargalos en la pestaña Costos" : "todos con costo ✓"} />
          </div>

          <Card title="Margen por modelo">
            {/* Mobile: lista compacta en dos líneas por modelo */}
            <div className="sm:hidden divide-y divide-borde">
              {paginaModelos.map(m => (
                <button key={m.producto} onClick={() => setDetalle(m.producto)}
                        className="w-full text-left py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">{m.producto}</div>
                    <div className="text-[11px] text-ink-3 tabular-nums">
                      {m.unidades} u. · venta {fmtPesosCorto(m.venta)}
                      {m.costo != null && ` · costo ${fmtPesosCorto(m.costo)}`}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-[13px] font-bold tabular-nums ${colorMargen(m.margen_pct)}`}>
                      {m.margen_pct != null ? `${m.margen_pct}%` : "—"}
                    </div>
                    <div className="text-[11px] text-ink-3 tabular-nums">
                      {m.margen != null ? fmtPesosCorto(m.margen) : "sin costo"}
                    </div>
                  </div>
                  <span className="text-ink-3 text-[12px] shrink-0">›</span>
                </button>
              ))}
            </div>

            {/* Desktop: tabla completa */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[13px] min-w-[560px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                    <th className="text-left py-2 font-semibold">Modelo</th>
                    <th className="text-right py-2 font-semibold">Unid.</th>
                    <th className="text-right py-2 font-semibold">Venta</th>
                    <th className="text-right py-2 font-semibold">Costo</th>
                    <th className="text-right py-2 font-semibold">Margen</th>
                    <th className="text-right py-2 font-semibold">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {paginaModelos.map(m => (
                    <tr key={m.producto} onClick={() => setDetalle(m.producto)}
                        className="cursor-pointer hover:bg-surface/60 transition-colors">
                      <td className="py-2 pr-3 font-medium text-ink max-w-[220px] truncate">
                        {m.producto}
                        <span className="text-ink-3 font-normal"> ›</span>
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{m.unidades}</td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{fmtPesosCorto(m.venta)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-2">
                        {m.costo != null ? fmtPesosCorto(m.costo) : <span className="text-warn font-semibold">sin costo</span>}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${colorMargen(m.margen_pct)}`}>
                        {m.margen != null ? fmtPesosCorto(m.margen) : "—"}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-bold ${colorMargen(m.margen_pct)}`}>
                        {m.margen_pct != null ? `${m.margen_pct}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginacion pagina={pagina} totalPaginas={totalPaginas} onChange={setPagina} />
            <p className="text-[11px] text-ink-3 mt-3">Tocá cualquier modelo para ver cuánto deja según cómo lo paguen.</p>
          </Card>
        </>
      )}

      {detalle && (
        <DetalleProducto producto={detalle} mes={rango.desde.slice(0, 7)} onCerrar={() => setDetalle(null)} />
      )}
    </div>
  );
}

// ── Tab: Carga de costos ──
function Costos() {
  const [modelos, setModelos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [filtro, setFiltro] = useState("");
  const [edicion, setEdicion] = useState({}); // producto → valor tipeado
  const [guardando, setGuardando] = useState({});

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON("/api/metricas?action=modelosCostos", 30000)
      .then(d => setModelos(d.modelos))
      .catch(() => setModelos([]))
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async (producto) => {
    const valor = parseFloat(edicion[producto]);
    if (isNaN(valor) || valor <= 0) return;
    setGuardando(g => ({ ...g, [producto]: true }));
    try {
      await getJSON(`/api/metricas?action=guardarCosto&producto=${encodeURIComponent(producto)}&costo=${valor}&desde=${hoyISO()}`, 15000);
      setModelos(ms => ms.map(m => m.producto === producto ? { ...m, costo: valor, vigente_desde: hoyISO() } : m));
      setEdicion(e => { const n = { ...e }; delete n[producto]; return n; });
    } finally {
      setGuardando(g => ({ ...g, [producto]: false }));
    }
  };

  const visibles = useMemo(() => {
    if (!modelos) return [];
    const f = filtro.toUpperCase().trim();
    return f ? modelos.filter(m => m.producto.includes(f)) : modelos;
  }, [modelos, filtro]);

  const sinCosto = (modelos || []).filter(m => m.costo == null).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input value={filtro} onChange={e => setFiltro(e.target.value)} placeholder="Buscar modelo…"
               className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[13px] text-ink w-56" />
        <div className="flex items-center gap-3">
          {modelos && <span className="text-[12px] text-ink-3">{sinCosto} de {modelos.length} sin costo</span>}
          <BotonActualizar onClick={cargar} cargando={cargando} />
        </div>
      </div>

      <Card title="Costo unitario por modelo · el costo nuevo rige desde hoy (el histórico conserva el anterior)">
        {!modelos ? <Spinner /> : (
          <ul className="divide-y divide-borde">
            {visibles.map(m => (
              <li key={m.producto} className="py-2.5 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <div className="text-[13px] font-medium text-ink">{m.producto}</div>
                  <div className="text-[11px] text-ink-3">
                    {m.unidades_90d} u. en 90 días
                    {m.costo != null && ` · costo actual ${fmtPesos(m.costo)} (desde ${m.vigente_desde.slice(5).split("-").reverse().join("/")})`}
                    {m.origen?.startsWith("auto:") && (
                      <span className="text-warn"> · asignado por familia: {m.origen.slice(5)}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" inputMode="decimal" placeholder={m.costo != null ? String(m.costo) : "costo $"}
                         value={edicion[m.producto] ?? ""}
                         onChange={e => setEdicion(ed => ({ ...ed, [m.producto]: e.target.value }))}
                         onKeyDown={e => e.key === "Enter" && guardar(m.producto)}
                         className={inputCls} />
                  <button onClick={() => guardar(m.producto)}
                          disabled={guardando[m.producto] || !edicion[m.producto]}
                          className="rounded-md bg-negro text-white px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40">
                    {guardando[m.producto] ? "…" : "Guardar"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── Tab: Resultado por unidad de negocio ──
function Negocio() {
  const [mes, setMes] = useState(hoyISO().slice(0, 7));
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON(`/api/metricas?action=rentabilidadNegocio&mes=${mes}`, 40000)
      .then(setData).catch(() => setData(null)).finally(() => setCargando(false));
  }, [mes]);

  useEffect(() => { setData(null); cargar(); }, [cargar]);

  const meses = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(2026, new Date().getUTCMonth() - i, 1));
    meses.push(d.toISOString().slice(0, 7));
  }
  const nombreMes = m => new Date(m + "-15T12:00:00Z").toLocaleDateString("es-AR", { month: "long", year: "numeric" });

  const t = data?.total;
  const faltaMix = data?.faltan_datos?.mix_pagos || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <select value={mes} onChange={e => setMes(e.target.value)}
                className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2 capitalize">
          {meses.map(m => <option key={m} value={m}>{nombreMes(m)}</option>)}
        </select>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </div>

      {!data ? <Spinner /> : (
        <>
          {faltaMix.length > 0 && (
            <Card>
              <p className="text-[12px] text-warn font-medium">
                Sin reporte de MercadoPago de este mes para: {faltaMix.join(", ")}. El costo financiero
                de esos locales figura en $0 hasta que se cargue.
              </p>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Venta del mes" value={fmtPesosCorto(t.venta)} />
            <StatTile label="Margen bruto" value={fmtPesosCorto(t.margen_bruto)}
                      sub={`${(t.margen_bruto / t.venta * 100).toFixed(1)}% sobre la venta`} />
            <StatTile label="Resultado operativo" value={fmtPesosCorto(t.resultado)}
                      sub={`${t.margen_pct}% sobre la venta`} />
          </div>

          <Card title="Cascada por unidad de negocio">
            {/* Mobile: una tarjeta por unidad — la tabla de 9 columnas no entra */}
            <div className="sm:hidden space-y-3">
              {data.unidades.map(u => {
                const filas = [
                  ["Mercadería (incl. fábrica)", -u.mercaderia],
                  ["Costo financiero", -u.financiero],
                  ...((u.publicidad + u.envios) > 0 ? [["Publicidad y envíos", -(u.publicidad + u.envios)]] : []),
                  ["Fijos", -u.fijos],
                  ["Impuestos", -(u.impuestos || 0)],
                ];
                return (
                  <div key={u.local} className="border border-borde rounded-lg p-3.5">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <span className="text-[14px] font-bold text-ink">
                        {u.local === "Tiendanube" ? "Online" : u.local}
                      </span>
                      <span className="text-[15px] font-bold text-ink tabular-nums">{fmtPesosCorto(u.venta)}</span>
                    </div>
                    {u.detalle_financiero?.tipo === "point" && (
                      <div className="text-[10px] text-ink-3 mb-2">
                        Point {u.detalle_financiero.share_point}% · costo {u.detalle_financiero.pct_point}%
                      </div>
                    )}
                    {u.detalle_financiero?.tipo === "web" && (
                      <div className="text-[10px] text-ink-3 mb-2">costo real {u.detalle_financiero.pct_real}%</div>
                    )}
                    <dl className="space-y-1 py-2 border-t border-borde">
                      {filas.map(([label, valor]) => (
                        <div key={label} className="flex items-center justify-between gap-3">
                          <dt className="text-[12px] text-ink-3">{label}</dt>
                          <dd className="text-[12px] text-ink-2 tabular-nums">{fmtPesosCorto(valor)}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="flex items-center justify-between gap-3 pt-2 border-t border-borde">
                      <span className="text-[12px] font-bold text-ink">Resultado</span>
                      <span className={`text-[15px] font-bold tabular-nums ${u.resultado >= 0 ? "text-ok" : "text-bad"}`}>
                        {fmtPesosCorto(u.resultado)} <span className="text-[12px]">({u.margen_pct}%)</span>
                      </span>
                    </div>
                    {u.equilibrio && (
                      <div className="flex items-center justify-between gap-3 pt-1.5 tabular-nums">
                        <span className="text-[11px] text-ink-3">
                          Equilibrio · {u.equilibrio.unidades.toLocaleString("es-AR")} u. · puede caer{" "}
                          <span className={u.equilibrio.margen_seguridad >= 40 ? "text-ok" : "text-warn"}>
                            {u.equilibrio.margen_seguridad}%
                          </span>
                        </span>
                        <span className="text-[12px] font-semibold text-ink-2">{fmtPesosCorto(u.equilibrio.venta)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="border-2 border-negro rounded-lg p-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[14px] font-bold text-ink">TOTAL</span>
                  <span className="text-[15px] font-bold text-ink tabular-nums">{fmtPesosCorto(t.venta)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 pt-2 mt-2 border-t border-borde">
                  <span className="text-[12px] font-bold text-ink">Resultado</span>
                  <span className={`text-[15px] font-bold tabular-nums ${t.resultado >= 0 ? "text-ok" : "text-bad"}`}>
                    {fmtPesosCorto(t.resultado)} <span className="text-[12px]">({t.margen_pct}%)</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Desktop: tabla completa */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[12px] min-w-[720px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                    <th className="text-left py-2 font-semibold">Unidad</th>
                    <th className="text-right py-2 font-semibold">Venta</th>
                    <th className="text-right py-2 font-semibold">Mercadería*</th>
                    <th className="text-right py-2 font-semibold">Financiero</th>
                    <th className="text-right py-2 font-semibold">Publi+envíos</th>
                    <th className="text-right py-2 font-semibold">Fijos</th>
                    <th className="text-right py-2 font-semibold">Impuestos</th>
                    <th className="text-right py-2 font-semibold">Resultado</th>
                    <th className="text-right py-2 font-semibold">%</th>
                    <th className="text-right py-2 font-semibold">Equilibrio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {data.unidades.map(u => (
                    <tr key={u.local}>
                      <td className="py-2 pr-3 font-semibold text-ink">
                        {u.local === "Tiendanube" ? "Online" : u.local}
                        {u.detalle_financiero?.tipo === "point" && (
                          <span className="block text-[10px] font-normal text-ink-3">
                            Point {u.detalle_financiero.share_point}% · costo {u.detalle_financiero.pct_point}%
                          </span>
                        )}
                        {u.detalle_financiero?.tipo === "web" && (
                          <span className="block text-[10px] font-normal text-ink-3">
                            costo real {u.detalle_financiero.pct_real}%
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{fmtPesosCorto(u.venta)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3">−{fmtPesosCorto(u.mercaderia)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3">−{fmtPesosCorto(u.financiero)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3">
                        {(u.publicidad + u.envios) > 0 ? `−${fmtPesosCorto(u.publicidad + u.envios)}` : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-3">−{fmtPesosCorto(u.fijos)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3" title={u.detalle_impuestos
                        ? `IIBB ${fmtPesos(u.detalle_impuestos.iibb)} · IVA ${fmtPesos(u.detalle_impuestos.iva)} · cargas ${fmtPesos(u.detalle_impuestos.cargas_sociales)}`
                        : ""}>
                        −{fmtPesosCorto(u.impuestos || 0)}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-bold ${u.resultado >= 0 ? "text-ok" : "text-bad"}`}>
                        {fmtPesosCorto(u.resultado)}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-bold ${colorMargen(u.margen_pct)}`}>
                        {u.margen_pct}%
                      </td>
                      <td className="py-2 text-right tabular-nums"
                          title={u.equilibrio ? `Necesita vender ${u.equilibrio.unidades} u. para cubrir sus fijos` : ""}>
                        {u.equilibrio ? (
                          <>
                            <div className="text-ink-2 font-semibold">{fmtPesosCorto(u.equilibrio.venta)}</div>
                            <div className={`text-[10px] ${u.equilibrio.margen_seguridad >= 40 ? "text-ok" : "text-warn"}`}>
                              {u.equilibrio.unidades.toLocaleString("es-AR")} u. · −{u.equilibrio.margen_seguridad}%
                            </div>
                          </>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-ink/20 font-bold">
                    <td className="py-2 text-ink">TOTAL</td>
                    <td className="py-2 text-right tabular-nums text-ink">{fmtPesosCorto(t.venta)}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">−{fmtPesosCorto(t.mercaderia)}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">−{fmtPesosCorto(t.financiero)}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">−{fmtPesosCorto(t.publicidad + t.envios)}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">−{fmtPesosCorto(t.fijos)}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">−{fmtPesosCorto(t.impuestos || 0)}</td>
                    <td className={`py-2 text-right tabular-nums ${t.resultado >= 0 ? "text-ok" : "text-bad"}`}>
                      {fmtPesosCorto(t.resultado)}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${colorMargen(t.margen_pct)}`}>{t.margen_pct}%</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">
                      {fmtPesosCorto(data.unidades.reduce((a, u) => a + (u.equilibrio?.venta || 0), 0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {t.detalle_impuestos && (
              <p className="text-[11px] text-ink-3 mt-3">
                *Mercadería incluye la fábrica de estampado ({fmtPesosCorto(t.fabrica_en_mercaderia || 0)}),
                repartida por prenda estampada: es costo de producción, no del local.
                Impuestos: IIBB {fmtPesosCorto(t.detalle_impuestos.iibb)} ·
                IVA neto {fmtPesosCorto(t.detalle_impuestos.iva)} ·
                cargas sociales {fmtPesosCorto(t.detalle_impuestos.cargas_sociales)}.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Tab: Gastos fijos por local (editables, versionados por mes) ──
function Fijos() {
  const [mes, setMes] = useState(hoyISO().slice(0, 7));
  const [locales, setLocales] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [edicion, setEdicion] = useState({});
  const [guardado, setGuardado] = useState(null);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON(`/api/metricas?action=gastosLocales&mes=${mes}`, 20000)
      .then(d => { setLocales(d.locales); setEdicion({}); })
      .catch(() => setLocales([]))
      .finally(() => setCargando(false));
  }, [mes]);

  useEffect(() => { setLocales(null); cargar(); }, [cargar]);

  const val = (l, campo) => {
    const k = `${l.local}|${campo}`;
    return edicion[k] !== undefined ? edicion[k] : (l.conceptos[campo] ?? 0);
  };
  const setVal = (local, campo, v) => setEdicion(e => ({ ...e, [`${local}|${campo}`]: v }));

  const guardar = async (l) => {
    const conceptos = {};
    for (const c of Object.keys(l.conceptos)) conceptos[c] = parseFloat(val(l, c)) || 0;
    const qs = new URLSearchParams({
      action: "guardarGastoLocal", local: l.local, mes, conceptos: JSON.stringify(conceptos),
    });
    await getJSON(`/api/metricas?${qs}`, 15000);
    setGuardado(l.local);
    setTimeout(() => setGuardado(null), 2500);
    cargar();
  };

  const meses = [];
  for (let i = -1; i < 5; i++) {
    const d = new Date(Date.UTC(2026, new Date().getUTCMonth() - i, 1));
    meses.push(d.toISOString().slice(0, 7));
  }
  const nombreMes = m => new Date(m + "-15T12:00:00Z").toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  const ETIQUETAS = {
    alquiler: "Alquiler", sueldos: "Sueldos", franqueros: "Franqueros",
    impuestos_varios: "Impuestos y varios", empleados: "Empleados", servicios: "Servicios",
    limpieza: "Limpieza", flete: "Flete", supervisor: "Supervisor",
  };
  const TITULOS = { __compartidos__: "Compartidos (se reparten entre locales)", __fabrica__: "Fábrica de estampado (se reparte entre todos los canales)" };
  const inp = "rounded-md border border-borde bg-surface-1 px-2 py-1 text-[12px] text-ink w-full tabular-nums";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <select value={mes} onChange={e => setMes(e.target.value)}
                className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2 capitalize">
          {meses.map(m => <option key={m} value={m}>{nombreMes(m)}</option>)}
        </select>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </div>

      <Card title={`Gastos fijos mensuales · vigencia desde ${nombreMes(mes)}`}>
        <p className="text-[11px] text-ink-3 mb-4">
          Al guardar, los valores rigen desde el mes elegido en adelante. Los meses anteriores conservan
          los suyos, así el histórico no se altera.
        </p>
        {!locales ? <Spinner /> : (
          <div className="space-y-4">
            {locales.map(l => {
              const campos = Object.keys(l.conceptos);
              const total = campos.reduce((a, c) => a + (parseFloat(val(l, c)) || 0), 0);
              const cambiado = campos.some(c => edicion[`${l.local}|${c}`] !== undefined);
              const especial = l.local.startsWith("__");
              return (
                <div key={l.local} className={`border rounded-lg p-4 ${especial ? "border-borde bg-surface/60" : "border-borde"}`}>
                  <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                    <div>
                      <span className="text-[14px] font-bold text-ink">{TITULOS[l.local] || l.local}</span>
                      <span className="text-[11px] text-ink-3 ml-2">
                        desde {l.vigente_desde} · total {fmtPesos(total)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {guardado === l.local && <span className="text-[11px] text-ok font-semibold">Guardado ✓</span>}
                      <button onClick={() => guardar(l)} disabled={!cambiado}
                              className="rounded-md bg-negro text-white px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40">
                        Guardar
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {campos.map(campo => (
                      <label key={campo} className="block">
                        <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">
                          {ETIQUETAS[campo] || campo}
                        </span>
                        <input type="number" inputMode="numeric" className={inp}
                               value={val(l, campo)}
                               onChange={e => setVal(l.local, campo, e.target.value)} />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Tab: Evolución mes a mes ──
function Evolucion() {
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON("/api/metricas?action=evolucion&meses=6", 60000)
      .then(setData).catch(() => setData(null)).finally(() => setCargando(false));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const nombreMes = m => new Date(m + "-15T12:00:00Z")
    .toLocaleDateString("es-AR", { month: "short", year: "2-digit" });

  const ms = data?.meses || [];
  const completos = ms.filter(m => m.completo);
  const incompletos = ms.filter(m => !m.completo);
  const estimados = ms.filter(m => m.completo && m.estimado);
  const ultimo = completos[completos.length - 1] || ms[ms.length - 1];
  const primero = completos[0] || ms[0];
  const varVenta = primero && ultimo && primero.venta > 0
    ? ((ultimo.venta - primero.venta) / primero.venta) * 100 : null;
  const varMargen = primero && ultimo ? ultimo.margen_pct - primero.margen_pct : null;
  const maxVenta = Math.max(...ms.map(m => m.venta), 1);
  const locales = ultimo ? Object.keys(ultimo.por_unidad) : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><BotonActualizar onClick={cargar} cargando={cargando} /></div>

      {!data ? <Spinner texto="Calculando los últimos meses…" /> : !ms.length ? (
        <Card><p className="text-[13px] text-ink-3 py-6 text-center">Sin datos</p></Card>
      ) : (
        <>
          {incompletos.length > 0 && (
            <Card>
              <p className="text-[12px] text-warn font-medium">
                {incompletos.map(m => nombreMes(m.mes)).join(", ")} {incompletos.length === 1 ? "no tiene" : "no tienen"} cargados
                los costos fijos, así que su margen aparece más alto de lo real y no es comparable.
              </p>
            </Card>
          )}
          {estimados.length > 0 && (
            <Card>
              <p className="text-[12px] text-ink-3">
                {estimados.map(m => nombreMes(m.mes)).join(", ")}: costos fijos estimados deflactando los de
                junio por el IPC del INDEC (mar 3,4% · abr 2,6% · may 2,1% · jun 1,9%). Sirven para ver la
                tendencia; cuando cargues los reales en Fijos, se reemplazan.
              </p>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Venta último mes" value={fmtPesosCorto(ultimo.venta)}
                      delta={varVenta} sub={`vs. ${nombreMes(primero.mes)}`} />
            <StatTile label="Resultado último mes" value={fmtPesosCorto(ultimo.resultado)}
                      sub={`${ultimo.margen_pct}% sobre la venta`} />
            <StatTile label="Margen: cambio del período"
                      value={`${varMargen > 0 ? "+" : ""}${varMargen?.toFixed(1)} pts`}
                      sub={`de ${primero.margen_pct}% a ${ultimo.margen_pct}%`} />
          </div>

          <Card title="Venta y resultado por mes">
            <div className="space-y-3">
              {ms.map(m => (
                <div key={m.mes}>
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-[12px] font-semibold text-ink capitalize">
                      {nombreMes(m.mes)}
                      {!m.completo && <span className="text-warn font-normal"> · sin costos fijos</span>}
                      {m.completo && m.estimado && <span className="text-ink-3 font-normal"> · estimado</span>}
                    </span>
                    <span className="text-[12px] text-ink-2 tabular-nums">
                      {fmtPesosCorto(m.venta)} · <span className={m.resultado >= 0 ? "text-ok font-semibold" : "text-bad font-semibold"}>
                        {fmtPesosCorto(m.resultado)} ({m.margen_pct}%)
                      </span>
                    </span>
                  </div>
                  <div className="h-[10px] rounded-[3px] bg-surface overflow-hidden flex">
                    <div className="h-full bg-negro" style={{ width: `${(m.resultado / maxVenta) * 100}%` }} />
                    <div className="h-full bg-borde" style={{ width: `${((m.venta - m.resultado) / maxVenta) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-3 mt-3">La parte oscura es el resultado; el resto, los costos.</p>
          </Card>

          <Card title="Margen por unidad de negocio, mes a mes">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] min-w-[420px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                    <th className="text-left py-2 font-semibold">Unidad</th>
                    {ms.map(m => (
                      <th key={m.mes} className={`text-right py-2 font-semibold capitalize ${m.completo ? "" : "text-warn"}`}>
                        {nombreMes(m.mes)}{!m.completo ? "*" : m.estimado ? "†" : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {locales.map(l => (
                    <tr key={l}>
                      <td className="py-2 pr-3 font-semibold text-ink">{l === "Tiendanube" ? "Online" : l}</td>
                      {ms.map(m => {
                        const u = m.por_unidad[l];
                        return (
                          <td key={m.mes} className={`py-2 text-right tabular-nums font-semibold ${u ? colorMargen(u.margen_pct) : "text-ink-3"}`}>
                            {u ? `${u.margen_pct}%` : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t-2 border-ink/20">
                    <td className="py-2 font-bold text-ink">TOTAL</td>
                    {ms.map(m => (
                      <td key={m.mes} className={`py-2 text-right tabular-nums font-bold ${colorMargen(m.margen_pct)}`}>
                        {m.margen_pct}%
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {(incompletos.length > 0 || estimados.length > 0) && (
              <p className="text-[11px] text-ink-3 mt-3">
                {incompletos.length > 0 && <span className="text-warn">* sin costos fijos cargados. </span>}
                {estimados.length > 0 && "† costos fijos estimados por IPC."}
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Tab: Inventario ──
function Traslados() {
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON("/api/metricas?action=traslados&dias=60", 45000)
      .then(setData).catch(() => setData(null)).finally(() => setCargando(false));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const nom = l => l === "Tiendanube" ? "Online" : l;
  const t = data?.total;

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><BotonActualizar onClick={cargar} cargando={cargando} /></div>

      {!data ? <Spinner texto="Buscando oportunidades…" /> : data.sin_datos ? (
        <Card><p className="text-[13px] text-ink-3 py-6 text-center">Todavía no hay foto de stock.</p></Card>
      ) : !data.sugerencias.length ? (
        <Card><p className="text-[13px] text-ink-3 py-6 text-center">No hay traslados que valgan la pena hoy.</p></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Movimientos sugeridos" value={t.movimientos} />
            <StatTile label="Unidades a mover" value={t.unidades.toLocaleString("es-AR")} />
            <StatTile label="Capital que se reubica" value={fmtPesosCorto(t.capital)}
                      sub="mercadería parada que pasaría a rotar" />
          </div>

          <Card title="Mover de donde no sale a donde se vende">
            <div className="divide-y divide-borde">
              {data.sugerencias.map(s => (
                <div key={`${s.producto}-${s.desde}-${s.hacia}`} className="py-3">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <span className="text-[13px] font-semibold text-ink">{s.producto}</span>
                    <span className="text-[13px] font-bold text-ink tabular-nums">
                      {s.mover} u. · {fmtPesosCorto(s.capital_liberado)}
                    </span>
                  </div>
                  <div className="text-[12px] text-ink-2 mt-1 flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-bad font-semibold">{nom(s.desde)}</span>
                      <span className="text-ink-3">
                        {s.stock_origen} u. paradas
                        {s.dias_inventario_origen ? ` (${s.dias_inventario_origen} días de stock)` : " (sin ventas)"}
                      </span>
                    </span>
                    <span className="text-ink-3">→</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-ok font-semibold">{nom(s.hacia)}</span>
                      <span className="text-ink-3">
                        vendió {s.vendidas_destino} en {data.dias} días
                        {s.stock_destino != null ? ` · le quedan ${s.stock_destino}` : " · stock no visible"}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-3 mt-3">
              Se sugiere mover cuando un local tiene más de 120 días de stock de un modelo y otro lo vende
              con menos de 45. La cantidad cubre 60 días del ritmo del destino sin dejar corto al origen.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function Inventario() {
  const [sub, setSub] = useState("stock");
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [local, setLocal] = useState("");
  const [orden, setOrden] = useState("capital");
  const [pagina, setPagina] = useState(1);

  const cargar = useCallback(() => {
    setCargando(true);
    const l = local ? `&local=${encodeURIComponent(local)}` : "";
    getJSON(`/api/metricas?action=inventario&dias=90${l}`, 45000)
      .then(setData).catch(() => setData(null)).finally(() => setCargando(false));
  }, [local]);
  useEffect(() => { setData(null); setPagina(1); cargar(); }, [cargar]);

  const ordenados = useMemo(() => {
    const m = [...(data?.modelos || [])].filter(x => x.stock > 0);
    if (orden === "capital") return m.sort((a, b) => (b.capital_inmovilizado || 0) - (a.capital_inmovilizado || 0));
    if (orden === "gmroi") return m.sort((a, b) => (a.gmroi ?? 999) - (b.gmroi ?? 999));
    return m.sort((a, b) => (a.rotacion ?? 999) - (b.rotacion ?? 999));
  }, [data, orden]);

  const totalPaginas = Math.ceil(ordenados.length / POR_PAGINA);
  const pag = ordenados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  const t = data?.total;
  const conStock = data?.locales_con_stock || [];

  const colorRot = r => r == null ? "text-ink-3" : r >= 4 ? "text-ok" : r >= 2 ? "text-warn" : "text-bad";

  if (sub === "traslados") {
    return (
      <div className="space-y-4">
        <Chips opciones={[{ value: "stock", label: "Stock" }, { value: "traslados", label: "Traslados" }]}
               valor={sub} onChange={setSub} />
        <Traslados />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Chips opciones={[{ value: "stock", label: "Stock" }, { value: "traslados", label: "Traslados" }]}
             valor={sub} onChange={setSub} />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips
          opciones={[{ value: "", label: "Todos" },
                     ...conStock.map(l => ({ value: l, label: l === "Tiendanube" ? "Online" : l }))]}
          valor={local} onChange={setLocal}
        />
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </div>

      {!data ? <Spinner texto="Leyendo inventario…" /> : data.sin_datos ? (
        <Card><p className="text-[13px] text-ink-3 py-6 text-center">Todavía no hay ninguna foto de stock.</p></Card>
      ) : (
        <>
          {data.locales_sin_stock?.length > 0 && (
            <Card>
              <p className="text-[12px] text-warn font-medium">
                Sin inventario real: {data.locales_sin_stock.map(l =>
                  `${l === "Tiendanube" ? "Online" : l} (${data.motivo_sin_stock?.[l] || "sin datos"})`
                ).join(" · ")}. Todo lo de abajo cubre {conStock.join(", ")}.
              </p>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Capital inmovilizado (a costo)" value={fmtPesosCorto(t.capital)}
                      sub={`${t.unidades.toLocaleString("es-AR")} u. en ${t.modelos} modelos`} />
            <StatTile label="Valor a precio de venta" value={fmtPesosCorto(t.valor_venta)}
                      sub={`${fmtPesosCorto(t.margen_potencial)} de margen si se vende todo`} />
            <StatTile label="Rotación anualizada" value={`${t.rotacion}x`}
                      sub={`GMROI ${t.gmroi} · margen por peso invertido`} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Sin ninguna venta" value={fmtPesosCorto(t.capital_sin_ventas)}
                      sub={`${t.modelos_sin_ventas} modelos · ${fmtPesosCorto(t.venta_sin_ventas)} a precio de venta`} />
            <StatTile label="Rotación lenta (+180 días)" value={fmtPesosCorto(t.capital_lento)}
                      sub={`${t.modelos_lentos} modelos · ${fmtPesosCorto(t.venta_lento)} a precio de venta`} />
            <StatTile label="Recién lanzados" value={fmtPesosCorto(t.capital_nuevo)}
                      sub={`${t.modelos_nuevos} modelos · aún sin historia`} />
          </div>

          <Card title="Inventario por modelo" right={
            <Chips opciones={[{ value: "capital", label: "Más capital" },
                              { value: "rotacion", label: "Menor rotación" },
                              { value: "gmroi", label: "Peor GMROI" }]}
                   valor={orden} onChange={setOrden} />
          }>
            {/* Mobile */}
            <div className="sm:hidden divide-y divide-borde">
              {pag.map(m => (
                <div key={m.producto} className="py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] font-medium text-ink truncate">
                      {m.producto}
                      {m.es_nuevo && <span className="ml-1 text-[9px] uppercase text-ok font-bold">nuevo</span>}
                    </span>
                    <span className="text-[13px] font-bold text-ink tabular-nums shrink-0 text-right">
                      {fmtPesosCorto(m.capital_inmovilizado || 0)}
                      {m.valor_venta ? <span className="block text-[10px] font-normal text-ink-3">
                        {fmtPesosCorto(m.valor_venta)} a p. venta
                      </span> : null}
                    </span>
                  </div>
                  <div className="text-[11px] text-ink-3 tabular-nums mt-0.5">
                    {m.stock} u. · {m.vendidas} vendidas en {m.dias_medidos} d. ·{" "}
                    <span className={colorRot(m.rotacion)}>{m.rotacion != null ? `${m.rotacion}x` : "sin rotar"}</span>
                    {m.dias_inventario != null && ` · ${m.dias_inventario} días`}
                    {m.gmroi != null && ` · GMROI ${m.gmroi}`}
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[12px] min-w-[600px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                    <th className="text-left py-2 font-semibold">Modelo</th>
                    <th className="text-right py-2 font-semibold">Stock</th>
                    <th className="text-right py-2 font-semibold">Vendidas 90d</th>
                    <th className="text-right py-2 font-semibold">Capital</th>
                    <th className="text-right py-2 font-semibold">A p. venta</th>
                    <th className="text-right py-2 font-semibold">Rotación</th>
                    <th className="text-right py-2 font-semibold">Días</th>
                    <th className="text-right py-2 font-semibold">GMROI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {pag.map(m => (
                    <tr key={m.producto}>
                      <td className="py-2 pr-3 font-medium text-ink max-w-[220px] truncate">
                        {m.producto}
                        {m.es_nuevo && (
                          <span className="ml-1.5 text-[9px] uppercase tracking-wide text-ok font-bold">
                            nuevo · {m.dias_desde_lanzamiento}d
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{m.stock}</td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{m.vendidas}</td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{fmtPesosCorto(m.capital_inmovilizado || 0)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-3">{m.valor_venta ? fmtPesosCorto(m.valor_venta) : "—"}</td>
                      <td className={`py-2 text-right tabular-nums font-bold ${colorRot(m.rotacion)}`}>
                        {m.rotacion != null ? `${m.rotacion}x` : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-3">{m.dias_inventario ?? "—"}</td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${m.gmroi == null ? "text-ink-3" : m.gmroi >= 3 ? "text-ok" : m.gmroi >= 1 ? "text-warn" : "text-bad"}`}>
                        {m.gmroi ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginacion pagina={pagina} totalPaginas={totalPaginas} onChange={setPagina} />
            <p className="text-[11px] text-ink-3 mt-3">
              <strong>Capital</strong> es lo que costó la mercadería; <strong>a p. venta</strong>, lo que
              entraría si se vendiera toda a precio de lista. <strong>Rotación</strong>: veces que se renueva el stock en un año, medida sobre los días que el
              modelo estuvo realmente a la venta (un producto que entró hace una semana no se juzga contra 90 días).
              <strong> GMROI</strong>: pesos de margen bruto que genera cada peso invertido en ese stock —
              por encima de 3 es sano, por debajo de 1 el modelo no paga el capital que ocupa.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

export default function Rentabilidad() {
  const [tab, setTab] = useState("negocio");
  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Rentabilidad</h1>
          <p className="text-[12px] text-ink-3">Costos, márgenes e inventario del negocio</p>
        </div>
        <Chips opciones={[{ value: "negocio", label: "Negocio" }, { value: "evolucion", label: "Evolución" },
                          { value: "margenes", label: "Productos" }, { value: "inventario", label: "Inventario" },
                          { value: "costos", label: "Costos" }, { value: "fijos", label: "Fijos" },
                          { value: "carga", label: "Carga" }]}
               valor={tab} onChange={setTab} />
      </header>
      {tab === "negocio" ? <Negocio /> : tab === "evolucion" ? <Evolucion />
        : tab === "margenes" ? <Margenes /> : tab === "inventario" ? <Inventario />
        : tab === "costos" ? <Costos /> : tab === "fijos" ? <Fijos /> : <Carga />}
    </div>
  );
}
