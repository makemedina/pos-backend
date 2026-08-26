import { randomUUID } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { clienteR2, nombreBucket } from './backup.service';

// Subida/descarga de fotos (comprobantes de gasto, facturas de compra,
// etc.) al mismo bucket de R2 que ya usan los respaldos -- cada quien
// con su propio prefijo de key, para no mezclarlos.

const EXTENSION_POR_TIPO: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export class TipoFotoInvalidoError extends Error {
  constructor() {
    super('La foto debe ser una imagen (jpg, png, webp o heic).');
  }
}

/**
 * Sube una imagen a R2 bajo el prefijo indicado. Se sube ANTES de crear
 * el registro al que pertenece -- si la subida falla, no se crea un
 * registro sin su foto obligatoria.
 */
export async function subirImagenR2(buffer: Buffer, contentType: string, prefijo: string): Promise<string> {
  const extension = EXTENSION_POR_TIPO[contentType];
  if (!extension) throw new TipoFotoInvalidoError();

  const s3 = clienteR2();
  const key = `${prefijo}${randomUUID()}.${extension}`;
  const subida = new Upload({
    client: s3,
    params: { Bucket: nombreBucket(), Key: key, Body: buffer, ContentType: contentType },
  });
  await subida.done();
  return key;
}

/** Regresa la imagen como stream, para mandarla directo al navegador. */
export async function descargarImagenR2(key: string) {
  const s3 = clienteR2();
  const objeto = await s3.send(new GetObjectCommand({ Bucket: nombreBucket(), Key: key }));
  if (!objeto.Body) throw new Error('No se pudo leer la imagen.');
  return { cuerpo: objeto.Body as NodeJS.ReadableStream, contentType: objeto.ContentType };
}
