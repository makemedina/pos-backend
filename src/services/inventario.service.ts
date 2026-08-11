import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';
import { fechaLocalDesdeString } from '../utils/fecha';

// A partir de cuantos dias en stock un lote se considera critico (viejo).
export const DIAS_CRITICO_ANTIGUEDAD = 15;

interface CrearAjusteInput {
  loteId: string;
  solicitadoPorId: string;
  autorizadoPorTelefono: string; // telefono del autorizador (mas facil de dictar que un ID)
  autorizadoPin: string;         // PIN de ese usuario, se valida contra su hash real
  tipo: 'merma' | 'correccion_positiva' | 'correccion_negativa';
  cantidad: number; // siempre positivo, el "tipo" define si suma o resta
  motivo: string;
}

/**
 * Registra un ajuste manual de inventario. Requiere autorizadoPorTelefono +
 * autorizadoPin, y ambos se verifican aqui mismo contra un usuario real
 * con el switch puedeAutorizar (o rol administrador) -- antes este
 * servicio confiaba en que "ya se habia autorizado en otro lado", pero
 * no existia ningun lugar donde eso realmente se verificara.
 */
export class AutorizacionInvalidaError extends Error {
  constructor() {
    super('Autorizacion invalida: el telefono no corresponde a un autorizador, o el PIN no coincide');
  }
}

/**
 * Lista los lotes de una variante, mas reciente primero, para que el
 * usuario elija sobre cual lote especifico hacer el ajuste (la merma o
 * correccion siempre es sobre un lote concreto, con su propio costo).
 */
export async function lotesDeVariante(varianteId: string) {
  const lotes = await prisma.loteInventario.findMany({
    where: { varianteId, compra: { cancelada: false } },
    orderBy: { fechaIngreso: 'desc' },
    take: 20,
  });

  return lotes.map((l) => ({
    id: l.id,
    costoUnitario: Number(l.costoUnitario),
    cantidadInicial: Number(l.cantidadInicial),
    cantidadDisponible: Number(l.cantidadDisponible),
    fechaIngreso: l.fechaIngreso,
  }));
}

export class StockInsuficienteParaAjusteError extends Error {
  constructor(disponible: number, solicitado: number) {
    super(`No se puede dar de baja ${solicitado}kg: el lote solo tiene ${disponible}kg disponibles`);
  }
}

export async function crearAjusteInventario(input: CrearAjusteInput) {
  const autorizadoPorId = await verificarAutorizadorPorTelefono(
    input.autorizadoPorTelefono,
    input.autorizadoPin
  );
  if (!autorizadoPorId) {
    throw new AutorizacionInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    const lote = await tx.loteInventario.findUniqueOrThrow({
      where: { id: input.loteId },
    });

    const costo = Number(lote.costoUnitario);
    const esSalida = input.tipo === 'merma' || input.tipo === 'correccion_negativa';
    const disponible = Number(lote.cantidadDisponible);

    // No se puede dar de baja mas de lo que hay -- misma regla que en
    // ventas ("no se permite vender en negativo"), aqui aplicada a mermas
    // y correcciones negativas.
    if (esSalida && input.cantidad > disponible) {
      throw new StockInsuficienteParaAjusteError(disponible, input.cantidad);
    }

    const impactoUtilidad = esSalida ? -(input.cantidad * costo) : input.cantidad * costo;

    await tx.loteInventario.update({
      where: { id: input.loteId },
      data: {
        cantidadDisponible: esSalida
          ? { decrement: input.cantidad }
          : { increment: input.cantidad },
      },
    });

    return tx.ajusteInventario.create({
      data: {
        loteId: input.loteId,
        solicitadoPorId: input.solicitadoPorId,
        autorizadoPorId,
        tipo: input.tipo,
        cantidad: input.cantidad,
        motivo: input.motivo,
        impactoUtilidad,
      },
    });
  });
}

