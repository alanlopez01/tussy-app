// Socios (solo admin) — pozos declarados repartidos por porcentaje y cuenta
// corriente de cada socio (retiros, gastos, aportes). Migrado del Excel de
// finanzas de Tussy. Un retiro/aporte en efectivo impacta la caja linkeado.
import { useCallback, useEffect, useState } from "react";
import { getJSON, postJSON, fmtPesos, hoyISO } from "../lib/api.js";
import { Card, Spinner, BotonActualizar } from "../components/ui.jsx";

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

const MESES = ["enero","febrero","marzo","abril","mayo","junio",
               "julio","agosto","septiembre","octubre","noviembre","diciembre"];
function nombreMes(ym) {
  const [a, m] = String(ym).split("-");
  return `${MESES[Number(m) - 1]} ${a}`;
}

const TIPOS = [
  { v: "retiro", l: "Retiro", ayuda: "efectivo o transferencia que se lleva el socio" },
  { v: "gasto", l: "Gasto socio", ayuda: "se descuenta de su saldo, no toca la caja" },
  { v: "aporte", l: "Aporte propio", ayuda: "puso plata, suma a su saldo" },
  { v: "pozo", l: "Declarar pozo", ayuda: "monto total a repartir entre los socios" },
];

const FORM_VACIO = { id: null, tipo: "retiro", socio: "", fecha: hoyISO(), descripcion: "", monto: "", impactar_caja: true };

