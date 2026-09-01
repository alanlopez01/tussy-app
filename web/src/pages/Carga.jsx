// Carga mensual de reportes: MercadoPago Point y Tiendanube.
// El navegador lee el .xlsx, extrae solo las columnas necesarias y se las manda
// al server, que las procesa con la misma lógica que los scripts de siempre.
import { useState } from "react";
import { fmtPesosCorto, postJSON } from "../lib/api.js";
import { Card, Spinner } from "../components/ui.jsx";

function postReporte(payload) {
  return postJSON("/api/metricas?action=cargarReporte", payload);
}

function ResultadoCarga({ resultado }) {
  if (!resultado) return null;
  return (
    <div className="mt-3 rounded-md bg-surface px-3.5 py-3 space-y-1">
      <div className="text-[12px] font-semibold text-ok">✓ Cargado</div>
      {resultado.cargado.map(f => (
        <div key={`${f.mes}-${f.local}`} className="text-[12px] text-ink-2 tabular-nums">
          <span className="font-semibold">{f.mes} · {f.local === "Tiendanube" ? "Online" : f.local}</span>:{" "}
          {fmtPesosCorto(f.bruto)} bruto · costo {(f.costo_pct * 100).toFixed(2)}%
          {f.envios != null && ` · envíos ${fmtPesosCorto(f.envios)}`}
          {f.publicidad != null && ` · publicidad ${fmtPesosCorto(f.publicidad)}`}
        </div>
      ))}
      {resultado.locales_desconocidos?.length > 0 && (
        <div className="text-[11px] text-warn">Locales no reconocidos: {resultado.locales_desconocidos.join(", ")}</div>
      )}
    </div>
  );
}

