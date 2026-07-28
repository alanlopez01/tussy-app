import { useEffect, useState } from "react";
import { getTopProductos, primerDiaMes, hoyISO, fmtPesos, LOCALES } from "../lib/api.js";
import { Card, Spinner } from "../components/ui.jsx";

export default function Productos() {
  const [data, setData] = useState(null);
  const [local, setLocal] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    const nombreLocal = local ? LOCALES.find(l => l.key === local)?.nombre === "Online" ? "Tiendanube" : LOCALES.find(l => l.key === local)?.nombre : null;
    getTopProductos(primerDiaMes(), hoyISO(), nombreLocal)
      .then(d => setData(d.productos))
      .catch(e => setError(e.message));
  }, [local]);

  const max = data?.length ? data[0].cantidad : 1;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-black text-ink">Productos</h1>
        <p className="text-[13px] text-ink-3">Más vendidos este mes</p>
      </header>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setLocal("")}
          className={`px-3.5 py-1.5 rounded-full text-[12px] font-bold border-2 transition-colors ${!local ? "bg-negro text-white border-negro" : "bg-surface-1 text-ink-3 border-borde"}`}>
          Todos
        </button>
        {LOCALES.map(l => (
          <button key={l.key} onClick={() => setLocal(l.key)}
            className={`px-3.5 py-1.5 rounded-full text-[12px] font-bold border-2 transition-colors ${local === l.key ? "bg-negro text-white border-negro" : "bg-surface-1 text-ink-3 border-borde"}`}>
            {l.nombre}
          </button>
        ))}
      </div>

      <Card>
        {error ? <p className="text-[13px] text-bad py-6 text-center">{error}</p>
          : !data ? <Spinner />
          : !data.length ? <p className="text-[13px] text-ink-3 py-6 text-center">Sin datos para este filtro</p>
          : (
          <ol className="divide-y divide-borde">
            {data.map((p, i) => (
              <li key={p.producto} className="flex items-center gap-4 py-3">
                <span className="w-7 text-right text-[13px] font-black text-ink-3 tabular-nums">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold text-ink truncate">{p.producto}</div>
                  <div className="mt-1.5 h-[6px] rounded-full bg-surface overflow-hidden">
                    <div className="h-full rounded-full bg-negro" style={{ width: `${(p.cantidad / max) * 100}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[15px] font-black text-ink tabular-nums">{p.cantidad} u.</div>
                  <div className="text-[11px] text-ink-3 tabular-nums">{fmtPesos(p.total)}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
