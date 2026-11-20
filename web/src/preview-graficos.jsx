// Banco de pruebas de los gráficos. No entra al build de la app: es una entrada
// de Vite aparte, para mirar las piezas con datos realistas sin pedir sesión.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import "./index.css";
import { LOCALES, fmtPesos, fmtPesosCorto } from "./lib/api.js";
import { Card, StatTile, LeyendaLocal, BarraH, Chips } from "./components/ui.jsx";
import { BarrasApiladas, FilaRanking, Medidor, Delta } from "./components/graficos.jsx";


const HOY = 19, DIAS = 30;
const BASE = { palermo: 2.9e6, laplata: 1.7e6, online: 1.2e6, meli: 0.9e6, dot: 2.1e6, abasto: 1.6e6, cordoba: 1.1e6 };

const datos = Array.from({ length: DIAS }, (_, i) => {
  const d = i + 1, futuro = d > HOY;
  const finde = (d % 7 === 6 || d % 7 === 0) ? 1.45 : 1;
  const valores = {};
  for (const l of LOCALES) {
    valores[l.key] = futuro ? 0
      : Math.round(BASE[l.key] * finde * (0.55 + ((d * 37 + l.key.length * 13) % 100) / 110));
  }
  if (d === HOY) for (const l of LOCALES) valores[l.key] = Math.round(valores[l.key] * 0.4);
  return { id: d, etiqueta: `${d}/11`, sub: `${d} de noviembre`, valores, futuro, hoy: d === HOY };
});
const totalesMes = {};
for (const l of LOCALES) totalesMes[l.key] = datos.reduce((a, x) => a + x.valores[l.key], 0);
const hoyPartes = LOCALES.map(l => ({ nombre: l.nombre, valor: datos[HOY - 1].valores[l.key], color: l.color }));
const top = [
  ["Buzo Oversize Negro", "Buzos · 3 colores", 184], ["Remera Box Beige", "Remeras · 5 colores", 151],
  ["Campera Puffer", "Camperas · 2 colores", 96], ["Jogger Cargo", "Pantalones · 4 colores", 74],
  ["Gorra Trucker", "Accesorios · 6 colores", 41],
];

function App() {
  const [tema, setTema] = useState("light");
  const [ocultos, setOcultos] = useState(() => new Set());
  const alternar = k => setOcultos(p => { const s = new Set(p); s.has(k) ? s.delete(k) : s.add(k); return s; });
  const SERIES = LOCALES.filter(l => !ocultos.has(l.key)).map(l => ({ key: l.key, nombre: l.nombre, color: l.color }));
  document.documentElement.setAttribute("data-theme", tema);
  return (
    <div className="min-h-screen bg-surface p-4 md:p-8">
      <div className="max-w-[1100px] mx-auto space-y-4">
        <header className="flex items-end justify-between gap-3 flex-wrap">
          <h1 className="text-[30px] md:text-[34px] font-semibold text-ink tracking-[-0.03em] leading-[1.08]">Gráficos</h1>
          <Chips opciones={[{ value: "light", label: "Claro" }, { value: "dark", label: "Oscuro" }]}
                 valor={tema} onChange={setTema} />
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatTile label="Ventas de hoy" value={fmtPesos(hoyPartes.reduce((a, p) => a + p.valor, 0))}
                    delta={-18} sub="ayer: $14,2M" />
          <StatTile label="Operaciones de hoy" value="213" sub="ticket promedio $41.500" />
          <StatTile label="Facturación del mes" value={fmtPesosCorto(Object.values(totalesMes).reduce((a, b) => a + b, 0))}
                    delta={12} sub="mes pasado mismas fechas: $198M" />
        </div>

        <Card title="Facturación diaria · noviembre"
              sub="el mes entero: lo que falta va rayado, no en cero"
              right={<LeyendaLocal locales={LOCALES} totales={totalesMes} fmt={fmtPesosCorto} ocultos={ocultos} onToggle={alternar} />}>
          <div className="overflow-x-auto -mx-1 px-1">
            <div style={{ minWidth: DIAS * 24 + 52 + "px" }}>
              <BarrasApiladas datos={datos} series={SERIES} fmt={fmtPesos} fmtCorto={fmtPesosCorto} alto={290} />
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="Ventas de hoy por local" sub="ordenado por lo que lleva vendido cada uno">
            {(() => { const t = hoyPartes.reduce((a, p) => a + p.valor, 0);
              const r = [...hoyPartes].sort((a, b) => b.valor - a.valor);
              return r.map((p, i) => (
                <FilaRanking key={p.nombre} puesto={i + 1} nombre={p.nombre}
                             sub={`${Math.round(p.valor / t * 100)}% del día`}
                             valor={p.valor} max={r[0].valor} texto={fmtPesos(p.valor)} color={p.color} />
              )); })()}
          </Card>
          <Card title="Lo que más salió" sub="unidades, últimos 30 días">
            {top.map(([n, s, v], i) => (
              <FilaRanking key={n} puesto={i + 1} nombre={n} sub={s} valor={v} max={top[0][2]} texto={`${v} u.`} />
            ))}
          </Card>
          <Card title="Cómo viene el mes" sub="proyección contra la meta">
            <table className="w-full text-[12px]">
              <tbody className="divide-y divide-borde">
                {[["Palermo", 112], ["La Plata", 96], ["Dot", 83], ["Abasto", 101], ["Córdoba", 64]].map(([l, p]) => (
                  <tr key={l}>
                    <td className="py-1.5 font-semibold text-ink">{l}</td>
                    <td className="py-1.5 pl-3">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-16 shrink-0"><Medidor valor={p} meta={100} alto={6} /></div>
                        <span className={`w-10 text-right tabular-nums font-bold ${p >= 100 ? "text-ok" : p >= 90 ? "text-warn" : "text-bad"}`}>{p}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Gasto por categoría" sub="la BarraH de siempre, re-vestida">
            {[["Alquileres", 18.4e6], ["Sueldos", 31.2e6], ["Telas", 12.9e6], ["Logística", 4.1e6]].map(([c, v]) => (
              <BarraH key={c} etiqueta={c} valor={v} max={31.2e6} texto={fmtPesos(v)} color="var(--color-bad)" />
            ))}
            <div className="flex gap-2 mt-3">
              <Delta pct={12} /><Delta pct={-7} /><Delta pct={0} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
