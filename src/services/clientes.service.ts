import { prisma } from '../prisma';

export class ClienteConInformacionLigadaError extends Error {
  constructor(ventas: number, cotizaciones: number, tieneSaldoInicial: boolean) {
    const partes: string[] = [];
    if (ventas > 0) partes.push(`${ventas} venta${ventas === 1 ? '' : 's'}`);
    if (cotizaciones > 0) partes.push(`${cotizaciones} cotizacion${cotizaciones === 1 ? '' : 'es'}`);
    if (tieneSaldoInicial) partes.push('saldo inicial de cartera');
    super(
      `Este cliente tiene ${partes.join(' y ')} registrado(s) y no se puede eliminar. ` +
        'Si ya no lo usas, puedes dejarlo así o cambiarle el nombre.'
    );
  }
}

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

interface DireccionInput {
  calle?: string;
  colonia?: string;
  ciudad?: string;
  estado?: string;
  codigoPostal?: string;
  calleEntrega?: string;
  coloniaEntrega?: string;
  ciudadEntrega?: string;
  estadoEntrega?: string;
  codigoPostalEntrega?: string;
}

/** Alta completa desde la pantalla de Clientes (con domicilio opcional, separado por partes). */
export async function crearCliente(
  datos: { nombre: string; telefono: string; nombreContacto?: string } & DireccionInput
) {
  return prisma.cliente.create({
    data: {
      nombre: datos.nombre,
      nombreContacto: datos.nombreContacto || undefined,
      telefono: datos.telefono,
      calle: datos.calle || undefined,
      colonia: datos.colonia || undefined,
      ciudad: datos.ciudad || undefined,
      estado: datos.estado || undefined,
      codigoPostal: datos.codigoPostal || undefined,
      calleEntrega: datos.calleEntrega || undefined,
      coloniaEntrega: datos.coloniaEntrega || undefined,
      ciudadEntrega: datos.ciudadEntrega || undefined,
      estadoEntrega: datos.estadoEntrega || undefined,
      codigoPostalEntrega: datos.codigoPostalEntrega || undefined,
    },
  });
}

/**
 * Alta masiva: crea un cliente por cada nombre de la lista, sin telefono
 * (se puede agregar despues desde el detalle del cliente). No se hace
 * ninguna deduplicacion automatica -- si dos nombres son parecidos pero
 * no identicos, se crean ambos, para no arriesgar fusionar por error dos
 * clientes distintos.
 */
export async function importarClientes(nombres: string[]) {
  const nombresLimpios = nombres.map((n) => n.trim()).filter((n) => n.length > 0);

  const creados = await prisma.$transaction(
    nombresLimpios.map((nombre) =>
      prisma.cliente.create({ data: { nombre, telefono: '' } })
    )
  );

  return { creados: creados.length };
}

/**
 * Pone el saldo inicial (deuda heredada de antes de usar el sistema) a
 * un grupo de clientes existentes, buscandolos por nombre exacto
 * (sin distinguir mayusculas/minusculas). Los nombres que no encuentren
 * coincidencia se regresan en "noEncontrados" para que el usuario los
 * revise (puede ser un typo o que ese cliente no se haya importado).
 */
/**
 * Carga la deuda heredada de antes de usar el sistema como una NOTA real
 * (una Venta a credito, sin productos/items -- una venta puede existir
 * sin ellos, igual que una compra puede existir sin lotes). Asi se le
 * puede ir abonando desde Cartera como a cualquier otra nota, con su
 * propio folio.
 *
 * Se le puede dar una fecha anterior a proposito (por default, ayer)
 * para que no se cuente como "venta de hoy" en el primer corte de caja
 * que se haga despues de cargar los saldos.
 */
export async function cargarSaldosIniciales(
  filas: { nombre: string; saldo: number }[],
  registradoPorId: string,
  fecha?: Date
) {
  const fechaCarga = fecha ?? (() => {
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    return ayer;
  })();

  const actualizados: string[] = [];
  const noEncontrados: string[] = [];

  for (const fila of filas) {
    const cliente = await prisma.cliente.findFirst({
      where: { nombre: { equals: fila.nombre.trim(), mode: 'insensitive' } },
    });

    if (!cliente) {
      noEncontrados.push(fila.nombre);
      continue;
    }

    await prisma.venta.create({
      data: {
        clienteId: cliente.id,
        vendedorId: registradoPorId,
        fecha: fechaCarga,
        total: fila.saldo,
        saldoPendiente: fila.saldo,
        esCredito: true,
        estadoPago: 'pendiente',
      },
    });
    actualizados.push(cliente.nombre);
  }

  return { actualizados, noEncontrados };
}

