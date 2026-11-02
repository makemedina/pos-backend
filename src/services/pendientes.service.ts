import { prisma } from '../prisma';

// Un pendiente es de "un dia", no de una hora: se guarda como medianoche
// UTC de ese dia calendario para que no dependa de la zona horaria del
// servidor (Railway corre en UTC) ni del navegador (Culiacan es UTC-7).
// Antes se guardaba como medianoche local del servidor y el frontend lo
// mostraba un dia antes ("lo programo para manana y sale hoy").
function normalizarFecha(fecha: Date) {
  return new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
}

const UN_DIA_MS = 24 * 60 * 60 * 1000;

function hoyEnCuliacan() {
  // en-CA da el formato YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date());
}

const INCLUIR_CLIENTE = { registradoPor: true, cliente: true } as const;

/**
 * Todos los pendientes, mas recientes primero por fecha programada.
 * Por default no trae los ya hechos (para no saturar la lista); con
 * incluirHechos=true se usa para el historial.
 */
export async function listarPendientes(incluirHechos = false) {
  return prisma.pendiente.findMany({
    where: incluirHechos ? {} : { hecho: false },
    include: INCLUIR_CLIENTE,
    orderBy: { fecha: 'asc' },
  });
}

/** Los pendientes programados para hoy -- se muestran junto a "Llamadas de hoy". */
export async function listarPendientesDeHoy(hoyStr?: string) {
  const [anio, mes, dia] = (hoyStr && /^\d{4}-\d{2}-\d{2}$/.test(hoyStr) ? hoyStr : hoyEnCuliacan())
    .split('-')
    .map(Number);
  const inicio = new Date(Date.UTC(anio, mes - 1, dia));
  // Rango de todo el dia (y no igualdad exacta) para que tambien entren
  // los pendientes guardados con el formato anterior.
  return prisma.pendiente.findMany({
    where: { fecha: { gte: inicio, lt: new Date(inicio.getTime() + UN_DIA_MS) } },
    include: INCLUIR_CLIENTE,
    orderBy: { creadoEn: 'asc' },
  });
}

export async function crearPendiente(
  concepto: string,
  fecha: Date,
  registradoPorId: string,
  notas?: string,
  clienteId?: string
) {
  return prisma.pendiente.create({
    data: {
      concepto,
      fecha: normalizarFecha(fecha),
      registradoPorId,
      notas: notas || null,
      clienteId: clienteId || null,
    },
    include: INCLUIR_CLIENTE,
  });
}

export async function actualizarPendiente(
  id: string,
  datos: { hecho?: boolean; concepto?: string; fecha?: Date; notas?: string; clienteId?: string | null }
) {
  return prisma.pendiente.update({
    where: { id },
    data: {
      ...(datos.hecho !== undefined ? { hecho: datos.hecho } : {}),
      ...(datos.concepto !== undefined ? { concepto: datos.concepto } : {}),
      ...(datos.fecha !== undefined ? { fecha: normalizarFecha(datos.fecha) } : {}),
      ...(datos.notas !== undefined ? { notas: datos.notas } : {}),
      ...(datos.clienteId !== undefined ? { clienteId: datos.clienteId } : {}),
    },
    include: INCLUIR_CLIENTE,
  });
}

export async function eliminarPendiente(id: string) {
  await prisma.pendiente.delete({ where: { id } });
}
