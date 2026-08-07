import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';

export class MontoPagoInvalidoError extends Error {}

export class PagoYaCanceladoError extends Error {
  constructor() {
    super('Este pago ya estaba cancelado.');
  }
}

export class AutorizacionCancelacionPagoInvalidaError extends Error {
  constructor() {
    super('Cancelar un pago de un dia anterior necesita autorizacion por telefono y PIN.');
  }
}

function esMismoDia(fecha: Date, referencia: Date) {
  return (
    fecha.getFullYear() === referencia.getFullYear() &&
    fecha.getMonth() === referencia.getMonth() &&
    fecha.getDate() === referencia.getDate()
  );
}

/**
 * Nivel 1 de Cartera: un renglon por cada cliente que alguna vez tuvo una
 * venta a credito, con su saldo total (suma de saldoPendiente de todas
 * sus notas a credito). El total general de cartera se calcula en el
 * frontend sumando estos saldoTotal.
 */
export async function resumenCarteraClientes() {
  const clientes = await prisma.cliente.findMany({
    where: {
      OR: [{ ventas: { some: { esCredito: true } } }, { saldoInicial: { gt: 0 } }],
    },
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
      saldoInicial: Number(c.saldoInicial),
      saldoTotal: c.ventas.reduce((acc, v) => acc + Number(v.saldoPendiente), 0) + Number(c.saldoInicial),
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
    cancelado: p.cancelado,
    canceladoEn: p.canceladoEn,
    registradoPor: { nombre: p.registradoPor?.nombre ?? 'Registro anterior' },
  }));
}

/**
 * Aplica un abono a una venta a credito DENTRO de una transaccion ya
 * abierta por el llamador (para poder reutilizar esta logica tanto para
 * un pago a una sola nota como para un pago repartido entre varias).
 *
 * Reparte el monto entre las lineas (VentaItem) que aun tengan saldo
 * pendiente, proporcional a lo que le falta a CADA una -- no al subtotal
 * original de la linea, sino a subtotal menos lo ya asignado en pagos
 * anteriores. Esto es lo que permite que calcularUtilidadVenta() siga
 * siendo exacto por producto incluso con varios abonos parciales en
 * momentos distintos.
 */