export default function Carga() {
  const [estadoMP, setEstadoMP] = useState({ estado: "idle" });
  const [estadoTN, setEstadoTN] = useState({ estado: "idle" });
  const [publicidad, setPublicidad] = useState("5967265");

  const cargarMP = async (file) => {
    if (!file) return;
    setEstadoMP({ estado: "procesando" });
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      // MP cambia el layout del export cada tanto (sep-2026 pasó de 38 a 24 columnas):
      // ubicamos encabezados y período por nombre, no por posición fija.
      const periodo = String(rows.slice(0, 6).flat().find(c => /desde el \d/i.test(String(c ?? ""))) || rows[1]?.[0] || "");
      const iHdr = rows.findIndex(r => Array.isArray(r) && r.some(c => String(c ?? "").trim() === "Número de operación"));
      if (iHdr < 0) throw new Error("No encontré los encabezados. ¿Es el export de Ventas de MercadoPago?");
      const hdr = rows[iHdr].map(h => String(h ?? "").trim());
      const col = n => hdr.indexOf(n);
      const ix = { estado: col("Estado"), cobro: col("Cobro"), neto: col("Total a recibir"),
                   medio: col("Medio de pago"), local: col("Local"), resumen: col("Resumen") };
      if (ix.local < 0 || ix.estado < 0) throw new Error("El reporte no trae las columnas Estado/Local esperadas");
      const filas = rows.slice(iHdr + 1)
        .filter(r => r && r[ix.estado] != null && String(r[0] ?? "") !== "")
        .map(r => ({
          estado: String(r[ix.estado] ?? ""), cobro: r[ix.cobro] ?? 0, neto: r[ix.neto] ?? 0,
          medio: String(r[ix.medio] ?? ""), local: String(r[ix.local] ?? ""), resumen: String(r[ix.resumen] ?? ""),
        }));
      if (!filas.length) throw new Error("El archivo no tiene operaciones. ¿Es el export de Ventas de MercadoPago?");
      const resultado = await postReporte({ tipo: "mp", periodo, filas });
      setEstadoMP({ estado: "ok", resultado });
    } catch (e) {
      setEstadoMP({ estado: "error", error: e.message });
    }
  };

  const cargarTN = async (file) => {
    if (!file) return;
    setEstadoTN({ estado: "procesando" });
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const ws = wb.Sheets["Listado de órdenes"];
      if (!ws) throw new Error('El archivo no tiene la hoja "Listado de órdenes". ¿Es el reporte de estadísticas de Tiendanube?');
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      const filas = rows.slice(4)
        .filter(r => r && r[0] != null)
        .map(r => ({
          fecha: r[1] instanceof Date ? r[1].toISOString().slice(0, 10) : String(r[1] ?? "").slice(0, 10),
          importe: r[10] ?? 0, plataforma: String(r[11] ?? ""), cuotas: r[14],
          estado: String(r[23] ?? ""), pago_envio: String(r[20] ?? ""), costo_envio: String(r[21] ?? ""),
        }));
      if (!filas.length) throw new Error("No encontré órdenes en el archivo.");
      const resultado = await postReporte({ tipo: "tn", filas, publicidad: parseFloat(publicidad) || null });
      setEstadoTN({ estado: "ok", resultado });
    } catch (e) {
      setEstadoTN({ estado: "error", error: e.message });
    }
  };

  const inputCls = "block w-full text-[12px] text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-negro file:text-white file:px-3.5 file:py-2 file:text-[12px] file:font-semibold file:cursor-pointer";

  return (
    <div className="space-y-4">
      <Card title="MercadoPago Point · locales físicos">
        <p className="text-[12px] text-ink-3 mb-3">
          MercadoPago → Tus negocios → <strong>Ventas</strong> → Exportar (Excel), con el <strong>mes completo</strong> como
          período. Actualiza el costo financiero real y el mix de cuotas de cada local.
        </p>
        <input type="file" accept=".xlsx" className={inputCls}
               onChange={e => { cargarMP(e.target.files?.[0]); e.target.value = ""; }} />
        {estadoMP.estado === "procesando" && <Spinner texto="Procesando reporte…" />}
        {estadoMP.estado === "error" && <p className="text-[12px] text-bad font-medium mt-3">{estadoMP.error}</p>}
        {estadoMP.estado === "ok" && <ResultadoCarga resultado={estadoMP.resultado} />}
      </Card>

      <Card title="Tiendanube · canal online">
        <p className="text-[12px] text-ink-3 mb-3">
          Tiendanube → Estadísticas → <strong>Exportar</strong>, con el mes completo. Trae el mix real de cuotas de
          PagoNube, las transferencias y los envíos que pagó la tienda.
        </p>
        <label className="block mb-3">
          <span className="block text-[10px] uppercase tracking-[0.06em] text-ink-3 mb-1">
            Publicidad del mes ($) — respaldo: si cargaste el estado de cuenta de MP en Contabilidad, la pauta real de Meta se usa sola y este campo se ignora
          </span>
          <input type="number" inputMode="numeric" value={publicidad} onChange={e => setPublicidad(e.target.value)}
                 className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[13px] text-ink w-44 tabular-nums" />
        </label>
        <input type="file" accept=".xlsx" className={inputCls}
               onChange={e => { cargarTN(e.target.files?.[0]); e.target.value = ""; }} />
        {estadoTN.estado === "procesando" && <Spinner texto="Procesando reporte…" />}
        {estadoTN.estado === "error" && <p className="text-[12px] text-bad font-medium mt-3">{estadoTN.error}</p>}
        {estadoTN.estado === "ok" && <ResultadoCarga resultado={estadoTN.resultado} />}
      </Card>

      <Card>
        <p className="text-[12px] text-ink-3">
          <strong>Rutina de cada mes</strong>: al cerrar el mes, exportá los dos reportes con el mes completo y
          subilos acá. Si un mes se carga dos veces, se pisa con la versión nueva (no duplica). Los números
          impactan al instante en <strong>Negocio</strong> y <strong>Evolución</strong>.
        </p>
      </Card>
    </div>
  );
}
