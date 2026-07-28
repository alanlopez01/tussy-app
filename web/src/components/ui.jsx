// Piezas compartidas del dashboard — estilo sobrio
import { fmtPesos } from "../lib/api.js";

export function Card({ title, children, right, className = "" }) {
  return (
    <section className={`bg-surface-1 rounded-lg border border-borde p-5 ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          {title && <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h2>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, sub, delta }) {
  const deltaColor = delta > 0 ? "text-ok" : delta < 0 ? "text-bad" : "text-ink-3";
  const deltaIcon = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
  return (
    <div className="bg-surface-1 rounded-lg border border-borde p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className="text-[26px] leading-tight font-bold text-ink mt-1.5 tabular-nums">{value}</div>
      <div className="flex items-center gap-2 mt-1 text-[12px] min-h-[18px]">
        {delta != null && !isNaN(delta) && (
          <span className={`font-semibold ${deltaColor}`}>{deltaIcon} {Math.abs(Math.round(delta))}%</span>
        )}
        {sub && <span className="text-ink-3">{sub}</span>}
      </div>
    </div>
  );
}

export function BotonActualizar({ onClick, cargando }) {
  return (
    <button
      onClick={onClick}
      disabled={cargando}
      className="inline-flex items-center gap-2 rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:bg-surface disabled:opacity-50 transition-colors"
    >
      <span className={cargando ? "animate-spin inline-block" : ""}>⟳</span>
      {cargando ? "Actualizando…" : "Actualizar"}
    </button>
  );
}

export function Chips({ opciones, valor, onChange }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {opciones.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded-md text-[12px] font-semibold border transition-colors inline-flex items-center gap-1.5 ${
            valor === o.value
              ? "bg-negro text-white border-negro"
              : "bg-surface-1 text-ink-2 border-borde hover:bg-surface"
          }`}
        >
          {o.color && <span className="w-2 h-2 rounded-[2px]" style={{ background: o.color }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ texto = "Cargando…" }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-ink-3">
      <div className="w-6 h-6 rounded-full border-2 border-borde border-t-negro animate-spin" />
      <div className="text-[12px]">{texto}</div>
    </div>
  );
}

export function LeyendaLocal({ locales }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1">
      {locales.map(l => (
        <span key={l.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-2 font-medium">
          <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: l.color }} />
          {l.nombre}
        </span>
      ))}
    </div>
  );
}

export function BarraH({ etiqueta, valor, max, texto, color = "var(--color-negro)" }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-24 shrink-0 text-[12px] font-medium text-ink-2 truncate">{etiqueta}</span>
      <div className="flex-1 h-[8px] rounded-[3px] bg-surface overflow-hidden">
        <div className="h-full rounded-[3px]" style={{ width: `${max > 0 ? (valor / max) * 100 : 0}%`, background: color }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[12px] font-semibold text-ink tabular-nums">{texto}</span>
    </div>
  );
}

// Tooltip compartido para Recharts
export function TooltipPesos({ active, payload, label, labelFormatter }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-negro text-white rounded-md px-3.5 py-2.5 shadow-lg text-[12px] min-w-[170px]">
      <div className="font-semibold mb-1.5">{labelFormatter ? labelFormatter(label) : label}</div>
      {payload.filter(p => p.value > 0).map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4 leading-relaxed">
          <span className="inline-flex items-center gap-1.5 text-white/80">
            <span className="w-2 h-2 rounded-[2px]" style={{ background: p.color || p.fill }} />
            {p.name}
          </span>
          <span className="font-semibold tabular-nums">{fmtPesos(p.value)}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="flex items-center justify-between gap-4 border-t border-white/20 mt-1.5 pt-1.5">
          <span className="text-white/80">Total</span>
          <span className="font-bold tabular-nums">{fmtPesos(payload.reduce((a, p) => a + (p.value || 0), 0))}</span>
        </div>
      )}
    </div>
  );
}
