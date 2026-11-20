import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { getJSON } from "./lib/api.js";
import { Spinner } from "./components/ui.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import VentasHub from "./pages/VentasHub.jsx";
import Finanzas from "./pages/Finanzas.jsx";
import Rentabilidad from "./pages/Rentabilidad.jsx";
import Contabilidad from "./pages/Contabilidad.jsx";
import Cajas from "./pages/Cajas.jsx";
import DeudaShato from "./pages/DeudaShato.jsx";
import Socios from "./pages/Socios.jsx";
import RRHH from "./pages/RRHH.jsx";
import Login from "./pages/Login.jsx";

// Los socios ven la operación (ventas, pedidos, finanzas) y el resultado del
// negocio; el detalle técnico (productos, contabilidad, costos) es del admin.
//
// `ver`  → se muestra a quien tenga esa pantalla habilitada (admin incluido).
// `noSi` → se esconde a quien ya tenga esa otra, porque muestran lo mismo.
const NAV = [
  { titulo: "Operación", items: [
    { to: "/", label: "Dashboard", icon: "tablero" },
    { to: "/ventas", label: "Ventas", icon: "barras" },
  ]},
  { titulo: "Administración", items: [
    // Finanzas es el resumen flaco de Cajas: la ve el que no tiene Cajas
    { to: "/finanzas", label: "Finanzas", icon: "billete", noSi: "cajas" },
    { to: "/cajas", label: "Cajas", icon: "caja", ver: "cajas" },
    { to: "/socios", label: "Socios", icon: "personas", soloAdmin: true },
    { to: "/deuda-shato", label: "Deuda Shato", icon: "intercambio", soloAdmin: true },
    { to: "/rrhh", label: "RRHH", icon: "persona", soloAdmin: true },
    { to: "/rentabilidad", label: "Rentabilidad", icon: "objetivo" },
    { to: "/contabilidad", label: "Contabilidad", icon: "documento", soloAdmin: true },
  ]},
];

// Iconos de trazo, 20px, en lugar de los símbolos unicode: los glifos
// geométricos no tienen todos el mismo peso ni el mismo centro óptico y la
// lista se ve temblorosa.
const TRAZOS = {
  tablero:     "M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v3A1.5 1.5 0 0 1 9.5 10h-4A1.5 1.5 0 0 1 4 8.5v-3Zm0 8A1.5 1.5 0 0 1 5.5 12h4A1.5 1.5 0 0 1 11 13.5v5A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-5Zm9-8A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v5A1.5 1.5 0 0 1 18.5 12h-4A1.5 1.5 0 0 1 13 10.5v-5Zm0 10A1.5 1.5 0 0 1 14.5 14h4A1.5 1.5 0 0 1 20 15.5v3A1.5 1.5 0 0 1 18.5 20h-4A1.5 1.5 0 0 1 13 18.5v-3Z",
  barras:      "M5 20V11m7 9V4m7 16v-6",
  billete:     "M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9Zm9 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  caja:        "M3 8.5 12 4l9 4.5M3 8.5v7L12 20l9-4.5v-7M3 8.5 12 13l9-4.5M12 13v7",
  personas:    "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 5 17.5V19m5.5-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15 4.2a3 3 0 0 1 0 5.6",
  persona:     "M18 19v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V19m6-9.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z",
  intercambio: "M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5",
  objetivo:    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0-3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  documento:   "M6 3.5h7L18.5 9v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5Zm7 0V9h5.5M8 13h8M8 17h5",
  sol:         "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-13v2m0 16v-2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4",
  luna:        "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  salir:       "M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h7a1.5 1.5 0 0 0 1.5-1.5V16m2.5-4H10m8.5 0L16 9.5M18.5 12 16 14.5",
  menu:        "M4 7h16M4 12h16M4 17h16",
  cerrar:      "M6 6l12 12M18 6 6 18",
};

function Icono({ nombre, className = "" }) {
  const d = TRAZOS[nombre];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
         className={`w-[19px] h-[19px] shrink-0 ${className}`}>
      <path d={d} />
    </svg>
  );
}

// Qué puede ver este usuario. El admin, todo; un socio, lo que el backend le
// haya habilitado (lib/usuarios.js → `ve`). Acá es solo la vista: el permiso de
// verdad lo valida cada endpoint con la misma lista.
function puedeVer(user, pantalla) {
  return user.rol === "admin" || (user.ve || []).includes(pantalla);
}

function navPara(user) {
  const admin = user.rol === "admin";
  const pasa = item =>
    (!item.soloAdmin || admin) &&
    (!item.ver || puedeVer(user, item.ver)) &&
    (!item.noSi || !puedeVer(user, item.noSi));
  return NAV
    .map(sec => ({ ...sec, items: sec.items.filter(pasa) }))
    .filter(sec => sec.items.length);
}

function cerrarSesion() {
  localStorage.removeItem("tussy_user");
  localStorage.removeItem("tussy_pass");
  localStorage.removeItem("tussy_remember");
  localStorage.removeItem("tussy_sesion");
  localStorage.removeItem("tussy_token");
  window.location.href = "/";
}

