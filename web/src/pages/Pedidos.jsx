import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON, hoyISO, LOCALES, fmtPesos } from "../lib/api.js";
import { Card, Spinner, BotonActualizar } from "../components/ui.jsx";
import { activarPush, pushActivo, pushSoportado } from "../lib/push.js";

const REFRESH_MS = 60000; // el feed se refresca cada 1 min

function colorDeLocal(nombre) {
  const l = LOCALES.find(l => l.db === nombre || l.nombre === nombre);
  return l?.color || "var(--color-ink-3)";
}
function nombreCorto(nombre) {
  return nombre === "Tiendanube" ? "Online" : nombre;
}

export default function Pedidos() {
  const [ops, setOps] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ultimaAct, setUltimaAct] = useState(null);
  const [estadoPush, setEstadoPush] = useState("verificando"); // verificando | activo | inactivo | error
  const [msgPush, setMsgPush] = useState("");
  const timerRef = useRef(null);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON("/api/metricas?action=feed&limite=60", 30000)
      .then(d => { setOps(d.operaciones); setUltimaAct(new Date()); })
      .catch(() => {})
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => {
    cargar();
    timerRef.current = setInterval(cargar, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [cargar]);

  useEffect(() => {
    pushActivo().then(a => setEstadoPush(a ? "activo" : "inactivo")).catch(() => setEstadoPush("inactivo"));
  }, []);

  const activar = async () => {
    try {
      setMsgPush("");
      let nombre = "socio";
      try { nombre = JSON.parse(localStorage.getItem("tussy_sesion"))?.nombre || "socio"; } catch { /* default */ }
      await activarPush(nombre);
      setEstadoPush("activo");
    } catch (e) {
      setEstadoPush("error");
      setMsgPush(e.message);
    }
  };

  const hoy = hoyISO();

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Pedidos</h1>
          <p className="text-[12px] text-ink-3">
            Ventas de todos los locales a medida que entran · se actualiza cada 1 min
            {ultimaAct && ` · actualizado ${ultimaAct.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {estadoPush !== "activo" && pushSoportado() && (
            <button onClick={activar}
                    className="inline-flex items-center gap-2 rounded-md bg-negro text-white px-3 py-1.5 text-[12px] font-semibold">
              🔔 Activar notificaciones
            </button>
          )}
          {estadoPush === "activo" && (
            <span className="text-[12px] font-semibold text-ok">🔔 Notificaciones activas</span>
          )}
          <BotonActualizar onClick={cargar} cargando={cargando} />
        </div>
      </header>

      {estadoPush === "error" && (
        <Card><p className="text-[12px] text-warn font-medium">{msgPush}</p></Card>
      )}

      <Card title="Últimas operaciones">
        {!ops ? <Spinner /> : !ops.length ? (
          <p className="text-[13px] text-ink-3 py-6 text-center">Sin operaciones registradas en los últimos días.</p>
        ) : (
          <ul className="divide-y divide-borde">
            {ops.map(op => (
              <li key={`${op.local}-${op.orden_id}-${op.fecha}`} className="py-3 flex items-center gap-4">
                <span className="w-1 self-stretch rounded-full" style={{ background: colorDeLocal(op.local) }} />
                <div className="w-16 shrink-0">
                  <div className="text-[13px] font-semibold text-ink tabular-nums">{op.hora ? op.hora.slice(0, 5) : "—"}</div>
                  <div className="text-[10px] text-ink-3">{op.fecha === hoy ? "hoy" : op.fecha.slice(5).split("-").reverse().join("/")}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-ink">
                    {nombreCorto(op.local)}
                    <span className="text-ink-3 font-normal"> · #{op.orden_id}</span>
                  </div>
                  <div className="text-[12px] text-ink-3 truncate">
                    {(op.productos || []).join(", ") || "—"}
                  </div>
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
    </div>
  );
}
