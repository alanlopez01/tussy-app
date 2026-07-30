import { useCallback, useEffect, useMemo, useState } from "react";
import { getJSON, rangoDe, hoyISO, fmtPesos, fmtPesosCorto } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, StatTile, Paginacion } from "../components/ui.jsx";

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

// ── Tab: Márgenes por modelo ──
function Margenes() {
  const [rango, setRango] = useState({ key: "mes", ...rangoDe("mes") });
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [pagina, setPagina] = useState(1);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON(`/api/metricas?action=rentabilidadProductos&desde=${rango.desde}&hasta=${rango.hasta}`, 30000)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setCargando(false));
  }, [rango]);

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
        <BotonActualizar onClick={cargar} cargando={cargando} />
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
            <div className="overflow-x-auto">
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
                    <tr key={m.producto}>
                      <td className="py-2 pr-3 font-medium text-ink max-w-[220px] truncate">{m.producto}</td>
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
          </Card>
        </>
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
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] min-w-[720px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                    <th className="text-left py-2 font-semibold">Unidad</th>
                    <th className="text-right py-2 font-semibold">Venta</th>
                    <th className="text-right py-2 font-semibold">Mercadería</th>
                    <th className="text-right py-2 font-semibold">Financiero</th>
                    <th className="text-right py-2 font-semibold">Publi+envíos</th>
                    <th className="text-right py-2 font-semibold">Fijos</th>
                    <th className="text-right py-2 font-semibold">Fábrica</th>
                    <th className="text-right py-2 font-semibold">Resultado</th>
                    <th className="text-right py-2 font-semibold">%</th>
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
                      <td className="py-2 text-right tabular-nums text-ink-3">−{fmtPesosCorto(u.fabrica)}</td>
                      <td className={`py-2 text-right tabular-nums font-bold ${u.resultado >= 0 ? "text-ok" : "text-bad"}`}>
                        {fmtPesosCorto(u.resultado)}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-bold ${colorMargen(u.margen_pct)}`}>
                        {u.margen_pct}%
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
                    <td className="py-2 text-right tabular-nums text-ink-2">−{fmtPesosCorto(t.fabrica)}</td>
                    <td className={`py-2 text-right tabular-nums ${t.resultado >= 0 ? "text-ok" : "text-bad"}`}>
                      {fmtPesosCorto(t.resultado)}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${colorMargen(t.margen_pct)}`}>{t.margen_pct}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-3 mt-3">
              Fábrica de estampado prorrateada por participación en la venta del mes. La fila de cada local
              muestra qué parte cobra por Point y a qué costo real.
            </p>
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

export default function Rentabilidad() {
  const [tab, setTab] = useState("negocio");
  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Rentabilidad</h1>
          <p className="text-[12px] text-ink-3">Solo visible para vos (en construcción)</p>
        </div>
        <Chips opciones={[{ value: "negocio", label: "Negocio" }, { value: "margenes", label: "Productos" },
                          { value: "costos", label: "Costos" }, { value: "fijos", label: "Fijos" }]}
               valor={tab} onChange={setTab} />
      </header>
      {tab === "negocio" ? <Negocio /> : tab === "margenes" ? <Margenes />
        : tab === "costos" ? <Costos /> : <Fijos />}
    </div>
  );
}
