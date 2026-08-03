import { prisma } from '../prisma';

export class MontoPagoInvalidoError extends Error {}

/**
 * Nivel 1 de Cartera: un renglon por cada cliente que alguna vez tuvo una
 * venta a credito, con su saldo total (suma de saldoPendiente de todas
 * sus notas a credito). El total general de cartera se calcula en el
 * frontend sumando estos saldoTotal.
 */
export async function resumenCarteraClientes() {
  const clientes = await prisma.cliente.findMany({
    where: { ventas: { some: { esCredito: true } } },
    include: {
      ventas: { where: { esCredito: true }, select: { saldoPendiente: true } },
    },
    orderBy: { nombre: 'asc' },
  });

  return clientes
    .map((c) => ({
      id: c.id,
      nombre: c.nombre,
      telefono: c.telefono,
      saldoTotal: c.ventas.reduce((acc, v) => acc + Number(v.saldoPendiente), 0),
      notasConSaldo: c.ventas.filter((v) => Number(v.saldoPendiente) > 0).length,
    }))
    .sort((a, b) => b.saldoTotal - a.saldoTotal);
}

/**
 * Nivel 2 de Cartera: las notas (ventas a credito) de un cliente en
 * particular. Por default solo las que tienen saldo pendiente; con
 * incluirPagadas=true se agregan tambien las que ya se liquidaron.
 */
export async function notasClienteCredito(clienteId: string, incluirPagadas: boolean) {
  const notas = await prisma.venta.findMany({
    where: {
      clienteId,
      esCredito: true,
      ...(incluirPagadas ? {} : { saldoPendiente: { gt: 0 } }),
    },
    orderBy: { fecha: 'desc' },
  });

  return notas.map((n) => ({
    id: n.id,
    folio: n.folio,
    fecha: n.fecha,
    total: Number(n.total),
    saldoPendiente: Number(n.saldoPendiente),
    estadoPago: n.estadoPago,
  }));
}

/** Nivel 3 de Cartera: historial de pagos/abonos de una nota especifica. */
export async function pagosVenta(ventaId: string) {
  const pagos = await prisma.pagoVenta.findMany({
    where: { ventaId },
    include: { registradoPor: true },
    orderBy: { fecha: 'asc' },
  });

  return pagos.map((p) => ({
    id: p.id,
    monto: Number(p.monto),
    metodoPago: p.metodoPago,
    fecha: p.fecha,
    registradoPor: { nombre: p.registradoPor?.nombre ?? 'Registro anterior' },
  }));
}

/**
 * Registra un abono a una venta a credito. Reparte el monto entre las
 * lineas (VentaItem) que aun tengan saldo pendiente, proporcional a lo
 * que le falta a CADA una -- no al subtotal original de la linea, sino
 * a subtotal menos lo ya asignado en pagos anteriores. Esto es lo que
 * permite que calcularUtilidadVenta() siga siendo exacto por producto
 * incluso con varios abonos parciales en momentos distintos.
 *
 * Antes esta funcion solo bajaba el saldoPendiente global de la venta,
 * sin crear ningun PagoAsignacion -- por eso los abonos posteriores al
 * pago inicial no se reflejaban en la utilidad cobrada por producto.
 */
export async function registrarPagoVenta(
  ventaId: string,
  monto: number,
  metodoPago: string,
  registradoPorId: string
) {
  if (!monto || monto <= 0) {
    throw new MontoPagoInvalidoError('El monto del pago debe ser mayor a cero');
  }

  return prisma.$transaction(async (tx) => {
    const venta = await tx.venta.findUniqueOrThrow({
      where: { id: ventaId },
      include: { items: { include: { pagoAsignaciones: true } } },
    });

    const saldoActual = Number(venta.saldoPendiente);
    if (monto > saldoActual) {
      throw new MontoPagoInvalidoError(
        `El pago de $${monto.toFixed(2)} es mayor al saldo pendiente de $${saldoActual.toFixed(2)}`
      );
    }

    const restantePorItem = venta.items.map((item) => {
      const subtotal = Number(item.cantidad) * Number(item.precioUnitario);
      const asignado = item.pagoAsignaciones.reduce((acc, a) => acc + Number(a.montoAsignado), 0);
      return { itemId: item.id, restante: Math.max(subtotal - asignado, 0) };
    });

    const totalRestante = restantePorItem.reduce((acc, i) => acc + i.restante, 0);

    const pago = await tx.pagoVenta.create({
      data: { ventaId, monto, metodoPago, registradoPorId },
    });

    if (totalRestante > 0) {
      for (const item of restantePorItem) {
        if (item.restante <= 0) continue;
        const proporcion = item.restante / totalRestante;
        const montoAsignado = monto * proporcion;

        await tx.pagoAsignacion.create({
          data: {
            pagoId: pago.id,
            ventaItemId: item.itemId,
            montoAsignado,
          },
        });
      }
    }

    const nuevoSaldo = saldoActual - monto;

    await tx.venta.update({
      where: { id: ventaId },
      data: {
        saldoPendiente: Math.max(nuevoSaldo, 0),
        estadoPago: nuevoSaldo <= 0 ? 'pagada' : 'parcial',
      },
    });

    return pago;
  });
}
