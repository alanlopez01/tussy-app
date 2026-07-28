import { Card } from "../components/ui.jsx";

export default function Finanzas() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-black text-ink">Finanzas</h1>
        <p className="text-[13px] text-ink-3">Gastos e ingresos manuales (Google Sheet)</p>
      </header>
      <Card>
        <p className="text-[13px] text-ink-3 py-8 text-center">
          En construcción — se conecta al Sheet de finanzas como hasta ahora.
        </p>
      </Card>
    </div>
  );
}
