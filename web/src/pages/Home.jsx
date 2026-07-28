import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { getSerie, getHoyVivo, hoyISO, diasAtras, primerDiaMes, mesAnteriorRango, LOCALES, fmtPesos, fmtPesosCorto } from "../lib/api.js";
import { Card, StatTile, Spinner, LeyendaLocal, TooltipPesos, BotonActualizar } from "../components/ui.jsx";

function fechaCorta(iso) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${parseInt(m)}`;
}

const RANGOS_GRAFICO = [
  { key: 7, label: "7 días" },
  { key: 30, label: "30 días" },
  { key: 90, label: "90 días" },
];

export default function Home() {
  const [serie, setSerie] = useState(null);
  const [hoyVivo, setHoyVivo] = useState(null);
  const [errorSerie, setErrorSerie] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [diasGrafico, setDiasGrafico] = useState(30);

  const cargar = useCallback(() => {
    setCargando(true);
    setErrorSerie(null);
    // Serie amplia: cubre 90 días de gráfico y el mes anterior completo para comparativas
    const desde = [diasAtras(89), mesAnteriorRango().desde].sort()[0];
    const p1 = getSerie(desde, diasAtras(1))
      .then(d => setSerie(d.dias.sort((a, b) => a.fecha.localeCompare(b.fecha))))
      .catch(e => setErrorSerie(e.message));
    const p2 = getHoyVivo().then(setHoyVivo).catch(() => setHoyVivo({ woo: null, df: null }));
    Promise.allSettled([p1, p2]).then(() => setCargando(false));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const hoy = useMemo(() => {
    if (!hoyVivo) return null;
    const { woo, df } = hoyVivo;
    const stores = [
      { key: "palermo", nombre: "Palermo",  src: woo?.palermo },
      { key: "laplata", nombre: "La Plata", src: woo?.laplata },
      { key: "online",  nombre: "Online",   src: woo?.tiendanube },
      { key: "dot",     nombre: "Dot",      src: df?.dot },
      { key: "abasto",  nombre: "Abasto",   src: df?.abasto },
      { key: "cordoba", nombre: "Córdoba",  src: df?.cordoba },
    ].map(s => ({
      ...s,
      total: s.src?.ok === false ? null : (s.src?.total ?? null),
      cantidad: s.src?.cantidad ?? 0,
      cargando: s.src == null,
    }));
    const total = stores.reduce((a, s) => a + (s.total || 0), 0);
    const ops = stores.reduce((a, s) => a + (s.total != null ? s.cantidad : 0), 0);
    return { stores, total, ops, ticket: ops > 0 ? total / ops : 0 };
  }, [hoyVivo]);

  // Comparativa HOY vs AYER
  const totalAyer = useMemo(() => {
    if (!serie) return null;
    const ayer = serie.find(d => d.fecha === diasAtras(1));
    return ayer ? ayer.total : null;
  }, [serie]);

  // Comparativa MES ACTUAL (1 → hoy) vs MES ANTERIOR (mismas fechas)
  const mes = useMemo(() => {
    if (!serie) return null;
    const serieMesActual = serie.filter(d => d.fecha >= primerDiaMes());
    const actual = serieMesActual.reduce((a, d) => a + d.total, 0) + (hoy?.total || 0);
    const pm = mesAnteriorRango();
    const anterior = serie
      .filter(d => d.fecha >= pm.desde && d.fecha <= pm.hastaMismasFechas)
      .reduce((a, d) => a + d.total, 0);
    return { actual, anterior };
  }, [serie, hoy]);

  const serieGrafico = useMemo(
    () => (serie || []).filter(d => d.fecha >= diasAtras(diasGrafico)),
    [serie, diasGrafico]
  );

  const barrasHoy = hoy?.stores
    .filter(s => !s.cargando)
    .map(s => ({ nombre: s.nombre, total: s.total || 0, color: LOCALES.find(l => l.key === s.key)?.color })) || [];

  const localesCaidos = hoy?.stores.filter(s => s.total === null && !s.cargando) || [];

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Resumen</h1>
          <p className="text-[12px] text-ink-3 capitalize">
            {new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
        <BotonActualizar onClick={cargar} cargando={cargando} />
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile
          label="Ventas de hoy"
          value={hoy ? fmtPesos(hoy.total) : "…"}
          delta={hoy && totalAyer ? ((hoy.total - totalAyer) / totalAyer) * 100 : null}
          sub={totalAyer ? `ayer: ${fmtPesosCorto(totalAyer)}` : ""}
        />
        <StatTile
          label="Operaciones de hoy"
          value={hoy ? hoy.ops : "…"}
          sub={hoy && hoy.ops > 0 ? `ticket promedio ${fmtPesos(hoy.ticket)}` : ""}
        />
        <StatTile
          label="Facturación del mes"
          value={mes ? fmtPesosCorto(mes.actual) : "…"}
          delta={mes && mes.anterior ? ((mes.actual - mes.anterior) / mes.anterior) * 100 : null}
          sub={mes && mes.anterior ? `mes pasado mismas fechas: ${fmtPesosCorto(mes.anterior)}` : ""}
        />
      </div>

      <Card title="Ventas de hoy por local">
        {!hoy ? <Spinner /> : (
          <>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barrasHoy} margin={{ top: 20, right: 8, left: 8, bottom: 0 }} barCategoryGap="35%">
                  <CartesianGrid vertical={false} stroke="var(--color-borde)" />
                  <XAxis dataKey="nombre" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} />
                  <YAxis hide />
                  <Tooltip content={<TooltipPesos />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="total" name="Ventas" radius={[3, 3, 0, 0]}
                       label={{ position: "top", fontSize: 11, fill: "var(--color-ink-2)", formatter: v => v > 0 ? fmtPesosCorto(v) : "" }}>
                    {barrasHoy.map(b => <Cell key={b.nombre} fill={b.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {localesCaidos.length > 0 && (
              <p className="text-[12px] text-warn font-medium mt-2">
                Sin conexión en este momento: {localesCaidos.map(s => s.nombre).join(", ")}. El dato se completa automáticamente.
              </p>
            )}
          </>
        )}
      </Card>

      <Card
        title="Facturación diaria"
        right={
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <div className="flex gap-1">
              {RANGOS_GRAFICO.map(r => (
                <button key={r.key} onClick={() => setDiasGrafico(r.key)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
                    diasGrafico === r.key ? "bg-negro text-white border-negro" : "bg-surface-1 text-ink-2 border-borde hover:bg-surface"
                  }`}>
                  {r.label}
                </button>
              ))}
            </div>
            {serie && <LeyendaLocal locales={LOCALES} />}
          </div>
        }
      >
        {errorSerie ? (
          <p className="text-[13px] text-bad py-6 text-center">No pude leer la base: {errorSerie}</p>
        ) : !serie ? <Spinner /> : (
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={serieGrafico} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="var(--color-borde)" />
                <XAxis dataKey="fecha" tickFormatter={fechaCorta} axisLine={false} tickLine={false}
                       tick={{ fontSize: 11, fill: "var(--color-ink-3)" }} minTickGap={20} />
                <YAxis tickFormatter={fmtPesosCorto} axisLine={false} tickLine={false}
                       tick={{ fontSize: 11, fill: "var(--color-ink-3)" }} width={62} />
                <Tooltip content={<TooltipPesos labelFormatter={fechaCorta} />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                {LOCALES.map((l, i) => (
                  <Bar key={l.key} dataKey={l.key} name={l.nombre} stackId="dia" fill={l.color}
                       stroke="var(--color-surface-1)" strokeWidth={1}
                       radius={i === LOCALES.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}
