import { useCallback, useEffect, useState } from "react";
import { getDashboardFinanzas, fmtPesos } from "../lib/api.js";
import { Card, Spinner, Chips, BotonActualizar, StatTile, BarraH } from "../components/ui.jsx";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

export default function Finanzas() {
  const hoy = new Date();
  const [marca, setMarca] = useState("tussy");
  const [mes, setMes] = useState(hoy.getMonth() + 1);
  const [anio, setAnio] = useState(hoy.getFullYear());
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);

  const cargar = useCallback(() => {
    setCargando(true);
    setError(null);
    getDashboardFinanzas(mes, anio, marca)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [mes, anio, marca]);

  useEffect(() => { setData(null); cargar(); }, [cargar]);

  const gastos = Object.entries(data?.porCatGasto || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const ingresos = Object.entries(data?.porCatIngreso || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxG = gastos.length ? gastos[0][1] : 1;
  const maxI = ingresos.length ? ingresos[0][1] : 1;

  const anios = [];
  for (let y = hoy.getFullYear(); y >= 2023; y--) anios.push(y);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Finanzas</h1>
          <p className="text-[12px] text-ink-3">Caja en efectivo · datos del Excel de finanzas (Google Sheet)</p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Chips
          opciones={[{ value: "tussy", label: "Tussy" }, { value: "shato", label: "Shato" }]}
          valor={marca}
          onChange={setMarca}
        />
        <div className="flex gap-2">
          <select value={mes} onChange={e => setMes(parseInt(e.target.value))}
                  className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2">
            {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={anio} onChange={e => setAnio(parseInt(e.target.value))}
                  className="rounded-md border border-borde bg-surface-1 px-3 py-1.5 text-[12px] font-semibold text-ink-2">
            {anios.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {error ? (
        <Card><p className="text-[13px] text-bad py-6 text-center">No pude leer el Sheet de finanzas: {error}</p></Card>
      ) : !data ? <Spinner texto="Leyendo el Sheet de finanzas…" /> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Saldo acumulado en caja" value={fmtPesos(data.saldoActual || 0)} />
            <StatTile label={`Ingresos · ${MESES[mes - 1]}`} value={fmtPesos(data.totalIngreso || 0)}
                      delta={data.totalIngresoAnt ? ((data.totalIngreso - data.totalIngresoAnt) / data.totalIngresoAnt) * 100 : null}
                      sub="vs. mes anterior" />
            <StatTile label={`Gastos · ${MESES[mes - 1]}`} value={fmtPesos(data.totalGasto || 0)}
                      delta={data.totalGastoAnt ? ((data.totalGasto - data.totalGastoAnt) / data.totalGastoAnt) * 100 : null}
                      sub="vs. mes anterior" />
            <StatTile label="Resultado neto" value={fmtPesos(data.neto || 0)}
                      delta={data.netoAnt ? ((data.neto - data.netoAnt) / Math.abs(data.netoAnt)) * 100 : null}
                      sub="vs. mes anterior" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <Card title="Gastos por categoría">
              {!gastos.length ? <p className="text-[13px] text-ink-3 py-4 text-center">Sin movimientos</p> : (
                <div>
                  {gastos.map(([cat, monto]) => (
                    <BarraH key={cat} etiqueta={cat} valor={monto} max={maxG} texto={fmtPesos(monto)} color="var(--color-bad)" />
                  ))}
                </div>
              )}
            </Card>
            <Card title="Ingresos por categoría">
              {!ingresos.length ? <p className="text-[13px] text-ink-3 py-4 text-center">Sin movimientos</p> : (
                <div>
                  {ingresos.map(([cat, monto]) => (
                    <BarraH key={cat} etiqueta={cat} valor={monto} max={maxI} texto={fmtPesos(monto)} color="var(--color-ok)" />
                  ))}
                </div>
              )}
            </Card>
          </div>

          {data.txHoy?.length > 0 && (
            <Card title="Movimientos de hoy">
              <ul className="divide-y divide-borde">
                {data.txHoy.map((tx, i) => (
                  <li key={i} className="py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{tx.desc}</div>
                      <div className="text-[11px] text-ink-3">{tx.cat}</div>
                    </div>
                    <div className={`text-[13px] font-bold tabular-nums ${tx.monto < 0 ? "text-bad" : "text-ok"}`}>
                      {fmtPesos(Math.abs(tx.monto))}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
