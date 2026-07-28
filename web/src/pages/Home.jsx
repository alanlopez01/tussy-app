import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell,
} from "recharts";
import { getSerie, getHoyVivo, hoyISO, diasAtras, primerDiaMes, LOCALES, fmtPesos, fmtPesosCorto } from "../lib/api.js";
import { Card, StatTile, Spinner, LeyendaLocal, TooltipPesos } from "../components/ui.jsx";

function fechaCorta(iso) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${parseInt(m)}`;
}

export default function Home() {
  const [serie, setSerie] = useState(null);
  const [hoyVivo, setHoyVivo] = useState(null);
  const [errorSerie, setErrorSerie] = useState(null);

  useEffect(() => {
    getSerie(diasAtras(30), diasAtras(1))
      .then(d => setSerie(d.dias))
      .catch(e => setErrorSerie(e.message));
    getHoyVivo().then(setHoyVivo).catch(() => setHoyVivo({ woo: null, df: null }));
  }, []);

  // KPIs de hoy en vivo
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

  // Promedio del mismo día de la semana (últimas 4 semanas) para el delta de hoy
  const promedioMismoDia = useMemo(() => {
    if (!serie) return null;
    const dow = new Date(hoyISO() + "T12:00:00Z").getUTCDay();
    const mismos = serie.filter(d => new Date(d.fecha + "T12:00:00Z").getUTCDay() === dow);
    if (!mismos.length) return null;
    return mismos.reduce((a, d) => a + d.total, 0) / mismos.length;
  }, [serie]);

  const serieMes = useMemo(() => {
    if (!serie) return [];
    return serie.filter(d => d.fecha >= primerDiaMes());
  }, [serie]);

  const totalMes = serieMes.reduce((a, d) => a + d.total, 0) + (hoy?.total || 0);

  const barrasHoy = hoy?.stores
    .filter(s => !s.cargando)
    .map(s => ({ nombre: s.nombre, total: s.total || 0, color: LOCALES.find(l => l.key === s.key)?.color })) || [];

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-black text-ink">Hola 👋</h1>
          <p className="text-[13px] text-ink-3 capitalize">
            {new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
      </header>

      {/* KPIs hero */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatTile
          label="Ventas hoy"
          value={hoy ? fmtPesos(hoy.total) : "…"}
          delta={hoy && promedioMismoDia ? ((hoy.total - promedioMismoDia) / promedioMismoDia) * 100 : null}
          sub={promedioMismoDia ? `vs promedio del día` : "cargando comparativa"}
        />
        <StatTile
          label="Operaciones hoy"
          value={hoy ? hoy.ops : "…"}
          sub={hoy && hoy.ops > 0 ? `ticket promedio ${fmtPesos(hoy.ticket)}` : ""}
        />
        <StatTile
          label="Facturación del mes"
          value={serie ? fmtPesosCorto(totalMes) : "…"}
          sub={serie ? `${serieMes.length + 1} días` : ""}
        />
      </div>

      {/* Hoy por local */}
      <Card title="Hoy por local">
        {!hoy ? <Spinner /> : (
          <>
            <div className="h-[210px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barrasHoy} margin={{ top: 18, right: 8, left: 8, bottom: 0 }} barCategoryGap="28%">
                  <CartesianGrid vertical={false} stroke="var(--color-borde)" strokeDasharray="0" />
                  <XAxis dataKey="nombre" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "var(--color-ink-2)" }} />
                  <YAxis hide />
                  <Tooltip content={<TooltipPesos />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="total" name="Ventas" radius={[4, 4, 0, 0]}
                       label={{ position: "top", fontSize: 11, fill: "var(--color-ink-2)", formatter: v => v > 0 ? fmtPesosCorto(v) : "" }}>
                    {barrasHoy.map(b => <Cell key={b.nombre} fill={b.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {hoy.stores.some(s => s.total === null && !s.cargando) && (
              <p className="text-[12px] text-warn font-semibold mt-2">
                ⚠ {hoy.stores.filter(s => s.total === null && !s.cargando).map(s => s.nombre).join(", ")}: sin conexión ahora — el dato se completa solo
              </p>
            )}
          </>
        )}
      </Card>

      {/* Serie del mes */}
      <Card title="Facturación diaria — últimos 30 días" right={serie && <LeyendaLocal locales={LOCALES} />}>
        {errorSerie ? (
          <p className="text-[13px] text-bad py-6 text-center">No pude leer la base: {errorSerie}</p>
        ) : !serie ? <Spinner /> : (
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={serie} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-borde)" strokeDasharray="0" />
                <XAxis dataKey="fecha" tickFormatter={fechaCorta} axisLine={false} tickLine={false}
                       tick={{ fontSize: 11, fill: "var(--color-ink-3)" }} minTickGap={24} />
                <YAxis tickFormatter={fmtPesosCorto} axisLine={false} tickLine={false}
                       tick={{ fontSize: 11, fill: "var(--color-ink-3)" }} width={62} />
                <Tooltip content={<TooltipPesos labelFormatter={fechaCorta} />} />
                {LOCALES.map(l => (
                  <Area key={l.key} type="monotone" dataKey={l.key} name={l.nombre} stackId="1"
                        stroke={l.color} fill={l.color} fillOpacity={0.85} strokeWidth={0} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}
