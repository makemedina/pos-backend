import { prisma } from '../prisma';

const ID_SINGLETON = 'singleton';

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
}

export async function actualizarConfiguracion(datos: ActualizarConfiguracionInput) {
  return prisma.configuracion.upsert({
    where: { id: ID_SINGLETON },
    update: datos,
    create: { id: ID_SINGLETON, ...datos },
  });
}
