import { prisma } from '../prisma';

interface DashboardFilters {
  periodo?: string;
  desde?: string;
  hasta?: string;
}

function parseDate(value: string, endOfDay = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }

  return date;
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
    case 'mes':
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'anio':
      inicio.setMonth(0, 1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'rango': {
      const desdeDate = desde ? parseDate(desde, false) : null;
      const hastaDate = hasta ? parseDate(hasta, true) : null;
      if (desdeDate) inicio.setTime(desdeDate.getTime());
      else {
        inicio.setDate(1);
        inicio.setHours(0, 0, 0, 0);
      }
      if (hastaDate) fin.setTime(hastaDate.getTime());
      else fin.setHours(23, 59, 59, 999);
      break;
    }
    default:
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
  }

  return { inicio, fin };
}

export async function obtenerDashboard(filters: DashboardFilters = {}) {
  const periodo = filters.periodo || 'todos';
  const { inicio, fin } = obtenerRango(periodo, filters.desde, filters.hasta);

  const [ventas, gastos] = await Promise.all([
    prisma.venta.findMany({
      where: {
        fecha: {
          gte: inicio,
          lte: fin,
        },
        cancelada: false,
      },
      include: {
        items: {
          include: {
            lote: {
              include: {
                variante: {
                  include: { producto: true },
                },
              },
            },
          },
        },
      },
    }),
    prisma.gasto.findMany({
      where: {
        fecha: {
          gte: inicio,
          lte: fin,
        },
        cancelado: false,
      },
    }),
  ]);

  const totalVentas = ventas.reduce((acc, venta) => acc + Number(venta.total), 0);
  const totalCobrado = ventas.reduce(
    (acc, venta) => acc + (Number(venta.total) - Number(venta.saldoPendiente)),
    0
  );

  const utilidadBruta = ventas.reduce((acc, venta) => {
    const ventaUtilidad = venta.items.reduce((itemAcc, item) => {
      const subtotal = Number(item.cantidad) * Number(item.precioUnitario);
      const costo = Number(item.cantidad) * Number(item.costoUnitarioSnapshot);
      return itemAcc + (subtotal - costo);
    }, 0);
    return acc + ventaUtilidad;
  }, 0);

  const totalGastos = gastos.reduce((acc, gasto) => acc + Number(gasto.monto), 0);

  const productosMasVendidos = ventas.reduce<Record<string, number>>((acc, venta) => {
    venta.items.forEach((item) => {
      const nombre = item.lote.variante.producto.nombre;
      acc[nombre] = (acc[nombre] || 0) + Number(item.cantidad);
    });
    return acc;
  }, {});

  return {
    totalVentas,
    totalCobrado,
    utilidadBruta,
    totalGastos,
    utilidadNeta: utilidadBruta - totalGastos,
    productosMasVendidos: Object.entries(productosMasVendidos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  };
}
