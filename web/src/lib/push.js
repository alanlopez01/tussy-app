// Suscripción a notificaciones push (misma infraestructura VAPID del sistema anterior)
const VAPID_PUBLIC = "BNeV0j4t-3qHIw1xEt_w127cJfyM7IWQISOH7s3ATqXJjO5jE5xclve1znRpHmYN5cEDshXbUfX4H5t7XN-c8s8";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function pushSoportado() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export async function activarPush(usuario = "socio") {
  if (!pushSoportado()) throw new Error("Este navegador no soporta notificaciones. En iPhone: agregá la app a la pantalla de inicio y abrila desde ahí.");
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") throw new Error("Permiso de notificaciones denegado. Activalo en los ajustes del navegador.");

  const reg = await navigator.serviceWorker.register("/sw.js");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    });
  }
  await fetch("/api/resumen-diario?action=subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), usuario }),
  });
  return true;
}

export async function pushActivo() {
  if (!pushSoportado()) return false;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub && Notification.permission === "granted";
}
