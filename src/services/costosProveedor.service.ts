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

/**
 * El costo con el que se compro por ultima vez esta variante a este
 * proveedor (segun el historial real de Compras/LoteInventario) -- para
 * sugerirlo como punto de partida al agregar/actualizar su costo de
 * referencia, en vez de que el usuario tenga que acordarse o buscarlo por
 * separado en el historial de compras.
 */
export async function ultimoCostoCompra(proveedorId: string, varianteId: string) {
  const lote = await prisma.loteInventario.findFirst({
    where: { varianteId, compra: { proveedorId, cancelada: false } },
    orderBy: { compra: { fecha: 'desc' } },
    select: { costoUnitario: true, compra: { select: { fecha: true } } },
  });

  if (!lote) return null;
  return { costo: Number(lote.costoUnitario), fecha: lote.compra.fecha };
}
