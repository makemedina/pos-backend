import { prisma } from '../prisma';

export class ConfirmacionInvalidaError extends Error {
  constructor() {
    super('Escribe exactamente "BORRAR TODO" para confirmar. No se hizo ningun cambio.');
  }
}

/**
 * Borra TODAS las transacciones (ventas, compras, gastos, ajustes, pagos,
 * cortes de caja) para poder arrancar la operacion real desde cero, sin
 * datos de prueba. NO borra: usuarios, permisos, clientes, proveedores,
 * categorias de gasto, productos ni variantes (esos catalogos se
 * conservan; solo se limpia el historial de movimientos).
 *
 * Requiere escribir la palabra de confirmacion exacta para evitar un
 * click accidental que borre datos reales sin querer.
 */
export async function resetearTransacciones(confirmacion: string) {
  if (confirmacion !== 'BORRAR TODO') {
    throw new ConfirmacionInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    // Se borra en este orden porque cada tabla depende de la anterior
    // (una llave foranea no permite borrar el "padre" antes que el "hijo").
    await tx.pagoAsignacion.deleteMany({});
    await tx.pagoVenta.deleteMany({});
    await tx.ajusteInventario.deleteMany({});
    await tx.ventaItem.deleteMany({});
    await tx.pagoCompra.deleteMany({});
    await tx.loteInventario.deleteMany({});
    await tx.venta.deleteMany({});
    await tx.compra.deleteMany({});
    await tx.gasto.deleteMany({});
    await tx.corteCaja.deleteMany({});
  });
}

interface FilaInventarioInicial {
  producto: string;
  marca: string;
  costo: number;
  precio: number;
  stock: number;
}

/**
 * Carga el stock inicial real del negocio: por cada fila, da de alta el
 * producto y la variante (marca) si no existen, y crea un lote de
 * inventario con la cantidad y el costo indicados. Todos los lotes
 * quedan agrupados bajo UNA sola "compra" de anclaje llamada
 * "Inventario inicial", con estado ya pagado (no es una deuda real, solo
 * es el mecanismo que usa el sistema para poder tener lotes con costo).
 */
export async function cargarInventarioInicial(filas: FilaInventarioInicial[]) {
  return prisma.$transaction(async (tx) => {
    const proveedorInicial = await tx.proveedor.upsert({
      where: { id: 'inventario-inicial' },
      update: {},
      create: { id: 'inventario-inicial', nombre: 'Inventario inicial (carga manual)' },
    });

    const totalCompra = filas.reduce((acc, f) => acc + f.costo * f.stock, 0);

    const compraAncla = await tx.compra.create({
      data: {
        proveedorId: proveedorInicial.id,
        numeroFactura: 'INVENTARIO-INICIAL',
        total: totalCompra,
        saldoPendiente: 0,
        estadoPago: 'pagada',
        esCargaInicial: true,
      },
    });

    const resultado: { producto: string; marca: string; stock: number }[] = [];

    for (const fila of filas) {
      let producto = await tx.producto.findFirst({
        where: { nombre: { equals: fila.producto, mode: 'insensitive' } },
      });
      if (!producto) {
        producto = await tx.producto.create({ data: { nombre: fila.producto } });
      }

      const variante = await tx.variante.upsert({
        where: { productoId_marca: { productoId: producto.id, marca: fila.marca } },
        update: { precioVenta: fila.precio },
        create: {
          productoId: producto.id,
          marca: fila.marca,
          precioVenta: fila.precio,
          stockMinimo: 0,
        },
      });

      await tx.loteInventario.create({
        data: {
          varianteId: variante.id,
          compraId: compraAncla.id,
          costoUnitario: fila.costo,
          cantidadInicial: fila.stock,
          cantidadDisponible: fila.stock,
        },
      });

      resultado.push({ producto: fila.producto, marca: fila.marca, stock: fila.stock });
    }

    return { compraId: compraAncla.id, items: resultado };
  });
}
