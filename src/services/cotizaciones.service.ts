import { prisma } from '../prisma';
import { crearVenta } from './ventas.service';

interface ItemCotizacionInput {
  varianteId: string;
  cantidad: number;
  precioUnitario: number;
}

interface CrearCotizacionInput {
  clienteId: string;
  vendedorId: string;
  items: ItemCotizacionInput[];
}

export class CotizacionSinItemsError extends Error {
  constructor() {
    super('Una cotizacion necesita al menos un producto');
  }
}

export class CotizacionYaResueltaError extends Error {
  constructor(estado: string) {
    super(`Esta cotizacion ya no esta pendiente (estado actual: ${estado})`);
  }
}

/**
 * Guarda el carrito armado + cliente como una cotizacion para compartir.
 * A proposito NO toca inventario, saldos ni crea ninguna Venta -- es solo
 * un registro que se puede retomar despues con confirmarCotizacion().
 */
export async function crearCotizacion(input: CrearCotizacionInput) {
  if (!input.items || input.items.length === 0) {
    throw new CotizacionSinItemsError();
  }

  const total = input.items.reduce((acc, i) => acc + i.cantidad * i.precioUnitario, 0);

  return prisma.cotizacion.create({
    data: {
      clienteId: input.clienteId,
      vendedorId: input.vendedorId,
      total,
      items: {
        create: input.items.map((i) => ({
          varianteId: i.varianteId,
          cantidad: i.cantidad,
          precioUnitario: i.precioUnitario,
        })),
      },
    },
    include: { cliente: true, vendedor: true, items: true },
  });
}

/**
 * Pendientes por confirmar. Sin scoping por vendedor a proposito -- cualquier
 * vendedor debe poder retomar y confirmar la cotizacion de otro compañero
 * cuando el cliente regresa a comprar.
 */
export async function listarCotizacionesPendientes() {
  return prisma.cotizacion.findMany({
    where: { estado: 'enviada' },
    include: { cliente: true, vendedor: true, items: true },
    orderBy: { fecha: 'desc' },
  });
}

export async function obtenerCotizacion(id: string) {
  return prisma.cotizacion.findUniqueOrThrow({
    where: { id },
    include: {
      cliente: true,
      vendedor: true,
      items: { include: { variante: { include: { producto: true } } } },
    },
  });
}

/**
 * Convierte una cotizacion pendiente en una Venta real, reutilizando
 * exactamente la misma logica de crearVenta (FIFO, autorizacion por
 * precio bajo costo, saldo/pago) -- la cotizacion solo aporta el cliente
 * y los items ya acordados con el cliente.
 */
export async function confirmarCotizacion(
  cotizacionId: string,
  datos: {
    vendedorId: string;
    esCredito: boolean;
    montoPagadoAhora: number;
    metodoPago?: string;
    autorizadoPorTelefono?: string;
    autorizadoPin?: string;
    motivoAutorizacion?: string;
  }
) {
  const cotizacion = await prisma.cotizacion.findUniqueOrThrow({
    where: { id: cotizacionId },
    include: { items: true },
  });

  if (cotizacion.estado !== 'enviada') {
    throw new CotizacionYaResueltaError(cotizacion.estado);
  }

  const resultado = await crearVenta({
    vendedorId: datos.vendedorId,
    clienteId: cotizacion.clienteId,
    esCredito: datos.esCredito,
    montoPagadoAhora: datos.montoPagadoAhora,
    metodoPago: datos.metodoPago,
    items: cotizacion.items.map((i) => ({
      varianteId: i.varianteId,
      cantidad: Number(i.cantidad),
      precioUnitario: Number(i.precioUnitario),
      autorizadoPorTelefono: datos.autorizadoPorTelefono,
      autorizadoPin: datos.autorizadoPin,
      motivoAutorizacion: datos.motivoAutorizacion,
    })),
  });

  await prisma.cotizacion.update({
    where: { id: cotizacionId },
    data: { estado: 'confirmada', confirmadaEn: new Date(), ventaId: resultado.venta.id },
  });

  return resultado;
}

/** No hay nada que revertir -- una cotizacion nunca toco inventario ni saldos. */
export async function cancelarCotizacion(cotizacionId: string) {
  const cotizacion = await prisma.cotizacion.findUniqueOrThrow({ where: { id: cotizacionId } });
  if (cotizacion.estado !== 'enviada') {
    throw new CotizacionYaResueltaError(cotizacion.estado);
  }

  return prisma.cotizacion.update({
    where: { id: cotizacionId },
    data: { estado: 'cancelada' },
  });
}
