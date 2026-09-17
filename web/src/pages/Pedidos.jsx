import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON, LOCALES, fmtPesos } from "../lib/api.js";
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
  const timerRef = useRef(null);

  const cargar = useCallback(() => {
    setCargando(true);
    getJSON("/api/metricas?action=feed&limite=200", 30000)
      .then(d => { setOps(d.operaciones); setResumen(d.resumen || null); setUltimaAct(new Date()); })
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
            Todas las ventas de hoy · se actualiza cada 1 min
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

      {resumen && rol === "admin" && (
        <div className="bg-negro text-white rounded-lg px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/50">Ganancia de hoy</div>
            <div className="text-[26px] leading-tight font-bold tabular-nums">{fmtPesos(resumen.margen)}</div>
            <div className="text-[11px] text-white/50">{String(resumen.margen_pct).replace(".", ",")}% de lo vendido</div>
          </div>
          <div className="text-right text-[11px] text-white/60 tabular-nums leading-relaxed">
            <div>Vendido <span className="text-white font-semibold">{fmtPesos(resumen.total)}</span></div>
            <div>− Mercadería {fmtPesos(resumen.mercaderia)}</div>
            <div>− IVA {fmtPesos(resumen.iva)}</div>
            <div>− Comisiones {fmtPesos(resumen.financiero)}</div>
          </div>
        </div>
      )}

      <Card title={ops ? `Hoy: ${ops.length} ventas · ${fmtPesos(totalHoy)}` : "Ventas de hoy"}>
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
                            [op.medio === "efectivo" ? "Efectivo (sin comisión)" : op.financiero_real
                               ? `Comisión MercadoPago${op.cuotas > 1 ? ` · ${op.cuotas} cuotas` : ""}`
                               : "Comisiones (estimadas)", -op.financiero, "text-ink-2"],
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
