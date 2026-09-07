// Cajas en efectivo (solo admin) — carga de ingresos/egresos que reemplaza a los
// Sheets "Finanzas Tussy Definitivo" y "Finanzas_Shato_v2". Marcas SIEMPRE separadas.
import { useCallback, useEffect, useState } from "react";
import { getJSON, postJSON, fmtPesos, hoyISO } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, StatTile } from "../components/ui.jsx";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const selectCls = "rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2";
const inputCls = "w-full rounded-md border border-borde bg-surface-1 px-3 py-2 text-[14px] text-ink";

// "1.234.567,89" o "1234567.89" → 1234567.89 (null si vacío, NaN si inválido)
function aMonto(s) {
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const norm = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = Number(norm);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
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
  useEffect(() => { setForm(f => ({ ...FORM_VACIO, tipo: f.tipo })); setFormError(null); }, [marca]);

  const listaCats = form.tipo === "egreso" ? cats.gasto : cats.ingreso;

  const guardar = async () => {
    setFormError(null);
    const monto = aMonto(form.monto);
    if (monto === null || Number.isNaN(monto) || monto <= 0) { setFormError("Monto inválido — usá formato 1.234.567,89"); return; }
    const categoria = form.categoria === "__nueva__" ? form.nuevaCat.trim() : form.categoria;
    if (!categoria) { setFormError("Elegí o escribí una categoría"); return; }
    setGuardando(true);
    try {
      const body = { marca, fecha: form.fecha, tipo: form.tipo, categoria, detalle: form.detalle, monto, medio: form.medio };
      if (form.id) await postJSON("/api/cajas?action=editar", { ...body, id: form.id });
      else await postJSON("/api/cajas?action=crear", body);
      setForm(f => ({ ...FORM_VACIO, tipo: f.tipo, fecha: f.fecha }));
      cargar();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setGuardando(false);
    }
  };

  const editarMov = (m) => {
    setForm({ id: m.id, tipo: m.tipo, fecha: m.fecha, categoria: m.categoria, nuevaCat: "", detalle: m.detalle || "", monto: String(m.monto).replace(".", ","), medio: m.medio || "Efectivo" });
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const borrarMov = async (m) => {
    if (!window.confirm(`¿Borrar ${m.tipo} de ${fmtPesos(m.monto)} (${m.categoria})?`)) return;
    try { await postJSON("/api/cajas?action=borrar", { id: m.id }); cargar(); }
    catch (e) { setError(e.message); }
  };

  const movsFiltrados = (movs || []).filter(m => filtroTipo === "todos" || m.tipo === filtroTipo);
  const anios = [];
  for (let y = hoy.getFullYear(); y >= 2023; y--) anios.push(y);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Cajas</h1>
          <p className="text-[12px] text-ink-3">Carga de ingresos y egresos en efectivo · reemplaza el Excel</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips
          opciones={[{ value: "tussy", label: "Tussy" }, { value: "shato", label: "Shato" }]}
          valor={marca}
          onChange={setMarca}
        />
        <div className="flex gap-2">
          <select value={mes} onChange={e => setMes(parseInt(e.target.value))} className={selectCls}>
            {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={anio} onChange={e => setAnio(parseInt(e.target.value))} className={selectCls}>
            {anios.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}

      {resumen && (
        <>
          <div className="bg-negro text-white rounded-lg p-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/50">
              Saldo en caja · {marca === "tussy" ? "Tussy" : "Shato"}
            </div>
            <div className="text-[32px] leading-tight font-bold mt-1.5 tabular-nums">{fmtPesos(resumen.saldoActual || 0)}</div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={`Ingresos ${MESES[mes - 1]}`} value={fmtPesos(resumen.totalIngreso)} />
            <StatTile label={`Egresos ${MESES[mes - 1]}`} value={fmtPesos(resumen.totalGasto)} />
            <StatTile label="Neto del mes" value={fmtPesos(resumen.neto)} />
          </div>
        </>
      )}

      <Card title={form.id ? "Editar movimiento" : "Cargar movimiento"}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {["egreso", "ingreso"].map(t => (
              <button key={t} onClick={() => setForm(f => ({ ...f, tipo: t, categoria: "", nuevaCat: "" }))}
                className={`rounded-md px-3 py-2.5 text-[14px] font-bold border transition-colors ${
                  form.tipo === t
                    ? t === "egreso" ? "bg-bad/10 border-bad text-bad" : "bg-ok/10 border-ok text-ok"
                    : "border-borde text-ink-3"
                }`}>
                {t === "egreso" ? "− Egreso" : "+ Ingreso"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Fecha</span>
              <input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} className={inputCls} />
            </label>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Monto ($)</span>
              <input type="text" inputMode="decimal" placeholder="1.234.567,89" value={form.monto}
                     onChange={e => setForm(f => ({ ...f, monto: e.target.value }))} className={`${inputCls} tabular-nums`} />
            </label>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Medio</span>
              <select value={form.medio} onChange={e => setForm(f => ({ ...f, medio: e.target.value }))} className={inputCls}>
                <option>Efectivo</option>
                <option>Transferencia</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Categoría</span>
              <select value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))} className={inputCls}>
                <option value="">Elegir…</option>
                {listaCats.map(c => <option key={c} value={c}>{c}</option>)}
                <option value="__nueva__">+ Nueva categoría</option>
              </select>
            </label>
            {form.categoria === "__nueva__" ? (
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Nombre de la categoría nueva</span>
                <input type="text" value={form.nuevaCat} onChange={e => setForm(f => ({ ...f, nuevaCat: e.target.value }))} className={inputCls} />
              </label>
            ) : (
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Detalle (opcional)</span>
                <input type="text" placeholder="ej: pago taller Luis" value={form.detalle}
                       onChange={e => setForm(f => ({ ...f, detalle: e.target.value }))} className={inputCls} />
              </label>
            )}
          </div>
          {form.categoria === "__nueva__" && (
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Detalle (opcional)</span>
              <input type="text" value={form.detalle} onChange={e => setForm(f => ({ ...f, detalle: e.target.value }))} className={inputCls} />
            </label>
          )}

          {formError && <p className="text-[12px] text-bad font-medium">{formError}</p>}

          <div className="flex gap-2">
            <button onClick={guardar} disabled={guardando}
                    className="flex-1 rounded-md bg-negro text-white px-4 py-2.5 text-[14px] font-bold disabled:opacity-50">
              {guardando ? "Guardando…" : form.id ? "Guardar cambios" : "Cargar"}
            </button>
            {form.id && (
              <button onClick={() => { setForm(f => ({ ...FORM_VACIO, tipo: f.tipo })); setFormError(null); }}
                      className="rounded-md border border-borde px-4 py-2.5 text-[14px] font-semibold text-ink-2">
                Cancelar
              </button>
            )}
          </div>
        </div>
      </Card>

      <Card title={`Movimientos de ${MESES[mes - 1]}`}
            right={<Chips opciones={[{ value: "todos", label: "Todos" }, { value: "ingreso", label: "Ingresos" }, { value: "egreso", label: "Egresos" }]}
                          valor={filtroTipo} onChange={setFiltroTipo} />}>
        {!movs ? <Spinner texto="Cargando movimientos…" /> : movsFiltrados.length === 0 ? (
          <p className="text-[13px] text-ink-3 py-4 text-center">Sin movimientos</p>
        ) : (
          <ul className="divide-y divide-borde">
            {movsFiltrados.map(m => (
              <li key={m.id} className="py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{m.detalle || m.categoria}</div>
                  <div className="text-[11px] text-ink-3">
                    {new Date(m.fecha + "T12:00:00Z").toLocaleDateString("es-AR", { day: "numeric", month: "short" })}
                    {" · "}{m.categoria}{m.medio === "Transferencia" ? " · transf." : ""}{m.usuario ? ` · ${m.usuario}` : ""}
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
        )}
      </Card>
    </div>
  );
}