/**
 * Migracion de un solo uso: convierte el saldoInicial (el mecanismo
 * viejo, un simple numero en el cliente) en una nota real -- para los
 * clientes a los que ya se les habia cargado saldo con la version
 * anterior de esta herramienta, antes de que se volviera una nota de
 * verdad.
 */
export async function migrarSaldoInicialANotas(registradoPorId: string, fecha?: Date) {
  const fechaCarga = fecha ?? (() => {
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    return ayer;
  })();

  const clientes = await prisma.cliente.findMany({ where: { saldoInicial: { gt: 0 } } });
  const migrados: string[] = [];

  for (const cliente of clientes) {
    const saldo = Number(cliente.saldoInicial);
    await prisma.$transaction([
      prisma.venta.create({
        data: {
          clienteId: cliente.id,
          vendedorId: registradoPorId,
          fecha: fechaCarga,
          total: saldo,
          saldoPendiente: saldo,
          esCredito: true,
          estadoPago: 'pendiente',
        },
      }),
      prisma.cliente.update({ where: { id: cliente.id }, data: { saldoInicial: 0 } }),
    ]);
    migrados.push(cliente.nombre);
  }

  return { migrados };
}

function calcularSaldoTotal(ventas: { esCredito: boolean; saldoPendiente: any }[], saldoInicial: any = 0) {
  // Cuenta las notas a credito, y tambien las de contado que quedaron con
  // saldo a favor (saldoPendiente negativo) por un sobrepago -- ese
  // excedente tambien debe reflejarse en el saldo total del cliente.
  const deVentas = ventas
    .filter((v) => v.esCredito || Number(v.saldoPendiente) < 0)
    .reduce((acc, v) => acc + Number(v.saldoPendiente), 0);
  return deVentas + Number(saldoInicial);
}

/**
 * Lista TODOS los clientes (no solo los que tienen credito activo, a
 * diferencia de la Cartera), con su saldo total, y permite filtrar por
 * si tienen deuda o no.
 */
const DIAS_ACTIVO = 30;

export async function listarClientesConSaldo(filtro: 'todos' | 'conDeuda' | 'sinDeuda') {
  const clientes = await prisma.cliente.findMany({
    include: {
      ventas: {
        select: { esCredito: true, saldoPendiente: true, fecha: true, cancelada: true, _count: { select: { items: true } } },
      },
    },
    orderBy: { nombre: 'asc' },
  });

  const limiteActivo = new Date();
  limiteActivo.setDate(limiteActivo.getDate() - DIAS_ACTIVO);

  const mapeados = clientes.map((c) => {
    // "Activo" = compro algo (venta con al menos un producto, no
    // cancelada) en los ultimos 30 dias. Las notas de saldo heredado
    // (carga inicial de deuda de antes de usar el sistema) no cuentan --
    // esas se crean sin ningun VentaItem, no son una compra real, y su
    // fecha esta puesta a proposito uno o mas dias atras.
    const ventasReales = c.ventas.filter((v) => !v.cancelada && v._count.items > 0);
    const ultimaCompra = ventasReales.reduce<Date | null>(
      (max, v) => (!max || v.fecha > max ? v.fecha : max),
      null
    );
    return {
      id: c.id,
      nombre: c.nombre,
      nombreContacto: c.nombreContacto,
      telefono: c.telefono,
      calle: c.calle,
      colonia: c.colonia,
      ciudad: c.ciudad,
      estado: c.estado,
      codigoPostal: c.codigoPostal,
      calleEntrega: c.calleEntrega,
      coloniaEntrega: c.coloniaEntrega,
      ciudadEntrega: c.ciudadEntrega,
      estadoEntrega: c.estadoEntrega,
      codigoPostalEntrega: c.codigoPostalEntrega,
      permiteVentaCredito: c.permiteVentaCredito,
      saldoInicial: Number(c.saldoInicial),
      saldoTotal: calcularSaldoTotal(c.ventas, c.saldoInicial),
      ultimaCompra,
      activo: !!ultimaCompra && ultimaCompra >= limiteActivo,
    };
  });

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
    nombreContacto: cliente.nombreContacto,
    telefono: cliente.telefono,
    calle: cliente.calle,
    colonia: cliente.colonia,
    ciudad: cliente.ciudad,
    estado: cliente.estado,
    codigoPostal: cliente.codigoPostal,
    calleEntrega: cliente.calleEntrega,
    coloniaEntrega: cliente.coloniaEntrega,
    ciudadEntrega: cliente.ciudadEntrega,
    estadoEntrega: cliente.estadoEntrega,
    codigoPostalEntrega: cliente.codigoPostalEntrega,
    permiteVentaCredito: cliente.permiteVentaCredito,
    saldoInicial: Number(cliente.saldoInicial),
    saldoTotal: calcularSaldoTotal(cliente.ventas, cliente.saldoInicial),
    diasLlamada: cliente.diasLlamada,
  };
}

