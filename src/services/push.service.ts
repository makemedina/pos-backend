import webpush from 'web-push';
import { prisma } from '../prisma';

const vapidConfigurado = !!(
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY &&
  process.env.VAPID_SUBJECT
);

if (vapidConfigurado) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
}

export function obtenerVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function guardarSuscripcionPush(
  usuarioId: string,
  suscripcion: { endpoint: string; keys: { p256dh: string; auth: string } }
) {
  await prisma.pushSubscription.upsert({
    where: { endpoint: suscripcion.endpoint },
    update: { usuarioId, p256dh: suscripcion.keys.p256dh, auth: suscripcion.keys.auth },
    create: {
      usuarioId,
      endpoint: suscripcion.endpoint,
      p256dh: suscripcion.keys.p256dh,
      auth: suscripcion.keys.auth,
    },
  });
}

export async function eliminarSuscripcionPush(endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
}

/**
 * Manda una notificacion push a todos los dispositivos suscritos de un
 * usuario. Si el navegador ya invalido esa suscripcion (410/404 -- el
 * usuario desinstalo la PWA, borro datos del sitio, etc.), se borra sola
 * en vez de seguir intentando mandarle para siempre.
 */
export async function enviarPush(
  usuarioId: string,
  payload: { title: string; body: string; tag?: string; url?: string }
) {
  if (!vapidConfigurado) return;

  const suscripciones = await prisma.pushSubscription.findMany({ where: { usuarioId } });
  await Promise.all(
    suscripciones.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          console.error(`[push] Error mandando a ${usuarioId}:`, err?.message || err);
        }
      }
    })
  );
}

/**
 * Manda un recordatorio push por cada pendiente programado para hoy que
 * todavia no se marca hecho -- al usuario que lo registro. Pensado para
 * correr una vez en la mañana (ver cron.ts).
 */
export async function notificarPendientesDeHoy() {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const pendientes = await prisma.pendiente.findMany({
    where: { fecha: hoy, hecho: false },
  });

  let enviados = 0;
  for (const p of pendientes) {
    await enviarPush(p.registradoPorId, {
      title: '📝 Pendiente de hoy',
      body: p.concepto,
      tag: `pendiente-${p.id}`,
      url: '/',
    });
    enviados++;
  }
  return { enviados };
}
