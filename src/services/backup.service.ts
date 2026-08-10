import { spawn } from 'child_process';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

// Respaldo completo de la base de datos (pg_dump en formato "custom",
// comprimido) subido a un bucket de Cloudflare R2 -- separado por
// completo de Railway, para que un respaldo siga a salvo aunque algo le
// pase al proyecto o a la base de datos misma. Se sube en streaming
// (pg_dump -> Upload de R2) sin pasar por disco, porque el sistema de
// archivos de Railway es efimero.

const PREFIJO = 'respaldos/';

export type TipoBackup = 'manual' | 'automatico' | 'pre-restauracion' | 'pre-reset';

export interface BackupInfo {
  key: string;
  fecha: string;
  tamano: number;
  tipo: TipoBackup;
}

export class BackupNoConfiguradoError extends Error {
  constructor(faltante: string) {
    super(
      `Los respaldos no están configurados: falta la variable de entorno ${faltante}. ` +
        'Revisa la configuración de Cloudflare R2 en Railway.'
    );
  }
}

function clienteR2(): S3Client {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID) throw new BackupNoConfiguradoError('R2_ACCOUNT_ID');
  if (!R2_ACCESS_KEY_ID) throw new BackupNoConfiguradoError('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) throw new BackupNoConfiguradoError('R2_SECRET_ACCESS_KEY');

  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

function nombreBucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new BackupNoConfiguradoError('R2_BUCKET_NAME');
  return bucket;
}

/**
 * Prisma agrega "?schema=xxx" al DATABASE_URL, un parametro que entiende
 * Prisma pero NO pg_dump/pg_restore (truena con "parametro de URI no
 * valido"). Se quita de la URL y se manda por separado con --schema.
 */
function requiereDatabaseUrl(): { url: string; schema: string } {
  const original = process.env.DATABASE_URL;
  if (!original) throw new Error('Falta la variable de entorno DATABASE_URL.');

  const url = new URL(original);
  const schema = url.searchParams.get('schema') || 'public';
  url.searchParams.delete('schema');
  return { url: url.toString(), schema };
}

function nombreArchivo(fecha: Date, tipo: TipoBackup): string {
  const iso = fecha.toISOString().replace(/[:.]/g, '-');
  return `${PREFIJO}${iso}_${tipo}.dump`;
}

function parsearNombre(key: string): { fecha: string; tipo: TipoBackup } {
  const base = key.slice(PREFIJO.length).replace(/\.dump$/, '');
  const idx = base.lastIndexOf('_');
  const fechaConGuiones = base.slice(0, idx);
  const tipo = (base.slice(idx + 1) as TipoBackup) || 'manual';
  // "2026-08-08T00-00-00-000Z" -> "2026-08-08T00:00:00.000Z"
  const fecha = fechaConGuiones.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z'
  );
  return { fecha, tipo };
}

/**
 * Corre pg_dump contra la base de datos y sube el resultado directo a R2
 * en streaming (sin escribirlo a disco). Tarda unos segundos para una
 * base de este tamaño.
 */
export async function crearBackup(tipo: TipoBackup): Promise<BackupInfo> {
  const { url: databaseUrl, schema } = requiereDatabaseUrl();
  const s3 = clienteR2();
  const bucket = nombreBucket();
  const fecha = new Date();
  const key = nombreArchivo(fecha, tipo);

  const proceso = spawn(
    'pg_dump',
    [databaseUrl, `--schema=${schema}`, '--format=custom', '--no-owner', '--no-privileges'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let salidaError = '';
  proceso.stderr.on('data', (chunk) => {
    salidaError += chunk.toString();
  });

  const subida = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: proceso.stdout },
  });

  const [, codigoSalida] = await Promise.all([
    subida.done(),
    new Promise<number>((resolve, reject) => {
      proceso.on('error', reject);
      proceso.on('close', (codigo) => resolve(codigo ?? 1));
    }),
  ]);

  if (codigoSalida !== 0) {
    // No dejar un archivo a medias/corrupto en el bucket.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    throw new Error(`pg_dump falló (código ${codigoSalida}): ${salidaError || 'sin detalle'}`);
  }

  const cabecera = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return { key, fecha: fecha.toISOString(), tamano: cabecera.ContentLength ?? 0, tipo };
}

/** Lista los respaldos disponibles en el bucket, mas reciente primero. */
export async function listarBackups(): Promise<BackupInfo[]> {
  const s3 = clienteR2();
  const bucket = nombreBucket();
  const resultado = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIJO }));
  const objetos = resultado.Contents ?? [];

  return objetos
    .filter((obj) => obj.Key)
    .map((obj) => {
      const { fecha, tipo } = parsearNombre(obj.Key!);
      return { key: obj.Key!, fecha, tamano: obj.Size ?? 0, tipo };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
}

/** Regresa el archivo del respaldo como stream, para mandarlo directo al navegador. */
export async function descargarBackup(key: string) {
  const s3 = clienteR2();
  const objeto = await s3.send(new GetObjectCommand({ Bucket: nombreBucket(), Key: key }));
  if (!objeto.Body) throw new Error('No se pudo leer el respaldo.');
  return objeto.Body as NodeJS.ReadableStream;
}

export async function eliminarBackup(key: string) {
  const s3 = clienteR2();
  await s3.send(new DeleteObjectCommand({ Bucket: nombreBucket(), Key: key }));
}

/**
 * Restaura la base de datos completa desde un respaldo -- BORRA todo lo
 * que haya actualmente y lo reemplaza con lo que traiga el respaldo
 * (pg_restore --clean --if-exists). Antes de tocar nada, guarda un
 * respaldo "pre-restauracion" con el estado justo antes de empezar, para
 * poder deshacerlo si se eligio el respaldo equivocado.
 */
export async function restaurarBackup(key: string): Promise<void> {
  const { url: databaseUrl } = requiereDatabaseUrl();

  await crearBackup('pre-restauracion');

  const cuerpo = await descargarBackup(key);

  const proceso = spawn(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', databaseUrl],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );

  let salidaError = '';
  proceso.stderr.on('data', (chunk) => {
    salidaError += chunk.toString();
  });

  cuerpo.pipe(proceso.stdin);

  const codigoSalida = await new Promise<number>((resolve, reject) => {
    proceso.on('error', reject);
    proceso.on('close', (codigo) => resolve(codigo ?? 1));
  });

  if (codigoSalida !== 0) {
    throw new Error(
      `La restauración falló a medio camino (código ${codigoSalida}): ${salidaError || 'sin detalle'}. ` +
        'La base de datos puede haber quedado en un estado mixto -- usa el respaldo "pre-restauracion" recien creado para regresar a como estaba.'
    );
  }
}
