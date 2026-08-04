import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';

interface ItemVentaInput {
  varianteId: string;
  cantidad: number;       // kg que el cliente quiere comprar
  precioUnitario: number; // precio final acordado (puede diferir del precio de lista)
  // Si el precio queda por debajo del costo, estos tres campos son obligatorios.
  // El administrador se identifica por su TELEFONO (no un ID interno) porque
  // es el mismo dato que usa para hacer login, mucho mas facil de dictar.
  autorizadoPorTelefono?: string;
  autorizadoPin?: string;
  motivoAutorizacion?: string;
}

interface CrearVentaInput {
  vendedorId: string;
  clienteId: string;
  items: ItemVentaInput[];
  esCredito: boolean;
  montoPagadoAhora: number; // 0 = credito total, = total => de contado
  metodoPago?: string;
  canalTicket?: string;
}

export class StockInsuficienteError extends Error {
  constructor(varianteId: string, disponible: number, solicitado: number) {
    super(
      `Stock insuficiente para la variante ${varianteId}: disponible ${disponible}kg, solicitado ${solicitado}kg`
    );
  }
}

export class PrecioBajoCostoSinAutorizarError extends Error {
  constructor(varianteId: string) {
    super(
      `El precio ofrecido para la variante ${varianteId} esta por debajo del costo y no tiene autorizacion`
    );
  }
}

export class ClienteSinCreditoError extends Error {
  constructor() {
    super('Este cliente no tiene autorizado comprar a credito.');
  }
}

/**
 * Registra una venta completa:
 * 1. Por cada item, descuenta stock de los lotes mas antiguos primero (FIFO).
 *    Si el lote mas viejo no alcanza, toma el resto del siguiente lote,
 *    generando varias lineas de VentaItem con su propio costo si es necesario.
 * 2. Si el precio ofrecido es menor al costo del lote, exige autorizacion.
 * 3. Si no hay stock suficiente en ningun lote, rechaza la venta completa
 *    (no se permite vender en negativo).
 * 4. Calcula el saldo pendiente segun si es credito/parcial/contado.
 * 5. Si hay pago inicial, reparte proporcionalmente entre las lineas
 *    (asignacion automatica por default).
 */
