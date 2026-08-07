import { prisma } from '../prisma';
import { movimientosInventario } from './inventario.service';

export class CorteYaExisteError extends Error {
  constructor() {
    super('Ya existe un corte de caja para el dia de hoy. Para corregirlo, editalo desde el historico.');
  }
}

function normalizarFecha(fecha: Date) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
}

// Convierte un string "YYYY-MM-DD" (el que mandan los <input type="date">
// del frontend) a medianoche LOCAL de ese dia. Ojo: "new Date('2026-07-30')"
// NO sirve para esto -- un string de solo fecha se interpreta como
// medianoche UTC, y este servidor corre con hora local distinta a UTC
// (Culiacan es UTC-7), asi que al pasar por normalizarFecha (que usa
// setHours en hora LOCAL) el dia se recorria uno hacia atras.
export function fechaLocalDesdeString(fechaStr: string): Date {
  const [anio, mes, dia] = fechaStr.split('-').map(Number);
  return new Date(anio, mes - 1, dia);
}

function finDelDia(inicioDia: Date) {
  const f = new Date(inicioDia);
  f.setHours(23, 59, 59, 999);
  return f;
}

// Orden fijo para agrupar el reporte del corte: primero efectivo, luego
// transferencia, y al final lo que todavia no tiene metodo de pago (a
// credito, sin abono el dia de hoy). Dentro de cada metodo, alfabetico
// por cliente/proveedor.
const ORDEN_METODO_PAGO: Record<string, number> = { efectivo: 0, transferencia: 1 };

function ordenarPorMetodoYNombre<T>(
  items: T[],
  getMetodo: (item: T) => string | null,
  getNombre: (item: T) => string
): T[] {
  return [...items].sort((a, b) => {
    const metodoA = getMetodo(a);
    const metodoB = getMetodo(b);
    const ordenA = metodoA ? ORDEN_METODO_PAGO[metodoA] ?? 2 : 3;
    const ordenB = metodoB ? ORDEN_METODO_PAGO[metodoB] ?? 2 : 3;
    if (ordenA !== ordenB) return ordenA - ordenB;
    return getNombre(a).localeCompare(getNombre(b));
  });
}

function subtotalesPorMetodo<T>(items: T[], getMetodo: (item: T) => string | null, getMonto: (item: T) => number) {
  return items.reduce(
    (acc, item) => {
      const metodo = getMetodo(item);
      if (metodo === 'transferencia') acc.transferencia += getMonto(item);
      else if (metodo === 'efectivo') acc.efectivo += getMonto(item);
      else acc.credito += getMonto(item);
      return acc;
    },
    { efectivo: 0, transferencia: 0, credito: 0 }
  );
}

function sumaPagosPorMetodo(pagos: { metodoPago: string; monto: unknown }[], metodo: string) {
  return pagos
    .filter((p) => p.metodoPago === metodo)
    .reduce((acc, p) => acc + Number(p.monto), 0);
}

/**
 * Utilidad bruta (margen de venta menos costo, por producto) y gastos
 * operativos de un dia especifico. Se usa tanto para la vista previa
 * del corte como para la fotografia que se guarda al cerrarlo.
 */
async function utilidadYGastosDelDia(inicioDia: Date, finDia: Date) {
  const [ventasHoy, gastosHoy] = await Promise.all([
    prisma.venta.findMany({
      where: { fecha: { gte: inicioDia, lte: finDia }, cancelada: false },
      include: { items: true },
    }),
    prisma.gasto.findMany({ where: { fecha: { gte: inicioDia, lte: finDia }, cancelado: false } }),
  ]);

  const utilidadDia = ventasHoy.reduce((acc, v) => {
    const utilidadVenta = v.items.reduce((accItem, item) => {
      const margen =
        (Number(item.precioUnitario) - Number(item.costoUnitarioSnapshot)) * Number(item.cantidad);
      return accItem + margen;
    }, 0);
    return acc + utilidadVenta;
  }, 0);

  const gastosDia = gastosHoy.reduce((acc, g) => acc + Number(g.monto), 0);

  return { utilidadDia, gastosDia };
}

