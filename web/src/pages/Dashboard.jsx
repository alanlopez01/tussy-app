// Dashboard: lo que antes eran Inicio y Productos, en solapas.
//
// Las dos son métricas del mismo negocio y se miraban una después de la otra,
// así que tenerlas como secciones distintas del menú obligaba a ir y volver.
// Acá se cambia de vista sin perder el lugar.
import { useState } from "react";
import { Chips } from "../components/ui.jsx";
import Home from "./Home.jsx";
import Productos from "./Productos.jsx";

export default function Dashboard({ rol }) {
  const admin = rol === "admin";
  // Productos expone costos y márgenes por modelo: no la ven los socios.
  const solapas = [
    { value: "resumen", label: "Resumen" },
    ...(admin ? [{ value: "productos", label: "Productos" }] : []),
  ];
  const [tab, setTab] = useState("resumen");
  const actual = solapas.some(s => s.value === tab) ? tab : "resumen";

  return (
    <div className="space-y-5">
      {solapas.length > 1 && <Chips opciones={solapas} valor={actual} onChange={setTab} />}
      {actual === "resumen" ? <Home /> : <Productos />}
    </div>
  );
}
