import { prisma } from '../prisma';

export async function buscarClientes(query: string) {
  if (!query || query.length < 2) return [];

  return prisma.cliente.findMany({
    where: {
      OR: [
        { nombre: { contains: query, mode: 'insensitive' } },
        { telefono: { contains: query } },
      ],
    },
    take: 10,
    orderBy: { nombre: 'asc' },
  });
}

export async function crearClienteRapido(nombre: string, telefono: string) {
  return prisma.cliente.create({
    data: { nombre, telefono },
  });
}

/** Alta completa desde la pantalla de Clientes (con domicilio opcional). */
export async function crearCliente(datos: { nombre: string; telefono: string; direccion?: string }) {
  return prisma.cliente.create({
    data: {
      nombre: datos.nombre,
      telefono: datos.telefono,
      direccion: datos.direccion || undefined,
    },
  });
}

function calcularSaldoTotal(ventas: { esCredito: boolean; saldoPendiente: any }[]) {
  return ventas
    .filter((v) => v.esCredito)
    .reduce((acc, v) => acc + Number(v.saldoPendiente), 0);
}

/**
 * Lista TODOS los clientes (no solo los que tienen credito activo, a
 * diferencia de la Cartera), con su saldo total, y permite filtrar por
 * si tienen deuda o no.
 */
export async function listarClientesConSaldo(filtro: 'todos' | 'conDeuda' | 'sinDeuda') {
  const clientes = await prisma.cliente.findMany({
    include: { ventas: { select: { esCredito: true, saldoPendiente: true } } },
    orderBy: { nombre: 'asc' },
  });

  const mapeados = clientes.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    telefono: c.telefono,
    direccion: c.direccion,
    permiteVentaCredito: c.permiteVentaCredito,
    saldoTotal: calcularSaldoTotal(c.ventas),
  }));

  if (filtro === 'conDeuda') return mapeados.filter((c) => c.saldoTotal > 0);
  if (filtro === 'sinDeuda') return mapeados.filter((c) => c.saldoTotal <= 0);
  return mapeados;
}

export async function obtenerClienteDetalle(clienteId: string) {
  const cliente = await prisma.cliente.findUniqueOrThrow({
    where: { id: clienteId },
    include: { ventas: { select: { esCredito: true, saldoPendiente: true } } },
  });

  return {
    id: cliente.id,
    nombre: cliente.nombre,
    telefono: cliente.telefono,
    direccion: cliente.direccion,
    permiteVentaCredito: cliente.permiteVentaCredito,
    saldoTotal: calcularSaldoTotal(cliente.ventas),
  };
}

interface ActualizarClienteInput {
  nombre?: string;
  telefono?: string;
  direccion?: string;
  permiteVentaCredito?: boolean;
}

export async function actualizarCliente(clienteId: string, datos: ActualizarClienteInput) {
  return prisma.cliente.update({ where: { id: clienteId }, data: datos });
}

/** Todas las transacciones (ventas) de un cliente, con sus productos para poder filtrar por nombre/codigo. */
export async function ventasDeCliente(clienteId: string) {
  const ventas = await prisma.venta.findMany({
    where: { clienteId, cancelada: false },
    include: {
      items: {
        include: { lote: { include: { variante: { include: { producto: true } } } } },
      },
    },
    orderBy: { fecha: 'desc' },
  });

  return ventas.map((v) => ({
    id: v.id,
    folio: v.folio,
    fecha: v.fecha,
    total: Number(v.total),
    saldoPendiente: Number(v.saldoPendiente),
    esCredito: v.esCredito,
    estadoPago: v.estadoPago,
    items: v.items.map((i) => ({
      producto: i.lote.variante.producto.nombre,
      productoId: i.lote.variante.producto.id,
      marca: i.lote.variante.marca,
      cantidad: Number(i.cantidad),
      precioUnitario: Number(i.precioUnitario),
    })),
  }));
}

/** Movimientos de cuenta: ventas generadas + pagos/abonos recibidos, en orden cronologico. */
export async function movimientosDeCliente(clienteId: string) {
  const [ventas, pagos] = await Promise.all([
    prisma.venta.findMany({ where: { clienteId, cancelada: false } }),
    prisma.pagoVenta.findMany({
      where: { venta: { clienteId } },
      include: { venta: true },
    }),
  ]);

  const movimientos = [
    ...ventas.map((v) => ({
      tipo: 'venta' as const,
      id: v.id,
      folio: v.folio,
      fecha: v.fecha,
      monto: Number(v.total),
    })),
    ...pagos.map((p) => ({
      tipo: 'abono' as const,
      id: p.id,
      folio: p.venta.folio,
      fecha: p.fecha,
      monto: Number(p.monto),
    })),
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

  const saldoTotal = calcularSaldoTotal(
    ventas.map((v) => ({ esCredito: v.esCredito, saldoPendiente: v.saldoPendiente }))
  );

  return { saldoTotal, movimientos };
}
