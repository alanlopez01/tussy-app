import { useEffect, useState } from "react";

export default function Login({ onLogin }) {
  const [usuario, setUsuario] = useState("");
  const [pass, setPass] = useState("");
  const [recordar, setRecordar] = useState(true);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  // Auto-login si quedó recordado
  useEffect(() => {
    const u = localStorage.getItem("tussy_user");
    const p = localStorage.getItem("tussy_pass");
    if (localStorage.getItem("tussy_remember") === "1" && u && p) {
      setUsuario(u); setPass(p);
      entrar(u, p, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function entrar(u = usuario, p = pass, silencioso = false) {
    if (!u || !p) { setError("Completá usuario y contraseña"); return; }
    setCargando(true); setError("");
    try {
      const r = await fetch(`/api/auth?usuario=${encodeURIComponent(u.trim().toLowerCase())}&password=${encodeURIComponent(p.trim())}`);
      const data = await r.json();
      if (data.ok) {
        if (recordar || silencioso) {
          localStorage.setItem("tussy_user", u);
          localStorage.setItem("tussy_pass", p);
          localStorage.setItem("tussy_remember", "1");
        } else {
          localStorage.removeItem("tussy_user");
          localStorage.removeItem("tussy_pass");
          localStorage.removeItem("tussy_remember");
        }
        localStorage.setItem("tussy_sesion", JSON.stringify({ rol: data.rol, nombre: data.nombre }));
        onLogin({ rol: data.rol, nombre: data.nombre });
      } else {
        if (!silencioso) setError(data.error || "Usuario o contraseña incorrectos");
        setCargando(false);
      }
    } catch {
      if (!silencioso) setError("Error de conexión");
      setCargando(false);
    }
  }

  return (
    <div className="min-h-screen bg-negro flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <img src="/logo.png" alt="Tussy" className="h-12 brightness-0 invert" />
        </div>
        <div className="bg-surface-1 rounded-lg p-6 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1.5">Usuario</label>
            <input value={usuario} onChange={e => setUsuario(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && document.getElementById("login-pass")?.focus()}
                   className="w-full rounded-md border border-borde bg-surface-1 px-3 py-2.5 text-[14px] text-ink"
                   autoCapitalize="none" autoCorrect="off" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1.5">Contraseña</label>
            <input id="login-pass" type="password" value={pass} onChange={e => setPass(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && entrar()}
                   className="w-full rounded-md border border-borde bg-surface-1 px-3 py-2.5 text-[14px] text-ink" />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={recordar} onChange={e => setRecordar(e.target.checked)} />
            Recordarme
          </label>
          {error && <p className="text-[12px] text-bad font-medium">{error}</p>}
          <button onClick={() => entrar()} disabled={cargando}
                  className="w-full rounded-md bg-negro text-white py-2.5 text-[14px] font-bold disabled:opacity-60">
            {cargando ? "Ingresando…" : "Ingresar"}
          </button>
        </div>
        <p className="text-center text-[10px] uppercase tracking-widest text-white/30 font-semibold mt-6">Tussy · Métricas</p>
      </div>
    </div>
  );
}
