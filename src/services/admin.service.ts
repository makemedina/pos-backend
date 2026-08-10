import { prisma } from '../prisma';

export class ConfirmacionInvalidaError extends Error {
  constructor() {
    super('Escribe exactamente "BORRAR TODO" para confirmar. No se hizo ningun cambio.');
  }
}

export class DependenciaResetInvalidaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
  }
}

export interface OpcionesReset {
  // Ventas + Compras + Ajustes de inventario van SIEMPRE juntos: los tres
  // tocan LoteInventario, y separarlos dejaria el stock en un estado que
  // no corresponde a ningun historial real (ej. borrar solo Compras
  // dejaria ventas apuntando a lotes que ya no existen).
  ventasComprasAjustes: boolean;
  cotizaciones: boolean;
  gastos: boolean;
  depositos: boolean;
  cortes: boolean;
  // Clientes, proveedores, productos/variantes/categorias. Solo se puede
  // pedir junto con ventasComprasAjustes + cotizaciones + gastos, porque
  // esas tablas son las que tienen una llave foranea hacia clientes/
  // proveedores/productos -- si se dejaran esos registros vivos,
  // Postgres rechazaria el borrado de todos modos.
  catalogos: boolean;
  // Ademas de borrar las filas, reinicia el contador de folio de
  // Venta/Cotizacion a 1 (si esa categoria tambien se esta borrando) --
  // sin esto, la siguiente venta seguiria numerandose desde donde iba,
  // no desde 1, aunque ya no quede ningun registro viejo.
  reiniciarNumeracion: boolean;
}

/**
 * Borra datos reales del sistema en bloque, para poder arrancar la
 * operacion desde cero (o corregir una carga de prueba) sin tener que
 * borrar registro por registro. Es DEFINITIVO -- por eso exige la misma
 * palabra de confirmacion escrita a mano que ya se usaba, y por eso el
 * caller (routes/index.ts) crea automaticamente un respaldo completo
 * justo antes de ejecutar esto (ver backup.service.ts).
 */
export async function ejecutarReset(confirmacion: string, opciones: OpcionesReset) {
  if (confirmacion !== 'BORRAR TODO') {
    throw new ConfirmacionInvalidaError();
  }

  if (
    opciones.catalogos &&
    !(opciones.ventasComprasAjustes && opciones.cotizaciones && opciones.gastos)
  ) {
    throw new DependenciaResetInvalidaError(
      'Para borrar clientes, proveedores y productos también hay que borrar ' +
        'ventas/compras/ajustes, cotizaciones y gastos -- todos hacen referencia a ellos.'
    );
  }

  await prisma.$transaction(async (tx) => {
    // Se borra en este orden porque cada tabla depende de la anterior
    // (una llave foranea no permite borrar el "padre" antes que el "hijo").
    if (opciones.ventasComprasAjustes || opciones.cotizaciones) {
      await tx.pagoAsignacion.deleteMany({});
      await tx.pagoVenta.deleteMany({});
    }
    if (opciones.cotizaciones) {
      await tx.cotizacionItem.deleteMany({});
      await tx.cotizacion.deleteMany({});
    }
    if (opciones.ventasComprasAjustes) {
      await tx.ajusteInventario.deleteMany({});
      await tx.ventaItem.deleteMany({});
      await tx.pagoCompra.deleteMany({});
      await tx.loteInventario.deleteMany({});
      await tx.venta.deleteMany({});
      await tx.compra.deleteMany({});
    }
    if (opciones.gastos) {
      await tx.gasto.deleteMany({});
    }
    if (opciones.depositos) {
      await tx.depositoBanco.deleteMany({});
    }
    if (opciones.cortes) {
      await tx.corteCaja.deleteMany({});
    }
    if (opciones.catalogos) {
      await tx.variante.deleteMany({});
      await tx.producto.deleteMany({});
      await tx.categoria.deleteMany({});
      await tx.categoriaGasto.deleteMany({});
      await tx.cliente.deleteMany({});
      await tx.proveedor.deleteMany({});
    }

    // El saldo de efectivo/banco que lleva el sistema solo se puede
    // reiniciar a 0 con confianza si se borro TODO lo que pudo haberlo
    // movido -- si solo se borra una parte (ej. nada mas gastos), el
    // saldo que queda ya no cuadra con el historial restante, pero
    // tampoco hay forma de recalcularlo sin ese historial borrado. Queda
    // como esta y se avisa en el frontend para que se corrija a mano en
    // Configuracion si hace falta.
    if (opciones.ventasComprasAjustes && opciones.gastos && opciones.depositos) {
      await tx.configuracion.updateMany({
        data: { saldoEfectivoActual: 0, saldoBancoActual: 0 },
      });
    }

    if (opciones.reiniciarNumeracion) {
      if (opciones.ventasComprasAjustes) {
        await tx.$executeRawUnsafe('ALTER SEQUENCE "Venta_folio_seq" RESTART WITH 1');
      }
      if (opciones.cotizaciones) {
        await tx.$executeRawUnsafe('ALTER SEQUENCE "Cotizacion_folio_seq" RESTART WITH 1');
      }
    }
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
export async function cargarInventarioInicial(filas: FilaInventarioInicial[], fecha?: Date) {
  const fechaCarga = fecha ?? (() => {
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    return ayer;
  })();

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
        fecha: fechaCarga,
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
          fechaIngreso: fechaCarga,
        },
      });

      resultado.push({ producto: fila.producto, marca: fila.marca, stock: fila.stock });
    }

    return { compraId: compraAncla.id, items: resultado };
  });
}
