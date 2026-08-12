import { prisma } from '../prisma';

/**
 * Lista los costos de referencia que un proveedor tiene registrados para
 * sus productos -- es informativo (para comparar entre proveedores al
 * comprar), no afecta el costo real de inventario.
 */
export async function listarCostosProveedor(proveedorId: string) {
  const registros = await prisma.costoProveedorProducto.findMany({
    where: { proveedorId },
    include: { variante: { include: { producto: true } } },
    orderBy: { variante: { producto: { nombre: 'asc' } } },
  });

  return registros.map((r) => ({
    varianteId: r.varianteId,
    producto: r.variante.producto.nombre,
    marca: r.variante.marca,
    costo: Number(r.costo),
    actualizadoEn: r.actualizadoEn,
  }));
}

export async function guardarCostoProveedor(proveedorId: string, varianteId: string, costo: number) {
  const r = await prisma.costoProveedorProducto.upsert({
    where: { proveedorId_varianteId: { proveedorId, varianteId } },
    update: { costo },
    create: { proveedorId, varianteId, costo },
    include: { variante: { include: { producto: true } } },
  });

  return {
    varianteId: r.varianteId,
    producto: r.variante.producto.nombre,
    marca: r.variante.marca,
    costo: Number(r.costo),
    actualizadoEn: r.actualizadoEn,
  };
}

export async function eliminarCostoProveedor(proveedorId: string, varianteId: string) {
  await prisma.costoProveedorProducto.delete({
    where: { proveedorId_varianteId: { proveedorId, varianteId } },
  });
}
