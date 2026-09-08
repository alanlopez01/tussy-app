// RRHH (solo admin) — asistencia día a día y legajos.
// La marca diaria llega sola desde el ERP de locales (los encargados la cargan
// ahí); acá se mira, y se corrige o carga a mano solo por excepción.
import { useCallback, useEffect, useState } from "react";
import { getJSON, postJSON, hoyISO } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar } from "../components/ui.jsx";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const inputCls = "w-full rounded-md border border-borde bg-surface-1 px-3 py-2 text-[14px] text-ink";
const selectCls = "rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2";
const LOCALES_RRHH = ["Palermo", "La Plata", "Dot", "Abasto", "Córdoba", "Supervisión", "Fábrica"];

const ESTADOS = [
  { v: "presente",   l: "P",  nombre: "Presente",   cls: "bg-ok/15 text-ok border-ok/40" },
  { v: "tarde",      l: "T",  nombre: "Tarde",      cls: "bg-warn/15 text-warn border-warn/40" },
  { v: "ausente",    l: "A",  nombre: "Ausente",    cls: "bg-bad/15 text-bad border-bad/40" },
  { v: "franco",     l: "F",  nombre: "Franco",     cls: "bg-surface text-ink-2 border-borde" },
  { v: "vacaciones", l: "V",  nombre: "Vacaciones", cls: "bg-surface text-ink-2 border-borde" },
];
const estadoDef = v => ESTADOS.find(e => e.v === v);

function agruparPorLocal(lista) {
  const grupos = [];
  for (const e of lista) {
    if (!grupos.length || grupos[grupos.length - 1].local !== e.local) grupos.push({ local: e.local, items: [] });
    grupos[grupos.length - 1].items.push(e);
  }
  return grupos;
}

