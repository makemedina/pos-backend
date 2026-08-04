import { prisma } from '../prisma';

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