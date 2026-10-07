import { useEffect, useState } from "react";
import { getMeliEstado, getMeliAuthUrl } from "../lib/api.js";
import { Card, Spinner } from "./ui.jsx";

// Panel de conexión con Mercado Libre. La autorización se hace una sola vez: el
// botón le pide la URL al backend (que ahí genera y guarda el `state`) y manda a
// MELI. Después el token se renueva solo, así que esto queda como diagnóstico.
export default function MeliConexion() {
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState(null);
  const [yendo, setYendo] = useState(false);

  useEffect(() => {
    getMeliEstado().then(setEstado).catch(e => setError(e.message));
  }, []);

  const conectar = async () => {
    setYendo(true);
    setError(null);
    try {
      const { url } = await getMeliAuthUrl();
      window.location.href = url;
    } catch (e) {
      setError(e.message);
      setYendo(false);
    }
  };

  if (!estado && !error) return <Card title="Mercado Libre"><Spinner /></Card>;

  const ok = estado?.conectada;
  return (
    <Card title="Mercado Libre">
      {error && <p className="text-[12px] text-bad">{error}</p>}
      {estado && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-ok" : "bg-ink-3"}`} />
            <span className="text-[13px] font-semibold text-ink">
              {ok ? `Conectado como ${estado.nickname || estado.user_id}` : "Sin conectar"}
            </span>
          </div>
          <p className="text-[12px] text-ink-2">
            {ok
              ? `El acceso se renueva solo: vence en ${estado.access_token_vence_en_min} min y se refresca antes.`
              : estado.motivo}
          </p>
          <div>
            <button
              onClick={conectar}
              disabled={yendo}
              className="bg-negro text-white rounded-md px-3.5 py-2 text-[12px] font-semibold disabled:opacity-50"
            >
              {yendo ? "Abriendo Mercado Libre…" : ok ? "Volver a autorizar" : "Conectar Mercado Libre"}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
