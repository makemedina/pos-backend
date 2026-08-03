import { prisma } from '../prisma';

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
  return prisma.gasto.create({
    data: input,
    include: { categoria: true, registradoPor: true, proveedor: true },
  });
}
