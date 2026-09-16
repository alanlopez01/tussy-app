// Alertas comerciales (solo admin) — lo que hay que mirar hoy, ordenado por urgencia.
// Las reglas viven en lib/alertas.js y las recalcula el cron todas las noches.
import { useCallback, useEffect, useState } from "react";
import { getJSON } from "../lib/api.js";
import { Card, Spinner, BotonActualizar } from "../components/ui.jsx";

const SEVERIDAD = {
  alta: { label: "Urgente", cls: "bg-bad/10 text-bad border-bad/40", punto: "bg-bad" },
  media: { label: "Esta semana", cls: "bg-warn/10 text-warn border-warn/40", punto: "bg-warn" },
  baja: { label: "En el radar", cls: "bg-surface text-ink-2 border-borde", punto: "bg-ink-3" },
};

export default function Alertas() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [abiertas, setAbiertas] = useState({});

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    getJSON("/api/metricas?action=alertas", 90000)
      .then(d => {
        setData(d);
        // Las urgentes arrancan desplegadas
        setAbiertas(Object.fromEntries(d.alertas.map((a, i) => [i, a.severidad === "alta"])));
      })
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Alertas</h1>
          <p className="text-[12px] text-ink-3">Costos, márgenes, catálogo y pauta · se revisa solo todas las noches</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}

      {!data ? <Spinner texto="Revisando el negocio…" /> : data.alertas.length === 0 ? (
        <Card><p className="text-[14px] text-ok py-8 text-center font-semibold">✓ Todo en orden — nada que revisar hoy</p></Card>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap text-[12px] font-semibold">
            {["alta", "media", "baja"].map(s => data.resumen[s] > 0 && (
              <span key={s} className={`rounded-full border px-3 py-1.5 ${SEVERIDAD[s].cls}`}>
                {data.resumen[s]} {SEVERIDAD[s].label.toLowerCase()}
              </span>
            ))}
            {!data.fuentes.tiendanube && <span className="rounded-full border border-borde px-3 py-1.5 text-ink-3">sin datos de Tiendanube</span>}
            {!data.fuentes.meta && <span className="rounded-full border border-borde px-3 py-1.5 text-ink-3">sin datos de Meta</span>}
          </div>

          {data.alertas.map((a, i) => {
            const sev = SEVERIDAD[a.severidad];
            const abierta = abiertas[i];
            return (
              <Card key={a.tipo + i} className="!p-0 overflow-hidden">
                <button onClick={() => setAbiertas(o => ({ ...o, [i]: !o[i] }))}
                        className="w-full text-left px-5 py-4 flex items-start gap-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev.punto}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-bold text-ink">{a.titulo}</div>
                    <div className="text-[12px] text-ink-3 mt-0.5">{a.detalle}</div>
                  </div>
                  <span className={`text-[11px] text-ink-3 transition-transform ${abierta ? "rotate-90" : ""}`}>▶</span>
                </button>
                {abierta && (
                  <div className="px-5 pb-4 -mt-1">
                    <div className="rounded-md bg-surface px-3.5 py-2.5 mb-3">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-bold">Qué hacer</span>
                      <div className="text-[13px] text-ink font-medium mt-0.5">{a.accion}</div>
                    </div>
                    <ul className="space-y-1.5">
                      {a.items.map((it, j) => (
                        <li key={j} className="text-[12px] text-ink-2 tabular-nums border-l-2 border-borde pl-2.5">
                          {it.texto}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
