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

// Los campos Decimal de Prisma llegan como string al pasar por JSON si no
// se convierten aqui -- eso rompia formatoMoneda() en el frontend (esperaba
// un number). Se mapea explicitamente, igual que en historial.service.ts.
function mapearResumen(c: {
  id: string;
  folio: number;
  fecha: Date;
  total: unknown;
  estado: string;
  cliente: { id: string; nombre: string; telefono: string };
  vendedor: { nombre: string };
  items: { varianteId: string; cantidad: unknown; precioUnitario: unknown }[];
}) {
  return {
    id: c.id,
    folio: c.folio,
    fecha: c.fecha,
    total: Number(c.total),
    estado: c.estado,
    cliente: { id: c.cliente.id, nombre: c.cliente.nombre, telefono: c.cliente.telefono },
    vendedor: { nombre: c.vendedor.nombre },
    items: c.items.map((i) => ({
      varianteId: i.varianteId,
      cantidad: Number(i.cantidad),
      precioUnitario: Number(i.precioUnitario),
    })),
  };
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

  const cotizacion = await prisma.cotizacion.create({
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

  return mapearResumen(cotizacion);
}

/**
 * Pendientes por confirmar. Sin scoping por vendedor a proposito -- cualquier
 * vendedor debe poder retomar y confirmar la cotizacion de otro compañero
 * cuando el cliente regresa a comprar.
 */
export async function listarCotizacionesPendientes() {
  const cotizaciones = await prisma.cotizacion.findMany({
    where: { estado: 'enviada' },
    include: { cliente: true, vendedor: true, items: true },
    orderBy: { fecha: 'desc' },
  });

  return cotizaciones.map(mapearResumen);
}

export async function obtenerCotizacion(id: string) {
  const cotizacion = await prisma.cotizacion.findUniqueOrThrow({
    where: { id },
    include: {
      cliente: true,
      vendedor: true,
      items: { include: { variante: { include: { producto: true } } } },
    },
  });

  return {
    id: cotizacion.id,
    folio: cotizacion.folio,
    fecha: cotizacion.fecha,
    total: Number(cotizacion.total),
    estado: cotizacion.estado,
    cliente: {
      id: cotizacion.cliente.id,
      nombre: cotizacion.cliente.nombre,
      telefono: cotizacion.cliente.telefono,
    },
    vendedor: { nombre: cotizacion.vendedor.nombre },
    items: cotizacion.items.map((i) => ({
      id: i.id,
      varianteId: i.varianteId,
      producto: i.variante.producto.nombre,
      marca: i.variante.marca,
      cantidad: Number(i.cantidad),
      precioUnitario: Number(i.precioUnitario),
    })),
  };
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