export default function Socios() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [form, setForm] = useState(FORM_VACIO);
  const [formError, setFormError] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [flash, setFlash] = useState(null);
  // En el celular se muestran los últimos meses y el resto se despliega. La
  // lista completa en una pantalla angosta no se termina de leer nunca.
  const [todosLosMeses, setTodosLosMeses] = useState(false);
  const [verPozos, setVerPozos] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    getJSON("/api/cajas?action=socios")
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const esPozo = form.tipo === "pozo";
  const montoNum = aMonto(form.monto) || 0;

  const guardar = async () => {
    setFormError(null);
    const monto = aMonto(form.monto);
    if (monto === null || Number.isNaN(monto) || monto <= 0) { setFormError("Poné un monto válido"); return; }
    if (!esPozo && !form.socio) { setFormError("Elegí el socio"); return; }
    setGuardando(true);
    try {
      const body = { fecha: form.fecha, socio: form.socio, tipo: form.tipo, descripcion: form.descripcion,
                     monto, impactar_caja: form.tipo === "retiro" || form.tipo === "aporte" ? form.impactar_caja : false };
      if (form.id) await postJSON("/api/cajas?action=socioMovEditar", { ...body, id: form.id });
      else await postJSON("/api/cajas?action=socioMovCrear", body);
      const nombreTipo = TIPOS.find(t => t.v === form.tipo).l;
      setFlash(`✓ ${nombreTipo} de ${fmtPesos(monto)} ${form.id ? "guardado" : "cargado"}${body.impactar_caja ? " · impactó en la caja" : ""}`);
      setTimeout(() => setFlash(null), 4000);
      setForm(f => ({ ...FORM_VACIO, tipo: f.tipo }));
      cargar();
    } catch (e) { setFormError(e.message); }
    finally { setGuardando(false); }
  };

  const editarMov = (m) => {
    setForm({ id: m.id, tipo: m.tipo, socio: m.socio || "", fecha: m.fecha, descripcion: m.descripcion || "",
              monto: formatearMiles(String(m.monto).replace(".", ",")), impactar_caja: !!m.caja_mov_id });
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const borrarMov = async (m) => {
    const extra = m.caja_mov_id ? " (también borra el movimiento linkeado en Cajas)" : "";
    if (!window.confirm(`¿Borrar ${m.tipo} de ${fmtPesos(m.monto)}${m.socio ? " de " + m.socio : ""}?${extra}`)) return;
    try { await postJSON("/api/cajas?action=socioMovBorrar", { id: m.id }); cargar(); }
    catch (e) { setError(e.message); }
  };

  const socios = data?.socios || [];
  const saldoTotal = socios.reduce((a, s) => a + s.saldo, 0);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[30px] md:text-[34px] font-semibold text-ink tracking-[-0.03em] leading-[1.08]">Socios</h1>
          <p className="text-[12px] text-ink-3">Pozos, retiros y cuenta corriente de cada socio</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <div className="bg-negro text-surface-1 rounded-lg px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-surface-1/50">Saldo a retirar (todos)</div>
          <div className="text-[26px] leading-tight font-bold tabular-nums">{data ? fmtPesos(saldoTotal) : "…"}</div>
        </div>
        {data && (
          <div className="text-right text-[12px] text-surface-1/60 tabular-nums">
            Pozos declarados: <span className="text-surface-1 font-semibold">{fmtPesos(data.pozo_total)}</span>
          </div>
        )}
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}
      {flash && <div className="rounded-lg bg-ok/10 border border-ok/40 text-ok px-4 py-3 text-[13px] font-semibold">{flash}</div>}

      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {socios.map(s => (
            <Card key={s.socio} className="!p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-bold text-ink">{s.socio}</span>
                <span className="text-[12px] font-semibold text-ink-3">{(s.porcentaje * 100).toLocaleString("es-AR")}%</span>
              </div>
              <div className="mt-2 space-y-1 text-[13px] md:text-[11px] text-ink-3 tabular-nums">
                <div className="flex justify-between"><span>Le corresponde</span><span>{fmtPesos(s.corresponde)}</span></div>
                <div className="flex justify-between"><span>Retirado</span><span>−{fmtPesos(s.retirado)}</span></div>
                {s.gastos > 0 && <div className="flex justify-between"><span>Gastos</span><span>−{fmtPesos(s.gastos)}</span></div>}
                {s.aportes > 0 && <div className="flex justify-between"><span>Aportes</span><span>+{fmtPesos(s.aportes)}</span></div>}
              </div>
              <div className="mt-2.5 pt-2 border-t border-borde flex justify-between items-baseline">
                <span className="text-[11px] uppercase tracking-[0.06em] text-ink-3 font-semibold">A retirar</span>
                <span className={`text-[18px] font-bold tabular-nums ${s.saldo > 1000 ? "text-ok" : s.saldo < -1000 ? "text-bad" : "text-ink"}`}>
                  {fmtPesos(s.saldo)}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {data?.meses?.length > 0 && (
        <Card title="Retiros mes a mes">
          {/* Celular: una tarjeta por mes. La tabla de seis columnas no entra en
              una pantalla angosta y obliga a scrollear de costado para leer un
              número, que es justo lo que no se puede hacer con plata. */}
          <div className="md:hidden space-y-3">
            {(todosLosMeses ? data.meses : data.meses.slice(0, 6)).map(m => (
              <div key={m.mes} className="rounded-lg border border-borde p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] font-bold text-ink capitalize">{nombreMes(m.mes)}</span>
                  <span className="text-[12px] text-ink-3 tabular-nums">
                    {m.pozo ? `pozo ${fmtPesos(m.pozo)}` : "sin pozo"}
                  </span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {socios.map(s => {
                    const d = m.socios[s.socio] || {};
                    if (!d.retiro && !d.gasto && !d.aporte) return null;
                    return (
                      <div key={s.socio} className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="text-ink-2">{s.socio}</span>
                        <span className="text-right tabular-nums">
                          <span className="text-ink font-semibold">{d.retiro ? fmtPesos(d.retiro) : "—"}</span>
                          {d.gasto > 0 && <div className="text-[12px] text-ink-3">+{fmtPesos(d.gasto)} gastos</div>}
                          {d.aporte > 0 && <div className="text-[12px] text-ok">−{fmtPesos(d.aporte)} aporte</div>}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2.5 pt-2 border-t border-borde flex items-baseline justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-[0.06em] text-ink-3 font-semibold">Retirado</span>
                  <span className="text-[15px] font-bold tabular-nums text-ink">{fmtPesos(m.total_retiros)}</span>
                </div>
                {m.pozo > 0 && (
                  <div className={`text-[12px] text-right mt-0.5 tabular-nums ${m.pozo - m.total_retiros >= 0 ? "text-ink-3" : "text-bad"}`}>
                    {m.pozo - m.total_retiros >= 0
                      ? `quedó ${fmtPesos(m.pozo - m.total_retiros)}`
                      : `${fmtPesos(m.total_retiros - m.pozo)} de más`}
                  </div>
                )}
              </div>
            ))}
            {data.meses.length > 6 && (
              <button
                onClick={() => setTodosLosMeses(v => !v)}
                className="w-full rounded-lg border border-borde py-2.5 text-[13px] font-semibold text-ink-2"
              >
                {todosLosMeses ? "Ver solo los últimos 6 meses" : `Ver los ${data.meses.length} meses`}
              </button>
            )}
            <div className="rounded-lg bg-surface border border-borde p-3">
              <div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 font-semibold">Acumulado</div>
              <div className="mt-1.5 space-y-1 text-[13px] tabular-nums">
                <div className="flex justify-between"><span className="text-ink-2">Pozos declarados</span><span className="text-ink">{fmtPesos(data.pozo_total)}</span></div>
                {socios.map(s => (
                  <div key={s.socio} className="flex justify-between">
                    <span className="text-ink-2">{s.socio} retiró</span><span className="text-ink">{fmtPesos(s.retirado)}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-borde pt-1 font-bold">
                  <span className="text-ink">Total retirado</span>
                  <span className="text-ink">{fmtPesos(socios.reduce((a, s) => a + s.retirado, 0))}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="hidden md:block -mx-1 overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-ink-3 text-[10px] uppercase tracking-[0.06em]">
                  <th className="text-left font-semibold py-1.5 pr-3">Mes</th>
                  <th className="text-right font-semibold py-1.5 px-2">Pozo</th>
                  {socios.map(s => (
                    <th key={s.socio} className="text-right font-semibold py-1.5 px-2">{s.socio}</th>
                  ))}
                  <th className="text-right font-semibold py-1.5 pl-2">Retirado</th>
                </tr>
              </thead>
              <tbody>
                {data.meses.map(m => {
                  const max = Math.max(...data.meses.map(x => x.total_retiros), 1);
                  return (
                    <tr key={m.mes} className="border-t border-borde">
                      <td className="py-2 pr-3 text-ink-2 capitalize whitespace-nowrap">{nombreMes(m.mes)}</td>
                      <td className="text-right py-2 px-2 text-ink-2">
                        {m.pozo ? fmtPesos(m.pozo) : <span className="text-ink-3">—</span>}
                      </td>
                      {socios.map(s => {
                        const d = m.socios[s.socio] || {};
                        return (
                          <td key={s.socio} className="text-right py-2 px-2 text-ink">
                            {d.retiro ? fmtPesos(d.retiro) : <span className="text-ink-3">—</span>}
                            {d.gasto > 0 && <div className="text-[10px] text-ink-3">+{fmtPesos(d.gasto)} gastos</div>}
                            {d.aporte > 0 && <div className="text-[10px] text-ok">−{fmtPesos(d.aporte)} aporte</div>}
                          </td>
                        );
                      })}
                      <td className="text-right py-2 pl-2 font-bold text-ink">
                        {fmtPesos(m.total_retiros)}
                        {m.pozo > 0 && (
                          <div className={`text-[10px] font-semibold ${m.pozo - m.total_retiros >= 0 ? "text-ink-3" : "text-bad"}`}>
                            {m.pozo - m.total_retiros >= 0
                              ? `quedó ${fmtPesos(m.pozo - m.total_retiros)}`
                              : `${fmtPesos(m.total_retiros - m.pozo)} de más`}
                          </div>
                        )}
                        <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--color-pista-2)" }}>
                          <div className="h-full rounded-[inherit] origin-left"
                               style={{ background: "var(--color-dato)",
                                        transform: `scaleX(${max > 0 ? m.total_retiros / max : 0})`,
                                        transition: "transform .45s var(--ease-suave)" }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink/20 font-bold text-ink">
                  <td className="py-2 pr-3 text-[11px] uppercase tracking-[0.06em]">Acumulado</td>
                  <td className="text-right py-2 px-2">{fmtPesos(data.pozo_total)}</td>
                  {socios.map(s => (
                    <td key={s.socio} className="text-right py-2 px-2">{fmtPesos(s.retirado)}</td>
                  ))}
                  <td className="text-right py-2 pl-2">
                    {fmtPesos(socios.reduce((a, s) => a + s.retirado, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-ink-3">
            <strong className="text-ink-2">Pozo</strong> es lo que se declaró para repartir ese mes.
            El número grande de cada socio es lo que se llevó, y abajo en chico los gastos que se le
            descuentan del saldo y los aportes que puso de su bolsillo.
          </p>
        </Card>
      )}

      <Card title={form.id ? "Editar movimiento" : null}>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {TIPOS.map(t => (
              <button key={t.v} onClick={() => setForm(f => ({ ...f, tipo: t.v, impactar_caja: t.v === "retiro" }))}
                className={`rounded-lg px-3 py-2.5 text-[13px] font-bold border-2 transition-colors ${
                  form.tipo === t.v ? "bg-acento text-white border-acento" : "border-borde text-ink-3"
                }`}>
                {t.l}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-ink-3 -mt-1.5">{TIPOS.find(t => t.v === form.tipo).ayuda}</p>

          {!esPozo && (
            <div className="flex gap-1.5 flex-wrap">
              {socios.map(s => (
                <button key={s.socio} onClick={() => setForm(f => ({ ...f, socio: s.socio }))}
                  className={`rounded-full px-4 py-1.5 text-[13px] font-bold border transition-colors ${
                    form.socio === s.socio ? "bg-acento text-white border-acento" : "bg-surface-1 text-ink-2 border-borde"
                  }`}>
                  {s.socio}
                </button>
              ))}
            </div>
          )}

          <input type="text" inputMode="decimal" placeholder="$ 0"
                 value={form.monto} onChange={e => setForm(f => ({ ...f, monto: formatearMiles(e.target.value) }))}
                 className="w-full rounded-lg border-2 border-borde bg-surface-1 px-4 py-3 text-[24px] font-bold text-ink tabular-nums placeholder:text-ink-3/50" />

          {esPozo && montoNum > 0 && (
            <div className="rounded-md bg-surface px-3.5 py-2.5 text-[12px] text-ink-2 tabular-nums space-y-0.5">
              {socios.map(s => (
                <div key={s.socio} className="flex justify-between">
                  <span>{s.socio} ({(s.porcentaje * 100).toLocaleString("es-AR")}%)</span>
                  <span className="font-semibold">{fmtPesos(montoNum * s.porcentaje)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <input type="text" placeholder={esPozo ? "Descripción · ej: Retiro septiembre" : "Descripción (opcional)"} value={form.descripcion}
                   onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} className={inputCls} />
            <input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} className={inputCls} />
          </div>

          {(form.tipo === "retiro" || form.tipo === "aporte") && !form.id && (
            <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
              <input type="checkbox" checked={form.impactar_caja}
                     onChange={e => setForm(f => ({ ...f, impactar_caja: e.target.checked }))} />
              {form.tipo === "retiro" ? "Salió de la caja en efectivo (carga el egreso en Cajas solo)" : "Entró a la caja en efectivo (carga el ingreso en Cajas solo)"}
            </label>
          )}

          {formError && <p className="text-[13px] text-bad font-semibold">{formError}</p>}

          <div className="flex gap-2">
            <button onClick={guardar} disabled={guardando}
                    className="flex-1 rounded-lg bg-acento text-white px-4 py-3.5 text-[15px] font-bold disabled:opacity-50">
              {guardando ? "Guardando…" : form.id ? "Guardar cambios" : "Cargar"}
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

      <Card title="Movimientos"
            right={
              <button onClick={() => setVerPozos(v => !v)}
                      className="text-[12px] font-semibold text-ink-3 underline underline-offset-2">
                {verPozos ? "Ver todos" : "Solo pozos"}
              </button>
            }>
        {!data ? <Spinner texto="Cargando…" /> : (
          <ul className="divide-y divide-borde">
            {(verPozos ? data.movimientos.filter(m => m.tipo === "pozo") : data.movimientos).map(m => (
              <li key={m.id} className="py-2.5 flex items-center gap-3">
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase border ${
                  m.tipo === "pozo" ? "bg-acento text-white border-acento"
                  : m.tipo === "retiro" ? "bg-bad/10 text-bad border-bad/30"
                  : m.tipo === "aporte" ? "bg-ok/10 text-ok border-ok/30"
                  : "bg-surface text-ink-2 border-borde"
                }`}>
                  {m.tipo === "pozo" ? "Pozo" : m.tipo === "gasto" ? "Gasto" : m.tipo}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">
                    {m.socio ? `${m.socio}${m.descripcion ? " · " + m.descripcion : ""}` : (m.descripcion || "Pozo")}
                  </div>
                  <div className="text-[11px] text-ink-3">
                    {new Date(m.fecha + "T12:00:00Z").toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" })}
                    {m.caja_mov_id ? " · en caja" : ""}
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