interface ActualizarClienteInput extends DireccionInput {
  nombre?: string;
  nombreContacto?: string;
  telefono?: string;
  permiteVentaCredito?: boolean;
}

export async function actualizarCliente(clienteId: string, datos: ActualizarClienteInput) {
  return prisma.cliente.update({ where: { id: clienteId }, data: datos });
}

/**
 * Elimina un cliente DE VERDAD (a diferencia de "cancelar", que solo
 * marca un registro). Solo se permite si no tiene ventas, cotizaciones ni
 * saldo inicial de cartera -- si tiene algo de eso, se advierte en vez de
 * borrarlo (borrarlo de todos modos dejaria huerfanas esas ventas/notas).
 */
export async function eliminarCliente(clienteId: string) {
  const [ventas, cotizaciones, cliente] = await Promise.all([
    prisma.venta.count({ where: { clienteId } }),
    prisma.cotizacion.count({ where: { clienteId } }),
    prisma.cliente.findUniqueOrThrow({ where: { id: clienteId } }),
  ]);
  const tieneSaldoInicial = Number(cliente.saldoInicial) !== 0;

  if (ventas > 0 || cotizaciones > 0 || tieneSaldoInicial) {
    throw new ClienteConInformacionLigadaError(ventas, cotizaciones, tieneSaldoInicial);
  }

  await prisma.cliente.delete({ where: { id: clienteId } });
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

/**
 * Ultimo precio que se le vendio a este cliente de cada variante (por
 * varianteId, la mas reciente primero). Se usa para sugerir precio al
 * armar una venta nueva -- si el cliente ya compro ese producto antes,
 * ModalAgregarProducto parte de ese precio en vez del precio de lista.
 */
export async function ultimosPreciosCliente(clienteId: string) {
  const ventas = await prisma.venta.findMany({
    where: { clienteId, cancelada: false },
    include: { items: { include: { lote: { select: { varianteId: true } } } } },
    orderBy: { fecha: 'desc' },
  });

  const resultado: Record<string, { precioUnitario: number; fecha: Date }> = {};
  for (const venta of ventas) {
    for (const item of venta.items) {
      const varianteId = item.lote.varianteId;
      if (!(varianteId in resultado)) {
        resultado[varianteId] = { precioUnitario: Number(item.precioUnitario), fecha: venta.fecha };
      }
    }
  }
  return resultado;
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
      cancelado: p.cancelado,
    })),
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

  const saldoTotal = calcularSaldoTotal(
    ventas.map((v) => ({ esCredito: v.esCredito, saldoPendiente: v.saldoPendiente }))
  );

  return { saldoTotal, movimientos };
}

// ---------- AGENDA DE LLAMADAS ----------

function normalizarFecha(fecha: Date) {
  const f = new Date(fecha);
  f.setHours(0, 0, 0, 0);
  return f;
}

const MIN_VENTAS_PARA_SUGERENCIA = 3;
const MIN_REPETICIONES_DIA = 2;

/**
 * Analiza el historial de ventas de cada cliente SIN dias de llamada
 * configurados todavia (diasLlamada vacio) y, si compra seguido el mismo
 * dia de la semana, se lo configura solo -- para no dejarlo en blanco
 * hasta que alguien lo revise a mano. Si el cliente ya tiene dias
 * configurados (aunque sea por esta misma funcion antes), NUNCA se
 * tocan -- la sugerencia automatica es de una sola vez, cualquier ajuste
 * despues es responsabilidad de quien lo edite a mano.
 *
 * Requiere al menos 3 ventas para intentar sugerir algo (con menos, no
 * hay suficiente historia para saber si es un patron real o casualidad),
 * y que el dia mas repetido tenga al menos 2 compras -- si no, se deja
 * sin sugerencia en vez de forzar un dia poco convincente.
 *
 * Se corre automaticamente cada noche (ver cron.ts) y tambien una vez al
 * arrancar el servidor, asi que no hace falta pedirlo a mano.
 */
