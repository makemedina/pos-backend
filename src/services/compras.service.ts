import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';

interface ItemCompraInput {
  varianteId: string;
  cantidad: number;   // kg
  costoUnitario: number; // $ por kg en ESTA compra
}

interface CrearCompraInput {
  proveedorId: string;
  numeroFactura?: string;
  fechaVencimiento?: Date;
  items: ItemCompraInput[];
  pagoInicial?: number;
  metodoPagoInicial?: string;
  registradoPorId?: string;
}

export class MontoPagoCompraInvalidoError extends Error {}

/**
 * Registra una compra a proveedor.
 * Por cada item, crea un LOTE_INVENTARIO nuevo e independiente (no se mezcla
 * con lotes anteriores de la misma variante, aunque el costo sea distinto).
 * Actualiza el saldo pendiente de la compra (cuenta por pagar).
 */
export async function crearCompra(input: CrearCompraInput) {
  const total = input.items.reduce(
    (acc, item) => acc + item.cantidad * item.costoUnitario,
    0
  );
  const pagoInicial = input.pagoInicial ?? 0;
  const saldoPendiente = total - pagoInicial;

  return prisma.$transaction(async (tx) => {
    const compra = await tx.compra.create({
      data: {
        proveedorId: input.proveedorId,
        numeroFactura: input.numeroFactura,
        fechaVencimiento: input.fechaVencimiento,
        total,
        saldoPendiente,
        estadoPago:
          saldoPendiente <= 0 ? 'pagada' : pagoInicial > 0 ? 'parcial' : 'pendiente',
      },
    });

    // Un lote nuevo por cada producto/variante comprado
    for (const item of input.items) {
      await tx.loteInventario.create({
        data: {
          varianteId: item.varianteId,
          compraId: compra.id,
          costoUnitario: item.costoUnitario,
          cantidadInicial: item.cantidad,
          cantidadDisponible: item.cantidad,
        },
      });
    }

    // Si hubo pago inicial, se registra como el primer abono
    if (pagoInicial > 0) {
      await tx.pagoCompra.create({
        data: {
          compraId: compra.id,
          monto: pagoInicial,
          metodoPago: input.metodoPagoInicial ?? 'efectivo',
          registradoPorId: input.registradoPorId,
        },
      });

      if ((input.metodoPagoInicial ?? 'efectivo') === 'transferencia') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoBancoActual: { decrement: pagoInicial } },
          create: { id: 'singleton', saldoBancoActual: -pagoInicial },
        });
      } else if ((input.metodoPagoInicial ?? 'efectivo') === 'efectivo') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoEfectivoActual: { decrement: pagoInicial } },
          create: { id: 'singleton', saldoEfectivoActual: -pagoInicial },
        });
      }
    }

    return compra;
  });
}

/**
 * Registra un pago (total o parcial) sobre una compra existente.
 * Recalcula saldo pendiente y estado de pago. Guarda quien lo registro
 * (tomado de la sesion, nunca del body) para el historial de abonos.
 */
export async function registrarPagoCompra(
  compraId: string,
  monto: number,
  metodoPago: string,
  registradoPorId: string
) {
  if (!monto || monto <= 0) {
    throw new MontoPagoCompraInvalidoError('El monto del pago debe ser mayor a cero');
  }

  return prisma.$transaction(async (tx) => {
    const compra = await tx.compra.findUniqueOrThrow({ where: { id: compraId } });

    const saldoActual = Number(compra.saldoPendiente);
    if (monto > saldoActual) {
      throw new MontoPagoCompraInvalidoError(
        `El pago de $${monto.toFixed(2)} es mayor al saldo pendiente de $${saldoActual.toFixed(2)}`
      );
    }

    await tx.pagoCompra.create({
      data: { compraId, monto, metodoPago, registradoPorId },
    });

    if (metodoPago === 'transferencia') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { decrement: monto } },
        create: { id: 'singleton', saldoBancoActual: -monto },
      });
    } else if (metodoPago === 'efectivo') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { decrement: monto } },
        create: { id: 'singleton', saldoEfectivoActual: -monto },
      });
    }

    const nuevoSaldo = saldoActual - monto;

    return tx.compra.update({
      where: { id: compraId },
      data: {
        saldoPendiente: nuevoSaldo,
        estadoPago: nuevoSaldo <= 0 ? 'pagada' : 'parcial',
      },
    });
  });
}

