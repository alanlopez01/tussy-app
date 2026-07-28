import { useCallback, useEffect, useRef, useState } from "react";
import { getVentasLive, hoyISO, diasAtras, LOCALES, fmtPesos } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, StatTile } from "../components/ui.jsx";

const REFRESH_MS = 120000; // auto-actualiza cada 2 minutos (solo mirando "hoy")

export default function Ventas() {
  const [localKey, setLocalKey] = useState("palermo");
  const [fecha, setFecha] = useState(hoyISO());
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ultimaAct, setUltimaAct] = useState(null);
  const timerRef = useRef(null);

  const cargar = useCallback((key, f) => {
    setCargando(true);
    getVentasLive(key, f)
      .then(d => { setData(d); setUltimaAct(new Date()); })
      .catch(e => setData({ ok: false, error: e.message, operaciones: [] }))
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => {
    setData(null);
    cargar(localKey, fecha);
    clearInterval(timerRef.current);
    if (fecha === hoyISO()) {
      timerRef.current = setInterval(() => cargar(localKey, fecha), REFRESH_MS);
    }
    return () => clearInterval(timerRef.current);
  }, [localKey, fecha, cargar]);

  const local = LOCALES.find(l => l.key === localKey);
  const esHoy = fecha === hoyISO();

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Ventas</h1>
          <p className="text-[12px] text-ink-3">
            Operaciones por local{esHoy ? " · se actualiza sola cada 2 min" : ""}
            {ultimaAct && ` · actualizado ${ultimaAct.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <BotonActualizar onClick={() => cargar(localKey, fecha)} cargando={cargando} />
      </header>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips
          opciones={LOCALES.map(l => ({ value: l.key, label: l.nombre, color: l.color }))}
          valor={localKey}
          onChange={setLocalKey}
        />
        <div className="flex items-center gap-1.5">
          <Chips
            opciones={[{ value: hoyISO(), label: "Hoy" }, { value: diasAtras(1), label: "Ayer" }]}
            valor={fecha}
            onChange={setFecha}
          />
          <input type="date" value={fecha} max={hoyISO()} onChange={e => e.target.value && setFecha(e.target.value)}
                 className="rounded-md border border-borde bg-surface-1 px-2 py-1.5 text-[12px] font-semibold text-ink-2" />
        </div>
      </div>

      {!data ? <Spinner texto={`Consultando ${local?.nombre}…`} /> : !data.ok ? (
        <Card>
          <p className="text-[13px] text-warn py-6 text-center font-medium">
            {local?.nombre} no responde en este momento ({data.error}).
            {["dot", "abasto", "cordoba"].includes(localKey) && " Si el local está cerrado, la computadora puede estar apagada."}
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label={`Total · ${data.local} · ${esHoy ? "hoy" : fecha}`} value={fmtPesos(data.total)} />
            <StatTile label="Operaciones" value={data.ops} />
            <StatTile label="Ticket promedio" value={data.ops > 0 ? fmtPesos(data.total / data.ops) : "—"} />
          </div>

          <Card title={`Operaciones (${data.ops})`}>
            {data.operaciones.length === 0 ? (
              <p className="text-[13px] text-ink-3 py-6 text-center">
                {esHoy ? `Todavía no hay ventas hoy en ${data.local}.` : `Sin ventas el ${fecha} en ${data.local}.`}
              </p>
            ) : (
              <ul className="divide-y divide-borde">
                {data.operaciones.map(op => (
                  <li key={op.orden_id} className="py-3 flex items-start gap-4">
                    <div className="w-14 shrink-0 pt-0.5">
                      <div className="text-[13px] font-semibold text-ink tabular-nums">{op.hora || "—"}</div>
                      <div className="text-[10px] text-ink-3 truncate" title={op.orden_id}>#{op.orden_id}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      {op.items.slice(0, 4).map((it, i) => (
                        <div key={i} className="text-[13px] text-ink-2 truncate">
                          {it.cantidad > 1 ? `${it.cantidad}× ` : ""}{it.producto}
                          {(it.talle || it.color) && (
                            <span className="text-ink-3"> · {[it.color, it.talle].filter(Boolean).join(" / ")}</span>
                          )}
                        </div>
                      ))}
                      {op.items.length > 4 && (
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
    </div>
  );
}
