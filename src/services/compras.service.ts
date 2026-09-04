import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';
import { verificarSaldoBancoSuficiente } from './configuracion.service';
import { fechaLocalDesdeString } from '../utils/fecha';
import { redondearCentavos } from '../utils/dinero';
import { subirImagenR2, descargarImagenR2 } from './imagenesR2.service';

const PREFIJO_FACTURAS = 'facturas-compra/';

/**
 * Sube la foto de la factura de una compra a R2. Se sube ANTES de crear
 * el registro de la compra -- si la subida falla, no se crea una compra
 * sin foto (la foto es obligatoria al capturar una compra normal).
 */
export async function subirFotoFacturaCompra(buffer: Buffer, contentType: string): Promise<string> {
  return subirImagenR2(buffer, contentType, PREFIJO_FACTURAS);
}

/** Regresa la foto de la factura como stream, para mandarla directo al navegador. */
export async function descargarFotoFacturaCompra(key: string) {
  return descargarImagenR2(key);
}

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
  fotoFacturaKey?: string;
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
        fotoFacturaKey: input.fotoFacturaKey,
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

      // Mantiene el costo de referencia de este proveedor (seccion
      // "Costos" en Proveedores) al dia solo con comprar -- sin esto,
      // quedaba desactualizado hasta que alguien entrara a esa pantalla
      // a capturarlo a mano.
      await tx.costoProveedorProducto.upsert({
        where: { proveedorId_varianteId: { proveedorId: input.proveedorId, varianteId: item.varianteId } },
        update: { costo: item.costoUnitario },
        create: { proveedorId: input.proveedorId, varianteId: item.varianteId, costo: item.costoUnitario },
      });
    }

    // Si hubo pago inicial, se registra como el primer abono
    if (pagoInicial > 0) {
      if ((input.metodoPagoInicial ?? 'efectivo') === 'transferencia') {
        await verificarSaldoBancoSuficiente(tx, pagoInicial);
      }

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
 * Aplica un abono a UNA compra DENTRO de una transaccion ya abierta por el
 * llamador (para reutilizar esta logica tanto para un pago a una sola
 * factura como para un pago repartido entre varias facturas del mismo
 * proveedor). A diferencia de un pago de cliente, aqui SI se limita el
 * monto al saldo pendiente -- no tiene sentido "sobrepagarle" a un
 * proveedor una factura especifica.
 */
async function aplicarPagoCompra(
  tx: Prisma.TransactionClient,
  compraId: string,
  monto: number,
  metodoPago: string,
  registradoPorId: string,
  proveedorIdEsperado?: string,
  grupoPagoId?: string
) {
  if (!monto || monto <= 0) {
    throw new MontoPagoCompraInvalidoError('El monto del pago debe ser mayor a cero');
  }

  // Mismo candado que aplicarPagoVenta (cartera.service.ts): bloquea la
  // fila para que dos pagos casi simultaneos a la MISMA factura (ej.
  // doble click por una pantalla colgada) no lean el mismo saldo inicial
  // y se pisen entre si.
  await tx.$queryRaw`SELECT id FROM "Compra" WHERE id = ${compraId} FOR UPDATE`;

  const compra = await tx.compra.findUniqueOrThrow({ where: { id: compraId } });

  if (proveedorIdEsperado && compra.proveedorId !== proveedorIdEsperado) {
    throw new MontoPagoCompraInvalidoError(
      `La factura ${compra.numeroFactura || compra.id} no pertenece a este proveedor`
    );
  }

  const saldoActual = Number(compra.saldoPendiente);
  if (monto > saldoActual) {
    throw new MontoPagoCompraInvalidoError(
      `El pago de $${monto.toFixed(2)} es mayor al saldo pendiente de $${saldoActual.toFixed(2)}`
    );
  }

  if (metodoPago === 'transferencia') {
    await verificarSaldoBancoSuficiente(tx, monto);
  }

  await tx.pagoCompra.create({
    data: { compraId, monto, metodoPago, registradoPorId, grupoPagoId },
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

  const nuevoSaldo = redondearCentavos(saldoActual - monto);

  const compraActualizada = await tx.compra.update({
    where: { id: compraId },
    data: {
      saldoPendiente: nuevoSaldo,
      estadoPago: nuevoSaldo <= 0 ? 'pagada' : 'parcial',
    },
  });

  return { compra: compraActualizada, saldoFacturaRestante: nuevoSaldo };
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
  const grupoPagoId = randomUUID();
  return prisma.$transaction(async (tx) => {
    const { compra } = await aplicarPagoCompra(tx, compraId, monto, metodoPago, registradoPorId, undefined, grupoPagoId);
    return compra;
  });
}

export interface AsignacionPagoMultipleCompra {
  compraId: string;
  monto: number;
}

/**
 * Registra UN pago que se le entrega a un proveedor y que se reparte
 * entre varias de sus facturas pendientes, con el monto especifico que se
 * le asigna a cada una. Mismo patron que registrarPagoMultiNota() del
 * lado de clientes: todo en una sola transaccion, todo o nada.
 */
export async function registrarPagoMultiCompra(
  proveedorId: string,
  asignaciones: AsignacionPagoMultipleCompra[],
  metodoPago: string,
  registradoPorId: string
) {
  const asignacionesValidas = asignaciones.filter((a) => a.monto > 0);
  if (asignacionesValidas.length === 0) {
    throw new MontoPagoCompraInvalidoError('Debes asignar un monto mayor a cero a al menos una factura');
  }

  const grupoPagoId = randomUUID();

  return prisma.$transaction(async (tx) => {
    const detalle: { compraId: string; numeroFactura: string | null; monto: number; saldoFacturaRestante: number }[] = [];
    let totalPagado = 0;

    for (const asignacion of asignacionesValidas) {
      const { compra, saldoFacturaRestante } = await aplicarPagoCompra(
        tx,
        asignacion.compraId,
        asignacion.monto,
        metodoPago,
        registradoPorId,
        proveedorId,
        grupoPagoId
      );
      totalPagado += asignacion.monto;
      detalle.push({
        compraId: asignacion.compraId,
        numeroFactura: compra.numeroFactura,
        monto: asignacion.monto,
        saldoFacturaRestante,
      });
    }

    return { detalle, totalPagado };
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
    cancelado: p.cancelado,
    canceladoEn: p.canceladoEn,
    registradoPor: { nombre: p.registradoPor?.nombre ?? 'Registro anterior' },
  }));
}

export class PagoCompraYaCanceladoError extends Error {
  constructor() {
    super('Este pago ya estaba cancelado.');
  }
}

export class AutorizacionCancelacionPagoCompraInvalidaError extends Error {
  constructor() {
    super('Cancelar un pago de un dia anterior necesita autorizacion por telefono y PIN.');
  }
}

/**
 * Cancela un abono ya registrado a una factura de proveedor (por
 * ejemplo, si se capturo con el metodo de pago equivocado -- efectivo en
 * vez de transferencia). No se borra -- queda marcado como cancelado,
 * para poder auditar despues. Revierte lo que ese pago habia movido: sube
 * de nuevo el saldoPendiente de la compra, recalcula su estadoPago, y
 * baja el saldo de efectivo/banco que se le habia sumado -- para volver
 * a registrarlo despues con el metodo correcto.
 *
 * Si el pago es de un dia distinto al de hoy, cancelarlo requiere
 * autorizacion por telefono+PIN de un administrador, igual que con
 * ventas, compras, gastos y depositos.
 */
export async function cancelarPagoCompra(
  pagoId: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const pagoActual = await prisma.pagoCompra.findUniqueOrThrow({
    where: { id: pagoId },
    include: { compra: true },
  });

  if (pagoActual.cancelado) {
    throw new PagoCompraYaCanceladoError();
  }

  let autorizadoPorId: string | null = null;
  if (!esMismoDia(pagoActual.fecha, new Date())) {
    if (!autorizacion) throw new AutorizacionCancelacionPagoCompraInvalidaError();
    autorizadoPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadoPorId) throw new AutorizacionCancelacionPagoCompraInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    const monto = Number(pagoActual.monto);
    const total = Number(pagoActual.compra.total);

    // Mismo candado que aplicarPagoCompra: bloquea la fila y vuelve a leer
    // el saldoPendiente YA DENTRO de la transaccion.
    await tx.$queryRaw`SELECT id FROM "Compra" WHERE id = ${pagoActual.compraId} FOR UPDATE`;
    const compraActual = await tx.compra.findUniqueOrThrow({ where: { id: pagoActual.compraId } });

    const nuevoSaldo = redondearCentavos(Math.min(Number(compraActual.saldoPendiente) + monto, total));

    await tx.compra.update({
      where: { id: pagoActual.compraId },
      data: {
        saldoPendiente: nuevoSaldo,
        estadoPago: nuevoSaldo >= total ? 'pendiente' : nuevoSaldo > 0 ? 'parcial' : 'pagada',
      },
    });

    // A diferencia de un pago de cliente (donde el dinero entra y cancelar
    // resta), aqui el pago original SALIO de caja/banco (decrement en
    // aplicarPagoCompra) -- cancelarlo debe DEVOLVER ese dinero, no
    // restarlo de nuevo.
    if (pagoActual.metodoPago === 'transferencia') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { increment: monto } },
        create: { id: 'singleton', saldoBancoActual: monto },
      });
    } else if (pagoActual.metodoPago === 'efectivo') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { increment: monto } },
        create: { id: 'singleton', saldoEfectivoActual: monto },
      });
    }

    return tx.pagoCompra.update({
      where: { id: pagoId },
      data: {
        cancelado: true,
        canceladoEn: new Date(),
        canceladoPorId: solicitadoPorId,
        autorizadoPorId,
      },
    });
  });
}

