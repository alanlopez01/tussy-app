// Contabilidad: posición de IVA, control de facturación, gastos por rubro y
// conciliación de transferencias MP contra facturas recibidas.
// Los exports de ARCA (Mis Comprobantes) y de MP se leen en el navegador y se
// suben ya normalizados; el WS de ARCA trae los emitidos solo cuando hay certificado.
import { useEffect, useState } from "react";
import { getJSON, postJSON, fmtPesos, fmtPesosCorto, hoyISO } from "../lib/api.js";
import { Card, Spinner, BotonActualizar, Chips } from "../components/ui.jsx";

const RUBROS = [
  "Mercadería / Fábrica", "Alquileres", "Servicios", "Publicidad", "Logística",
  "Impuestos", "Honorarios", "Financiero", "Insumos", "Sueldos", "Otros", "Sin rubro",
];

// ── Lectura de exports (números "1.234,56", fechas dd/mm/yyyy o Date) ──

function aNumero(v) {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  const s = String(v).trim();
  if (/^-?[\d.]+,\d+$/.test(s)) return parseFloat(s.replace(/\./g, "").replace(",", "."));
  return parseFloat(s.replace(/[^\d.-]/g, "")) || 0;
}

function aFecha(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v || "").trim();
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// "Transferencia enviada Taboada Gerardo" → tipo + contraparte
function partirMovimientoMP(tipoCompleto) {
  const t = String(tipoCompleto || "").trim();
  for (const p of ["Transferencia enviada", "Transferencia programada", "Pago de impuestos", "Compra", "Pago", "Débito por"]) {
    if (t.startsWith(p)) return { prefijo: p, contraparte: t.slice(p.length).trim() || null };
  }
  return { prefijo: t.split(" ")[0] || "Otro", contraparte: null };
}

function aEntero(v) {
  const m = String(v ?? "").match(/-?\d+/);
  return m ? parseInt(m[0]) : null;
}

// Busca la fila de encabezados y devuelve un índice por nombre. Los patrones se
// prueban EN ORDEN: el primero que matchea gana (así "total iva" le gana a "iva 2,5%").
function mapearColumnas(rows, requeridas) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const celdas = (rows[i] || []).map(c => String(c ?? "").toLowerCase());
    const idx = {};
    for (const [clave, patrones] of Object.entries(requeridas)) {
      idx[clave] = -1;
      for (const p of patrones) {
        const j = celdas.findIndex(c => c.includes(p));
        if (j >= 0) { idx[clave] = j; break; }
      }
    }
    if (idx.fecha >= 0 && idx.total >= 0) return { fila: i, idx };
  }
  return null;
}

async function leerHojas(file) {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
}

// Export de Mis Comprobantes (emitidos y recibidos comparten formato;
// cambia Emisor/Receptor según la clase)
async function parsearMisComprobantes(file, clase) {
  const rows = await leerHojas(file);
  const mapa = mapearColumnas(rows, {
    fecha: ["fecha"],
    tipo: ["tipo de comprobante", "tipo comprobante", "tipo cbte"],
    pv: ["punto de venta"],
    numero: ["número desde", "numero desde", "número de comprobante", "numero comprobante"],
    doc: [clase === "recibidos" ? "nro. doc. emisor" : "nro. doc. receptor", "nro. doc"],
    nombre: ["denominaci"],
    neto: ["neto gravado total", "neto gravado"],
    iva: ["total iva", "iva total", "iva"],
    tributos: ["otros tributos"],
    total: ["imp. total", "importe total", "imp total"],
  });
  if (!mapa) throw new Error("No encontré los encabezados del export de Mis Comprobantes. ¿Es el archivo correcto?");
  const { fila, idx } = mapa;
  const filas = [];
  for (const r of rows.slice(fila + 1)) {
    if (!r || r.length === 0) continue;
    const fecha = aFecha(r[idx.fecha]);
    const tipo = aEntero(r[idx.tipo]);
    const numero = idx.numero >= 0 ? aEntero(r[idx.numero]) : null;
    if (!fecha || tipo == null || numero == null) continue;
    const docNro = idx.doc >= 0 ? aEntero(String(r[idx.doc] ?? "").replace(/\D/g, "")) : null;
    filas.push({
      fecha, tipo, numero,
      punto_venta: idx.pv >= 0 ? aEntero(r[idx.pv]) || 0 : 0,
      neto: idx.neto >= 0 ? aNumero(r[idx.neto]) : 0,
      iva: idx.iva >= 0 ? aNumero(r[idx.iva]) : 0,
      otros_tributos: idx.tributos >= 0 ? aNumero(r[idx.tributos]) : 0,
      total: aNumero(r[idx.total]),
      ...(clase === "recibidos"
        ? { cuit_emisor: docNro, emisor: String(r[idx.nombre] ?? "").trim() || null }
        : { doc_nro: docNro, receptor: String(r[idx.nombre] ?? "").trim() || null }),
    });
  }
  if (!filas.length) throw new Error("El archivo no tiene comprobantes.");
  return filas;
}

