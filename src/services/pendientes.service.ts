import { prisma } from '../prisma';

function normalizarFecha(fecha: Date) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
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
export async function listarPendientesDeHoy() {
  const hoy = normalizarFecha(new Date());
  return prisma.pendiente.findMany({
    where: { fecha: hoy },
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
