import { createHash } from 'crypto';
import { prisma } from '../prisma';

// Conversions API (CAPI) de Meta: le avisa a Meta, desde el servidor, de
// las ventas y clientes nuevos que se registran en el POS. La venta se
// negocia por WhatsApp (los anuncios son de "clic a WhatsApp") y se
// registra aqui, asi que el Pixel del sitio web nunca la ve -- esta es la
// unica forma de que la IA de Meta aprenda quien SI compra.
//
// Meta cruza los datos del cliente (telefono, email, nombre, ciudad...)
// contra sus cuentas de Facebook/Instagram/WhatsApp. Esos datos se mandan
// SIEMPRE hasheados con SHA-256, nunca en texto plano.
//
// Sin META_DATASET_ID y META_CAPI_TOKEN no se manda nada (el resto de la
// app funciona igual). Con META_TEST_EVENT_CODE los eventos llegan solo a
// la pestana "Test Events" del Events Manager y no afectan las campanas.
//
// Los clientes nuevos se avisan al momento ("dispara y olvida": si Meta
// falla, el cliente ya quedo guardado y solo se registra el error). Las
// ventas, en cambio, se mandan con RETRASO_COMPRA_HORAS de retraso desde
// una tarea programada (enviarComprasPendientesAMeta): Meta no permite
// borrar una compra ya recibida, y casi todas las cancelaciones pasan en
// las primeras horas, asi que esperar evita reportarle ventas canceladas.

const DATASET_ID = process.env.META_DATASET_ID;
const TOKEN = process.env.META_CAPI_TOKEN;
const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || undefined;
const API_VERSION = process.env.META_API_VERSION || 'v24.0';

const metaConfigurado = !!(DATASET_ID && TOKEN);

// Meta rechaza eventos con mas de 7 dias de antiguedad.
const MAX_ANTIGUEDAD_SEG = 7 * 24 * 60 * 60;

// En los 90 dias previos a este cambio, el 97% de las ventas canceladas se
// cancelaron dentro de las primeras 6 horas.
const RETRASO_COMPRA_HORAS = 6;

