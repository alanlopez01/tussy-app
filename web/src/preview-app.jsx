// Banco de pruebas del ruteo y los permisos: la app entera, con la sesión que
// se le pida y /api mockeado. No entra al build; es una entrada de Vite aparte.
//
//   /preview-app.html?quien=fede|alan|nico[&ruta=/cajas]
//
// Existe porque en dev vite proxea /api a producción: sin esto, mirar la app
// local significaría mandar una contraseña real fuera de la máquina. Ojo: solo
// están mockeados /api/auth y /api/cajas — para probar otra pantalla hay que
// agregarle los datos que esa pantalla pide, o va a romper.
import { createRoot } from "react-dom/client";
import "./index.css";

const quien = new URLSearchParams(location.search).get("quien") || "fede";
const SESIONES = {
  alan: { ok: true, usuario: "alan", rol: "admin", nombre: "Alan", ve: [] },
  fede: { ok: true, usuario: "fede", rol: "socio", nombre: "Federico", ve: ["cajas"] },
  nico: { ok: true, usuario: "nico", rol: "socio", nombre: "Nicolas", ve: [] },
};
localStorage.setItem("tussy_token", "falso");
localStorage.setItem("tussy_sesion", JSON.stringify({ rol: SESIONES[quien].rol, nombre: SESIONES[quien].nombre }));

const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const MOVS = [
  { id: 1, fecha: hoy, tipo: "egreso", categoria: "Talleres", detalle: "pago taller Luis", monto: 1850000, medio: "Efectivo" },
  { id: 2, fecha: hoy, tipo: "ingreso", categoria: "Local Palermo", detalle: "rendición sábado", monto: 2940000, medio: "Efectivo" },
];
const RESUMEN = { totalGasto: 1850000, totalIngreso: 2940000, neto: 1090000, saldoActual: 14382500,
                  porCatGasto: { Talleres: 1850000 }, porCatIngreso: { "Local Palermo": 2940000 }, txHoy: [] };

window.fetch = async (url) => {
  const u = String(url);
  const cuerpo =
    u.includes("action=sesion") ? SESIONES[quien]
    : u.includes("action=resumen") ? RESUMEN
    : u.includes("action=movimientos") ? { movimientos: MOVS }
    : u.includes("action=categorias") ? { gasto: ["Talleres", "Tela"], ingreso: ["Local Palermo"] }
    : {};
  return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "Content-Type": "application/json" } });
};

history.replaceState({}, "", (new URLSearchParams(location.search).get("ruta") || "/cajas") + location.search);
const { default: App } = await import("./App.jsx");
createRoot(document.getElementById("root")).render(<App />);
