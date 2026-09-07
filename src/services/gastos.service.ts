import { prisma } from '../prisma';
import { verificarAutorizadorPorTelefono } from './auth.service';
import { verificarSaldoBancoSuficiente } from './configuracion.service';
import { subirImagenR2, descargarImagenR2 } from './imagenesR2.service';
import { fechaLocalDesdeString } from '../utils/fecha';

const PREFIJO_COMPROBANTES = 'recibos-gastos/';

/**
 * Sube la foto del comprobante de un gasto a R2. Se sube ANTES de crear
 * el registro del gasto -- si la subida falla, no se crea un gasto sin
 * foto (la foto es obligatoria).
 */
export async function subirFotoComprobanteGasto(buffer: Buffer, contentType: string): Promise<string> {
  return subirImagenR2(buffer, contentType, PREFIJO_COMPROBANTES);
}

/** Regresa la foto del comprobante como stream, para mandarla directo al navegador. */
export async function descargarFotoComprobanteGasto(key: string) {
  return descargarImagenR2(key);
}

export async function obtenerGastoPorId(gastoId: string) {
  return prisma.gasto.findUniqueOrThrow({ where: { id: gastoId } });
}

/** Mismo criterio que listarGastos: solo el dueno del gasto o quien puede ver los de todos. */
export function puedeVerGasto(
  gasto: { registradoPorId: string },
  usuario: { id: string; rolBase: string; permisos: { puedeVerGastosTodos: boolean } | null }
) {
  return (
    usuario.rolBase === 'administrador' ||
    !!usuario.permisos?.puedeVerGastosTodos ||
    gasto.registradoPorId === usuario.id
  );
}

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

export interface FiltrosHistorialGastos {
  periodo?: string; // dia | ayer | antier | semana | semana_pasada | hace_2_semanas | hace_3_semanas | mes | anio | rango | todos
  desde?: string;
  hasta?: string;
  categoriaId?: string;
  proveedorId?: string;
  metodoPago?: string; // efectivo | transferencia
}

// Semana calendario de lunes a domingo, "semanasAtras" semanas atras de
// la semana actual (0 = esta semana, 1 = semana pasada, 2 = hace 2
// semanas, etc.) -- no son "los ultimos 7 dias", son semanas calendario.
function calcularSemana(hoy: Date, semanasAtras: number) {
  const diaSemana = hoy.getDay(); // 0=domingo ... 6=sabado
  const diffLunes = diaSemana === 0 ? 6 : diaSemana - 1;
  const lunesEstaSemana = new Date(hoy);
  lunesEstaSemana.setDate(hoy.getDate() - diffLunes);
  const lunes = new Date(lunesEstaSemana);
  lunes.setDate(lunesEstaSemana.getDate() - semanasAtras * 7);
  lunes.setHours(0, 0, 0, 0);
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);
  domingo.setHours(23, 59, 59, 999);
  return { inicio: lunes, fin: domingo };
}

function obtenerRangoGastos(periodo: string, desde?: string, hasta?: string) {
  const hoy = new Date();
  const inicio = new Date(hoy);
  const fin = new Date(hoy);

  switch (periodo) {
    case 'dia':
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'ayer': {
      const ayer = new Date(hoy);
      ayer.setDate(hoy.getDate() - 1);
      ayer.setHours(0, 0, 0, 0);
      const finAyer = new Date(ayer);
      finAyer.setHours(23, 59, 59, 999);
      inicio.setTime(ayer.getTime());
      fin.setTime(finAyer.getTime());
      break;
    }
    case 'antier': {
      const antier = new Date(hoy);
      antier.setDate(hoy.getDate() - 2);
      antier.setHours(0, 0, 0, 0);
      const finAntier = new Date(antier);
      finAntier.setHours(23, 59, 59, 999);
      inicio.setTime(antier.getTime());
      fin.setTime(finAntier.getTime());
      break;
    }
    case 'semana': {
      const r = calcularSemana(hoy, 0);
      inicio.setTime(r.inicio.getTime());
      fin.setTime(r.fin.getTime());
      break;
    }
    case 'semana_pasada': {
      const r = calcularSemana(hoy, 1);
      inicio.setTime(r.inicio.getTime());
      fin.setTime(r.fin.getTime());
      break;
    }
    case 'hace_2_semanas': {
      const r = calcularSemana(hoy, 2);
      inicio.setTime(r.inicio.getTime());
      fin.setTime(r.fin.getTime());
      break;
    }
    case 'hace_3_semanas': {
      const r = calcularSemana(hoy, 3);
      inicio.setTime(r.inicio.getTime());
      fin.setTime(r.fin.getTime());
      break;
    }
    case 'anio':
      inicio.setMonth(0, 1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'rango': {
      if (desde) {
        const d = fechaLocalDesdeString(desde);
        d.setHours(0, 0, 0, 0);
        inicio.setTime(d.getTime());
      } else {
        inicio.setDate(1);
        inicio.setHours(0, 0, 0, 0);
      }
      if (hasta) {
        const h = fechaLocalDesdeString(hasta);
        h.setHours(23, 59, 59, 999);
        fin.setTime(h.getTime());
      } else {
        fin.setHours(23, 59, 59, 999);
      }
      break;
    }
    case 'todos':
      inicio.setFullYear(2000, 0, 1);
      inicio.setHours(0, 0, 0, 0);
      fin.setFullYear(2100, 0, 1);
      fin.setHours(23, 59, 59, 999);
      break;
    case 'mes':
    default:
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);
      fin.setHours(23, 59, 59, 999);
      break;
  }

  return { inicio, fin };
}

/**
 * Regla de negocio: cualquier usuario puede registrar un gasto sin
 * autorizacion previa, pero solo ve los propios. Solo el administrador
 * (o quien tenga puedeVerGastosTodos) ve los de todos.
 *
 * Sin filtros (el default), se comporta igual que antes -- todos los
 * gastos, sin restriccion de fecha ("todos"). Con filtros, sirve como el
 * reporte de gastos: por periodo/rango de fechas, categoria, proveedor y
 * metodo de pago.
 */
export async function listarGastos(
  usuario: { id: string; rolBase: string; permisos: { puedeVerGastosTodos: boolean } | null },
  filtros: FiltrosHistorialGastos = {}
) {
  const puedeVerTodos = usuario.rolBase === 'administrador' || usuario.permisos?.puedeVerGastosTodos;
  const { inicio, fin } = obtenerRangoGastos(filtros.periodo || 'todos', filtros.desde, filtros.hasta);

  return prisma.gasto.findMany({
    where: {
      ...(puedeVerTodos ? {} : { registradoPorId: usuario.id }),
      fecha: { gte: inicio, lte: fin },
      ...(filtros.categoriaId ? { categoriaId: filtros.categoriaId } : {}),
      ...(filtros.proveedorId ? { proveedorId: filtros.proveedorId } : {}),
      ...(filtros.metodoPago ? { metodoPago: filtros.metodoPago } : {}),
    },
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
  fotoComprobanteKey: string;
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
