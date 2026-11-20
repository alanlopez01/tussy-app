// Las piezas de gráfico.
//
// Todas se dibujan con divs, no con SVG ni con una librería. No es capricho: lo
// que define esta estética —el día futuro rayado, el punto de hoy, la grilla
// punteada con el número encima de la línea, el corte de 2px entre tramos, la
// columna que se prende entera al pasar el mouse— es justamente lo que una
// librería de gráficos no deja tocar sin pelear. Con divs son cuatro reglas de
// CSS y se tematizan solas con los tokens.
import { useState } from "react";

// ── Escala "linda" ────────────────────────────────────────────────────────
// Un eje que termina en 1.237.904 no se lee. Esto redondea el techo hacia
// arriba al 1/2/5 × 10ⁿ más cercano y devuelve los cuatro cortes de la grilla.
export function escalaLinda(max, cortes = 4) {
  if (!(max > 0)) return { techo: 1, pasos: [1, 0.75, 0.5, 0.25, 0] };
  const crudo = max / cortes;
  const mag = Math.pow(10, Math.floor(Math.log10(crudo)));
  const paso = [1, 2, 2.5, 5, 10].map(m => m * mag).find(p => p >= crudo) || 10 * mag;
  const techo = paso * cortes;
  return { techo, pasos: Array.from({ length: cortes + 1 }, (_, i) => techo - i * paso) };
}

