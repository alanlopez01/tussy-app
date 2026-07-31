import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, useLocation } from "react-router-dom";
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
  { to: "/rentabilidad", label: "Rentabilidad", icon: "◎" },
];

function navPara(user) {
  return NAV.filter(item => !item.soloAdmin || user.rol === "admin");
}

function cerrarSesion() {
  localStorage.removeItem("tussy_user");
  localStorage.removeItem("tussy_pass");
  localStorage.removeItem("tussy_remember");
  localStorage.removeItem("tussy_sesion");
  localStorage.removeItem("tussy_token");
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

// Mobile: barra superior con hamburguesa + panel deslizante
function MenuMobile({ user }) {
  const [abierto, setAbierto] = useState(false);
  const location = useLocation();
  const items = navPara(user);
  const actual = items.find(i => i.to === location.pathname) || items[0];

  // Cerrar al navegar y bloquear el scroll del fondo mientras está abierto
  useEffect(() => { setAbierto(false); }, [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = abierto ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [abierto]);

  return (
    <>
      <header className="md:hidden sticky top-0 z-40 bg-negro text-white flex items-center gap-3 px-4 py-3 pt-[max(12px,env(safe-area-inset-top))]">
        <button onClick={() => setAbierto(true)} aria-label="Abrir menú"
                className="flex flex-col justify-center gap-[5px] w-8 h-8 shrink-0">
          <span className="block h-[2px] w-6 bg-white rounded-full" />
          <span className="block h-[2px] w-6 bg-white rounded-full" />
          <span className="block h-[2px] w-6 bg-white rounded-full" />
        </button>
        <img src="/logo.png" alt="Tussy" className="h-6 w-auto brightness-0 invert" />
        <span className="text-[13px] font-semibold text-white/60 ml-auto">{actual?.label}</span>
      </header>

      {abierto && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <nav className="w-64 max-w-[80%] bg-negro text-white flex flex-col pt-[max(20px,env(safe-area-inset-top))]">
            <div className="px-5 pb-6 flex items-center justify-between">
              <img src="/logo.png" alt="Tussy" className="h-7 w-auto brightness-0 invert" />
              <button onClick={() => setAbierto(false)} aria-label="Cerrar menú"
                      className="text-white/60 text-2xl leading-none px-2">×</button>
            </div>
            <div className="flex-1 px-3 space-y-1 overflow-y-auto">
              {items.map(item => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-semibold ${
                      isActive ? "bg-white/10 text-white" : "text-white/55"
                    }`}>
                  <span className="text-base w-5 text-center">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
            <div className="px-5 py-5 pb-[max(20px,env(safe-area-inset-bottom))] flex items-center justify-between border-t border-white/10">
              <span className="text-[12px] text-white/50 font-semibold">{user.nombre}</span>
              <button onClick={cerrarSesion} className="text-[12px] text-white/40 font-semibold">Salir</button>
            </div>
          </nav>
          <button className="flex-1 bg-black/50" onClick={() => setAbierto(false)} aria-label="Cerrar menú" />
        </div>
      )}
    </>
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
      <div className="md:flex min-h-screen">
        <Sidebar user={user} />
        <MenuMobile user={user} />
        <main className="flex-1 min-w-0 px-4 md:px-8 py-6 md:py-6 max-w-[1200px]">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/ventas" element={<Ventas />} />
            <Route path="/productos" element={<Productos />} />
            <Route path="/pedidos" element={<Pedidos />} />
            <Route path="/finanzas" element={<Finanzas />} />
            <Route path="/rentabilidad" element={<Rentabilidad />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