/**
 * Todos los pagos que se le han entregado a un proveedor, sin importar a
 * que factura(s) hayan cubierto -- agrupados por grupoPagoId (un solo
 * pago puede repartirse entre varias facturas pendientes del proveedor,
 * y todos esos PagoCompra comparten el mismo grupoPagoId). Los pagos de
 * antes de que existiera este agrupamiento no tienen grupoPagoId -- cada
 * uno de esos forma su propio grupo de una sola factura, usando su propio
 * id como clave. Mismo patron que pagosClienteAgrupados() en cartera.service.ts.
 */
export async function pagosProveedorAgrupados(proveedorId: string) {
  const pagos = await prisma.pagoCompra.findMany({
    where: { compra: { proveedorId } },
    include: { compra: { select: { id: true, numeroFactura: true } }, registradoPor: true },
    orderBy: { fecha: 'desc' },
  });

  const grupos = new Map<
    string,
    {
      grupoKey: string;
      fecha: Date;
      metodosPago: Set<string>;
      montoTotal: number;
      facturas: { compraId: string; numeroFactura: string | null; monto: number; cancelado: boolean }[];
      registradoPor: string;
      todoCancelado: boolean;
    }
  >();

  for (const p of pagos) {
    const grupoKey = p.grupoPagoId ?? p.id;
    let grupo = grupos.get(grupoKey);
    if (!grupo) {
      grupo = {
        grupoKey,
        fecha: p.fecha,
        metodosPago: new Set(),
        montoTotal: 0,
        facturas: [],
        registradoPor: p.registradoPor?.nombre ?? 'Registro anterior',
        todoCancelado: true,
      };
      grupos.set(grupoKey, grupo);
    }
    if (p.fecha < grupo.fecha) grupo.fecha = p.fecha;
    if (!p.cancelado) {
      grupo.metodosPago.add(p.metodoPago);
      grupo.montoTotal += Number(p.monto);
      grupo.todoCancelado = false;
    }
    grupo.facturas.push({
      compraId: p.compra.id,
      numeroFactura: p.compra.numeroFactura,
      monto: Number(p.monto),
      cancelado: p.cancelado,
    });
  }

  return Array.from(grupos.values())
    .map((g) => ({
      grupoKey: g.grupoKey,
      fecha: g.fecha,
      metodosPago: Array.from(g.metodosPago),
      montoTotal: redondearCentavos(g.montoTotal),
      facturas: g.facturas,
      registradoPor: g.registradoPor,
      cancelado: g.todoCancelado,
    }))
    .sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
}

