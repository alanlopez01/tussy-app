import { useEffect, useState } from "react";

export default function Login({ onLogin }) {
  const [usuario, setUsuario] = useState("");
  const [pass, setPass] = useState("");
  const [recordar, setRecordar] = useState(true);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  // Migración: versiones anteriores guardaban usuario+contraseña. Si están, se usa
  // una única vez para renovar la sesión y se borran para siempre.
  useEffect(() => {
    const u = localStorage.getItem("tussy_user");
    const p = localStorage.getItem("tussy_pass");
    if (localStorage.getItem("tussy_remember") === "1" && u && p) {
      setUsuario(u);
      entrar(u, p, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function entrar(u = usuario, p = pass, silencioso = false) {
    if (!u || !p) { setError("Completá usuario y contraseña"); return; }
    setCargando(true); setError("");
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario: u.trim().toLowerCase(), password: p.trim() }),
      });
      const data = await r.json();
      if (data.ok) {
        // La contraseña NUNCA se guarda: la sesión vive en un token firmado.
        localStorage.removeItem("tussy_pass");
        localStorage.setItem("tussy_token", data.token);
        localStorage.setItem("tussy_sesion", JSON.stringify({ rol: data.rol, nombre: data.nombre }));
        if (recordar || silencioso) {
          localStorage.setItem("tussy_user", u);
          localStorage.setItem("tussy_remember", "1");
        } else {
          localStorage.removeItem("tussy_user");
          localStorage.removeItem("tussy_remember");
        }
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
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="w-full max-w-[380px] sube">
        <div className="flex flex-col items-center gap-3 mb-7">
          <span className="w-12 h-12 rounded-[15px] bg-acento grid place-items-center">
            <img src="/logo.png" alt="Tussy" className="h-5 w-auto brightness-0 invert" />
          </span>
          <div className="text-center">
            <div className="text-[19px] font-bold text-ink tracking-[-0.02em] leading-tight">Tussy</div>
            <div className="text-[13px] text-ink-3 leading-tight">Métricas</div>
          </div>
        </div>
        <div className="elevado rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-ink-3 mb-1.5">Usuario</label>
            <input value={usuario} onChange={e => setUsuario(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && document.getElementById("login-pass")?.focus()}
                   className="w-full rounded-md aro bg-surface px-3 py-2.5 text-[14px] text-ink focus:aro-2 outline-none transition-shadow"
                   autoCapitalize="none" autoCorrect="off" />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-ink-3 mb-1.5">Contraseña</label>
            <input id="login-pass" type="password" value={pass} onChange={e => setPass(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && entrar()}
                   className="w-full rounded-md aro bg-surface px-3 py-2.5 text-[14px] text-ink focus:aro-2 outline-none transition-shadow" />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-ink-2 select-none cursor-pointer">
            <input type="checkbox" checked={recordar} onChange={e => setRecordar(e.target.checked)}
                   className="accent-[var(--color-acento)]" />
            Recordarme
          </label>
          {error && <p className="text-[12.5px] text-bad font-medium">{error}</p>}
          <button onClick={() => entrar()} disabled={cargando}
                  className="w-full rounded-md bg-acento text-white py-2.5 text-[14px] font-bold disabled:opacity-60
                             hover:bg-acento-hi transition-colors">
            {cargando ? "Ingresando…" : "Ingresar"}
          </button>
        </div>
      </div>
    </div>
  );
}
