import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

const ID_SINGLETON = 'singleton';

export class SaldoBancoInsuficienteError extends Error {
  constructor(monto: number, saldoActual: number) {
    super(
      `No hay suficiente saldo en banco para pagar $${monto.toFixed(2)} por transferencia ` +
        `(saldo actual: $${saldoActual.toFixed(2)}). El banco nunca puede quedar en negativo -- ` +
        `usa efectivo o registra un depósito primero.`
    );
  }
}

/**
 * El banco nunca puede quedar en negativo (a diferencia de un cliente, que
 * si puede tener saldo a favor): antes de cualquier salida de dinero por
 * transferencia (gasto, pago a proveedor), se valida que alcance.
 */
export async function verificarSaldoBancoSuficiente(tx: Prisma.TransactionClient, monto: number) {
  const configuracion = await tx.configuracion.findUnique({ where: { id: ID_SINGLETON } });
  const saldoActual = Number(configuracion?.saldoBancoActual ?? 0);
  if (monto > saldoActual) {
    throw new SaldoBancoInsuficienteError(monto, saldoActual);
  }
}

/**
 * Obtiene la configuracion unica del negocio. Si nunca se ha guardado
 * nada, crea el registro con los valores por default (todo vacio,
 * papel de 58mm, etc) para que siempre haya algo que regresar.
 */
export async function obtenerConfiguracion() {
  const existente = await prisma.configuracion.findUnique({ where: { id: ID_SINGLETON } });
  if (existente) return existente;

  return prisma.configuracion.create({ data: { id: ID_SINGLETON } });
}

interface ActualizarConfiguracionInput {
  nombreNegocio?: string;
  logoBase64?: string | null;
  telefono?: string;
  direccion?: string;
  notasNegocio?: string;
  mostrarDatosCliente?: boolean;
  encabezadoRecibo?: string;
  piePaginaRecibo?: string;
  anchoPapelMm?: number;
  imprimirDosVeces?: boolean;
  saldoBancoActual?: number;
  saldoEfectivoActual?: number;
}

export async function actualizarConfiguracion(datos: ActualizarConfiguracionInput) {
  return prisma.configuracion.upsert({
    where: { id: ID_SINGLETON },
    update: datos,
    create: { id: ID_SINGLETON, ...datos },
  });
}