// Estado de cuenta de MercadoPago (account statement): nos quedamos con la plata
// que SALE. La contraparte viene embebida en el tipo ("Transferencia enviada Juan…").
async function parsearMovimientosMP(file) {
  const rows = await leerHojas(file);
  const mapa = mapearColumnas(rows, {
    fecha: ["release_date", "fecha"],
    total: ["net_amount", "monto", "importe", "valor"],
    id: ["reference_id", "id de", "operaci", "referencia"],
    nombre: ["transaction_type", "contraparte", "destinatario", "descripci", "detalle"],
  });
  if (!mapa) {
    throw new Error("No reconozco el formato de este export de MercadoPago. Pasámelo por el chat y ajusto el lector.");
  }
  const { fila, idx } = mapa;
  const vistos = {};
  const filas = [];
  for (const r of rows.slice(fila + 1)) {
    if (!r || r.length === 0) continue;
    const fecha = aFecha(r[idx.fecha]);
    const monto = aNumero(r[idx.total]);
    if (!fecha || monto >= 0) continue; // solo egresos
    const tipo = String(r[idx.nombre] ?? "").trim();
    const { contraparte } = partirMovimientoMP(tipo);
    const base = idx.id >= 0 && r[idx.id] != null && String(r[idx.id]).trim()
      ? String(r[idx.id]).trim()
      : `${fecha}|${monto}|${tipo}`;
    vistos[base] = (vistos[base] || 0) + 1;
    filas.push({
      id: vistos[base] > 1 ? `${base}#${vistos[base]}` : base,
      fecha,
      monto: Math.abs(monto),
      contraparte,
      cuit: null,
      detalle: tipo,
    });
  }
  if (!filas.length) throw new Error("No encontré egresos (montos negativos) en el archivo.");
  return filas;
}

// ── Piezas de UI ──

function fmtCuit(c) {
  const s = String(c || "");
  return s.length === 11 ? `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` : s;
}

