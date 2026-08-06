import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';

export class MontoDepositoInvalidoError extends Error {}

export class DepositoYaCanceladoError extends Error {
  constructor() {
    super('Este depósito ya estaba cancelado.');
  }
}

export class AutorizacionCancelacionDepositoInvalidaError extends Error {
  constructor() {
    super('Cancelar un depósito de un dia anterior necesita autorizacion por telefono y PIN.');
  }
}

function esMismoDia(fecha: Date, referencia: Date) {
  return (
    fecha.getFullYear() === referencia.getFullYear() &&
    fecha.getMonth() === referencia.getMonth() &&
    fecha.getDate() === referencia.getDate()
  );
}

/**
 * Traspaso interno: efectivo que se deposito al banco (tipicamente para
 * poder pagarle a un proveedor por transferencia). No es una venta ni un
 * gasto -- no debe afectar utilidad ni ningun reporte de ingresos, solo
 * mueve el saldo de efectivo a banco para que el Corte de Caja siga
 * cuadrando.
 */
export async function registrarDeposito(monto: number, notas: string | undefined, registradoPorId: string) {
  if (!monto || monto <= 0) {
    throw new MontoDepositoInvalidoError('El monto del deposito debe ser mayor a cero');
  }

  return prisma.$transaction(async (tx) => {
    const deposito = await tx.depositoBanco.create({
      data: { monto, notas, registradoPorId },
      include: { registradoPor: true },
    });

    await tx.configuracion.upsert({
      where: { id: 'singleton' },
      update: {
        saldoEfectivoActual: { decrement: monto },
        saldoBancoActual: { increment: monto },
      },
      create: { id: 'singleton', saldoEfectivoActual: -monto, saldoBancoActual: monto },
    });

    return deposito;
  });
}

/**
 * Cualquier usuario puede registrar y ver sus propios depositos; solo el
 * administrador (o quien tenga puedeVerGastosTodos, el mismo permiso que
 * ya se usa para ver los gastos de todos) ve los de todos.
 */
export async function listarDepositos(usuario: {
  id: string;
  rolBase: string;
  permisos: { puedeVerGastosTodos: boolean } | null;
}) {
  const puedeVerTodos = usuario.rolBase === 'administrador' || usuario.permisos?.puedeVerGastosTodos;

  return prisma.depositoBanco.findMany({
    where: puedeVerTodos ? undefined : { registradoPorId: usuario.id },
    include: { registradoPor: true },
    orderBy: { fecha: 'desc' },
  });
}

/**
 * Cancela un deposito (por ejemplo, si se capturo mal el monto). No se
 * borra -- queda marcado como cancelado, para poder auditar despues, y
 * se excluye de los totales del corte de caja. Revierte el saldo:
 * regresa el monto a efectivo y lo quita de banco.
 *
 * Si el deposito es de un dia distinto al de hoy, cancelarlo requiere
 * autorizacion por telefono+PIN de un administrador, igual que con
 * ventas, compras y gastos.
 */
export async function cancelarDeposito(
  depositoId: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const depositoActual = await prisma.depositoBanco.findUniqueOrThrow({ where: { id: depositoId } });
  if (depositoActual.cancelado) {
    throw new DepositoYaCanceladoError();
  }

  let autorizadoPorId: string | null = null;
  if (!esMismoDia(depositoActual.fecha, new Date())) {
    if (!autorizacion) throw new AutorizacionCancelacionDepositoInvalidaError();
    autorizadoPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadoPorId) throw new AutorizacionCancelacionDepositoInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    const monto = Number(depositoActual.monto);

    await tx.configuracion.upsert({
      where: { id: 'singleton' },
      update: {
        saldoEfectivoActual: { increment: monto },
        saldoBancoActual: { decrement: monto },
      },
      create: { id: 'singleton', saldoEfectivoActual: monto, saldoBancoActual: -monto },
    });

    return tx.depositoBanco.update({
      where: { id: depositoId },
      data: {
        cancelado: true,
        canceladoEn: new Date(),
        canceladoPorId: solicitadoPorId,
        autorizadoPorId,
      },
      include: { registradoPor: true },
    });
  });
}
