import { useState } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home.jsx";
import Ventas from "./pages/Ventas.jsx";
import Productos from "./pages/Productos.jsx";
import Pedidos from "./pages/Pedidos.jsx";
import Finanzas from "./pages/Finanzas.jsx";
import Rentabilidad from "./pages/Rentabilidad.jsx";
import Login from "./pages/Login.jsx";

const NAV = [
  { to: "/", label: "Inicio", icon: "◧" },
  { to: "/ventas", label: "Ventas", icon: "▤" },
  { to: "/productos", label: "Productos", icon: "▦" },
  { to: "/pedidos", label: "Pedidos", icon: "◷" },
  { to: "/finanzas", label: "Finanzas", icon: "◈" },
  // Solo admin mientras esté en construcción
  { to: "/rentabilidad", label: "Rentabilidad", icon: "◎", soloAdmin: true },
];

function navPara(user) {
  return NAV.filter(item => !item.soloAdmin || user.rol === "admin");
}

function cerrarSesion() {
  localStorage.removeItem("tussy_user");
  localStorage.removeItem("tussy_pass");
  localStorage.removeItem("tussy_remember");
  localStorage.removeItem("tussy_sesion");
  window.location.href = "/";
}

function Sidebar({ user }) {
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col bg-negro text-white min-h-screen sticky top-0 max-h-screen">
      <div className="px-5 py-6 flex items-center gap-3">
        <img src="/logo.png" alt="Tussy" className="h-8 w-auto brightness-0 invert" />
        <div className="text-[11px] uppercase tracking-widest text-white/50 font-semibold">Métricas</div>
      </div>
      <nav className="flex-1 px-3 space-y-1">
        {navPara(user).map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-semibold transition-colors ${
                isActive ? "bg-white/10 text-white" : "text-white/55 hover:text-white hover:bg-white/5"
              }`
            }
          >
            <span className="text-base leading-none w-5 text-center">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="px-5 py-4 flex items-center justify-between">
        <span className="text-[11px] text-white/50 font-semibold">{user.nombre}</span>
        <button onClick={cerrarSesion} className="text-[11px] text-white/40 hover:text-white font-semibold">
          Salir
        </button>
      </div>
    </aside>
  );
}

function TabBar({ user }) {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-negro text-white flex justify-around pt-2 pb-[max(20px,calc(env(safe-area-inset-bottom)+8px))]">
      {navPara(user).map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) =>
            `flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-[10px] font-semibold ${
              isActive ? "text-white" : "text-white/50"
            }`
          }
        >
          <span className="text-lg leading-none">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("tussy_sesion")) || null; }
    catch { return null; }
  });

  if (!user) return <Login onLogin={setUser} />;

  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Sidebar user={user} />
        <main className="flex-1 min-w-0 px-4 md:px-8 py-6 pb-24 md:pb-8 max-w-[1200px]">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/ventas" element={<Ventas />} />
            <Route path="/productos" element={<Productos />} />
            <Route path="/pedidos" element={<Pedidos />} />
            <Route path="/finanzas" element={<Finanzas />} />
            {user.rol === "admin" && <Route path="/rentabilidad" element={<Rentabilidad />} />}
          </Routes>
        </main>
        <TabBar user={user} />
      </div>
    </BrowserRouter>
  );
}
