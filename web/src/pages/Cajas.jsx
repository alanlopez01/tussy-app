// Cajas en efectivo — reemplaza a los Sheets "Finanzas Tussy Definitivo" y
// "Finanzas_Shato_v2". Marcas SIEMPRE separadas. La carga es lo primero: monto,
// categoría como botones (las más usadas primero) y listo.
//
// `soloLectura` = la misma pantalla, los mismos números, sin el formulario de
// carga ni los botones de editar y borrar. Es lo que ve un socio habilitado:
// que mire la caja no significa que la mueva, y el server tampoco lo dejaría.
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

// ── Detalle de una categoría ──
// Un total no sirve si no se puede abrir. Los movimientos los filtra el server
// por marca, tipo y categoría (el endpoint de movimientos ya sabía hacerlo) y
// acá se ordenan por monto, que es como uno mira un gasto que le llamó la
// atención: primero el grande. El mes anterior está a un toque, porque la
// pregunta que sigue a "qué fue esto" siempre es "y el mes pasado qué fue".
function DetalleCategoria({ marca, categoria, tipo, fila, mes, anio, onCerrar }) {
  const anterior = mes === 1 ? { mes: 12, anio: anio - 1 } : { mes: mes - 1, anio };
  // Si este mes no tuvo nada pero el pasado sí, abre directo donde hay algo.
  const [cual, setCual] = useState(fila.total === 0 && fila.totalAnt > 0 ? "anterior" : "actual");
  const [orden, setOrden] = useState("monto");
  const [movs, setMovs] = useState(null);
  const [error, setError] = useState(null);
  const ver = cual === "actual" ? { mes, anio } : anterior;

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCerrar]);

  useEffect(() => {
    setMovs(null);
    setError(null);
    getJSON(`/api/cajas?action=movimientos&marca=${marca}&mes=${ver.mes}&anio=${ver.anio}` +
            `&tipo=${tipo}&categoria=${encodeURIComponent(categoria)}`)
      .then(r => setMovs(r.movimientos))
      .catch(e => setError(e.message));
  }, [marca, categoria, tipo, ver.mes, ver.anio]);

  const lista = [...(movs || [])].sort((a, b) =>
    orden === "monto" ? b.monto - a.monto : a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0);
  const total = lista.reduce((a, m) => a + m.monto, 0);
  const esGasto = tipo === "egreso";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <button className="absolute inset-0 bg-black/50" onClick={onCerrar} aria-label="Cerrar" />
      <div role="dialog" aria-modal="true"
           className="relative bg-surface-1 rounded-t-2xl sm:rounded-lg w-full sm:max-w-xl max-h-[88vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="text-[16px] font-bold text-ink">{categoria}</h3>
            <p className="text-[11px] text-ink-3">
              {marca === "shato" ? "Shato" : "Tussy"} · {esGasto ? "gastos" : "ingresos"} de {MESES[ver.mes - 1]} {ver.anio}
            </p>
          </div>
          <button onClick={onCerrar} className="text-ink-3 text-2xl leading-none px-1" aria-label="Cerrar">×</button>
        </div>

        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Chips opciones={[{ value: "actual", label: MESES[mes - 1] }, { value: "anterior", label: MESES[anterior.mes - 1] }]}
                 valor={cual} onChange={setCual} />
          <span className="ml-auto">
            <Chips opciones={[{ value: "monto", label: "Por monto" }, { value: "fecha", label: "Por fecha" }]}
                   valor={orden} onChange={setOrden} />
          </span>
        </div>

        <div className="flex items-baseline gap-3 pb-3 mb-1 border-b border-borde">
          <span className={`text-[22px] font-bold tabular-nums ${esGasto ? "text-bad" : "text-ok"}`}>{fmtPesos(total)}</span>
          <span className="text-[12px] text-ink-3">{lista.length} movimiento{lista.length === 1 ? "" : "s"}</span>
        </div>

        {error ? <p className="text-[13px] text-bad py-6 text-center">{error}</p>
          : !movs ? <Spinner texto="Buscando los movimientos…" />
          : !lista.length ? <p className="text-[13px] text-ink-3 py-8 text-center">Sin movimientos en {MESES[ver.mes - 1]}</p>
          : (
            <ul className="divide-y divide-borde">
              {lista.map(m => (
                <li key={m.id} className="py-2.5 flex items-center gap-3">
                  <span className="text-[11px] text-ink-3 tabular-nums w-[52px] shrink-0">
                    {m.fecha.slice(8, 10)}/{m.fecha.slice(5, 7)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">{m.detalle || <span className="text-ink-3">sin detalle</span>}</div>
                    {m.medio === "Transferencia" && <div className="text-[11px] text-ink-3">transferencia</div>}
                  </div>
                  <div className={`text-[13px] font-bold tabular-nums shrink-0 ${esGasto ? "text-bad" : "text-ok"}`}>
                    {fmtPesos(m.monto)}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

// ── Solapa Resumen ──
// Una tabla por marca con el gasto (y el ingreso) por categoría, y el mes
// anterior pegado a cada fila. La barrita es la proporción dentro de la marca:
// sirve para ver de un vistazo quién se come la caja, no para medir.
function TablaCats({ filas, mesAnt, tono, malSube = false, onElegir }) {
  if (!filas.length) return <p className="text-[12px] text-ink-3 py-3">Sin movimientos este mes</p>;
  const max = Math.max(...filas.map(f => f.total), 1);
  const total = filas.reduce((a, f) => a + f.total, 0);
  const totalAnt = filas.reduce((a, f) => a + f.totalAnt, 0);
  // Que un gasto suba es malo y que un ingreso suba es bueno: el color se da
  // vuelta según el lado, si no el verde y el rojo mienten.
  const difCls = d => (d === 0 ? "text-ink-3" : d > 0 === malSube ? "text-bad" : "text-ok");
  const conSigno = d => (d === 0 ? "=" : (d > 0 ? "+" : "−") + fmtPesos(Math.abs(d)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] tabular-nums">
        <thead>
          <tr className="text-left text-ink-3 uppercase text-[10px] tracking-[0.05em]">
            <th className="py-1.5 pr-2 font-semibold">Categoría</th>
            <th className="py-1.5 px-2 font-semibold text-right">Este mes</th>
            <th className="py-1.5 px-2 font-semibold text-right hidden sm:table-cell">{mesAnt}</th>
            <th className="py-1.5 pl-2 font-semibold text-right">Dif.</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-borde">
          {filas.map(f => (
            <tr key={f.categoria} onClick={() => onElegir(f)} tabIndex={0} role="button"
                title={`Ver los movimientos de ${f.categoria}`}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onElegir(f); } }}
                className="cursor-pointer hover:bg-pista focus:bg-pista outline-none">
              <td className="py-2 pr-2 min-w-[110px]">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-medium text-ink">{f.categoria}</span>
                  {f.n > 0 && <span className="text-[10px] text-ink-3">{f.n} mov.</span>}
                </div>
                <div className="mt-1 h-1 rounded-full bg-pista-2 overflow-hidden">
                  <div className={`h-full rounded-full ${tono}`} style={{ width: `${(f.total / max) * 100}%` }} />
                </div>
              </td>
              <td className="py-2 px-2 text-right font-semibold text-ink">{f.total ? fmtPesos(f.total) : "—"}</td>
              <td className="py-2 px-2 text-right text-ink-3 hidden sm:table-cell">{f.totalAnt ? fmtPesos(f.totalAnt) : "—"}</td>
              <td className={`py-2 pl-2 text-right font-semibold ${difCls(f.total - f.totalAnt)}`}>{conSigno(f.total - f.totalAnt)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td className="pt-2.5 pr-2 text-ink border-t-2 border-borde">Total</td>
            <td className="pt-2.5 px-2 text-right text-ink border-t-2 border-borde">{fmtPesos(total)}</td>
            <td className="pt-2.5 px-2 text-right text-ink-3 border-t-2 border-borde hidden sm:table-cell">{fmtPesos(totalAnt)}</td>
            <td className={`pt-2.5 pl-2 text-right border-t-2 border-borde ${difCls(total - totalAnt)}`}>{conSigno(total - totalAnt)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Resumen({ mes, anio, setMes, setAnio, anios }) {
  const [data, setData] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    getJSON(`/api/cajas?action=resumenCategorias&mes=${mes}&anio=${anio}`)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [mes, anio]);
  useEffect(() => { setData(null); cargar(); }, [cargar]);

  const mesAnt = data ? MESES[parseInt(data.mesAnterior.slice(5), 10) - 1] : "Mes ant.";
  const saldoTotal = data ? (data.saldos.tussy || 0) + (data.saldos.shato || 0) : 0;

  return (
    <div className="space-y-4">
      {/* Las dos cajas juntas: es lo único que la solapa de carga no puede mostrar */}
      <div className="bg-negro text-surface-1 rounded-lg px-5 py-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
        {[["tussy", "Caja Tussy"], ["shato", "Caja Shato"]].map(([k, l]) => (
          <div key={k}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-surface-1/50">{l}</div>
            <div className="text-[20px] leading-tight font-bold tabular-nums">{data ? fmtPesos(data.saldos[k] || 0) : "…"}</div>
          </div>
        ))}
        <div className="col-span-2 sm:col-span-1 sm:text-right border-t sm:border-t-0 border-surface-1/15 pt-3 sm:pt-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-surface-1/50">Las dos juntas</div>
          <div className="text-[26px] leading-tight font-bold tabular-nums">{data ? fmtPesos(saldoTotal) : "…"}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select value={mes} onChange={e => setMes(parseInt(e.target.value))} className={selectCls}>
          {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select value={anio} onChange={e => setAnio(parseInt(e.target.value))} className={selectCls}>
          {anios.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="ml-auto"><BotonActualizar onClick={cargar} cargando={cargando} /></span>
      </div>

      {error && <Card><p className="text-[13px] text-bad py-3 text-center">{error}</p></Card>}
      {!data ? <Spinner texto="Armando el resumen…" /> : (
        <div className="grid lg:grid-cols-2 gap-4 items-start">
          {[["tussy", "Tussy"], ["shato", "Shato"]].map(([k, l]) => {
            const d = data.marcas[k];
            const neto = d.totales.ingreso - d.totales.gasto;
            return (
              <Card key={k} title={l}
                    sub={`entró ${fmtPesos(d.totales.ingreso)} · salió ${fmtPesos(d.totales.gasto)}`}
                    right={
                      <span className={`text-[16px] font-bold tabular-nums ${neto >= 0 ? "text-ok" : "text-bad"}`}>
                        {neto >= 0 ? "+" : "−"}{fmtPesos(Math.abs(neto))}
                      </span>
                    }>
                <div className="space-y-5">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1.5">
                      Gastos <span className="normal-case tracking-normal text-ink-3/70">· tocá una categoría para ver los movimientos</span>
                    </div>
                    <TablaCats filas={d.gasto} mesAnt={mesAnt} tono="bg-bad/70" malSube
                               onElegir={f => setDetalle({ marca: k, tipo: "egreso", fila: f })} />
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1.5">Ingresos</div>
                    <TablaCats filas={d.ingreso} mesAnt={mesAnt} tono="bg-ok/70"
                               onElegir={f => setDetalle({ marca: k, tipo: "ingreso", fila: f })} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {detalle && (
        <DetalleCategoria marca={detalle.marca} categoria={detalle.fila.categoria} tipo={detalle.tipo}
                          fila={detalle.fila} mes={mes} anio={anio} onCerrar={() => setDetalle(null)} />
      )}
    </div>
  );
}

const FORM_VACIO = { id: null, tipo: "egreso", fecha: hoyISO(), categoria: "", nuevaCat: "", detalle: "", monto: "", medio: "Efectivo" };

export default function Cajas({ soloLectura = false }) {
  const hoy = new Date();
  const [marca, setMarca] = useState("tussy");
  const [mes, setMes] = useState(hoy.getMonth() + 1);
  const [anio, setAnio] = useState(hoy.getFullYear());
  const [resumen, setResumen] = useState(null);
  const [movs, setMovs] = useState(null);
  const [cats, setCats] = useState({ gasto: [], ingreso: [] });
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [tab, setTab] = useState("caja");
  const [busca, setBusca] = useState("");
  const [filtroCat, setFiltroCat] = useState("");
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
      // Las categorías son para los botones de la carga: sin carga, no se piden.
      soloLectura ? Promise.resolve(null) : getJSON(`/api/cajas?action=categorias&marca=${marca}`),
    ])
      .then(([r, m, c]) => { setResumen(r); setMovs(m.movimientos); if (c) setCats(c); })
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [marca, mes, anio, soloLectura]);

  useEffect(() => { setResumen(null); setMovs(null); cargar(); }, [cargar]);
  useEffect(() => { setForm(f => ({ ...FORM_VACIO, tipo: f.tipo })); setFormError(null); setMasFechaMedio(false); }, [marca]);
  // Las categorías no son las mismas en las dos marcas: el filtro no sobrevive al cambio.
  useEffect(() => { setFiltroCat(""); }, [marca]);

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

  // Buscador: una sola caja contra todo lo que se ve del movimiento — detalle,
  // categoría, medio y el monto escrito de las dos formas (16000000 y
  // $16.000.000) — porque uno busca "hernan", "16.000.000" o "transf" sin
  // pensar en columnas. Se filtra en el navegador sobre el mes ya cargado: son
  // 500 movimientos como mucho, pedirle al server por cada tecla no tiene sentido.
  const q = busca.trim().toLowerCase();
  const coincide = m =>
    `${m.detalle || ""} ${m.categoria} ${m.medio || ""} ${m.monto} ${fmtPesos(m.monto)}`.toLowerCase().includes(q);
  const movsFiltrados = (movs || []).filter(m =>
    (filtroTipo === "todos" || m.tipo === filtroTipo) &&
    (!filtroCat || m.categoria === filtroCat) &&
    (!q || coincide(m)));
  const filtrando = !!q || !!filtroCat || filtroTipo !== "todos";
  const totalFiltrado = movsFiltrados.reduce((a, m) => a + (m.tipo === "egreso" ? -m.monto : m.monto), 0);
  // El selector lista las categorías que existen este mes, no el catálogo
  // entero: filtrar por una categoría sin movimientos no sirve de nada.
  const catsDelMes = Object.entries(
    (movs || []).reduce((c, m) => ((c[m.categoria] = (c[m.categoria] || 0) + 1), c), {})
  ).sort((a, b) => a[0].localeCompare(b[0], "es"));

  // Movimientos agrupados por día para leer de un vistazo
  const porDia = [];
  for (const m of movsFiltrados) {
    if (!porDia.length || porDia[porDia.length - 1].fecha !== m.fecha) porDia.push({ fecha: m.fecha, items: [] });
    porDia[porDia.length - 1].items.push(m);
  }

  const anios = [];
  for (let y = hoy.getFullYear(); y >= 2023; y--) anios.push(y);
  const catBtn = (activa) =>
    `rounded-full px-3 py-1.5 text-[12px] font-semibold border transition-colors ${
      activa ? "bg-acento text-white border-acento" : "bg-surface-1 text-ink-2 border-borde hover:border-ink-3"
    }`;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[30px] md:text-[34px] font-semibold text-ink tracking-[-0.03em] leading-[1.08]">Cajas</h1>
          <p className="text-[12px] text-ink-3">
            {soloLectura ? "Todo lo que entra y sale de la caja · la carga Alan" : "La caja se carga acá · el Excel ya fue"}
          </p>
        </div>
        {tab === "caja" && <BotonActualizar onClick={cargar} cargando={cargando} />}
      </header>

      <Chips opciones={[{ value: "caja", label: "Caja" }, { value: "resumen", label: "Resumen" }]}
             valor={tab} onChange={setTab} />

      {tab === "resumen" ? <Resumen mes={mes} anio={anio} setMes={setMes} setAnio={setAnio} anios={anios} /> : <>

      {/* Marca + saldo en una sola franja */}
      <div className="bg-negro text-surface-1 rounded-lg px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {[["tussy", "Tussy"], ["shato", "Shato"]].map(([v, l]) => (
            <button key={v} onClick={() => setMarca(v)}
              className={`rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ${
                // En oscuro la franja se da vuelta (negro = claro): el botón
                // elegido tiene que invertirse con ella o queda blanco sobre blanco.
                marca === v ? "bg-surface-1 text-negro" : "bg-surface-1/10 text-surface-1/60 hover:text-surface-1"
              }`}>
              {l}
            </button>
          ))}
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-surface-1/50">Saldo en caja</div>
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
      {!soloLectura && (
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
      )}

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
        <div className="py-2 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <input type="search" value={busca} onChange={e => setBusca(e.target.value)}
                   placeholder="Buscar detalle, categoría o monto…"
                   className="flex-1 min-w-[170px] rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12.5px] text-ink placeholder:text-ink-3/70" />
            <select value={filtroCat} onChange={e => setFiltroCat(e.target.value)} className={selectCls}>
              <option value="">Todas las categorías</option>
              {catsDelMes.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
            </select>
            {filtrando && (
              <button onClick={() => { setBusca(""); setFiltroCat(""); setFiltroTipo("todos"); }}
                      className="rounded-md border border-borde px-3 py-1.5 text-[12px] font-semibold text-ink-3 hover:text-ink">
                Limpiar
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Chips opciones={[
                     { value: "todos", label: "Todo", cuenta: movs ? movs.length : undefined },
                     { value: "egreso", label: "Gastos", cuenta: movs ? movs.filter(m => m.tipo === "egreso").length : undefined },
                     { value: "ingreso", label: "Ingresos", cuenta: movs ? movs.filter(m => m.tipo === "ingreso").length : undefined },
                   ]}
                   valor={filtroTipo} onChange={setFiltroTipo} />
            {filtrando && movs && (
              <span className="ml-auto text-[11.5px] text-ink-3 tabular-nums">
                {movsFiltrados.length} de {movs.length} ·{" "}
                <strong className={`font-bold ${totalFiltrado >= 0 ? "text-ok" : "text-bad"}`}>
                  {totalFiltrado >= 0 ? "+" : "−"}{fmtPesos(Math.abs(totalFiltrado))}
                </strong>
              </span>
            )}
          </div>
        </div>
        {!movs ? <Spinner texto="Cargando movimientos…" /> : porDia.length === 0 ? (
          <p className="text-[13px] text-ink-3 py-4 text-center">
            {filtrando ? "Ningún movimiento coincide con la búsqueda" : "Sin movimientos este mes"}
          </p>
        ) : (
          porDia.map(dia => {
            const netoDia = dia.items.reduce((a, m) => a + (m.tipo === "egreso" ? -m.monto : m.monto), 0);
            return (
            <details key={dia.fecha} open={filtrando || dia.fecha === hoyISO()} className="group">
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
                    {!soloLectura && (
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => editarMov(m)} title="Editar"
                                className="text-[12px] px-2 py-1 rounded-md border border-borde text-ink-3 hover:text-ink">✎</button>
                        <button onClick={() => borrarMov(m)} title="Borrar"
                                className="text-[12px] px-2 py-1 rounded-md border border-borde text-ink-3 hover:text-bad">🗑</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </details>
            );
          })
        )}
      </Card>

      </>}
    </div>
  );
}
