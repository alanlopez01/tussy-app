// Contabilidad: posición de IVA, control de facturación, gastos por rubro y
// conciliación de transferencias MP contra facturas recibidas.
// Los exports de ARCA (Mis Comprobantes) y de MP se leen en el navegador y se
// suben ya normalizados; el WS de ARCA trae los emitidos solo cuando hay certificado.
import { useEffect, useState } from "react";
import { getJSON, postJSON, fmtPesos, fmtPesosCorto, hoyISO } from "../lib/api.js";
import { Card, Spinner, BotonActualizar, Chips, DatosDelMes } from "../components/ui.jsx";

const RUBROS = [
  "Mercadería / Fábrica", "Tela", "Alquileres", "Servicios", "Publicidad", "Logística",
  "Impuestos", "Honorarios", "Financiero", "Insumos", "Sueldos", "Factura",
  "Transferencias cuenta propia", "Otros", "Sin rubro",
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
  // Sin acentos de los dos lados: así "número desde" matchea aunque el archivo
  // venga con encoding raro o el patrón se escriba distinto
  const limpiar = t => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const celdas = (rows[i] || []).map(limpiar);
    const idx = {};
    for (const [clave, patrones] of Object.entries(requeridas)) {
      idx[clave] = -1;
      for (const p of patrones) {
        const pl = limpiar(p);
        const j = celdas.findIndex(c => c.includes(pl));
        if (j >= 0) { idx[clave] = j; break; }
      }
    }
    if (idx.fecha >= 0 && idx.total >= 0) return { fila: i, idx };
  }
  return null;
}

async function leerHojas(file) {
  const XLSX = await import("xlsx");
  // Los CSV de ARCA vienen en UTF-8: hay que leerlos como texto (el navegador
  // decodifica bien); si se leen como bytes, SheetJS asume Latin-1 y los
  // acentos se rompen ("Número" → "NÃºmero") y no matchea ninguna columna.
  const esTexto = /\.(csv|txt)$/i.test(file.name || "");
  // raw:true en los CSV: que NO intente convertir "13611206,11" a número — lo
  // interpreta con coma de miles y multiplica todo por 100. Los montos quedan
  // como texto y los convierte aNumero, que entiende la coma decimal argentina.
  const wb = esTexto
    ? XLSX.read(await file.text(), { type: "string", raw: true })
    : XLSX.read(await file.arrayBuffer(), { cellDates: true });
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
  if (!filas.length) {
    const soloEncabezado = rows.length <= fila + 1;
    throw new Error(soloEncabezado
      ? "El export vino vacío: no hay comprobantes en el período que elegiste en ARCA."
      : "Leí el archivo pero ninguna fila tiene fecha, tipo y número válidos. Pasámelo por el chat y lo reviso.");
  }
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
    if (!fecha || !monto) continue;
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
      entrada: monto > 0, // liquidaciones Point/QR, dLocal (PagoNube), transferencias recibidas
      contraparte,
      cuit: null,
      detalle: tipo,
    });
  }
  if (!filas.length) throw new Error("No encontré movimientos en el archivo.");
  // Encabezado del extracto: INITIAL_BALANCE / CREDITS / DEBITS / FINAL_BALANCE
  let saldoFinal = null;
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const c0 = String((rows[i] || [])[0] ?? "").toUpperCase();
    if (c0.includes("INITIAL_BALANCE")) {
      const vals = rows[i + 1] || [];
      saldoFinal = aNumero(vals[3]);
      break;
    }
  }
  const fechaCorte = filas.reduce((a, f) => f.fecha > a ? f.fecha : a, filas[0].fecha);
  return { filas, saldo: saldoFinal != null && saldoFinal !== 0 ? { cuenta: "mp", fecha: fechaCorte, saldo: saldoFinal } : null };
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

