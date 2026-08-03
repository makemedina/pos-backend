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