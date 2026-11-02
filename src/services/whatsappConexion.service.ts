import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { prisma } from '../prisma';

// Conexion del numero de WhatsApp del negocio con la app de Meta, desde
// Configuracion > Conectar WhatsApp. El frontend abre el Embedded Signup de
// Meta en modo coexistencia (el numero sigue en la app de WhatsApp Business)
// y nos manda el codigo de autorizacion + los ids de la cuenta. Aqui:
//
//   1. se canjea el codigo por el token de la integracion,
//   2. se suscribe la app a la cuenta (sin esto no llegan los webhooks),
//   3. se piden los contactos y el historial de la app (solo se puede una
//      vez y dentro de 24 h; si falla, se reintenta desde la pantalla),
//   4. se obtiene el dataset de Meta de esa cuenta, para mandarle las
//      compras con el clic del anuncio (metaCapi.service).
//
// Necesita META_APP_ID, META_APP_SECRET y META_ES_CONFIG_ID (la
// configuracion de "Inicio de sesion con Facebook para empresas" de la app).

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const CONFIG_ID = process.env.META_ES_CONFIG_ID;
const API_VERSION = process.env.META_API_VERSION || 'v24.0';

export class WhatsappNoConfiguradoError extends Error {
  constructor() {
    super('Falta configurar META_APP_ID, META_APP_SECRET y META_ES_CONFIG_ID en el servidor.');
  }
}

export function datosParaConectar() {
  return APP_ID && APP_SECRET && CONFIG_ID ? { appId: APP_ID, configId: CONFIG_ID, apiVersion: API_VERSION } : null;
}

// ---------- token cifrado ----------

function llave(): Buffer {
  return createHash('sha256').update(`conexion-whatsapp:${APP_SECRET}`).digest();
}

function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', llave(), iv);
  const datos = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), datos].map((b) => b.toString('base64')).join('.');
}

function descifrar(guardado: string): string {
  const [iv, tag, datos] = guardado.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', llave(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(datos), decipher.final()]).toString('utf8');
}

// ---------- Graph API ----------

async function graph(metodo: 'GET' | 'POST', ruta: string, token: string, cuerpo?: object) {
  const respuesta = await fetch(`https://graph.facebook.com/${API_VERSION}/${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const datos: any = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw new Error(`${ruta}: ${datos?.error?.message ?? respuesta.status}`);
  }
  return datos;
}

async function canjearCodigo(codigo: string): Promise<string> {
  const params = new URLSearchParams({ client_id: APP_ID!, client_secret: APP_SECRET!, code: codigo });
  const respuesta = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const datos: any = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok || !datos.access_token) {
    throw new Error(`Meta no acepto el codigo de autorizacion: ${datos?.error?.message ?? respuesta.status}`);
  }
  return datos.access_token;
}

/** Contactos y despues historial. Error 135000 = ya se habia sincronizado: cuenta como hecho. */
async function sincronizarApp(phoneNumberId: string, token: string) {
  for (const tipo of ['smb_app_state_sync', 'history']) {
    try {
      await graph('POST', `${phoneNumberId}/smb_app_data`, token, { messaging_product: 'whatsapp', sync_type: tipo });
    } catch (err) {
      if (!String((err as Error).message).includes('135000')) throw err;
    }
  }
}

/** El dataset de la cuenta; Meta solo permite uno por cuenta y lo crea si no existe. */
async function datasetDeLaCuenta(wabaId: string, token: string): Promise<string | null> {
  const existente = await graph('GET', `${wabaId}/dataset`, token);
  const id = existente?.data?.[0]?.dataset_id ?? existente?.data?.[0]?.id ?? existente?.id;
  if (id) return String(id);
  const creado = await graph('POST', `${wabaId}/dataset`, token);
  return creado?.id ? String(creado.id) : null;
}

/**
 * La ventana de Meta no siempre avisa los ids de la cuenta (en coexistencia
 * a veces solo llega el codigo). Si faltan, se sacan del token: la cuenta
 * que el usuario autorizo y su numero.
 */
async function cuentaDelToken(token: string, wabaId?: string, phoneNumberId?: string) {
  if (!wabaId) {
    const params = new URLSearchParams({ input_token: token, access_token: `${APP_ID}|${APP_SECRET}` });
    const respuesta = await fetch(`https://graph.facebook.com/${API_VERSION}/debug_token?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const datos: any = await respuesta.json().catch(() => ({}));
    const alcances: any[] = datos?.data?.granular_scopes ?? [];
    wabaId = alcances.find((a) => a.scope === 'whatsapp_business_management')?.target_ids?.[0];
    if (!wabaId) {
      // Solo nombres de permisos e ids de cuentas (nada secreto), para diagnosticar.
      console.error('[whatsapp] token sin cuenta de WhatsApp; permisos:', JSON.stringify(alcances), datos?.data?.is_valid);
      throw new Error(
        'Meta no autorizó ninguna cuenta de WhatsApp. Asegúrate de terminar todo en la ventana de Meta (hasta escanear el código con el celular) antes de que se cierre.',
      );
    }
  }
  if (!phoneNumberId) {
    const numeros = await graph('GET', `${wabaId}/phone_numbers?fields=id,display_phone_number`, token);
    phoneNumberId = numeros?.data?.[0]?.id;
    if (!phoneNumberId) throw new Error('La cuenta de WhatsApp autorizada no tiene numero.');
  }
  return { wabaId: String(wabaId), phoneNumberId: String(phoneNumberId) };
}