export async function crearVenta(input: CrearVentaInput) {
  if (input.esCredito) {
    const cliente = await prisma.cliente.findUniqueOrThrow({ where: { id: input.clienteId } });
    if (!cliente.permiteVentaCredito) {
      throw new ClienteSinCreditoError();
    }
  }

  return prisma.$transaction(async (tx) => {
    const lineasCreadas: {
      loteId: string;
      cantidad: number;
      precioLista: number;
      precioUnitario: number;
      costoUnitarioSnapshot: number;
      autorizadoPorId?: string;
      motivoAutorizacion?: string;
      subtotal: number;
    }[] = [];

    let total = 0;

    for (const item of input.items) {
      const variante = await tx.variante.findUniqueOrThrow({
        where: { id: item.varianteId },
      });

      // Lotes con stock disponible, del mas viejo al mas nuevo (FIFO)
      const lotes = await tx.loteInventario.findMany({
        where: { varianteId: item.varianteId, cantidadDisponible: { gt: 0 } },
        orderBy: { fechaIngreso: 'asc' },
      });

      const stockTotal = lotes.reduce(
        (acc, l) => acc + Number(l.cantidadDisponible),
        0
      );

      if (stockTotal < item.cantidad) {
        throw new StockInsuficienteError(item.varianteId, stockTotal, item.cantidad);
      }

      let cantidadRestante = item.cantidad;
      let autorizadoPorIdResuelto: string | undefined; // el ID real, resuelto por telefono+pin

      for (const lote of lotes) {
        if (cantidadRestante <= 0) break;

        const costoLote = Number(lote.costoUnitario);

        // Si el precio ofrecido es menor al costo de ESTE lote especifico,
        // se requiere autorizacion valida de un usuario real con permiso
        // (se verifica su PIN, no solo que el campo venga presente).
        if (item.precioUnitario < costoLote) {
          if (!item.autorizadoPorTelefono || !item.autorizadoPin || !item.motivoAutorizacion) {
            throw new PrecioBajoCostoSinAutorizarError(item.varianteId);
          }
          if (!autorizadoPorIdResuelto) {
            const idResuelto = await verificarAutorizadorPorTelefono(
              item.autorizadoPorTelefono,
              item.autorizadoPin
            );
            if (!idResuelto) {
              throw new PrecioBajoCostoSinAutorizarError(item.varianteId);
            }
            autorizadoPorIdResuelto = idResuelto;
          }
        }

        const cantidadDeEsteLote = Math.min(
          cantidadRestante,
          Number(lote.cantidadDisponible)
        );

        // Descuenta del lote
        await tx.loteInventario.update({
          where: { id: lote.id },
          data: {
            cantidadDisponible: {
              decrement: cantidadDeEsteLote,
            },
          },
        });

        const subtotal = cantidadDeEsteLote * item.precioUnitario;
        total += subtotal;

        lineasCreadas.push({
          loteId: lote.id,
          cantidad: cantidadDeEsteLote,
          precioLista: Number(variante.precioVenta),
          precioUnitario: item.precioUnitario,
          costoUnitarioSnapshot: costoLote,
          autorizadoPorId: autorizadoPorIdResuelto,
          motivoAutorizacion: item.motivoAutorizacion,
          subtotal,
        });

        cantidadRestante -= cantidadDeEsteLote;
      }
    }

    const saldoPendiente = total - input.montoPagadoAhora;
    const estadoPago =
      saldoPendiente <= 0 ? 'pagada' : input.montoPagadoAhora > 0 ? 'parcial' : 'pendiente';

    const venta = await tx.venta.create({
      data: {
        vendedorId: input.vendedorId,
        clienteId: input.clienteId,
        total,
        saldoPendiente: Math.max(saldoPendiente, 0),
        esCredito: input.esCredito,
        estadoPago,
        canalTicket: input.canalTicket,
      },
    });

    const items = [];
    for (const linea of lineasCreadas) {
      const ventaItem = await tx.ventaItem.create({
        data: {
          ventaId: venta.id,
          loteId: linea.loteId,
          cantidad: linea.cantidad,
          precioLista: linea.precioLista,
          precioUnitario: linea.precioUnitario,
          costoUnitarioSnapshot: linea.costoUnitarioSnapshot,
          autorizadoPorId: linea.autorizadoPorId,
          motivoAutorizacion: linea.motivoAutorizacion,
        },
      });
      items.push({ ...ventaItem, subtotal: linea.subtotal });
    }

    // Pago inicial: se registra y se reparte proporcional al subtotal de cada linea
    if (input.montoPagadoAhora > 0) {
      const pago = await tx.pagoVenta.create({
        data: {
          ventaId: venta.id,
          monto: input.montoPagadoAhora,
          metodoPago: input.metodoPago ?? 'efectivo',
        },
      });

      for (const item of items) {
        const proporcion = item.subtotal / total;
        const montoAsignado = input.montoPagadoAhora * proporcion;

        await tx.pagoAsignacion.create({
          data: {
            pagoId: pago.id,
            ventaItemId: item.id,
            montoAsignado,
          },
        });
      }

      // El saldo bancario o en efectivo sube solo, segun el metodo de pago.
      const metodo = input.metodoPago ?? 'efectivo';
      if (metodo === 'transferencia') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoBancoActual: { increment: input.montoPagadoAhora } },
          create: { id: 'singleton', saldoBancoActual: input.montoPagadoAhora },
        });
      } else if (metodo === 'efectivo') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoEfectivoActual: { increment: input.montoPagadoAhora } },
          create: { id: 'singleton', saldoEfectivoActual: input.montoPagadoAhora },
        });
      }
    }

    return { venta, items };
  });
}

/**
 * Calcula la utilidad de una venta:
 * - utilidadDevengada: la ganancia total "en papel" (venta completa, se haya cobrado o no)
 * - utilidadCobrada: la parte de esa ganancia respaldada por dinero ya recibido,
 *   calculada por linea segun el % pagado de CADA producto (mas preciso que
 *   aplicar el % del total de la nota).
 */