// ── Modo claro / oscuro ─────────────────────────────────────────────────────
// Arranca con lo que tenga el sistema y recuerda lo que el usuario elija.
function temaInicial() {
  try {
    const g = localStorage.getItem("tussy_tema");
    if (g === "dark" || g === "light") return g;
  } catch { /* sin localStorage: el sistema manda */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useTema() {
  const [tema, setTema] = useState(temaInicial);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", tema);
    try { localStorage.setItem("tussy_tema", tema); } catch { /* da igual */ }
  }, [tema]);
  return [tema, () => setTema(t => (t === "dark" ? "light" : "dark"))];
}

const claseItem = ({ isActive }) =>
  `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-semibold transition-colors ${
    isActive
      ? "bg-acento text-white shadow-[0_8px_18px_-10px_var(--color-acento)]"
      : "text-ink-2 hover:text-ink hover:bg-surface"
  }`;

function Marca() {
  return (
    <div className="flex items-center gap-2.5 px-1.5 pb-4">
      <span className="w-9 h-9 rounded-[11px] bg-acento grid place-items-center shrink-0">
        <img src="/logo.png" alt="" className="h-4 w-auto brightness-0 invert" />
      </span>
      <span className="min-w-0">
        <span className="block text-[14.5px] font-bold text-ink leading-tight tracking-[-0.01em]">Tussy</span>
        <span className="block text-[11.5px] text-ink-3 leading-tight truncate">Métricas</span>
      </span>
    </div>
  );
}

