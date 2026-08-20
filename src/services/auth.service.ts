import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { prisma } from '../prisma';
import { verificarBloqueo, registrarIntentoFallido, limpiarIntentos } from './loginLimiter';

const RONDAS_BCRYPT = 10;
// Ventana deslizante (se renueva en cada peticion mientras se use la app):
// un dia laboral completo, para que no pida iniciar sesion de nuevo si
// la PWA se queda en segundo plano durante una comida o un rato sin usarse.
const DURACION_SESION_HORAS = 12;

export interface UsuarioSesion {
  id: string;
  nombre: string;
  telefono: string;
  rolBase: string;
  permisos: {
    puedeVerCostos: boolean;
    puedeRegistrarCompras: boolean;
    puedeVerUtilidad: boolean;
    puedeVerCarteraGeneral: boolean;
    puedeVerGastosTodos: boolean;
    puedeAutorizar: boolean;
    puedeRegistrarPagos: boolean;
  } | null;
}

function mapPermisos(usuario: any): UsuarioSesion['permisos'] {
  if (!usuario.permisos) return null;
  return {
    puedeVerCostos: usuario.permisos.puedeVerCostos,
    puedeRegistrarCompras: usuario.permisos.puedeRegistrarCompras,
    puedeVerUtilidad: usuario.permisos.puedeVerUtilidad,
    puedeVerCarteraGeneral: usuario.permisos.puedeVerCarteraGeneral,
    puedeVerGastosTodos: usuario.permisos.puedeVerGastosTodos,
    puedeAutorizar: usuario.permisos.puedeAutorizar,
    puedeRegistrarPagos: usuario.permisos.puedeRegistrarPagos,
  };
}

export class LoginBloqueadoError extends Error {
  minutosRestantes: number;
  constructor(minutosRestantes: number) {
    super(`Demasiados intentos fallidos. Espera ${minutosRestantes} minuto(s) antes de volver a intentar.`);
    this.minutosRestantes = minutosRestantes;
  }
}

/**
 * Verifica telefono+PIN y, si son correctos, crea una fila nueva en Sesion
 * con un token aleatorio. Ese token es lo unico que el frontend guarda y
 * manda en cada llamada posterior (header Authorization: Bearer <token>).
 *
 * Antes de intentar validar el PIN, se revisa si este identificador esta
 * bloqueado por demasiados intentos fallidos recientes -- el PIN es de
 * solo 4 digitos, asi que sin este limite alguien podria probar todas las
 * combinaciones posibles en minutos.
 */
export async function loginUsuario(
  identificador: string,
  pin: string
): Promise<{ token: string; usuario: UsuarioSesion }> {
  const minutosBloqueado = verificarBloqueo(identificador);
  if (minutosBloqueado !== null) {
    throw new LoginBloqueadoError(minutosBloqueado);
  }

  // Se puede iniciar sesion con el telefono o con el nombre, en el mismo campo.
  const usuario = await prisma.usuario.findFirst({
    where: {
      OR: [
        { telefono: identificador },
        { nombre: { equals: identificador, mode: 'insensitive' } },
      ],
    },
    include: { permisos: true },
  });

  if (!usuario || !usuario.activo) {
    registrarIntentoFallido(identificador);
    throw new Error('Credenciales invalidas');
  }

  const pinValido = await bcrypt.compare(pin, usuario.pin);
  if (!pinValido) {
    registrarIntentoFallido(identificador);
    throw new Error('Credenciales invalidas');
  }

  limpiarIntentos(identificador);

  const token = randomUUID();
  const expiraEn = new Date(Date.now() + DURACION_SESION_HORAS * 60 * 60 * 1000);

  await prisma.sesion.create({
    data: { token, usuarioId: usuario.id, expiraEn },
  });

  return {
    token,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      telefono: usuario.telefono,
      rolBase: usuario.rolBase,
      permisos: mapPermisos(usuario),
    },
  };
}

/** Usado por el middleware requireAuth en cada request protegida. */
export async function obtenerUsuarioPorToken(token: string) {
  const sesion = await prisma.sesion.findUnique({
    where: { token },
    include: { usuario: { include: { permisos: true } } },
  });

  if (!sesion || sesion.expiraEn < new Date()) return null;
  if (!sesion.usuario.activo) return null;

  // Ventana deslizante: cada peticion valida renueva la sesion otra hora
  // mas. Mientras la app se siga usando (sin cerrar la pagina) la sesion
  // nunca expira; si queda inactiva 1 hora completa, si.
  const nuevaExpiracion = new Date(Date.now() + DURACION_SESION_HORAS * 60 * 60 * 1000);
  await prisma.sesion.update({
    where: { token },
    data: { expiraEn: nuevaExpiracion },
  });

  return {
    id: sesion.usuario.id,
    nombre: sesion.usuario.nombre,
    telefono: sesion.usuario.telefono,
    rolBase: sesion.usuario.rolBase,
    permisos: mapPermisos(sesion.usuario),
  };
}

