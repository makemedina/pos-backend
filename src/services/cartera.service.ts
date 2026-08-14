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

// Una nota cuenta para Cartera si es a credito, O si es de contado pero
// el cliente pago de mas y quedo con saldo a favor (saldoPendiente
// negativo) -- ese excedente tambien debe verse y restarse del resto de
// su cartera, aunque la venta en si nunca fue "a credito".
const NOTA_RELEVANTE_PARA_CARTERA = { OR: [{ esCredito: true }, { saldoPendiente: { lt: 0 } }] };

/**
 * Nivel 1 de Cartera: un renglon por cada cliente que alguna vez tuvo una
 * venta a credito (o quedo con saldo a favor de una venta de contado),
 * con su saldo total. El total general de cartera se calcula en el
 * frontend sumando estos saldoTotal.
 */
export async function resumenCarteraClientes() {
  const clientes = await prisma.cliente.findMany({
    where: {
      OR: [
        { ventas: { some: { cancelada: false, ...NOTA_RELEVANTE_PARA_CARTERA } } },
        { saldoInicial: { gt: 0 } },
      ],
    },
    include: {
      ventas: { where: { cancelada: false, ...NOTA_RELEVANTE_PARA_CARTERA }, select: { saldoPendiente: true } },
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
      cancelada: false,
      ...NOTA_RELEVANTE_PARA_CARTERA,
      // "not: 0" en vez de "gt: 0" porque un saldo negativo (a favor del
      // cliente por una venta de contado pagada de mas) tambien cuenta
      // como "con saldo pendiente de mostrar", no solo lo que debe.
      ...(incluirPagadas ? {} : { saldoPendiente: { not: 0 } }),
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

  // Bloquea la fila de la venta por el resto de esta transaccion. Sin
  // esto, dos abonos casi simultaneos a la MISMA nota (ej. el usuario le
  // dio doble click porque la pantalla se veia colgada) leen el mismo
  // saldoPendiente inicial y el segundo pisa el descuento del primero en
  // vez de sumarse -- el efectivo/banco de Configuracion queda bien
  // (usa increment atomico), pero el saldoPendiente de la nota queda mal.
  // El SELECT FOR UPDATE obliga a que la segunda transaccion espere a que
  // la primera termine, y entonces lea el saldo YA actualizado.
  await tx.$queryRaw`SELECT id FROM "Venta" WHERE id = ${ventaId} FOR UPDATE`;

  const venta = await tx.venta.findUniqueOrThrow({
    where: { id: ventaId },
    include: { items: { include: { pagoAsignaciones: true } } },
  });

  if (clienteIdEsperado && venta.clienteId !== clienteIdEsperado) {
    throw new MontoPagoInvalidoError(`La venta #${venta.folio} no pertenece a este cliente`);
  }

  // A diferencia de un pago a proveedor, aqui NO se limita el monto al
  // saldo pendiente: un cliente si puede pagar de mas y quedar con saldo
  // a favor (saldoPendiente negativo), que se resta del resto de su
  // cartera. El banco, en cambio, nunca puede quedar en negativo -- pero
  // esto es dinero ENTRANDO (increment), asi que esa regla no aplica aqui.
  const saldoActual = Number(venta.saldoPendiente);

  const restantePorItem = venta.items.map((item) => {
    const subtotal = Number(item.cantidad) * Number(item.precioUnitario);
    const asignado = item.pagoAsignaciones.reduce((acc, a) => acc + Number(a.montoAsignado), 0);
    return { itemId: item.id, restante: Math.max(subtotal - asignado, 0) };
  });

  const totalRestante = restantePorItem.reduce((acc, i) => acc + i.restante, 0);

  const pago = await tx.pagoVenta.create({
    data: { ventaId, monto, metodoPago, registradoPorId },
  });

  // Si el cliente paga de mas, el excedente no se reparte entre las
  // lineas (ya no les falta nada) -- solo se reparte hasta cubrir lo que
  // en verdad restaba, para que calcularUtilidadVenta() nunca calcule mas
  // del 100% cobrado por producto. El excedente queda reflejado nada mas
  // en el saldoPendiente negativo de la nota.
  const montoAAsignar = Math.min(monto, totalRestante);
  if (totalRestante > 0 && montoAAsignar > 0) {
    for (const item of restantePorItem) {
      if (item.restante <= 0) continue;
      const proporcion = item.restante / totalRestante;
      const montoAsignado = montoAAsignar * proporcion;

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
      saldoPendiente: nuevoSaldo,
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

  return { pago, venta, saldoNotaRestante: nuevoSaldo };
}

async function calcularSaldoTotalCliente(tx: Prisma.TransactionClient, clienteId: string) {
  const [ventasCliente, cliente] = await Promise.all([
    tx.venta.aggregate({
      where: { clienteId, cancelada: false, ...NOTA_RELEVANTE_PARA_CARTERA },
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

    // Mismo candado que aplicarPagoVenta: bloquea la fila y vuelve a leer
    // el saldoPendiente YA DENTRO de la transaccion, en vez de confiar en
    // el valor que se leyo antes de entrar aqui (pagoActual.venta), que
    // pudo quedar desactualizado si hubo otro pago/cancelacion a la misma
    // nota mientras tanto.
    await tx.$queryRaw`SELECT id FROM "Venta" WHERE id = ${pagoActual.ventaId} FOR UPDATE`;
    const ventaActual = await tx.venta.findUniqueOrThrow({ where: { id: pagoActual.ventaId } });

    await tx.pagoAsignacion.deleteMany({ where: { pagoId } });

    const nuevoSaldo = Math.min(Number(ventaActual.saldoPendiente) + monto, total);

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
