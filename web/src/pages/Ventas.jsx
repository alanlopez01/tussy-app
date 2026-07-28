import { Card } from "../components/ui.jsx";

export default function Ventas() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-black text-ink">Ventas</h1>
        <p className="text-[13px] text-ink-3">Comparativas por período y local</p>
      </header>
      <Card>
        <p className="text-[13px] text-ink-3 py-8 text-center">
          En construcción — acá van las comparativas mes a mes, por local y por canal.
        </p>
      </Card>
    </div>
  );
}
