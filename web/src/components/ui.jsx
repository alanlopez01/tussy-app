// Piezas compartidas del dashboard
import { fmtPesos } from "../lib/api.js";

export function Card({ title, children, right, className = "" }) {
  return (
    <section className={`bg-surface-1 rounded-2xl border border-borde shadow-[0_1px_4px_rgba(0,0,0,0.04)] p-5 ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between mb-4">
          {title && <h2 className="text-[13px] font-bold uppercase tracking-wide text-ink-2">{title}</h2>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, sub, delta }) {
  const deltaColor = delta > 0 ? "text-ok" : delta < 0 ? "text-bad" : "text-ink-3";
  const deltaIcon = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  return (
    <div className="bg-surface-1 rounded-2xl border border-borde shadow-[0_1px_4px_rgba(0,0,0,0.04)] p-5">
      <div className="text-[12px] font-bold uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-[28px] leading-tight font-black text-ink mt-1 tabular-nums">{value}</div>
      <div className="flex items-center gap-2 mt-1 text-[12px]">
        {delta != null && !isNaN(delta) && (
          <span className={`font-bold ${deltaColor}`}>{deltaIcon} {Math.abs(Math.round(delta))}%</span>
        )}
        {sub && <span className="text-ink-3">{sub}</span>}
      </div>
    </div>
  );
}

export function Spinner({ texto = "Cargando..." }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-ink-3">
      <div className="w-7 h-7 rounded-full border-[3px] border-borde border-t-negro animate-spin" />
      <div className="text-[13px]">{texto}</div>
    </div>
  );
}

export function LeyendaLocal({ locales }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {locales.map(l => (
        <span key={l.key} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2 font-medium">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: l.color }} />
          {l.nombre}
        </span>
      ))}
    </div>
  );
}

// Tooltip compartido para Recharts
export function TooltipPesos({ active, payload, label, labelFormatter }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-negro text-white rounded-xl px-3.5 py-2.5 shadow-lg text-[12px]">
      <div className="font-bold mb-1">{labelFormatter ? labelFormatter(label) : label}</div>
      {payload.filter(p => p.value > 0).map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-[2px]" style={{ background: p.color || p.fill }} />
            {p.name}
          </span>
          <span className="font-bold tabular-nums">{fmtPesos(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
