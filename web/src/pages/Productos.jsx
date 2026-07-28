import { useCallback, useEffect, useState } from "react";
import { getTopProductos, getCategorias, getVariantes, rangoDe, fmtPesosCorto, LOCALES } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, BarraH, SelectorFechas, Paginacion } from "../components/ui.jsx";

const POR_PAGINA = 10;

export default function Productos() {
  const [localKey, setLocalKey] = useState("");
  const [orden, setOrden] = useState("cantidad");
  const [rango, setRango] = useState({ key: "mes", ...rangoDe("mes") });
  const [pagina, setPagina] = useState(1);
  const [top, setTop] = useState(null);
  const [cats, setCats] = useState(null);
  const [vars, setVars] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);

  const cargar = useCallback(() => {
    const { desde, hasta } = rango;
    const dbLocal = localKey ? LOCALES.find(l => l.key === localKey)?.db : null;
    setCargando(true);
    setError(null);
    Promise.allSettled([
      getTopProductos(desde, hasta, { local: dbLocal, orden, limite: 50 }).then(d => setTop(d.productos)),
      getCategorias(desde, hasta, dbLocal).then(d => setCats(d.categorias)),
      getVariantes(desde, hasta, dbLocal).then(d => setVars(d)),
    ]).then(rs => {
      if (rs.every(r => r.status === "rejected")) setError("No pude leer la base");
      setCargando(false);
    });
  }, [localKey, orden, rango]);

  useEffect(() => { setTop(null); setCats(null); setVars(null); setPagina(1); cargar(); }, [cargar]);

  const totalPaginas = top ? Math.ceil(top.length / POR_PAGINA) : 0;
  const paginaTop = top ? top.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA) : [];
  const maxTop = top?.length ? top[0][orden] : 1;
  const maxCat = cats?.length ? Math.max(...cats.map(c => c.total)) : 1;
  const maxTalle = vars?.talles?.length ? vars.talles[0].cantidad : 1;
  const maxColor = vars?.colores?.length ? vars.colores[0].cantidad : 1;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Productos</h1>
          <p className="text-[12px] text-ink-3">Modelos agrupados (sin distinguir variantes)</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <SelectorFechas rango={rango} onChange={setRango} />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips
          opciones={[{ value: "", label: "Todos" }, ...LOCALES.map(l => ({ value: l.key, label: l.nombre, color: l.color }))]}
          valor={localKey}
          onChange={setLocalKey}
        />
        <Chips
          opciones={[{ value: "cantidad", label: "Por unidades" }, { value: "total", label: "Por facturación" }]}
          valor={orden}
          onChange={setOrden}
        />
      </div>

      {error && <Card><p className="text-[13px] text-bad py-6 text-center">{error}</p></Card>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card title={`Ranking de modelos · ${orden === "cantidad" ? "unidades" : "facturación"}`}>
          {!top ? <Spinner /> : !top.length ? <p className="text-[13px] text-ink-3 py-6 text-center">Sin datos</p> : (
            <>
              <ol className="divide-y divide-borde">
                {paginaTop.map((p, i) => (
                  <li key={p.producto} className="flex items-center gap-3 py-2">
                    <span className="w-6 text-right text-[12px] font-bold text-ink-3 tabular-nums">
                      {(pagina - 1) * POR_PAGINA + i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{p.producto}</div>
                      <div className="mt-1 h-[5px] rounded-[3px] bg-surface overflow-hidden">
                        <div className="h-full rounded-[3px] bg-negro" style={{ width: `${(p[orden] / maxTop) * 100}%` }} />
                      </div>
                    </div>
                    <div className="text-right shrink-0 w-20">
                      <div className="text-[13px] font-bold text-ink tabular-nums">
                        {orden === "cantidad" ? `${p.cantidad} u.` : fmtPesosCorto(p.total)}
                      </div>
                      <div className="text-[11px] text-ink-3 tabular-nums">
                        {orden === "cantidad" ? fmtPesosCorto(p.total) : `${p.cantidad} u.`}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              <Paginacion pagina={pagina} totalPaginas={totalPaginas} onChange={setPagina} />
            </>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Venta por categoría">
            {!cats ? <Spinner /> : !cats.length ? <p className="text-[13px] text-ink-3 py-4 text-center">Sin datos</p> : (
              <div>
                {cats.slice(0, 8).map(c => (
                  <BarraH key={c.categoria} etiqueta={c.categoria} valor={c.total} max={maxCat}
                          texto={`${fmtPesosCorto(c.total)} · ${c.cantidad} u.`} />
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card title="Talles más vendidos">
              {!vars ? <Spinner /> : !vars.talles?.length ? <p className="text-[13px] text-ink-3 py-4 text-center">Sin datos</p> : (
                <div>
                  {vars.talles.slice(0, 6).map(t => (
                    <BarraH key={t.valor} etiqueta={t.valor} valor={t.cantidad} max={maxTalle} texto={`${t.cantidad} u.`} />
                  ))}
                </div>
              )}
            </Card>
            <Card title="Colores más vendidos">
              {!vars ? <Spinner /> : !vars.colores?.length ? <p className="text-[13px] text-ink-3 py-4 text-center">Sin datos</p> : (
                <div>
                  {vars.colores.slice(0, 6).map(c => (
                    <BarraH key={c.valor} etiqueta={c.valor} valor={c.cantidad} max={maxColor} texto={`${c.cantidad} u.`} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