/** Reporte de entradas/salidas de inventario en un rango de fechas (agregado, usado por el corte del dia). */
export async function movimientosInventario(desde: Date, hasta: Date) {
  const [compras, ventas, ajustes] = await Promise.all([
    prisma.loteInventario.findMany({
      where: { fechaIngreso: { gte: desde, lte: hasta }, compra: { cancelada: false } },
      include: { variante: { include: { producto: true } } },
    }),
    prisma.ventaItem.findMany({
      where: { venta: { fecha: { gte: desde, lte: hasta }, cancelada: false } },
      include: { lote: { include: { variante: { include: { producto: true } } } } },
    }),
    prisma.ajusteInventario.findMany({
      where: { fecha: { gte: desde, lte: hasta } },
      include: { lote: { include: { variante: { include: { producto: true } } } } },
    }),
  ]);

  const entradasKg = compras.reduce((acc, l) => acc + Number(l.cantidadInicial), 0);
  const entradasValor = compras.reduce(
    (acc, l) => acc + Number(l.cantidadInicial) * Number(l.costoUnitario),
    0
  );
  const salidasKg = ventas.reduce((acc, v) => acc + Number(v.cantidad), 0);
  const salidasValor = ventas.reduce(
    (acc, v) => acc + Number(v.cantidad) * Number(v.costoUnitarioSnapshot),
    0
  );
  const mermaKg = ajustes
    .filter((a) => a.tipo === 'merma')
    .reduce((acc, a) => acc + Number(a.cantidad), 0);
  const mermaValor = ajustes
    .filter((a) => a.tipo === 'merma')
    .reduce((acc, a) => acc - Number(a.impactoUtilidad), 0);

  return {
    entradas: { kg: entradasKg, valor: entradasValor, movimientos: compras.length },
    salidas: { kg: salidasKg, valor: salidasValor, movimientos: ventas.length },
    merma: { kg: mermaKg, valor: mermaValor },
  };
}

interface FiltrosMovimientosDetalle {
  periodo?: string; // dia | semana | mes | anio | rango
  desde?: string;
  hasta?: string;
  productoId?: string;
}