function sha256(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

function sinAcentos(valor: string): string {
  return valor.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Telefono en el formato que pide Meta: solo digitos, con codigo de pais.
 * Los numeros del POS se capturan a 10 digitos (ej. "667 159 1730"), asi
 * que se les antepone el 52 de Mexico. Tambien acepta numeros que ya
 * traen 52, +52 o el viejo 521 de celulares.
 */
export function normalizarTelefono(telefono: string | null | undefined): string | null {
  if (!telefono) return null;
  const digitos = telefono.replace(/\D/g, '');
  if (digitos.length === 10) return `52${digitos}`;
  if (digitos.length === 12 && digitos.startsWith('52')) return digitos;
  if (digitos.length === 13 && digitos.startsWith('521')) return `52${digitos.slice(3)}`;
  return null; // formato desconocido -- mejor no mandar un telefono incorrecto
}

/** Nombres: minusculas, sin signos de puntuacion. */
function normalizarNombre(valor: string): string {
  return valor.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ');
}

/** Ciudad/estado: minusculas, sin acentos, sin espacios ni puntuacion (ej. "culiacan"). */
function normalizarLugar(valor: string): string {
  return sinAcentos(valor).toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface ClienteParaMeta {
  id: string;
  telefono: string | null;
  email: string | null;
  nombreContacto: string | null;
  ciudad: string | null;
  estado: string | null;
  codigoPostal: string | null;
  ciudadEntrega: string | null;
  estadoEntrega: string | null;
  codigoPostalEntrega: string | null;
}

/** Arma el bloque user_data con cada campo normalizado y hasheado. */
export function construirUserData(cliente: ClienteParaMeta) {
  const userData: Record<string, string[]> = {
    external_id: [sha256(cliente.id)],
    country: [sha256('mx')],
  };

  const telefono = normalizarTelefono(cliente.telefono);
  if (telefono) userData.ph = [sha256(telefono)];

  const email = cliente.email?.trim().toLowerCase();
  if (email) userData.em = [sha256(email)];

  // nombreContacto es la persona (el "nombre" del cliente es el negocio,
  // que no le sirve a Meta para encontrar a nadie).
  const nombreContacto = cliente.nombreContacto ? normalizarNombre(cliente.nombreContacto) : '';
  if (nombreContacto) {
    const [primerNombre, ...resto] = nombreContacto.split(' ');
    userData.fn = [sha256(primerNombre)];
    if (resto.length > 0) userData.ln = [sha256(resto.join(' '))];
  }

  // Se usa la direccion del negocio; si no la tiene, la de entrega.
  const ciudad = cliente.ciudad || cliente.ciudadEntrega;
  const estado = cliente.estado || cliente.estadoEntrega;
  const codigoPostal = (cliente.codigoPostal || cliente.codigoPostalEntrega)?.replace(/\D/g, '');
  if (ciudad && normalizarLugar(ciudad)) userData.ct = [sha256(normalizarLugar(ciudad))];
  if (estado && normalizarLugar(estado)) userData.st = [sha256(normalizarLugar(estado))];
  if (codigoPostal) userData.zp = [sha256(codigoPostal)];

  return userData;
}

interface EventoMeta {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: string;
  user_data: Record<string, string[]>;
  custom_data?: Record<string, unknown>;
}

async function enviarEventos(eventos: EventoMeta[]) {
  // El token va en el body (no en la URL) para que no quede en logs de proxies.
  const url = `https://graph.facebook.com/${API_VERSION}/${DATASET_ID}/events`;
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: eventos, test_event_code: TEST_EVENT_CODE, access_token: TOKEN }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!respuesta.ok) {
    throw new Error(`Meta CAPI respondio ${respuesta.status}: ${await respuesta.text()}`);
  }
}

function eventTimeValido(fecha: Date): number | null {
  const segundos = Math.floor(fecha.getTime() / 1000);
  if (Date.now() / 1000 - segundos > MAX_ANTIGUEDAD_SEG) return null;
  return segundos;
}

/**
 * Evento "Purchase" por una venta registrada. event_id = id de la venta,
 * para que Meta descarte duplicados si llegara a mandarse dos veces.
 * action_source "chat": la venta se cerro por WhatsApp. Las ventas
 * canceladas, en cero o demasiado viejas no se mandan.
 */
async function enviarCompra(ventaId: string) {
  const venta = await prisma.venta.findUnique({
    where: { id: ventaId },
    include: { cliente: true },
  });
  if (!venta || venta.cancelada || Number(venta.total) <= 0) return;

  const eventTime = eventTimeValido(venta.fecha);
  if (!eventTime) return;

  await enviarEventos([
    {
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: `venta-${venta.id}`,
      action_source: 'chat',
      user_data: construirUserData(venta.cliente),
      custom_data: {
        currency: 'MXN',
        value: Number(venta.total),
        order_id: String(venta.folio),
        // Como llego el cliente (anuncio, vendedor, ...) -- sirve para armar
        // conversiones personalizadas en Meta, ej. "Compra de cliente de anuncio".
        origen_cliente: venta.cliente.origen ?? 'sin_dato',
      },
    },
  ]);
}

/**
 * Evento "Lead" por un cliente nuevo, SOLO si llego por un anuncio. Los
 * que consiguio un vendedor o llegaron recomendados no se reportan: Meta
 * usaria esos Leads para buscar mas gente "parecida" como si fueran fruto
 * de sus anuncios, y ensuciarian su aprendizaje.
 */
async function enviarClienteNuevo(clienteId: string) {
  const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });
  if (!cliente || cliente.origen !== 'anuncio') return;

  const eventTime = eventTimeValido(cliente.fechaAlta);
  if (!eventTime) return;

  await enviarEventos([
    {
      event_name: 'Lead',
      event_time: eventTime,
      event_id: `cliente-${cliente.id}`,
      action_source: 'chat',
      user_data: construirUserData(cliente),
    },
  ]);
}

let enviandoCompras = false;

/**
 * Manda a Meta las ventas que ya cumplieron RETRASO_COMPRA_HORAS y que
 * nadie ha revisado (metaRevisadaEn null). Las que se cancelaron en ese
 * tiempo solo se marcan como revisadas, sin mandarse. Si Meta falla, la
 * venta se queda pendiente y se reintenta en la siguiente corrida (hasta
 * que cumpla los 7 dias que acepta Meta). Corre desde cron.ts.
 */
export async function enviarComprasPendientesAMeta() {
  if (!metaConfigurado || enviandoCompras) return { enviadas: 0, descartadas: 0 };
  enviandoCompras = true;
  try {
    const ahora = Date.now();
    const pendientes = await prisma.venta.findMany({
      where: {
        metaRevisadaEn: null,
        fecha: {
          lte: new Date(ahora - RETRASO_COMPRA_HORAS * 3600 * 1000),
          gte: new Date(ahora - MAX_ANTIGUEDAD_SEG * 1000),
        },
      },
      select: { id: true, cancelada: true },
      orderBy: { fecha: 'asc' },
    });

    let enviadas = 0;
    let descartadas = 0;
    for (const venta of pendientes) {
      try {
        if (venta.cancelada) {
          descartadas++;
        } else {
          await enviarCompra(venta.id);
          enviadas++;
        }
        await prisma.venta.update({ where: { id: venta.id }, data: { metaRevisadaEn: new Date() } });
      } catch (err) {
        console.error('[meta-capi] Purchase', venta.id, err);
      }
    }
    return { enviadas, descartadas };
  } finally {
    enviandoCompras = false;
  }
}

export function notificarClienteNuevoAMeta(clienteId: string) {
  if (!metaConfigurado) return;
  enviarClienteNuevo(clienteId).catch((err) => console.error('[meta-capi] Lead', clienteId, err));
}
