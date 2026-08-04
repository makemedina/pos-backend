import { prisma } from '../prisma';

interface FiltrosHistorial {
  periodo?: string; // dia | semana | mes | anio | rango
  desde?: string;
  hasta?: string;
  clienteId?: string;
  metodoPago?: string; // efectivo | transferencia
  incluirCanceladas?: boolean;
}

interface UsuarioContexto {
  id: string;
  rolBase: string;
  permisos: { puedeVerCarteraGeneral: boolean; puedeVerUtilidad?: boolean } | null;
}

function obtenerRango(periodo: string, desde?: string, hasta?: string) {
  const hoy = new Date();
  const fin = new Date(hoy);
  const inicio = new Date(hoy);

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
 * Lista el historico de ventas con filtros de periodo, cliente y metodo
 * de pago. Regla de negocio: cada vendedor ve solo sus propias ventas,
 * salvo el administrador o quien tenga el switch puedeVerCarteraGeneral,
 * que ven las de todos (mismo patron que ya usamos para "gastos").
 */
export async function listarHistorialVentas(filtros: FiltrosHistorial, usuario: UsuarioContexto) {
  const periodo = filtros.periodo || 'todos';
  const { inicio, fin } = obtenerRango(periodo, filtros.desde, filtros.hasta);

  const puedeVerTodas = usuario.rolBase === 'administrador' || usuario.permisos?.puedeVerCarteraGeneral;

  const ventas = await prisma.venta.findMany({
    where: {
      fecha: { gte: inicio, lte: fin },
      ...(filtros.incluirCanceladas ? {} : { cancelada: false }),
      ...(puedeVerTodas ? {} : { vendedorId: usuario.id }),
      ...(filtros.clienteId ? { clienteId: filtros.clienteId } : {}),
      ...(filtros.metodoPago ? { pagos: { some: { metodoPago: filtros.metodoPago } } } : {}),
    },
    include: {
      cliente: true,
      vendedor: true,
      pagos: true,
      items: {
        include: {
          lote: { include: { variante: { include: { producto: true } } } },
        },
      },
    },
    orderBy: { fecha: 'desc' },
  });

  const puedeVerUtilidad = usuario.rolBase === 'administrador' || usuario.permisos?.puedeVerUtilidad;

  return ventas.map((v) => ({
    id: v.id,
    folio: v.folio,
    fecha: v.fecha,
    total: Number(v.total),
    saldoPendiente: Number(v.saldoPendiente),
    esCredito: v.esCredito,
    estadoPago: v.estadoPago,
    cancelada: v.cancelada,
    canceladaEn: v.canceladaEn,
    cliente: { id: v.cliente.id, nombre: v.cliente.nombre, telefono: v.cliente.telefono },
    vendedor: { id: v.vendedor.id, nombre: v.vendedor.nombre },
    metodosPago: [...new Set(v.pagos.map((p) => p.metodoPago))],
    items: v.items.map((i) => {
      const cantidad = Number(i.cantidad);
      const precioUnitario = Number(i.precioUnitario);
      const costoUnitario = Number(i.costoUnitarioSnapshot);
      return {
        producto: i.lote.variante.producto.nombre,
        marca: i.lote.variante.marca,
        cantidad,
        precioUnitario,
        // El costo y la utilidad revelan el margen del negocio; se omiten
        // si el usuario no tiene permiso de ver utilidad (mismo criterio
        // que ya se usa en el corte de caja).
        ...(puedeVerUtilidad
          ? {
              costoUnitario,
              utilidad: (precioUnitario - costoUnitario) * cantidad,
            }
          : {}),
      };
    }),
  }));
}

/** Detalle completo de una nota especifica -- para cuando se hace click en una transaccion. */
export async function obtenerDetalleVenta(ventaId: string) {
  const venta = await prisma.venta.findUniqueOrThrow({
    where: { id: ventaId },
    include: {
      cliente: true,
      vendedor: true,
      pagos: true,
      items: {
        include: { lote: { include: { variante: { include: { producto: true } } } } },
      },
    },
  });

  return {
    id: venta.id,
    folio: venta.folio,
    fecha: venta.fecha,
    total: Number(venta.total),
    saldoPendiente: Number(venta.saldoPendiente),
    esCredito: venta.esCredito,
    estadoPago: venta.estadoPago,
    cancelada: venta.cancelada,
    canceladaEn: venta.canceladaEn,
    cliente: { id: venta.cliente.id, nombre: venta.cliente.nombre, telefono: venta.cliente.telefono },
    vendedor: { id: venta.vendedor.id, nombre: venta.vendedor.nombre },
    metodosPago: [...new Set(venta.pagos.map((p) => p.metodoPago))],
    items: venta.items.map((i) => ({
      producto: i.lote.variante.producto.nombre,
      marca: i.lote.variante.marca,
      cantidad: Number(i.cantidad),
      precioUnitario: Number(i.precioUnitario),
      subtotal: Number(i.cantidad) * Number(i.precioUnitario),
    })),
  };
}