// ── Tab: asistencia del día ──
function Asistencia({ recargarKey }) {
  const [fecha, setFecha] = useState(hoyISO());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editando, setEditando] = useState(null); // { id, estado, minutos, motivo }

  const cargar = useCallback(() => {
    setError(null);
    getJSON(`/api/rrhh?action=asistencia&fecha=${fecha}`)
      .then(setData)
      .catch(e => setError(e.message));
  }, [fecha]);
  useEffect(() => { setData(null); cargar(); }, [cargar, recargarKey]);

  const marcar = async (emp, estado, minutos, motivo) => {
    try {
      await postJSON("/api/rrhh?action=marcar", { empleado_id: emp.id, fecha, estado, minutos_tarde: minutos, motivo });
      setEditando(null);
      cargar();
    } catch (e) { setError(e.message); }
  };
  const desmarcar = async (emp) => {
    try { await postJSON("/api/rrhh?action=desmarcar", { empleado_id: emp.id, fecha }); setEditando(null); cargar(); }
    catch (e) { setError(e.message); }
  };

  const marcados = (data?.empleados || []).filter(e => e.estado);
  const resumen = ESTADOS.map(E => ({ ...E, n: marcados.filter(e => e.estado === E.v).length })).filter(x => x.n > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} className={selectCls} />
        {data && (
          <div className="flex gap-2 flex-wrap text-[12px] font-semibold">
            {resumen.map(r => <span key={r.v} className={`rounded-full border px-2.5 py-1 ${r.cls}`}>{r.n} {r.nombre.toLowerCase()}{r.n > 1 && r.v !== "tarde" ? "s" : ""}</span>)}
            <span className="rounded-full border border-borde px-2.5 py-1 text-ink-3">{(data.empleados.length - marcados.length)} sin marcar</span>
          </div>
        )}
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}
      {!data ? <Spinner texto="Cargando asistencia…" /> : agruparPorLocal(data.empleados).map(g => (
        <Card key={g.local} title={g.local}>
          <ul className="divide-y divide-borde">
            {g.items.map(e => {
              const E = estadoDef(e.estado);
              const abierto = editando?.id === e.id;
              return (
                <li key={e.id} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{e.nombre}</div>
                      <div className="text-[11px] text-ink-3">
                        {e.estado
                          ? `${E.nombre}${e.minutos_tarde ? ` ${e.minutos_tarde}'` : ""}${e.motivo ? ` · ${e.motivo}` : ""}${e.marcado_por ? ` · ${e.marcado_por}` : ""}`
                          : "Sin marcar"}
                      </div>
                    </div>
                    {e.estado && !abierto && (
                      <span className={`rounded-full border px-2.5 py-1 text-[12px] font-bold ${E.cls}`}>{E.l}</span>
                    )}
                    <button onClick={() => setEditando(abierto ? null : { id: e.id, estado: e.estado || "presente", minutos: e.minutos_tarde || "", motivo: e.motivo || "" })}
                            className="text-[12px] px-2 py-1 rounded-md border border-borde text-ink-3 hover:text-ink">
                      {abierto ? "×" : "✎"}
                    </button>
                  </div>
                  {abierto && (
                    <div className="mt-2 space-y-2">
                      <div className="flex gap-1.5 flex-wrap">
                        {ESTADOS.map(E2 => (
                          <button key={E2.v}
                            onClick={() => setEditando(ed => ({ ...ed, estado: E2.v }))}
                            className={`rounded-full border px-3 py-1.5 text-[12px] font-bold ${editando.estado === E2.v ? E2.cls : "border-borde text-ink-3"}`}>
                            {E2.nombre}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        {editando.estado === "tarde" && (
                          <input type="number" inputMode="numeric" placeholder="Min. tarde" value={editando.minutos}
                                 onChange={ev => setEditando(ed => ({ ...ed, minutos: ev.target.value }))}
                                 className={`${inputCls} w-28`} />
                        )}
                        <input type="text" placeholder="Motivo (opcional)" value={editando.motivo}
                               onChange={ev => setEditando(ed => ({ ...ed, motivo: ev.target.value }))} className={inputCls} />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => marcar(e, editando.estado, editando.minutos, editando.motivo)}
                                className="rounded-md bg-negro text-white px-4 py-2 text-[13px] font-bold">Guardar</button>
                        {e.estado && (
                          <button onClick={() => desmarcar(e)}
                                  className="rounded-md border border-borde px-4 py-2 text-[13px] font-semibold text-ink-3">Quitar marca</button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}

// ── Tab: resumen del mes ──
function ResumenMes() {
  const hoy = new Date();
  const [mes, setMes] = useState(hoy.getMonth() + 1);
  const [anio, setAnio] = useState(hoy.getFullYear());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null); setError(null);
    getJSON(`/api/rrhh?action=resumenMes&mes=${mes}&anio=${anio}`)
      .then(setData)
      .catch(e => setError(e.message));
  }, [mes, anio]);

  const anios = [];
  for (let y = hoy.getFullYear(); y >= 2025; y--) anios.push(y);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <select value={mes} onChange={e => setMes(parseInt(e.target.value))} className={selectCls}>
          {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select value={anio} onChange={e => setAnio(parseInt(e.target.value))} className={selectCls}>
          {anios.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}
      {!data ? <Spinner texto="Armando el resumen…" /> : agruparPorLocal(data.empleados).map(g => (
        <Card key={g.local} title={g.local}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-left text-ink-3 uppercase text-[10px] tracking-[0.05em]">
                  <th className="py-1.5 pr-2 font-semibold">Empleado</th>
                  <th className="py-1.5 px-2 font-semibold text-center">Pres.</th>
                  <th className="py-1.5 px-2 font-semibold text-center">Tardes</th>
                  <th className="py-1.5 px-2 font-semibold text-center">Min.</th>
                  <th className="py-1.5 px-2 font-semibold text-center">Aus.</th>
                  <th className="py-1.5 px-2 font-semibold text-center">Francos</th>
                  <th className="py-1.5 pl-2 font-semibold text-center">Vac.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-borde">
                {g.items.map(e => (
                  <tr key={e.id}>
                    <td className="py-2 pr-2 font-medium text-ink">{e.nombre}</td>
                    <td className="py-2 px-2 text-center">{e.presentes || "—"}</td>
                    <td className={`py-2 px-2 text-center font-bold ${e.tardes >= 3 ? "text-warn" : ""}`}>{e.tardes || "—"}</td>
                    <td className="py-2 px-2 text-center text-ink-3">{e.minutos_tarde || ""}</td>
                    <td className={`py-2 px-2 text-center font-bold ${e.ausentes >= 2 ? "text-bad" : ""}`}>{e.ausentes || "—"}</td>
                    <td className="py-2 px-2 text-center">{e.francos || "—"}</td>
                    <td className="py-2 pl-2 text-center">{e.vacaciones || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Tab: legajos ──
const LEGAJO_VACIO = { id: null, nombre: "", local: "Palermo", puesto: "", cuil: "", telefono: "", fecha_ingreso: "", estado: "activo", notas: "" };

function Legajos() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [verBajas, setVerBajas] = useState(false);

  const cargar = useCallback(() => {
    setError(null);
    getJSON(`/api/rrhh?action=empleados&estado=${verBajas ? "todos" : "activo"}`)
      .then(d => setData(d.empleados))
      .catch(e => setError(e.message));
  }, [verBajas]);
  useEffect(() => { setData(null); cargar(); }, [cargar]);

  const guardar = async () => {
    if (!form.nombre.trim()) { setError("Falta el nombre"); return; }
    setGuardando(true); setError(null);
    try {
      await postJSON(`/api/rrhh?action=${form.id ? "empleadoEditar" : "empleadoCrear"}`, form);
      setForm(null);
      cargar();
    } catch (e) { setError(e.message); }
    finally { setGuardando(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setForm({ ...LEGAJO_VACIO })}
                className="rounded-md bg-negro text-white px-4 py-2 text-[13px] font-bold">＋ Empleado</button>
        <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-3">
          <input type="checkbox" checked={verBajas} onChange={e => setVerBajas(e.target.checked)} />
          Ver bajas
        </label>
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}

      {form && (
        <Card title={form.id ? "Editar legajo" : "Nuevo empleado"}>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Nombre y apellido</span>
                <input type="text" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Local</span>
                <select value={form.local} onChange={e => setForm(f => ({ ...f, local: e.target.value }))} className={inputCls}>
                  {LOCALES_RRHH.map(l => <option key={l}>{l}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Puesto</span>
                <input type="text" placeholder="vendedor, encargado…" value={form.puesto || ""} onChange={e => setForm(f => ({ ...f, puesto: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">CUIL</span>
                <input type="text" value={form.cuil || ""} onChange={e => setForm(f => ({ ...f, cuil: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Teléfono</span>
                <input type="text" value={form.telefono || ""} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Fecha de ingreso</span>
                <input type="date" value={form.fecha_ingreso || ""} onChange={e => setForm(f => ({ ...f, fecha_ingreso: e.target.value }))} className={inputCls} />
              </label>
            </div>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Notas</span>
              <input type="text" value={form.notas || ""} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} className={inputCls} />
            </label>
            {form.id && (
              <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                <input type="checkbox" checked={form.estado === "baja"}
                       onChange={e => setForm(f => ({ ...f, estado: e.target.checked ? "baja" : "activo" }))} />
                Dar de baja (deja de aparecer en asistencia)
              </label>
            )}
            <div className="flex gap-2">
              <button onClick={guardar} disabled={guardando}
                      className="flex-1 rounded-md bg-negro text-white px-4 py-2.5 text-[14px] font-bold disabled:opacity-50">
                {guardando ? "Guardando…" : "Guardar"}
              </button>
              <button onClick={() => setForm(null)} className="rounded-md border border-borde px-4 py-2.5 text-[14px] font-semibold text-ink-2">Cancelar</button>
            </div>
          </div>
        </Card>
      )}

      {!data ? <Spinner texto="Cargando legajos…" /> : agruparPorLocal(data).map(g => (
        <Card key={g.local} title={`${g.local} · ${g.items.length}`}>
          <ul className="divide-y divide-borde">
            {g.items.map(e => (
              <li key={e.id} className="py-2.5 flex items-center gap-3 cursor-pointer" onClick={() => setForm({ ...LEGAJO_VACIO, ...e })}>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">
                    {e.nombre}
                    {e.estado === "baja" && <span className="ml-2 text-[10px] font-bold uppercase text-bad">baja</span>}
                    {e.origen === "erp" && <span className="ml-2 text-[10px] font-bold uppercase text-warn">nuevo del erp</span>}
                  </div>
                  <div className="text-[11px] text-ink-3">
                    {[e.puesto, e.cuil, e.fecha_ingreso ? `ingreso ${e.fecha_ingreso}` : null].filter(Boolean).join(" · ") || "Completar datos"}
                  </div>
                </div>
                <span className="text-[12px] text-ink-3">✎</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

export default function RRHH() {
  const [tab, setTab] = useState("asistencia");
  const [recargarKey, setRecargarKey] = useState(0);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">RRHH</h1>
          <p className="text-[12px] text-ink-3">Asistencias que marcan los encargados en el ERP · legajos del equipo</p>
        </div>
        {tab === "asistencia" && <BotonActualizar onClick={() => setRecargarKey(k => k + 1)} cargando={false} />}
      </header>
      <Chips
        opciones={[{ value: "asistencia", label: "Asistencia" }, { value: "mes", label: "Resumen del mes" }, { value: "legajos", label: "Legajos" }]}
        valor={tab}
        onChange={setTab}
      />
      {tab === "asistencia" && <Asistencia recargarKey={recargarKey} />}
      {tab === "mes" && <ResumenMes />}
      {tab === "legajos" && <Legajos />}
    </div>
  );
}