function Grupos({ secciones }) {
  return (
    <>
      {secciones.map(sec => (
        <div key={sec.titulo} className="space-y-0.5">
          <div className="px-2.5 pt-3 pb-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3/80">
            {sec.titulo}
          </div>
          {sec.items.map(item => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={claseItem}>
              <Icono nombre={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}

function BloqueUsuario({ user }) {
  return (
    <div className="mt-3 flex items-center gap-2.5 rounded-md aro bg-surface px-2.5 py-2">
      <span className="w-8 h-8 rounded-full bg-acento-suave text-acento-texto grid place-items-center text-[12px] font-bold shrink-0">
        {String(user.nombre || "?").slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-ink truncate leading-tight">{user.nombre}</span>
        <span className="block text-[11px] text-ink-3 leading-tight">{user.rol === "admin" ? "Administración" : "Socio"}</span>
      </span>
      <button onClick={cerrarSesion} title="Salir" aria-label="Salir"
              className="text-ink-3 hover:text-ink transition-colors p-1">
        <Icono nombre="salir" />
      </button>
    </div>
  );
}

// El panel lateral flota: no toca ningún borde de la ventana. Es lo que separa
// esta estética de un sidebar pegado al canto.
function Sidebar({ user }) {
  return (
    <aside className="hidden md:flex w-[244px] shrink-0 sticky top-3 h-[calc(100vh-24px)] m-3 mr-0
                      flex-col elevado rounded-xl px-3.5 pt-4 pb-3.5">
      <Marca />
      <nav className="flex-1 overflow-y-auto -mx-1 px-1">
        <Grupos secciones={navPara(user)} />
      </nav>
      <BloqueUsuario user={user} />
    </aside>
  );
}

// Mobile: la misma pieza, deslizándose. El encabezado dice SIEMPRE en qué
// pantalla estás, que era lo que se perdía en el celular.
function MenuMobile({ user, tema, alternarTema }) {
  const [abierto, setAbierto] = useState(false);
  const location = useLocation();
  const secciones = navPara(user);
  const planos = secciones.flatMap(s => s.items);
  const actual = planos.find(i => i.to === location.pathname) || planos[0];

  useEffect(() => { setAbierto(false); }, [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = abierto ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [abierto]);

  return (
    <>
      <header className="md:hidden sticky top-0 z-40 bg-surface/85 backdrop-blur-xl
                         flex items-center gap-2.5 px-4 py-2.5 pt-[max(10px,env(safe-area-inset-top))]">
        <button onClick={() => setAbierto(true)} aria-label="Abrir menú"
                className="w-9 h-9 grid place-items-center rounded-md aro bg-surface-1 text-ink-2 shrink-0">
          <Icono nombre="menu" />
        </button>
        <span className="min-w-0">
          <span className="block text-[15px] font-bold text-ink leading-tight tracking-[-0.01em] truncate">
            {actual?.label}
          </span>
        </span>
        <button onClick={alternarTema} aria-label="Cambiar tema"
                className="ml-auto w-9 h-9 grid place-items-center rounded-md aro bg-surface-1 text-ink-2 shrink-0">
          <Icono nombre={tema === "dark" ? "sol" : "luna"} />
        </button>
      </header>

      {abierto && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <nav className="w-[268px] max-w-[82%] m-2 flotante rounded-xl flex flex-col px-3.5 pt-4 pb-3.5
                          pt-[max(16px,env(safe-area-inset-top))]">
            <div className="flex items-start justify-between">
              <Marca />
              <button onClick={() => setAbierto(false)} aria-label="Cerrar menú"
                      className="text-ink-3 p-1.5 -mt-0.5">
                <Icono nombre="cerrar" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto -mx-1 px-1">
              <Grupos secciones={secciones} />
            </div>
            <BloqueUsuario user={user} />
          </nav>
          <button className="flex-1 bg-black/40 backdrop-blur-[2px]" onClick={() => setAbierto(false)} aria-label="Cerrar menú" />
        </div>
      )}
    </>
  );
}

// La barra de arriba del escritorio: dónde estoy, qué día es, y el tema.
function TopBar({ tema, alternarTema }) {
  const location = useLocation();
  const planos = NAV.flatMap(s => s.items);
  const actual = planos.find(i => i.to === location.pathname);
  const hoy = new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="hidden md:flex items-center gap-2 pt-4 pb-1">
      <nav className="flex items-center gap-1.5 text-[12.5px] min-w-0" aria-label="Dónde estoy">
        <span className="text-ink-3">Tussy</span>
        <span className="text-ink-3/60">›</span>
        <span className="font-semibold text-ink truncate">{actual?.label || "Dashboard"}</span>
        <span className="text-ink-3/60">·</span>
        <span className="text-ink-3 truncate first-letter:uppercase">{hoy}</span>
      </nav>
      <button onClick={alternarTema} aria-label="Cambiar tema"
              className="ml-auto w-8 h-8 grid place-items-center rounded-md aro bg-surface-1 text-ink-2
                         hover:text-ink transition-colors shrink-0">
        <Icono nombre={tema === "dark" ? "sol" : "luna"} />
      </button>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("tussy_sesion")) || null; }
    catch { return null; }
  });
  const [tema, alternarTema] = useTema();

  // La sesión guardada puede ser vieja y no saber lo que este usuario ya tiene
  // habilitado. Al abrir se la pregunta al server: un permiso nuevo vale en el
  // próximo F5, nadie tiene que cerrar sesión y volver a entrar. Si el server
  // no contesta, se sigue con la que había; si el token no vale, getJSON
  // devuelve al login por su cuenta.
  const [refrescando, setRefrescando] = useState(() => !!localStorage.getItem("tussy_token"));
  useEffect(() => {
    if (!localStorage.getItem("tussy_token")) return;
    getJSON("/api/auth?action=sesion", 15000)
      .then(s => {
        const sesion = { usuario: s.usuario, rol: s.rol, nombre: s.nombre, ve: s.ve || [] };
        localStorage.setItem("tussy_sesion", JSON.stringify(sesion));
        setUser(u => (JSON.stringify(u) === JSON.stringify(sesion) ? u : sesion));
      })
      .catch(() => { /* sin red: vale la sesión guardada */ })
      .finally(() => setRefrescando(false));
  }, []);

  if (!user) return <Login onLogin={setUser} />;

  // Solo las sesiones viejas (las que no traen `ve`) esperan al refresh.
  const esperandoPermisos = refrescando && !user.ve;

  return (
    <BrowserRouter>
      <div className="md:flex min-h-screen">
        <Sidebar user={user} />
        <MenuMobile user={user} tema={tema} alternarTema={alternarTema} />
        <div className="flex-1 min-w-0 px-4 md:px-7 pb-14 max-w-[1500px]">
          <TopBar tema={tema} alternarTema={alternarTema} />
          <main className="py-3 md:py-4">
            <Routes>
              <Route path="/" element={<Dashboard rol={user.rol} />} />
              <Route path="/ventas" element={<VentasHub rol={user.rol} />} />
              {/* Productos y Pedidos pasaron a ser solapas. Las rutas viejas se
                  mantienen porque hay notificaciones y links guardados que apuntan ahí. */}
              <Route path="/productos" element={<Navigate to="/" replace />} />
              <Route path="/pedidos" element={<Navigate to="/ventas" replace />} />
              {/* Una sesión guardada de antes de los permisos no sabe todavía qué
                  puede ver: esperar al refresh en vez de rebotar a Dashboard. */}
              <Route path="/finanzas" element={esperandoPermisos ? <Spinner texto="Un segundo…" />
                : puedeVer(user, "cajas") ? <Navigate to="/cajas" replace /> : <Finanzas />} />
              {/* El socio habilitado ve la misma pantalla, sin los botones de carga */}
              <Route path="/cajas" element={esperandoPermisos ? <Spinner texto="Un segundo…" />
                : puedeVer(user, "cajas") ? <Cajas soloLectura={user.rol !== "admin"} />
                : <Navigate to="/" replace />} />
              <Route path="/rrhh" element={user.rol === "admin" ? <RRHH /> : <Navigate to="/" replace />} />
              <Route path="/deuda-shato" element={user.rol === "admin" ? <DeudaShato /> : <Navigate to="/" replace />} />
              <Route path="/socios" element={user.rol === "admin" ? <Socios /> : <Navigate to="/" replace />} />
              <Route path="/rentabilidad" element={<Rentabilidad rol={user.rol} />} />
              <Route path="/contabilidad" element={user.rol === "admin" ? <Contabilidad /> : <Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
