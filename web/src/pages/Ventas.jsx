import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON, hoyISO, diasAtras, primerDiaMes, LOCALES, fmtPesos, fmtPesosCorto } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, StatTile } from "../components/ui.jsx";

const REFRESH_MS = 120000; // auto-actualiza cada 2 minutos (solo mirando "hoy")


// ── Curva horaria: qué franjas venden, por local y día de semana ──
// Para armar horarios y franqueros con datos. Promedia solo los días en que el
// local abrió (un domingo cerrado no cuenta como $0).
const DOW = [{ d: 1, n: "Lun" }, { d: 2, n: "Mar" }, { d: 3, n: "Mié" }, { d: 4, n: "Jue" },
             { d: 5, n: "Vie" }, { d: 6, n: "Sáb" }, { d: 0, n: "Dom" }];

function CurvaHoraria() {
  const [data, setData] = useState(null);
  const [localKey, setLocalKey] = useState("palermo");

  useEffect(() => {
    getJSON("/api/metricas?action=curvaHoraria", 40000).then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;
  const local = LOCALES.find(l => l.key === localKey);
  const franjas = data.franjas.filter(f => f.local === local.db);
  const diasDe = dow => Number(data.dias.find(x => x.local === local.db && x.dow === dow)?.dias || 0);
  const horas = [...new Set(franjas.map(f => f.h))].sort((a, b) => a - b);
  const prom = {};
  let max = 0;
  for (const f of franjas) {
    const dias = diasDe(f.dow);
    const v = dias > 0 ? f.venta / dias : 0;
    prom[`${f.dow}-${f.h}`] = v;
    if (v > max) max = v;
  }
  const porDia = DOW.map(({ d, n }) => ({
    n, total: horas.reduce((a, h) => a + (prom[`${d}-${h}`] || 0), 0), abierto: diasDe(d) > 0,
  }));
  const mejorDia = porDia.filter(x => x.abierto).sort((a, b) => b.total - a.total)[0];

  return (
    <Card title="Curva horaria · promedio por franja"
          right={<span className="text-[11px] text-ink-3">desde el {data.desde.slice(8, 10)}/{data.desde.slice(5, 7)} · para armar horarios y franqueros</span>}>
      <div className="mb-3">
        <Chips opciones={LOCALES.map(l => ({ value: l.key, label: l.nombre }))}
               valor={localKey} onChange={setLocalKey} />
      </div>
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full min-w-[560px]">
          <thead>
            <tr>
              <th className="text-left py-1 pr-2 text-[10px] uppercase text-ink-3 font-semibold w-10"></th>
              {horas.map(h => (
                <th key={h} className="text-center py-1 text-[10px] text-ink-3 font-semibold">{h}h</th>
              ))}
              <th className="text-right py-1 pl-2 text-[10px] uppercase text-ink-3 font-semibold">Día</th>
            </tr>
          </thead>
          <tbody>
            {DOW.map(({ d, n }) => {
              const abierto = diasDe(d) > 0;
              const totalDia = porDia.find(x => x.n === n)?.total || 0;
              return (
                <tr key={d}>
                  <td className={`py-0.5 pr-2 font-semibold ${abierto ? "text-ink" : "text-ink-3"}`}>{n}</td>
                  {horas.map(h => {
                    const v = prom[`${d}-${h}`] || 0;
                    const int = max > 0 ? v / max : 0;
                    return (
                      <td key={h} className="p-0.5">
                        <div title={`${n} ${h}h · ${fmtPesosCorto(v)} promedio`}
                             className="h-6 rounded-[3px] flex items-center justify-center"
                             style={{ background: abierto && v > 0 ? `rgba(20,20,20,${0.06 + int * 0.84})` : "var(--color-surface)" }}>
                          {int > 0.55 && <span className="text-white text-[9px] font-bold">{Math.round(v / 1000)}</span>}
                        </div>
                      </td>
                    );
                  })}
                  <td className={`py-0.5 pl-2 text-right tabular-nums font-semibold ${abierto ? "text-ink-2" : "text-ink-3"}`}>
                    {abierto ? fmtPesosCorto(totalDia) : "cerrado"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-3 mt-2">
        Más oscuro = más venta promedio en esa franja (el número es en miles). Mejor día:{" "}
        <strong>{mejorDia?.n}</strong> ({fmtPesosCorto(mejorDia?.total || 0)} promedio). Las franjas claras del
        principio y el final del día son las candidatas a revisar horarios; los picos, a reforzar con franqueros.
      </p>
    </Card>
  );
}

export default function Ventas() {
  const [localKey, setLocalKey] = useState("palermo");
  const [periodo, setPeriodo] = useState("hoy"); // hoy | ayer | mes
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ultimaAct, setUltimaAct] = useState(null);
  const timerRef = useRef(null);

  const cargar = useCallback((key, per) => {
    setCargando(true);
    const localDb = LOCALES.find(l => l.key === key)?.db;
    // Siempre desde la base (el cron la actualiza cada 5 min): carga instantánea
    const [desde, hasta] = per === "mes" ? [primerDiaMes(), hoyISO()]
      : per === "ayer" ? [diasAtras(1), diasAtras(1)]
      : [hoyISO(), hoyISO()];
    const lim = per === "mes" ? 60 : 150;
    getJSON(`/api/metricas?action=operaciones&local=${encodeURIComponent(localDb)}&desde=${desde}&hasta=${hasta}&limite=${lim}`, 30000)
      .then(d => { setData(d); setUltimaAct(new Date()); })
      .catch(e => setData({ ok: false, error: e.message, operaciones: [] }))
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => {
    setData(null);
    cargar(localKey, periodo);
    clearInterval(timerRef.current);
    if (periodo === "hoy") {
      timerRef.current = setInterval(() => cargar(localKey, periodo), REFRESH_MS);
    }
    return () => clearInterval(timerRef.current);
  }, [localKey, periodo, cargar]);

  const local = LOCALES.find(l => l.key === localKey);
  const etiquetaPeriodo = periodo === "hoy" ? "hoy" : periodo === "ayer" ? "ayer" : "este mes";
  const esMes = periodo === "mes";

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Ventas</h1>
          <p className="text-[12px] text-ink-3">
            Operaciones por local · datos con hasta 5 min de demora
            {ultimaAct && ` · actualizado ${ultimaAct.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <BotonActualizar onClick={() => cargar(localKey, periodo)} cargando={cargando} />
      </header>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips
          opciones={LOCALES.map(l => ({ value: l.key, label: l.nombre, color: l.color }))}
          valor={localKey}
          onChange={setLocalKey}
        />
        <Chips
          opciones={[{ value: "hoy", label: "Hoy" }, { value: "ayer", label: "Ayer" }, { value: "mes", label: "Este mes" }]}
          valor={periodo}
          onChange={setPeriodo}
        />
      </div>

      {!data ? <Spinner texto={`Consultando ${local?.nombre}…`} /> : !data.ok ? (
        <Card>
          <p className="text-[13px] text-warn py-6 text-center font-medium">
            No pude leer la base ({data.error}). Probá actualizar en unos segundos.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label={`Total · ${local?.nombre} · ${etiquetaPeriodo}`} value={fmtPesos(data.total)} />
            <StatTile label="Operaciones" value={data.ops} />
            <StatTile label="Ticket promedio" value={data.ops > 0 ? fmtPesos(data.total / data.ops) : "—"} />
          </div>

          <Card title={esMes && data.ops > data.operaciones.length
            ? `Últimas ${data.operaciones.length} operaciones de ${data.ops}`
            : `Operaciones (${data.ops})`}>
            {data.operaciones.length === 0 ? (
              <p className="text-[13px] text-ink-3 py-6 text-center">Sin ventas {etiquetaPeriodo} en {local?.nombre}.</p>
            ) : (
              <ul className="divide-y divide-borde">
                {data.operaciones.map(op => (
                  <li key={`${op.fecha || ""}-${op.orden_id}`} className="py-3 flex items-start gap-4">
                    <div className="w-14 shrink-0 pt-0.5">
                      <div className="text-[13px] font-semibold text-ink tabular-nums">{op.hora ? op.hora.slice(0, 5) : "—"}</div>
                      {esMes && op.fecha && (
                        <div className="text-[10px] text-ink-3 tabular-nums">{op.fecha.slice(5).split("-").reverse().join("/")}</div>
                      )}
                      <div className="text-[10px] text-ink-3 truncate" title={op.orden_id}>#{op.orden_id}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      {(op.items || op.productos?.map(p => ({ producto: p })) || []).slice(0, 4).map((it, i) => (
                        <div key={i} className="text-[13px] text-ink-2 truncate">
                          {it.cantidad > 1 ? `${it.cantidad}× ` : ""}{it.producto}
                          {(it.talle || it.color) && (
                            <span className="text-ink-3"> · {[it.color, it.talle].filter(Boolean).join(" / ")}</span>
                          )}
                        </div>
                      ))}
                      {(op.items?.length || 0) > 4 && (
                        <div className="text-[12px] text-ink-3">+{op.items.length - 4} artículos más</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[14px] font-bold text-ink tabular-nums">{fmtPesos(op.total)}</div>
                      <div className="text-[11px] text-ink-3">{op.unidades} {op.unidades === 1 ? "unidad" : "unidades"}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <CurvaHoraria />
    </div>
  );
}