export async function cerrarSesion(token: string) {
  await prisma.sesion.deleteMany({ where: { token } });
}

/**
 * Confirma que un usuario puede actuar como autorizador de una venta bajo
 * costo o de un ajuste de inventario: debe existir, estar activo, tener el
 * switch puedeAutorizar (o ser administrador), y su PIN debe coincidir con
 * el que se capturo en el momento. Este PIN es el "codigo remoto" que el
 * administrador dicta al vendedor via llamada/whatsapp -- es la version
 * minima viable mientras se construye el flujo de aprobacion push
 * (pendiente #1 de la lista original).
 */
/**
 * Igual que verificarAutorizador, pero identifica al autorizador por su
 * telefono en vez de su ID -- mucho mas practico en campo, ya que el
 * administrador se sabe su telefono de memoria (es el mismo con el que
 * hace login), no un UUID interno.
 * Regresa el ID real del usuario si la autorizacion es valida (para
 * guardarlo en el registro de auditoria), o null si no lo es.
 */
export async function verificarAutorizadorPorTelefono(
  telefono: string,
  pin: string
): Promise<string | null> {
  const usuario = await prisma.usuario.findUnique({
    where: { telefono },
    include: { permisos: true },
  });

  if (!usuario || !usuario.activo) return null;
  const autorizado = usuario.rolBase === 'administrador' || usuario.permisos?.puedeAutorizar;
  if (!autorizado) return null;

  const pinValido = await bcrypt.compare(pin, usuario.pin);
  return pinValido ? usuario.id : null;
}

export async function verificarAutorizador(usuarioId: string, pin: string): Promise<boolean> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    include: { permisos: true },
  });

  if (!usuario || !usuario.activo) return false;
  const autorizado = usuario.rolBase === 'administrador' || usuario.permisos?.puedeAutorizar;
  if (!autorizado) return false;

  return bcrypt.compare(pin, usuario.pin);
}

export async function listarUsuarios() {
  const usuarios = await prisma.usuario.findMany({
    include: { permisos: true },
    orderBy: { nombre: 'asc' },
  });
  // Nunca se manda el hash del PIN al frontend.
  return usuarios.map(({ pin, ...resto }) => resto);
}

export async function crearUsuario(datos: {
  nombre: string;
  telefono: string;
  pin: string;
  rolBase?: string;
}) {
  const pinHash = await bcrypt.hash(datos.pin, RONDAS_BCRYPT);

  const usuario = await prisma.usuario.create({
    data: {
      nombre: datos.nombre,
      telefono: datos.telefono,
      pin: pinHash,
      rolBase: datos.rolBase ?? 'vendedor',
      permisos: {
        create: {
          puedeVerCostos: false,
          puedeRegistrarCompras: false,
          puedeVerUtilidad: false,
          puedeVerCarteraGeneral: false,
          puedeVerGastosTodos: false,
          puedeAutorizar: false,
          puedeRegistrarPagos: false,
        },
      },
    },
    include: { permisos: true },
  });

  const { pin: _pin, ...sinPin } = usuario;
  return sinPin;
}

export async function cambiarPinUsuario(usuarioId: string, nuevoPin: string) {
  const pinHash = await bcrypt.hash(nuevoPin, RONDAS_BCRYPT);
  const usuario = await prisma.usuario.update({
    where: { id: usuarioId },
    data: { pin: pinHash },
  });
  const { pin: _pin, ...sinPin } = usuario;
  return sinPin;
}

export async function actualizarUsuario(
  usuarioId: string,
  datos: { nombre?: string; telefono?: string }
) {
  const usuario = await prisma.usuario.update({
    where: { id: usuarioId },
    data: datos,
  });
  const { pin: _pin, ...sinPin } = usuario;
  return sinPin;
}

export async function actualizarPermisosUsuario(
  usuarioId: string,
  permisos: {
    puedeVerCostos: boolean;
    puedeRegistrarCompras: boolean;
    puedeVerUtilidad: boolean;
    puedeVerCarteraGeneral: boolean;
    puedeVerGastosTodos: boolean;
    puedeAutorizar: boolean;
    puedeRegistrarPagos: boolean;
  }
) {
  return prisma.permisosUsuario.upsert({
    where: { usuarioId },
    update: permisos,
    create: { usuarioId, ...permisos },
    include: { usuario: true },
  });
}