/**
 * Cancela TODOS los PagoCompra de un mismo grupoPagoId de un solo golpe
 * -- el equivalente a cancelarPagoCompra pero para un pago que se le
 * entrego a un proveedor y que se repartio entre varias facturas, en vez
 * de tener que entrar factura por factura y cancelar cada renglon.
 * Revierte cada factura afectada (saldoPendiente, estadoPago) y el
 * efectivo/banco que cada renglon habia movido, todo en una transaccion.
 *
 * grupoKey puede ser un grupoPagoId real (varios renglones) o, para pagos
 * de antes de que existiera el agrupamiento, el id de un PagoCompra suelto
 * sin grupoPagoId -- pagosProveedorAgrupados() ya arma la clave de la
 * misma forma, asi que el frontend nunca necesita distinguir los dos casos.
 *
 * Si CUALQUIERA de los renglones no es de hoy, cancelar el grupo entero
 * requiere autorizacion por telefono+PIN de un administrador.
 */
export async function cancelarGrupoPagoCompra(
  grupoKey: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const pagos = await prisma.pagoCompra.findMany({
    where: { OR: [{ grupoPagoId: grupoKey }, { id: grupoKey, grupoPagoId: null }] },
    include: { compra: true },
  });

  const pagosActivos = pagos.filter((p) => !p.cancelado);
  if (pagosActivos.length === 0) {
    throw new PagoCompraYaCanceladoError();
  }

  let autorizadoPorId: string | null = null;
  if (pagosActivos.some((p) => !esMismoDia(p.fecha, new Date()))) {
    if (!autorizacion) throw new AutorizacionCancelacionPagoCompraInvalidaError();
    autorizadoPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadoPorId) throw new AutorizacionCancelacionPagoCompraInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    for (const pagoActual of pagosActivos) {
      const monto = Number(pagoActual.monto);
      const total = Number(pagoActual.compra.total);

      await tx.$queryRaw`SELECT id FROM "Compra" WHERE id = ${pagoActual.compraId} FOR UPDATE`;
      const compraActual = await tx.compra.findUniqueOrThrow({ where: { id: pagoActual.compraId } });

      const nuevoSaldo = redondearCentavos(Math.min(Number(compraActual.saldoPendiente) + monto, total));

      await tx.compra.update({
        where: { id: pagoActual.compraId },
        data: {
          saldoPendiente: nuevoSaldo,
          estadoPago: nuevoSaldo >= total ? 'pendiente' : nuevoSaldo > 0 ? 'parcial' : 'pagada',
        },
      });

      if (pagoActual.metodoPago === 'transferencia') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoBancoActual: { increment: monto } },
          create: { id: 'singleton', saldoBancoActual: monto },
        });
      } else if (pagoActual.metodoPago === 'efectivo') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoEfectivoActual: { increment: monto } },
          create: { id: 'singleton', saldoEfectivoActual: monto },
        });
      }

      await tx.pagoCompra.update({
        where: { id: pagoActual.id },
        data: { cancelado: true, canceladoEn: new Date(), canceladoPorId: solicitadoPorId, autorizadoPorId },
      });
    }

    return { cancelados: pagosActivos.length };
  });
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
    fotoFacturaKey: compra.fotoFacturaKey,
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
    case 'ayer': {
      const ayer = new Date(hoy);
      ayer.setDate(hoy.getDate() - 1);
      ayer.setHours(0, 0, 0, 0);
      const finAyer = new Date(ayer);
      finAyer.setHours(23, 59, 59, 999);
      inicio.setTime(ayer.getTime());
      fin.setTime(finAyer.getTime());
      break;
    }
    case 'semana': {
      // Semana calendario de lunes a domingo (no los ultimos 7 dias).
      const diaSemana = hoy.getDay(); // 0=domingo ... 6=sabado
      const diffLunes = diaSemana === 0 ? 6 : diaSemana - 1;
      const lunes = new Date(hoy);
      lunes.setDate(hoy.getDate() - diffLunes);
      lunes.setHours(0, 0, 0, 0);
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      domingo.setHours(23, 59, 59, 999);
      inicio.setTime(lunes.getTime());
      fin.setTime(domingo.getTime());
      break;
    }
    case 'semana_pasada': {
      const diaSemana = hoy.getDay();
      const diffLunes = diaSemana === 0 ? 6 : diaSemana - 1;
      const lunesEstaSemana = new Date(hoy);
      lunesEstaSemana.setDate(hoy.getDate() - diffLunes);
      const lunesPasado = new Date(lunesEstaSemana);
      lunesPasado.setDate(lunesEstaSemana.getDate() - 7);
      lunesPasado.setHours(0, 0, 0, 0);
      const domingoPasado = new Date(lunesPasado);
      domingoPasado.setDate(lunesPasado.getDate() + 6);
      domingoPasado.setHours(23, 59, 59, 999);
      inicio.setTime(lunesPasado.getTime());
      fin.setTime(domingoPasado.getTime());
      break;
    }
    case 'anio':
      inicio.setMonth(0, 1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'rango': {
      if (desde) {
        const d = fechaLocalDesdeString(desde);
        d.setHours(0, 0, 0, 0);
        inicio.setTime(d.getTime());
      } else {
        inicio.setDate(1);
        inicio.setHours(0, 0, 0, 0);
      }
      if (hasta) {
        const h = fechaLocalDesdeString(hasta);
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

interface FacturaInicial {
  proveedor: string;
  telefono?: string;
  factura: string;
  importe: number;
}

/**
 * Carga facturas pendientes heredadas de antes de usar el sistema (deuda
 * con proveedores). Cada fila crea una Compra real, SIN lotes de
 * inventario (una compra puede existir sin ellos) -- asi la factura
 * aparece tal cual en "Facturas pendientes" y "Registrar pago", con su
 * numero real, y se puede abonar como cualquier otra. No toca el
 * inventario para nada.
 *
 * Si el proveedor no existe, se crea (usando el telefono si vino). Si ya
 * existe y no tenia telefono guardado, se le pone el de esta fila.
 */
export async function cargarFacturasIniciales(filas: FacturaInicial[], fecha?: Date) {
  const fechaCarga = fecha ?? (() => {
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    return ayer;
  })();

  const resultado: { proveedor: string; factura: string }[] = [];

  for (const fila of filas) {
    let proveedor = await prisma.proveedor.findFirst({
      where: { nombre: { equals: fila.proveedor.trim(), mode: 'insensitive' } },
    });

    if (!proveedor) {
      proveedor = await prisma.proveedor.create({
        data: { nombre: fila.proveedor.trim(), telefono: fila.telefono || undefined },
      });
    } else if (!proveedor.telefono && fila.telefono) {
      proveedor = await prisma.proveedor.update({
        where: { id: proveedor.id },
        data: { telefono: fila.telefono },
      });
    }

    await prisma.compra.create({
      data: {
        proveedorId: proveedor.id,
        numeroFactura: fila.factura,
        fecha: fechaCarga,
        total: fila.importe,
        saldoPendiente: fila.importe,
        estadoPago: 'pendiente',
        esCargaInicial: true,
      },
    });

    resultado.push({ proveedor: proveedor.nombre, factura: fila.factura });
  }

  return { creadas: resultado.length };
}

export class CompraNoEsDeHoyError extends Error {
  constructor() {
    super('Solo se puede corregir el método de pago de una compra registrada hoy.');
  }
}

export class CorteYaHechoError extends Error {
  constructor() {
    super('Ya se guardó el corte de caja de hoy. Para corregir esto, habla con un administrador.');
  }
}

/**
 * Corrige una compra que se capturo "de contado" por error (el usuario
 * puso efectivo/transferencia cuando en realidad era a credito): borra
 * el/los pagos que tenga, regresa el efectivo/banco que se le habian
 * descontado, y deja la compra con saldoPendiente = total (pendiente),
 * como si nunca se hubiera pagado nada.
 *
 * A diferencia de cancelarCompra/cancelarPagoVenta (que dejan registro
 * porque pueden pasar dias despues), aqui se borra de verdad -- por eso
 * solo se permite el MISMO dia que se registro la compra, y solo si
 * todavia no se guardo el corte de caja de hoy. Una vez guardado el
 * corte, el efectivo/banco de ese dia ya quedo "congelado" en ese
 * reporte, y revertir un pago despues romperia ese cuadre sin que nadie
 * se diera cuenta.
 */
export async function corregirCompraAContadoCredito(compraId: string) {
  const compra = await prisma.compra.findUniqueOrThrow({
    where: { id: compraId },
    include: { pagos: true },
  });

  if (compra.cancelada) {
    throw new CompraYaCanceladaError();
  }

  const hoy = new Date();
  if (!esMismoDia(compra.fecha, hoy)) {
    throw new CompraNoEsDeHoyError();
  }

  const inicioDia = new Date(hoy);
  inicioDia.setHours(0, 0, 0, 0);
  const corteHoy = await prisma.corteCaja.findUnique({ where: { fecha: inicioDia } });
  if (corteHoy) {
    throw new CorteYaHechoError();
  }

  if (compra.pagos.length === 0) {
    return compra;
  }

  return prisma.$transaction(async (tx) => {
    for (const pago of compra.pagos) {
      const monto = Number(pago.monto);
      if (pago.metodoPago === 'transferencia') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoBancoActual: { increment: monto } },
          create: { id: 'singleton', saldoBancoActual: monto },
        });
      } else if (pago.metodoPago === 'efectivo') {
        await tx.configuracion.upsert({
          where: { id: 'singleton' },
          update: { saldoEfectivoActual: { increment: monto } },
          create: { id: 'singleton', saldoEfectivoActual: monto },
        });
      }
    }

    await tx.pagoCompra.deleteMany({ where: { compraId } });

    return tx.compra.update({
      where: { id: compraId },
      data: { saldoPendiente: compra.total, estadoPago: 'pendiente' },
    });
  });
}
