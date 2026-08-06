import { prisma } from '../prisma';

export async function buscarProductos(query: string) {
  if (!query || query.length < 2) return [];

  return prisma.producto.findMany({
    where: { nombre: { contains: query, mode: 'insensitive' } },
    take: 10,
    orderBy: { nombre: 'asc' },
  });
}

export async function variantesDeProducto(productoId: string) {
  return prisma.variante.findMany({
    where: { productoId, activo: true },
    orderBy: { marca: 'asc' },
  });
}
export async function buscarVariantes(query: string) {
  if (!query || query.length < 2) return [];

  return prisma.variante.findMany({
    where: {
      OR: [
        { marca: { contains: query, mode: 'insensitive' } },
        { producto: { nombre: { contains: query, mode: 'insensitive' } } },
      ],
    },
    include: { producto: true },
    take: 10,
  });
}

export async function crearVarianteRapida(
  nombreProducto: string,
  marca: string,
  precioVenta: number
) {
  let producto = await prisma.producto.findFirst({
    where: { nombre: { equals: nombreProducto, mode: 'insensitive' } },
  });

  if (!producto) {
    producto = await prisma.producto.create({ data: { nombre: nombreProducto } });
  }

  return prisma.variante.create({
    data: {
      productoId: producto.id,
      marca,
      precioVenta,
      stockMinimo: 0,
    },
    include: { producto: true },
  });
}

export async function listarCatalogo() {
  const variantes = await prisma.variante.findMany({
    where: { activo: true },
    orderBy: [{ producto: { nombre: 'asc' } }, { marca: 'asc' }],
    include: {
      producto: {
        include: { categoria: true },
      },
      lotes: true,
    },
  });

  return variantes
    .map((v) => {
      const stockDisponible = v.lotes.reduce(
        (acc, l) => acc + Number(l.cantidadDisponible),
        0
      );
      const costoLoteMasViejo = v.lotes[0]
        ? Number(v.lotes[0].costoUnitario)
        : null;

      return {
        id: v.id,
        producto: v.producto.nombre,
        marca: v.marca,
        categoria: v.producto.categoria?.nombre ?? null,
        precioVenta: Number(v.precioVenta),
        stockMinimo: Number(v.stockMinimo),
        stockDisponible,
        costoLoteMasViejo,
        pocoStock: stockDisponible <= Number(v.stockMinimo),
      };
    })
    .filter((v) => v.stockDisponible > 0);

}

/**
 * Listado de GESTION de productos (no de venta): incluye TODAS las
 * variantes, incluso sin stock, ordenadas de mayor a menor stock. El
 * switch de "ver sin stock" se aplica en el frontend sobre este mismo
 * listado. A diferencia de listarCatalogo() (usado en la pantalla de
 * Ventas), aqui no se oculta nada por default.
 */
export async function listarProductosGestion() {
  const variantes = await prisma.variante.findMany({
    where: { activo: true },
    include: {
      producto: { include: { categoria: true } },
      lotes: true,
    },
  });

  return variantes
    .map((v) => {
      const stockDisponible = v.lotes.reduce((acc, l) => acc + Number(l.cantidadDisponible), 0);

      // Costo (precio de compra): SIN promediar -- cada lote conserva su
      // propio costo, porque compras distintas del mismo producto pueden
      // venir a precios distintos y eso importa para saber que se esta
      // vendiendo con que margen. Solo se listan los lotes que aun tienen
      // stock, el mas reciente primero.
      const lotesConStock = v.lotes
        .filter((l) => Number(l.cantidadDisponible) > 0)
        .sort((a, b) => b.fechaIngreso.getTime() - a.fechaIngreso.getTime())
        .map((l) => ({
          cantidadDisponible: Number(l.cantidadDisponible),
          costoUnitario: Number(l.costoUnitario),
          fechaIngreso: l.fechaIngreso,
        }));

      return {
        id: v.id,
        producto: v.producto.nombre,
        productoId: v.producto.id,
        marca: v.marca,
        categoria: v.producto.categoria?.nombre ?? null,
        precioVenta: Number(v.precioVenta),
        lotes: lotesConStock,
        stockMinimo: Number(v.stockMinimo),
        stockDisponible,
        pocoStock: stockDisponible <= Number(v.stockMinimo),
      };
    })
    .sort((a, b) => b.stockDisponible - a.stockDisponible);
}

/**
 * Historial completo de movimientos de UNA variante especifica: entradas
 * (compras, con proveedor), salidas (ventas, con cliente) y ajustes
 * (merma/correccion). Cada entrada y venta trae el id de su compra/venta
 * original, para poder navegar a ese detalle al hacer click.
 */
export async function historialVariante(varianteId: string) {
  const [lotes, ventaItems, ajustes] = await Promise.all([
    prisma.loteInventario.findMany({
      where: { varianteId, compra: { cancelada: false } },
      include: { compra: { include: { proveedor: true } } },
    }),
    prisma.ventaItem.findMany({
      where: { lote: { varianteId }, venta: { cancelada: false } },
      include: { venta: { include: { cliente: true } } },
    }),
    prisma.ajusteInventario.findMany({
      where: { lote: { varianteId } },
    }),
  ]);

  const movimientos = [
    ...lotes.map((l) => ({
      tipo: 'entrada' as const,
      id: l.id,
      fecha: l.fechaIngreso,
      cantidad: Number(l.cantidadInicial),
      valor: Number(l.cantidadInicial) * Number(l.costoUnitario),
      referencia: `Compra a ${l.compra.proveedor.nombre}`,
      navegarA: { tipo: 'compra' as const, id: l.compraId },
    })),
    ...ventaItems.map((v) => ({
      tipo: 'salida' as const,
      id: v.id,
      fecha: v.venta.fecha,
      cantidad: -Number(v.cantidad),
      valor: -(Number(v.cantidad) * Number(v.costoUnitarioSnapshot)),
      referencia: `Venta #${v.venta.folio} - ${v.venta.cliente.nombre}`,
      navegarA: { tipo: 'venta' as const, id: v.ventaId },
    })),
    ...ajustes.map((a) => {
      const esSalida = a.tipo === 'merma' || a.tipo === 'correccion_negativa';
      return {
        tipo: a.tipo as 'merma' | 'correccion_positiva' | 'correccion_negativa',
        id: a.id,
        fecha: a.fecha,
        cantidad: (esSalida ? -1 : 1) * Number(a.cantidad),
        valor: Number(a.impactoUtilidad),
        referencia: a.motivo,
        navegarA: undefined,
      };
    }),
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

  return movimientos;
}