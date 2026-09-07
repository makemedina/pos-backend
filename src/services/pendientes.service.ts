import { prisma } from '../prisma';

function normalizarFecha(fecha: Date) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
}

/**
 * Todos los pendientes, mas recientes primero por fecha programada.
 * Por default no trae los ya hechos (para no saturar la lista); con
 * incluirHechos=true se usa para el historial.
 */
export async function listarPendientes(incluirHechos = false) {
  return prisma.pendiente.findMany({
    where: incluirHechos ? {} : { hecho: false },
    include: { registradoPor: true },
    orderBy: { fecha: 'asc' },
  });
}

/** Los pendientes programados para hoy -- se muestran junto a "Llamadas de hoy". */
export async function listarPendientesDeHoy() {
  const hoy = normalizarFecha(new Date());
  return prisma.pendiente.findMany({
    where: { fecha: hoy },
    include: { registradoPor: true },
    orderBy: { creadoEn: 'asc' },
  });
}

export async function crearPendiente(
  concepto: string,
  fecha: Date,
  registradoPorId: string,
  notas?: string
) {
  return prisma.pendiente.create({
    data: {
      concepto,
      fecha: normalizarFecha(fecha),
      registradoPorId,
      notas: notas || null,
    },
  });
}

export async function actualizarPendiente(
  id: string,
  datos: { hecho?: boolean; concepto?: string; fecha?: Date; notas?: string }
) {
  return prisma.pendiente.update({
    where: { id },
    data: {
      ...(datos.hecho !== undefined ? { hecho: datos.hecho } : {}),
      ...(datos.concepto !== undefined ? { concepto: datos.concepto } : {}),
      ...(datos.fecha !== undefined ? { fecha: normalizarFecha(datos.fecha) } : {}),
      ...(datos.notas !== undefined ? { notas: datos.notas } : {}),
    },
  });
}

export async function eliminarPendiente(id: string) {
  await prisma.pendiente.delete({ where: { id } });
}
