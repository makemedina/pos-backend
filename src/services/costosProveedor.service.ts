import { prisma } from '../prisma';

/**
 * Lista los costos de referencia que un proveedor tiene registrados para
 * sus productos -- es informativo (para comparar entre proveedores al
 * comprar), no afecta el costo real de inventario.
 */
export async function listarCostosProveedor(proveedorId: string) {
  const registros = await prisma.costoProveedorProducto.findMany({
    where: { proveedorId },
    include: { variante: { include: { producto: true } } },
    orderBy: { variante: { producto: { nombre: 'asc' } } },
  });

  return registros.map((r) => ({
    varianteId: r.varianteId,
    producto: r.variante.producto.nombre,
    marca: r.variante.marca,
    costo: Number(r.costo),
    actualizadoEn: r.actualizadoEn,
  }));
}

export async function guardarCostoProveedor(proveedorId: string, varianteId: string, costo: number) {
  const r = await prisma.costoProveedorProducto.upsert({
    where: { proveedorId_varianteId: { proveedorId, varianteId } },
    update: { costo },
    create: { proveedorId, varianteId, costo },
    include: { variante: { include: { producto: true } } },
  });

  return {
    varianteId: r.varianteId,
    producto: r.variante.producto.nombre,
    marca: r.variante.marca,
    costo: Number(r.costo),
    actualizadoEn: r.actualizadoEn,
  };
}

export async function eliminarCostoProveedor(proveedorId: string, varianteId: string) {
  await prisma.costoProveedorProducto.delete({
    where: { proveedorId_varianteId: { proveedorId, varianteId } },
  });
}

/**
 * El costo con el que se compro por ultima vez esta variante a este
 * proveedor (segun el historial real de Compras/LoteInventario) -- para
 * sugerirlo como punto de partida al agregar/actualizar su costo de
 * referencia, en vez de que el usuario tenga que acordarse o buscarlo por
 * separado en el historial de compras.
 */
export async function ultimoCostoCompra(proveedorId: string, varianteId: string) {
  const lote = await prisma.loteInventario.findFirst({
    where: { varianteId, compra: { proveedorId, cancelada: false } },
    orderBy: { compra: { fecha: 'desc' } },
    select: { costoUnitario: true, compra: { select: { fecha: true } } },
  });

  if (!lote) return null;
  return { costo: Number(lote.costoUnitario), fecha: lote.compra.fecha };
}

/**
 * Arma la tabla comparativa de precios (producto/marca x proveedor) para
 * decidir a quien conviene comprarle. Cada celda sale del costo de
 * referencia guardado (que ya se actualiza solo con cada compra, ver
 * compras.service.ts) y, donde no hay uno guardado -- compras de antes de
 * que existiera esa tabla --, cae al costo de la ultima compra real.
 *
 * `origen` dice de donde viene el precio que se muestra: 'compra' si es
 * el mismo de la ultima compra, 'manual' si alguien lo capturo distinto
 * (ej. el proveedor aviso de un precio nuevo y todavia no se le compra).
 *
 * Solo entran los precios actualizados en los ultimos DIAS_VIGENCIA_PRECIO
 * dias.
 */
// Un precio de hace mas de estos dias ya no es confiable para decidir a
// quien comprarle, asi que deja de salir en la tabla (no se borra: sigue
// en "Costos" del proveedor y en el historial de compras).
const DIAS_VIGENCIA_PRECIO = 10;

export async function tablaPreciosProveedores() {
  const limite = new Date();
  limite.setHours(0, 0, 0, 0);
  limite.setDate(limite.getDate() - DIAS_VIGENCIA_PRECIO);

  const [proveedores, registros, lotes] = await Promise.all([
    prisma.proveedor.findMany({ select: { id: true, nombre: true }, orderBy: { nombre: 'asc' } }),
    prisma.costoProveedorProducto.findMany({
      include: { variante: { include: { producto: true } } },
    }),
    prisma.loteInventario.findMany({
      where: { compra: { cancelada: false } },
      orderBy: { compra: { fecha: 'desc' } },
      select: {
        varianteId: true,
        costoUnitario: true,
        compra: { select: { proveedorId: true, fecha: true } },
        variante: { select: { marca: true, producto: { select: { nombre: true } } } },
      },
    }),
  ]);

  // Ultima compra por proveedor+variante (los lotes ya vienen de la mas
  // reciente a la mas vieja, asi que el primero que aparece es el bueno).
  const ultimasCompras = new Map<string, { costo: number; fecha: Date }>();
  const filas = new Map<
    string,
    {
      varianteId: string;
      producto: string;
      marca: string;
      precios: Record<
        string,
        { costo: number; actualizadoEn: Date; origen: 'compra' | 'manual'; ultimaCompra: { costo: number; fecha: Date } | null }
      >;
    }
  >();

  function filaDe(varianteId: string, producto: string, marca: string) {
    let fila = filas.get(varianteId);
    if (!fila) {
      fila = { varianteId, producto, marca, precios: {} };
      filas.set(varianteId, fila);
    }
    return fila;
  }

  for (const l of lotes) {
    const clave = `${l.compra.proveedorId}|${l.varianteId}`;
    if (ultimasCompras.has(clave)) continue;
    const ultima = { costo: Number(l.costoUnitario), fecha: l.compra.fecha };
    ultimasCompras.set(clave, ultima);
    if (ultima.fecha < limite) continue;
    filaDe(l.varianteId, l.variante.producto.nombre, l.variante.marca).precios[l.compra.proveedorId] = {
      costo: ultima.costo,
      actualizadoEn: ultima.fecha,
      origen: 'compra',
      ultimaCompra: ultima,
    };
  }

  for (const r of registros) {
    if (r.actualizadoEn < limite) continue;
    const ultima = ultimasCompras.get(`${r.proveedorId}|${r.varianteId}`) ?? null;
    const costo = Number(r.costo);
    filaDe(r.varianteId, r.variante.producto.nombre, r.variante.marca).precios[r.proveedorId] = {
      costo,
      actualizadoEn: r.actualizadoEn,
      origen: ultima && ultima.costo === costo ? 'compra' : 'manual',
      ultimaCompra: ultima,
    };
  }

  return {
    proveedores,
    filas: [...filas.values()].sort(
      (a, b) => a.producto.localeCompare(b.producto, 'es') || a.marca.localeCompare(b.marca, 'es')
    ),
  };
}
