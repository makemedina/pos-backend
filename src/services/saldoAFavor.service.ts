import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

// Copia local a proposito (no importada de ventas.service.ts): ese
// archivo importa consumirSaldoAFavor de aqui, e importar en la
// direccion contraria crearia un ciclo entre los dos modulos.
function redondearCentavos(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

export class SaldoAFavorInsuficienteError extends Error {
  constructor(disponible: number) {
    super(`El cliente solo tiene $${disponible.toFixed(2)} de saldo a favor disponible.`);
  }
}

/** Cuanto saldo a favor tiene disponible un cliente ahora mismo (positivo). */
export async function saldoAFavorDisponible(clienteId: string): Promise<number> {
  const agg = await prisma.venta.aggregate({
    where: { clienteId, cancelada: false, saldoPendiente: { lt: 0 } },
    _sum: { saldoPendiente: true },
  });
  return redondearCentavos(-Number(agg._sum.saldoPendiente ?? 0));
}

/**
 * Consume `monto` del saldo a favor de un cliente (metodoPago
 * 'saldo_favor'), tomandolo de sus notas con saldoPendiente negativo --
 * la mas antigua primero -- DENTRO de una transaccion ya abierta por el
 * llamador (crearVenta o aplicarPagoVenta). NO mueve efectivo ni banco:
 * es una reasignacion interna entre notas del mismo cliente, no dinero
 * nuevo entrando a caja. Lanza SaldoAFavorInsuficienteError si no alcanza.
 */
export async function consumirSaldoAFavor(
  tx: Prisma.TransactionClient,
  clienteId: string,
  monto: number
): Promise<void> {
  if (monto <= 0) return;

  const notasConFavor = await tx.venta.findMany({
    where: { clienteId, cancelada: false, saldoPendiente: { lt: 0 } },
    orderBy: { fecha: 'asc' },
  });

  const disponible = notasConFavor.reduce((acc, n) => acc - Number(n.saldoPendiente), 0);
  if (monto > disponible + 0.005) {
    throw new SaldoAFavorInsuficienteError(redondearCentavos(disponible));
  }

  let restante = monto;
  for (const nota of notasConFavor) {
    if (restante <= 0) break;
    const favorEnEstaNota = -Number(nota.saldoPendiente);
    const aConsumir = Math.min(favorEnEstaNota, restante);
    const nuevoSaldo = redondearCentavos(Number(nota.saldoPendiente) + aConsumir);

    await tx.venta.update({
      where: { id: nota.id },
      data: {
        saldoPendiente: nuevoSaldo,
        estadoPago: nuevoSaldo >= Number(nota.total) ? 'pendiente' : nuevoSaldo > 0 ? 'parcial' : 'pagada',
      },
    });

    restante = redondearCentavos(restante - aConsumir);
  }
}