// Listado buscable de facturas recibidas: sin búsqueda muestra el mes elegido;
// con búsqueda rastrea todo el historial (proveedor, CUIT o número).
function FacturasRecibidas({ mes }) {
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);

  const buscar = (query) => {
    setCargando(true);
    const qs = query ? `q=${encodeURIComponent(query)}` : `mes=${mes}`;
    getJSON(`/api/metricas?action=facturasRecibidas&${qs}`, 30000)
      .then(setData).catch(() => setData(null)).finally(() => setCargando(false));
  };
  useEffect(() => { setQ(""); buscar(""); }, [mes]); // eslint-disable-line react-hooks/exhaustive-deps

  const th = "text-left text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold px-3 py-2";
  const td = "px-3 py-2 text-[12px] text-ink-2 tabular-nums";
  const total = (data?.facturas || []).reduce((a, f) => a + ([3, 8, 13].includes(f.tipo) ? -f.total : f.total), 0);

  return (
    <Card title={data?.q ? `Facturas que coinciden con "${data.q}" (${data?.facturas.length || 0})` : `Facturas recibidas del mes (${data?.facturas.length || 0})`}
          right={<span className="text-[11px] text-ink-3 tabular-nums">total {fmtPesosCorto(total)}</span>}>
      <div className="flex gap-2 mb-3">
        <input value={q} onChange={e => setQ(e.target.value)}
               onKeyDown={e => e.key === "Enter" && buscar(q)}
               placeholder="Buscar por proveedor, CUIT o N° de factura (en todo el historial)…"
               className="flex-1 rounded-md border border-borde bg-surface-1 px-3 py-2 text-[13px] text-ink" />
        <button onClick={() => buscar(q)} className="rounded-md bg-negro text-white px-3.5 text-[12px] font-semibold">Buscar</button>
        {data?.q && <button onClick={() => { setQ(""); buscar(""); }} className="text-[12px] font-semibold text-ink-3 underline">Limpiar</button>}
      </div>
      {cargando ? <Spinner /> : !data?.facturas.length ? (
        <p className="text-[12px] text-ink-3 py-3 text-center">Sin facturas {data?.q ? "que coincidan" : "cargadas este mes"}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr>
              <th className={th}>Fecha</th><th className={th}>Comprobante</th><th className={th}>Proveedor</th>
              <th className={`${th} text-right`}>Neto</th><th className={`${th} text-right`}>IVA</th><th className={`${th} text-right`}>Total</th>
            </tr></thead>
            <tbody>
              {data.facturas.map((f, i) => (
                <tr key={i} className="border-t border-borde">
                  <td className={td}>{f.fecha.slice(8, 10)}/{f.fecha.slice(5, 7)}/{f.fecha.slice(2, 4)}</td>
                  <td className={`${td} text-[10px]`}>{data.nombresTipo?.[f.tipo] || `T${f.tipo}`} {String(f.punto_venta).padStart(4, "0")}-{String(f.numero).padStart(8, "0")}</td>
                  <td className={td}>
                    <div className="font-semibold text-ink">{f.emisor || "—"}</div>
                    <div className="text-[10px] text-ink-3">{fmtCuit(f.cuit_emisor)}</div>
                  </td>
                  <td className={`${td} text-right`}>{fmtPesosCorto(f.neto)}</td>
                  <td className={`${td} text-right`}>{fmtPesosCorto(f.iva)}</td>
                  <td className={`${td} text-right font-semibold ${[3, 8, 13].includes(f.tipo) ? "text-bad" : ""}`}>
                    {[3, 8, 13].includes(f.tipo) ? "−" : ""}{fmtPesos(f.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ¿Dónde está la plata? Puente resultado → cajas del mes.
function Flujo({ mes }) {
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [declEdit, setDeclEdit] = useState(null);
  const [declValor, setDeclValor] = useState("");
  const recargar = () => getJSON(`/api/metricas?action=flujoMes&mes=${mes}`, 60000)
    .then(setData).catch(() => setData(null)).finally(() => setCargando(false));
  useEffect(() => {
    setCargando(true); setData(null);
    recargar();
  }, [mes]); // eslint-disable-line react-hooks/exhaustive-deps

  const guardarDeclarado = async (local) => {
    const saldo = Math.round(Number(declValor.replace(/\./g, "")) || 0);
    setDeclEdit(null);
    if (!saldo) return;
    try {
      await postJSON("/api/metricas?action=guardarEfectivoLocal", { local, saldo });
      recargar();
    } catch { /* siguiente refresh */ }
  };

  if (cargando) return <Spinner texto="Armando el flujo del mes…" />;
  if (!data) return <Card><p className="text-[12px] text-bad">No pude calcular el flujo. Probá actualizar.</p></Card>;
  const c = data.cajas, p = data.puente;
  const fila = (label, monto, extra) => (
    <div className="flex justify-between items-baseline gap-3 py-1.5 border-b border-borde last:border-0 text-[12px]">
      <span className="text-ink-2">{label}{extra && <span className="text-ink-3 text-[11px]"> · {extra}</span>}</span>
      <span className={`tabular-nums font-semibold shrink-0 ${monto >= 0 ? "text-ink" : "text-bad"}`}>{monto >= 0 ? "+" : "−"}{fmtPesosCorto(Math.abs(monto))}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Card title="Δ MercadoPago">
          <div className={`text-[22px] font-bold tabular-nums ${c.mp.delta >= 0 ? "text-ok" : "text-bad"}`}>{c.mp.delta >= 0 ? "+" : ""}{fmtPesosCorto(c.mp.delta)}</div>
          <p className="text-[11px] text-ink-3 mt-1">entró {fmtPesosCorto(c.mp.entradas)} · salió {fmtPesosCorto(c.mp.salidas)}</p>
        </Card>
        <Card title="Δ Galicia">
          <div className={`text-[22px] font-bold tabular-nums ${c.galicia.delta >= 0 ? "text-ok" : "text-bad"}`}>{c.galicia.delta >= 0 ? "+" : ""}{fmtPesosCorto(c.galicia.delta)}</div>
          <p className="text-[11px] text-ink-3 mt-1">entró {fmtPesosCorto(c.galicia.entradas)} · salió {fmtPesosCorto(c.galicia.salidas)}</p>
        </Card>
        <Card title="Δ Caja efectivo">
          <div className={`text-[22px] font-bold tabular-nums ${(c.efectivo?.delta || 0) >= 0 ? "text-ok" : "text-bad"}`}>
            {c.efectivo ? `${c.efectivo.delta >= 0 ? "+" : ""}${fmtPesosCorto(c.efectivo.delta)}` : "—"}
          </div>
          <p className="text-[11px] text-ink-3 mt-1">{c.efectivo ? `entró ${fmtPesosCorto(c.efectivo.ingresos)} · salió ${fmtPesosCorto(c.efectivo.gastos)}` : "sin datos de Finanzas"}</p>
        </Card>
        <Card title="Saldo caja efectivo hoy">
          <div className="text-[22px] font-bold tabular-nums text-ink">{c.efectivo ? fmtPesosCorto(c.efectivo.saldo_actual) : "—"}</div>
          <p className="text-[11px] text-ink-3 mt-1">del sistema de Finanzas (solo Tussy)</p>
        </Card>
      </div>

      {c.mp.sin_entradas && (
        <Card><p className="text-[12px] text-warn font-medium">
          ⚠️ El estado de cuenta de MP de este mes se cargó con la versión vieja (solo salidas). Re-subilo en
          Carga para tener también las entradas (liquidaciones Point/QR y PagoNube vía dLocal) y que el flujo cierre.
        </p></Card>
      )}

      {data.saldos_cierre && (
        <Card title="La plata, al cierre del mes"
              right={<span className="text-[11px] text-ink-3">saldos que capturan los extractos al cargarse</span>}>
          <div className="grid gap-3 sm:grid-cols-4">
            {[["MercadoPago", data.saldos_cierre.mp?.saldo, data.saldos_cierre.mp?.fecha],
              ["Galicia", data.saldos_cierre.galicia?.saldo, data.saldos_cierre.galicia?.fecha],
              ["Caja efectivo", data.saldos_cierre.efectivo?.saldo, "hoy"],
              ["Tienda en tránsito (PagoNube)", data.saldos_cierre.en_transito_tienda || 0, "llega el mes siguiente"]].map(([l, v, f]) => (
              <div key={l} className="bg-surface rounded-md px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">{l}</div>
                <div className="text-[17px] font-bold tabular-nums text-ink mt-0.5">{v != null ? fmtPesosCorto(v) : "—"}</div>
                {f && <div className="text-[10px] text-ink-3">{typeof f === "string" && f.includes("-") ? `al ${f.slice(8, 10)}/${f.slice(5, 7)}` : f}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="¿Dónde está la plata del resultado?">
        {p.lineas.map(l => fila(l.label, l.monto))}
        <div className="flex justify-between items-baseline gap-3 py-2 border-t-2 border-borde text-[13px] font-bold">
          <span className="text-ink">Debería haber quedado en las cajas</span>
          <span className="tabular-nums">{p.esperado >= 0 ? "+" : "−"}{fmtPesosCorto(Math.abs(p.esperado))}</span>
        </div>
        <div className="flex justify-between items-baseline gap-3 py-1 text-[13px] font-bold">
          <span className="text-ink">Quedó de verdad (Δ MP + Galicia + efectivo)</span>
          <span className="tabular-nums">{p.observado >= 0 ? "+" : "−"}{fmtPesosCorto(Math.abs(p.observado))}</span>
        </div>
        <div className={`flex justify-between items-baseline gap-3 py-2 rounded-md px-3 mt-1 text-[13px] font-bold ${Math.abs(p.sin_ubicar) > 10e6 ? "bg-bad/10 text-bad" : "bg-surface text-ok"}`}>
          <span>Sin ubicar</span>
          <span className="tabular-nums">{fmtPesosCorto(p.sin_ubicar)}</span>
        </div>
        <p className="text-[11px] text-ink-3 mt-3">
          {p.nota_stock && <>Δ stock: {p.nota_stock}. </>}
          {data.efectivo_cruce?.rendido_a_caja != null && (
            <>Efectivo cobrado en los locales {fmtPesosCorto(data.efectivo_cruce.cobrado_locales)} vs. rendido a la
            caja central {fmtPesosCorto(data.efectivo_cruce.rendido_a_caja)}: la diferencia paga gastos en el
            local o queda en las cajas de los locales — parte del "sin ubicar" vive ahí. </>
          )}
          "Sin ubicar" junta lo que falta medir (stock, efectivo sin rendir, timing de acreditaciones) y
          cualquier fuga real: si un mes da grande y no hay explicación, ahí hay que mirar.
        </p>
      </Card>

      {data.rendiciones && (
        <Card title="Efectivo en los locales · cobrado vs. rendido"
              right={<span className="text-[11px] text-ink-3">desde junio (cuando se empezó a medir el medio de pago) · tocá "declarado" para cargar el conteo físico</span>}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[560px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-3 border-b border-borde">
                  <th className="text-left py-2 font-semibold">Local</th>
                  <th className="text-right py-2 font-semibold">Cobrado</th>
                  <th className="text-right py-2 font-semibold">Rendido a caja</th>
                  <th className="text-right py-2 font-semibold">Pendiente</th>
                  <th className="text-right py-2 font-semibold">Declarado en local</th>
                  <th className="text-right py-2 font-semibold">Dif.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-borde">
                {data.rendiciones.map(r => (
                  <tr key={r.local}>
                    <td className="py-2 font-semibold text-ink">{r.local}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">{fmtPesosCorto(r.cobrado)}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">{fmtPesosCorto(r.rendido)}</td>
                    <td className={`py-2 text-right tabular-nums font-bold ${r.pendiente > 5e6 ? "text-warn" : "text-ink"}`}>{fmtPesosCorto(r.pendiente)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {declEdit === r.local ? (
                        <input autoFocus value={declValor} onChange={e => setDeclValor(e.target.value)}
                               onBlur={() => guardarDeclarado(r.local)}
                               onKeyDown={e => e.key === "Enter" && guardarDeclarado(r.local)}
                               inputMode="numeric" placeholder="conteo físico"
                               className="w-28 rounded border border-borde bg-surface-1 px-2 py-0.5 text-right text-[12px]" />
                      ) : (
                        <button onClick={() => { setDeclEdit(r.local); setDeclValor(r.declarado ? String(Math.round(r.declarado)) : ""); }}
                                className="text-ink-2 underline decoration-dotted underline-offset-2">
                          {r.declarado != null ? `${fmtPesosCorto(r.declarado)}` : "declarar"}
                        </button>
                      )}
                      {r.declarado_fecha && <div className="text-[9px] text-ink-3">al {r.declarado_fecha.slice(8, 10)}/{r.declarado_fecha.slice(5, 7)}</div>}
                    </td>
                    <td className={`py-2 text-right tabular-nums font-semibold ${r.declarado == null ? "text-ink-3" : Math.abs(r.pendiente - r.declarado) > 3e6 ? "text-bad" : "text-ok"}`}>
                      {r.declarado != null ? fmtPesosCorto(r.declarado - r.pendiente) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-ink-3 mt-3">
            <strong>Pendiente</strong> = cobrado en efectivo − rendido a la caja central: es la plata que debería
            estar en el local (o que pagó gastos ahí que todavía no se registraron). Cargando el{" "}
            <strong>conteo físico</strong> la columna Dif. muestra cuánto se usó en gastos sin registrar (negativo)
            o si sobra. La Plata y Córdoba no tienen categoría de rendición en Finanzas: su efectivo se acumula ahí.
          </p>
        </Card>
      )}

      {c.efectivo && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Caja efectivo · en qué se gastó">
            {Object.entries(c.efectivo.por_categoria_gasto).sort((a, b) => b[1] - a[1]).map(([k, v]) => fila(k, -Number(v)))}
          </Card>
          <Card title="Caja efectivo · de dónde entró">
            {Object.entries(c.efectivo.por_categoria_ingreso).sort((a, b) => b[1] - a[1]).map(([k, v]) => fila(k, Number(v)))}
          </Card>
        </div>
      )}
    </div>
  );
}

// La liquidación que determina la contadora (~día 18): queda como número oficial
// del mes y alimenta directo la cascada de Rentabilidad.
function LiquidacionContadora({ mes, ivaMes, onGuardado }) {
  const [decl, setDecl] = useState("");
  const [pag, setPag] = useState("");
  const [estado, setEstado] = useState("idle");
  useEffect(() => {
    setDecl(ivaMes?.declarado != null ? String(Math.round(ivaMes.declarado)) : "");
    setPag(ivaMes?.pagado != null ? String(Math.round(ivaMes.pagado)) : "");
    setEstado("idle");
  }, [mes, ivaMes?.declarado, ivaMes?.pagado]);

  const guardar = async () => {
    setEstado("guardando");
    try {
      await postJSON("/api/metricas?action=guardarImpuestoMes",
        { mes, concepto: "iva", monto: decl === "" ? null : Number(decl.replace(/\./g, "")), nota: "F.2051 · cargado desde la app" });
      await postJSON("/api/metricas?action=guardarImpuestoMes",
        { mes, concepto: "iva_pagado", monto: pag === "" ? null : Number(pag.replace(/\./g, "")) });
      setEstado("ok");
      onGuardado();
    } catch (e) { setEstado("error"); }
  };

  return (
    <Card title={`Liquidación de la contadora · ${mesLargo(mes)}`}>
      <div className="flex gap-3 flex-wrap items-end">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Posición declarada (F.2051)</span>
          <input value={decl} onChange={e => setDecl(e.target.value)} inputMode="numeric" placeholder="ej. 6917490"
                 className="rounded-md border border-borde bg-surface-1 px-3 py-2 text-[13px] text-ink w-44 tabular-nums" />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">Pagado (VEP)</span>
          <input value={pag} onChange={e => setPag(e.target.value)} inputMode="numeric" placeholder="lo que salió del banco"
                 className="rounded-md border border-borde bg-surface-1 px-3 py-2 text-[13px] text-ink w-44 tabular-nums" />
        </label>
        <button onClick={guardar} disabled={estado === "guardando"}
                className="rounded-md bg-negro text-white px-4 py-2 text-[12px] font-semibold disabled:opacity-50">
          {estado === "guardando" ? "Guardando…" : "Guardar"}
        </button>
        {estado === "ok" && <span className="text-[12px] text-ok font-semibold">✓ guardado</span>}
        {estado === "error" && <span className="text-[12px] text-bad font-semibold">error, probá de nuevo</span>}
      </div>
      <p className="text-[11px] text-ink-3 mt-3">
        La <strong>posición declarada</strong> pasa a ser el IVA oficial del mes (pisa la foto de ARCA en la
        cascada de Rentabilidad). El <strong>pagado</strong> suele ser menor: la diferencia son retenciones y
        percepciones que ya te descontaron durante el mes — plata que ya estaba adelantada, no un ahorro.
      </p>
    </Card>
  );
}

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
  const [catAbierta, setCatAbierta] = useState(null);

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
      // El extracto bancario lo parsea el server (misma librería que los scripts);
      // los xlsx se leen acá porque el navegador ya trae el lector.
      let payload;
      if (clave === "banco") payload = { texto: await file.text() };
      else if (clave === "emitidos" || clave === "recibidos") payload = { clase: clave, filas: await parser(file) };
      else {
        const r = await parser(file);
        payload = Array.isArray(r) ? { filas: r } : r; // movimientos MP: {filas, saldo}
      }
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
  // Las transferencias a la cuenta propia del banco no son gasto: son plata que
  // cambia de bolsillo y se rastrea en el flujo de fondos, no contra una factura.
  const sinRespaldo = data?.conciliacion?.filter(r => !r.cuentaPropia && r.facturado < r.transferido * 0.9) || [];
  const aCuentaPropia = data?.conciliacion?.filter(r => r.cuentaPropia).reduce((a, r) => a + r.transferido, 0) || 0;

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
        { value: "flujo", label: "Flujo" },
        { value: "carga", label: "Carga" },
      ]} />

      {tab !== "carga" && (
        <select value={mes} onChange={e => setMes(e.target.value)}
                className="rounded-md border border-borde bg-surface-1 px-3 py-2 text-[13px] font-semibold text-ink capitalize">
          {meses.map(m => <option key={m} value={m} className="capitalize">{mesLargo(m)}</option>)}
        </select>
      )}

      {tab !== "carga" && <DatosDelMes mes={mes} />}

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
              <table className="w-full min-w-[680px]">
                <thead><tr>
                  <th className={th}>Mes</th><th className={`${th} text-right`}>Facturado</th><th className={`${th} text-right`}>Débito</th>
                  <th className={`${th} text-right`}>Compras</th><th className={`${th} text-right`}>Crédito</th><th className={`${th} text-right`}>Posición</th>
                  <th className={`${th} text-right`}>Declarado</th><th className={`${th} text-right`}>Dif.</th><th className={`${th} text-right`}>Pagado</th>
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
                      <td className={`${td} text-right font-semibold`}>{r.declarado != null ? fmtPesosCorto(r.declarado) : "—"}</td>
                      <td className={`${td} text-right ${r.declarado != null && Math.abs(r.posicion - r.declarado) > Math.abs(r.declarado || 1) * 0.15 ? "text-warn font-semibold" : "text-ink-3"}`}>
                        {r.declarado != null ? fmtPesosCorto(r.posicion - r.declarado) : "—"}
                      </td>
                      <td className={`${td} text-right`}>{r.pagado != null ? fmtPesosCorto(r.pagado) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-3 mt-3">
              <strong>Posición</strong> es nuestra foto débito−crédito desde ARCA; <strong>Declarado</strong> es
              la liquidación de la contadora (el número oficial). Una diferencia chica es normal (ajustes
              técnicos, saldos a favor arrastrados); si es grande, conviene revisarla con ella.{" "}
              <strong>Pagado</strong> suele ser menor al declarado por las retenciones ya sufridas.
            </p>
          </Card>
          <LiquidacionContadora mes={mes} ivaMes={ivaMes} onGuardado={() => cargar()} />
        </>
      )}

      {tab === "facturacion" && data && (() => {
        const locales = data.facturacionLocal || [];
        const alertas = locales.filter(l => l.ratio != null && l.ratioPrev != null && Math.abs(l.ratio - l.ratioPrev) > 0.1);
        const totalElec = locales.reduce((a, l) => a + (l.electronico || 0), 0);
        const hayElec = totalElec > 0;
        const difElec = totalElec - totalFacturado;
        return (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Card title="Venta total del mes"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(totalVenta)}</div></Card>
            <Card title="Pagos electrónicos">
              <div className="text-[24px] font-bold text-ink tabular-nums">{hayElec ? fmtPesosCorto(totalElec) : "—"}</div>
              <p className="text-[11px] text-ink-3 mt-1">
                {hayElec ? `${Math.round(totalElec / totalVenta * 100)}% de la venta · el resto, efectivo` : "sin datos de medio de pago este mes"}
              </p>
            </Card>
            <Card title="Facturado en ARCA"><div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(totalFacturado)}</div></Card>
            <Card title="Electrónico − facturado">
              <div className={`text-[24px] font-bold tabular-nums ${hayElec && Math.abs(difElec) > totalElec * 0.05 ? "text-warn" : "text-ok"}`}>
                {hayElec ? fmtPesosCorto(difElec) : "—"}
              </div>
              <p className="text-[11px] text-ink-3 mt-1">
                {hayElec ? `${(difElec / totalElec * 100).toFixed(1)}% · ARCA impacta 24-48 h después` : ""}
              </p>
            </Card>
          </div>

          <Card title="Facturación por local">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px]">
                <thead><tr>
                  <th className={th}>Local</th><th className={`${th} text-right`}>Venta</th>
                  <th className={`${th} text-right`}>Electrónico</th><th className={`${th} text-right`}>Cobrado MP/PN</th>
                  <th className={`${th} text-right`}>Facturado</th>
                  <th className={`${th} text-right`}>Fact./electr.</th>
                  <th className={`${th} text-right`}>% de la venta</th><th className={`${th} text-right`}>mes ant.</th>
                </tr></thead>
                <tbody>
                  {locales.map(l => {
                    const salto = l.ratio != null && l.ratioPrev != null && Math.abs(l.ratio - l.ratioPrev) > 0.1;
                    return (
                      <tr key={l.local} className="border-t border-borde">
                        <td className={`${td} font-semibold text-ink`}>{l.local === "Tiendanube" ? "Online" : l.local}
                          <span className="text-[10px] text-ink-3 ml-1.5">PV {String(l.punto_venta).padStart(4, "0")}</span></td>
                        <td className={`${td} text-right`}>{fmtPesosCorto(l.venta)}</td>
                        <td className={`${td} text-right font-semibold`}>{l.electronico ? fmtPesosCorto(l.electronico) : "—"}</td>
                        <td className={`${td} text-right`}>{l.point ? fmtPesosCorto(l.point) : "—"}</td>
                        <td className={`${td} text-right`}>{fmtPesosCorto(l.facturado)}</td>
                        <td className={`${td} text-right font-bold ${l.ratioElec != null && Math.abs(l.ratioElec - 1) > 0.1 ? "text-warn" : "text-ink"}`}>
                          {l.ratioElec != null ? Math.round(l.ratioElec * 100) + "%" : "—"}
                        </td>
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
              <strong>Electrónico</strong> es lo cobrado con tarjeta o QR según el propio sistema del local
              (ELECTRON en Dragonfish, Chip and Pin en Woo); es lo que corresponde facturar, así que{" "}
              <strong>Fact./electr. debería rondar el 100%</strong> y se marca en amarillo si se aleja más de 10
              puntos. Ojo que ARCA impacta 24-48 h después, así que sobre el cierre del mes siempre se ve corto.
              <strong> Cobrado MP/PN</strong> es lo liquidado por la pasarela de cada canal: en los locales,
              MercadoPago con todos los medios (Point, QR, billeteras — exportá el reporte de Ventas{" "}
              <strong>sin el filtro Point</strong>); en Online, <strong>Pago Nube</strong> más transferencias,
              según el reporte de Tiendanube. Debería calzar con Electrónico. La última columna compara contra
              el propio ratio del mes anterior para detectar cambios de comportamiento.
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
          <FacturasRecibidas mes={mes} />
        </>
      )}

      {tab === "conciliacion" && data && (() => {
        const q = busqueda.trim().toLowerCase();
        const coincide = t => !q || String(t || "").toLowerCase().includes(q);
        const filas = data.conciliacion.filter(r =>
          (!soloFaltan || (!r.cuentaPropia && r.facturado < r.transferido * 0.9)) &&
          (coincide(r.nombre) || r.movimientos.some(m => coincide(m.id))));
        const cats = (data.egresos?.categorias || [])
          .map(c => ({ ...c, hits: c.movimientos.filter(m => coincide(m.descripcion) || coincide(m.contraparte) || coincide(m.id) || coincide(c.categoria)) }))
          .filter(c => !q || c.hits.length);
        const totalEgresos = data.egresos?.total || 0;
        return (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Card title="Gasto real del mes">
              <div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(totalEgresos)}</div>
              <p className="text-[11px] text-ink-3 mt-1">MercadoPago + Galicia, sin contar traspasos internos</p>
            </Card>
            <Card title="Movido a cuenta propia">
              <div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(aCuentaPropia)}</div>
              <p className="text-[11px] text-ink-3 mt-1">de MercadoPago a Galicia · no es gasto</p>
            </Card>
            <Card title="A proveedores desde MP">
              <div className="text-[24px] font-bold text-ink tabular-nums">{fmtPesosCorto(transferido - aCuentaPropia)}</div>
              <p className="text-[11px] text-ink-3 mt-1">{data.conciliacion.length - 1} contrapartes</p>
            </Card>
            <Card title="Sin factura que lo cubra">
              <div className={`text-[24px] font-bold tabular-nums ${sinRespaldo.length ? "text-bad" : "text-ok"}`}>
                {fmtPesosCorto(sinRespaldo.reduce((a, e) => a + (e.transferido - Math.max(e.facturado, 0)), 0))}
              </div>
              <p className="text-[11px] text-ink-3 mt-1">{sinRespaldo.length} proveedores</p>
            </Card>
          </div>

          <Card>
            <div className="flex gap-2 flex-wrap items-center">
              <input value={busqueda} onChange={e => setBusqueda(e.target.value)}
                     placeholder="Buscar proveedor, concepto, categoría o N° de operación…"
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

          {/* ── Control integral: todo lo que salió, de las dos cuentas ── */}
          <Card title="En qué se fue la plata · MercadoPago + Galicia"
                right={<span className="text-[11px] text-ink-3">tocá una categoría para ver los movimientos</span>}>
            {!cats.length ? (
              <p className="text-[13px] text-ink-2">
                {q ? "Ningún egreso coincide con esa búsqueda." : "Subí el estado de cuenta de MercadoPago y el extracto de Galicia en la pestaña Carga."}
              </p>
            ) : (
              <div className="space-y-1">
                {cats.map(c => {
                  const propio = c.categoria === "Transferencias cuenta propia";
                  const abierto = catAbierta === c.categoria;
                  const lista = q ? c.hits : c.movimientos;
                  return (
                    <div key={c.categoria} className="border-b border-borde last:border-0 pb-2">
                      <button onClick={() => setCatAbierta(abierto ? null : c.categoria)}
                              className="w-full text-left py-1.5 group">
                        <div className="flex justify-between items-baseline gap-3 mb-1">
                          <span className="text-[13px] font-semibold text-ink">
                            <span className="text-ink-3 mr-1.5 text-[11px]">{abierto ? "▾" : "▸"}</span>
                            {c.categoria}
                            <span className="text-[11px] text-ink-3 font-normal ml-1.5">({c.movimientos.length})</span>
                          </span>
                          <span className="tabular-nums text-[13px] font-bold text-ink shrink-0">
                            {fmtPesos(c.total)}
                            {!propio && totalEgresos > 0 && (
                              <span className="text-[11px] text-ink-3 font-normal ml-1.5">
                                {Math.round(c.total / totalEgresos * 100)}%
                              </span>
                            )}
                          </span>
                        </div>
                        {propio ? (
                          <p className="text-[11px] text-ink-3">traspaso interno · no cuenta como gasto</p>
                        ) : (
                          <div className="h-2 rounded-full bg-surface overflow-hidden">
                            <div className="h-full rounded-full bg-negro"
                                 style={{ width: `${totalEgresos ? Math.max(2, c.total / totalEgresos * 100) : 0}%` }} />
                          </div>
                        )}
                      </button>
                      {abierto && (
                        <div className="mt-1.5 rounded-md bg-surface p-3">
                          {lista.map(m => (
                            <div key={`${m.origen}-${m.id}`}
                                 className="flex justify-between items-baseline gap-2 text-[12px] py-1.5 border-b border-borde last:border-0">
                              <span className="text-ink-2 shrink-0 w-11">{m.fecha.slice(8, 10)}/{m.fecha.slice(5, 7)}</span>
                              <span className={`text-[9px] font-semibold uppercase tracking-wide shrink-0 px-1.5 py-0.5 rounded ${m.origen === "Galicia" ? "bg-negro text-white" : "bg-borde text-ink-2"}`}>
                                {m.origen === "Galicia" ? "GAL" : "MP"}
                              </span>
                              <span className="text-ink-3 truncate flex-1">
                                {m.descripcion}{m.contraparte && !String(m.descripcion || "").includes(m.contraparte) ? ` · ${m.contraparte}` : ""}
                              </span>
                              <span className="tabular-nums font-semibold text-ink shrink-0">{fmtPesos(m.monto)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {data.banco?.total?.ingresos > 0 && (
              <p className="text-[11px] text-ink-3 mt-3">
                A Galicia entraron <strong>{fmtPesosCorto(data.banco.total.ingresos)}</strong> (de los cuales{" "}
                {fmtPesosCorto(data.banco.total.desdeMP)} vinieron de MercadoPago) y salieron{" "}
                <strong>{fmtPesosCorto(data.banco.total.egresos)}</strong>.
              </p>
            )}
          </Card>

          {/* ── Conciliación de transferencias contra facturas ── */}
          <Card title="Transferencias vs. facturas, por proveedor"
                right={<span className="text-[11px] text-ink-3">tocá un proveedor para ver el detalle</span>}>
            {!data.conciliacion.length ? (
              <p className="text-[13px] text-ink-2">
                Subí el <strong>estado de cuenta</strong> de MercadoPago (Dinero → Movimientos → Exportar) en la
                pestaña Carga: acá se compara cuánto le transferiste a cada proveedor contra cuánto te facturó.
              </p>
            ) : (
              <>
                <div className="hidden md:flex gap-3 px-2 pb-1.5 text-[10px] uppercase tracking-[0.06em] text-ink-3 font-semibold">
                  <span className="flex-1">Proveedor</span>
                  <span className="w-28 text-right">Transferido</span>
                  <span className="w-28 text-right">Facturado</span>
                  <span className="w-36">Estado</span>
                </div>
                {filas.map(r => {
                  const ok = r.facturado >= r.transferido * 0.9;
                  const abierto = detalle === r.nombre;
                  return (
                    <div key={r.nombre} className="border-t border-borde">
                      <button onClick={() => setDetalle(abierto ? null : r.nombre)}
                              className={`w-full text-left px-2 py-2.5 md:flex md:items-baseline md:gap-3 hover:bg-surface ${abierto ? "bg-surface" : ""}`}>
                        <span className="flex-1 text-[13px] font-semibold text-ink block">
                          <span className="text-ink-3 mr-1.5 text-[11px]">{abierto ? "▾" : "▸"}</span>
                          {r.nombre}
                          <span className="text-[11px] text-ink-3 font-normal ml-1.5">({r.transferencias})</span>
                          {r.rubro && !r.cuentaPropia && (
                            <span className="text-[10px] text-ink-3 font-normal ml-1.5 border border-borde rounded px-1 py-px align-middle">{r.rubro}</span>
                          )}
                        </span>
                        <span className="w-28 text-right text-[13px] tabular-nums text-ink hidden md:inline-block">{fmtPesos(r.transferido)}</span>
                        <span className="w-28 text-right text-[13px] tabular-nums text-ink-2 hidden md:inline-block">{r.cuentaPropia ? "—" : fmtPesos(r.facturado)}</span>
                        <span className="w-36 text-[12px] hidden md:inline-block">
                          {r.cuentaPropia
                            ? <span className="text-ink-3 font-semibold">cuenta propia</span>
                            : ok
                              ? <span className="text-ok font-semibold">✓ cubierto{r.porMonto ? " (por monto)" : ""}</span>
                              : <span className="text-bad font-semibold">faltan {fmtPesosCorto(r.transferido - Math.max(r.facturado, 0))}</span>}
                        </span>
                        {/* En celular la fila se lee apilada */}
                        <span className="md:hidden flex justify-between items-baseline gap-2 mt-1 text-[12px]">
                          <span className="text-ink-2 tabular-nums">
                            {fmtPesos(r.transferido)}
                            {!r.cuentaPropia && <span className="text-ink-3"> · fact. {fmtPesosCorto(r.facturado)}</span>}
                          </span>
                          {r.cuentaPropia
                            ? <span className="text-ink-3 font-semibold">cuenta propia</span>
                            : ok
                              ? <span className="text-ok font-semibold">✓ cubierto</span>
                              : <span className="text-bad font-semibold">faltan {fmtPesosCorto(r.transferido - Math.max(r.facturado, 0))}</span>}
                        </span>
                      </button>
                      {abierto && (
                        <div className="px-2 pb-3">
                          <div className="rounded-md bg-surface p-3 grid gap-4 md:grid-cols-2">
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
                                <p className={`text-[12px] font-medium ${r.cuentaPropia ? "text-ink-2" : "text-bad"}`}>
                                  {r.cuentaPropia
                                    ? "Es plata que pasa a la cuenta de Galicia, no un gasto: no lleva factura. En qué se usó lo ves arriba, en el desglose por categoría."
                                    : "Ninguna. Reclamale el comprobante al proveedor, o revisá si facturó en otro mes (subí ese período en Carga)."}
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
                      )}
                    </div>
                  );
                })}
                {!filas.length && <p className="text-[12px] text-ink-3 py-3 text-center">Sin resultados para esa búsqueda</p>}
                <p className="text-[11px] text-ink-3 mt-3">
                  Se compara por total (los pagos suelen ser parciales), con facturas de hasta 20 días antes o después
                  del mes. El <strong>N° de operación</strong> de cada transferencia es el mismo que aparece en
                  MercadoPago → Actividad.
                </p>
              </>
            )}
          </Card>
        </>
        );
      })()}

      {tab === "flujo" && <Flujo mes={mes} />}

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
          <Uploader titulo="Galicia · Extracto de la cuenta corriente" estado={estados.banco || { estado: "idle" }}
            descripcion="Galicia Office → Consultas → Movimientos → Descargar CSV. Es lo que cierra el circuito: muestra en qué se gastó la plata que se transfiere de MercadoPago a la cuenta propia (sueldos, AFIP, echeqs, proveedores)."
            onFile={subir("banco", null, "cargarBanco")} />
        </>
      )}
    </div>
  );
}