/** Valor del inventario disponible, a costo (cantidad disponible x costo del lote). */
async function valorInventarioActual() {
  const lotes = await prisma.loteInventario.findMany({
    where: { cantidadDisponible: { gt: 0 } },
    select: { cantidadDisponible: true, costoUnitario: true },
  });
  return lotes.reduce((acc, l) => acc + Number(l.cantidadDisponible) * Number(l.costoUnitario), 0);
}

/**
 * Arma la vista previa del corte de un dia: inventario, ventas, compras,
 * gastos, cartera, cuentas por pagar, el DETALLE de cada pago de cliente
 * recibido ese dia, la utilidad del dia, y la balanza (activos menos
 * pasivos: cartera por cobrar + valor de inventario, menos cuentas por
 * pagar). Utilidad y balanza revelan el desempeño del negocio, asi que
 * la ruta las quita de la respuesta si el usuario no tiene permiso.
 */
export async function corteDelDia(fecha: Date) {
  const inicioDia = normalizarFecha(fecha);
  const fin = finDelDia(inicioDia);

  const [
    inventarioMovs,
    ventasHoy,
    comprasHoy,
    gastosHoy,
    pagosClientesHoy,
    pagosProveedoresHoy,
    depositosBancoHoy,
    cartera,
    porPagar,
    saldosInicialesClientes,
    { utilidadDia, gastosDia },
    corteExistente,
    valorInventario,
    corteAnterior,
    ventasCanceladasHoy,
    comprasCanceladasHoy,
    gastosCanceladosHoy,
    configuracion,
  ] = await Promise.all([
    movimientosInventario(inicioDia, fin),
    prisma.venta.findMany({
      where: { fecha: { gte: inicioDia, lte: fin }, cancelada: false },
      include: { cliente: true, vendedor: true, pagos: { orderBy: { fecha: 'asc' } } },
      orderBy: { fecha: 'asc' },
    }),
    prisma.compra.findMany({
      where: { fecha: { gte: inicioDia, lte: fin }, cancelada: false, esCargaInicial: false },
      include: { proveedor: true, pagos: { orderBy: { fecha: 'asc' } } },
      orderBy: { fecha: 'asc' },
    }),
    prisma.gasto.findMany({ where: { fecha: { gte: inicioDia, lte: fin }, cancelado: false } }),
    // Se excluyen los pagos cancelados individualmente (cancelarPagoVenta)
    // Y los pagos de una venta/compra que se cancelo COMPLETA -- si no, el
    // corte los sigue contando como dinero cobrado aunque cancelarVenta/
    // cancelarCompra ya revirtieron ese monto de saldoEfectivo/BancoActual.
    prisma.pagoVenta.findMany({
      where: { fecha: { gte: inicioDia, lte: fin }, cancelado: false, venta: { cancelada: false } },
      include: { venta: { include: { cliente: true } }, registradoPor: true },
      orderBy: { fecha: 'asc' },
    }),
    prisma.pagoCompra.findMany({
      where: { fecha: { gte: inicioDia, lte: fin }, compra: { cancelada: false } },
      include: { compra: { include: { proveedor: true } }, registradoPor: true },
      orderBy: { fecha: 'asc' },
    }),
    prisma.depositoBanco.findMany({
      where: { fecha: { gte: inicioDia, lte: fin }, cancelado: false },
      include: { registradoPor: true },
      orderBy: { fecha: 'asc' },
    }),
    prisma.venta.aggregate({
      where: { estadoPago: { in: ['pendiente', 'parcial'] } },
      _sum: { saldoPendiente: true },
    }),
    prisma.compra.aggregate({
      where: { estadoPago: { in: ['pendiente', 'parcial'] } },
      _sum: { saldoPendiente: true },
    }),
    prisma.cliente.aggregate({ _sum: { saldoInicial: true } }),
    utilidadYGastosDelDia(inicioDia, fin),
    prisma.corteCaja.findUnique({ where: { fecha: inicioDia } }),
    valorInventarioActual(),
    prisma.corteCaja.findFirst({ where: { fecha: { lt: inicioDia } }, orderBy: { fecha: 'desc' } }),
    prisma.venta.findMany({
      where: { cancelada: true, canceladaEn: { gte: inicioDia, lte: fin } },
      include: { cliente: true, canceladaPor: true },
      orderBy: { canceladaEn: 'asc' },
    }),
    prisma.compra.findMany({
      where: { cancelada: true, canceladaEn: { gte: inicioDia, lte: fin } },
      include: { proveedor: true, canceladaPor: true },
      orderBy: { canceladaEn: 'asc' },
    }),
    prisma.gasto.findMany({
      where: { cancelado: true, canceladoEn: { gte: inicioDia, lte: fin } },
      include: { categoria: true, canceladoPor: true },
      orderBy: { canceladoEn: 'asc' },
    }),
    prisma.configuracion.findUnique({ where: { id: 'singleton' } }),
  ]);

  const totalVendido = ventasHoy.reduce((acc, v) => acc + Number(v.total), 0);
  const totalCobrado = ventasHoy.reduce(
    (acc, v) => acc + (Number(v.total) - Number(v.saldoPendiente)),
    0
  );
  const totalComprado = comprasHoy.reduce((acc, c) => acc + Number(c.total), 0);
  const totalGastos = gastosHoy.reduce((acc, g) => acc + Number(g.monto), 0);
  const totalDepositosBanco = depositosBancoHoy.reduce((acc, d) => acc + Number(d.monto), 0);

  // El pago inicial de una venta se puede repartir entre efectivo y
  // transferencia (ej. $500 en efectivo + $300 por transferencia) -- por
  // eso "metodoPago" aqui es una lista ("efectivo, transferencia") para
  // mostrar, mientras que el orden/agrupado usa solo el primer metodo
  // registrado (cosmetico). Las compras siguen siendo de un solo metodo.
  const ventasConMetodo = ventasHoy.map((v) => {
    const efectivo = sumaPagosPorMetodo(v.pagos, 'efectivo');
    const transferencia = sumaPagosPorMetodo(v.pagos, 'transferencia');
    const metodosUsados = [...new Set(v.pagos.map((p) => p.metodoPago))];
    return {
      venta: v,
      metodoPago: metodosUsados.length > 0 ? metodosUsados.join(', ') : null,
      metodoOrden: v.pagos[0]?.metodoPago ?? null,
      efectivo,
      transferencia,
    };
  });
  const comprasConMetodo = comprasHoy.map((c) => ({
    compra: c,
    metodoPago: c.pagos[0]?.metodoPago ?? null,
  }));

  const ventasOrdenadas = ordenarPorMetodoYNombre(
    ventasConMetodo,
    (x) => x.metodoOrden,
    (x) => x.venta.cliente.nombre
  );
  const comprasOrdenadas = ordenarPorMetodoYNombre(
    comprasConMetodo,
    (x) => x.metodoPago,
    (x) => x.compra.proveedor.nombre
  );
  const pagosClientesOrdenados = ordenarPorMetodoYNombre(
    pagosClientesHoy,
    (p) => p.metodoPago,
    (p) => p.venta.cliente.nombre
  );

  // Subtotales por metodo de VENTAS: se calculan del dinero realmente
  // cobrado por cada metodo (no del total de la venta bajo un solo metodo
  // "adivinado"), para que sumen exacto aunque un pago se haya repartido.
  // Lo que falte del total hasta lo cobrado se cuenta como "credito".
  const ventasSubtotalesPorMetodo = ventasConMetodo.reduce(
    (acc, x) => {
      acc.efectivo += x.efectivo;
      acc.transferencia += x.transferencia;
      acc.credito += Number(x.venta.total) - x.efectivo - x.transferencia;
      return acc;
    },
    { efectivo: 0, transferencia: 0, credito: 0 }
  );
  const comprasSubtotalesPorMetodo = subtotalesPorMetodo(
    comprasConMetodo,
    (x) => x.metodoPago,
    (x) => Number(x.compra.total)
  );

  const totalPagosClientes = pagosClientesHoy.reduce((acc, p) => acc + Number(p.monto), 0);
  const pagosClientesEfectivo = pagosClientesHoy
    .filter((p) => p.metodoPago === 'efectivo')
    .reduce((acc, p) => acc + Number(p.monto), 0);
  const pagosClientesTransferencia = pagosClientesHoy
    .filter((p) => p.metodoPago === 'transferencia')
    .reduce((acc, p) => acc + Number(p.monto), 0);

  const totalPagosProveedores = pagosProveedoresHoy.reduce((acc, p) => acc + Number(p.monto), 0);
  const pagosProveedoresEfectivo = pagosProveedoresHoy
    .filter((p) => p.metodoPago === 'efectivo')
    .reduce((acc, p) => acc + Number(p.monto), 0);
  const pagosProveedoresTransferencia = pagosProveedoresHoy
    .filter((p) => p.metodoPago === 'transferencia')
    .reduce((acc, p) => acc + Number(p.monto), 0);

  const carteraPendiente =
    Number(cartera._sum.saldoPendiente ?? 0) + Number(saldosInicialesClientes._sum.saldoInicial ?? 0);
  const cuentasPorPagar = Number(porPagar._sum.saldoPendiente ?? 0);

  // OJO: aqui todavia no se puede calcular la balanza completa de hoy --
  // le faltan el efectivo y el banco, que el usuario apenas va a contar.
  // El frontend calcula esa balanza en vivo, mientras el usuario escribe,
  // usando estos mismos numeros (cartera, valorInventario, cuentasPorPagar)
  // mas lo que vaya tecleando.
  const balanzaAyer = corteAnterior ? Number(corteAnterior.balanzaTotal) : null;
  const balanzaEsperada = balanzaAyer !== null ? balanzaAyer + utilidadDia - gastosDia : null;

  return {
    yaExisteCorteHoy: !!corteExistente,
    // Si este dia ya tiene un corte guardado, se incluyen tambien
    // utilidadDia/valorInventario/balanzaTotal tal como quedaron
    // capturados ESE dia -- necesarios para que "Utilidad y balanza" al
    // reimprimir un corte pasado muestre lo mismo que el historico, en
    // vez de recalcular con el valor de inventario y cartera de HOY
    // (que ya cambiaron desde entonces).
    corteExistente: corteExistente
      ? {
          id: corteExistente.id,
          efectivoContado: Number(corteExistente.efectivoContado),
          saldoBancoContado: Number(corteExistente.saldoBancoContado),
          utilidadDia: Number(corteExistente.utilidadDia),
          valorInventario: Number(corteExistente.valorInventario),
          balanzaTotal: Number(corteExistente.balanzaTotal),
        }
      : null,
    inventario: inventarioMovs,
    ventas: {
      total: totalVendido,
      cobrado: totalCobrado,
      cantidad: ventasHoy.length,
      subtotalesPorMetodo: ventasSubtotalesPorMetodo,
      detalle: ventasOrdenadas.map(({ venta: v, metodoPago, efectivo, transferencia }) => ({
        id: v.id,
        folio: v.folio,
        cliente: v.cliente.nombre,
        vendedor: v.vendedor.nombre,
        total: Number(v.total),
        saldoPendiente: Number(v.saldoPendiente),
        estadoPago: v.estadoPago,
        metodoPago,
        // Cuanto de esta venta especificamente se pago con cada metodo --
        // relevante cuando el pago se repartio (ej. $30 efectivo + $28
        // transferencia en la misma nota).
        montoEfectivo: efectivo,
        montoTransferencia: transferencia,
        fecha: v.fecha,
      })),
    },
    compras: {
      total: totalComprado,
      cantidad: comprasHoy.length,
      subtotalesPorMetodo: comprasSubtotalesPorMetodo,
      detalle: comprasOrdenadas.map(({ compra: c, metodoPago }) => ({
        id: c.id,
        numeroFactura: c.numeroFactura,
        proveedor: c.proveedor.nombre,
        total: Number(c.total),
        saldoPendiente: Number(c.saldoPendiente),
        estadoPago: c.estadoPago,
        metodoPago,
        fecha: c.fecha,
      })),
    },
    gastos: { total: totalGastos, cantidad: gastosHoy.length },
    pagosClientes: {
      total: totalPagosClientes,
      efectivo: pagosClientesEfectivo,
      transferencia: pagosClientesTransferencia,
      cantidad: pagosClientesHoy.length,
      detalle: pagosClientesOrdenados.map((p) => ({
        id: p.id,
        folio: p.venta.folio,
        cliente: p.venta.cliente.nombre,
        monto: Number(p.monto),
        metodoPago: p.metodoPago,
        fecha: p.fecha,
        registradoPor: p.registradoPor?.nombre ?? 'Registro anterior',
      })),
    },
    pagosProveedores: {
      total: totalPagosProveedores,
      efectivo: pagosProveedoresEfectivo,
      transferencia: pagosProveedoresTransferencia,
      cantidad: pagosProveedoresHoy.length,
      detalle: pagosProveedoresHoy.map((p) => ({
        id: p.id,
        proveedor: p.compra.proveedor.nombre,
        numeroFactura: p.compra.numeroFactura,
        monto: Number(p.monto),
        metodoPago: p.metodoPago,
        fecha: p.fecha,
        registradoPor: p.registradoPor?.nombre ?? 'Registro anterior',
      })),
    },
    depositosBanco: {
      total: totalDepositosBanco,
      cantidad: depositosBancoHoy.length,
      detalle: depositosBancoHoy.map((d) => ({
        id: d.id,
        monto: Number(d.monto),
        notas: d.notas,
        fecha: d.fecha,
        registradoPor: d.registradoPor?.nombre ?? 'Registro anterior',
      })),
    },
    cartera: carteraPendiente,
    cuentasPorPagar,
    saldoBancoSistema: configuracion ? Number(configuracion.saldoBancoActual) : 0,
    saldoEfectivoSistema: configuracion ? Number(configuracion.saldoEfectivoActual) : 0,
    canceladas: {
      ventas: ventasCanceladasHoy.map((v) => ({
        id: v.id,
        folio: v.folio,
        cliente: v.cliente.nombre,
        total: Number(v.total),
        fechaOriginal: v.fecha,
        canceladaEn: v.canceladaEn,
        canceladaPor: v.canceladaPor?.nombre ?? '—',
      })),
      compras: comprasCanceladasHoy.map((c) => ({
        id: c.id,
        numeroFactura: c.numeroFactura,
        proveedor: c.proveedor.nombre,
        total: Number(c.total),
        fechaOriginal: c.fecha,
        canceladaEn: c.canceladaEn,
        canceladaPor: c.canceladaPor?.nombre ?? '—',
      })),
      gastos: gastosCanceladosHoy.map((g) => ({
        id: g.id,
        concepto: g.concepto,
        categoria: g.categoria.nombre,
        total: Number(g.monto),
        fechaOriginal: g.fecha,
        canceladoEn: g.canceladoEn,
        canceladoPor: g.canceladoPor?.nombre ?? '—',
      })),
    },
    // Los siguientes campos revelan la utilidad y el balance del negocio;
    // la ruta los quita de la respuesta si el usuario no tiene permiso.
    // balanzaTotal y diferenciaCuadre NO van aqui -- todavia no se sabe
    // cuanto hay en efectivo/banco (el usuario apenas los va a contar),
    // asi que el frontend los calcula en vivo con lo que vaya escribiendo,
    // usando estos mismos numeros (cartera, valorInventario, cuentasPorPagar).
    utilidadDia,
    valorInventario,
    balanzaAyer,
    balanzaEsperada,
  };
}

