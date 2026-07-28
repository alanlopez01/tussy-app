import { Card } from "../components/ui.jsx";

export default function Pedidos() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-black text-ink">Pedidos</h1>
        <p className="text-[13px] text-ink-3">Feed en vivo de pedidos entrantes</p>
      </header>
      <Card>
        <p className="text-[13px] text-ink-3 py-8 text-center">
          En construcción — cuando activemos los webhooks (Fase 2), acá vas a ver cada pedido entrar en tiempo real.
        </p>
      </Card>
    </div>
  );
}
