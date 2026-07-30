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

export default function Rentabilidad() {
  const [tab, setTab] = useState("margenes");
  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Rentabilidad</h1>
          <p className="text-[12px] text-ink-3">Margen bruto por modelo · solo visible para vos (en construcción)</p>
        </div>
        <Chips opciones={[{ value: "margenes", label: "Márgenes" }, { value: "costos", label: "Costos" }]}
               valor={tab} onChange={setTab} />
      </header>
      {tab === "margenes" ? <Margenes /> : <Costos />}
    </div>
  );
}