/** Historial de abonos de una compra especifica, con quien lo registro. */
export async function pagosCompra(compraId: string) {
  const pagos = await prisma.pagoCompra.findMany({
    where: { compraId },
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

/** Detalle completo de una compra especifica -- para cuando se hace click en una "entrada" del historial de un producto. */
export async function obtenerDetalleCompra(compraId: string) {
  const compra = await prisma.compra.findUniqueOrThrow({
    where: { id: compraId },
    include: {
      proveedor: true,
      pagos: true,
      lotes: { include: { variante: { include: { producto: true } } } },
    },
  });

  return {
    id: compra.id,
    numeroFactura: compra.numeroFactura,
    fecha: compra.fecha,
    fechaVencimiento: compra.fechaVencimiento,
    total: Number(compra.total),
    saldoPendiente: Number(compra.saldoPendiente),
    estadoPago: compra.estadoPago,
    cancelada: compra.cancelada,
    canceladaEn: compra.canceladaEn,
    proveedor: { id: compra.proveedor.id, nombre: compra.proveedor.nombre, telefono: compra.proveedor.telefono },
    metodosPago: [...new Set(compra.pagos.map((p) => p.metodoPago))],
    items: compra.lotes.map((l) => ({
      producto: l.variante.producto.nombre,
      marca: l.variante.marca,
      cantidad: Number(l.cantidadInicial),
      costoUnitario: Number(l.costoUnitario),
      subtotal: Number(l.cantidadInicial) * Number(l.costoUnitario),
    })),
  };
}

/** Reporte de facturas pendientes de pago a proveedores */
export async function facturasPendientes() {
  const compras = await prisma.compra.findMany({
    where: { estadoPago: { in: ['pendiente', 'parcial'] }, cancelada: false },
    include: { proveedor: true },
    orderBy: { fechaVencimiento: 'asc' },
  });

  return compras.map((c) => ({
    id: c.id,
    numeroFactura: c.numeroFactura,
    total: Number(c.total),
    saldoPendiente: Number(c.saldoPendiente),
    fechaVencimiento: c.fechaVencimiento,
    fecha: c.fecha,
    proveedor: {
      id: c.proveedor.id,
      nombre: c.proveedor.nombre,
      telefono: c.proveedor.telefono,
    },
  }));
}

interface FiltrosHistorialCompras {
  periodo?: string; // dia | semana | mes | anio | rango | todos
  desde?: string;
  hasta?: string;
  proveedorId?: string;
  estadoPago?: string; // pendiente | parcial | pagada
}

function obtenerRangoCompras(periodo: string, desde?: string, hasta?: string) {
  const hoy = new Date();
  const inicio = new Date(hoy);
  const fin = new Date(hoy);

  switch (periodo) {
    case 'todos':
      inicio.setFullYear(2000, 0, 1);
      inicio.setHours(0, 0, 0, 0);
      fin.setFullYear(2100, 0, 1);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'dia':
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'semana':
      inicio.setDate(hoy.getDate() - 6);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'anio':
      inicio.setMonth(0, 1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'rango': {
      if (desde) {
        const d = new Date(desde);
        d.setHours(0, 0, 0, 0);
        inicio.setTime(d.getTime());
      } else {
        inicio.setDate(1);
        inicio.setHours(0, 0, 0, 0);
      }
      if (hasta) {
        const h = new Date(hasta);
        h.setHours(23, 59, 59, 999);
        fin.setTime(h.getTime());
      } else {
        fin.setHours(23, 59, 59, 999);
      }
      break;
    }
    case 'mes':
    default:
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
  }

  return { inicio, fin };
}

/**
 * Historial COMPLETO de compras (pagadas, parciales y pendientes -- a
 * diferencia de facturasPendientes(), que solo muestra lo que aun se debe).
 * Filtra por periodo, proveedor y estado de pago.
 */
export async function listarHistorialCompras(filtros: FiltrosHistorialCompras) {
  const { inicio, fin } = obtenerRangoCompras(filtros.periodo || 'todos', filtros.desde, filtros.hasta);

  const compras = await prisma.compra.findMany({
    where: {
      fecha: { gte: inicio, lte: fin },
      ...(filtros.proveedorId ? { proveedorId: filtros.proveedorId } : {}),
      ...(filtros.estadoPago ? { estadoPago: filtros.estadoPago } : {}),
    },
    include: {
      proveedor: true,
      pagos: true,
      lotes: { include: { variante: { include: { producto: true } } } },
    },
    orderBy: { fecha: 'desc' },
  });

  return compras.map((c) => ({
    id: c.id,
    numeroFactura: c.numeroFactura,
    fecha: c.fecha,
    fechaVencimiento: c.fechaVencimiento,
    total: Number(c.total),
    saldoPendiente: Number(c.saldoPendiente),
    estadoPago: c.estadoPago,
    cancelada: c.cancelada,
    canceladaEn: c.canceladaEn,
    proveedor: { id: c.proveedor.id, nombre: c.proveedor.nombre, telefono: c.proveedor.telefono },
    metodosPago: [...new Set(c.pagos.map((p) => p.metodoPago))],
    items: c.lotes.map((l) => ({
      producto: l.variante.producto.nombre,
      marca: l.variante.marca,
      cantidad: Number(l.cantidadInicial),
      costoUnitario: Number(l.costoUnitario),
    })),
  }));
}

export class CompraYaCanceladaError extends Error {
  constructor() {
    super('Esta compra ya estaba cancelada.');
  }
}

export class AutorizacionCancelacionInvalidaError extends Error {
  constructor() {
    super('Cancelar una compra de un dia anterior necesita autorizacion por telefono y PIN.');
  }
}

export class CompraConMercanciaVendidaError extends Error {
  constructor() {
    super(
      'No se puede cancelar: parte de la mercancia de esta compra ya se vendio. ' +
        'Solo se puede cancelar una compra cuyo inventario siga completo, sin tocar.'
    );
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
 * Cancela una compra: quita del inventario exactamente lo que esa compra
 * habia agregado, pone su saldo pendiente en cero, y deja registro de
 * quien y cuando la cancelo. Solo se puede cancelar si NADA de esa
 * mercancia se ha vendido todavia (si ya se vendio parte, no hay forma
 * segura de "deshacerlo" sin afectar ventas ya hechas a un cliente).
 *
 * Si la compra es de un dia distinto al de hoy, cancelarla requiere
 * autorizacion por telefono+PIN de un administrador, igual que con las
 * ventas.
 */
export async function cancelarCompra(
  compraId: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const compraActual = await prisma.compra.findUniqueOrThrow({ where: { id: compraId } });
  if (compraActual.cancelada) {
    throw new CompraYaCanceladaError();
  }

  let autorizadaPorId: string | null = null;
  if (!esMismoDia(compraActual.fecha, new Date())) {
    if (!autorizacion) throw new AutorizacionCancelacionInvalidaError();
    autorizadaPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadaPorId) throw new AutorizacionCancelacionInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    const compra = await tx.compra.findUniqueOrThrow({
      where: { id: compraId },
      include: { lotes: true, pagos: true },
    });

    if (compra.cancelada) {
      throw new CompraYaCanceladaError();
    }

    for (const lote of compra.lotes) {
      if (Number(lote.cantidadDisponible) < Number(lote.cantidadInicial)) {
        throw new CompraConMercanciaVendidaError();
      }
    }

    for (const lote of compra.lotes) {
      await tx.loteInventario.update({
        where: { id: lote.id },
        data: { cantidadDisponible: 0 },
      });
    }

    // Si algo de lo pagado fue por transferencia, se le regresa al saldo
    // bancario -- esa compra ya no existe, ese dinero no debe seguir
    // contando como salido por ella.
    const pagadoPorTransferencia = compra.pagos
      .filter((p) => p.metodoPago === 'transferencia')
      .reduce((acc, p) => acc + Number(p.monto), 0);
    const pagadoEnEfectivo = compra.pagos
      .filter((p) => p.metodoPago === 'efectivo')
      .reduce((acc, p) => acc + Number(p.monto), 0);
    if (pagadoPorTransferencia > 0) {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { increment: pagadoPorTransferencia } },
        create: { id: 'singleton', saldoBancoActual: pagadoPorTransferencia },
      });
    }
    if (pagadoEnEfectivo > 0) {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { increment: pagadoEnEfectivo } },
        create: { id: 'singleton', saldoEfectivoActual: pagadoEnEfectivo },
      });
    }

    return tx.compra.update({
      where: { id: compraId },
      data: {
        cancelada: true,
        canceladaEn: new Date(),
        canceladaPorId: solicitadoPorId,
        autorizadaPorId,
        saldoPendiente: 0,
      },
    });
  });
}
