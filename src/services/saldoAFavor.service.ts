import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { redondearCentavos } from '../utils/dinero';

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

export interface ConsumoSaldoAFavor {
  ventaId: string;
  monto: number;
}

function estadoPagoNota(saldoPendiente: number, total: number) {
  return saldoPendiente >= total ? 'pendiente' : saldoPendiente > 0 ? 'parcial' : 'pagada';
}

/**
 * Consume `monto` del saldo a favor de un cliente (metodoPago
 * 'saldo_favor'), tomandolo de sus notas con saldoPendiente negativo --
 * la mas antigua primero -- DENTRO de una transaccion ya abierta por el
 * llamador (crearVenta o aplicarPagoVenta). NO mueve efectivo ni banco:
 * es una reasignacion interna entre notas del mismo cliente, no dinero
 * nuevo entrando a caja. Lanza SaldoAFavorInsuficienteError si no alcanza.
 *
 * `ventaIdExcluir` es la nota que se esta pagando: si quedo con
 * sobrepago en este mismo cobro, ese excedente no es saldo a favor previo.
 *
 * Regresa de que notas se tomo y cuanto, para guardarlo en el PagoVenta
 * y poder devolverlo con restaurarSaldoAFavor si se cancela.
 */
export async function consumirSaldoAFavor(
  tx: Prisma.TransactionClient,
  clienteId: string,
  monto: number,
  ventaIdExcluir?: string
): Promise<ConsumoSaldoAFavor[]> {
  if (monto <= 0) return [];

  const notasConFavor = await tx.venta.findMany({
    where: {
      clienteId,
      cancelada: false,
      saldoPendiente: { lt: 0 },
      ...(ventaIdExcluir ? { id: { not: ventaIdExcluir } } : {}),
    },
    orderBy: { fecha: 'asc' },
  });

  const disponible = notasConFavor.reduce((acc, n) => acc - Number(n.saldoPendiente), 0);
  if (monto > disponible + 0.005) {
    throw new SaldoAFavorInsuficienteError(redondearCentavos(disponible));
  }

  const consumos: ConsumoSaldoAFavor[] = [];
  let restante = monto;
  for (const nota of notasConFavor) {
    if (restante <= 0) break;
    const favorEnEstaNota = -Number(nota.saldoPendiente);
    const aConsumir = redondearCentavos(Math.min(favorEnEstaNota, restante));
    const nuevoSaldo = redondearCentavos(Number(nota.saldoPendiente) + aConsumir);

    await tx.venta.update({
      where: { id: nota.id },
      data: { saldoPendiente: nuevoSaldo, estadoPago: estadoPagoNota(nuevoSaldo, Number(nota.total)) },
    });

    consumos.push({ ventaId: nota.id, monto: aConsumir });
    restante = redondearCentavos(restante - aConsumir);
  }
  return consumos;
}

/**
 * Lo contrario de consumirSaldoAFavor: cuando se cancela un pago con
 * 'saldo_favor' (o la venta que lo uso), le regresa a cada nota de origen
 * el saldo a favor que se le habia tomado. Las notas que ya se cancelaron
 * se saltan -- su dinero ya se devolvio al cancelarlas.
 *
 * Los pagos registrados antes de que existiera consumosSaldoFavor no
 * traen el detalle; en ese caso no hay de donde regresarlo y se avisa en
 * el log para corregirlo a mano.
 */
export async function restaurarSaldoAFavor(
  tx: Prisma.TransactionClient,
  pago: { id: string; consumosSaldoFavor: Prisma.JsonValue }
): Promise<void> {
  const consumos = pago.consumosSaldoFavor as ConsumoSaldoAFavor[] | null;
  if (!Array.isArray(consumos)) {
    console.warn(`[saldo a favor] El pago ${pago.id} no guarda de que notas tomo el saldo; no se pudo regresar.`);
    return;
  }

  for (const consumo of consumos) {
    const nota = await tx.venta.findUnique({ where: { id: consumo.ventaId } });
    if (!nota || nota.cancelada) continue;
    const nuevoSaldo = redondearCentavos(Number(nota.saldoPendiente) - consumo.monto);
    await tx.venta.update({
      where: { id: nota.id },
      data: { saldoPendiente: nuevoSaldo, estadoPago: estadoPagoNota(nuevoSaldo, Number(nota.total)) },
    });
  }
}
