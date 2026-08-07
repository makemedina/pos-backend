import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';
import { verificarSaldoBancoSuficiente } from './configuracion.service';

// Categorias tipicas de un ERP para gastos operativos de un negocio pequeno.
// Se crean automaticamente la primera vez que se piden las categorias y
// la tabla esta vacia -- asi nunca se topa el usuario con un formulario
// de gasto sin ninguna categoria para elegir (eso era justo la causa de
// "no se pudo registrar el gasto": categoriaId llegaba vacio).
const CATEGORIAS_DEFAULT: { nombre: string; departamento: string }[] = [
  { nombre: 'Renta', departamento: 'Operativos' },
  { nombre: 'Servicios (luz, agua, gas, internet)', departamento: 'Operativos' },
  { nombre: 'Mantenimiento y reparaciones', departamento: 'Operativos' },
  { nombre: 'Transporte y combustible', departamento: 'Operativos' },
  { nombre: 'Sueldos y nomina', departamento: 'Recursos Humanos' },
  { nombre: 'Papeleria e insumos de oficina', departamento: 'Administrativos' },
  { nombre: 'Publicidad y marketing', departamento: 'Administrativos' },
  { nombre: 'Honorarios profesionales', departamento: 'Administrativos' },
  { nombre: 'Limpieza', departamento: 'Administrativos' },
  { nombre: 'Impuestos y contribuciones', departamento: 'Financieros' },
  { nombre: 'Seguros', departamento: 'Financieros' },
  { nombre: 'Comisiones bancarias', departamento: 'Financieros' },
  { nombre: 'Otros gastos', departamento: 'Administrativos' },
];

export async function listarCategoriasGasto() {
  const existentes = await prisma.categoriaGasto.count();
  if (existentes === 0) {
    await prisma.categoriaGasto.createMany({ data: CATEGORIAS_DEFAULT });
  }

  return prisma.categoriaGasto.findMany({
    orderBy: [{ departamento: 'asc' }, { nombre: 'asc' }],
  });
}

export async function crearCategoriaGasto(nombre: string, departamento: string) {
  return prisma.categoriaGasto.create({
    data: { nombre, departamento },
  });
}

/**
 * Regla de negocio: cualquier usuario puede registrar un gasto sin
 * autorizacion previa, pero solo ve los propios. Solo el administrador
 * (o quien tenga puedeVerGastosTodos) ve los de todos.
 */
export async function listarGastos(usuario: { id: string; rolBase: string; permisos: { puedeVerGastosTodos: boolean } | null }) {
  const puedeVerTodos = usuario.rolBase === 'administrador' || usuario.permisos?.puedeVerGastosTodos;

  return prisma.gasto.findMany({
    where: puedeVerTodos ? undefined : { registradoPorId: usuario.id },
    include: { categoria: true, registradoPor: true, proveedor: true },
    orderBy: { fecha: 'desc' },
  });
}

/**
 * registradoPorId ya no viene del body: lo decide el backend a partir de
 * la sesion activa (req.usuario.id). proveedorId es opcional -- no todo
 * gasto tiene un proveedor asociado (ej. sueldos).
 */
export async function crearGasto(input: {
  categoriaId: string;
  registradoPorId: string;
  proveedorId?: string;
  concepto: string;
  monto: number;
  metodoPago: string;
}) {
  return prisma.$transaction(async (tx) => {
    if (input.metodoPago === 'transferencia') {
      await verificarSaldoBancoSuficiente(tx, input.monto);
    }

    const gasto = await tx.gasto.create({
      data: input,
      include: { categoria: true, registradoPor: true, proveedor: true },
    });

    if (input.metodoPago === 'transferencia') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { decrement: input.monto } },
        create: { id: 'singleton', saldoBancoActual: -input.monto },
      });
    } else if (input.metodoPago === 'efectivo') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { decrement: input.monto } },
        create: { id: 'singleton', saldoEfectivoActual: -input.monto },
      });
    }

    return gasto;
  });
}

export class GastoYaCanceladoError extends Error {
  constructor() {
    super('Este gasto ya estaba cancelado.');
  }
}

export class AutorizacionCancelacionGastoInvalidaError extends Error {
  constructor() {
    super('Cancelar un gasto de un dia anterior necesita autorizacion por telefono y PIN.');
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
 * Cancela un gasto (por ejemplo, si se capturo mal). No se borra --
 * queda marcado como cancelado, para poder auditar despues, y se excluye
 * de los totales de corte de caja y dashboard.
 *
 * Si el gasto es de un dia distinto al de hoy, cancelarlo requiere
 * autorizacion por telefono+PIN de un administrador, igual que con
 * ventas y compras.
 */
export async function cancelarGasto(
  gastoId: string,
  solicitadoPorId: string,
  autorizacion?: { telefono: string; pin: string }
) {
  const gastoActual = await prisma.gasto.findUniqueOrThrow({ where: { id: gastoId } });
  if (gastoActual.cancelado) {
    throw new GastoYaCanceladoError();
  }

  let autorizadoPorId: string | null = null;
  if (!esMismoDia(gastoActual.fecha, new Date())) {
    if (!autorizacion) throw new AutorizacionCancelacionGastoInvalidaError();
    autorizadoPorId = await verificarAutorizadorPorTelefono(autorizacion.telefono, autorizacion.pin);
    if (!autorizadoPorId) throw new AutorizacionCancelacionGastoInvalidaError();
  }

  return prisma.$transaction(async (tx) => {
    if (gastoActual.metodoPago === 'transferencia') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoBancoActual: { increment: Number(gastoActual.monto) } },
        create: { id: 'singleton', saldoBancoActual: Number(gastoActual.monto) },
      });
    } else if (gastoActual.metodoPago === 'efectivo') {
      await tx.configuracion.upsert({
        where: { id: 'singleton' },
        update: { saldoEfectivoActual: { increment: Number(gastoActual.monto) } },
        create: { id: 'singleton', saldoEfectivoActual: Number(gastoActual.monto) },
      });
    }

    return tx.gasto.update({
      where: { id: gastoId },
      data: {
        cancelado: true,
        canceladoEn: new Date(),
        canceladoPorId: solicitadoPorId,
        autorizadoPorId,
      },
      include: { categoria: true, registradoPor: true, proveedor: true },
    });
  });
}
