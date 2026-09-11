// Deuda Shato ↔ Tussy (solo admin) — ledger de préstamos cruzados que vivía en
// la hoja "deuda" del Excel de Shato. Pagos/préstamos de Shato de un lado, tela
// y préstamos de Tussy del otro. balance = Shato − Tussy (negativo: Shato debe).
import { useCallback, useEffect, useState } from "react";
import { getJSON, postJSON, fmtPesos, hoyISO } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar } from "../components/ui.jsx";

const inputCls = "w-full rounded-md border border-borde bg-surface-1 px-3 py-2 text-[14px] text-ink";

function aMonto(s) {
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
function formatearMiles(s) {
  const t = String(s ?? "").replace(/[^\d,]/g, "");
  const i = t.indexOf(",");
  let ent = (i >= 0 ? t.slice(0, i) : t).replace(/^0+(?=\d)/, "");
  const dec = i >= 0 ? "," + t.slice(i + 1).replace(/,/g, "").slice(0, 2) : "";
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + dec;
}
const aNum = s => { const n = Number(String(s ?? "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };

const FORM_VACIO = { id: null, lado: "shato", fecha: hoyISO(), detalle: "", kilos: "", precio: "", monto: "" };

export default function DeudaShato() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filtro, setFiltro] = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);
  const [formError, setFormError] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [flash, setFlash] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    getJSON("/api/cajas?action=deuda")
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const esTela = form.lado === "tussy";

  // kilos × precio completa el monto solo (editable después)
  const actualizarKilosPrecio = (campo, valor) => {
    setForm(f => {
      const nuevo = { ...f, [campo]: valor };
      const k = aNum(campo === "kilos" ? valor : f.kilos);
      const p = aNum(campo === "precio" ? valor : f.precio);
      if (k > 0 && p > 0) nuevo.monto = formatearMiles(String(Math.round(k * p * 100) / 100).replace(".", ","));
      return nuevo;
    });
  };

  const guardar = async () => {
    setFormError(null);
    const monto = aMonto(form.monto);
    if (monto === null || Number.isNaN(monto) || monto <= 0) { setFormError("Poné un monto válido"); return; }
    setGuardando(true);
    try {
      const body = { fecha: form.fecha, lado: form.lado, detalle: form.detalle, monto,
                     kilos: esTela ? aNum(form.kilos) || null : null,
                     precio: esTela ? aNum(form.precio) || null : null };
      if (form.id) await postJSON("/api/cajas?action=deudaEditar", { ...body, id: form.id });
      else await postJSON("/api/cajas?action=deudaCrear", body);
      setFlash(`✓ ${form.lado === "shato" ? "Pago de Shato" : "Préstamo de Tussy"} de ${fmtPesos(monto)} ${form.id ? "guardado" : "cargado"}`);
      setTimeout(() => setFlash(null), 3500);
      setForm(f => ({ ...FORM_VACIO, lado: f.lado }));
      cargar();
    } catch (e) { setFormError(e.message); }
    finally { setGuardando(false); }
  };

  const editarMov = (m) => {
    setForm({ id: m.id, lado: m.lado, fecha: m.fecha, detalle: m.detalle || "",
              kilos: m.kilos ? formatearMiles(String(m.kilos).replace(".", ",")) : "",
              precio: m.precio ? formatearMiles(String(m.precio).replace(".", ",")) : "",
              monto: formatearMiles(String(m.monto).replace(".", ",")) });
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const borrarMov = async (m) => {
    if (!window.confirm(`¿Borrar movimiento de ${fmtPesos(m.monto)} (${m.lado === "shato" ? "Shato" : "Tussy"})?`)) return;
    try { await postJSON("/api/cajas?action=deudaBorrar", { id: m.id }); cargar(); }
    catch (e) { setError(e.message); }
  };

  const movs = (data?.movimientos || []).filter(m => filtro === "todos" || m.lado === filtro);
  const debe = data && data.balance < 0 ? "Shato le debe a Tussy" : "Tussy le debe a Shato";

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Deuda Shato</h1>
          <p className="text-[12px] text-ink-3">Préstamos cruzados Shato ↔ Tussy · pagos y tela</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <div className="bg-negro text-white rounded-lg px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/50">{data ? debe : "Balance"}</div>
          <div className="text-[26px] leading-tight font-bold tabular-nums">
            {data ? fmtPesos(Math.abs(data.balance)) : "…"}
          </div>
        </div>
        {data && (
          <div className="text-right text-[12px] text-white/60 tabular-nums leading-relaxed">
            <div>Prestado por Shato: <span className="text-white font-semibold">{fmtPesos(data.prestado_shato)}</span></div>
            <div>Prestado por Tussy: <span className="text-white font-semibold">{fmtPesos(data.prestado_tussy)}</span></div>
          </div>
        )}
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}
      {flash && <div className="rounded-lg bg-ok/10 border border-ok/40 text-ok px-4 py-3 text-[13px] font-semibold">{flash}</div>}

      <Card title={form.id ? "Editar movimiento" : null}>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-2">
            {[["shato", "Pago / préstamo de Shato"], ["tussy", "Tela / préstamo de Tussy"]].map(([v, l]) => (
              <button key={v} onClick={() => setForm(f => ({ ...f, lado: v }))}
                className={`rounded-lg px-3 py-3 text-[13px] font-bold border-2 transition-colors ${
                  form.lado === v ? "bg-negro text-white border-negro" : "border-borde text-ink-3"
                }`}>
                {l}
              </button>
            ))}
          </div>

          {esTela && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Kilos</span>
                <input type="text" inputMode="decimal" placeholder="225,73" value={form.kilos}
                       onChange={e => actualizarKilosPrecio("kilos", e.target.value)} className={`${inputCls} tabular-nums`} />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Precio por kilo ($)</span>
                <input type="text" inputMode="decimal" placeholder="14.000" value={form.precio}
                       onChange={e => actualizarKilosPrecio("precio", formatearMiles(e.target.value))} className={`${inputCls} tabular-nums`} />
              </label>
            </div>
          )}

          <input type="text" inputMode="decimal" placeholder="$ 0"
                 value={form.monto} onChange={e => setForm(f => ({ ...f, monto: formatearMiles(e.target.value) }))}
                 className="w-full rounded-lg border-2 border-borde bg-surface-1 px-4 py-3 text-[24px] font-bold text-ink tabular-nums placeholder:text-ink-3/50" />

          <div className="grid grid-cols-2 gap-3">
            <input type="text" placeholder={esTela ? "Detalle · ej: Frisa negro" : "Detalle · ej: pago tela"} value={form.detalle}
                   onChange={e => setForm(f => ({ ...f, detalle: e.target.value }))} className={inputCls} />
            <input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} className={inputCls} />
          </div>

          {formError && <p className="text-[13px] text-bad font-semibold">{formError}</p>}

          <div className="flex gap-2">
            <button onClick={guardar} disabled={guardando}
                    className="flex-1 rounded-lg bg-negro text-white px-4 py-3.5 text-[15px] font-bold disabled:opacity-50">
              {guardando ? "Guardando…" : form.id ? "Guardar cambios" : "Cargar"}
            </button>
            {form.id && (
              <button onClick={() => { setForm(f => ({ ...FORM_VACIO, lado: f.lado })); setFormError(null); }}
                      className="rounded-lg border border-borde px-4 py-3.5 text-[14px] font-semibold text-ink-2">
                Cancelar
              </button>
            )}
          </div>
        </div>
      </Card>

      <Card title="Últimos movimientos"
            right={<Chips opciones={[{ value: "todos", label: "Todos" }, { value: "shato", label: "Shato" }, { value: "tussy", label: "Tussy" }]}
                          valor={filtro} onChange={setFiltro} />}>
        {!data ? <Spinner texto="Cargando…" /> : movs.length === 0 ? (
          <p className="text-[13px] text-ink-3 py-4 text-center">Sin movimientos</p>
        ) : (
          <ul className="divide-y divide-borde">
            {movs.map(m => (
              <li key={m.id} className="py-2.5 flex items-center gap-3">
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${
                  m.lado === "shato" ? "bg-surface text-ink-2 border border-borde" : "bg-ok/10 text-ok border border-ok/30"
                }`}>
                  {m.lado === "shato" ? "Shato" : "Tussy"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{m.detalle || (m.lado === "shato" ? "Préstamo Shato" : "Préstamo Tussy")}</div>
                  <div className="text-[11px] text-ink-3">
                    {new Date(m.fecha + "T12:00:00Z").toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" })}
                    {m.kilos ? ` · ${String(m.kilos).replace(".", ",")} kg × ${fmtPesos(m.precio || 0)}` : ""}
                  </div>
                </div>
                <div className="text-[13px] font-bold tabular-nums">{fmtPesos(m.monto)}</div>
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
