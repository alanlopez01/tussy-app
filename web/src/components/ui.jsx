// Piezas compartidas del dashboard — estilo sobrio
import { Delta } from "./graficos.jsx";

export function Card({ title, sub, children, right, className = "" }) {
  return (
    <section className={`elevado rounded-lg px-5 pt-[18px] pb-5 ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          {title && (
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-ink leading-tight tracking-[-0.01em]">{title}</h2>
              {sub && <p className="text-[12px] text-ink-3 mt-0.5">{sub}</p>}
            </div>
          )}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, sub, delta }) {
  return (
    <div className="elevado rounded-lg px-5 py-4">
      <div className="text-[12px] font-medium text-ink-3">{label}</div>
      <div className="text-[26px] leading-[1.15] text-ink mt-1 cifra-xl">{value}</div>
      {(sub || (delta != null && !isNaN(delta))) && (
        <div className="flex items-center gap-2 mt-1.5 text-[12px] flex-wrap">
          <Delta pct={delta} />
          {sub && <span className="text-ink-3">{sub}</span>}
        </div>
      )}
    </div>
  );
}

export function BotonActualizar({ onClick, cargando }) {
  return (
    <button
      onClick={onClick}
      disabled={cargando}
      className="inline-flex items-center gap-2 rounded-md aro bg-surface-1 px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 hover:text-ink hover:bg-surface disabled:opacity-50 transition-colors"
    >
      <span className={cargando ? "animate-spin inline-block" : ""}>⟳</span>
      {cargando ? "Actualizando…" : "Actualizar"}
    </button>
  );
}

// El chip de filtro: activo = fondo del acento en suave y texto del acento.
// Nunca negro sólido, que compite con los números.
export function Chips({ opciones, valor, onChange }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {opciones.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors inline-flex items-center gap-1.5 ${
            valor === o.value
              ? "bg-acento-suave text-acento-texto"
              : "aro bg-surface-1 text-ink-2 hover:text-ink hover:bg-surface"
          }`}
        >
          {o.color && <span className="w-2 h-2 rounded-[3px]" style={{ background: o.color }} />}
          {o.label}
          {o.cuenta != null && (
            <span className={`text-[11px] tabular-nums ${valor === o.value ? "opacity-70" : "text-ink-3"}`}>{o.cuenta}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ texto = "Cargando…" }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-ink-3">
      <div className="w-6 h-6 rounded-full border-2 border-borde border-t-acento animate-spin" />
      <div className="text-[12.5px]">{texto}</div>
    </div>
  );
}

// La leyenda también es el filtro. Siete locales apilados en una barra de 24px
// son un arcoíris; apagar los que no te interesan es la única forma honesta de
// leerlos. Apagar uno NO repinta a los demás: el color sigue al local, no al
// puesto que ocupa en la pila.
export function LeyendaLocal({ locales, totales, fmt, ocultos, onToggle }) {
  const Tag = onToggle ? "button" : "span";
  return (
    <div className="flex flex-wrap gap-1.5">
      {locales.map(l => {
        const off = ocultos?.has(l.key);
        return (
          <Tag key={l.key}
               {...(onToggle ? { onClick: () => onToggle(l.key), "aria-pressed": !off, type: "button" } : {})}
               title={onToggle ? (off ? `Mostrar ${l.nombre}` : `Ocultar ${l.nombre}`) : undefined}
               className={`inline-flex items-center gap-1.5 rounded-md aro px-2 py-1 text-[11.5px] font-semibold transition-colors
                           ${off ? "bg-transparent text-ink-3" : "bg-surface text-ink-2"}
                           ${onToggle ? "hover:bg-surface cursor-pointer" : ""}`}>
            <i className="w-2 h-2 rounded-[3px] shrink-0 not-italic transition-opacity"
               style={{ background: l.color, opacity: off ? 0.25 : 1 }} />
            {l.nombre}
            {totales && fmt && !off && <b className="text-ink cifra font-bold">{fmt(totales[l.key] || 0)}</b>}
          </Tag>
        );
      })}
    </div>
  );
}

export function BarraH({ etiqueta, valor, max, texto, color = "var(--color-dato)" }) {
  const f = max > 0 ? Math.max(valor / max, 0) : 0;
  return (
    <div className="grid items-center gap-3 py-2 border-b border-borde last:border-0"
         style={{ gridTemplateColumns: "minmax(0,1fr) minmax(40px,110px) auto" }}>
      <span className="text-[13px] font-semibold text-ink truncate">{etiqueta}</span>
      <div className="relative h-2 rounded-sm overflow-hidden" style={{ background: "var(--color-pista-2)" }}>
        <div className="absolute inset-0 rounded-[inherit] origin-left"
             style={{ background: color, transform: `scaleX(${f})`, transition: "transform .45s var(--ease-suave)" }} />
      </div>
      <span className="text-right text-[13px] font-bold text-ink cifra whitespace-nowrap">{texto}</span>
    </div>
  );
}

// Filtro de fechas compartido: chips de rangos + rango personalizado.
// `rango` = { key, desde, hasta }; el padre lo guarda en su estado.
import { useState } from "react";
import { rangoDe } from "../lib/api.js";

const RANGOS_DEF = [
  { key: "hoy", label: "Hoy" },
  { key: "ayer", label: "Ayer" },
  { key: "7d", label: "7 días" },
  { key: "mes", label: "Este mes" },
  { key: "mesPasado", label: "Mes pasado" },
];

export function SelectorFechas({ rango, onChange, opciones = RANGOS_DEF }) {
  const [abierto, setAbierto] = useState(false);
  const [desde, setDesde] = useState(rango.desde);
  const [hasta, setHasta] = useState(rango.hasta);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {opciones.map(o => (
        <button key={o.key}
          onClick={() => { setAbierto(false); onChange({ key: o.key, ...rangoDe(o.key) }); }}
          className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${
            rango.key === o.key ? "bg-acento-suave text-acento-texto" : "aro bg-surface-1 text-ink-2 hover:text-ink hover:bg-surface"
          }`}>
          {o.label}
        </button>
      ))}
      <button onClick={() => setAbierto(!abierto)}
        className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${
          rango.key === "custom" ? "bg-acento-suave text-acento-texto" : "aro bg-surface-1 text-ink-2 hover:text-ink hover:bg-surface"
        }`}>
        Personalizado
      </button>
      {abierto && (
        <span className="inline-flex items-center gap-1.5">
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
                 className="rounded-md aro bg-surface-1 px-2 py-1 text-[12px] text-ink-2" />
          <span className="text-[12px] text-ink-3">a</span>
          <input type="date" value={hasta} onChange={e => setHasta(e.target.value)}
                 className="rounded-md aro bg-surface-1 px-2 py-1 text-[12px] text-ink-2" />
          <button onClick={() => { if (desde && hasta && desde <= hasta) { setAbierto(false); onChange({ key: "custom", desde, hasta }); } }}
                  className="px-3 py-1.5 rounded-md text-[12.5px] font-semibold bg-acento text-white">
            Aplicar
          </button>
        </span>
      )}
    </div>
  );
}

export function Paginacion({ pagina, totalPaginas, onChange }) {
  if (totalPaginas <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-3 border-t border-borde mt-2">
      <button onClick={() => onChange(pagina - 1)} disabled={pagina <= 1}
              className="px-3 py-1 rounded-md aro text-[12px] font-semibold text-ink-2 disabled:opacity-40 hover:bg-surface">
        ‹ Anterior
      </button>
      <span className="text-[12px] text-ink-3 tabular-nums">{pagina} / {totalPaginas}</span>
      <button onClick={() => onChange(pagina + 1)} disabled={pagina >= totalPaginas}
              className="px-3 py-1 rounded-md aro text-[12px] font-semibold text-ink-2 disabled:opacity-40 hover:bg-surface">
        Siguiente ›
      </button>
    </div>
  );
}

// Panel "Datos del mes": qué fuentes están completas y hasta qué día llega cada una.
// Responde "¿puedo confiar en los números de este mes?" antes de leerlos.
import { useEffect as _useEffect, useState as _useState } from "react";
import { getJSON as _getJSON, postJSON as _postJSON } from "../lib/api.js";

export function DatosDelMes({ mes }) {
  const [data, setData] = _useState(null);
  const [abierto, setAbierto] = _useState(false);

  const cargar = () => _getJSON(`/api/metricas?action=completitud&mes=${mes}`, 30000)
    .then(setData).catch(() => setData(null));
  _useEffect(() => { setData(null); cargar(); }, [mes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const faltan = data.items.filter(i => i.estado !== "ok");
  const ICONO = { ok: "✓", parcial: "◐", falta: "✗" };
  const COLOR = { ok: "text-ok", parcial: "text-warn", falta: "text-bad" };

  // Cuando una fuente figura incompleta pero el dato es correcto (ej. el banco no
  // tuvo movimientos los últimos días del mes), se puede dar por completa a mano.
  const confirmar = async (clave, valor) => {
    try {
      await _postJSON("/api/metricas?action=confirmarCompletitud", { mes, clave, valor });
      cargar();
    } catch { /* el próximo refresh lo muestra */ }
  };

  return (
    <section className={`rounded-lg p-4 ${faltan.length ? "bg-surface-1 aro-2" : "elevado"}`}>
      <button onClick={() => setAbierto(!abierto)} className="w-full text-left flex items-center justify-between gap-3">
        <span className="text-[12px] font-semibold text-ink">
          {faltan.length === 0
            ? <span className="text-ok">✓ Datos del mes completos ({data.total}/{data.total} fuentes)</span>
            : <span className="text-warn">◐ Datos del mes: {data.completos}/{data.total} fuentes completas — tocá para ver qué falta</span>}
        </span>
        <span className="text-ink-3 text-[11px]">{abierto ? "▾" : "▸"}</span>
      </button>
      {(abierto || faltan.length > 0) && (
        <div className="mt-3 space-y-1.5">
          {(abierto ? data.items : faltan).map(i => (
            <div key={i.clave} className="flex items-baseline gap-2 text-[12px] flex-wrap">
              <span className={`font-bold shrink-0 ${COLOR[i.estado]}`}>{ICONO[i.estado]}</span>
              <span className="font-semibold text-ink-2 shrink-0">{i.label}:</span>
              <span className="text-ink-3">{i.detalle}</span>
              {i.estado !== "ok" && (
                <button onClick={() => confirmar(i.clave, true)}
                        title="Usalo cuando el dato está bien igual (ej. no hubo movimientos esos días)"
                        className="text-[11px] font-semibold text-ink-2 underline decoration-dotted underline-offset-2 shrink-0">
                  dar por completo ✓
                </button>
              )}
              {i.confirmado && (
                <button onClick={() => confirmar(i.clave, false)}
                        className="text-[11px] text-ink-3 underline decoration-dotted underline-offset-2 shrink-0">
                  deshacer
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