function obtenerRangoFechas(periodo: string, desde?: string, hasta?: string) {
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

export interface MovimientoInventarioDetalle {
  tipo: 'entrada' | 'salida' | 'merma' | 'correccion_positiva' | 'correccion_negativa';
  id: string;
  fecha: Date;
  producto: string;
  marca: string;
  cantidad: number; // positivo = suma al inventario, negativo = resta
  valor: number;    // mismo signo que cantidad, a costo
  referencia: string;
}

/**
 * Reporte DETALLADO de movimientos de inventario: cada entrada (compra),
 * salida (venta), merma y correccion, uno por uno, con su producto,
 * cantidad, valor y referencia -- a diferencia de movimientosInventario()
 * que solo da totales agregados (usado por el corte del dia).
 */
export async function detalleMovimientosInventario(filtros: FiltrosMovimientosDetalle) {
  const { inicio: desde, fin: hasta } = obtenerRangoFechas(filtros.periodo || 'todos', filtros.desde, filtros.hasta);
  const { productoId } = filtros;

  const [compras, ventas, ajustes] = await Promise.all([
    prisma.loteInventario.findMany({
      where: {
        fechaIngreso: { gte: desde, lte: hasta },
        compra: { cancelada: false },
        ...(productoId ? { variante: { productoId } } : {}),
      },
      include: { variante: { include: { producto: true } }, compra: { include: { proveedor: true } } },
    }),
    prisma.ventaItem.findMany({
      where: {
        venta: { fecha: { gte: desde, lte: hasta }, cancelada: false },
        ...(productoId ? { lote: { variante: { productoId } } } : {}),
      },
      include: {
        lote: { include: { variante: { include: { producto: true } } } },
        venta: { include: { cliente: true } },
      },
    }),
    prisma.ajusteInventario.findMany({
      where: {
        fecha: { gte: desde, lte: hasta },
        ...(productoId ? { lote: { variante: { productoId } } } : {}),
      },
      include: { lote: { include: { variante: { include: { producto: true } } } } },
    }),
  ]);

  const movimientos: MovimientoInventarioDetalle[] = [
    ...compras.map((l) => ({
      tipo: 'entrada' as const,
      id: l.id,
      fecha: l.fechaIngreso,
      producto: l.variante.producto.nombre,
      marca: l.variante.marca,
      cantidad: Number(l.cantidadInicial),
      valor: Number(l.cantidadInicial) * Number(l.costoUnitario),
      referencia: `Compra a ${l.compra.proveedor.nombre}`,
    })),
    ...ventas.map((v) => ({
      tipo: 'salida' as const,
      id: v.id,
      fecha: v.venta.fecha,
      producto: v.lote.variante.producto.nombre,
      marca: v.lote.variante.marca,
      cantidad: -Number(v.cantidad),
      valor: -(Number(v.cantidad) * Number(v.costoUnitarioSnapshot)),
      referencia: `Venta #${v.venta.folio} - ${v.venta.cliente.nombre}`,
    })),
    ...ajustes.map((a) => {
      const esSalida = a.tipo === 'merma' || a.tipo === 'correccion_negativa';
      return {
        tipo: a.tipo as 'merma' | 'correccion_positiva' | 'correccion_negativa',
        id: a.id,
        fecha: a.fecha,
        producto: a.lote.variante.producto.nombre,
        marca: a.lote.variante.marca,
        cantidad: (esSalida ? -1 : 1) * Number(a.cantidad),
        valor: Number(a.impactoUtilidad),
        referencia: a.motivo,
      };
    }),
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

  const resumen = {
    entradasKg: movimientos.filter((m) => m.tipo === 'entrada').reduce((acc, m) => acc + m.cantidad, 0),
    entradasValor: movimientos.filter((m) => m.tipo === 'entrada').reduce((acc, m) => acc + m.valor, 0),
    salidasKg: -movimientos.filter((m) => m.tipo === 'salida').reduce((acc, m) => acc + m.cantidad, 0),
    salidasValor: -movimientos.filter((m) => m.tipo === 'salida').reduce((acc, m) => acc + m.valor, 0),
    mermaKg: -movimientos.filter((m) => m.tipo === 'merma').reduce((acc, m) => acc + m.cantidad, 0),
    mermaValor: -movimientos.filter((m) => m.tipo === 'merma').reduce((acc, m) => acc + m.valor, 0),
    correccionNetaKg: movimientos
      .filter((m) => m.tipo === 'correccion_positiva' || m.tipo === 'correccion_negativa')
      .reduce((acc, m) => acc + m.cantidad, 0),
    correccionNetaValor: movimientos
      .filter((m) => m.tipo === 'correccion_positiva' || m.tipo === 'correccion_negativa')
      .reduce((acc, m) => acc + m.valor, 0),
  };

  return { resumen, movimientos };
}

export interface LoteAntiguo {
  id: string;
  producto: string;
  marca: string;
  proveedor: string;
  cantidadDisponible: number;
  costoUnitario: number;
  valorEnStock: number;
  fechaIngreso: Date;
  diasEnStock: number;
  critico: boolean;
}

/**
 * Reporte de antiguedad de stock: todos los lotes que todavia tienen
 * cantidad disponible, ordenados del mas viejo al mas nuevo, marcando
 * "critico" a los que llevan mas de DIAS_CRITICO_ANTIGUEDAD dias sin
 * venderse -- mercancia que se queda parada es la que se echa a perder o
 * pierde valor primero.
 */
export async function reporteAntiguedadStock(): Promise<LoteAntiguo[]> {
  const lotes = await prisma.loteInventario.findMany({
    where: { cantidadDisponible: { gt: 0 }, compra: { cancelada: false } },
    include: { variante: { include: { producto: true } }, compra: { include: { proveedor: true } } },
    orderBy: { fechaIngreso: 'asc' },
  });

  const ahora = Date.now();
  const unDiaMs = 1000 * 60 * 60 * 24;

  return lotes.map((l) => {
    const diasEnStock = Math.floor((ahora - l.fechaIngreso.getTime()) / unDiaMs);
    const cantidadDisponible = Number(l.cantidadDisponible);
    const costoUnitario = Number(l.costoUnitario);
    return {
      id: l.id,
      producto: l.variante.producto.nombre,
      marca: l.variante.marca,
      proveedor: l.compra.proveedor.nombre,
      cantidadDisponible,
      costoUnitario,
      valorEnStock: cantidadDisponible * costoUnitario,
      fechaIngreso: l.fechaIngreso,
      diasEnStock,
      critico: diasEnStock > DIAS_CRITICO_ANTIGUEDAD,
    };
  });
}
