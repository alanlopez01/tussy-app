import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON, LOCALES, fmtPesos, hoyISO, diasAtras, primerDiaMes } from "../lib/api.js";
import { Card, Spinner, BotonActualizar, Chips } from "../components/ui.jsx";
import { activarPush, pushActivo, pushSoportado } from "../lib/push.js";

const REFRESH_MS = 60000; // el feed se refresca cada 1 min (solo mirando "hoy")

function rangoDe(clave) {
  const hoy = hoyISO();
  if (clave === "ayer") return { desde: diasAtras(1), hasta: diasAtras(1) };
  if (clave === "7d") return { desde: diasAtras(6), hasta: hoy };
  if (clave === "mes") return { desde: primerDiaMes(), hasta: hoy };
  if (clave === "mes_pasado") {
    const [y, m] = primerDiaMes().split("-").map(Number);
    const pm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const pad = n => String(n).padStart(2, "0");
    const ultimo = new Date(Date.UTC(pm.y, pm.m, 0)).getUTCDate();
    return { desde: `${pm.y}-${pad(pm.m)}-01`, hasta: `${pm.y}-${pad(pm.m)}-${pad(ultimo)}` };
  }
  return { desde: hoy, hasta: hoy };
}
const PERIODOS = [
  { value: "hoy", label: "Hoy" }, { value: "ayer", label: "Ayer" },
  { value: "7d", label: "7 días" }, { value: "mes", label: "Este mes" },
  { value: "mes_pasado", label: "Mes pasado" },
];

