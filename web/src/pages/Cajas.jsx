// Cajas en efectivo (solo admin) — reemplaza a los Sheets "Finanzas Tussy Definitivo"
// y "Finanzas_Shato_v2". Marcas SIEMPRE separadas. La carga es lo primero: monto,
// categoría como botones (las más usadas primero) y listo.
import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON, postJSON, fmtPesos, hoyISO } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar } from "../components/ui.jsx";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const selectCls = "rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2";
const inputCls = "w-full rounded-md border border-borde bg-surface-1 px-3 py-2 text-[14px] text-ink";

// "1.234.567,89" → 1234567.89 (null si vacío, NaN si inválido). Los puntos son
// siempre separador de miles porque el input formatea mientras se escribe.
function aMonto(s) {
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// Formatea mientras se escribe: "1500000" → "1.500.000", coma para decimales
function formatearMiles(s) {
  const t = String(s ?? "").replace(/[^\d,]/g, "");
  const i = t.indexOf(",");
  let ent = (i >= 0 ? t.slice(0, i) : t).replace(/^0+(?=\d)/, "");
  const dec = i >= 0 ? "," + t.slice(i + 1).replace(/,/g, "").slice(0, 2) : "";
  ent = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return ent + dec;
}

function fechaLinda(iso) {
  if (iso === hoyISO()) return "Hoy";
  const ayer = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  if (iso === ayer) return "Ayer";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "short" });
}

const FORM_VACIO = { id: null, tipo: "egreso", fecha: hoyISO(), categoria: "", nuevaCat: "", detalle: "", monto: "", medio: "Efectivo" };