// ── El tooltip ────────────────────────────────────────────────────────────
// Tinta sólida, nunca una tarjeta clara: tiene que despegarse del gráfico que
// está tapando.
function Globo({ titulo, sub, filas, lado, alturaRel = 0, altoPlot = 260, fmt }) {
  const pos = lado === "izq" ? "left-0" : lado === "der" ? "right-0" : "left-1/2 -translate-x-1/2";
  // Se apoya arriba de la barra, pero con un techo calculado: el área del
  // gráfico scrollea en horizontal, y eso hace que también recorte en vertical.
  // Un globo de siete locales mide ~185px: sin este tope, en una barra alta el
  // navegador le come el título y el total sin avisar.
  const altoGlobo = 58 + (filas?.length || 0) * 18;
  const tope = Math.max(0, (altoPlot - altoGlobo - 14) / altoPlot);
  const abajo = `calc(${Math.min(alturaRel, tope) * 100}% + 10px)`;
  return (
    <div className={`absolute ${pos} z-20 pointer-events-none whitespace-nowrap
                     rounded-md px-2.5 py-2 flex flex-col gap-px flotante`}
         style={{ bottom: abajo, background: "var(--color-negro)", color: "var(--color-surface-1)", minWidth: 168 }}>
      <b className="text-[13.5px] font-bold cifra">{titulo}</b>
      {sub && <small className="text-[11px] font-semibold opacity-75">{sub}</small>}
      {filas?.length > 0 && (
        <div className="mt-1 flex flex-col gap-[3px]">
          {filas.map(f => (
            <div key={f.nombre} className="flex items-center gap-1.5 text-[11.5px]">
              <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: f.color }} />
              <span className="font-medium opacity-90">{f.nombre}</span>
              <em className="ml-auto pl-3 not-italic font-bold cifra">{fmt(f.valor)}</em>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Barras apiladas por día ───────────────────────────────────────────────
// `datos`: [{ id, etiqueta, sub, valores: {clave: número}, futuro, hoy }]
// `series`: [{ key, nombre, color }] — el orden es el del apilado, de abajo
//           hacia arriba, y NO cambia nunca: el color sigue al local, no al
//           puesto que ocupa hoy.
export function BarrasApiladas({ datos, series, fmt, fmtCorto = fmt, alto = 260, mejor = true }) {
  const [activa, setActiva] = useState(null);
  const n = datos.length;
  const muchas = n > 14;

  const totales = datos.map(d => series.reduce((a, s) => a + (d.valores?.[s.key] || 0), 0));
  const pico = Math.max(...totales, 0);
  const { techo, pasos } = escalaLinda(pico);
  const iMejor = mejor && pico > 0 ? totales.indexOf(pico) : -1;

  return (
    <div className="relative select-none" style={{ padding: "4px 0 26px 52px", height: alto }}>
      {/* La grilla: punteada, con el número APOYADO en la línea y no en una
          columna de eje aparte. Ahorra 60px de ancho y no parte la tarjeta. */}
      <div className="absolute inset-y-[4px] left-[52px] right-0 bottom-[26px] flex flex-col justify-between pointer-events-none">
        {pasos.map((v, i) => (
          <div key={i} className="relative h-0"
               style={{ borderTop: `1px ${i === pasos.length - 1 ? "solid" : "dashed"} var(--color-linea-2)` }}>
            <span className="absolute -top-2 -left-[52px] text-[11px] font-semibold text-ink-3">{fmtCorto(v)}</span>
          </div>
        ))}
      </div>

      {/* La línea del mejor día, con su chapita. Da una referencia sin obligar a
          leer el eje. Va DENTRO de una caja con los mismos márgenes que la
          grilla: si no, el porcentaje se mide contra el alto total y la línea
          cae siempre un poco más arriba de donde está el pico. */}
      {iMejor >= 0 && (
        <div className="absolute left-[52px] right-0 top-[4px] bottom-[26px] z-[2] pointer-events-none">
          <div className="absolute -left-1 right-0 h-0"
               style={{ bottom: `${(pico / techo) * 100}%`,
                        borderTop: "1.5px dashed color-mix(in srgb, var(--color-ink) 45%, transparent)" }}>
            <small className="absolute -top-[11px] right-0 rounded-[7px] px-2 py-0.5 text-[11px] font-bold"
                   style={{ background: "var(--color-negro)", color: "var(--color-surface)" }}>
              mejor · {fmtCorto(pico)}
            </small>
          </div>
        </div>
      )}

      <div className="relative flex h-full" style={{ gap: muchas ? 3 : 8 }}>
        {datos.map((d, i) => {
          const total = totales[i];
          let cum = 0;
          const capas = series.map(s => {
            const v = d.valores?.[s.key] || 0;
            cum += v;
            return { ...s, v, cum };
          });
          // La capa más alta con valor: es la única que no lleva corte arriba,
          // así la corona de la barra queda limpia.
          let corona = -1;
          capas.forEach((c, k) => { if (c.v > 0) corona = k; });
          const verEtiqueta = !muchas || i % 5 === 0 || d.hoy;
          const lado = i < 2 ? "der" : i > n - 3 ? "izq" : "centro";

          return (
            <div key={d.id ?? i}
                 className="relative flex flex-1 min-w-0 justify-center h-full"
                 onMouseEnter={() => setActiva(i)} onMouseLeave={() => setActiva(null)}
                 onFocus={() => setActiva(i)} onBlur={() => setActiva(null)}
                 tabIndex={total > 0 ? 0 : -1}>
              {/* La pista: todo el alto de la columna. Se prende al pasar el
                  mouse, que es lo que hace que el gráfico se sienta vivo sin
                  mover nada. El día que todavía no pasó va rayado. */}
              <div className={`relative w-full h-full max-w-[54px] rounded-t-[12px] rounded-b-[4px] transition-colors
                               ${d.futuro ? "rayado" : ""}`}
                   style={activa === i && !d.futuro ? { background: "var(--color-pista)" } : undefined}>
                {!d.futuro && capas.slice().reverse().map((c, k) => c.cum > 0 && (
                  <div key={c.key}
                       className={`absolute left-0 right-0 bottom-0 rounded-t-[10px] rounded-b-[4px]
                                   ${capas.length - 1 - k === corona ? "" : (muchas ? "corte-fino" : "corte")}`}
                       style={{ height: `${(c.cum / techo) * 100}%`, background: c.color,
                                transition: "height .45s var(--ease-suave)" }} />
                ))}
                {/* El punto de hoy, por debajo de la base. */}
                {d.hoy && (
                  <span className="absolute -bottom-[5px] left-1/2 -ml-[2.5px] w-[5px] h-[5px] rounded-full"
                        style={{ background: "var(--color-ink)" }} />
                )}
              </div>

              {verEtiqueta && (
                <span className={`absolute -bottom-[22px] -left-[40%] -right-[40%] text-center text-[11px]
                                  whitespace-nowrap ${d.hoy ? "font-bold text-ink" : "font-semibold text-ink-3"}`}>
                  {d.etiqueta}
                </span>
              )}

              {activa === i && total > 0 && (
                <Globo titulo={fmt(total)} sub={d.sub || d.etiqueta} lado={lado} fmt={fmt}
                       alturaRel={total / techo} altoPlot={alto - 30}
                       filas={capas.filter(c => c.v > 0).map(c => ({ nombre: c.nombre, valor: c.v, color: c.color }))} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── La fila de ranking ────────────────────────────────────────────────────
// Puesto, nombre, barra fina sobre canaleta, número a la derecha en negrita.
export function FilaRanking({ puesto, nombre, sub, valor, max, texto, color = "var(--color-dato)", derecha }) {
  const f = max > 0 ? Math.max(valor / max, 0) : 0;
  return (
    <div className="grid items-center gap-3 py-2 border-b border-borde last:border-0"
         style={{ gridTemplateColumns: puesto != null ? "18px minmax(0,1fr) minmax(40px,110px) auto" : "minmax(0,1fr) minmax(40px,110px) auto" }}>
      {puesto != null && (
        <span className={`text-center text-[12.5px] font-bold ${puesto === 1 ? "text-acento-texto" : "text-ink-3"}`}>
          {puesto}
        </span>
      )}
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink truncate">{nombre}</div>
        {sub && <div className="text-[11.5px] text-ink-3 truncate">{sub}</div>}
      </div>
      <div className="relative h-2 rounded-sm overflow-hidden" style={{ background: "var(--color-pista-2)" }}>
        <div className="absolute inset-0 rounded-[inherit] origin-left"
             style={{ background: color, transform: `scaleX(${f})`, transition: "transform .45s var(--ease-suave)" }} />
      </div>
      <span className="text-right text-[13px] font-bold text-ink cifra whitespace-nowrap">{texto}</span>
      {derecha}
    </div>
  );
}

// ── El medidor ────────────────────────────────────────────────────────────
// Avance contra una meta. Cambia de color solo cuando el avance se queda corto,
// nunca "decorativamente".
export function Medidor({ valor, meta, marca, alto = 8, color: forzado }) {
  const f = meta > 0 ? Math.min(valor / meta, 1) : 0;
  const pct = meta > 0 ? (valor / meta) * 100 : 0;
  // Los mismos tres cortes que ya usaba el número al lado: llegaste (100),
  // casi (90), no llegaste. Sin una banda "neutral" en el medio, que haría que
  // la barra dijera una cosa y el porcentaje de al lado otra.
  const color = forzado || (pct >= 100 ? "var(--color-ok)" : pct >= 90 ? "var(--color-warn)" : "var(--color-bad)");
  return (
    <div className="relative block rounded-sm overflow-hidden" style={{ background: "var(--color-pista-2)", height: alto }}>
      <div className="absolute inset-0 rounded-[inherit] origin-left"
           style={{ background: color, transform: `scaleX(${f})`, transition: "transform .5s var(--ease-suave)" }} />
      {marca != null && marca > 0 && marca < 1 && (
        <span className="absolute top-0 bottom-0 w-px" style={{ left: `${marca * 100}%`, background: "var(--color-ink)", opacity: 0.55 }} />
      )}
    </div>
  );
}

// ── La chapita de variación ───────────────────────────────────────────────
// Píldora con fondo teñido, no texto suelto de color: el número y su signo
// forman un objeto, y el color deja de competir con las cifras de al lado.
export function Delta({ pct, sufijo = "%" }) {
  if (pct == null || isNaN(pct)) return null;
  const v = Math.round(pct);
  const sube = v > 0, baja = v < 0;
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full px-[7px] py-0.5 text-[11px] font-bold whitespace-nowrap"
          style={{
            color: sube ? "var(--color-ok)" : baja ? "var(--color-bad)" : "var(--color-ink-3)",
            background: sube ? "var(--color-ok-suave)" : baja ? "var(--color-bad-suave)" : "var(--color-pista-2)",
          }}>
      {sube ? "↑" : baja ? "↓" : "·"} {Math.abs(v)}{sufijo}
    </span>
  );
}