async function aplicarPagoVenta(
  tx: Prisma.TransactionClient,
  ventaId: string,
  monto: number,
  metodoPago: string,
  registradoPorId: string,
  clienteIdEsperado?: string
) {
  if (!monto || monto <= 0) {
    throw new MontoPagoInvalidoError('El monto del pago debe ser mayor a cero');
  }

  const venta = await tx.venta.findUniqueOrThrow({
    where: { id: ventaId },
    include: { items: { include: { pagoAsignaciones: true } } },
  });

  if (clienteIdEsperado && venta.clienteId !== clienteIdEsperado) {
    throw new MontoPagoInvalidoError(`La venta #${venta.folio} no pertenece a este cliente`);
  }

  const saldoActual = Number(venta.saldoPendiente);
  if (monto > saldoActual) {
    throw new MontoPagoInvalidoError(
      `El pago de $${monto.toFixed(2)} para la venta #${venta.folio} es mayor a su saldo pendiente de $${saldoActual.toFixed(2)}`
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

  if (metodoPago === 'transferencia') {
    await tx.configuracion.upsert({
      where: { id: 'singleton' },
      update: { saldoBancoActual: { increment: monto } },
      create: { id: 'singleton', saldoBancoActual: monto },
    });
  } else if (metodoPago === 'efectivo') {
    await tx.configuracion.upsert({
      where: { id: 'singleton' },
      update: { saldoEfectivoActual: { increment: monto } },
      create: { id: 'singleton', saldoEfectivoActual: monto },
    });
  }

  return { pago, venta, saldoNotaRestante: Math.max(nuevoSaldo, 0) };
}

async function calcularSaldoTotalCliente(tx: Prisma.TransactionClient, clienteId: string) {
  const [ventasCliente, cliente] = await Promise.all([
    tx.venta.aggregate({
      where: { clienteId, esCredito: true, cancelada: false },
      _sum: { saldoPendiente: true },
    }),
    tx.cliente.findUniqueOrThrow({ where: { id: clienteId } }),
  ]);
  return Number(ventasCliente._sum.saldoPendiente ?? 0) + Number(cliente.saldoInicial);
}

/** Registra un abono a una sola venta a credito. */
export async function registrarPagoVenta(
  ventaId: string,
  monto: number,
  metodoPago: string,
  registradoPorId: string
) {
  return prisma.$transaction(async (tx) => {
    const { pago, venta, saldoNotaRestante } = await aplicarPagoVenta(tx, ventaId, monto, metodoPago, registradoPorId);
    const saldoTotalCliente = await calcularSaldoTotalCliente(tx, venta.clienteId);
    return { pago, saldoTotalCliente, saldoNotaRestante };
  });
}

export interface AsignacionPagoMultiple {
  ventaId: string;
  monto: number;
}

/**
 * Registra UN pago que un cliente entrega y que se reparte entre varias
 * de sus notas a credito, con el monto especifico que se le asigna a
 * cada una (ej. el cliente da $10,000 y se asignan $3,000 a tres notas y
 * $1,000 a otra). Cada asignacion se procesa con la misma logica de
 * prorrateo por linea que un abono individual, todo en una sola
 * transaccion para que quede todo o nada.
 */
export async function registrarPagoMultiNota(
  clienteId: string,
  asignaciones: AsignacionPagoMultiple[],
  metodoPago: string,
  registradoPorId: string
) {
  const asignacionesValidas = asignaciones.filter((a) => a.monto > 0);
  if (asignacionesValidas.length === 0) {
    throw new MontoPagoInvalidoError('Debes asignar un monto mayor a cero a al menos una nota');
  }

  return prisma.$transaction(async (tx) => {
    const detalle: { ventaId: string; folio: number; monto: number; saldoNotaRestante: number }[] = [];
    let totalPagado = 0;

    for (const asignacion of asignacionesValidas) {
      const { venta, saldoNotaRestante } = await aplicarPagoVenta(
        tx,
        asignacion.ventaId,
        asignacion.monto,
        metodoPago,
        registradoPorId,
        clienteId
      );
      totalPagado += asignacion.monto;
      detalle.push({ ventaId: asignacion.ventaId, folio: venta.folio, monto: asignacion.monto, saldoNotaRestante });
    }

    const saldoTotalCliente = await calcularSaldoTotalCliente(tx, clienteId);

    return { detalle, totalPagado, saldoTotalCliente };
  });
}

/**
 * Cancela un pago/abono ya registrado a una nota (por ejemplo, si se
 * capturo mal el monto o el metodo). No se borra -- queda marcado como
 * cancelado, para poder auditar despues. Revierte todo lo que ese pago
 * habia movido: sube de nuevo el saldoPendiente de la venta, recalcula su
 * estadoPago, y baja el saldo de efectivo/banco que se le habia sumado.
 *
 * Las PagoAsignacion de este pago (el reparto proporcional entre lineas
 * que usa calcularUtilidadVenta) se borran -- son solo un artefacto
 * interno para esa cuenta, no un registro que el usuario vea, y ya no
 * aplican una vez cancelado el pago.
 *
 * Si el pago es de un dia distinto al de hoy, cancelarlo requiere
 * autorizacion por telefono+PIN de un administrador, igual que con
 * ventas, compras, gastos y depositos.
 */
export async function cancelarPagoVenta(
  pagoId: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const pagoActual = await prisma.pagoVenta.findUniqueOrThrow({
    where: { id: pagoId },
    include: { venta: true },
  });

  if (pagoActual.cancelado) {
    throw new PagoYaCanceladoError();
  }

  let autorizadoPorId: string | null = null;
  if (!esMismoDia(pagoActual.fecha, new Date())) {
    if (!autorizacion) throw new AutorizacionCancelacionPagoInvalidaError();
    autorizadoPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadoPorId) throw new AutorizacionCancelacionPagoInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    const monto = Number(pagoActual.monto);
    const total = Number(pagoActual.venta.total);

    await tx.pagoAsignacion.deleteMany({ where: { pagoId } });

    const nuevoSaldo = Math.min(Number(pagoActual.venta.saldoPendiente) + monto, total);

    await tx.venta.update({
      where: { id: pagoActual.ventaId },
      data: {
        saldoPendiente: nuevoSaldo,
        estadoPago: nuevoSaldo >= total ? 'pendiente' : nuevoSaldo > 0 ? 'parcial' : 'pagada',
      },
    });

    if (pagoActual.metodoPago === 'transferencia') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { decrement: monto } },
        create: { id: 'singleton', saldoBancoActual: -monto },
      });
    } else if (pagoActual.metodoPago === 'efectivo') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { decrement: monto } },
        create: { id: 'singleton', saldoEfectivoActual: -monto },
      });
    }

    const pagoCancelado = await tx.pagoVenta.update({
      where: { id: pagoId },
      data: {
        cancelado: true,
        canceladoEn: new Date(),
        canceladoPorId: solicitadoPorId,
        autorizadoPorId,
      },
      include: { registradoPor: true },
    });

    return {
      id: pagoCancelado.id,
      monto: Number(pagoCancelado.monto),
      metodoPago: pagoCancelado.metodoPago,
      fecha: pagoCancelado.fecha,
      cancelado: pagoCancelado.cancelado,
      canceladoEn: pagoCancelado.canceladoEn,
      registradoPor: { nombre: pagoCancelado.registradoPor?.nombre ?? 'Registro anterior' },
      saldoNotaRestante: nuevoSaldo,
    };
  });
}
