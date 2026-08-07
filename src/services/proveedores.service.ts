import { prisma } from '../prisma';

export class ProveedorConInformacionLigadaError extends Error {
  constructor(compras: number, gastos: number) {
    const partes: string[] = [];
    if (compras > 0) partes.push(`${compras} compra${compras === 1 ? '' : 's'}`);
    if (gastos > 0) partes.push(`${gastos} gasto${gastos === 1 ? '' : 's'}`);
    super(
      `Este proveedor tiene ${partes.join(' y ')} registrado(s) y no se puede eliminar. ` +
        'Si ya no lo usas, puedes dejarlo así o cambiarle el nombre.'
    );
  }
}

export async function buscarProveedores(query: string) {
  if (!query || query.length < 2) return prisma.proveedor.findMany({ take: 10 });

  return prisma.proveedor.findMany({
    where: { nombre: { contains: query, mode: 'insensitive' } },
    take: 10,
    orderBy: { nombre: 'asc' },
  });
}

export async function crearProveedorRapido(nombre: string, telefono?: string) {
  return prisma.proveedor.create({
    data: { nombre, telefono },
  });
}

/** Alta masiva: crea un proveedor por cada nombre de la lista, sin telefono. */
export async function importarProveedores(nombres: string[]) {
  const nombresLimpios = nombres.map((n) => n.trim()).filter((n) => n.length > 0);

  const creados = await prisma.$transaction(
    nombresLimpios.map((nombre) => prisma.proveedor.create({ data: { nombre } }))
  );

  return { creados: creados.length };
}

/** Lista TODOS los proveedores, para la pantalla de gestion (alta/edicion). */
export async function listarProveedores() {
  return prisma.proveedor.findMany({ orderBy: { nombre: 'asc' } });
}

export async function actualizarProveedor(
  id: string,
  datos: { nombre?: string; telefono?: string | null }
) {
  return prisma.proveedor.update({ where: { id }, data: datos });
}

/**
 * Elimina un proveedor DE VERDAD (a diferencia de "cancelar", que solo
 * marca un registro). Solo se permite si no tiene compras ni gastos
 * registrados -- si los tiene, se advierte en vez de borrarlo (borrarlo
 * de todos modos dejaria huerfanas esas compras/gastos).
 */
export async function eliminarProveedor(id: string) {
  const [compras, gastos] = await Promise.all([
    prisma.compra.count({ where: { proveedorId: id } }),
    prisma.gasto.count({ where: { proveedorId: id } }),
  ]);

  if (compras > 0 || gastos > 0) {
    throw new ProveedorConInformacionLigadaError(compras, gastos);
  }

  await prisma.proveedor.delete({ where: { id } });
}