export async function calcularUtilidadVenta(ventaId: string) {
  const items = await prisma.ventaItem.findMany({
    where: { ventaId },
    include: { pagoAsignaciones: true },
  });

  let utilidadDevengada = 0;
  let utilidadCobrada = 0;

  for (const item of items) {
    const cantidad = Number(item.cantidad);
    const subtotal = cantidad * Number(item.precioUnitario);
    const margenItem =
      (Number(item.precioUnitario) - Number(item.costoUnitarioSnapshot)) * cantidad;

    const totalAsignado = item.pagoAsignaciones.reduce(
      (acc, a) => acc + Number(a.montoAsignado),
      0
    );
    const porcentajeCobrado = subtotal > 0 ? totalAsignado / subtotal : 0;

    utilidadDevengada += margenItem;
    utilidadCobrada += margenItem * porcentajeCobrado;
  }

  return { utilidadDevengada, utilidadCobrada };
}

export class VentaYaCanceladaError extends Error {
  constructor() {
    super('Esta venta ya estaba cancelada.');
  }
}

export class AutorizacionCancelacionInvalidaError extends Error {
  constructor() {
    super('Cancelar una venta de un dia anterior necesita autorizacion por telefono y PIN.');
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
 * Cancela una venta: regresa la cantidad de cada linea al lote de donde
 * salio (FIFO inverso), pone el saldo pendiente en cero (ya no se debe
 * nada de una venta que no existio), y deja registro de quien y cuando
 * la cancelo. No se borra nada -- la venta y sus items quedan en la base
 * de datos marcados como cancelados, para poder auditar despues.
 * Los reportes (historial, dashboard, corte, cartera, movimientos de
 * inventario) excluyen las ventas canceladas de sus totales.
 *
 * Si la venta es de un dia distinto al de hoy, cancelarla requiere
 * autorizacion por telefono+PIN de un administrador (igual que un ajuste
 * de inventario) -- no basta con que quien lo solicita este loggeado.
 */
export async function cancelarVenta(
  ventaId: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const ventaActual = await prisma.venta.findUniqueOrThrow({ where: { id: ventaId } });
  if (ventaActual.cancelada) {
    throw new VentaYaCanceladaError();
  }

  let autorizadaPorId: string | null = null;
  if (!esMismoDia(ventaActual.fecha, new Date())) {
    if (!autorizacion) throw new AutorizacionCancelacionInvalidaError();
    autorizadaPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadaPorId) throw new AutorizacionCancelacionInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    const venta = await tx.venta.findUniqueOrThrow({
      where: { id: ventaId },
      include: { items: true, pagos: true },
    });

    if (venta.cancelada) {
      throw new VentaYaCanceladaError();
    }

    for (const item of venta.items) {
      await tx.loteInventario.update({
        where: { id: item.loteId },
        data: { cantidadDisponible: { increment: item.cantidad } },
      });
    }

    // Si algo de lo pagado fue por transferencia o en efectivo, se le
    // regresa al saldo correspondiente -- esa venta ya no existe, ese
    // dinero no se debe seguir contando como ingresado por ella.
    const pagadoPorTransferencia = venta.pagos
      .filter((p) => p.metodoPago === 'transferencia')
      .reduce((acc, p) => acc + Number(p.monto), 0);
    const pagadoEnEfectivo = venta.pagos
      .filter((p) => p.metodoPago === 'efectivo')
      .reduce((acc, p) => acc + Number(p.monto), 0);
    if (pagadoPorTransferencia > 0) {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { decrement: pagadoPorTransferencia } },
        create: { id: 'singleton', saldoBancoActual: -pagadoPorTransferencia },
      });
    }
    if (pagadoEnEfectivo > 0) {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { decrement: pagadoEnEfectivo } },
        create: { id: 'singleton', saldoEfectivoActual: -pagadoEnEfectivo },
      });
    }

    return tx.venta.update({
      where: { id: ventaId },
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