export async function sugerirDiasCompraAutomaticamente() {
  const clientesSinDias = await prisma.cliente.findMany({
    where: { diasLlamada: { equals: [] } },
    select: { id: true },
  });
  if (clientesSinDias.length === 0) return { clientesActualizados: 0 };

  const idsSinDias = clientesSinDias.map((c) => c.id);
  const ventas = await prisma.venta.findMany({
    where: { clienteId: { in: idsSinDias }, cancelada: false },
    select: { clienteId: true, fecha: true },
  });

  const conteoPorCliente = new Map<string, number[]>();
  for (const v of ventas) {
    const conteos = conteoPorCliente.get(v.clienteId) ?? new Array(7).fill(0);
    conteos[v.fecha.getDay()] += 1;
    conteoPorCliente.set(v.clienteId, conteos);
  }

  let clientesActualizados = 0;
  for (const [clienteId, conteos] of conteoPorCliente) {
    const totalVentas = conteos.reduce((a, b) => a + b, 0);
    if (totalVentas < MIN_VENTAS_PARA_SUGERENCIA) continue;

    const maxConteo = Math.max(...conteos);
    if (maxConteo < MIN_REPETICIONES_DIA) continue;

    const diasSugeridos = conteos
      .map((c, dia) => ({ dia, c }))
      .filter((x) => x.c === maxConteo)
      .map((x) => x.dia);

    await prisma.cliente.update({ where: { id: clienteId }, data: { diasLlamada: diasSugeridos } });
    clientesActualizados += 1;
  }

  return { clientesActualizados };
}

/** Configura que dias de la semana (0=domingo...6=sabado) hay que llamarle a este cliente/prospecto. */
export async function actualizarDiasLlamadaCliente(clienteId: string, dias: number[]) {
  const diasValidos = [...new Set(dias.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b
  );
  const cliente = await prisma.cliente.update({
    where: { id: clienteId },
    data: { diasLlamada: diasValidos },
  });
  return cliente.diasLlamada;
}

/**
 * El checklist de "a quien llamarle hoy": todos los clientes/prospectos
 * cuyo dia de llamada incluye el dia de hoy, con el estado de su
 * registro de HOY (si ya se le hablo, la nota de la llamada, y si hizo
 * pedido). Un cliente sin registro de hoy todavia se ve con los valores
 * en blanco/false.
 */
export async function listarLlamadasDeHoy() {
  const hoy = normalizarFecha(new Date());
  const diaSemana = hoy.getDay(); // 0=domingo ... 6=sabado, igual que diasLlamada

  const clientes = await prisma.cliente.findMany({
    where: { diasLlamada: { has: diaSemana } },
    orderBy: { nombre: 'asc' },
  });

  const registros = await prisma.llamadaCliente.findMany({
    where: { fecha: hoy, clienteId: { in: clientes.map((c) => c.id) } },
  });
  const porCliente = new Map(registros.map((r) => [r.clienteId, r]));

  return clientes.map((c) => {
    const registro = porCliente.get(c.id);
    return {
      id: c.id,
      nombre: c.nombre,
      telefono: c.telefono,
      notasCliente: c.notas,
      hecha: registro?.hecha ?? false,
      notas: registro?.notas ?? '',
      hizoPedido: registro?.hizoPedido ?? false,
    };
  });
}

/**
 * Actualiza el registro de HOY de un cliente en la agenda de llamadas
 * (hecha/notas/hizoPedido, cualquier combinacion) -- crea el registro
 * si todavia no existia. Cada campo es opcional para poder guardar solo
 * lo que cambio (ej. tipear una nota sin tocar el checkbox de "hecha").
 */
export async function actualizarLlamadaCliente(
  clienteId: string,
  datos: { hecha?: boolean; notas?: string; hizoPedido?: boolean },
  registradoPorId: string
) {
  const hoy = normalizarFecha(new Date());

  await prisma.llamadaCliente.upsert({
    where: { clienteId_fecha: { clienteId, fecha: hoy } },
    update: {
      ...(datos.hecha !== undefined ? { hecha: datos.hecha } : {}),
      ...(datos.notas !== undefined ? { notas: datos.notas } : {}),
      ...(datos.hizoPedido !== undefined ? { hizoPedido: datos.hizoPedido } : {}),
    },
    create: {
      clienteId,
      fecha: hoy,
      registradoPorId,
      hecha: datos.hecha ?? false,
      notas: datos.notas ?? null,
      hizoPedido: datos.hizoPedido ?? false,
    },
  });
}