/**
 * Guarda el corte de caja del dia de HOY. Solo se permite uno por dia:
 * si ya existe, hay que corregirlo desde el historico en vez de crear
 * uno nuevo (esto tambien esta protegido por un unique constraint en
 * la base de datos, como segunda linea de defensa).
 */
export async function guardarCorteCaja(
  registradoPorId: string,
  efectivoContado: number,
  saldoBancoContado: number,
  fechaCorte?: Date
) {
  const hoy = normalizarFecha(fechaCorte ?? new Date());
  const fin = finDelDia(hoy);

  const existente = await prisma.corteCaja.findUnique({ where: { fecha: hoy } });
  if (existente) {
    throw new CorteYaExisteError();
  }

  const [{ utilidadDia, gastosDia }, valorInventario, cartera, porPagar, saldosInicialesClientes] = await Promise.all([
    utilidadYGastosDelDia(hoy, fin),
    valorInventarioActual(),
    prisma.venta.aggregate({
      where: { estadoPago: { in: ['pendiente', 'parcial'] } },
      _sum: { saldoPendiente: true },
    }),
    prisma.compra.aggregate({
      where: { estadoPago: { in: ['pendiente', 'parcial'] } },
      _sum: { saldoPendiente: true },
    }),
    prisma.cliente.aggregate({ _sum: { saldoInicial: true } }),
  ]);

  const carteraPendiente =
    Number(cartera._sum.saldoPendiente ?? 0) + Number(saldosInicialesClientes._sum.saldoInicial ?? 0);
  const cuentasPorPagar = Number(porPagar._sum.saldoPendiente ?? 0);
  // La balanza es TODOS los activos menos TODOS los pasivos: lo que hay
  // en efectivo y en el banco (lo que se acaba de contar), mas lo que
  // deben los clientes, mas el valor del inventario a costo, menos lo
  // que se le debe a los proveedores.
  const balanzaTotal =
    efectivoContado + saldoBancoContado + carteraPendiente + valorInventario - cuentasPorPagar;

  try {
    return await prisma.corteCaja.create({
      data: {
        registradoPorId,
        fecha: hoy,
        efectivoContado,
        saldoBancoContado,
        utilidadDia,
        gastosDia,
        valorInventario,
        balanzaTotal,
      },
    });
  } catch (err: any) {
    // P2002 = violacion de unique constraint (por si dos personas
    // intentaron guardar el corte de hoy casi al mismo tiempo).
    if (err.code === 'P2002') {
      throw new CorteYaExisteError();
    }
    throw err;
  }
}

