// Ventas: el listado de pedidos y el análisis por hora, en solapas.
//
// Las dos pantallas listaban las mismas operaciones —una con el margen y otra
// sin él— y vivían en secciones distintas del menú. Ahora Pedidos es la vista
// por defecto, que es la que se mira todos los días, y el análisis queda al lado.
import { useState } from "react";
import { Chips } from "../components/ui.jsx";
import Pedidos from "./Pedidos.jsx";
import Ventas from "./Ventas.jsx";

const SOLAPAS = [
  { value: "pedidos", label: "Pedidos" },
  { value: "analisis", label: "Por hora y local" },
];

export default function VentasHub({ rol }) {
  const [tab, setTab] = useState("pedidos");
  return (
    <div className="space-y-5">
      <Chips opciones={SOLAPAS} valor={tab} onChange={setTab} />
      {tab === "pedidos" ? <Pedidos rol={rol} /> : <Ventas />}
    </div>
  );
}
