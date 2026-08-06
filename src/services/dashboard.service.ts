import { prisma } from '../prisma';

interface DashboardFilters {
  periodo?: string;
  desde?: string;
  hasta?: string;
}

function fechaKey(fecha: Date) {
  const d = new Date(fecha);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
        pagos: { orderBy: { fecha: 'asc' } },
        cliente: true,
        vendedor: true,
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

  const ventasCantidad = ventas.length;
  const ticketMedio = ventasCantidad > 0 ? totalVentas / ventasCantidad : 0;

  // El "metodo de pago" de una venta es el de su pago inicial (el primero
  // registrado); las que todavia no tienen ningun pago (a credito, sin
  // abono aun) no cuentan para el porcentaje de efectivo vs transferencia.
  const ventasEfectivo = ventas
    .filter((v) => v.pagos[0]?.metodoPago === 'efectivo')
    .reduce((acc, v) => acc + Number(v.total), 0);
  const ventasTransferencia = ventas
    .filter((v) => v.pagos[0]?.metodoPago === 'transferencia')
    .reduce((acc, v) => acc + Number(v.total), 0);
  const baseConMetodoPago = ventasEfectivo + ventasTransferencia;
  const porcentajeEfectivo = baseConMetodoPago > 0 ? (ventasEfectivo / baseConMetodoPago) * 100 : 0;

  const productosMasVendidos = ventas.reduce<Record<string, number>>((acc, venta) => {
    venta.items.forEach((item) => {
      const nombre = item.lote.variante.producto.nombre;
      acc[nombre] = (acc[nombre] || 0) + Number(item.cantidad);
    });
    return acc;
  }, {});

  const productosMasVendidosPorValor = ventas.reduce<Record<string, number>>((acc, venta) => {
    venta.items.forEach((item) => {
      const nombre = item.lote.variante.producto.nombre;
      const subtotal = Number(item.cantidad) * Number(item.precioUnitario);
      acc[nombre] = (acc[nombre] || 0) + subtotal;
    });
    return acc;
  }, {});

  const mejoresClientesPorValor = ventas.reduce<Record<string, number>>((acc, venta) => {
    const nombre = venta.cliente.nombre;
    acc[nombre] = (acc[nombre] || 0) + Number(venta.total);
    return acc;
  }, {});

  const ventasPorVendedor = ventas.reduce<Record<string, number>>((acc, venta) => {
    const nombre = venta.vendedor.nombre;
    acc[nombre] = (acc[nombre] || 0) + Number(venta.total);
    return acc;
  }, {});

  // Desglose dia por dia de cada metrica principal, para que el
  // frontend pueda mostrar el detalle al hacer click en una tarjeta.
  interface AcumuladoDia {
    facturacion: number;
    ventasCantidad: number;
    ganancia: number;
    totalCobrado: number;
    gastos: number;
    ventasEfectivo: number;
    ventasTransferencia: number;
  }
  const porDiaMap = new Map<string, AcumuladoDia>();
  function obtenerDia(key: string): AcumuladoDia {
    let dia = porDiaMap.get(key);
    if (!dia) {
      dia = {
        facturacion: 0,
        ventasCantidad: 0,
        ganancia: 0,
        totalCobrado: 0,
        gastos: 0,
        ventasEfectivo: 0,
        ventasTransferencia: 0,
      };
      porDiaMap.set(key, dia);
    }
    return dia;
  }

  for (const venta of ventas) {
    const dia = obtenerDia(fechaKey(venta.fecha));
    dia.facturacion += Number(venta.total);
    dia.ventasCantidad += 1;
    dia.totalCobrado += Number(venta.total) - Number(venta.saldoPendiente);
    dia.ganancia += venta.items.reduce((acc, item) => {
      const subtotal = Number(item.cantidad) * Number(item.precioUnitario);
      const costo = Number(item.cantidad) * Number(item.costoUnitarioSnapshot);
      return acc + (subtotal - costo);
    }, 0);
    const metodo = venta.pagos[0]?.metodoPago;
    if (metodo === 'efectivo') dia.ventasEfectivo += Number(venta.total);
    else if (metodo === 'transferencia') dia.ventasTransferencia += Number(venta.total);
  }
  for (const gasto of gastos) {
    obtenerDia(fechaKey(gasto.fecha)).gastos += Number(gasto.monto);
  }

  const detallePorDia = Array.from(porDiaMap.entries())
    .map(([fecha, d]) => {
      const baseMetodoDia = d.ventasEfectivo + d.ventasTransferencia;
      return {
        fecha,
        facturacion: d.facturacion,
        ventasCantidad: d.ventasCantidad,
        ticketMedio: d.ventasCantidad > 0 ? d.facturacion / d.ventasCantidad : 0,
        ganancia: d.ganancia,
        totalCobrado: d.totalCobrado,
        utilidadNeta: d.ganancia - d.gastos,
        porcentajeEfectivo: baseMetodoDia > 0 ? (d.ventasEfectivo / baseMetodoDia) * 100 : 0,
      };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha)); // mas reciente primero

  return {
    totalVentas,
    totalCobrado,
    utilidadBruta,
    totalGastos,
    utilidadNeta: utilidadBruta - totalGastos,
    ventasCantidad,
    ticketMedio,
    porcentajeEfectivo,
    productosMasVendidos: Object.entries(productosMasVendidos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    productosMasVendidosPorValor: Object.entries(productosMasVendidosPorValor)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    mejoresClientesPorValor: Object.entries(mejoresClientesPorValor)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    ventasPorVendedor: Object.entries(ventasPorVendedor)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    detallePorDia,
  };
}