function Uploader({ titulo, descripcion, onFile, estado }) {
  const inputCls = "block w-full text-[12px] text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-negro file:text-white file:px-3.5 file:py-2 file:text-[12px] file:font-semibold file:cursor-pointer";
  return (
    <Card title={titulo}>
      <p className="text-[12px] text-ink-3 mb-3">{descripcion}</p>
      <input type="file" accept=".xlsx,.csv" className={inputCls}
             onChange={e => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      {estado.estado === "procesando" && <Spinner texto="Procesando…" />}
      {estado.estado === "error" && <p className="text-[12px] text-bad font-medium mt-3">{estado.error}</p>}
      {estado.estado === "ok" && (
        <p className="text-[12px] text-ok font-semibold mt-3">
          ✓ {estado.resultado.nuevas} nuevas de {estado.resultado.recibidas} filas (las repetidas no duplican)
        </p>
      )}
    </Card>
  );
}

const mesLargo = m => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("es-AR", { month: "long", year: "numeric", timeZone: "UTC" });

export default function Contabilidad() {
  const [mes, setMes] = useState(hoyISO().slice(0, 7));
  const [tab, setTab] = useState("iva");
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [estados, setEstados] = useState({});
  const [sync, setSync] = useState(null);
  const [busqueda, setBusqueda] = useState("");
  const [soloFaltan, setSoloFaltan] = useState(false);
  const [detalle, setDetalle] = useState(null);

  const cargar = async (m = mes) => {
    setCargando(true); setError("");
    try { setData(await getJSON(`/api/metricas?action=contabilidad&mes=${m}`)); }
    catch (e) { setError(e.message); }
    setCargando(false);
  };
  useEffect(() => { cargar(mes); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [mes]);

  const subir = (clave, parser, endpoint) => async (file) => {
    if (!file) return;
    setEstados(s => ({ ...s, [clave]: { estado: "procesando" } }));
    try {
      const filas = await parser(file);
      const payload = clave === "emitidos" || clave === "recibidos" ? { clase: clave, filas } : { filas };
      const resultado = await postJSON(`/api/metricas?action=${endpoint}`, payload, 120000);
      setEstados(s => ({ ...s, [clave]: { estado: "ok", resultado } }));
      cargar();
    } catch (e) {
      setEstados(s => ({ ...s, [clave]: { estado: "error", error: e.message } }));
    }
  };

  const cambiarRubro = async (cuit, rubro) => {
    setData(d => ({ ...d, proveedores: d.proveedores.map(p => p.cuit === cuit ? { ...p, rubro } : p) }));
    try { await postJSON("/api/metricas?action=rubroProveedor", { cuit, rubro }); cargar(); }
    catch (e) { setError(e.message); }
  };

  const sincronizar = async () => {
    setSync({ corriendo: true });
    try { setSync(await getJSON("/api/metricas?action=arcaSync", 120000)); cargar(); }
    catch (e) { setSync({ ok: false, motivo: e.message }); }
  };

  const meses = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(`${hoyISO().slice(0, 7)}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    meses.push(d.toISOString().slice(0, 7));
  }

  const ivaMes = data?.iva?.find(r => r.mes === mes);
  const totalVenta = data?.cruce?.reduce((a, r) => a + r.venta, 0) || 0;
  const totalFacturado = data?.cruce?.reduce((a, r) => a + r.facturado, 0) || 0;
  const gastosMes = data?.rubros?.reduce((a, r) => a + r.total, 0) || 0;
  // Confirmados por Alan; los Dragonfish además se auto-detectan del orden_id
  const pvHint = { 33: "Online", 1901: "Palermo", 1902: "La Plata", 1904: "Dot", 1905: "Abasto", 1401: "Córdoba" };
  for (const r of data?.pvLocales || []) if (!pvHint[Number(r.pv)]) pvHint[Number(r.pv)] = r.local;
  const transferido = data?.conciliacion?.reduce((a, r) => a + r.transferido, 0) || 0;
  const sinRespaldo = data?.conciliacion?.filter(r => r.facturado < r.transferido * 0.9) || [];

  const th = "text-left text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold px-3 py-2";
  const td = "px-3 py-2 text-[12px] text-ink-2 tabular-nums";

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold text-ink">Contabilidad</h1>
          <p className="text-[13px] text-ink-3">IVA, facturación, gastos y conciliación</p>
        </div>
        <BotonActualizar onClick={() => cargar()} cargando={cargando} />
      </header>

      <Chips valor={tab} onChange={setTab} opciones={[
        { value: "iva", label: "IVA" },
        { value: "facturacion", label: "Facturación" },
        { value: "gastos", label: "Gastos" },
        { value: "conciliacion", label: "Conciliación" },
        { value: "carga", label: "Carga" },
      ]} />

      {tab !== "carga" && (
        <select value={mes} onChange={e => setMes(e.target.value)}
                className="rounded-md border border-borde bg-surface-1 px-3 py-2 text-[13px] font-semibold text-ink capitalize">
          {meses.map(m => <option key={m} value={m} className="capitalize">{mesLargo(m)}</option>)}
        </select>
      )}

      {error && <p className="text-[12px] text-bad font-medium">{error}</p>}
      {cargando && !data && <Spinner texto="Cargando…" />}

      {data && data.estado.emitidos === 0 && data.estado.recibidos === 0 && tab !== "carga" && (
        <Card>
          <p className="text-[13px] text-ink-2">
            Todavía no hay comprobantes cargados. Andá a la pestaña <strong>Carga</strong> y subí los exports de
            Mis Comprobantes (ARCA): emitidos y recibidos. Cuando el certificado esté activo, los emitidos
            van a entrar solos todas las noches.
          </p>
        </Card>
      )}

      {tab === "iva" && data && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card title="IVA débito (ventas)"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(ivaMes?.debito || 0)}</div></Card>
            <Card title="IVA crédito (compras)"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(ivaMes?.credito || 0)}</div></Card>
            <Card title="Posición del mes">
              <div className={`text-[24px] font-bold tabular-nums ${(ivaMes?.posicion || 0) > 0 ? "text-bad" : "text-ok"}`}>
                {fmtPesosCorto(ivaMes?.posicion || 0)}
              </div>
              <p className="text-[11px] text-ink-3 mt-1">{(ivaMes?.posicion || 0) > 0 ? "a pagar" : "a favor"}</p>
            </Card>
          </div>
          <Card title="Últimos meses">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px]">
                <thead><tr>
                  <th className={th}>Mes</th><th className={`${th} text-right`}>Facturado</th><th className={`${th} text-right`}>Débito</th>
                  <th className={`${th} text-right`}>Compras</th><th className={`${th} text-right`}>Crédito</th><th className={`${th} text-right`}>Posición</th>
                </tr></thead>
                <tbody>
                  {data.iva.map(r => (
                    <tr key={r.mes} className="border-t border-borde">
                      <td className={`${td} font-semibold capitalize`}>{mesLargo(r.mes)}</td>
                      <td className={`${td} text-right`}>{fmtPesosCorto(r.facturado)}</td>
                      <td className={`${td} text-right`}>{fmtPesosCorto(r.debito)}</td>
                      <td className={`${td} text-right`}>{fmtPesosCorto(r.compras)}</td>
                      <td className={`${td} text-right`}>{fmtPesosCorto(r.credito)}</td>
                      <td className={`${td} text-right font-bold ${r.posicion > 0 ? "text-bad" : "text-ok"}`}>{fmtPesosCorto(r.posicion)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-3 mt-3">
              La posición real de ARCA además resta retenciones y percepciones sufridas; esto es la foto
              débito−crédito para anticipar la liquidación del contador.
            </p>
          </Card>
        </>
      )}

      {tab === "facturacion" && data && (() => {
        const locales = data.facturacionLocal || [];
        const alertas = locales.filter(l => l.ratio != null && l.ratioPrev != null && Math.abs(l.ratio - l.ratioPrev) > 0.1);
        return (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card title="Venta total del mes"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(totalVenta)}</div></Card>
            <Card title="Facturado en ARCA"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(totalFacturado)}</div></Card>
            <Card title="Locales fuera de su patrón">
              <div className={`text-[24px] font-bold tabular-nums ${alertas.length ? "text-warn" : "text-ok"}`}>{alertas.length}</div>
              <p className="text-[11px] text-ink-3 mt-1">
                {alertas.length ? alertas.map(a => a.local).join(", ") : "todos facturan como el mes pasado"}
              </p>
            </Card>
          </div>

          <Card title="Facturación por local">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px]">
                <thead><tr>
                  <th className={th}>Local</th><th className={`${th} text-right`}>Venta</th>
                  <th className={`${th} text-right`}>Cobrado Point</th><th className={`${th} text-right`}>Facturado</th>
                  <th className={`${th} text-right`}>% de la venta</th><th className={`${th} text-right`}>mes anterior</th>
                </tr></thead>
                <tbody>
                  {locales.map(l => {
                    const salto = l.ratio != null && l.ratioPrev != null && Math.abs(l.ratio - l.ratioPrev) > 0.1;
                    return (
                      <tr key={l.local} className="border-t border-borde">
                        <td className={`${td} font-semibold text-ink`}>{l.local === "Tiendanube" ? "Online" : l.local}
                          <span className="text-[10px] text-ink-3 ml-1.5">PV {String(l.punto_venta).padStart(4, "0")}</span></td>
                        <td className={`${td} text-right`}>{fmtPesosCorto(l.venta)}</td>
                        <td className={`${td} text-right`}>{l.point ? fmtPesosCorto(l.point) : "—"}</td>
                        <td className={`${td} text-right`}>{fmtPesosCorto(l.facturado)}</td>
                        <td className={`${td} text-right font-bold ${salto ? "text-warn" : "text-ink"}`}>
                          {l.ratio != null ? Math.round(l.ratio * 100) + "%" : "—"}
                        </td>
                        <td className={`${td} text-right text-ink-3`}>
                          {l.ratioPrev != null ? Math.round(l.ratioPrev * 100) + "%" : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-3 mt-3">
              Cada local factura una porción distinta de lo que vende: online factura todo, y en los locales depende
              de la operatoria de cada uno. Por eso no se compara contra una regla única sino contra{" "}
              <strong>el propio ratio del mes anterior</strong>: lo que hay que detectar es un cambio de
              comportamiento. Se marca en amarillo cuando el porcentaje se movió más de 10 puntos. Como la
              facturación es manual y a veces se pasan facturas al mes siguiente, un mes suelto puede desviarse.
            </p>
          </Card>
          <Card title="Detalle por punto de venta"
                right={<span className="text-[11px] text-ink-3">si aparece un PV sin nombre, avisame y lo mapeo</span>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead><tr><th className={th}>PV</th><th className={th}>Local</th><th className={`${th} text-right`}>Comprobantes</th><th className={`${th} text-right`}>Facturado</th></tr></thead>
                <tbody>
                  {data.porPV.map(r => (
                    <tr key={r.punto_venta} className="border-t border-borde">
                      <td className={`${td} font-semibold`}>{String(r.punto_venta).padStart(4, "0")}</td>
                      <td className={td}>{pvHint[r.punto_venta] || "—"}</td>
                      <td className={`${td} text-right`}>{r.comprobantes}</td>
                      <td className={`${td} text-right font-semibold`}>{fmtPesosCorto(r.total)}</td>
                    </tr>
                  ))}
                  {!data.porPV.length && <tr><td colSpan={4} className={`${td} text-center text-ink-3`}>Sin comprobantes emitidos este mes</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Día por día · venta total vs. facturado (referencia)">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px]">
                <thead><tr><th className={th}>Fecha</th><th className={`${th} text-right`}>Venta</th><th className={`${th} text-right`}>Facturado</th><th className={`${th} text-right`}>Dif.</th></tr></thead>
                <tbody>
                  {data.cruce.map(r => {
                    const dif = r.venta - r.facturado;
                    return (
                      <tr key={r.fecha} className="border-t border-borde">
                        <td className={td}>{r.fecha.slice(8, 10)}/{r.fecha.slice(5, 7)}</td>
                        <td className={`${td} text-right`}>{fmtPesosCorto(r.venta)}</td>
                        <td className={`${td} text-right`}>{fmtPesosCorto(r.facturado)}</td>
                        <td className={`${td} text-right font-semibold ${Math.abs(dif) > Math.max(r.venta, 1) * 0.05 ? "text-warn" : "text-ink-3"}`}>{fmtPesosCorto(dif)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
        );
      })()}

      {tab === "gastos" && data && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <Card title="Compras del mes (con IVA)"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(gastosMes)}</div></Card>
            <Card title="Comprobantes"><div className="text-[24px] font-bold text-ink tabular-nums">{data.rubros.reduce((a, r) => a + r.comprobantes, 0)}</div></Card>
          </div>
          <Card title="Por rubro">
            <div className="space-y-2">
              {data.rubros.map(r => (
                <div key={r.rubro}>
                  <div className="flex justify-between text-[12px] mb-0.5">
                    <span className="font-semibold text-ink-2">{r.rubro}</span>
                    <span className="tabular-nums text-ink">{fmtPesosCorto(r.total)} · {gastosMes ? Math.round(r.total / gastosMes * 100) : 0}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface overflow-hidden">
                    <div className="h-full rounded-full bg-negro" style={{ width: `${gastosMes ? Math.max(2, r.total / gastosMes * 100) : 0}%` }} />
                  </div>
                </div>
              ))}
              {!data.rubros.length && <p className="text-[12px] text-ink-3">Sin compras cargadas este mes.</p>}
            </div>
          </Card>
          <Card title="Por proveedor" right={<span className="text-[11px] text-ink-3">el rubro se asigna una vez y aplica a todas sus facturas</span>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead><tr><th className={th}>Proveedor</th><th className={th}>Rubro</th><th className={`${th} text-right`}>Cbtes.</th><th className={`${th} text-right`}>IVA</th><th className={`${th} text-right`}>Total</th></tr></thead>
                <tbody>
                  {data.proveedores.map(p => (
                    <tr key={p.cuit} className="border-t border-borde">
                      <td className={td}>
                        <div className="font-semibold text-ink">{p.nombre || "—"}</div>
                        <div className="text-[10px] text-ink-3">{fmtCuit(p.cuit)}</div>
                      </td>
                      <td className={td}>
                        <select value={p.rubro} onChange={e => cambiarRubro(p.cuit, e.target.value)}
                                className="rounded-md border border-borde bg-surface-1 px-2 py-1 text-[11px] font-semibold text-ink-2">
                          {RUBROS.map(r => <option key={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className={`${td} text-right`}>{p.comprobantes}</td>
                      <td className={`${td} text-right`}>{fmtPesosCorto(p.iva)}</td>
                      <td className={`${td} text-right font-semibold`}>{fmtPesos(p.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {tab === "conciliacion" && data && (() => {
        const q = busqueda.trim().toLowerCase();
        const coincide = t => !q || String(t || "").toLowerCase().includes(q);
        const filas = data.conciliacion.filter(r =>
          (!soloFaltan || r.facturado < r.transferido * 0.9) &&
          (coincide(r.nombre) || r.movimientos.some(m => coincide(m.id))));
        const movsBusqueda = q
          ? (data.movimientos || []).filter(m => coincide(m.contraparte) || coincide(m.detalle) || coincide(m.id))
          : [];
        return (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card title="Transferido a proveedores"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(transferido)}</div></Card>
            <Card title="Proveedores"><div className="text-[24px] font-bold text-ink tabular-nums">{data.conciliacion.length}</div></Card>
            <Card title="Con facturación corta">
              <div className={`text-[24px] font-bold tabular-nums ${sinRespaldo.length ? "text-bad" : "text-ok"}`}>{sinRespaldo.length}</div>
              {sinRespaldo.length > 0 && <p className="text-[11px] text-ink-3 mt-1">{fmtPesosCorto(sinRespaldo.reduce((a, e) => a + (e.transferido - Math.max(e.facturado, 0)), 0))} transferidos sin factura que los cubra</p>}
            </Card>
          </div>

          <Card>
            <div className="flex gap-2 flex-wrap items-center">
              <input value={busqueda} onChange={e => setBusqueda(e.target.value)}
                     placeholder="Buscar proveedor, concepto o N° de operación…"
                     className="flex-1 min-w-[220px] rounded-md border border-borde bg-surface-1 px-3 py-2 text-[13px] text-ink" />
              <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-2">
                <input type="checkbox" checked={soloFaltan} onChange={e => setSoloFaltan(e.target.checked)} />
                Solo los que faltan
              </label>
              {(q || soloFaltan) && (
                <button onClick={() => { setBusqueda(""); setSoloFaltan(false); }}
                        className="text-[12px] font-semibold text-ink-3 underline">Limpiar</button>
              )}
            </div>
          </Card>

          <Card title="Transferencias vs. facturas, por proveedor"
                right={<span className="text-[11px] text-ink-3">tocá una fila para ver el detalle</span>}>
            {!data.conciliacion.length ? (
              <p className="text-[13px] text-ink-2">
                Subí el <strong>estado de cuenta</strong> de MercadoPago (Dinero → Movimientos → Exportar) en la
                pestaña Carga: acá se compara cuánto le transferiste a cada proveedor contra cuánto te facturó.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px]">
                    <thead><tr><th className={th}>Proveedor</th><th className={`${th} text-right`}>Transf.</th><th className={`${th} text-right`}>Transferido</th><th className={`${th} text-right`}>Facturado</th><th className={th}>Estado</th></tr></thead>
                    <tbody>
                      {filas.map(r => {
                        const ok = r.facturado >= r.transferido * 0.9;
                        const abierto = detalle === r.nombre;
                        return (
                          <tr key={r.nombre} onClick={() => setDetalle(abierto ? null : r.nombre)}
                              className={`border-t border-borde cursor-pointer hover:bg-surface ${abierto ? "bg-surface" : ""}`}>
                            <td className={`${td} font-semibold text-ink`}>
                              <span className="text-ink-3 mr-1.5">{abierto ? "▾" : "▸"}</span>{r.nombre}
                            </td>
                            <td className={`${td} text-right`}>{r.transferencias}</td>
                            <td className={`${td} text-right`}>{fmtPesos(r.transferido)}</td>
                            <td className={`${td} text-right`}>{fmtPesos(r.facturado)}</td>
                            <td className={td}>{ok
                              ? <span className="text-ok font-semibold">✓ cubierto{r.porMonto ? " (por monto)" : ""}</span>
                              : <span className="text-bad font-semibold">faltan {fmtPesosCorto(r.transferido - Math.max(r.facturado, 0))}</span>}</td>
                          </tr>
                        );
                      })}
                      {!filas.length && <tr><td colSpan={5} className={`${td} text-center text-ink-3`}>Sin resultados para esa búsqueda</td></tr>}
                    </tbody>
                  </table>
                </div>

                {/* El detalle vive fuera del scroll horizontal de la tabla: en celular
                    tiene que leerse completo sin desplazar de costado. */}
                {(() => {
                  const r = filas.find(x => x.nombre === detalle);
                  if (!r) return null;
                  return (
                    <div className="mt-3 rounded-md bg-surface border border-borde p-4">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <span className="text-[13px] font-bold text-ink">{r.nombre}</span>
                        <button onClick={() => setDetalle(null)} className="text-[11px] font-semibold text-ink-3">Cerrar ✕</button>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold mb-1.5">
                            Transferencias ({r.movimientos.length})
                          </div>
                          {r.movimientos.map(m => (
                            <div key={m.id} className="flex justify-between items-baseline gap-2 text-[12px] py-1.5 border-b border-borde last:border-0">
                              <span className="text-ink-2 shrink-0">{m.fecha.slice(8, 10)}/{m.fecha.slice(5, 7)}</span>
                              <span className="text-ink-3 text-[10px] font-mono truncate" title="N° de operación en MercadoPago">op. {m.id}</span>
                              <span className="tabular-nums font-semibold text-ink shrink-0">{fmtPesos(m.monto)}</span>
                            </div>
                          ))}
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold mb-1.5">
                            Facturas imputadas ({r.comprobantes.length})
                          </div>
                          {r.comprobantes.length === 0 ? (
                            <p className="text-[12px] text-bad font-medium">
                              Ninguna. Reclamale el comprobante al proveedor, o revisá si facturó en otro mes
                              (subí ese período en Carga).
                            </p>
                          ) : r.comprobantes.map(c => (
                            <div key={`${c.tipo}-${c.punto_venta}-${c.numero}`} className="flex justify-between items-baseline gap-2 text-[12px] py-1.5 border-b border-borde last:border-0">
                              <span className="text-ink-2 shrink-0">{c.fecha.slice(8, 10)}/{c.fecha.slice(5, 7)}</span>
                              <span className="text-ink-3 text-[10px] truncate">
                                {data.nombresTipo?.[c.tipo] || `Tipo ${c.tipo}`} {String(c.punto_venta).padStart(4, "0")}-{String(c.numero).padStart(8, "0")}
                              </span>
                              <span className="tabular-nums font-semibold text-ink shrink-0">{fmtPesos(c.total)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
                <p className="text-[11px] text-ink-3 mt-3">
                  Se compara por total (los pagos suelen ser parciales), con facturas de hasta 20 días antes o después
                  del mes. Las transferencias a cuentas propias o retiros de socios van a figurar "sin factura": es esperable.
                  El <strong>N° de operación</strong> de cada transferencia es el mismo que aparece en MercadoPago → Actividad.
                </p>
              </>
            )}
          </Card>

          {q && (
            <Card title={`Todos los movimientos que coinciden con "${busqueda}" (${movsBusqueda.length})`}>
              {!movsBusqueda.length ? (
                <p className="text-[12px] text-ink-3">Ningún movimiento de este mes coincide. Probá con otro mes.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px]">
                    <thead><tr><th className={th}>Fecha</th><th className={th}>Concepto</th><th className={th}>N° operación</th><th className={`${th} text-right`}>Monto</th></tr></thead>
                    <tbody>
                      {movsBusqueda.map(m => (
                        <tr key={m.id} className="border-t border-borde">
                          <td className={td}>{m.fecha.slice(8, 10)}/{m.fecha.slice(5, 7)}</td>
                          <td className={td}>{m.detalle}</td>
                          <td className={`${td} text-[10px] font-mono text-ink-3`}>{m.id}</td>
                          <td className={`${td} text-right font-semibold`}>{fmtPesos(m.monto)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {data.otrosEgresos?.length > 0 && (
            <Card title="Otros egresos de la cuenta MP (no transferencias)">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]">
                  <thead><tr><th className={th}>Canal</th><th className={`${th} text-right`}>Pagos</th><th className={`${th} text-right`}>Total</th></tr></thead>
                  <tbody>
                    {data.otrosEgresos.map(r => (
                      <tr key={r.canal} className="border-t border-borde">
                        <td className={`${td} font-semibold`}>{r.canal}</td>
                        <td className={`${td} text-right`}>{r.pagos}</td>
                        <td className={`${td} text-right font-semibold`}>{fmtPesos(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
        );
      })()}

      {tab === "carga" && (
        <>
          <Card title="Estado">
            <div className="text-[12px] text-ink-2 space-y-1">
              <div>Comprobantes emitidos en la base: <strong className="tabular-nums">{data?.estado.emitidos ?? "…"}</strong></div>
              <div>Comprobantes recibidos en la base: <strong className="tabular-nums">{data?.estado.recibidos ?? "…"}</strong></div>
              <div>Conexión ARCA (web service): {data?.arca
                ? <strong className="text-ok">activa — los emitidos entran solos cada noche</strong>
                : <strong className="text-warn">pendiente del certificado — mientras tanto cargá los emitidos a mano</strong>}</div>
            </div>
            {data?.arca && (
              <div className="mt-3">
                <button onClick={sincronizar} disabled={sync?.corriendo}
                        className="rounded-md bg-negro text-white px-3.5 py-2 text-[12px] font-semibold disabled:opacity-50">
                  {sync?.corriendo ? "Sincronizando…" : "Traer emitidos ahora"}
                </button>
                {sync && !sync.corriendo && (
                  <p className="text-[12px] mt-2 text-ink-2">
                    {sync.ok ? `✓ ${sync.cargados} comprobantes traídos${sync.pendientes ? ` · quedan ${sync.pendientes} (se completan en las próximas corridas)` : ""}` : sync.motivo}
                  </p>
                )}
              </div>
            )}
          </Card>
          <Uploader titulo="ARCA · Comprobantes recibidos (compras)" estado={estados.recibidos || { estado: "idle" }}
            descripcion="ARCA → Mis Comprobantes → Recibidos → elegí el período → Exportar (xlsx o csv). Subilo cada 2-3 días: las filas repetidas no duplican."
            onFile={subir("recibidos", f => parsearMisComprobantes(f, "recibidos"), "cargarComprobantes")} />
          <Uploader titulo="ARCA · Comprobantes emitidos (hasta que ande el certificado)" estado={estados.emitidos || { estado: "idle" }}
            descripcion="ARCA → Mis Comprobantes → Emitidos → período → Exportar. Cuando el web service esté activo, esta carga deja de ser necesaria."
            onFile={subir("emitidos", f => parsearMisComprobantes(f, "emitidos"), "cargarComprobantes")} />
          <Uploader titulo="MercadoPago · Estado de cuenta (para conciliar transferencias)" estado={estados.egresos || { estado: "idle" }}
            descripcion="MercadoPago → Dinero → Movimientos → Exportar (estado de cuenta). Tomo solo la plata que sale: transferencias a proveedores (se concilian contra sus facturas), pauta, envíos y servicios."
            onFile={subir("egresos", parsearMovimientosMP, "cargarEgresos")} />
        </>
      )}
    </div>
  );
}