function colorDeLocal(nombre) {
  const l = LOCALES.find(l => l.db === nombre || l.nombre === nombre);
  return l?.color || "var(--color-ink-3)";
}
function nombreCorto(nombre) {
  return nombre === "Tiendanube" ? "Online" : nombre;
}
function esIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function Pedidos({ rol }) {
  const [ops, setOps] = useState(null);
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ultimaAct, setUltimaAct] = useState(null);
  const [estadoPush, setEstadoPush] = useState("verificando");
  const [msgPush, setMsgPush] = useState("");
  const [abierta, setAbierta] = useState(null); // orden expandida
  const [periodo, setPeriodo] = useState("hoy");
  const [localFiltro, setLocalFiltro] = useState("todos");
  const [info, setInfo] = useState(null);
  const timerRef = useRef(null);

  const cargar = useCallback(() => {
    setCargando(true);
    const { desde, hasta } = rangoDe(periodo);
    const qs = new URLSearchParams({ action: "feed", limite: "400", desde, hasta });
    if (localFiltro !== "todos") qs.set("local", localFiltro);
    getJSON(`/api/metricas?${qs}`, 60000)
      .then(d => {
        setOps(d.operaciones); setResumen(d.resumen || null);
        setInfo({ ops: d.ops, parcial: d.parcial });
        setUltimaAct(new Date());
      })
      .catch(() => {})
      .finally(() => setCargando(false));
  }, [periodo, localFiltro]);

  useEffect(() => { setOps(null); cargar(); }, [cargar]);

  // El refresco automático solo tiene sentido mirando el día de hoy.
  useEffect(() => {
    clearInterval(timerRef.current);
    if (periodo === "hoy") timerRef.current = setInterval(cargar, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [cargar, periodo]);

  useEffect(() => {
    pushActivo().then(a => setEstadoPush(a ? "activo" : "inactivo")).catch(() => setEstadoPush("inactivo"));
  }, []);

  const activar = async () => {
    setMsgPush("");
    if (!pushSoportado()) {
      setEstadoPush("error");
      setMsgPush(esIOS()
        ? "En iPhone: tocá el botón Compartir de Safari → \"Agregar a pantalla de inicio\". Después abrí la app desde el ícono nuevo y volvé a tocar este botón."
        : "Este navegador no soporta notificaciones. Probá con Chrome, o agregá la app a la pantalla de inicio.");
      return;
    }
    try {
      let nombre = "socio";
      try { nombre = JSON.parse(localStorage.getItem("tussy_sesion"))?.nombre || "socio"; } catch { /* default */ }
      await activarPush(nombre);
      setEstadoPush("activo");
    } catch (e) {
      setEstadoPush("error");
      setMsgPush(e.message);
    }
  };

  const totalHoy = (ops || []).reduce((a, o) => a + o.total, 0);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Pedidos</h1>
          <p className="text-[12px] text-ink-3">
            {periodo === "hoy" ? "Todas las ventas de hoy · se actualiza cada 1 min" : "Ventas del período"}
            {ultimaAct && ` · actualizado ${ultimaAct.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {estadoPush === "activo" ? (
            <span className="text-[12px] font-semibold text-ok">🔔 Notificaciones activas</span>
          ) : (
            <button onClick={activar}
                    className="inline-flex items-center gap-2 rounded-md bg-negro text-white px-3 py-1.5 text-[12px] font-semibold">
              🔔 Activar notificaciones
            </button>
          )}
          <BotonActualizar onClick={cargar} cargando={cargando} />
        </div>
      </header>

      {estadoPush === "error" && msgPush && (
        <Card><p className="text-[12px] text-warn font-medium">{msgPush}</p></Card>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips opciones={PERIODOS} valor={periodo} onChange={setPeriodo} />
        <select value={localFiltro} onChange={e => setLocalFiltro(e.target.value)}
                className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2">
          <option value="todos">Todos los locales</option>
          {LOCALES.map(l => <option key={l.db} value={l.db}>{nombreCorto(l.db)}</option>)}
        </select>
      </div>

      {resumen && rol === "admin" && (
        <div className="bg-negro text-white rounded-lg px-5 py-4">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/50">
                Lo que queda {PERIODOS.find(p => p.value === periodo)?.label.toLowerCase()}
              </div>
              <div className="text-[28px] leading-tight font-bold tabular-nums">{fmtPesos(resumen.margen)}</div>
              <div className="text-[11px] text-white/50">
                {String(resumen.margen_pct).replace(".", ",")}% de {fmtPesos(resumen.total)} vendidos
              </div>
            </div>
            <div className="text-[11px] tabular-nums leading-relaxed min-w-[190px]">
              {[
                ["Mercadería", resumen.mercaderia],
                ["IVA", resumen.iva],
                ["Ingresos brutos", resumen.iibb],
                ["Impuesto al cheque", resumen.cheque],
                ["Comisiones MercadoPago", resumen.comisiones],
              ].map(([etiqueta, valor]) => (
                <div key={etiqueta} className="flex justify-between gap-4 text-white/60">
                  <span>− {etiqueta}</span>
                  <span className="text-white/80">{fmtPesos(valor || 0)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="text-[10px] text-white/40 mt-3 pt-3 border-t border-white/10">
            Antes de alquileres, sueldos y pauta. IVA calculado sobre el valor agregado ({resumen.iva_origen}).
            {resumen.con_dato_real > 0 && ` · ${resumen.con_dato_real} operaciones con la comisión real de MercadoPago.`}
          </div>
        </div>
      )}

      <Card title={ops
        ? (info?.parcial
            ? `Últimas ${ops.length} de ${info.ops} ventas · ${fmtPesos(resumen?.total ?? totalHoy)}`
            : `${ops.length} ventas · ${fmtPesos(resumen?.total ?? totalHoy)}`)
        : "Ventas"}>
        {!ops ? <Spinner /> : !ops.length ? (
          <p className="text-[13px] text-ink-3 py-6 text-center">Todavía no hay ventas registradas hoy.</p>
        ) : (
          <ul className="divide-y divide-borde">
            {ops.map(op => {
              const clave = `${op.local}-${op.orden_id}`;
              const expandida = abierta === clave;
              return (
                <li key={clave}>
                  <button
                    onClick={() => setAbierta(expandida ? null : clave)}
                    className="w-full text-left py-3 flex items-center gap-3 sm:gap-4 cursor-pointer hover:bg-surface/60 rounded-md px-1 -mx-1 transition-colors"
                  >
                    <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: colorDeLocal(op.local) }} />
                    <div className="w-12 shrink-0">
                      <div className="text-[13px] font-semibold text-ink tabular-nums">{op.hora ? op.hora.slice(0, 5) : "—"}</div>
                      {periodo !== "hoy" && op.fecha && (
                        <div className="text-[10px] text-ink-3 tabular-nums">{op.fecha.slice(5).split("-").reverse().join("/")}</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ink">
                        {nombreCorto(op.local)}
                        <span className="text-ink-3 font-normal hidden sm:inline"> · #{op.orden_id}</span>
                      </div>
                      {!expandida && (
                        <div className="text-[12px] text-ink-3 truncate">
                          {(op.items || []).map(i => i.producto).join(", ") || "—"}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[14px] font-bold text-ink tabular-nums">{fmtPesos(op.total)}</div>
                      {op.margen != null ? (
                        <div className={`text-[12px] font-bold tabular-nums ${op.margen > 0 ? "text-ok" : "text-bad"}`}>
                          deja {fmtPesos(op.margen)}
                        </div>
                      ) : (
                        <div className="text-[11px] text-ink-3">{op.unidades} {op.unidades === 1 ? "unidad" : "unidades"}</div>
                      )}
                    </div>
                    <span className={`text-ink-3 text-[11px] shrink-0 transition-transform ${expandida ? "rotate-180" : ""}`}>▾</span>
                  </button>
                  {expandida && (
                    <div className="ml-8 sm:ml-10 mb-3 rounded-md bg-surface px-4 py-3 space-y-1.5">
                      <div className="text-[11px] text-ink-3 sm:hidden">#{op.orden_id}</div>
                      {(op.items || []).map((it, i) => (
                        <div key={i} className="flex items-center justify-between gap-3 text-[12px]">
                          <span className="text-ink-2 min-w-0 truncate">
                            {it.cantidad > 1 ? `${it.cantidad}× ` : ""}{it.producto}
                            {(it.color || it.talle) && (
                              <span className="text-ink-3"> · {[it.color, it.talle].filter(Boolean).join(" / ")}</span>
                            )}
                          </span>
                          <span className="font-semibold text-ink tabular-nums shrink-0">{fmtPesos(it.total)}</span>
                        </div>
                      ))}
                      {op.total !== (op.items || []).reduce((a, i) => a + Number(i.total || 0), 0) && (
                        <div className="flex items-center justify-between gap-3 text-[12px] border-t border-borde pt-1.5">
                          <span className="text-ink-3">Envío / descuentos</span>
                          <span className="font-semibold text-ink tabular-nums">
                            {fmtPesos(op.total - (op.items || []).reduce((a, i) => a + Number(i.total || 0), 0))}
                          </span>
                        </div>
                      )}
                      {op.margen != null && (
                        <div className="border-t border-borde pt-2 mt-1 space-y-1">
                          {[
                            ["Vendido", op.total, "text-ink"],
                            ["Mercadería", -op.mercaderia, "text-ink-2"],
                            ["IVA", -op.iva, "text-ink-2"],
                            ["Ingresos brutos", -op.iibb, "text-ink-2"],
                            ["Impuesto al cheque", -op.cheque, "text-ink-2"],
                            [op.medio === "efectivo" ? "Efectivo (sin comisión)" : op.financiero_real
                               ? `Comisión MercadoPago${op.cuotas > 1 ? ` · ${op.cuotas} cuotas` : ""}`
                               : "Comisiones (estimadas)", -op.comisiones, "text-ink-2"],
                          ].map(([etiqueta, valor, cls]) => (
                            <div key={etiqueta} className="flex items-center justify-between gap-3 text-[12px]">
                              <span className="text-ink-3">{etiqueta}</span>
                              <span className={`tabular-nums ${cls}`}>{valor < 0 ? "−" : ""}{fmtPesos(Math.abs(valor))}</span>
                            </div>
                          ))}
                          <div className="flex items-center justify-between gap-3 text-[13px] border-t border-borde pt-1.5">
                            <span className="font-semibold text-ink">Nos queda</span>
                            <span className={`font-bold tabular-nums ${op.margen > 0 ? "text-ok" : "text-bad"}`}>
                              {fmtPesos(op.margen)} · {String(op.margen_pct).replace(".", ",")}%
                            </span>
                          </div>
                          {op.falta_costo && (
                            <div className="text-[11px] text-warn">Algún producto no tiene costo cargado: el margen está incompleto.</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