export default function Cajas() {
  const hoy = new Date();
  const [marca, setMarca] = useState("tussy");
  const [mes, setMes] = useState(hoy.getMonth() + 1);
  const [anio, setAnio] = useState(hoy.getFullYear());
  const [resumen, setResumen] = useState(null);
  const [movs, setMovs] = useState(null);
  const [cats, setCats] = useState({ gasto: [], ingreso: [] });
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(FORM_VACIO);
  const [formError, setFormError] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [flash, setFlash] = useState(null);
  const [masFechaMedio, setMasFechaMedio] = useState(false);
  const montoRef = useRef(null);

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    const qs = `marca=${marca}&mes=${mes}&anio=${anio}`;
    Promise.all([
      getJSON(`/api/cajas?action=resumen&${qs}`),
      getJSON(`/api/cajas?action=movimientos&${qs}`),
      getJSON(`/api/cajas?action=categorias&marca=${marca}`),
    ])
      .then(([r, m, c]) => { setResumen(r); setMovs(m.movimientos); setCats(c); })
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [marca, mes, anio]);

  useEffect(() => { setResumen(null); setMovs(null); cargar(); }, [cargar]);
  useEffect(() => { setForm(f => ({ ...FORM_VACIO, tipo: f.tipo })); setFormError(null); setMasFechaMedio(false); }, [marca]);

  const esGasto = form.tipo === "egreso";
  const listaCats = esGasto ? cats.gasto : cats.ingreso;

  const guardar = async () => {
    setFormError(null);
    const monto = aMonto(form.monto);
    if (monto === null || Number.isNaN(monto) || monto <= 0) { setFormError("Poné un monto válido, ej: 1.500.000"); montoRef.current?.focus(); return; }
    const categoria = form.categoria === "__nueva__" ? form.nuevaCat.trim() : form.categoria;
    if (!categoria) { setFormError("Tocá una categoría"); return; }
    setGuardando(true);
    try {
      const body = { marca, fecha: form.fecha, tipo: form.tipo, categoria, detalle: form.detalle, monto, medio: form.medio };
      if (form.id) await postJSON("/api/cajas?action=editar", { ...body, id: form.id });
      else await postJSON("/api/cajas?action=crear", body);
      setFlash(`✓ ${esGasto ? "Gasto" : "Ingreso"} de ${fmtPesos(monto)} ${form.id ? "guardado" : "cargado"} en ${categoria}`);
      setTimeout(() => setFlash(null), 3500);
      setForm(f => ({ ...FORM_VACIO, tipo: f.tipo }));
      setMasFechaMedio(false);
      cargar();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setGuardando(false);
    }
  };

  const editarMov = (m) => {
    setForm({ id: m.id, tipo: m.tipo, fecha: m.fecha, categoria: m.categoria, nuevaCat: "", detalle: m.detalle || "", monto: formatearMiles(String(m.monto).replace(".", ",")), medio: m.medio || "Efectivo" });
    setMasFechaMedio(true);
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const borrarMov = async (m) => {
    if (!window.confirm(`¿Borrar ${m.tipo === "egreso" ? "gasto" : "ingreso"} de ${fmtPesos(m.monto)} (${m.categoria})?`)) return;
    try { await postJSON("/api/cajas?action=borrar", { id: m.id }); cargar(); }
    catch (e) { setError(e.message); }
  };

  // Movimientos agrupados por día para leer de un vistazo
  const movsFiltrados = (movs || []).filter(m => filtroTipo === "todos" || m.tipo === filtroTipo);
  const porDia = [];
  for (const m of movsFiltrados) {
    if (!porDia.length || porDia[porDia.length - 1].fecha !== m.fecha) porDia.push({ fecha: m.fecha, items: [] });
    porDia[porDia.length - 1].items.push(m);
  }

  const anios = [];
  for (let y = hoy.getFullYear(); y >= 2023; y--) anios.push(y);
  const catBtn = (activa) =>
    `rounded-full px-3 py-1.5 text-[12px] font-semibold border transition-colors ${
      activa ? "bg-negro text-white border-negro" : "bg-surface-1 text-ink-2 border-borde hover:border-ink-3"
    }`;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Cajas</h1>
          <p className="text-[12px] text-ink-3">La caja se carga acá · el Excel ya fue</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      {/* Marca + saldo en una sola franja */}
      <div className="bg-negro text-white rounded-lg px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {[["tussy", "Tussy"], ["shato", "Shato"]].map(([v, l]) => (
            <button key={v} onClick={() => setMarca(v)}
              className={`rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ${
                marca === v ? "bg-white text-negro" : "bg-white/10 text-white/60 hover:text-white"
              }`}>
              {l}
            </button>
          ))}
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/50">Saldo en caja</div>
          <div className="text-[26px] leading-tight font-bold tabular-nums">
            {resumen ? fmtPesos(resumen.saldoActual || 0) : "…"}
          </div>
        </div>
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}
      {flash && (
        <div className="rounded-lg bg-ok/10 border border-ok/40 text-ok px-4 py-3 text-[13px] font-semibold">{flash}</div>
      )}

      {/* Carga rápida: monto → categoría → listo */}
      <Card title={form.id ? "Editar movimiento" : null}>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-2">
            {[["egreso", "− Gasto"], ["ingreso", "+ Ingreso"]].map(([t, l]) => (
              <button key={t} onClick={() => setForm(f => ({ ...f, tipo: t, categoria: "", nuevaCat: "" }))}
                className={`rounded-lg px-3 py-3 text-[15px] font-bold border-2 transition-colors ${
                  form.tipo === t
                    ? t === "egreso" ? "bg-bad/10 border-bad text-bad" : "bg-ok/10 border-ok text-ok"
                    : "border-borde text-ink-3"
                }`}>
                {l}
              </button>
            ))}
          </div>

          <input ref={montoRef} type="text" inputMode="decimal" placeholder="$ 0"
                 value={form.monto} onChange={e => setForm(f => ({ ...f, monto: formatearMiles(e.target.value) }))}
                 className="w-full rounded-lg border-2 border-borde bg-surface-1 px-4 py-3 text-[24px] font-bold text-ink tabular-nums placeholder:text-ink-3/50" />

          <div>
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1.5">
              ¿De qué es este {esGasto ? "gasto" : "ingreso"}?
            </div>
            <div className="flex flex-wrap gap-1.5">
              {listaCats.map(c => (
                <button key={c} onClick={() => setForm(f => ({ ...f, categoria: c }))} className={catBtn(form.categoria === c)}>
                  {c}
                </button>
              ))}
              <button onClick={() => setForm(f => ({ ...f, categoria: "__nueva__" }))} className={catBtn(form.categoria === "__nueva__")}>
                + Nueva
              </button>
            </div>
          </div>

          {form.categoria === "__nueva__" && (
            <input type="text" placeholder="Nombre de la categoría nueva" value={form.nuevaCat}
                   onChange={e => setForm(f => ({ ...f, nuevaCat: e.target.value }))} className={inputCls} />
          )}

          <input type="text" placeholder="Detalle (opcional) · ej: pago taller Luis" value={form.detalle}
                 onChange={e => setForm(f => ({ ...f, detalle: e.target.value }))} className={inputCls} />

          {!masFechaMedio ? (
            <button onClick={() => setMasFechaMedio(true)} className="text-[12px] font-semibold text-ink-3 underline underline-offset-2">
              Es de otra fecha o por transferencia
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Fecha</span>
                <input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Medio</span>
                <select value={form.medio} onChange={e => setForm(f => ({ ...f, medio: e.target.value }))} className={inputCls}>
                  <option>Efectivo</option>
                  <option>Transferencia</option>
                </select>
              </label>
            </div>
          )}

          {formError && <p className="text-[13px] text-bad font-semibold">{formError}</p>}

          <div className="flex gap-2">
            <button onClick={guardar} disabled={guardando}
                    className={`flex-1 rounded-lg px-4 py-3.5 text-[15px] font-bold text-white disabled:opacity-50 ${esGasto ? "bg-bad" : "bg-ok"}`}>
              {guardando ? "Guardando…" : form.id ? "Guardar cambios" : `Cargar ${esGasto ? "gasto" : "ingreso"}`}
            </button>
            {form.id && (
              <button onClick={() => { setForm(f => ({ ...FORM_VACIO, tipo: f.tipo })); setFormError(null); }}
                      className="rounded-lg border border-borde px-4 py-3.5 text-[14px] font-semibold text-ink-2">
                Cancelar
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* Movimientos del mes */}
      <Card
        title={`Movimientos de ${MESES[mes - 1]}`}
        right={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <select value={mes} onChange={e => setMes(parseInt(e.target.value))} className={selectCls}>
              {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={anio} onChange={e => setAnio(parseInt(e.target.value))} className={selectCls}>
              {anios.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        }>
        {resumen && (
          <div className="flex gap-4 pb-3 mb-1 border-b border-borde text-[13px] font-semibold tabular-nums">
            <span className="text-ok">+ {fmtPesos(resumen.totalIngreso)}</span>
            <span className="text-bad">− {fmtPesos(resumen.totalGasto)}</span>
            <span className={`ml-auto ${resumen.neto >= 0 ? "text-ok" : "text-bad"}`}>= {fmtPesos(resumen.neto)}</span>
          </div>
        )}
        <div className="py-2">
          <Chips opciones={[{ value: "todos", label: "Todo" }, { value: "egreso", label: "Gastos" }, { value: "ingreso", label: "Ingresos" }]}
                 valor={filtroTipo} onChange={setFiltroTipo} />
        </div>
        {!movs ? <Spinner texto="Cargando movimientos…" /> : porDia.length === 0 ? (
          <p className="text-[13px] text-ink-3 py-4 text-center">Sin movimientos este mes</p>
        ) : (
          porDia.map(dia => {
            const netoDia = dia.items.reduce((a, m) => a + (m.tipo === "egreso" ? -m.monto : m.monto), 0);
            return (
            <details key={dia.fecha} open={dia.fecha === hoyISO()} className="group">
              <summary className="flex items-center gap-2 cursor-pointer select-none pt-3 pb-1 list-none [&::-webkit-details-marker]:hidden">
                <span className="text-[10px] text-ink-3 transition-transform group-open:rotate-90">▶</span>
                <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-ink-3">{fechaLinda(dia.fecha)}</span>
                <span className="text-[11px] text-ink-3">· {dia.items.length} mov.</span>
                <span className={`ml-auto text-[12px] font-bold tabular-nums ${netoDia >= 0 ? "text-ok" : "text-bad"}`}>
                  {netoDia >= 0 ? "+" : "−"}{fmtPesos(Math.abs(netoDia))}
                </span>
              </summary>
              <ul className="divide-y divide-borde">
                {dia.items.map(m => (
                  <li key={m.id} className="py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{m.detalle || m.categoria}</div>
                      <div className="text-[11px] text-ink-3">
                        {m.categoria}{m.medio === "Transferencia" ? " · transf." : ""}
                      </div>
                    </div>
                    <div className={`text-[13px] font-bold tabular-nums ${m.tipo === "egreso" ? "text-bad" : "text-ok"}`}>
                      {m.tipo === "egreso" ? "−" : "+"}{fmtPesos(m.monto)}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => editarMov(m)} title="Editar"
                              className="text-[12px] px-2 py-1 rounded-md border border-borde text-ink-3 hover:text-ink">✎</button>
                      <button onClick={() => borrarMov(m)} title="Borrar"
                              className="text-[12px] px-2 py-1 rounded-md border border-borde text-ink-3 hover:text-bad">🗑</button>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
            );
          })
        )}
      </Card>
    </div>
  );
}
