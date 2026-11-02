import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '../prisma';
import { normalizarTelefono } from '../services/metaCapi.service';

// Webhook de la API de WhatsApp Cloud. Meta llama aqui por cada mensaje
// que recibe el numero del negocio. Solo nos interesan los que abren un
// chat desde un anuncio de "clic a WhatsApp": traen un objeto "referral"
// con ctwa_clid, que se guarda para mandarlo despues con la compra (ver
// metaCapi.service). Los mensajes en si no se guardan.
//
// Sin WHATSAPP_VERIFY_TOKEN y META_APP_SECRET el webhook responde 404 (la
// sucursal que no lo use no expone nada).
//
// Se monta en server.ts ANTES de express.json: la firma de Meta
// (X-Hub-Signature-256) se calcula sobre el cuerpo crudo, byte por byte.

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

export const whatsappWebhook = Router();

whatsappWebhook.use((_req, res, next) => {
  if (!VERIFY_TOKEN || !APP_SECRET) return res.sendStatus(404);
  next();
});

// Meta verifica la URL una sola vez, al configurar el webhook en la app.
whatsappWebhook.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

function firmaValida(cuerpo: Buffer, firma: string | undefined): boolean {
  if (!firma?.startsWith('sha256=')) return false;
  const esperada = Buffer.from(createHmac('sha256', APP_SECRET!).update(cuerpo).digest('hex'));
  const recibida = Buffer.from(firma.slice('sha256='.length));
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

interface MensajeWhatsapp {
  id: string;
  from: string;
  timestamp?: string;
  referral?: {
    ctwa_clid?: string;
    source_id?: string;
    source_type?: string;
    headline?: string;
  };
}

function mensajesConReferido(cuerpo: any): MensajeWhatsapp[] {
  const mensajes: MensajeWhatsapp[] = [];
  for (const entrada of cuerpo?.entry ?? []) {
    for (const cambio of entrada?.changes ?? []) {
      for (const mensaje of cambio?.value?.messages ?? []) {
        if (mensaje?.referral?.ctwa_clid && mensaje.id && mensaje.from) mensajes.push(mensaje);
      }
    }
  }
  return mensajes;
}

whatsappWebhook.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const cuerpo = req.body as Buffer;
  if (!Buffer.isBuffer(cuerpo) || !firmaValida(cuerpo, req.header('x-hub-signature-256'))) {
    return res.sendStatus(401);
  }

  // Se contesta 200 aunque falle el guardado: si no, Meta reintenta el
  // mismo webhook por horas. El error queda en el log.
  try {
    for (const mensaje of mensajesConReferido(JSON.parse(cuerpo.toString('utf8')))) {
      const telefono = normalizarTelefono(mensaje.from);
      if (!telefono) continue;
      const segundos = Number(mensaje.timestamp);
      await prisma.referidoWhatsapp.upsert({
        where: { mensajeId: mensaje.id },
        update: {},
        create: {
          mensajeId: mensaje.id,
          telefono,
          ctwaClid: mensaje.referral!.ctwa_clid!,
          sourceId: mensaje.referral!.source_id ?? null,
          sourceType: mensaje.referral!.source_type ?? null,
          headline: mensaje.referral!.headline ?? null,
          recibidoEn: Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date(),
        },
      });
      console.log('[whatsapp] chat desde anuncio', mensaje.referral!.source_id ?? '-');
    }
  } catch (err) {
    console.error('[whatsapp] webhook', err);
  }
  res.sendStatus(200);
});
