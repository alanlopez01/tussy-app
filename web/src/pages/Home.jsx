import { useCallback, useEffect, useMemo, useState } from "react";
import { getSerie, getJSON, hoyISO, diasAtras, primerDiaMes, mesAnteriorRango, LOCALES, fmtPesos, fmtPesosCorto } from "../lib/api.js";
import { Card, StatTile, Spinner, LeyendaLocal, BotonActualizar } from "../components/ui.jsx";
import { BarrasApiladas, FilaRanking, Medidor } from "../components/graficos.jsx";

function fechaCorta(iso) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${parseInt(m)}`;
}

function fechaLarga(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("es-AR",
    { weekday: "long", day: "numeric", month: "long" });
}


// Proyección de cierre del mes por local, contra la meta (editable acá mismo).
// La proyección usa la forma de los últimos 3 meses: qué % del mes suele estar
// vendido a esta altura.
function ComoVieneElMes({ refreshKey }) {
  const [data, setData] = useState(null);
  const [editando, setEditando] = useState(null);
  const [valor, setValor] = useState("");

  const cargar = useCallback(() => {
    getJSON("/api/metricas?action=proyeccion", 30000).then(setData).catch(() => setData(null));
  }, []);
  // Se actualiza junto con el resto del Home (cada Actualizar / recarga)
  useEffect(() => { cargar(); }, [cargar, refreshKey]);

  if (!data) return null;
  const guardar = async (local) => {
    const monto = Math.round(Number(valor.replace(/\./g, "")) || 0);
    setEditando(null);
    if (!monto) return;
    try {
      const t = localStorage.getItem("tussy_token");
      await fetch("/api/metricas?action=guardarMeta", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(t ? { "X-Tussy-Auth": t } : {}) },
        body: JSON.stringify({ mes: data.mes, local, monto }),
      });
      cargar();
    } catch { /* la recarga siguiente lo muestra */ }
  };
  const nombre = l => l === "Tiendanube" ? "Online" : l;

  return (
    <Card title={`Cómo viene ${new Date(data.mes + "-15T12:00:00Z").toLocaleDateString("es-AR", { month: "long" })}`}
          right={<span className="text-[11px] text-ink-3">acumulado en vivo · proyección con {data.dia} día{data.dia === 1 ? "" : "s"} completo{data.dia === 1 ? "" : "s"} · tocá la meta para editarla</span>}>
      {data.temprano && (
        <p className="text-[11px] text-warn font-medium mb-2">
          Muy temprano en el mes: la proyección todavía es poco confiable.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[480px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
              <th className="text-left py-1.5 font-semibold">Local</th>
              <th className="text-right py-1.5 font-semibold">Acumulado</th>
              <th className="text-right py-1.5 font-semibold">Proyección</th>
              <th className="text-right py-1.5 font-semibold">Meta</th>
              <th className="text-right py-1.5 font-semibold">vs. meta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-borde">
            {data.locales.map(l => (
              <tr key={l.local}>
                <td className="py-1.5 font-semibold text-ink">{nombre(l.local)}</td>
                <td className="py-1.5 text-right tabular-nums text-ink-2">{fmtPesosCorto(l.acumulado)}</td>
                <td className="py-1.5 text-right tabular-nums font-semibold text-ink">
                  {l.proyeccion != null ? fmtPesosCorto(l.proyeccion) : "—"}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {editando === l.local ? (
                    <input autoFocus value={valor} onChange={e => setValor(e.target.value)}
                           onBlur={() => guardar(l.local)}
                           onKeyDown={e => e.key === "Enter" && guardar(l.local)}
                           inputMode="numeric" placeholder="monto del mes"
                           className="w-28 rounded border border-borde bg-surface-1 px-2 py-0.5 text-right text-[12px]" />
                  ) : (
                    <button onClick={() => { setEditando(l.local); setValor(l.meta ? String(l.meta) : ""); }}
                            className="text-ink-2 underline decoration-dotted underline-offset-2">
                      {l.meta ? fmtPesosCorto(l.meta) : "fijar"}
                    </button>
                  )}
                </td>
                <td className="py-1.5 pl-3">
                  {l.vs_meta_pct != null ? (
                    <div className="flex items-center gap-2 justify-end">
                      <div className="w-16 shrink-0"><Medidor valor={l.vs_meta_pct} meta={100} alto={6} /></div>
                      <span className={`w-10 text-right tabular-nums font-bold ${
                        l.vs_meta_pct >= 100 ? "text-ok" : l.vs_meta_pct >= 90 ? "text-warn" : "text-bad"}`}>
                        {l.vs_meta_pct}%
                      </span>
                    </div>
                  ) : <span className="block text-right text-ink-3">—</span>}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-borde">
              <td className="py-1.5 font-bold text-ink">TOTAL</td>
              <td className="py-1.5 text-right tabular-nums font-bold">{fmtPesosCorto(data.total.acumulado)}</td>
              <td className="py-1.5 text-right tabular-nums font-bold">
                {data.total.proyeccion != null ? fmtPesosCorto(data.total.proyeccion) : "—"}
              </td>
              <td className="py-1.5 text-right tabular-nums font-bold">
                {data.total.meta != null ? fmtPesosCorto(data.total.meta) : "—"}
              </td>
              <td className={`py-1.5 text-right tabular-nums font-bold ${
                data.total.meta && data.total.proyeccion
                  ? (data.total.proyeccion / data.total.meta >= 1 ? "text-ok" : "text-warn") : "text-ink-3"}`}>
                {data.total.meta && data.total.proyeccion ? Math.round(data.total.proyeccion / data.total.meta * 100) + "%" : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Home() {
  const [serie, setSerie] = useState(null);
  const [hoyVivo, setHoyVivo] = useState(null);
  const [errorSerie, setErrorSerie] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    setErrorSerie(null);
    // Todo sale de la base (el cron la actualiza cada 5 min): carga en <1 segundo.
    // Serie desde el mes anterior completo (comparativas) hasta HOY inclusive.
    const desde = mesAnteriorRango().desde;
    const p1 = getSerie(desde, hoyISO())
      .then(d => setSerie(d.dias.sort((a, b) => a.fecha.localeCompare(b.fecha))))
      .catch(e => setErrorSerie(e.message));
    // Estado de sincronización: para avisar si algún local viene fallando hoy
    const p2 = getJSON("/api/metricas?action=sync", 15000)
      .then(d => setHoyVivo(d.pendientes || []))
      .catch(() => setHoyVivo([]));
    Promise.allSettled([p1, p2]).then(() => setCargando(false));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const hoy = useMemo(() => {
    if (!serie) return null;
    const fila = serie.find(d => d.fecha === hoyISO());
    const stores = LOCALES.map(l => ({
      key: l.key, nombre: l.nombre,
      total: fila ? (fila[l.key] || 0) : 0,
      cargando: false,
    }));
    const total = fila?.total || 0;
    const ops = fila?.ops || 0;
    return { stores, total, ops, ticket: ops > 0 ? total / ops : 0 };
  }, [serie]);

  // Locales con error de sincronización HOY (ej. computadora apagada)
  const localesConError = useMemo(() => {
    if (!hoyVivo) return [];
    const nombres = { "Tiendanube": "Online" };
    return hoyVivo
      .filter(p => p.fecha === hoyISO())
      .map(p => nombres[p.local] || p.local);
  }, [hoyVivo]);

  // Comparativa HOY vs AYER
  const totalAyer = useMemo(() => {
    if (!serie) return null;
    const ayer = serie.find(d => d.fecha === diasAtras(1));
    return ayer ? ayer.total : null;
  }, [serie]);

  // Comparativa MES ACTUAL (1 → hoy, hoy ya incluido en la serie) vs MES ANTERIOR (mismas fechas)
  const mes = useMemo(() => {
    if (!serie) return null;
    const actual = serie.filter(d => d.fecha >= primerDiaMes()).reduce((a, d) => a + d.total, 0);
    const pm = mesAnteriorRango();
    const anterior = serie
      .filter(d => d.fecha >= pm.desde && d.fecha <= pm.hastaMismasFechas)
      .reduce((a, d) => a + d.total, 0);
    return { actual, anterior };
  }, [serie]);

  // Gráfico: SIEMPRE el mes actual completo (día 1 → fin de mes), con hoy en vivo.
  // Los días futuros quedan vacíos pero la línea de tiempo se ve entera.
  const serieGrafico = useMemo(() => {
    const inicio = primerDiaMes();
    const [y, m] = inicio.split("-").map(Number);
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const porFecha = {};
    for (const d of serie || []) if (d.fecha >= inicio) porFecha[d.fecha] = d;
    const dias = [];
    for (let d = 1; d <= ultimoDia; d++) {
      const fecha = `${inicio.slice(0, 8)}${String(d).padStart(2, "0")}`;
      dias.push(porFecha[fecha] || { fecha });
    }
    return dias;
  }, [serie]);

  // El gráfico habla en series, no en filas. La leyenda puede apagar locales;
  // los que quedan NO cambian de color ni de orden.
  const [ocultos, setOcultos] = useState(() => new Set());
  const alternar = useCallback(k => setOcultos(prev => {
    const s = new Set(prev);
    s.has(k) ? s.delete(k) : s.add(k);
    return s.size === LOCALES.length ? prev : s;   // nunca apagar el último
  }), []);
  const SERIES_LOCALES = useMemo(
    () => LOCALES.filter(l => !ocultos.has(l.key))
                 .map(l => ({ key: l.key, nombre: l.nombre, color: l.color })), [ocultos]);

  const datosGrafico = useMemo(() => {
    const h = hoyISO();
    return serieGrafico.map(d => ({
      id: d.fecha,
      etiqueta: fechaCorta(d.fecha),
      sub: fechaLarga(d.fecha),
      valores: d,
      futuro: d.fecha > h,
      hoy: d.fecha === h,
    }));
  }, [serieGrafico]);

  // Lo que lleva cada local en el mes: va en la leyenda, al lado del color.
  const totalesMes = useMemo(() => {
    const t = {};
    for (const l of LOCALES) t[l.key] = serieGrafico.reduce((a, d) => a + (d[l.key] || 0), 0);
    return t;
  }, [serieGrafico]);

  // Ordenado de mayor a menor: la pregunta de este panel es quién vendió más
  // hoy, no cómo se reparte el total —eso lo cuenta el gráfico de abajo.
  const rankingHoy = useMemo(() => {
    const filas = (hoy?.stores || []).map(s => ({
      nombre: s.nombre, total: s.total || 0,
      color: LOCALES.find(l => l.key === s.key)?.color,
    }));
    const tot = filas.reduce((a, f) => a + f.total, 0);
    return filas
      .map(f => ({ ...f, pct: tot > 0 ? Math.round((f.total / tot) * 100) : null }))
      .sort((a, b) => b.total - a.total);
  }, [hoy]);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[30px] md:text-[34px] font-semibold text-ink tracking-[-0.03em] leading-[1.08]">Resumen</h1>
          <p className="text-[12px] text-ink-3">
            <span className="capitalize">{new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
            {" · datos con hasta 5 min de demora"}
          </p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile
          label="Ventas de hoy"
          value={hoy ? fmtPesos(hoy.total) : "…"}
          delta={hoy && totalAyer ? ((hoy.total - totalAyer) / totalAyer) * 100 : null}
          sub={totalAyer ? `ayer: ${fmtPesosCorto(totalAyer)}` : ""}
        />
        <StatTile
          label="Operaciones de hoy"
          value={hoy ? hoy.ops : "…"}
          sub={hoy && hoy.ops > 0 ? `ticket promedio ${fmtPesos(hoy.ticket)}` : ""}
        />
        <StatTile
          label="Facturación del mes"
          value={mes ? fmtPesosCorto(mes.actual) : "…"}
          delta={mes && mes.anterior ? ((mes.actual - mes.anterior) / mes.anterior) * 100 : null}
          sub={mes && mes.anterior ? `mes pasado mismas fechas: ${fmtPesosCorto(mes.anterior)}` : ""}
        />
      </div>

      <ComoVieneElMes refreshKey={serie} />

      <Card title="Ventas de hoy por local" sub="ordenado por lo que lleva vendido cada uno">
        {!hoy ? <Spinner /> : (
          <>
            {rankingHoy.map((b, i) => (
              <FilaRanking key={b.nombre} puesto={i + 1} nombre={b.nombre}
                           sub={b.pct != null ? `${b.pct}% del día` : null}
                           valor={b.total} max={rankingHoy[0]?.total || 0}
                           texto={fmtPesos(b.total)} color={b.color} />
            ))}
            {localesConError.length > 0 && (
              <p className="text-[12px] text-warn font-medium mt-3">
                Sin conexión con: {[...new Set(localesConError)].join(", ")}. El dato se recupera solo cuando vuelva.
              </p>
            )}
          </>
        )}
      </Card>

      <Card
        title={`Facturación diaria · ${new Date().toLocaleDateString("es-AR", { month: "long" })}`}
        sub="el mes entero: lo que falta va rayado, no en cero · tocá un local de la leyenda para sacarlo"
        right={serie && <LeyendaLocal locales={LOCALES} totales={totalesMes} fmt={fmtPesosCorto}
                                      ocultos={ocultos} onToggle={alternar} />}
      >
        {errorSerie ? (
          <p className="text-[13px] text-bad py-6 text-center">No pude leer la base: {errorSerie}</p>
        ) : !serie ? <Spinner /> : (
          // En mobile scrollea horizontal para que cada día siga siendo legible.
          <div className="overflow-x-auto -mx-1 px-1">
            <div style={{ minWidth: serieGrafico.length * 24 + 52 + "px" }}>
              <BarrasApiladas datos={datosGrafico} series={SERIES_LOCALES}
                              fmt={fmtPesos} fmtCorto={fmtPesosCorto} alto={290} />
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
