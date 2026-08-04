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
  const deVentas = ventas
    .filter((v) => v.esCredito)
    .reduce((acc, v) => acc + Number(v.saldoPendiente), 0);
  return deVentas + Number(saldoInicial);
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
    saldoInicial: Number(c.saldoInicial),
    saldoTotal: calcularSaldoTotal(c.ventas, c.saldoInicial),
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
    saldoInicial: Number(cliente.saldoInicial),
    saldoTotal: calcularSaldoTotal(cliente.ventas, cliente.saldoInicial),
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