/** Historico de cortes, mas reciente primero, con el cuadre de cada uno contra el anterior. */
export async function listarCortes() {
  const cortes = await prisma.corteCaja.findMany({
    include: { registradoPor: true },
    orderBy: { fecha: 'asc' }, // ascendente para poder comparar cada uno con el anterior
  });

  let balanzaPrevia: number | null = null;

  const mapeados = cortes.map((c) => {
    const utilidadDia = Number(c.utilidadDia);
    const gastosDia = Number(c.gastosDia);
    const balanzaTotal = Number(c.balanzaTotal);

    const balanzaEsperada = balanzaPrevia !== null ? balanzaPrevia + utilidadDia - gastosDia : null;
    const diferenciaCuadre = balanzaEsperada !== null ? balanzaTotal - balanzaEsperada : null;

    balanzaPrevia = balanzaTotal;

    return {
      id: c.id,
      fecha: c.fecha,
      efectivoContado: Number(c.efectivoContado),
      saldoBancoContado: Number(c.saldoBancoContado),
      utilidadDia,
      gastosDia,
      valorInventario: Number(c.valorInventario),
      balanzaTotal,
      balanzaEsperada,
      diferenciaCuadre,
      registradoPor: c.registradoPor.nombre,
      actualizadoEn: c.actualizadoEn,
    };
  });

  return mapeados.reverse(); // mas reciente primero, como antes
}

/**
 * Corrige un corte ya guardado (por si se contó mal el efectivo o el
 * banco). Solo se permite ajustar esos dos campos -- utilidad, gastos y
 * balanza quedan como la fotografia calculada el dia que se cerro, no
 * se recalculan con esta correccion.
 */
export async function actualizarCorteCaja(
  id: string,
  efectivoContado: number,
  saldoBancoContado: number
) {
  return prisma.corteCaja.update({
    where: { id },
    data: { efectivoContado, saldoBancoContado },
  });
}

/**
 * Elimina un corte de caja ya guardado. Solo administrador -- borrar un
 * corte cambia contra que se compara el dia siguiente en el cuadre, asi
 * que hay que usarlo con cuidado (por ejemplo, si se capturo con la
 * fecha equivocada y se quiere volver a hacer bien).
 */
export async function eliminarCorteCaja(id: string) {
  await prisma.corteCaja.delete({ where: { id } });
}