// ---------- operaciones ----------

export async function conectarWhatsapp(codigo: string, wabaIdVentana?: string, phoneNumberIdVentana?: string) {
  if (!datosParaConectar()) throw new WhatsappNoConfiguradoError();
  const token = await canjearCodigo(codigo);
  const { wabaId, phoneNumberId } = await cuentaDelToken(token, wabaIdVentana, phoneNumberIdVentana);
  await graph('POST', `${wabaId}/subscribed_apps`, token);

  await prisma.conexionWhatsapp.upsert({
    where: { id: 'principal' },
    update: { wabaId, phoneNumberId, tokenCifrado: cifrar(token), conectadoEn: new Date(), sincronizadoEn: null, datasetId: null, ultimoError: null },
    create: { wabaId, phoneNumberId, tokenCifrado: cifrar(token) },
  });
  cacheConexion = null;

  // Lo que sigue puede fallar sin perder la conexion: queda en ultimoError
  // y se reintenta desde la pantalla.
  return completarConexion();
}

/** Sincroniza (si falta) y obtiene el dataset (si falta). */
export async function completarConexion() {
  const conexion = await prisma.conexionWhatsapp.findUnique({ where: { id: 'principal' } });
  if (!conexion) return null;
  const token = descifrar(conexion.tokenCifrado);
  const errores: string[] = [];
  const cambios: { sincronizadoEn?: Date; datasetId?: string } = {};

  if (!conexion.sincronizadoEn) {
    try {
      await sincronizarApp(conexion.phoneNumberId, token);
      cambios.sincronizadoEn = new Date();
    } catch (err) {
      errores.push(`Sincronizacion: ${(err as Error).message}`);
    }
  }
  if (!conexion.datasetId) {
    try {
      const datasetId = await datasetDeLaCuenta(conexion.wabaId, token);
      if (datasetId) cambios.datasetId = datasetId;
    } catch (err) {
      errores.push(`Dataset: ${(err as Error).message}`);
    }
  }

  cacheConexion = null;
  return estadoConexion(
    await prisma.conexionWhatsapp.update({
      where: { id: 'principal' },
      data: { ...cambios, ultimoError: errores.length ? errores.join(' | ') : null },
    }),
  );
}

function estadoConexion(conexion: {
  wabaId: string;
  phoneNumberId: string;
  datasetId: string | null;
  conectadoEn: Date;
  sincronizadoEn: Date | null;
  ultimoError: string | null;
}) {
  const { wabaId, phoneNumberId, datasetId, conectadoEn, sincronizadoEn, ultimoError } = conexion;
  return { wabaId, phoneNumberId, datasetId, conectadoEn, sincronizadoEn, ultimoError };
}

export async function obtenerEstadoWhatsapp() {
  const conexion = await prisma.conexionWhatsapp.findUnique({ where: { id: 'principal' } });
  return { configurado: datosParaConectar(), conexion: conexion ? estadoConexion(conexion) : null };
}

// ---------- para metaCapi.service ----------

let cacheConexion: { wabaId: string; datasetId: string; token: string } | null = null;

/** Cuenta, dataset y token para mandar eventos con ctwa_clid; null si aun no esta lista. */
export async function conexionParaEventos() {
  if (cacheConexion) return cacheConexion;
  if (!APP_SECRET) return null;
  const conexion = await prisma.conexionWhatsapp.findUnique({ where: { id: 'principal' } });
  if (!conexion?.datasetId) return null;
  cacheConexion = { wabaId: conexion.wabaId, datasetId: conexion.datasetId, token: descifrar(conexion.tokenCifrado) };
  return cacheConexion;
}
